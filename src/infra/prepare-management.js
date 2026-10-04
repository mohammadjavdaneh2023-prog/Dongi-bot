import { DomainError, requireCondition } from '../domain/errors.js';
import {syncActorAdmin} from './group-admin.js';

export function parseManagement(text) {
  const match=text.trim().match(/^#dongi\s+(?:(freeze|unfreeze)|(user)\s+(suspend|activate))\s+(\S+)$/i);
  requireCondition(match,'PARSE_FAILED');
  return {action:(match[1]??match[3]).toLowerCase(),publicId:match[4]};
}

export async function prepareManagement(db,telegram,update) {
  const message=update.message;
  if(!/^#dongi\s+(?:alias\b|freeze\b|unfreeze\b|user\s+(?:suspend|activate)\b)/i.test(message?.text?.trim()??'')) return undefined;
  try {
    const alias=message.text.trim().match(/^#dongi\s+alias\s+(\S+)\s+(add|remove)\s+(.+)$/i);
    const intent=alias?{action:'alias',publicId:alias[1]}:parseManagement(message.text);
    requireCondition(Number.isSafeInteger(message.from?.id)&&!message.from.is_bot&&!message.sender_chat,'PERMISSION_DENIED');
    const actor=db.prepare('SELECT * FROM users WHERE telegram_user_id=?').get(String(message.from.id));
    requireCondition(actor&&actor.status!=='SUSPENDED','PERMISSION_DENIED');
    requireCondition(actor.status!=='FROZEN','ACTOR_FROZEN');
    requireCondition(actor.bot_started===1,'USER_NOT_STARTED');
    const target=db.prepare('SELECT * FROM users WHERE public_id=?').get(intent.publicId);
    requireCondition(target,'UNKNOWN_USER',{addressed_as:intent.publicId});
    requireCondition(intent.action==='alias'&&actor.role==='OWNER'||target.role!=='OWNER','OWNER_PROTECTED');
    const group=['group','supergroup'].includes(message.chat.type);
    if(group&&actor.role!=='OWNER') await syncActorAdmin(db,telegram,message,actor);
    if(actor.role!=='OWNER') {
      requireCondition(group&&['freeze','unfreeze','alias'].includes(intent.action)
        &&db.prepare('SELECT 1 FROM group_roles WHERE telegram_chat_id=? AND user_id=?').get(String(message.chat.id),actor.id),'PERMISSION_DENIED');
    }
    const currentMemberIds=new Set();
    if(group) {
      const candidates=actor.role==='OWNER'?[actor]:[actor,target];
      for(const user of candidates) {
        requireCondition(user.telegram_user_id&&user.bot_started,'USER_NOT_STARTED',{public_id:user.public_id});
        let member;
        try{member=await telegram.call('getChatMember',{chat_id:String(message.chat.id),user_id:Number(user.telegram_user_id)});}
        catch{throw new DomainError('MEMBERSHIP_CHECK_FAILED',{public_id:user.public_id});}
        requireCondition(member?.user?.id===Number(user.telegram_user_id),'MEMBERSHIP_CHECK_FAILED');
        if(['creator','administrator','member'].includes(member.status)||(member.status==='restricted'&&member.is_member)) currentMemberIds.add(user.id);
      }
    }
    return {intent,currentMemberIds,verifiedAt:Date.now(),updateId:update.update_id,chatId:String(message.chat.id)};
  }catch(error){return {error:error instanceof DomainError?error.code:'INTERNAL_ERROR',details:error instanceof DomainError?error.details:{}};}
}
