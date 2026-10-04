import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/infra/db/database.js';
import { createRouter } from '../src/bot/router.js';
import { seedResponses } from '../src/bot/responses.js';
import { createPayloadCipher,deliverOutbox } from '../src/infra/outbox.js';
import { prepareInvoice } from '../src/infra/prepare-invoice.js';

function fixture(t) {
  const db=openDatabase(':memory:');t.after(()=>db.close());seedResponses(db);
  for(const [id,pid] of [[10,'AB123'],[11,'CD456'],[12,'EF789']]) db.prepare("INSERT INTO users VALUES (?,?,?,?,'MEMBER','ACTIVE',1,1,1)").run(String(id),String(id),pid,pid);
  const cipher=createPayloadCipher('ab'.repeat(32)); const log=()=>{};
  const router=createRouter({db,cipher,bot:{id:99,username:'testbot'},config:{},log});
  let seq=0;
  const telegram={call:async(method,args)=>method==='getChatMember'?{user:{id:args.user_id},status:'member'}:{message_id:1000+(++seq)}};
  const send=async(text,extra={})=>{
    const update={update_id:++seq,message:{message_id:seq,chat:{id:-100,type:'group'},from:{id:10},text,...extra}};
    return router(update,await prepareInvoice(db,telegram,update));
  };
  return {db,cipher,telegram,send,log};
}

test('ordinary creator may void only own source-group invoice and read own details while suspended',async t=>{
 const f=fixture(t);
 await f.send('#DONGI invoice "created for others"\nCD456 +100\nEF789 -100');
 assert.equal((await f.send('#DONGI void #1',{from:{id:11}})).event,'PERMISSION_DENIED');
 assert.equal((await f.send('#DONGI void #1',{chat:{id:-200,type:'group'}})).event,'PERMISSION_DENIED');
 assert.equal((await f.send('#DONGI void #1')).event,'INVOICE_VOIDED');
 assert.equal((await f.send('#DONGI restore #1')).event,'PERMISSION_DENIED');
 f.db.exec("UPDATE users SET status='SUSPENDED' WHERE id='10'");
 assert.equal((await f.send('#DONGI details #1',{chat:{id:10,type:'private'}})).event,'DETAILS_READY');
});
test('details displays partial open amounts and auditable allocations without financial mutation',async t=>{
  const f=fixture(t);
  await f.send('#DONGI invoice "x"\nAB123 -100\nCD456 +100\nEF789 0');
  await f.send('#DONGI settle 40\nto: CD456');
  const before=f.db.prepare('SELECT count(*) n FROM audit_events').get().n;
  assert.equal((await f.send('#DONGI details #1')).event,'DETAILS_READY');
  const row=f.db.prepare('SELECT encrypted_payload FROM response_outbox ORDER BY id DESC LIMIT 1').get();
  const text=f.cipher.decrypt(row.encrypted_payload).text;
  assert.match(text,/PARTIAL/);assert.match(text,/باز: -60/);assert.match(text,/EF789.*اصل: 0 \| باز: 0/);
  assert.match(text,/تسویه #2 → فاکتور #1/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM audit_events').get().n,before);
});
test('receipt reply context is persisted on successful delivery and fake receipt text is ignored',async t=>{
  const f=fixture(t);
  await f.send('#DONGI invoice "x"\nAB123 -100\nCD456 +100');
  await deliverOutbox(f);
  const receipt=f.db.prepare('SELECT message_id FROM receipt_messages').get();
  assert.ok(receipt);
  assert.equal((await f.send('#DONGI details',{reply_to_message:{message_id:receipt.message_id,from:{id:99}}})).event,'DETAILS_READY');
  assert.equal((await f.send('#DONGI details',{reply_to_message:{message_id:987654,from:{id:99},text:'🧾 #1'}})).event,'INVOICE_NOT_FOUND');
});
test('private details require participation and group visibility includes zero participants',async t=>{
  const f=fixture(t);
  await f.send('#DONGI invoice "x"\nAB123 -100\nCD456 +100');
  assert.equal((await f.send('#DONGI details #1',{chat:{id:12,type:'private'},from:{id:12}})).event,'PERMISSION_DENIED');
  assert.equal((await f.send('#DONGI details #1',{chat:{id:11,type:'private'},from:{id:11}})).event,'DETAILS_READY');
  await f.send('#DONGI invoice "zero"\nAB123 -100\nCD456 +100\nEF789 0');
  f.telegram.call=async(_,args)=>({user:{id:args.user_id},status:args.user_id===12?'left':'member'});
  assert.equal((await f.send('#DONGI details #2')).event,'INVOICE_NOT_VISIBLE');
});
