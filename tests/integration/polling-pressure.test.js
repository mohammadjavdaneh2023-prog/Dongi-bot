import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { databaseDiagnostics, acquirePollingLock, openDatabase } from '../../src/infra/db/database.js';
import { runWithPollingLock } from '../../src/infra/polling-lock.js';
import { runPolling } from '../../src/bot/poller.js';
import { createRouter } from '../../src/bot/router.js';
import { seedResponses } from '../../src/bot/responses.js';
import { createPayloadCipher } from '../../src/infra/outbox.js';

const mib = 1024 * 1024;
const updateCount = 600;

test('bounded PostgreSQL polling pressure recovers across disconnects and releases resources', {
  skip: process.env.DONGI_PRESSURE_TEST === '1' ? false : 'Run with npm run test:pressure',
}, async t => {
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'pressure test requires Node.js 24');
  assert.ok(process.env.TEST_DATABASE_URL, 'pressure test requires a disposable real PostgreSQL database');

  const db = openDatabase(':memory:');
  const lockDb = openDatabase(':memory:');
  const observerDb = openDatabase(':memory:');
  const shutdown = new AbortController();
  t.after(async () => {
    shutdown.abort();
    await Promise.all([lockDb.close(), db.close(), observerDb.close()]);
  });

  seedResponses(db);
  db.exec("INSERT INTO users VALUES ('owner','10','AA111','Owner','OWNER','ACTIVE',1,1,1)");
  const cipher = createPayloadCipher('ab'.repeat(32));
  const bot = { id: 99, username: 'dongi_bot' };
  const router = createRouter({ db, cipher, bot, config: {}, log: () => {} });
  const failures = new Set([5, 12, 19, 26, 33, 40, 47, 54]);
  let pollCalls = 0;
  let deleteWebhookCalls = 0;
  let pollerStarts = 0;
  let deliveredMessages = 0;
  let warmupRss;
  const samples = [];
  const updates = Array.from({ length: updateCount }, (_, index) => ({
    update_id: index + 1,
    message: { date: Math.floor(Date.now() / 1000), message_id: index + 1,
      from: { id: 10 }, chat: { id: -100, type: 'group' }, text: '#DONGI help' },
  }));
  const telegram = { call: async (method, payload) => {
    if (method === 'deleteWebhook') { deleteWebhookCalls += 1; return true; }
    if (method === 'getUpdates') {
      pollCalls += 1;
      if (failures.delete(pollCalls)) throw { code: 'NETWORK' };
      const offset = Number(payload.offset ?? 0);
      const batch = updates.slice(Math.max(0, offset - 1), Math.max(0, offset - 1) + 10);
      if (offset > 100 && warmupRss === undefined) warmupRss = process.memoryUsage().rss;
      if (offset > 100) samples.push(process.memoryUsage());
      return batch;
    }
    if (method === 'sendMessage') { deliveredMessages += 1; return { message_id: 200_000 + deliveredMessages }; }
    if (method === 'deleteMessage' || method === 'answerCallbackQuery') return true;
    throw new Error(`UNEXPECTED_TELEGRAM_METHOD_${method}`);
  } };
  const log = () => {};
  const diagnosticsBefore = databaseDiagnostics();
  const rssBefore = process.memoryUsage().rss;
  assert.deepEqual(diagnosticsBefore, { activeDatabases: 3, activeWorkers: 3, activeDisconnectWaiters: 0 });
  assert.equal(db.prepare("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name='dongi'").get().count, 3);

  const run = runWithPollingLock({
    db: lockDb,
    shutdownSignal: shutdown.signal,
    retryMs: 10,
    onAcquired: () => { pollerStarts += 1; },
    run: pollingSignal => runPolling(
      { db, telegram, router, cipher, log, bot, shutdownSignal: pollingSignal },
      () => Number(db.prepare("SELECT value FROM runtime_state WHERE key='offset'").get()?.value ?? 0) > updateCount,
      async () => {},
    ),
  });

  assert.equal(acquirePollingLock(observerDb), false, 'only the dedicated lock connection may own polling');
  await run;
  assert.equal(pollerStarts, 1);
  assert.equal(deleteWebhookCalls, 1, 'receive session is initialized once, not once per retry');
  assert.equal(deliveredMessages, updateCount);
  assert.equal(db.prepare('SELECT count(*)::integer AS count FROM processed_updates').get().count, updateCount);
  assert.equal(db.prepare("SELECT value FROM runtime_state WHERE key='offset'").get().value, String(updateCount + 1));
  assert.equal(failures.size, 0, 'all eight artificial disconnects must be exercised');

  const memory = process.memoryUsage();
  const peakRss = Math.max(memory.rss, ...samples.map(sample => sample.rss));
  const endSamples = samples.slice(-10);
  const tailSpread = Math.max(...endSamples.map(sample => sample.rss)) - Math.min(...endSamples.map(sample => sample.rss));
  assert.ok(peakRss < 256 * mib, `RSS peak exceeded 256 MiB: ${Math.round(peakRss / mib)} MiB`);
  assert.ok(memory.rss - warmupRss < 64 * mib, `RSS grew more than 64 MiB after warm-up: ${Math.round((memory.rss - warmupRss) / mib)} MiB`);
  assert.ok(tailSpread < 64 * mib, `RSS did not stabilize in the final samples: ${Math.round(tailSpread / mib)} MiB`);
  assert.ok(memory.arrayBuffers < 64 * mib, `array buffers grew beyond their fixed connection budget: ${Math.round(memory.arrayBuffers / mib)} MiB`);

  shutdown.abort();
  assert.equal(databaseDiagnostics().activeDisconnectWaiters, 0, 'shutdown must remove lock disconnect listeners');
  assert.equal(getEventListeners(shutdown.signal, 'abort').length, 0, 'shutdown must remove abort listeners');
  await Promise.all([lockDb.close(), db.close()]);
  assert.equal(acquirePollingLock(observerDb), true, 'closing the owner connection releases the advisory lock');
  assert.equal(observerDb.prepare("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name='dongi'").get().count, 1);
  assert.deepEqual(databaseDiagnostics(), { activeDatabases: 1, activeWorkers: 1, activeDisconnectWaiters: 0 });
  await observerDb.close();
  assert.deepEqual(databaseDiagnostics(), { activeDatabases: 0, activeWorkers: 0, activeDisconnectWaiters: 0 });

  process.stdout.write(`${JSON.stringify({ pressure_test: 'PASS', node: process.versions.node, postgres: 'real', updates: updateCount,
    reconnect_cycles: 8, poller_starts: pollerStarts, rss_before_mib: Math.round(rssBefore / mib),
    rss_warmup_mib: Math.round(warmupRss / mib),
    rss_final_mib: Math.round(memory.rss / mib), rss_peak_mib: Math.round(peakRss / mib),
    rss_tail_spread_mib: Math.round(tailSpread / mib), array_buffers_final_mib: Math.round(memory.arrayBuffers / mib),
    max_rss_mib: 256, workers_and_clients: 3, shutdown_resources: '0 workers / 0 clients / 0 listeners' })}\n`);
});
