const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const migrationPath = path.join(__dirname, '..', '..', 'supabase', 'migrations', '002_room_controller_policies.sql');

test('room controller migration lets hosts and co-hosts update playback state', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /DROP POLICY IF EXISTS "rooms_update"/);
  assert.match(sql, /CREATE POLICY "rooms_update"/);
  assert.match(sql, /auth\.uid\(\) = host_id/);
  assert.match(sql, /auth\.uid\(\) = ANY\(co_hosts\)/);
});
