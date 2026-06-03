// supabase/functions/resolve-audio/index.ts
// Resolves YouTube, Spotify, direct URLs, and text search into playable tracks.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

type ResolveMode = "stream-endpoint" | "direct";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const DEFAULT_COBALT_INSTANCES = [
  "https://apicobalt.mgytr.top",
  "https://cobaltapi.kittycat.boo",
  "https://dog.kittycat.boo",
];

const INVIDIOUS_INSTANCES = [
  "https://inv.thepixora.com",
  "https://invidious.nerdvpn.de",
  "https://inv.nadeko.net",
  "https://yt.artemislena.eu",
];

function envList(name: string, fallback: string[]) {
  return (Deno.env.get(name) || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .concat(fallback);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function buildStreamUrl(req: Request, mediaUrl: string) {
  const configuredUrl = Deno.env.get("SYNCBEAT_RESOLVE_AUDIO_URL");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const fallbackUrl = new URL(req.url);
  const baseUrl = configuredUrl ||
    (supabaseUrl ? `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/resolve-audio` : `${fallbackUrl.origin}${fallbackUrl.pathname}`);
  const url = new URL(baseUrl);
  url.searchParams.set("stream", mediaUrl);
  return url.toString();
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

function normalizeYouTubeUrl(url: string) {
  const videoId = extractYouTubeId(url);
  if (!videoId) throw new Error("URL do YouTube inválida");
  return `https://www.youtube.com/watch?v=${videoId}`;
}

async function extractAudioViaCobalt(mediaUrl: string): Promise<{ url: string; filename?: string }> {
  const instances = envList("COBALT_API_URLS", DEFAULT_COBALT_INSTANCES);
  const apiKey = Deno.env.get("COBALT_API_KEY");
  const authScheme = Deno.env.get("COBALT_AUTH_SCHEME") || "Api-Key";
  const errors: string[] = [];

  for (const instance of instances) {
    const endpoint = instance.replace(/\/+$/, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
    };
    if (apiKey) headers.Authorization = `${authScheme} ${apiKey}`;

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          url: mediaUrl,
          downloadMode: "audio",
          audioFormat: Deno.env.get("COBALT_AUDIO_FORMAT") || "mp3",
          audioBitrate: Deno.env.get("COBALT_AUDIO_BITRATE") || "128",
          filenameStyle: "basic",
          alwaysProxy: true,
          disableMetadata: true,
          youtubeBetterAudio: true,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      const text = await res.text();
      let data: any = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { text };
      }

      if (!res.ok || data.status === "error") {
        const code = data?.error?.code || data?.error || data?.status || `HTTP ${res.status}`;
        errors.push(`${endpoint}: ${code}`);
        continue;
      }

      if (data.url) return { url: data.url, filename: data.filename };
      errors.push(`${endpoint}: resposta sem URL`);
    } catch (err) {
      errors.push(`${endpoint}: ${err instanceof Error ? err.message : "falha"}`);
    }
  }

  throw new Error(
    `Não foi possível extrair áudio via Cobalt. Configure uma instância própria em COBALT_API_URLS. ${errors.join(" | ")}`
  );
}

async function invidiousGet(path: string): Promise<any> {
  const instances = [...INVIDIOUS_INSTANCES];

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

  try {
    const listRes = await fetch("https://api.invidious.io/instances.json", {
      signal: AbortSignal.timeout(4000),
    });
    if (listRes.ok) {
      const apiData = await listRes.json();
      const dynamicInstances = apiData
        .filter(([uri, info]: [string, any]) => info.type === "https" && !instances.includes(uri))
        .map(([uri]: [string, any]) => uri);

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
    // Keep the original failure message below.
  }

  throw new Error("Todas as instâncias Invidious falharam. Tente novamente.");
}

async function getVideoMetadata(videoId: string) {
  return invidiousGet(
    `/api/v1/videos/${videoId}?fields=title,author,lengthSeconds,videoThumbnails`
  );
}

async function searchVideos(query: string) {
  return invidiousGet(
    `/api/v1/search?q=${encodeURIComponent(query)}&type=video&fields=videoId,title,author,lengthSeconds,videoThumbnails`
  );
}

function chooseThumbnail(videoId: string, thumbnails: any[] | undefined) {
  const thumbnail = (
    thumbnails?.find((t: any) => t.quality === "high")?.url ||
    thumbnails?.[0]?.url ||
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  );
  return thumbnail.replace(/^http:\/\//, "https://");
}

async function resolveYouTube(url: string, req: Request, mode: ResolveMode) {
  const ytUrl = normalizeYouTubeUrl(url);
  const videoId = extractYouTubeId(ytUrl)!;

  const [metaResult, cobaltResult] = await Promise.all([
    getVideoMetadata(videoId).catch(() => null),
    extractAudioViaCobalt(ytUrl),
  ]);

  const data = metaResult?.data;
  let name = data?.title;
  let artist = data?.author;

  if (!name && cobaltResult.filename) {
    const cleanName = cobaltResult.filename.replace(/\.[a-zA-Z0-9]+$/, "");
    const parts = cleanName.split(" - ");
    if (parts.length >= 2) {
      artist = parts[0].trim();
      name = parts.slice(1).join(" - ").trim();
    } else {
      name = cleanName;
      artist = "YouTube";
    }
  }

  return {
    name: name || "Desconhecido",
    artist: artist || "Desconhecido",
    duration: data?.lengthSeconds || 0,
    thumbnail: chooseThumbnail(videoId, data?.videoThumbnails),
    audioUrl: mode === "direct" ? cobaltResult.url : buildStreamUrl(req, ytUrl),
    sourceType: "youtube",
    originalUrl: ytUrl,
  };
}

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
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Spotify token retornou resposta inválida (${res.status}): ${text.slice(0, 80)}`);
  }
  if (!data.access_token) throw new Error("Falha ao autenticar no Spotify");

  spotifyToken = data.access_token;
  spotifyTokenExpiry = Date.now() + data.expires_in * 1000;
  return spotifyToken!;
}

async function getSpotifyMetadata(url: string) {
  try {
    const token = await getSpotifyToken();
    const match = url.match(/spotify\.com\/(?:intl-[a-z]+\/)?track\/([A-Za-z0-9]+)/);
    if (!match) throw new Error("URL do Spotify inválida. Use o formato: open.spotify.com/track/...");

    const res = await fetch(`https://api.spotify.com/v1/tracks/${match[1]}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const track = await res.json();
    if (track.error) throw new Error(`Spotify: ${track.error.message}`);

    const artistName = track.artists.map((a: any) => a.name).join(", ");
    return {
      trackName: track.name,
      artistName,
      duration: Math.round(track.duration_ms / 1000),
      thumbnail: track.album.images?.[0]?.url || null,
      searchQuery: `${track.name} ${artistName} audio`,
    };
  } catch (apiErr) {
    const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    if (!res.ok || !data.title) {
      throw new Error(apiErr instanceof Error ? apiErr.message : "Não foi possível ler metadados do Spotify");
    }
    return {
      trackName: data.title,
      artistName: "Spotify",
      duration: 0,
      thumbnail: data.thumbnail_url || null,
      searchQuery: `${data.title} audio`,
    };
  }
}

async function resolveSpotify(url: string, req: Request, mode: ResolveMode) {
  const match = url.match(/spotify\.com\/(?:intl-[a-z]+\/)?track\/([A-Za-z0-9]+)/);
  if (!match) throw new Error("URL do Spotify inválida. Use o formato: open.spotify.com/track/...");

  const metadata = await getSpotifyMetadata(url);

  const { data: results } = await searchVideos(metadata.searchQuery);
  if (!results?.length) throw new Error("Faixa não encontrada no YouTube");

  const videoId = results[0].videoId;
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const cobaltResult = await extractAudioViaCobalt(ytUrl);

  return {
    name: metadata.trackName,
    artist: metadata.artistName,
    duration: metadata.duration,
    thumbnail: metadata.thumbnail,
    audioUrl: mode === "direct" ? cobaltResult.url : buildStreamUrl(req, ytUrl),
    sourceType: "spotify",
    originalUrl: url,
  };
}

async function resolveSearch(query: string, req: Request, mode: ResolveMode) {
  const { data: results } = await searchVideos(query);
  if (!results?.length) throw new Error("Nenhum resultado encontrado para: " + query);

  const video = results[0];
  const videoId = video.videoId;
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const cobaltResult = await extractAudioViaCobalt(ytUrl);

  return {
    name: video.title || "Desconhecido",
    artist: video.author || "Desconhecido",
    duration: video.lengthSeconds || 0,
    thumbnail: chooseThumbnail(videoId, video.videoThumbnails),
    audioUrl: mode === "direct" ? cobaltResult.url : buildStreamUrl(req, ytUrl),
    sourceType: "youtube",
    originalUrl: ytUrl,
  };
}

function resolveDirect(url: string) {
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
}

async function resolveInput(input: string, req: Request, mode: ResolveMode) {
  const trimmed = input.trim();

  if (/youtube\.com|youtu\.be/.test(trimmed)) return resolveYouTube(trimmed, req, mode);
  if (/spotify\.com\/(?:intl-[a-z]+\/)?track\//.test(trimmed)) return resolveSpotify(trimmed, req, mode);
  if (/^https?:\/\//.test(trimmed)) {
    if (extractYouTubeId(trimmed)) return resolveYouTube(trimmed, req, mode);
    return resolveDirect(trimmed);
  }

  return resolveSearch(trimmed, req, mode);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const url = new URL(req.url);

    if (req.method === "GET" && url.searchParams.has("stream")) {
      const input = url.searchParams.get("stream") || "";
      const track = await resolveInput(input, req, "direct");
      return new Response(null, {
        status: 302,
        headers: {
          ...CORS_HEADERS,
          "Location": track.audioUrl,
          "Cache-Control": "no-store",
        },
      });
    }

    if (req.method !== "POST") {
      return jsonResponse({ ok: false, error: "Método não suportado" }, 405);
    }

    const { input } = await req.json();
    if (!input?.trim()) return jsonResponse({ ok: false, error: "Campo 'input' é obrigatório" }, 400);

    const track = await resolveInput(input, req, "stream-endpoint");
    return jsonResponse({ ok: true, track });
  } catch (err: any) {
    console.error("resolve-audio error:", err);
    return jsonResponse({ ok: false, error: err.message || "Erro interno" }, 500);
  }
});
