const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');

// Attempt to load spotify-web-api-node; if missing, Spotify support is disabled
let SpotifyWebApi;
try {
  SpotifyWebApi = require('spotify-web-api-node');
} catch (_) {
  SpotifyWebApi = null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Check if yt-dlp binary is available on the system.
 */
function checkYtDlp() {
  return new Promise((resolve) => {
    exec('yt-dlp --version', (err) => resolve(!err));
  });
}

/**
 * Run yt-dlp and return stdout as a string.
 */
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        fail(new Error('yt-dlp is not installed or is not available in PATH.'));
        return;
      }
      fail(new Error(`yt-dlp failed to start: ${err.message}`));
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`yt-dlp error: ${stderr.slice(0, 500)}`));
    });
  });
}

function buildStreamPath(url) {
  return `/api/stream?url=${encodeURIComponent(url)}`;
}

function extractSpotifyTrackId(url) {
  const match = url.match(/spotify\.com\/(?:intl-[a-z]+\/)?track\/([A-Za-z0-9]+)/);
  return match?.[1] || null;
}

async function resolveStreamUrl(url) {
  const directUrl = await runYtDlp([
    '-f', 'bestaudio',
    '-g',
    '--no-playlist',
    url,
  ]);

  return directUrl.split('\n')[0];
}

/**
 * Extract track info (title, uploader, duration, thumbnail, audioUrl) from a URL.
 */
async function resolveYouTubeUrl(url) {
  // Get metadata as JSON
  const jsonStr = await runYtDlp([
    '--dump-json',
    '--no-playlist',
    '--skip-download',
    url,
  ]);
  const info = JSON.parse(jsonStr);

  return {
    name: info.title || 'Unknown',
    artist: info.uploader || info.channel || 'Unknown',
    duration: info.duration || 0,
    thumbnail: info.thumbnail || null,
    audioUrl: buildStreamPath(info.webpage_url || url),
    sourceType: 'youtube',
    originalUrl: info.webpage_url || url,
  };
}

/**
 * Search YouTube by text query and return the top result's track info.
 */
async function searchYouTube(query) {
  const searchQuery = `ytsearch1:${query}`;
  const jsonStr = await runYtDlp([
    '--dump-json',
    '--no-playlist',
    '--skip-download',
    searchQuery,
  ]);
  const info = JSON.parse(jsonStr);

  return {
    name: info.title || 'Unknown',
    artist: info.uploader || info.channel || 'Unknown',
    duration: info.duration || 0,
    thumbnail: info.thumbnail || null,
    audioUrl: buildStreamPath(info.webpage_url),
    sourceType: 'youtube',
    originalUrl: info.webpage_url,
  };
}

// ─── Spotify Client (optional) ───────────────────────────────────────────────

let spotifyApi = null;
let spotifyTokenExpiry = 0;

function initSpotify(clientId, clientSecret) {
  if (!SpotifyWebApi) {
    console.warn('[Spotify] spotify-web-api-node not installed. Spotify support disabled.');
    return false;
  }
  if (!clientId || !clientSecret) {
    console.warn('[Spotify] Missing credentials. Spotify support disabled.');
    return false;
  }
  spotifyApi = new SpotifyWebApi({ clientId, clientSecret });
  console.log('[Spotify] Client initialized.');
  return true;
}

async function ensureSpotifyToken() {
  if (!spotifyApi) return false;
  if (Date.now() < spotifyTokenExpiry - 60_000) return true;

  try {
    const data = await spotifyApi.clientCredentialsGrant();
    spotifyApi.setAccessToken(data.body.access_token);
    spotifyTokenExpiry = Date.now() + data.body.expires_in * 1000;
    return true;
  } catch (err) {
    console.error('[Spotify] Token error:', err.message);
    return false;
  }
}

