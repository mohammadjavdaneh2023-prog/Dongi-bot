import { loadConfig } from '../src/infra/config.js';
import { openDatabase } from '../src/infra/db/database.js';
import { IdentityRepository } from '../src/repositories/identity.js';
import { OnboardingService } from '../src/domain/users/onboarding.js';
import { createLogger, newTraceId } from '../src/infra/logging.js';
import { DomainError } from '../src/domain/errors.js';

let db;
try {
  const config = loadConfig(process.env, { requireRuntimeSecrets: false });
  const ownerTelegramId = process.env.OWNER_TELEGRAM_ID;
  const name = process.env.OWNER_NAME;
  if (!ownerTelegramId || !name) throw new DomainError('OWNER_CONFIG_REQUIRED');
  const log = createLogger(config);
  const traceId = newTraceId();
  db = openDatabase(config.databaseUrl);
  const service = new OnboardingService(new IdentityRepository(db), config);
  const owner = service.bootstrapOwner({ ownerTelegramId, name, publicId: process.env.OWNER_PUBLIC_ID, traceId });
  log('OWNER_BOOTSTRAP_COMPLETED', traceId, { stage: 'COMMITTED', dongi_user_id: owner.id, public_id: owner.public_id });
  process.stdout.write(`${JSON.stringify({ public_id: owner.public_id, bot_started: Boolean(owner.bot_started), trace_id: traceId })}\n`);
} catch (error) {
  process.stderr.write(`${error.code && /^[A-Z_]+$/.test(error.code) ? error.code : 'BOOTSTRAP_FAILED'}\n`);
  process.exitCode = 1;
} finally { db?.close(); }
