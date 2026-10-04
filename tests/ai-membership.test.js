import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/infra/db/database.js';
import {prepareAi} from '../src/infra/prepare-ai.js';
import {createAiGateway} from '../src/infra/ai-gateway.js';

test('AI checks selected identities before preview, avoids unrelated membership calls and refuses absent participant',async t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());
 for(const [id,pid,name] of [[10,'AA111','Ali'],[11,'BB222','Hasan'],[12,'CC333','Unrelated']])db.prepare("INSERT INTO users VALUES (?,?,?,?,'MEMBER','ACTIVE',1,1,1)").run(String(id),String(id),pid,name);
 const update={update_id:1,message:{message_id:1,from:{id:10},chat:{id:-100,type:'group'},text:'هی دنگی شام بین من و حسن ۸۰۰ #EXACT'}};
 const calls=[];let absent=false;
 const telegram={call:async(_,p)=>{calls.push(p.user_id);return {user:{id:p.user_id},status:absent&&p.user_id===11?'left':'member'};}};
 const ai={gateway:createAiGateway(),generate:async()=>({text:JSON.stringify({kind:'INVOICE',lines:['#DONGI invoice "شام" 800','between: me BB222']})})};
 assert.equal((await prepareAi(db,telegram,update,ai)).proposal.kind,'INVOICE');
 assert.deepEqual(calls,[10,10,11]);
 absent=true;assert.equal((await prepareAi(db,telegram,update,ai)).error,'USER_NOT_IN_GROUP');
 assert.equal(db.prepare('SELECT count(*) n FROM ai_pending').get().n,0);
 update.message.text='هی دنگی بانک بساز';
 assert.equal((await prepareAi(db,telegram,update,{generate:()=>assert.fail('bank must not reach AI')})).proposal.kind,'ADMIN_REJECTED');
});
