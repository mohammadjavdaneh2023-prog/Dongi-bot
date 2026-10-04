import test from 'node:test';
import assert from 'node:assert/strict';
import { projectBalance, settlementPlan } from '../src/domain/balances.js';
import { openDatabase } from '../src/infra/db/database.js';
import { createRouter } from '../src/bot/router.js';
import { seedResponses } from '../src/bot/responses.js';
import { createPayloadCipher } from '../src/infra/outbox.js';
import { prepareInvoice } from '../src/infra/prepare-invoice.js';

const users = ['A','B','C'].map((name, i) => ({ id: String(i), public_id: ['AB123','CD456','EF789'][i], canonical_name: name, status: 'ACTIVE', bot_started: 1, telegram_user_id: String(10+i) }));
const invoice = (amounts, extra = {}) => ({ lifecycle_status: 'ACTIVE', source_chat_id: '-999', entries: amounts.map((amount,i) => ({ user_id: String(i), amount })), ...extra });

test('projection includes cross-group invoices and zero members control inclusion', () => {
  const all = new Set(['0','1','2']);
  const invoices = [invoice([100,-100,0])];
  assert.deepEqual(projectBalance(invoices, users, all).rows.map(row => row.amount), [100n,-100n,0n]);
  const excluded = projectBalance(invoices, users, new Set(['0','1']));
  assert.equal(excluded.excluded, 1); assert.equal(excluded.included, 0);
  assert.deepEqual(excluded.rows.map(row => row.amount), [0n,0n]);
});
test('void and unrelated invoices do not contribute; suspended participants exclude invoices', () => {
  const invoices = [invoice([100,-100]), invoice([400,-400], { lifecycle_status: 'VOID' })];
  const result = projectBalance(invoices, users, new Set(['0','1','2']));
  assert.equal(result.included, 1);
  assert.equal(projectBalance(invoices, users, new Set(['2'])).excluded, 0);
  const changed = users.map(user => user.id === '1' ? { ...user, status: 'SUSPENDED' } : user);
  assert.equal(projectBalance(invoices, changed, new Set(['0','1','2'])).excluded, 1);
});
test('sums beyond safe number boundary remain exact and planner preserves input', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const balance = projectBalance([invoice([max,-max]), invoice([max,-max])], users, new Set(['0','1','2']));
  assert.equal(balance.rows[0].amount, BigInt(max)*2n);
  const before = structuredClone(balance.rows);
  const plan = settlementPlan(balance.rows);
  assert.equal(plan.length, 1); assert.equal(plan[0].amount, BigInt(max)*2n);
  assert.deepEqual(balance.rows, before);
});
test('planner deterministically chooses largest balances and clears every balance', () => {
  const rows = [100n,100n,-150n,-50n].map((amount,i) => ({ public_id: `ID${i}`, name: `User${i}`, amount }));
  const transfers = settlementPlan(rows);
  assert.equal(transfers[0].from, 'ID2'); assert.equal(transfers[0].to, 'ID0');
  const remaining = new Map(rows.map(row => [row.public_id,row.amount]));
  for (const transfer of transfers) {
    remaining.set(transfer.from, remaining.get(transfer.from)+transfer.amount);
    remaining.set(transfer.to, remaining.get(transfer.to)-transfer.amount);
  }
  assert.ok([...remaining.values()].every(amount => amount === 0n));
});
test('balance and settle-plan run through router without financial writes', async t => {
  const db = openDatabase(':memory:'); t.after(() => db.close()); seedResponses(db);
  for (const user of users) db.prepare("INSERT INTO users VALUES (?,?,?,?,'MEMBER','ACTIVE',1,1,1)").run(user.id,user.telegram_user_id,user.public_id,user.canonical_name);
  const cipher = createPayloadCipher('ab'.repeat(32));
  const router = createRouter({ db,cipher,bot: { id: 99, username:'TestBot' },config:{},log:()=>{} });
  const telegram = { call: async (_, args) => ({ user: { id: args.user_id },status:'member' }) };
  let seq = 0;
  const send = async (text, chatId) => {
    const update = { update_id: ++seq, message: { message_id: seq,from:{id:10},chat:{id:chatId,type:'group'},text } };
    return router(update, await prepareInvoice(db,telegram,update));
  };
  assert.equal((await send('#DONGI invoice "x" 100\nbetween: CD456',-100)).event,'INVOICE_CREATED');
  const audits = db.prepare('SELECT count(*) n FROM audit_events').get().n;
  assert.equal((await send('#DONGI balance',-200)).event,'BALANCE_READY');
  assert.equal((await send('#DONGI settle-plan',-200)).event,'SETTLEMENT_PLAN_READY');
  assert.equal(db.prepare('SELECT count(*) n FROM invoices').get().n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM audit_events').get().n,audits);
  const texts = db.prepare('SELECT encrypted_payload FROM response_outbox').all().map(row => cipher.decrypt(row.encrypted_payload).text);
  assert.match(texts[1], /A \[AB123\]  \+100/);
  assert.match(texts[2], /B \[CD456\] → A \[AB123\]: 100/);
});
