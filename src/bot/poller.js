import { deliverOutbox } from '../infra/outbox.js';
import { renderResponse } from './responses.js';
import { newTraceId } from '../infra/logging.js';
import { syncMembership } from '../infra/membership.js';
import { prepareInvoice } from '../infra/prepare-invoice.js';
import { prepareManagement } from '../infra/prepare-management.js';
import { prepareAi } from '../infra/prepare-ai.js';
import { prepareConversation } from '../infra/prepare-conversation.js';
import { classifyTrigger } from './triggers.js';
import { privateRequest } from './private-dashboard.js';
import { withSignal } from '../infra/deadline.js';
import {prepareBank} from '../infra/prepare-bank.js';

export function acceptedMessage(message,bot){
 if(!message)return false;
 const text=message.text?.trim()??'';
 const start=text.match(/^\/start(?:@([A-Za-z0-9_]+))?(?:\s+\S+)?$/i);
 return classifyTrigger({kind:'message',chatType:message.chat?.type,text,
  directReplyToBot:message.reply_to_message?.from?.id===bot.id,
  inPrivateFlow:Boolean((start&&(!start[1]||start[1].toLowerCase()===bot.username.toLowerCase()))||/^#dongi(?![\p{L}\p{N}_])/iu.test(text)||privateRequest(text,bot.username))})!=='DROP';
}

export async function cleanupTemporary({db,telegram}){
 for(const row of db.prepare('SELECT * FROM temporary_messages').all()){
  try{await telegram.call('deleteMessage',row);}
  catch(error){if(error.code!==400) {if(disconnected(error))throw error;continue;}}
  db.prepare('DELETE FROM temporary_messages WHERE chat_id=? AND message_id=?').run(row.chat_id,row.message_id);
 }
}

// Switch to polling without discarding updates queued during an outage or handoff.
export async function beginSession(deps){
 await deps.telegram.call('deleteWebhook',{drop_pending_updates:false});
 await cleanupTemporary(deps);
}

export async function pollOnce(deps) {
 const {db,telegram,router,cipher,log,bot,ai}=deps;
 const deliver=()=>deliverOutbox({db,telegram,cipher,log});
 await deliver();await cleanupTemporary(deps);
 const offset=Number(db.prepare("SELECT value FROM runtime_state WHERE key='offset'").get()?.value??0);
 const updates=await telegram.call('getUpdates',{offset,timeout:25,allowed_updates:['message','callback_query','chat_member','my_chat_member']},deps.shutdownSignal);
 for(const update of updates){
  if(!Number.isSafeInteger(update.update_id))continue;
  const callback=update.callback_query;
  if(syncMembership(db,update)){
   log('MEMBERSHIP_SYNCED',newTraceId(),{telegram_update_id:update.update_id,stage:'MEMBERSHIP',result:'SUCCESS'});
  }else{
   let routed=update;
   if(callback){
    const action=callback.message?.from?.id===bot.id&&callback.data?.match(/^dai:(confirm|cancel):([a-f0-9]{36})$/);
    await telegram.call('answerCallbackQuery',{callback_query_id:callback.id,...(!action?{text:renderResponse(db,'FEATURE_UNAVAILABLE'),show_alert:true}:{})});
    if(action)routed={update_id:update.update_id,message:{message_id:-update.update_id,response_to_message_id:callback.message.message_id,
      from:callback.from,chat:callback.message.chat,text:`#DONGI ai-${action[1]} ${action[2]}`}};
    else routed={};
   }
   if(acceptedMessage(routed.message,bot)){
    const message=routed.message;
    const duplicate=db.prepare('SELECT 1 FROM processed_updates WHERE update_id=? OR (chat_id=? AND message_id=?)').get(routed.update_id,String(message.chat.id),message.message_id);
    let temporary;
    const slow=callback||message.reply_to_message?.from?.id===bot.id||/هی\s+دنگی|#dongi\s+(invoice|settle|balance|details|void|restore|freeze|unfreeze|alias|bank|ai-confirm|user\s+(suspend|activate))/iu.test(message.text??'');
    if(slow&&!duplicate){
     const sent=await telegram.call('sendMessage',{chat_id:String(message.chat.id),text:'صبر کن دارم فکر می‌کنم',reply_parameters:{message_id:message.response_to_message_id??message.message_id}});
     if(Number.isSafeInteger(sent?.message_id)){
      temporary={chat_id:String(message.chat.id),message_id:sent.message_id};
      db.prepare('INSERT OR IGNORE INTO temporary_messages VALUES (?,?)').run(temporary.chat_id,temporary.message_id);
     }
    }
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),deps.requestTimeoutMs??120000);
    const signal=deps.shutdownSignal?AbortSignal.any([controller.signal,deps.shutdownSignal]):controller.signal;
    const boundedTelegram={call:(method,payload)=>withSignal(signal,()=>telegram.call(method,payload,signal))};
    const boundedAi=ai?{...ai,gateway:{run:(kind,task)=>ai.gateway.run(kind,s=>task(AbortSignal.any([s,signal])))}}:undefined;
    let prepared;
    try{
     if(!duplicate)prepared=await withSignal(signal,async()=>
      await prepareConversation(db,boundedTelegram,routed,boundedAi,bot)
      ??await prepareAi(db,boundedTelegram,routed,boundedAi)
      ??await prepareManagement(db,boundedTelegram,routed)
      ??await prepareBank(db,boundedTelegram,routed)
      ??await prepareInvoice(db,boundedTelegram,routed));
    }catch(error){prepared={error:signal.aborted?'REQUEST_TIMEOUT':error.code??'INTERNAL_ERROR'};}
    finally{clearTimeout(timer);}
    if(deps.shutdownSignal?.aborted)break;
    if(signal.aborted)prepared={error:'REQUEST_TIMEOUT'};
    const result=router(routed,prepared);
    if(result.fallback)await telegram.call('sendMessage',result.fallback);
    await deliver();
    if(temporary)await cleanupTemporary(deps);
   }
  }
  db.prepare("INSERT INTO runtime_state VALUES ('offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(update.update_id+1));
  await deliver();
 }
}

function retryDelay(ms,signal){
 if(signal?.aborted)return Promise.resolve();
 return new Promise(resolve=>{
  const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve();};
  const timer=setTimeout(finish,ms);
  signal?.addEventListener('abort',finish,{once:true});
 });
}

export async function runPolling(dependencies,shouldStop,sleep=retryDelay){
 const deps=dependencies;
 if(shouldStop())return;
 let sessionReady=false;
 let consecutiveFailures=0;
 let lastFailureLoggedAt=0;
 while(!shouldStop()){
  try{
   if(!sessionReady){await beginSession(deps);sessionReady=true;}
   await pollOnce(deps);
   consecutiveFailures=0;
  }catch(error){
   if(shouldStop())break;
   consecutiveFailures=Math.min(consecutiveFailures+1,7);
   const now=Date.now();
   if(consecutiveFailures===1||now-lastFailureLoggedAt>=300000){
    dependencies.log('POLL_FAILED',newTraceId(),{error_type:'TELEGRAM_OR_STORAGE_FAILURE',stage:'POLL'},'ERROR');
    lastFailureLoggedAt=now;
   }
   if(error.code===401||error.code===409)throw error;
   if(deps.db.connectionLost||error.code==='DB_OPERATION_TIMEOUT')throw new Error('DATABASE_CONNECTION_LOST');
   const backoff=Math.min(60000,1000*2**Math.min(consecutiveFailures-1,6));
   await sleep(Math.min(60000,Math.max(backoff,(Number(error.retryAfter)||0)*1000)),deps.shutdownSignal);
  }
 }
}
