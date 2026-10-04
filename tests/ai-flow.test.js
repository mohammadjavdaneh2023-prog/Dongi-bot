import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/infra/db/database.js';
import {createRouter} from '../src/bot/router.js';
import {pollOnce} from '../src/bot/poller.js';
import {seedResponses} from '../src/bot/responses.js';
import {createPayloadCipher} from '../src/infra/outbox.js';
import {createAiGateway} from '../src/infra/ai-gateway.js';

test('Telegram AI preview, own confirm and duplicate callback commit exactly one invoice',async t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());seedResponses(db);
 db.exec(`INSERT INTO users VALUES ('a','10','AA111','Ali','MEMBER','ACTIVE',1,1,1),('b','11','BB222','Hasan','MEMBER','ACTIVE',1,1,1)`);
 const cipher=createPayloadCipher('ab'.repeat(32));const bot={id:99,username:'bot'};
 const router=createRouter({db,cipher,bot,config:{},log:()=>{}});
 let calls=0;const ai={gateway:createAiGateway(),generate:async()=>{calls++;return {text:JSON.stringify({kind:'INVOICE',lines:['#DONGI invoice "dinner" 600','paid: me 600','between: me BB222']})};}};
 const sent=[];let updates=[];
 const telegram={call:async(method,args)=>{
  if(method==='getUpdates')return updates;
  if(method==='getChatMember')return {user:{id:args.user_id},status:'member'};
  if(method==='sendMessage'){sent.push(args);return {message_id:100+sent.length};}
  if(method==='answerCallbackQuery')return true;
  if(method==='deleteMessage')return true;
  assert.fail(method);
 }};
 const deps={db,telegram,router,cipher,log:()=>{},bot,ai};
 updates=[{update_id:1,message:{message_id:1,from:{id:10},chat:{id:-100,type:'group'},text:'هی دنگی شام ۶۰۰ تومان بین من و حسن'}}];
 await pollOnce(deps);
 assert.equal(db.prepare('SELECT count(*) n FROM invoices').get().n,0);
 assert.equal(sent[0].text,'صبر کن دارم فکر می‌کنم');
 assert.equal(sent[0].reply_parameters.message_id,1);
 const data=sent.find(s=>s.reply_markup).reply_markup.inline_keyboard[0][0].callback_data;
 const callback=(id,actor)=>({update_id:id,callback_query:{id:String(id),data,from:{id:actor},message:{message_id:102,from:{id:99},chat:{id:-100,type:'group'}}}});
 updates=[callback(2,11)];await pollOnce(deps);
 assert.equal(db.prepare('SELECT count(*) n FROM invoices').get().n,0);
 updates=[callback(3,10)];await pollOnce(deps);await pollOnce(deps);
 assert.equal(db.prepare('SELECT count(*) n FROM invoices').get().n,1);
 assert.equal(db.prepare('SELECT input_mode FROM invoices').get().input_mode,'AI_CONFIRMED');
 assert.equal(db.prepare('SELECT status FROM ai_pending').get().status,'CONFIRMED');
 assert.equal(calls,1);
 assert.ok(db.prepare('SELECT 1 FROM receipt_messages').get());
});
