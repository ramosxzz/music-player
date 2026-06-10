const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const setupPath = path.join(__dirname, '..', '..', 'setup.js');

test('setup script applies every SQL migration in sorted order', () => {
  const source = fs.readFileSync(setupPath, 'utf8');

  assert.match(source, /readdirSync\(migrationsDir\)/);
  assert.match(source, /\.filter\(\(file\) => file\.endsWith\('\.sql'\)\)/);
  assert.match(source, /\.sort\(\)/);
  assert.doesNotMatch(source, /'001_initial\.sql'/);
});
