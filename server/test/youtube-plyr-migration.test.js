const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('room page keeps URL paste available without showing an embedded YouTube player in the UI', () => {
  const html = read('client', 'room.html');
  const css = read('client', 'style.css');
  const nowPlayingMarkup = html.match(/<div class="glass now-playing-card"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/)?.[0] || '';

  assert.doesNotMatch(html, /cdn\.plyr\.io/);
  assert.match(html, /id="youtube-iframe-player"/);
  assert.match(html, /class="playback-engine"/);
  assert.doesNotMatch(nowPlayingMarkup, /youtube-iframe-player/);
  assert.match(html, /id="tab-url"/);
  assert.match(html, /id="url-input"/);
  assert.doesNotMatch(html, /<audio id="audio-player"/);
  assert.match(css, /\.playback-engine\s*{/);
  assert.match(css, /left:\s*-9999px/);
});

test('room logic uses YouTube video ids with iframe API instead of direct audio extraction', () => {
  const js = read('client', 'js', 'room.js');

  assert.match(js, /let youtubePlayer = null/);
  assert.match(js, /let currentYouTubeVideoId = null/);
  assert.match(js, /getTrackVideoId\(track\)/);
  assert.match(js, /ensureYouTubeApi\(\)/);
  assert.match(js, /new YT\.Player/);
  assert.match(js, /loadYouTubeTrack\(track/);
  assert.match(js, /currentYouTubeVideoId !== videoId/);
  assert.match(js, /cueVideoById/);
  assert.match(js, /loadVideoById/);
  assert.match(js, /youtube_video_id: track\.youtubeVideoId/);
  assert.doesNotMatch(js, /Plyr/);
  assert.doesNotMatch(js, /audio\.addEventListener\('error'/);
  assert.doesNotMatch(js, /audio_url: track\.audioUrl/);
});

test('frontend no longer offers Spotify as a login or music source', () => {
  const indexHtml = read('client', 'index.html');
  const appJs = read('client', 'js', 'app.js');
  const authJs = read('client', 'js', 'auth.js');
  const roomHtml = read('client', 'room.html');
  const roomJs = read('client', 'js', 'room.js');

  assert.doesNotMatch(indexHtml, /Spotify/i);
  assert.doesNotMatch(roomHtml, /Spotify/i);
  assert.doesNotMatch(appJs, /Spotify/i);
  assert.doesNotMatch(authJs, /Spotify/i);
  assert.doesNotMatch(roomJs, /Spotify/i);
});

test('resolve-audio function returns YouTube metadata without Cobalt audio extraction', () => {
  const fn = read('supabase', 'functions', 'resolve-audio', 'index.ts');

  assert.match(fn, /youtubeVideoId/);
  assert.doesNotMatch(fn, /extractAudioViaCobalt/);
  assert.doesNotMatch(fn, /COBALT_/);
  assert.doesNotMatch(fn, /resolveSpotify/);
});
