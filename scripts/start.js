import { loadConfig } from '../src/infra/config.js';
import { acquirePollingLock, openDatabase } from '../src/infra/db/database.js';
import { createLogger, newTraceId } from '../src/infra/logging.js';
import { createPurposeCipher } from '../src/infra/outbox.js';
import { createTelegramClient } from '../src/infra/telegram.js';
import { seedResponses } from '../src/bot/responses.js';
import { createRouter } from '../src/bot/router.js';
import { runPolling } from '../src/bot/poller.js';
import { createHealthServer } from '../src/infra/health.js';
import { createAiRuntime } from '../src/infra/ai-runtime.js';

let db;
let health;
const state = { started: false, db: undefined, telegramReady: false };
const shutdown = new AbortController();

function stop() { state.started = false; shutdown.abort(); }
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  const config = loadConfig();
  const log = createLogger(config);
  health = createHealthServer({ port: config.port, version: config.appVersion, readiness: () => state });
  db = openDatabase(config.databaseUrl);
  state.db = db;
  if (!acquirePollingLock(db)) throw new Error('POLLING_CONSUMER_ALREADY_ACTIVE');
  if (!db.prepare("SELECT id FROM users WHERE role='OWNER'").get()) throw new Error('OWNER_CONFIG_REQUIRED');
  const cipher = createPurposeCipher(config.encryptionKey, 'outbox');
  const telegram = createTelegramClient(process.env.TELEGRAM_BOT_TOKEN);
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
  log('BOT_STARTED', newTraceId(), { stage: 'POLL' });
  await runPolling({ db, telegram, router, cipher, log, bot, ai, shutdownSignal: shutdown.signal }, () => shutdown.signal.aborted);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: 'ERROR', service: 'dongi', event: 'BOT_START_OR_RUNTIME_FAILED', error_type: error?.message && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'STARTUP_FAILED' })}\n`);
  process.exitCode = 1;
} finally {
  state.started = false;
  await new Promise(resolve => health?.close(resolve) ?? resolve());
  db?.close();
}
