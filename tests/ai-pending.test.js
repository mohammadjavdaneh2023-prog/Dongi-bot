import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,transaction} from '../src/infra/db/database.js';
import {createPending,resolvePending} from '../src/repositories/ai-pending.js';

function fixture(t){
 const db=openDatabase(':memory:');t.after(()=>db.close());
 db.exec(`INSERT INTO users VALUES ('a','10','AA111','Ali','MEMBER','ACTIVE',1,1,1),('b','11','BB222','Hasan','MEMBER','ACTIVE',1,1,1)`);
 const message={message_id:1,from:{id:10},chat:{id:-100,type:'group'}};
 const verified={chatId:'-100',actorTelegramId:'10',verifiedAt:1000,currentMemberIds:new Set(['a','b'])};
 const args={message,verified,traceId:'DNG-test',now:1000};
 const create=(proposal={kind:'INVOICE',command:'#DONGI invoice "dinner" 600\npaid: me 600\nbetween: me BB222'})=>transaction(db,()=>createPending(db,{...args,proposal}));
 const resolve=(token,extra={})=>transaction(db,()=>resolvePending(db,{...args,token,action:'confirm',...extra}));
 return {db,args,create,resolve};
}
test('preview writes no invoice; confirmation is single-use and marked AI_CONFIRMED',t=>{
 const f=fixture(t);const pending=f.create();
 assert.equal(f.db.prepare('SELECT count(*) n FROM invoices').get().n,0);
 const saved=f.resolve(pending.token);
 assert.equal(saved.invoice.entries[0].amount,300);
 assert.equal(f.db.prepare('SELECT input_mode FROM invoices').get().input_mode,'AI_CONFIRMED');
 assert.throws(()=>f.resolve(pending.token),{code:'AI_CONFIRMATION_USED'});
 assert.equal(f.db.prepare('SELECT count(*) n FROM invoices').get().n,1);
});
test('another actor/chat, expired token, and stale membership cannot confirm',t=>{
 const f=fixture(t);const p=f.create();
 for(const message of [{...f.args.message,from:{id:11}},{...f.args.message,chat:{id:-200,type:'group'}}])
  assert.throws(()=>f.resolve(p.token,{message}),{code:'AI_CONFIRMATION_INVALID'});
 assert.throws(()=>f.resolve(p.token,{now:p.expiresAt}),{code:'AI_CONFIRMATION_EXPIRED'});
 assert.throws(()=>f.resolve(p.token,{now:62000}),{code:'MEMBERSHIP_CHECK_FAILED'});
 assert.equal(f.db.prepare('SELECT count(*) n FROM invoices').get().n,0);
});
test('cancel consumes proposal without financial effects',t=>{
 const f=fixture(t);const p=f.create();f.resolve(p.token,{action:'cancel'});
 assert.throws(()=>f.resolve(p.token),{code:'AI_CONFIRMATION_USED'});
 assert.equal(f.db.prepare('SELECT count(*) n FROM invoice_entries').get().n,0);
});
test('freshly frozen actor and changed membership or all-participants block confirmation',t=>{
 const f=fixture(t);const p=f.create();
 f.db.exec("UPDATE users SET status='FROZEN' WHERE id='a'");
 assert.throws(()=>f.resolve(p.token),{code:'ACTOR_FROZEN'});
 f.db.exec("UPDATE users SET status='ACTIVE' WHERE id='a'");
 assert.throws(()=>f.resolve(p.token,{verified:{...f.args.verified,currentMemberIds:new Set(['a'])}}),{code:'USER_NOT_IN_GROUP'});
 f.db.exec("UPDATE users SET canonical_name='Changed' WHERE id='b'");
 assert.throws(()=>f.resolve(p.token),{code:'AI_PREVIEW_CHANGED'});
});
test('audit failure rolls back invoice, entries and consumption together',t=>{
 const f=fixture(t);const p=f.create();
 f.db.exec("CREATE TRIGGER fail_confirm BEFORE INSERT ON audit_events WHEN NEW.event='AI_PREVIEW_CONFIRMED' BEGIN SELECT RAISE(ABORT,'test'); END");
 assert.throws(()=>f.resolve(p.token),{code:'DB_TRANSACTION_FAILED'});
 assert.equal(f.db.prepare('SELECT count(*) n FROM invoices').get().n,0);
 assert.equal(f.db.prepare('SELECT status FROM ai_pending').get().status,'PENDING');
 f.db.exec('DROP TRIGGER fail_confirm');f.resolve(p.token);
});
test('settlement cannot even preview without open balance',t=>{
 const f=fixture(t);
 assert.throws(()=>f.create({kind:'SETTLEMENT',command:'#DONGI settle 100\nfrom: me\nto: BB222'}),{code:'NO_OPEN_BALANCE'});
 assert.equal(f.db.prepare('SELECT count(*) n FROM ai_pending').get().n,0);
});
