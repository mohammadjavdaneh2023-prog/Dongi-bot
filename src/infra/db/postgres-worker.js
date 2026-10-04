import { parentPort } from 'node:worker_threads';
import pg from 'pg';

const { Client, types } = pg;
types.setTypeParser(20, value => Number(value));
let client;
let testSchema;
const testTriggers = new Map();

function placeholders(sql) {
  let index = 0;
  let quote = false;
  let result = '';
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (char === "'" && sql[i - 1] !== '\\') quote = !quote;
    result += char === '?' && !quote ? `$${++index}` : char;
  }
  return result;
}

function compatibleSql(input) {
  if (/^\s*PRAGMA\s+table_info\(([^)]+)\)/i.test(input)) {
    const table = input.match(/^\s*PRAGMA\s+table_info\(([^)]+)\)/i)[1].replace(/['"]/g, '');
    return `SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='${table}' ORDER BY ordinal_position`;
  }
  let sql = placeholders(input);
  sql = sql.replace(/\browid\b/gi, 'ctid');
  if (/^\s*INSERT\s+OR\s+IGNORE\s+/i.test(sql)) {
    sql = sql.replace(/^\s*INSERT\s+OR\s+IGNORE\s+/i, 'INSERT ');
    if (!/\bON\s+CONFLICT\b/i.test(sql)) sql = `${sql.replace(/;\s*$/, '')} ON CONFLICT DO NOTHING`;
  }
  return sql;
}

function compatibleExec(input) {
  const create = input.trim().match(/^CREATE TRIGGER\s+(\w+)\s+BEFORE INSERT ON\s+(\w+)(?:\s+WHEN\s+(.+?))?\s+BEGIN SELECT RAISE\(ABORT\s*,\s*'[^']*'\); END;?$/i);
  if (create) {
    const [, name, table, condition] = create;
    testTriggers.set(name, table);
    const body = condition
      ? `BEGIN IF ${condition} THEN RAISE EXCEPTION 'test_forced_failure'; END IF; RETURN NEW; END`
      : `BEGIN RAISE EXCEPTION 'test_forced_failure'; END`;
    return `CREATE FUNCTION ${name}_fn() RETURNS trigger LANGUAGE plpgsql AS $$ ${body} $$; CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}_fn()`;
  }
  const drop = input.trim().match(/^DROP TRIGGER\s+(\w+);?$/i);
  if (drop && testTriggers.has(drop[1])) {
    const name = drop[1];
    const table = testTriggers.get(name);
    testTriggers.delete(name);
    return `DROP TRIGGER ${name} ON ${table}; DROP FUNCTION ${name}_fn()`;
  }
  return input;
}

function write(shared, value, failed = false) {
  const header = new Int32Array(shared, 0, 3);
  const target = new Uint8Array(shared, 12);
  let bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > target.length) {
    bytes = new TextEncoder().encode(JSON.stringify({ code: 'DB_RESPONSE_TOO_LARGE' }));
    failed = true;
  }
  target.set(bytes);
  Atomics.store(header, 1, bytes.length);
  Atomics.store(header, 2, failed ? 1 : 0);
  Atomics.store(header, 0, 1);
  Atomics.notify(header, 0);
}

parentPort.on('message', async ({ shared, operation, sql, params = [], databaseUrl, schema }) => {
  try {
    if (operation === 'connect') {
      client = new Client({ connectionString: databaseUrl, application_name: 'dongi', connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 10000 });
      await client.connect();
      if (schema) {
        testSchema = schema;
        await client.query(`CREATE SCHEMA ${schema}`);
        await client.query(`SET search_path TO ${schema}, public`);
      }
      return write(shared, { connected: true });
    }
    if (!client) throw Object.assign(new Error('Database not connected'), { code: 'DB_NOT_CONNECTED' });
    if (operation === 'query') {
      const result = await client.query(compatibleSql(sql), params);
      return write(shared, { rows: result.rows, rowCount: result.rowCount ?? 0 });
    }
    if (operation === 'exec') {
      await client.query(compatibleExec(sql));
      return write(shared, { ok: true });
    }
    if (operation === 'close') {
      if (testSchema) await client.query(`DROP SCHEMA ${testSchema} CASCADE`);
      await client.end();
      return write(shared, { closed: true });
    }
    throw Object.assign(new Error('Unsupported database operation'), { code: 'DB_OPERATION_UNSUPPORTED' });
  } catch (error) {
    write(shared, { code: error.code ?? 'DB_OPERATION_FAILED', constraint: error.constraint ?? null }, true);
  }
});
