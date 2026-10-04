import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/infra/db/database.js';
import { createRouter } from '../src/bot/router.js';
import { seedResponses } from '../src/bot/responses.js';
import { createPayloadCipher } from '../src/infra/outbox.js';
import { prepareInvoice } from '../src/infra/prepare-invoice.js';

function setup(t){
 const db=openDatabase(':memory:');t.after(()=>db.close());seedResponses(db);
 db.exec(`INSERT INTO users VALUES ('10','10','AB123','Owner','OWNER','ACTIVE',1,1,1),('11','11','CD456','Member','MEMBER','ACTIVE',1,1,1);
 INSERT INTO group_roles VALUES ('-100','11','ADMIN')`);
 const router=createRouter({db,cipher:createPayloadCipher('ab'.repeat(32)),bot:{id:99,username:'testbot'},config:{},log:()=>{}});
 const telegram={call:async(_,args)=>({user:{id:args.user_id},status:args.user_id===11&&args.chat_id==='-100'?'administrator':'member'})};let seq=0;
 const send=async(text,from=10,chat=-100)=>{const update={update_id:++seq,message:{message_id:seq,from:{id:from},chat:{id:chat,type:chat>0?'private':'group'},text}};
 return {result:router(update,await prepareInvoice(db,telegram,update)),update};};
 return {db,router,send};
}
test('void and restore preserve entries, audit history and prevent replay',async t=>{
 const f=setup(t);await f.send('#DONGI invoice "x"\nAB123 +100\nCD456 -100');
 const before=f.db.prepare('SELECT * FROM invoice_entries ORDER BY position').all();
 const changed=await f.send('#DONGI void #1',11);
 assert.equal(changed.result.event,'INVOICE_VOIDED');
 assert.equal(f.router(changed.update).event,'DUPLICATE_REQUEST');
 assert.equal(f.db.prepare('SELECT lifecycle_status FROM invoices').get().lifecycle_status,'VOID');
 assert.deepEqual(f.db.prepare('SELECT * FROM invoice_entries ORDER BY position').all(),before);
 assert.equal((await f.send('#DONGI void #1',11)).result.event,'INVOICE_ALREADY_VOID');
 assert.equal((await f.send('#DONGI restore #1',11)).result.event,'INVOICE_RESTORED');
 assert.equal((await f.send('#DONGI restore #1',11)).result.event,'INVOICE_NOT_VOID');
 assert.equal(f.db.prepare("SELECT count(*) n FROM audit_events WHERE event IN ('INVOICE_VOIDED','INVOICE_RESTORED')").get().n,2);
});
test('admin cannot change another group invoice or act privately; owner may act privately',async t=>{
 const f=setup(t);await f.send('#DONGI invoice "x"\nAB123 +100\nCD456 -100');
 assert.equal((await f.send('#DONGI void #1',11,-200)).result.event,'PERMISSION_DENIED');
 assert.equal((await f.send('#DONGI void #1',11,11)).result.event,'PERMISSION_DENIED');
 assert.equal((await f.send('#DONGI void #1',10,10)).result.event,'INVOICE_VOIDED');
});
test('settlement and netting dependencies block void',async t=>{
 for(const kind of ['settlement','netting']){
  const f=setup(t);await f.send('#DONGI invoice "x"\nAB123 -100\nCD456 +100');
  await f.send(kind==='settlement'?'#DONGI settle 50\nto: CD456':'#DONGI invoice "opposite"\nAB123 +50\nCD456 -50');
  assert.equal((await f.send('#DONGI void #1')).result.event,'INVOICE_HAS_DEPENDENCIES');
  assert.equal((await f.send('#DONGI void #2')).result.event,'INVOICE_HAS_DEPENDENCIES');
 }
});
test('audit failure rolls back status change',async t=>{
 const f=setup(t);await f.send('#DONGI invoice "x"\nAB123 +100\nCD456 -100');
 f.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events WHEN NEW.event='INVOICE_VOIDED' BEGIN SELECT RAISE(ABORT,'failure'); END");
 assert.equal((await f.send('#DONGI void #1')).result.event,'DB_TRANSACTION_FAILED');
 assert.equal(f.db.prepare('SELECT lifecycle_status FROM invoices').get().lifecycle_status,'ACTIVE');
});
test('restore rechecks opposite balances and nets atomically',async t=>{
 const f=setup(t);await f.send('#DONGI invoice "x"\nAB123 +100\nCD456 -100');
 await f.send('#DONGI void #1');
 await f.send('#DONGI invoice "y"\nAB123 -40\nCD456 +40');
 assert.equal((await f.send('#DONGI restore #1')).result.event,'INVOICE_RESTORED');
 assert.equal(f.db.prepare('SELECT count(*) n FROM netting_allocations').get().n,2);
 assert.deepEqual(f.db.prepare(`SELECT e.open_amount FROM invoice_entries e JOIN invoices i ON i.id=e.invoice_id
   ORDER BY i.public_ref,e.position`).all().map(row=>row.open_amount),[60,-60,0,0]);
});
