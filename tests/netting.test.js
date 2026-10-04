import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase,transaction } from '../src/infra/db/database.js';
import { createRouter } from '../src/bot/router.js';
import { seedResponses } from '../src/bot/responses.js';
import { createPayloadCipher } from '../src/infra/outbox.js';
import { prepareInvoice } from '../src/infra/prepare-invoice.js';
import { applyNetting } from '../src/repositories/netting.js';
import { planNetting } from '../src/domain/netting.js';
import { newTraceId } from '../src/infra/logging.js';

function setup(t) {
  const db=openDatabase(':memory:');t.after(()=>db.close());seedResponses(db);
  for(const [id,pid] of [[10,'AB123'],[11,'CD456'],[12,'EF789']]) db.prepare("INSERT INTO users VALUES (?,?,?,?,'MEMBER','ACTIVE',1,1,1)").run(String(id),String(id),pid,pid);
  const cipher=createPayloadCipher('ab'.repeat(32));
  const router=createRouter({db,cipher,bot:{id:99,username:'testbot'},config:{},log:()=>{}});
  const telegram={call:async(_,args)=>({user:{id:args.user_id},status:'member'})};
  let seq=0;
  const send=async text=>{
    const update={update_id:++seq,message:{message_id:seq,chat:{id:-100,type:'group'},from:{id:10},text}};
    return {result:router(update,await prepareInvoice(db,telegram,update)),update};
  };
  return {db,cipher,router,send};
}
test('three-person cycle closes automatically with traceable allocations and unchanged original amounts',async t=>{
  const f=setup(t);
  await f.send('#DONGI invoice "a"\nAB123 -100\nCD456 +100');
  await f.send('#DONGI invoice "b"\nCD456 -100\nEF789 +100');
  const last=await f.send('#DONGI invoice "c"\nEF789 -100\nAB123 +100');
  assert.equal(last.result.event,'INVOICE_CREATED');
  assert.equal(f.db.prepare('SELECT count(*) n FROM invoice_entries WHERE open_amount != 0').get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM netting_allocations').get().n,3);
  assert.equal(f.db.prepare("SELECT count(*) n FROM audit_events WHERE event='NETTING_APPLIED'").get().n,3);
  assert.equal(f.db.prepare('SELECT sum(abs(amount)) n FROM invoice_entries').get().n,600);
  assert.equal(f.router(last.update).event,'DUPLICATE_REQUEST');
  const trigger=f.db.prepare('SELECT id FROM invoices ORDER BY public_ref DESC LIMIT 1').get().id;
  assert.equal(transaction(f.db,()=>applyNetting(f.db,trigger,'10',newTraceId())),0);
  assert.equal((await f.send('#DONGI details #1')).result.event,'DETAILS_READY');
  const text=f.cipher.decrypt(f.db.prepare('SELECT encrypted_payload FROM response_outbox ORDER BY id DESC LIMIT 1').get().encrypted_payload).text;
  assert.match(text,/CLOSED/);assert.match(text,/تهاتر/);
});
test('partial netting leaves only net open balance and retains initial zero row',async t=>{
  const f=setup(t);
  await f.send('#DONGI invoice "a"\nAB123 +100\nCD456 -100\nEF789 0');
  await f.send('#DONGI invoice "b"\nAB123 -70\nCD456 +70');
  assert.deepEqual(f.db.prepare(`SELECT e.open_amount FROM invoice_entries e JOIN invoices i ON i.id=e.invoice_id
    ORDER BY i.public_ref,e.position`).all().map(row=>row.open_amount),[30,-30,0,0,0]);
  assert.equal(f.db.prepare('SELECT count(*) n FROM invoices').get().n,2);
});
test('netting persistence or audit failure rolls back the new invoice and changes to existing rows',async t=>{
  for(const failure of ['allocation','audit']) {
    const f=setup(t);
    await f.send('#DONGI invoice "a"\nAB123 +100\nCD456 -100');
    f.db.exec(failure==='allocation'
      ? "CREATE TRIGGER fail_net BEFORE INSERT ON netting_allocations BEGIN SELECT RAISE(ABORT,'failure'); END"
      : "CREATE TRIGGER fail_net BEFORE INSERT ON audit_events WHEN NEW.event='NETTING_APPLIED' BEGIN SELECT RAISE(ABORT,'failure'); END");
    assert.equal((await f.send('#DONGI invoice "b"\nAB123 -70\nCD456 +70')).result.event,'DB_TRANSACTION_FAILED');
    assert.equal(f.db.prepare('SELECT count(*) n FROM invoices').get().n,1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM netting_allocations').get().n,0);
    assert.deepEqual(f.db.prepare(`SELECT e.open_amount FROM invoice_entries e JOIN invoices i ON i.id=e.invoice_id
      ORDER BY i.public_ref,e.position`).all().map(row=>row.open_amount),[100,-100]);
  }
});
test('netting order is deterministic newest-first and never mutates input',()=>{
  const rows=[{id:'old',user_id:'u',open_amount:100,created_at:1,public_ref:1,position:0},
    {id:'new',user_id:'u',open_amount:60,created_at:2,public_ref:2,position:0},
    {id:'debt',user_id:'u',open_amount:-80,created_at:3,public_ref:3,position:0}];
  const before=structuredClone(rows);
  const result=planNetting(rows);
  assert.deepEqual(result.map(row=>[row.positive_entry_id,row.amount]),[['new',60],['old',20]]);
  assert.deepEqual(rows,before);
});
