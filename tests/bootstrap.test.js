import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { openDatabase } from '../src/infra/db/database.js';

test('bootstrap CLI reserves the configured owner without starting them or leaking credentials', () => {
  const env = { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL,
    APP_ENCRYPTION_KEY: '0'.repeat(64), OWNER_TELEGRAM_ID: '123456',
    OWNER_NAME: 'رئیس', OWNER_PUBLIC_ID: 'AB417', TELEGRAM_BOT_TOKEN: 'secret-test-value' };
  const run = extra => spawnSync(process.execPath, ['scripts/bootstrap-owner.js'], { env: { ...env, ...extra }, encoding: 'utf8' });
  for (let i = 0; i < 2; i++) {
    const result = run({});
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(output.public_id, 'AB417');
    assert.equal(output.bot_started, false);
    assert.doesNotMatch(result.stdout + result.stderr, /secret-test-value/);
  }
  const conflict = run({ OWNER_TELEGRAM_ID: '999' });
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /OWNER_ALREADY_CONFIGURED/);
  const missing = run({ OWNER_NAME: '' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /OWNER_CONFIG_REQUIRED/);
  const db = openDatabase(env.DATABASE_URL);
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit_events').get().n, 1);
  } finally { db.close(); }
});
