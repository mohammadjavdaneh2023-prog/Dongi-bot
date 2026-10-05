import {parseBank} from '../bot/bank-parser.js';
import {DomainError,requireCondition} from '../domain/errors.js';
import {syncActorAdmin} from './group-admin.js';

export async function prepareBank(db,telegram,update){
 const message=update.message;
 if(!/^#dongi\s+bank\b/i.test(message?.text?.trim()??''))return;
 try{
  const intent=parseBank(message.text);
  requireCondition(['group','supergroup'].includes(message.chat.type),'BANK_GROUP_ONLY');
  requireCondition(Number.isSafeInteger(message.from?.id)&&!message.from.is_bot&&!message.sender_chat,'PERMISSION_DENIED');
  const actor=db.prepare('SELECT * FROM users WHERE telegram_user_id=?').get(String(message.from.id));
  requireCondition(actor?.bot_started&&actor.status==='ACTIVE','PERMISSION_DENIED');
  requireCondition(!db.prepare('SELECT 1 FROM group_restrictions WHERE telegram_chat_id=? AND user_id=? AND frozen=1').get(String(message.chat.id),actor.id),'ACTOR_FROZEN');
  const verifiedAt=Date.now();
  if(actor.role!=='OWNER')await syncActorAdmin(db,telegram,message,actor);
  const admin=actor.role==='OWNER'||Boolean(db.prepare('SELECT 1 FROM group_roles WHERE telegram_chat_id=? AND user_id=?').get(String(message.chat.id),actor.id));
  let members;
  if(intent.action==='create'){
   requireCondition(admin,'PERMISSION_DENIED');
   members=intent.members.map(m=>{const user=db.prepare('SELECT * FROM users WHERE public_id=? AND retired_at IS NULL').get(m.publicId);requireCondition(user,'UNKNOWN_USER',{public_id:m.publicId});return user;});
  }else{
   const bank=db.prepare('SELECT * FROM banks WHERE id=?').get(intent.bankId);requireCondition(bank,'BANK_NOT_FOUND');
   members=db.prepare('SELECT u.* FROM bank_members m JOIN users u ON u.id=m.user_id WHERE m.bank_id=?').all(bank.id);
   requireCondition(admin||bank.manager_id===actor.id||(intent.action==='report'&&members.some(u=>u.id===actor.id)),'PERMISSION_DENIED');
  }
  const currentMemberIds=new Set();
  for(const user of [...new Map([actor,...members].map(u=>[u.id,u])).values()]){
   requireCondition(user.bot_started&&user.telegram_user_id,'USER_NOT_STARTED',{public_id:user.public_id});
   let member;try{member=await telegram.call('getChatMember',{chat_id:String(message.chat.id),user_id:Number(user.telegram_user_id)});}catch{throw new DomainError('MEMBERSHIP_CHECK_FAILED');}
   requireCondition(member?.user?.id===Number(user.telegram_user_id),'MEMBERSHIP_CHECK_FAILED');
   requireCondition(['creator','administrator','member'].includes(member.status)||(member.status==='restricted'&&member.is_member===true),'BANK_MEMBER_ABSENT',{public_id:user.public_id});
   currentMemberIds.add(user.id);
  }
  return {intent,currentMemberIds,verifiedAt,chatId:String(message.chat.id),updateId:update.update_id,actorId:actor.id};
 }catch(error){return {error:error instanceof DomainError?error.code:'INTERNAL_ERROR',details:error.details};}
}
