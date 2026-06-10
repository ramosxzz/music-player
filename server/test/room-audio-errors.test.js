const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const roomJsPath = path.join(__dirname, '..', '..', 'client', 'js', 'room.js');

test('room player no longer uses expiring direct audio links', () => {
  const source = fs.readFileSync(roomJsPath, 'utf8');

  assert.match(source, /syncYouTube/);
  assert.match(source, /loadYouTubeTrack/);
  assert.doesNotMatch(source, /audio\.addEventListener\('error'/);
  assert.doesNotMatch(source, /Link de áudio expirado/);
  assert.doesNotMatch(source, /audio_url: track\.audioUrl/);
});

test('queue removals broadcast an immediate synchronized queue refresh', () => {
  const source = fs.readFileSync(roomJsPath, 'utf8');

  assert.match(source, /broadcastQueueState/);
  assert.match(source, /playback:queueChanged/);
  assert.match(source, /broadcastQueueState\('removeTrack'\)/);
  assert.match(source, /broadcastQueueState\('clearQueue'\)/);
  assert.match(source, /await refreshQueue\(\)/);
});
