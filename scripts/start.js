import { loadConfig } from '../src/infra/config.js';
import { openDatabase } from '../src/infra/db/database.js';
import { createLogger, newTraceId } from '../src/infra/logging.js';
import { createPurposeCipher } from '../src/infra/outbox.js';
import { createTelegramClient } from '../src/infra/telegram.js';
import { seedResponses } from '../src/bot/responses.js';
import { createRouter } from '../src/bot/router.js';
import { cleanupTemporary, runPolling } from '../src/bot/poller.js';
import { createHealthServer } from '../src/infra/health.js';
import { createAiRuntime } from '../src/infra/ai-runtime.js';
import { runWithPollingLock } from '../src/infra/polling-lock.js';

let db;
let lockDb;
let health;
let memoryTimer;
let telegram;
let log;
const state = { started: false, db: undefined, telegramReady: false };
const shutdown = new AbortController();

function stop() { state.started = false; shutdown.abort(); }
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  const config = loadConfig();
  log = createLogger(config);
  health = createHealthServer({ port: config.port, version: config.appVersion, readiness: () => state });
  db = openDatabase(config.databaseUrl);
  state.db = db;
  if (!db.prepare("SELECT id FROM users WHERE role='OWNER'").get()) throw new Error('OWNER_CONFIG_REQUIRED');
  const cipher = createPurposeCipher(config.encryptionKey, 'outbox');
  telegram = createTelegramClient(process.env.TELEGRAM_BOT_TOKEN);
  const keyCheck = db.prepare("SELECT value FROM runtime_state WHERE key='encryption_key_check'").get();
  if (keyCheck) {
    if (cipher.decrypt(keyCheck.value) !== 'DONGI') throw new Error('INVALID_APP_ENCRYPTION_KEY');
  } else db.prepare("INSERT INTO runtime_state(key,value) VALUES ('encryption_key_check',?)").run(cipher.encrypt('DONGI'));
  const bot = await telegram.call('getMe');
  const previousBot = db.prepare("SELECT value FROM runtime_state WHERE key='bot_id'").get();
  if (previousBot && previousBot.value !== String(bot.id)) throw new Error('DATABASE_BOT_MISMATCH');
  db.prepare("INSERT INTO runtime_state(key,value) VALUES ('bot_id',?) ON CONFLICT(key) DO NOTHING").run(String(bot.id));
  seedResponses(db);
  const ai = createAiRuntime({ apiKey: config.aiApiKey, db, log });
  const router = createRouter({ db, cipher, bot, config, log });
  state.telegramReady = true;
  state.started = true;
  lockDb = openDatabase(config.databaseUrl);
  const logMemory = () => {
    const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
    log('PROCESS_MEMORY', newTraceId(), {
      stage: 'RUNTIME', rss_bytes: rss, heap_used_bytes: heapUsed,
      external_bytes: external, array_buffers_bytes: arrayBuffers,
    });
  };
  logMemory();
  memoryTimer = setInterval(logMemory, 60_000);
  memoryTimer.unref();
  await runWithPollingLock({
    db: lockDb,
    shutdownSignal: shutdown.signal,
    onWaiting: () => log('POLLING_LOCK_WAITING', newTraceId(), { stage: 'POLL' }),
    onAcquired: () => log('BOT_STARTED', newTraceId(), { stage: 'POLL', process_id: process.pid }),
    onLockLost: () => { state.started = false; },
    run: pollingSignal => runPolling(
      { db, telegram, router, cipher, log, bot, ai, shutdownSignal: pollingSignal },
      () => pollingSignal.aborted,
    ),
  });
} catch (error) {
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: 'ERROR', service: 'dongi', event: 'BOT_START_OR_RUNTIME_FAILED', error_type: error?.message && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'STARTUP_FAILED' })}\n`);
  process.exitCode = 1;
} finally {
  state.started = false;
  clearInterval(memoryTimer);
  await new Promise(resolve => health?.close(resolve) ?? resolve());
  try {
    if (db && telegram) await cleanupTemporary({ db, telegram });
  } catch {
    log?.('TEMPORARY_CLEANUP_INCOMPLETE', newTraceId(), { stage: 'SHUTDOWN', error_type: 'TELEGRAM_OR_STORAGE_FAILURE' }, 'WARN');
  }
  await lockDb?.close();
  await db?.close();
}
