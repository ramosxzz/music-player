const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('destructive actions use the SyncBeat modal instead of browser confirm', () => {
  const indexHtml = read('client', 'index.html');
  const roomHtml = read('client', 'room.html');
  const appJs = read('client', 'js', 'app.js');
  const roomJs = read('client', 'js', 'room.js');
  const uiJs = read('client', 'js', 'ui.js');
  const css = read('client', 'style.css');

  assert.match(indexHtml, /\/js\/ui\.js/);
  assert.match(roomHtml, /\/js\/ui\.js/);
  assert.match(uiJs, /window\.SyncBeatUI/);
  assert.match(uiJs, /confirm\(/);
  assert.match(css, /\.sb-modal-backdrop/);
  assert.match(css, /\.sb-modal/);
  assert.match(appJs, /SyncBeatUI\.confirm/);
  assert.match(roomJs, /SyncBeatUI\.confirm/);
  assert.doesNotMatch(appJs, /window\.confirm|[^.\w]confirm\(/);
  assert.doesNotMatch(roomJs, /window\.confirm|[^.\w]confirm\(/);
  assert.doesNotMatch(appJs, /alert\(/);
  assert.doesNotMatch(roomJs, /alert\(/);
});

test('room queue has clearer remove and clear actions', () => {
  const html = read('client', 'room.html');
  const js = read('client', 'js', 'room.js');
  const css = read('client', 'style.css');

  assert.match(html, /id="clear-queue-btn"/);
  assert.match(js, /clearQueue\(/);
  assert.match(js, /confirmQueueRemoval/);
  assert.match(js, /queue-action-btn/);
  assert.match(js, /data-action="remove-track"/);
  assert.match(css, /\.queue-header-actions/);
  assert.match(css, /\.queue-action-btn/);
  assert.match(css, /\.clear-queue-btn/);
  assert.doesNotMatch(js, />x<\/button>/);
});

test('host can promote and remove co-hosts from the listeners panel', () => {
  const js = read('client', 'js', 'room.js');
  const css = read('client', 'style.css');

  assert.match(js, /toggleCoHost/);
  assert.match(js, /data-action="promote-cohost"/);
  assert.match(js, /data-action="demote-cohost"/);
  assert.match(js, /listener-cohost-tag/);
  assert.match(js, /co_hosts/);
  assert.match(css, /\.listener-actions/);
  assert.match(css, /\.listener-role-btn/);
});

test('visualizer and light theme use redesigned surfaces', () => {
  const css = read('client', 'style.css');
  const js = read('client', 'js', 'room.js');

  assert.match(css, /\.sound-ribbon/);
  assert.match(css, /\.visualizer-container::after/);
  assert.match(css, /:root\.light-theme \.room-page/);
  assert.match(css, /:root\.light-theme \.room-sidebar/);
  assert.match(css, /:root\.light-theme \.player-bar/);
  assert.match(css, /:root\.light-theme \.now-playing-card/);
  assert.match(css, /:root\.light-theme \.volume-slider/);
  assert.match(css, /:root\.light-theme \.mobile-player-bar \.btn-icon/);
  assert.match(js, /createLinearGradient/);
  assert.match(js, /roundRect/);
});

test('room light theme and mobile layout are usable', () => {
  const html = read('client', 'room.html');
  const css = read('client', 'style.css');

  assert.match(html, /class="form-hint"/);
  assert.match(css, /:root\.light-theme \.add-music-tabs/);
  assert.match(css, /:root\.light-theme \.add-tab\.active/);
  assert.match(css, /:root\.light-theme \.add-music-panel input/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.room-page[\s\S]*height:\s*auto/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.room-main[\s\S]*overflow-y:\s*visible/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.input-row[\s\S]*flex-direction:\s*column/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.player-bar[\s\S]*position:\s*sticky/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*\.now-playing-card[\s\S]*grid-template-columns:\s*72px 1fr/);
});
