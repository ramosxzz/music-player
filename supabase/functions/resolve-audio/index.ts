// supabase/functions/resolve-audio/index.ts
// Resolves YouTube links and search terms into metadata for official YouTube iframe playback.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const INVIDIOUS_INSTANCES = [
  "https://inv.thepixora.com",
  "https://invidious.nerdvpn.de",
  "https://inv.nadeko.net",
  "https://yt.artemislena.eu",
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function extractYouTubeId(input: string): string | null {
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /embed\/([A-Za-z0-9_-]{11})/,
    /shorts\/([A-Za-z0-9_-]{11})/,
    /^([A-Za-z0-9_-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function invidiousGet(path: string): Promise<any> {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const res = await fetch(`${instance}${path}`, {
        headers: { "User-Agent": "SyncBeat/1.0" },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.error) continue;
      return data;
    } catch {
      continue;
    }
  }

  throw new Error("Não foi possível consultar metadados do YouTube. Tente novamente.");
}

function chooseThumbnail(videoId: string, thumbnails: any[] | undefined) {
  const thumbnail = (
    thumbnails?.find((t: any) => t.quality === "high")?.url ||
    thumbnails?.[0]?.url ||
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  );
  return thumbnail.replace(/^http:\/\//, "https://");
}

function buildTrack(video: any) {
  const videoId = video.videoId || video.videoId === "" ? video.videoId : video.video_id;
  const youtubeVideoId = videoId || video.id;
  const originalUrl = `https://www.youtube.com/watch?v=${youtubeVideoId}`;

  return {
    name: video.title || "Video do YouTube",
    artist: video.author || video.authorName || "YouTube",
    duration: Number(video.lengthSeconds || 0),
    thumbnail: chooseThumbnail(youtubeVideoId, video.videoThumbnails),
    youtubeVideoId,
    audioUrl: originalUrl,
    sourceType: "youtube",
    originalUrl,
  };
}

async function resolveYouTubeVideo(videoId: string) {
  const video = await invidiousGet(
    `/api/v1/videos/${videoId}?fields=videoId,title,author,lengthSeconds,videoThumbnails`
  ).catch(() => ({
    videoId,
    title: "Video do YouTube",
    author: "YouTube",
    lengthSeconds: 0,
    videoThumbnails: [],
  }));

  return buildTrack({ ...video, videoId });
}

async function resolveSearch(query: string) {
  const results = await invidiousGet(
    `/api/v1/search?q=${encodeURIComponent(query)}&type=video&fields=videoId,title,author,lengthSeconds,videoThumbnails`
  );

  if (!results?.length) throw new Error("Nenhum video encontrado para: " + query);
  return buildTrack(results[0]);
}

async function resolveInput(input: string) {
  const trimmed = input.trim();
  if (/spotify\.com/i.test(trimmed)) {
    throw new Error("Spotify foi removido deste projeto. Use uma busca ou link do YouTube.");
  }

  const videoId = extractYouTubeId(trimmed);
  if (videoId) return resolveYouTubeVideo(videoId);
  if (/^https?:\/\//.test(trimmed)) {
    throw new Error("Use apenas links do YouTube ou busque pelo nome da música.");
  }

  return resolveSearch(trimmed);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    if (req.method !== "POST") {
      return jsonResponse({ ok: false, error: "Método não suportado" }, 405);
    }

    const { input } = await req.json();
    if (!input?.trim()) return jsonResponse({ ok: false, error: "Campo 'input' é obrigatório" }, 400);

    const track = await resolveInput(input);
    return jsonResponse({ ok: true, track });
  } catch (err: any) {
    console.error("resolve-audio error:", err);
    return jsonResponse({ ok: false, error: err.message || "Erro interno" }, 500);
  }
});
