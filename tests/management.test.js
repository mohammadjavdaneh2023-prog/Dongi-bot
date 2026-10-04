import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/infra/db/database.js';
import {createRouter} from '../src/bot/router.js';
import {seedResponses} from '../src/bot/responses.js';
import {createPayloadCipher} from '../src/infra/outbox.js';
import {prepareManagement} from '../src/infra/prepare-management.js';
function setup(t){
 const db=openDatabase(':memory:');t.after(()=>db.close());seedResponses(db);
 db.exec(`INSERT INTO users VALUES ('10','10','AB123','Owner','OWNER','ACTIVE',1,1,1),('11','11','CD456','Admin','MEMBER','ACTIVE',1,1,1),('12','12','EF789','Member','MEMBER','ACTIVE',1,1,1);
 INSERT INTO group_roles VALUES ('-100','11','ADMIN')`);
 const router=createRouter({db,cipher:createPayloadCipher('ab'.repeat(32)),bot:{id:99,username:'bot'},config:{},log:()=>{}});
 const telegram={call:async(_,args)=>({user:{id:args.user_id},status:args.user_id===11&&args.chat_id==='-100'?'administrator':'member'})};let seq=0;
 const send=async(text,from=10,chat=-100)=>{const update={update_id:++seq,message:{message_id:seq,from:{id:from},chat:{id:chat,type:chat>0?'private':'group'},text}};return {result:router(update,await prepareManagement(db,telegram,update)),update};};
 return {db,router,send,telegram};
}
test('admin freeze is local, cannot suspend and cannot act in another group',async t=>{
 const f=setup(t);
 assert.equal((await f.send('#DONGI freeze EF789',11)).result.event,'USER_FROZEN');
 assert.equal(f.db.prepare("SELECT status FROM users WHERE id='12'").get().status,'ACTIVE');
 assert.equal(f.db.prepare('SELECT count(*) n FROM group_restrictions WHERE frozen=1').get().n,1);
 assert.equal((await f.send('#DONGI freeze EF789',11,-200)).result.event,'PERMISSION_DENIED');
 assert.equal((await f.send('#DONGI user suspend EF789',11)).result.event,'PERMISSION_DENIED');
 assert.equal((await f.send('#DONGI unfreeze EF789',11)).result.event,'USER_UNFROZEN');
});
test('owner transitions are global, preserve local freeze and protect owner',async t=>{
 const f=setup(t);await f.send('#DONGI freeze EF789',11);
 assert.equal((await f.send('#DONGI freeze EF789',10,10)).result.event,'USER_FROZEN');
 assert.equal((await f.send('#DONGI user suspend EF789',10,10)).result.event,'USER_SUSPENDED');
 assert.equal((await f.send('#DONGI unfreeze EF789',10,10)).result.event,'USER_STATE_INVALID');
 assert.equal((await f.send('#DONGI user activate EF789',10,10)).result.event,'USER_ACTIVATED');
 assert.equal(f.db.prepare('SELECT frozen FROM group_restrictions').get().frozen,1);
 assert.equal((await f.send('#DONGI freeze AB123',10,10)).result.event,'OWNER_PROTECTED');
});
test('mutation audit failure rolls back and duplicate update does not repeat',async t=>{
 const f=setup(t);
 const first=await f.send('#DONGI freeze EF789',11);
 assert.equal(f.router(first.update).event,'DUPLICATE_REQUEST');
 assert.equal(f.db.prepare('SELECT count(*) n FROM audit_events').get().n,1);
 f.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'failure'); END");
 assert.equal((await f.send('#DONGI unfreeze EF789',11)).result.event,'DB_TRANSACTION_FAILED');
 assert.equal(f.db.prepare('SELECT frozen FROM group_restrictions').get().frozen,1);
});
test('Telegram promotion grants access and demotion revokes cached access',async t=>{
 const f=setup(t);f.db.exec('DELETE FROM group_roles');
 assert.equal((await f.send('#DONGI freeze EF789',11)).result.event,'USER_FROZEN');
 f.telegram.call=async(_,args)=>({user:{id:args.user_id},status:'member'});
 assert.equal((await f.send('#DONGI unfreeze EF789',11)).result.event,'PERMISSION_DENIED');
 assert.equal(f.db.prepare('SELECT count(*) n FROM group_roles').get().n,0);
});
