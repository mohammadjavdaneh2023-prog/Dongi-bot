import { loadConfig } from '../src/infra/config.js';
import { migrationsCurrent, openDatabase } from '../src/infra/db/database.js';

let db;
try {
  const config = loadConfig(process.env, { requireRuntimeSecrets: false });
  db = openDatabase(config.databaseUrl);
  if (!migrationsCurrent(db)) throw new Error('MIGRATIONS_INCOMPLETE');
  process.stdout.write(`${JSON.stringify({ status: 'migrated' })}\n`);
} catch {
  process.stderr.write(`${JSON.stringify({ status: 'migration_failed' })}\n`);
  process.exitCode = 1;
} finally { db?.close(); }
