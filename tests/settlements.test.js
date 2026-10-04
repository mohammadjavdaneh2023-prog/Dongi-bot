import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/infra/db/database.js';
import { createRouter } from '../src/bot/router.js';
import { seedResponses } from '../src/bot/responses.js';
import { createPayloadCipher } from '../src/infra/outbox.js';
import { prepareInvoice } from '../src/infra/prepare-invoice.js';
import { settlementState } from '../src/domain/settlements.js';

function fixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close()); seedResponses(db);
  for (const [id,pid] of [[10,'AB123'],[11,'CD456'],[12,'EF789']]) db.prepare("INSERT INTO users VALUES (?,?,?,?,'MEMBER','ACTIVE',1,1,1)").run(String(id),String(id),pid,pid);
  const router = createRouter({ db, cipher:createPayloadCipher('ab'.repeat(32)),bot:{id:99,username:'testbot'},config:{},log:()=>{} });
  const telegram = { call: async (_,args) => ({user:{id:args.user_id},status:'member'}) };
  let seq = 0;
  const send = async text => {
    const update = {update_id:++seq,message:{message_id:seq,chat:{id:-100,type:'group'},from:{id:10},text}};
    const result = router(update,await prepareInvoice(db,telegram,update));
    return {result,update};
  };
  return {db,router,send};
}
test('settlement allocates both sides newest-first and duplicate update does not reallocate', async t => {
  const f=fixture(t);
  await f.send('#DONGI invoice "old"\nAB123 -100\nCD456 +100');
  await f.send('#DONGI invoice "new"\nAB123 -200\nCD456 +200');
  const {result,update}=await f.send('#DONGI settle 250\nto: CD456');
  assert.equal(result.event,'SETTLEMENT_CREATED');
  const rows=f.db.prepare('SELECT i.public_ref,e.amount,e.open_amount FROM invoice_entries e JOIN invoices i ON i.id=e.invoice_id ORDER BY i.public_ref,e.position').all();
  assert.deepEqual(rows.map(row=>row.open_amount),[-50,50,0,0,0,0]);
  assert.deepEqual(rows.slice(-2).map(row=>row.amount),[250,-250]);
  assert.equal(f.db.prepare('SELECT count(*) n FROM settlement_allocations').get().n,4);
  assert.equal(f.router(update).event,'DUPLICATE_REQUEST');
  assert.equal(f.db.prepare('SELECT count(*) n FROM settlement_allocations').get().n,4);
});
test('two streams can close different invoices involving a third person', async t => {
  const f=fixture(t);
  await f.send('#DONGI invoice "one"\nAB123 -100\nEF789 +100');
  await f.send('#DONGI invoice "two"\nEF789 -100\nCD456 +100');
  assert.equal((await f.send('#DONGI settle 100\nto: CD456')).result.event,'SETTLEMENT_CREATED');
  const open=f.db.prepare("SELECT e.open_amount FROM invoice_entries e WHERE user_id='12' ORDER BY rowid").all();
  assert.deepEqual(open.map(row=>row.open_amount),[0,0]);
  assert.equal(f.db.prepare('SELECT count(*) n FROM netting_allocations').get().n,1);
});
test('over-settlement and insufficient against never spill or write partial data', async t => {
  const f=fixture(t);
  await f.send('#DONGI invoice "one"\nAB123 -100\nCD456 +100');
  await f.send('#DONGI invoice "two"\nAB123 -100\nCD456 +100');
  assert.equal((await f.send('#DONGI settle 250\nto: CD456')).result.event,'SETTLEMENT_EXCEEDS_OPEN_BALANCE');
  assert.equal((await f.send('#DONGI settle 150\nto: CD456\nagainst: #1')).result.event,'SETTLEMENT_TARGET_INVALID');
  assert.equal(f.db.prepare('SELECT count(*) n FROM invoices').get().n,2);
  assert.equal(f.db.prepare('SELECT count(*) n FROM settlement_allocations').get().n,0);
  assert.equal((await f.send('#DONGI settle 100\nto: CD456\nagainst: #1')).result.event,'SETTLEMENT_CREATED');
});
test('allocation persistence failure rolls back settlement and original open amounts', async t => {
  const f=fixture(t);
  await f.send('#DONGI invoice "one"\nAB123 -100\nCD456 +100');
  f.db.exec("CREATE TRIGGER fail_alloc BEFORE INSERT ON settlement_allocations BEGIN SELECT RAISE(ABORT,'failure'); END");
  assert.equal((await f.send('#DONGI settle 50\nto: CD456')).result.event,'DB_TRANSACTION_FAILED');
  assert.equal(f.db.prepare('SELECT count(*) n FROM invoices').get().n,1);
  assert.deepEqual(f.db.prepare('SELECT open_amount FROM invoice_entries ORDER BY position').all().map(row=>row.open_amount),[-100,100]);
});
test('partial state does not require a zero entry', () => {
  assert.equal(settlementState([{amount:100,open_amount:70},{amount:-100,open_amount:-70}]),'PARTIAL');
  assert.equal(settlementState([{amount:100,open_amount:100},{amount:0,open_amount:0}]),'OPEN');
  assert.equal(settlementState([{amount:0,open_amount:0}]),'CLOSED');
});
