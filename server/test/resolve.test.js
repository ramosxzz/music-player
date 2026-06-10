const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

const TEST_PORT = 3137;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname + '/..',
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      SPOTIFY_CLIENT_ID: '',
      SPOTIFY_CLIENT_SECRET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  return { child, getLogs: () => ({ stdout, stderr }) };
}

async function waitForHealth() {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch (_) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('server did not become healthy');
}

test('resolve endpoint returns an error response instead of crashing when yt-dlp is missing', async (t) => {
  const server = startServer();

  t.after(() => {
    if (!server.child.killed) server.child.kill();
  });

  await waitForHealth();

  const res = await fetch(`${BASE_URL}/api/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: 'test song' }),
  });

  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /yt-dlp/i);

  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(server.child.exitCode, null, JSON.stringify(server.getLogs()));
});
