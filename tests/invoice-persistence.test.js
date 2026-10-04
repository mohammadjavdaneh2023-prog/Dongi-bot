import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/infra/db/database.js';
import { createRouter } from '../src/bot/router.js';
import { seedResponses } from '../src/bot/responses.js';
import { createPayloadCipher } from '../src/infra/outbox.js';
import { prepareInvoice } from '../src/infra/prepare-invoice.js';

function setup(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close()); seedResponses(db);
  const insert = db.prepare(`INSERT INTO users(id,telegram_user_id,public_id,canonical_name,role,status,bot_started,created_at,updated_at)
    VALUES (?,?,?,?,'MEMBER','ACTIVE',1,1,1)`);
  for (const [i, name] of ['Ali', 'Hasan', 'Reza'].entries()) insert.run(String(i), String(i + 10), ['AB123','CD456','EF789'][i], name);
  const cipher = createPayloadCipher('ab'.repeat(32));
  const router = createRouter({ db, cipher, bot: { id: 999, username: 'testbot' }, config: {}, log: () => {} });
  const update = { update_id: 1, message: { message_id: 1, chat: { id: -100, type: 'supergroup' }, from: { id: 10 },
    text: '#DONGI invoice "شام" 900\npaid: me 600 Hasan 300\nbetween: me Hasan Reza' } };
  const calls = [];
  const telegram = { call: async (method, args) => { assert.equal(db.isTransaction, false); calls.push(args); return { user: { id: args.user_id }, status: 'member' }; } };
  return { db, cipher, router, update, telegram, calls };
}

test('financial command commits invoice, zero entries, audit and receipt together', async t => {
  const f = setup(t);
  const prepared = await prepareInvoice(f.db, f.telegram, f.update);
  assert.equal(f.router(f.update, prepared).event, 'INVOICE_CREATED');
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.db.prepare('SELECT amount,open_amount FROM invoice_entries ORDER BY position').all().map(row => [row.amount,row.open_amount]), [[300,300],[0,0],[-300,-300]]);
  const audit = JSON.parse(f.db.prepare("SELECT metadata_json FROM audit_events WHERE event = 'INVOICE_CREATED'").get().metadata_json);
  assert.equal(audit.entries.length, 3);
  const receipt = f.cipher.decrypt(f.db.prepare('SELECT encrypted_payload FROM response_outbox').get().encrypted_payload).text;
  assert.match(receipt, /Hasan \[CD456\]  0/);
  assert.match(receipt, /#1/);
  assert.equal(await prepareInvoice(f.db, f.telegram, f.update), undefined);
  assert.equal(f.router(f.update).event, 'DUPLICATE_REQUEST');
  assert.equal(f.db.prepare('SELECT count(*) n FROM invoices').get().n, 1);
});

test('missing zero participant membership rejects entire invoice', async t => {
  const f = setup(t);
  const telegram = { call: async (_, args) => ({ user: { id: args.user_id }, status: args.user_id === 11 ? 'left' : 'member' }) };
  const prepared = await prepareInvoice(f.db, telegram, f.update);
  assert.equal(f.router(f.update, prepared).event, 'USER_NOT_IN_GROUP');
  assert.equal(f.db.prepare('SELECT count(*) n FROM invoices').get().n, 0);
});

test('network failure, stale verification and direct unverified routing cannot register money', async t => {
  const f = setup(t);
  const failure = await prepareInvoice(f.db, { call: async () => { throw new Error('secret'); } }, f.update);
  assert.equal(failure.error, 'MEMBERSHIP_CHECK_FAILED');
  const prepared = await prepareInvoice(f.db, f.telegram, f.update);
  prepared.verifiedAt -= 61000;
  assert.equal(f.router(f.update, prepared).event, 'MEMBERSHIP_CHECK_FAILED');
  assert.equal(f.router({ ...f.update, update_id: 2, message: { ...f.update.message, message_id: 2 } }).event, 'MEMBERSHIP_CHECK_FAILED');
  assert.equal(f.db.prepare('SELECT count(*) n FROM invoices').get().n, 0);
});

test('audit failure rolls back invoice and every entry', async t => {
  const f = setup(t);
  const prepared = await prepareInvoice(f.db, f.telegram, f.update);
  f.db.exec("CREATE TRIGGER fail_financial_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'failure'); END");
  assert.equal(f.router(f.update, prepared).event, 'DB_TRANSACTION_FAILED');
  assert.equal(f.db.prepare('SELECT count(*) n FROM invoices').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM invoice_entries').get().n, 0);
});

test('actor status is checked again after network verification', async t => {
  const f = setup(t);
  const prepared = await prepareInvoice(f.db, f.telegram, f.update);
  f.db.prepare("INSERT INTO group_restrictions VALUES ('-100','0',1)").run();
  assert.equal(f.router(f.update, prepared).event, 'ACTOR_FROZEN');
  assert.equal(f.db.prepare('SELECT count(*) n FROM invoices').get().n, 0);
});

test('all includes only current eligible group members', async t => {
  const f = setup(t);
  f.update.message.text = '#DONGI invoice "x" 100\nbetween: all';
  const prepared = await prepareInvoice(f.db, { call: async (_, args) => ({ user: { id: args.user_id }, status: args.user_id === 12 ? 'left' : 'member' }) }, f.update);
  assert.equal(f.router(f.update, prepared).event, 'INVOICE_CREATED');
  assert.equal(f.db.prepare('SELECT count(*) n FROM invoice_entries').get().n, 2);
});
