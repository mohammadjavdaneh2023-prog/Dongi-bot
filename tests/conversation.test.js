import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/infra/db/database.js';
import {prepareConversation,conversationReply} from '../src/infra/prepare-conversation.js';
import {createAiGateway} from '../src/infra/ai-gateway.js';
function setup(t){const db=openDatabase(':memory:');t.after(()=>db.close());db.exec("INSERT INTO users VALUES ('a','10','AA111','Ali','MEMBER','ACTIVE',1,1,1)");
 const update={update_id:1,message:{message_id:1,from:{id:10},chat:{id:-100,type:'group'},text:'سلام',reply_to_message:{from:{id:99},text:'سلام رفیق'}}};
 return {db,update,telegram:{call:async()=>({user:{id:10},status:'member'})},bot:{id:99}};}
test('free reply uses 10 percent gate and deterministic commands never enter conversation',async t=>{
 const f=setup(t);let calls=0;const ai={gateway:createAiGateway(),generate:async()=>{calls++;return {text:'{"text":"سلام رفیق!"}'};}};
 assert.equal((await prepareConversation(f.db,f.telegram,f.update,ai,f.bot,()=>0.1)).conversationEvent,'INTERACTION_DISMISS');
 assert.equal(calls,0);
 assert.equal((await prepareConversation(f.db,f.telegram,f.update,ai,f.bot,()=>0.09)).conversationText,'سلام رفیق!');
 f.update.message.text='#DONGI balance';assert.equal(await prepareConversation(f.db,f.telegram,f.update,ai,f.bot,()=>0),undefined);
 assert.equal(calls,1);assert.equal(f.db.prepare('SELECT count(*) n FROM invoices').get().n,0);
});
test('conversation failures, malformed output, quota and nonmember always have a safe response',async t=>{
 const f=setup(t);
 for(const text of ['{"text":""}','{"text":"hi","command":"x"}','oops']){
  assert.equal((await conversationReply({gateway:createAiGateway(),generate:async()=>({text})},f.update.message)).conversationEvent,'INTERACTION_DISMISS');
 }
 assert.equal((await conversationReply({gateway:{run:async()=>{throw {code:'AI_GATEWAY_BUSY'};}}},f.update.message)).conversationEvent,'AI_GATEWAY_BUSY');
 assert.equal((await prepareConversation(f.db,{call:async()=>({user:{id:10},status:'left'})},f.update,{generate:()=>assert.fail()},f.bot,()=>0)).conversationEvent,'INTERACTION_DISMISS');
});
