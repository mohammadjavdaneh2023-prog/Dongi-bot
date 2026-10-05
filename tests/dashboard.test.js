import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/infra/db/database.js';
import {createRouter} from '../src/bot/router.js';
import {seedResponses} from '../src/bot/responses.js';
import {createPayloadCipher} from '../src/infra/outbox.js';
import {prepareInvoice} from '../src/infra/prepare-invoice.js';
function setup(t){
 const db=openDatabase(':memory:');t.after(()=>db.close());seedResponses(db);
 db.exec(`INSERT INTO users VALUES ('10','10','AB123','Ali','MEMBER','ACTIVE',1,1,1),('11','11','CD456','Hasan','MEMBER','ACTIVE',1,1,1),('12','12','EF789','Zero','MEMBER','ACTIVE',1,1,1)`);
 const cipher=createPayloadCipher('ab'.repeat(32));
 const router=createRouter({db,cipher,bot:{id:99,username:'bot'},config:{},log:()=>{}});
 const telegram={call:async(_,args)=>({user:{id:args.user_id},status:'member'})};let seq=0;
 const send=async(text,id=10,group=false)=>{
 const update={update_id:++seq,message:{message_id:seq,from:{id},chat:{id:group?-100:id,type:group?'group':'private'},text}};
 const result=router(update,await prepareInvoice(db,telegram,update));
 const row=db.prepare('SELECT encrypted_payload FROM response_outbox WHERE update_id=? ORDER BY id DESC LIMIT 1').get(update.update_id);
 return {result,payload:row?cipher.decrypt(row.encrypted_payload):null};};
 return {db,send};
}
test('private dashboard isolates balances and preserves zero participant history',async t=>{
 const f=setup(t);await f.send('#DONGI invoice "dinner"\nAB123 +100\nCD456 -100\nEF789 0',10,true);
 assert.match((await f.send('حساب من',11)).payload.text,/-100/);
 assert.match((await f.send('ریزحساب باز',11)).payload.text,/باز: -100/);
 assert.doesNotMatch((await f.send('ریزحساب باز',12)).payload.text,/#1/);
 assert.match((await f.send('تاریخچه',12)).payload.text,/INVOICE_CREATED/);
 assert.match((await f.send('فاکتورهای من',10)).payload.text,/#1/);
 assert.doesNotMatch((await f.send('فاکتورهای من',11)).payload.text,/#1/);
});
test('dashboard pagination is bounded and financial records are unchanged',async t=>{
 const f=setup(t);
 for(let i=0;i<9;i++)await f.send(`#DONGI invoice "item${i}"\nAB123 +10\nCD456 -10`,10,true);
 const count=f.db.prepare('SELECT count(*) n FROM audit_events').get().n;
 const first=await f.send('/my open');const second=await f.send('/my open 2');
 assert.equal((first.payload.text.match(/باز:/g)??[]).length,8);
 assert.equal((second.payload.text.match(/باز:/g)??[]).length,1);
 assert.ok(first.payload.reply_markup.keyboard.flat().includes('/my open 2'));
 assert.equal(f.db.prepare('SELECT count(*) n FROM audit_events').get().n,count);
});
test('start supplies keyboard, unlinked users get a response and group buttons are ignored',async t=>{
 const f=setup(t);
 assert.ok((await f.send('/start')).payload.reply_markup.keyboard.flat().includes('حساب من'));
 assert.equal((await f.send('/my balance',88)).result.event,'ONBOARDING_REQUIRED');
 assert.equal((await f.send('/my balance AB123')).result.event,'PARSE_FAILED');
 assert.equal((await f.send('حساب من',10,true)).result.dropped,true);
});
test('reply menu can be dismissed and reopened with /menu',async t=>{
 const f=setup(t);
 const opened=await f.send('/menu');
 assert.equal(opened.payload.reply_markup.is_persistent,false);
 assert.ok(opened.payload.reply_markup.keyboard.flat().includes('بستن منو'));
 const closed=await f.send('بستن منو');
 assert.deepEqual(closed.payload.reply_markup,{remove_keyboard:true});
 assert.match(closed.payload.text,/\/menu/);
 const reopened=await f.send('/menu');
 assert.ok(reopened.payload.reply_markup.keyboard.flat().includes('حساب من'));
});
test('read-only dashboard remains available for frozen and suspended users',async t=>{
 const f=setup(t);
 for(const status of ['FROZEN','SUSPENDED']){
 f.db.prepare("UPDATE users SET status=? WHERE id='10'").run(status);
 const result=await f.send('پروفایل من');
 assert.equal(result.result.event,'PRIVATE_VIEW_READY');assert.match(result.payload.text,new RegExp(status));
 }
});
