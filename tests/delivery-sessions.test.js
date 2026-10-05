import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import {openDatabase} from '../src/infra/db/database.js';
import {createRouter} from '../src/bot/router.js';
import {pollOnce,beginSession,runPolling} from '../src/bot/poller.js';
import {seedResponses} from '../src/bot/responses.js';
import {createPayloadCipher} from '../src/infra/outbox.js';
import {createTelegramClient} from '../src/infra/telegram.js';
import {prepareBank} from '../src/infra/prepare-bank.js';

function fixture(t){
 const db=openDatabase(':memory:');t.after(()=>db.close());seedResponses(db);
 db.exec("INSERT INTO users VALUES ('a','10','AA111','Ali','OWNER','ACTIVE',1,1,1)");
 const cipher=createPayloadCipher('ab'.repeat(32));const bot={id:99,username:'bot'};const log=()=>{};
 const router=createRouter({db,cipher,bot,config:{},log});
 const message=(id,text,date)=>({update_id:id,message:{date,message_id:id,from:{id:10},chat:{id:-100,type:'group'},text}});
 return {db,cipher,bot,log,router,message};
}
test('session initialization preserves pending delivery and financial history',async t=>{
 const f=fixture(t);f.router(f.message(1,'#DONGI help'));
 const bank=f.message(2,'#DONGI bank create "old bank" 1000\nmembers: AA111*1\nmanager: AA111');
 f.router(bank,await prepareBank(f.db,{call:async(_,p)=>({user:{id:p.user_id},status:'member'})},bank));
 const calls=[];f.telegram={call:async(m,p)=>{calls.push([m,p]);return true;}};
 await beginSession(f);
 assert.deepEqual(calls[0],['deleteWebhook',{drop_pending_updates:false}]);
 assert.equal(f.db.prepare('SELECT count(*) n FROM processed_updates').get().n,2);
 assert.equal(f.db.prepare('SELECT balance FROM banks').get().balance,1000);
 assert.equal(f.db.prepare('SELECT count(*) n FROM bank_receipts').get().n,1);
 assert.equal(f.db.prepare("SELECT delivery_status FROM response_outbox ORDER BY id LIMIT 1").get().delivery_status,'PENDING');
 assert.equal(f.db.prepare('SELECT count(*) n FROM users').get().n,1);
});

test('caller cancellation is not mistaken for lost Telegram connectivity',async()=>{
 const controller=new AbortController();controller.abort();
 const client=createTelegramClient('123:fake-token',async()=>{throw new Error('aborted');});
 await assert.rejects(client.call('getChatMember',{},controller.signal),{code:'REQUEST_TIMEOUT'});
});
test('timeout produces a reply and removes temporary message while delayed updates are processed',async t=>{
 const f=fixture(t);const sent=[];const deleted=[];
 f.requestTimeoutMs=10;
 f.telegram={call:async(m,p)=>{
  if(m==='getUpdates')return [f.message(1,'#DONGI help',99),f.message(2,'ordinary',101),f.message(3,'#DONGI balance',101)];
  if(m==='getChatMember')return new Promise(()=>{});
  if(m==='sendMessage'){sent.push(p);return {message_id:1000+sent.length};}
  if(m==='deleteMessage'){deleted.push(p);return true;}
 }};
 await pollOnce(f);
 assert.equal(sent.length,3);assert.match(sent[0].text,/دستورهای دنگی/);
 assert.equal(sent[1].text,'صبر کن دارم فکر می‌کنم');
 assert.ok(sent.slice(1).every(p=>p.reply_parameters.message_id===3));
 assert.match(sent[2].text,/مهلت/);assert.equal(deleted.length,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM invoices').get().n,0);
});
test('network recovery resumes the existing receive session without dropping pending updates',async t=>{
 const f=fixture(t);const calls=[];let polls=0;let resets=0;
 f.telegram={call:async(m)=>{calls.push(m);if(m==='deleteWebhook'){resets++;return true;}if(m==='getUpdates'){polls++;if(polls===1)throw {code:'NETWORK'};return [];}}};
 await runPolling(f,()=>polls>=2,async()=>{});
 assert.equal(resets,1);assert.deepEqual(calls.filter(m=>['getUpdates','deleteWebhook'].includes(m)),['deleteWebhook','getUpdates','getUpdates']);
});
test('shutdown cancels the polling retry timer and removes its abort listener',async t=>{
 const f=fixture(t);const shutdown=new AbortController();
 f.telegram={call:async method=>{
  if(method==='deleteWebhook')return true;
  if(method==='getUpdates'){setImmediate(()=>shutdown.abort());throw {code:'NETWORK'};}
 }};
 const started=Date.now();
 await runPolling({...f,shutdownSignal:shutdown.signal},()=>shutdown.signal.aborted);
 assert.ok(Date.now()-started<500,'shutdown must not wait for the backoff timer');
 assert.equal(getEventListeners(shutdown.signal,'abort').length,0);
});
