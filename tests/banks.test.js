import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/infra/db/database.js';
import {createRouter} from '../src/bot/router.js';
import {seedResponses} from '../src/bot/responses.js';
import {createPayloadCipher} from '../src/infra/outbox.js';
import {prepareBank} from '../src/infra/prepare-bank.js';
import {dashboard} from '../src/bot/private-dashboard.js';
const create='#DONGI bank create "سفر" 800000\nmembers: AA111*1 BB222*1 CC333*2 DD444*4\nmanager: BB222';
function fixture(t){
 const db=openDatabase(':memory:');t.after(()=>db.close());seedResponses(db);
 for(const [id,pid] of [[10,'AA111'],[11,'BB222'],[12,'CC333'],[13,'DD444'],[14,'EE555']])db.prepare('INSERT INTO users VALUES (?,?,?,?,?,\'ACTIVE\',1,1,1)').run(String(id),String(id),pid,pid,id===10?'OWNER':'MEMBER');
 const cipher=createPayloadCipher('ab'.repeat(32));const router=createRouter({db,cipher,bot:{id:99,username:'bot'},config:{},log:()=>{}});
 let seq=0;const absent=new Set();const admins=new Set([14]);
 const telegram={call:async(_,p)=>({user:{id:p.user_id},status:absent.has(p.user_id)?'left':admins.has(p.user_id)?'administrator':'member'})};
 const send=async(text,from=10,chat=-100)=>{
  const update={update_id:++seq,message:{message_id:seq,from:{id:from},chat:{id:chat,type:chat>0?'private':'group'},text}};
  const result=router(update,await prepareBank(db,telegram,update));return {...result,update};
 };
 return {db,cipher,router,send,absent,admins};
}
test('weighted bank receipts conserve funds; manager can charge/refund/spend across groups',async t=>{
 const f=fixture(t);assert.equal((await f.send(create)).event,'BANK_CHANGED');
 assert.deepEqual(f.db.prepare('SELECT amount FROM bank_receipts ORDER BY user_id').all().map(r=>r.amount),[100000,100000,200000,400000]);
 assert.equal((await f.send('#DONGI bank charge B1 80000 "شارژ مجدد"',11,-200)).event,'BANK_CHANGED');
 assert.equal((await f.send('#DONGI bank refund B1 80000 "برگشت"',11,-200)).event,'BANK_CHANGED');
 assert.equal((await f.send('#DONGI bank spend B1 200000 "خرید غذا"',11,-200)).event,'BANK_CHANGED');
 assert.equal(f.db.prepare('SELECT balance FROM banks').get().balance,600000);
 for(const tx of f.db.prepare('SELECT id,amount FROM bank_transactions').all())assert.equal(f.db.prepare('SELECT sum(amount) s FROM bank_receipts WHERE transaction_id=?').get(tx.id).s,tx.amount);
 assert.equal(f.db.prepare('SELECT count(*) n FROM invoices').get().n,0);
 assert.equal((await f.send('#DONGI bank report B1',12)).event,'BANK_REPORT');
 const personal=dashboard(f.db,f.db.prepare("SELECT * FROM users WHERE id='12'").get(),{view:'banks',page:1});
 assert.match(personal.text,/220000/);assert.match(personal.text,/50000/);
});
test('only owner/admin creates; ordinary members cannot mutate, demoted admins lose access',async t=>{
 const f=fixture(t);
 assert.equal((await f.send(create,11)).event,'PERMISSION_DENIED');
 assert.equal((await f.send(create,14)).event,'BANK_CHANGED');
 assert.equal((await f.send('#DONGI bank spend B1 1 "x"',12)).event,'PERMISSION_DENIED');
 assert.equal((await f.send('#DONGI bank spend B1 1 "x"',14)).event,'BANK_CHANGED');
 f.admins.clear();
 assert.equal((await f.send('#DONGI bank spend B1 1 "x"',14)).event,'PERMISSION_DENIED');
 assert.equal((await f.send('#DONGI bank spend B1 1 "x"',11,11)).event,'BANK_GROUP_ONLY');
});
test('missing member blocks every change even for owner and alternate group; duplicate ratios blocked globally',async t=>{
 const f=fixture(t);await f.send(create);
 assert.equal((await f.send(create.replace('سفر','جدید').replace('AA111*1 BB222*1 CC333*2 DD444*4','DD444*8 CC333*4 BB222*2 AA111*2'),10,-200)).event,'BANK_DUPLICATE');
 f.absent.add(13);
 for(const actor of [10,11,14])for(const operation of ['charge','refund','spend'])assert.equal((await f.send(`#DONGI bank ${operation} B1 10 "x"`,actor,-200)).event,'BANK_MEMBER_ABSENT');
 assert.equal(f.db.prepare('SELECT balance FROM banks').get().balance,800000);
 assert.equal(f.db.prepare('SELECT count(*) n FROM bank_transactions').get().n,1);
 f.absent.clear();assert.equal((await f.send('#DONGI bank spend B1 1 "x"',11,-200)).event,'BANK_CHANGED');
});
test('overspend, invalid manager, duplicate deliveries and audit failure cannot partially change bank',async t=>{
 const f=fixture(t);assert.equal((await f.send(create.replace('manager: BB222','manager: EE555'))).event,'BANK_MANAGER_REQUIRED');
 const result=await f.send(create);assert.equal(f.router(result.update).event,'DUPLICATE_REQUEST');
 assert.equal((await f.send('#DONGI bank spend B1 800001 "x"',11)).event,'BANK_INSUFFICIENT');
 f.db.exec("CREATE TRIGGER fail_bank_audit BEFORE INSERT ON audit_events WHEN NEW.event LIKE 'BANK_%' BEGIN SELECT RAISE(ABORT,'failure'); END");
 assert.equal((await f.send('#DONGI bank refund B1 100 "x"',11)).event,'DB_TRANSACTION_FAILED');
 assert.equal(f.db.prepare('SELECT balance FROM banks').get().balance,800000);
 assert.equal(f.db.prepare('SELECT count(*) n FROM bank_transactions').get().n,1);
 assert.throws(()=>f.db.exec('UPDATE bank_members SET weight=2'));
 assert.throws(()=>f.db.exec('DELETE FROM bank_transactions'));
});
