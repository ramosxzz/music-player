const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('Claude design language is integrated into the static SyncBeat frontend', () => {
  const indexHtml = read('client', 'index.html');
  const roomHtml = read('client', 'room.html');
  const mobileRoomHtml = read('client', 'room-mobile.html');
  const css = read('client', 'style.css');

  assert.match(css, /Plus\+Jakarta\+Sans/);
  assert.match(css, /--purple:\s*#7C3AED/i);
  assert.match(css, /--accent:\s*#22D3EE/i);
  assert.match(css, /\.syncbeat-ambient-shell/);
  assert.match(css, /\.room-queue-rail/);
  assert.match(css, /\.sync-status-pill/);
  assert.match(css, /\.mobile-room-tabs/);
  assert.match(indexHtml, /syncbeat-ambient-shell/);
  assert.match(indexHtml, /claude-home-actions/);
  assert.match(roomHtml, /room-queue-rail/);
  assert.match(roomHtml, /sync-status-pill/);
  assert.match(mobileRoomHtml, /mobile-room-tabs/);
});
