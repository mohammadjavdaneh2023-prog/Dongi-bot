import { classifyTrigger } from '../bot/triggers.js';
import { interpretAi } from '../bot/ai-intent.js';
import { invoiceContext } from '../repositories/invoices.js';
import { requireCondition } from '../domain/errors.js';
import { conversationReply } from './prepare-conversation.js';
import {planAllocations} from '../domain/settlements.js';

export async function prepareAi(db,telegram,update,ai) {
 const message=update.message;
 if(!message)return;
 const action=message.text?.match(/^#DONGI ai-(confirm|cancel) ([a-f0-9]{36})$/);
 const core=classifyTrigger({kind:'message',chatType:message.chat?.type,text:message.text})==='AI_CORE';
 if(!action&&!core)return;
 try {
  requireCondition(Number.isSafeInteger(message.from?.id)&&!message.from.is_bot&&!message.sender_chat,'PERMISSION_DENIED');
  if(db.prepare('SELECT 1 FROM processed_updates WHERE update_id=? OR (chat_id=? AND message_id=?)').get(update.update_id,String(message.chat.id),message.message_id))return;
  if(action?.[1]==='cancel')return {aiAction:'cancel',token:action[2]};
  requireCondition(['group','supergroup'].includes(message.chat.type),'INVOICE_GROUP_ONLY');
  if(core)requireCondition(ai,'FEATURE_UNAVAILABLE');
  const context=invoiceContext(db,message);
  const actor=context.users.find(u=>u.id===context.actorId);
  requireCondition(actor&&actor.status==='ACTIVE'&&actor.bot_started,'PERMISSION_DENIED');
  requireCondition(!context.groupFrozenIds.has(actor.id),'ACTOR_FROZEN');
  if(core&&/بانک|\bbank\b/iu.test(message.text??''))return {proposal:{kind:'ADMIN_REJECTED'}};
  if(action){
   const pending=db.prepare('SELECT actor_id,chat_id,status,expires_at FROM ai_pending WHERE token=?').get(action[2]);
   requireCondition(pending?.actor_id===actor.id&&pending.chat_id===String(message.chat.id),'AI_CONFIRMATION_INVALID');
   requireCondition(pending.status==='PENDING','AI_CONFIRMATION_USED');
   requireCondition(Date.now()<pending.expires_at,'AI_CONFIRMATION_EXPIRED');
  }
  const includesAll=/همه|\ball\b/iu.test(message.text??'');
  let candidateIds=new Set(includesAll?context.users.map(u=>u.id):[actor.id]);
  if(action){
    const saved=db.prepare('SELECT preview_json,intent_json FROM ai_pending WHERE token=?').get(action[2]);
    const intent=JSON.parse(saved.intent_json);
    candidateIds=new Set(intent.positive?.all||intent.negative?.all?context.users.map(u=>u.id):[actor.id,...JSON.parse(saved.preview_json).built.entries.map(e=>e.user_id)]);
  }
  const verify=async()=>{
   const currentMemberIds=new Set();const verifiedAt=Date.now();
   for(const user of context.users.filter(u=>candidateIds.has(u.id)&&u.bot_started&&u.telegram_user_id&&u.status!=='SUSPENDED')){
    let member;
    try{member=await telegram.call('getChatMember',{chat_id:String(message.chat.id),user_id:Number(user.telegram_user_id)});}catch{throw {code:'MEMBERSHIP_CHECK_FAILED'};}
    requireCondition(member?.user?.id===Number(user.telegram_user_id),'MEMBERSHIP_CHECK_FAILED');
    if(['creator','administrator','member'].includes(member.status)||(member.status==='restricted'&&member.is_member))currentMemberIds.add(user.id);
   }
   return {currentMemberIds,verifiedAt,chatId:String(message.chat.id),actorTelegramId:String(message.from.id)};
  };
  let verified=await verify();
  if(action)return {aiAction:action[1],token:action[2],verified};
  requireCondition(verified.currentMemberIds.has(actor.id),'USER_NOT_IN_GROUP');
  // Names/IDs are candidates for interpretation, NOT evidence of membership. No
  // proposal is shown or committed until all selected participants are verified.
  const identityCandidates=includesAll?verified.currentMemberIds:new Set(context.users.filter(u=>u.bot_started&&u.telegram_user_id&&u.status!=='SUSPENDED').map(u=>u.id));
  const proposal=await interpretAi({text:message.text,context:{...context,currentMemberIds:identityCandidates},...ai,
    validateFinancial:(proposal,built)=>{if(proposal.kind==='SETTLEMENT')planAllocations(built,db.prepare(`SELECT e.*,i.public_ref,i.created_at
      FROM invoice_entries e JOIN invoices i ON i.id=e.invoice_id WHERE i.lifecycle_status='ACTIVE' AND e.open_amount!=0`).all(),proposal.intent.against);}});
  if(proposal.kind==='CHAT' && Math.random()>=0.1)return {conversationEvent:'INTERACTION_DISMISS',proposal,verified};
  if(proposal.kind==='CHAT')return {...await conversationReply(ai,message,actor.role),proposal,verified};
  if(proposal.intent){
    candidateIds=new Set([actor.id,...proposal.preview.entries.map(e=>e.user_id)]);
    verified=await verify();
    requireCondition([...candidateIds].every(id=>verified.currentMemberIds.has(id)),'USER_NOT_IN_GROUP');
  }
  return {proposal,verified};
 }catch(error){return {error:error.code??'AI_PROVIDER_ERROR'};}
}