async function getSpotifyMetadata(url) {
  try {
    if (!spotifyApi) throw new Error('Spotify API credentials not configured.');
    if (!(await ensureSpotifyToken())) throw new Error('Could not authenticate with Spotify.');

    const trackId = extractSpotifyTrackId(url);
    if (!trackId) throw new Error('Invalid Spotify track URL. Expected format: https://open.spotify.com/track/...');

    const { body: track } = await spotifyApi.getTrack(trackId);
    const artistName = track.artists.map((a) => a.name).join(', ');

    return {
      trackName: track.name,
      artistName,
      duration: Math.round(track.duration_ms / 1000),
      thumbnail: track.album.images?.[0]?.url || null,
      searchQuery: `${track.name} ${artistName} audio`,
    };
  } catch (apiErr) {
    const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, {
      timeout: 8000,
    });
    const data = await res.json();
    if (!res.ok || !data.title) throw apiErr;

    return {
      trackName: data.title,
      artistName: 'Spotify',
      duration: 0,
      thumbnail: data.thumbnail_url || null,
      searchQuery: `${data.title} audio`,
    };
  }
}

/**
 * Resolve a Spotify track URL → get metadata → search YouTube → get audio URL.
 */
async function resolveSpotifyUrl(url) {
  const trackId = extractSpotifyTrackId(url);
  if (!trackId) throw new Error('Invalid Spotify track URL. Expected format: https://open.spotify.com/track/...');

  const metadata = await getSpotifyMetadata(url);

  // Search YouTube for the best match
  const ytResult = await searchYouTube(metadata.searchQuery);

  return {
    ...ytResult,
    name: metadata.trackName,
    artist: metadata.artistName,
    duration: metadata.duration,
    thumbnail: metadata.thumbnail,
    sourceType: 'spotify',
    originalUrl: url,
    spotifyId: trackId,
  };
}

/**
 * Resolve a generic URL as an audio file (no processing, served as-is).
 * Returns a simple track descriptor.
 */
function resolveDirectUrl(url) {
  // Try to extract a name from the URL path
  try {
    const parsed = new URL(url);
    const filename = path.basename(parsed.pathname) || 'Unknown';
    const name = decodeURIComponent(filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '));
    return {
      name: name || 'Audio Track',
      artist: 'Unknown',
      duration: 0,
      thumbnail: null,
      audioUrl: url,
      sourceType: 'url',
      originalUrl: url,
    };
  } catch {
    return {
      name: 'Audio Track',
      artist: 'Unknown',
      duration: 0,
      thumbnail: null,
      audioUrl: url,
      sourceType: 'url',
      originalUrl: url,
    };
  }
}

/**
 * Resolve an uploaded file to a track descriptor.
 * @param {string} filename - original filename
 * @param {string} serverPath - server-relative URL path to serve the file
 */
function resolveUpload(filename, serverPath) {
  const name = filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  return {
    name: name || filename,
    artist: 'Upload',
    duration: 0,
    thumbnail: null,
    audioUrl: serverPath,
    sourceType: 'upload',
    originalUrl: serverPath,
  };
}

// ─── Main Resolver ───────────────────────────────────────────────────────────

/**
 * Detects the source type from an input string and resolves it to a track descriptor.
 *
 * Returns: { name, artist, duration, thumbnail, audioUrl, sourceType, originalUrl }
 * Throws on failure.
 */
async function resolveSource(input) {
  const trimmed = input.trim();

  // YouTube URLs
  if (/youtube\.com\/watch|youtu\.be\//.test(trimmed)) {
    return await resolveYouTubeUrl(trimmed);
  }

  // Spotify URLs
  if (/spotify\.com\/(?:intl-[a-z]+\/)?track\//.test(trimmed)) {
    return await resolveSpotifyUrl(trimmed);
  }

  // Generic URL (direct audio file or other yt-dlp-supported platform)
  if (/^https?:\/\//.test(trimmed)) {
    // Try yt-dlp first (handles SoundCloud, Vimeo, etc.)
    try {
      return await resolveYouTubeUrl(trimmed);
    } catch {
      // Fallback to treating it as a direct audio URL
      return resolveDirectUrl(trimmed);
    }
  }

  // Plain text = YouTube search query
  return await searchYouTube(trimmed);
}

module.exports = {
  resolveSource,
  resolveUpload,
  resolveStreamUrl,
  initSpotify,
  checkYtDlp,
};
