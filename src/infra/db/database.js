import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { DomainError } from '../../domain/errors.js';

const migrations = [new URL('./migrations/001_initial_postgresql.sql', import.meta.url)];
const responseBytes = 16 * 1024 * 1024;

function rpc(worker, operation, payload = {}) {
  const shared = new SharedArrayBuffer(12 + responseBytes);
  const header = new Int32Array(shared, 0, 3);
  worker.postMessage({ shared, operation, ...payload });
  const status = Atomics.wait(header, 0, 0, 30000);
  if (status === 'timed-out') throw new Error('DB_OPERATION_TIMEOUT');
  const length = Atomics.load(header, 1);
  const failed = Atomics.load(header, 2) === 1;
  const text = new TextDecoder().decode(new Uint8Array(shared, 12, length));
  const value = JSON.parse(text);
  if (failed) throw Object.assign(new Error(value.code), value);
  return value;
}

class PreparedStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; }
  all(...params) { return this.db.query(this.sql, params).rows; }
  get(...params) { return this.all(...params)[0]; }
  run(...params) {
    const result = this.db.query(this.sql, params);
    const first = result.rows[0] ?? {};
    return { changes: result.rowCount, lastInsertRowid: first.public_ref ?? first.id };
  }
}

class Database {
  constructor(databaseUrl, { test = false } = {}) {
    this.worker = new Worker(new URL('./postgres-worker.js', import.meta.url));
    this.isTransaction = false;
    this.closed = false;
    this.connectionLost = false;
    this.disconnectWaiters = new Set();
    this.worker.on('message', message => {
      if (message?.event === 'connection_lost') this.markConnectionLost();
    });
    this.worker.on('error', () => this.markConnectionLost());
    this.worker.on('exit', () => { if (!this.closed) this.markConnectionLost(); });
    const schema = test ? `dongi_test_${randomBytes(8).toString('hex')}` : undefined;
    rpc(this.worker, 'connect', { databaseUrl, schema });
  }
  markConnectionLost() {
    if (this.connectionLost || this.closed) return;
    this.connectionLost = true;
    for (const resolve of this.disconnectWaiters) resolve(true);
    this.disconnectWaiters.clear();
  }
  assertAvailable() {
    if (this.closed) throw new Error('DB_CLOSED');
    if (this.connectionLost) throw new Error('DB_CONNECTION_LOST');
  }
  prepare(sql) { return new PreparedStatement(this, sql); }
  query(sql, params = []) { this.assertAvailable(); return rpc(this.worker, 'query', { sql, params }); }
  exec(sql) { this.assertAvailable(); return rpc(this.worker, 'exec', { sql }); }
  waitForDisconnect(signal) {
    if (this.connectionLost) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        this.disconnectWaiters.delete(onDisconnect);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onDisconnect = value => finish(value);
      const onAbort = () => finish(false);
      this.disconnectWaiters.add(onDisconnect);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.disconnectWaiters) resolve(false);
    this.disconnectWaiters.clear();
    try {
      if (!this.connectionLost) rpc(this.worker, 'close');
    } catch {
      this.connectionLost = true;
    } finally {
      this.worker.terminate();
    }
  }
}

function applyMigrations(db) {
  db.exec('BEGIN');
  try {
    db.exec("SELECT pg_advisory_xact_lock(hashtext('dongi:migrations')); CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at bigint NOT NULL)");
    const applied = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
    if (applied.some((row, index) => row.version !== index + 1) || applied.length > migrations.length) throw new Error('UNSUPPORTED_DATABASE_SCHEMA');
    for (let index = applied.length; index < migrations.length; index++) {
      db.exec(readFileSync(migrations[index], 'utf8'));
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(index + 1, Date.now());
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
    throw error;
  }
}

export function openDatabase(databaseUrl) {
  const test = databaseUrl === ':memory:';
  const url = test ? process.env.TEST_DATABASE_URL : databaseUrl;
  if (!url || !/^postgres(?:ql)?:\/\//i.test(url)) throw new Error(test ? 'TEST_DATABASE_URL_REQUIRED' : 'DATABASE_URL_REQUIRED');
  const db = new Database(url, { test });
  try { applyMigrations(db); return db; }
  catch (error) { db.close(); throw error; }
}

export function migrationsCurrent(db) {
  return db.prepare('SELECT count(*)::integer AS count FROM schema_migrations').get()?.count === migrations.length;
}

export function acquirePollingLock(db) {
  return db.prepare("SELECT pg_try_advisory_lock(hashtext('dongi:telegram-poller')) AS acquired").get()?.acquired === true;
}

export function transaction(db, work) {
  let began = false;
  try {
    db.exec('BEGIN');
    began = true;
    db.isTransaction = true;
    const result = work();
    if (result && typeof result.then === 'function') throw new Error('ASYNC_TRANSACTION_FORBIDDEN');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (began) try { db.exec('ROLLBACK'); } catch { /* Preserve domain failure. */ }
    if (error instanceof DomainError) throw error;
    throw new DomainError('DB_TRANSACTION_FAILED');
  } finally {
    db.isTransaction = false;
  }
}
