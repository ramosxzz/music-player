const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..', '..');
const file = (...parts) => path.join(root, ...parts);
const read = (...parts) => {
  const target = file(...parts);
  assert.equal(fs.existsSync(target), true, `${parts.join('/')} should exist`);
  return fs.readFileSync(target, 'utf8');
};

test('desktop and mobile frontends use separate HTML shells with device routing', () => {
  const indexHtml = read('client', 'index.html');
  const mobileHtml = read('client', 'mobile.html');
  const roomHtml = read('client', 'room.html');
  const roomMobileHtml = read('client', 'room-mobile.html');
  const appJs = read('client', 'js', 'app.js');
  const roomJs = read('client', 'js', 'room.js');
  const deviceRouter = read('client', 'js', 'device-router.js');

  assert.match(indexHtml, /\/js\/device-router\.js/);
  assert.match(roomHtml, /\/js\/device-router\.js/);
  assert.match(mobileHtml, /class="mobile-home-page"/);
  assert.match(roomMobileHtml, /class="mobile-room-page"/);
  assert.match(mobileHtml, /id="landing-section"/);
  assert.match(mobileHtml, /id="room-section"/);
  assert.match(roomMobileHtml, /id="add-music-panel"/);
  assert.match(roomMobileHtml, /id="queue-list"/);
  assert.match(roomMobileHtml, /id="listeners-list"/);
  assert.match(roomMobileHtml, /id="player-controls"/);
  assert.match(roomMobileHtml, /id="youtube-iframe-player"/);
  assert.match(deviceRouter, /max-width:\s*760px/);
  assert.match(deviceRouter, /room-mobile\.html/);
  assert.match(deviceRouter, /mobile\.html/);
  assert.match(deviceRouter, /'mobile':\s*isMobile \? null : 'index\.html'/);
  assert.match(deviceRouter, /'room':\s*isMobile \? 'room-mobile\.html' : null/);
  assert.match(deviceRouter, /'room-mobile':\s*isMobile \? null : 'room\.html'/);
  assert.match(appJs, /getRoomPagePath/);
  assert.match(appJs, /room-mobile\.html/);
  assert.match(roomJs, /getRoomPagePath/);
  assert.match(roomJs, /mobile-room-page/);
  assert.doesNotMatch(appJs, /window\.location\.href = `\/room\.html\?room=/);
  assert.doesNotMatch(roomJs, /location\.origin}\/room\.html\?room=/);
});

test('PWA shell is installable and caches both desktop and mobile frontends', () => {
  const manifest = JSON.parse(read('client', 'manifest.webmanifest'));
  const serviceWorker = read('client', 'sw.js');
  const htmlFiles = ['index.html', 'mobile.html', 'room.html', 'room-mobile.html'];

  assert.equal(manifest.name, 'SyncBeat');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/mobile.html');
  assert.equal(manifest.scope, '/');
  assert.ok(manifest.icons.length >= 2);
  assert.ok(fs.existsSync(file('client', 'icons', 'icon-192.png')));
  assert.ok(fs.existsSync(file('client', 'icons', 'icon-512.png')));
  assert.match(JSON.stringify(manifest.icons), /\/icons\/icon-192\.png/);
  assert.match(JSON.stringify(manifest.icons), /\/icons\/icon-512\.png/);

  for (const htmlFile of htmlFiles) {
    const html = read('client', htmlFile);
    assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
    assert.match(html, /name="theme-color"/);
    assert.match(html, /apple-mobile-web-app-capable/);
  }

  assert.match(serviceWorker, /syncbeat-pwa-v2/);
  assert.match(serviceWorker, /install/);
  assert.match(serviceWorker, /fetch/);
  assert.match(serviceWorker, /mobile\.html/);
  assert.match(serviceWorker, /room-mobile\.html/);
});
