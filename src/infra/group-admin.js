import {randomUUID} from 'node:crypto';
import {DomainError,requireCondition} from '../domain/errors.js';
import {transaction} from './db/database.js';
import {newTraceId} from './logging.js';

export async function syncActorAdmin(db,telegram,message,actor){
 let member;
 try{member=await telegram.call('getChatMember',{chat_id:String(message.chat.id),user_id:Number(actor.telegram_user_id)});}
 catch{throw new DomainError('MEMBERSHIP_CHECK_FAILED');}
 requireCondition(member?.user?.id===Number(actor.telegram_user_id),'MEMBERSHIP_CHECK_FAILED');
 const admin=['creator','administrator'].includes(member.status);
 transaction(db,()=>{
  const old=Boolean(db.prepare('SELECT 1 FROM group_roles WHERE telegram_chat_id=? AND user_id=?').get(String(message.chat.id),actor.id));
  if(old===admin)return;
  if(admin)db.prepare("INSERT INTO group_roles VALUES (?,?,'ADMIN')").run(String(message.chat.id),actor.id);
  else db.prepare('DELETE FROM group_roles WHERE telegram_chat_id=? AND user_id=?').run(String(message.chat.id),actor.id);
  db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?,?)').run(randomUUID(),'GROUP_ROLE_SYNCED',actor.id,actor.id,newTraceId(),
    JSON.stringify({chat_id:String(message.chat.id),before:old?'ADMIN':'MEMBER',after:admin?'ADMIN':'MEMBER',source:'GET_CHAT_MEMBER'}),Date.now());
 });
 return member;
}
