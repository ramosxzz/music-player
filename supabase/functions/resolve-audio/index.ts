// supabase/functions/resolve-audio/index.ts
// Edge Function (Deno) — Resolve audio from YouTube, Spotify, direct URL or search

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

// ─── Invidious helpers ────────────────────────────────────────────────────────

async function invidiousGet(path: string): Promise<any> {
  const instances = [...INVIDIOUS_INSTANCES];

  // 1. Tenta a lista hardcoded primeiro
  for (const instance of instances) {
    try {
      const res = await fetch(`${instance}${path}`, {
        headers: { "User-Agent": "SyncBeat/1.0" },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.error) continue;
      return { data, instance };
    } catch {
      continue;
    }
  }

  // 2. Self-healing: se falhar, busca a lista dinâmica e atualizada diretamente da API oficial do Invidious
  try {
    const listRes = await fetch("https://api.invidious.io/instances.json", {
      signal: AbortSignal.timeout(4000)
    });
    if (listRes.ok) {
      const apiData = await listRes.json();
      const dynamicInstances = apiData
        .filter(([domain, info]: any) => info.type === 'https' && !instances.includes(info.uri))
        .map(([domain, info]: any) => info.uri);

      for (const instance of dynamicInstances) {
        try {
          const res = await fetch(`${instance}${path}`, {
            headers: { "User-Agent": "SyncBeat/1.0" },
            signal: AbortSignal.timeout(6000),
          });
          if (!res.ok) continue;
          const data = await res.json();
          if (data.error) continue;
          return { data, instance };
        } catch {
          continue;
        }
      }
    }
  } catch {
    // Ignora falhas da busca dinâmica e deixa cair no erro abaixo
  }

  throw new Error("Todas as instâncias Invidious falharam. Tente novamente.");
}

async function getVideoData(videoId: string) {
  return invidiousGet(`/api/v1/videos/${videoId}?local=true&fields=title,author,lengthSeconds,videoThumbnails`);
}

async function searchVideos(query: string) {
  return invidiousGet(
    `/api/v1/search?q=${encodeURIComponent(query)}&type=video&fields=videoId,title,author,lengthSeconds,videoThumbnails`
  );
}

function extractYouTubeId(url: string): string | null {
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /embed\/([A-Za-z0-9_-]{11})/,
    /shorts\/([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// ─── YouTube resolver ─────────────────────────────────────────────────────────

async function resolveYouTube(url: string) {
  const videoId = extractYouTubeId(url);
  if (!videoId) throw new Error("URL do YouTube inválida");

  const { data } = await getVideoData(videoId);

  const thumbnail = data.videoThumbnails?.find((t: any) => t.quality === "high")?.url
    || data.videoThumbnails?.[0]?.url
    || null;

  return {
    name: data.title || "Desconhecido",
    artist: data.author || "Desconhecido",
    duration: data.lengthSeconds || 0,
    thumbnail,
    audioUrl: `https://www.youtube.com/watch?v=${videoId}`,
    sourceType: "youtube",
    originalUrl: url,
  };
}

// ─── Spotify resolver ─────────────────────────────────────────────────────────

let spotifyToken: string | null = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken(): Promise<string> {
  if (spotifyToken && Date.now() < spotifyTokenExpiry - 30_000) return spotifyToken;

  const clientId = Deno.env.get("SPOTIFY_CLIENT_ID");
  const clientSecret = Deno.env.get("SPOTIFY_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Credenciais do Spotify não configuradas");

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${clientId}:${clientSecret}`),
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Falha ao autenticar no Spotify");

  spotifyToken = data.access_token;
  spotifyTokenExpiry = Date.now() + data.expires_in * 1000;
  return spotifyToken!;
}

async function resolveSpotify(url: string) {
  const match = url.match(/spotify\.com\/(?:intl-[a-z]+\/)?track\/([A-Za-z0-9]+)/);
  if (!match) throw new Error("URL do Spotify inválida. Use o formato: open.spotify.com/track/...");

  const trackId = match[1];
  const token = await getSpotifyToken();

  const res = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const track = await res.json();
  if (track.error) throw new Error(`Spotify: ${track.error.message}`);

  const artistName = track.artists.map((a: any) => a.name).join(", ");
  const trackName = track.name;
  const thumbnail = track.album.images?.[0]?.url || null;
  const duration = Math.round(track.duration_ms / 1000);

  // Search on YouTube via Invidious
  const { data: results } = await searchVideos(`${trackName} ${artistName} audio`);
  if (!results?.length) throw new Error("Faixa não encontrada no YouTube");

  const videoId = results[0].videoId;

  return {
    name: trackName,
    artist: artistName,
    duration,
    thumbnail,
    audioUrl: `https://www.youtube.com/watch?v=${videoId}`,
    sourceType: "spotify",
    originalUrl: url,
  };
}

// ─── Text search resolver ─────────────────────────────────────────────────────

async function resolveSearch(query: string) {
  const { data: results } = await searchVideos(query);
  if (!results?.length) throw new Error("Nenhum resultado encontrado para: " + query);

  const video = results[0];

  const thumbnail = video.videoThumbnails?.find((t: any) => t.quality === "high")?.url
    || video.videoThumbnails?.[0]?.url
    || null;

  return {
    name: video.title || "Desconhecido",
    artist: video.author || "Desconhecido",
    duration: video.lengthSeconds || 0,
    thumbnail,
    audioUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
    sourceType: "youtube",
    originalUrl: `https://youtube.com/watch?v=${video.videoId}`,
  };
}

// ─── Direct URL resolver ──────────────────────────────────────────────────────

function resolveDirect(url: string) {
  try {
    const parsed = new URL(url);
    const filename = parsed.pathname.split("/").pop() || "audio";
    const name = decodeURIComponent(filename.replace(/\.[^.]+$/, "").replace(/[-_]/g, " "));
    return {
      name: name || "Arquivo de Áudio",
      artist: "URL Direta",
      duration: 0,
      thumbnail: null,
      audioUrl: url,
      sourceType: "url",
      originalUrl: url,
    };
  } catch {
    throw new Error("URL inválida");
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const { input } = await req.json();
    if (!input?.trim()) {
      return new Response(
        JSON.stringify({ ok: false, error: "Campo 'input' é obrigatório" }),
        { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    const trimmed = input.trim();
    let track: any;

    if (/youtube\.com|youtu\.be/.test(trimmed)) {
      track = await resolveYouTube(trimmed);
    } else if (/spotify\.com\/(?:intl-[a-z]+\/)?track\//.test(trimmed)) {
      track = await resolveSpotify(trimmed);
    } else if (/^https?:\/\//.test(trimmed)) {
      // Try Invidious (handles SoundCloud etc) then fall back to direct
      try {
        const videoId = extractYouTubeId(trimmed);
        if (videoId) {
          track = await resolveYouTube(trimmed);
        } else {
          throw new Error("not youtube");
        }
      } catch {
        track = resolveDirect(trimmed);
      }
    } else {
      track = await resolveSearch(trimmed);
    }

    return new Response(
      JSON.stringify({ ok: true, track }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("resolve-audio error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: err.message || "Erro interno" }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }
});
