import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { acquirePollingLock, openDatabase } from '../../src/infra/db/database.js';
import { createHealthServer } from '../../src/infra/health.js';
import { runWithPollingLock } from '../../src/infra/polling-lock.js';

const timeout = (promise, ms = 5000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('TEST_TIMEOUT')), ms);
  promise.then(
    value => { clearTimeout(timer); resolve(value); },
    error => { clearTimeout(timer); reject(error); },
  );
});

test('a ready replacement waits for the old polling lock then takes over exactly once', async t => {
  let oldLock = openDatabase(':memory:');
  const replacementDb = openDatabase(':memory:');
  const observerDb = openDatabase(':memory:');
  const shutdown = new AbortController();
  t.after(() => {
    shutdown.abort();
    oldLock?.close();
    replacementDb.close();
    observerDb.close();
  });

  assert.equal(acquirePollingLock(oldLock), true);
  const state = { started: true, db: replacementDb, telegramReady: true };
  const health = createHealthServer({ port: 0, version: 'test', readiness: () => state });
  await once(health, 'listening');
  t.after(() => new Promise(resolve => health.close(resolve)));

  let reportWaiting;
  const waiting = new Promise(resolve => { reportWaiting = resolve; });
  let pollingStarts = 0;
  const handoff = runWithPollingLock({
    db: replacementDb,
    shutdownSignal: shutdown.signal,
    retryMs: 10,
    onWaiting: reportWaiting,
    run: signal => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })),
    onAcquired: () => { pollingStarts += 1; },
  });

  await timeout(waiting);
  const { port } = health.address();
  assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 200);
  assert.equal(pollingStarts, 0);
  assert.equal(acquirePollingLock(observerDb), false);

  oldLock.close();
  oldLock = undefined;
  await timeout(new Promise(resolve => {
    const check = setInterval(() => {
      if (pollingStarts === 1) { clearInterval(check); resolve(); }
    }, 5);
  }));
  assert.equal(pollingStarts, 1);
  assert.equal(acquirePollingLock(observerDb), false);

  shutdown.abort();
  assert.equal(await timeout(handoff), true);
});

test('loss of the lock-holding connection aborts polling and fails cleanly', async t => {
  const lockDb = openDatabase(':memory:');
  const controlDb = openDatabase(':memory:');
  const shutdown = new AbortController();
  t.after(() => {
    shutdown.abort();
    lockDb.close();
    controlDb.close();
  });

  const backendPid = lockDb.prepare('SELECT pg_backend_pid() AS id').get().id;
  let pollingStarted;
  const started = new Promise(resolve => { pollingStarted = resolve; });
  let pollingAborted = false;
  let lockLossReported = false;
  const running = runWithPollingLock({
    db: lockDb,
    shutdownSignal: shutdown.signal,
    retryMs: 10,
    onAcquired: pollingStarted,
    onLockLost: () => { lockLossReported = true; },
    run: signal => new Promise(resolve => signal.addEventListener('abort', () => {
      pollingAborted = true;
      resolve();
    }, { once: true })),
  });

  await timeout(started);
  assert.equal(controlDb.prepare('SELECT pg_terminate_backend(?) AS terminated').get(backendPid).terminated, true);
  await assert.rejects(timeout(running), { message: 'POLLING_LOCK_CONNECTION_LOST' });
  assert.equal(lockLossReported, true);
  assert.equal(pollingAborted, true);
});
