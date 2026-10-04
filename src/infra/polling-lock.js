import { acquirePollingLock } from './db/database.js';

function delay(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function waitForPollingLock(db, {
  signal,
  retryMs = 1000,
  sleep = delay,
  onWaiting = () => {},
} = {}) {
  let waitingReported = false;
  while (!signal?.aborted) {
    if (acquirePollingLock(db)) return true;
    if (!waitingReported) {
      waitingReported = true;
      onWaiting();
    }
    await sleep(retryMs, signal);
  }
  return false;
}

export async function runWithPollingLock({
  db,
  shutdownSignal,
  run,
  retryMs,
  sleep,
  onWaiting,
  onAcquired = () => {},
  onLockLost = () => {},
}) {
  const acquired = await waitForPollingLock(db, {
    signal: shutdownSignal,
    retryMs,
    sleep,
    onWaiting,
  });
  if (!acquired) return false;

  onAcquired();
  const lockFailure = new AbortController();
  const pollingSignal = shutdownSignal
    ? AbortSignal.any([shutdownSignal, lockFailure.signal])
    : lockFailure.signal;
  const polling = Promise.resolve().then(() => run(pollingSignal));
  const outcome = await Promise.race([
    polling.then(() => ({ type: 'polling_stopped' })),
    db.waitForDisconnect(shutdownSignal).then(lost => ({ type: lost ? 'lock_lost' : 'shutdown' })),
  ]);

  if (outcome.type === 'lock_lost') {
    onLockLost();
    lockFailure.abort();
    await polling.catch(() => {});
    throw new Error('POLLING_LOCK_CONNECTION_LOST');
  }
  if (outcome.type === 'shutdown') {
    lockFailure.abort();
    await polling;
  }
  return true;
}
