import { randomUUID } from 'node:crypto';
import { requireCondition } from '../domain/errors.js';

export function manageUser(db,{actor,message,intent,currentMemberIds,traceId}) {
  requireCondition(db.isTransaction,'DB_TRANSACTION_FAILED');
  requireCondition(actor&&actor.status!=='SUSPENDED','PERMISSION_DENIED');
  requireCondition(actor.status!=='FROZEN','ACTOR_FROZEN');
  requireCondition(actor.bot_started===1,'USER_NOT_STARTED');
  const target=db.prepare('SELECT * FROM users WHERE public_id=?').get(intent.publicId);
  requireCondition(target,'UNKNOWN_USER',{addressed_as:intent.publicId});
  requireCondition(target.role!=='OWNER','OWNER_PROTECTED');
  const group=['group','supergroup'].includes(message.chat.type);
  if(group){
    requireCondition(currentMemberIds.has(actor.id),'USER_NOT_IN_GROUP');
    requireCondition(!db.prepare('SELECT 1 FROM group_restrictions WHERE telegram_chat_id=? AND user_id=? AND frozen=1').get(String(message.chat.id),actor.id),'ACTOR_FROZEN');
  }
  const local=actor.role!=='OWNER';
  if(local){
    requireCondition(group&&['freeze','unfreeze'].includes(intent.action)
      &&db.prepare('SELECT 1 FROM group_roles WHERE telegram_chat_id=? AND user_id=?').get(String(message.chat.id),actor.id),'PERMISSION_DENIED');
    requireCondition(currentMemberIds.has(target.id),'USER_NOT_IN_GROUP',{public_id:target.public_id});
  }
  let before;let after;
  if(local){
    before=db.prepare('SELECT frozen FROM group_restrictions WHERE telegram_chat_id=? AND user_id=?').get(String(message.chat.id),target.id)?.frozen??0;
    after=intent.action==='freeze'?1:0;
    requireCondition(before!==after,'USER_STATE_UNCHANGED');
    db.prepare('INSERT INTO group_restrictions VALUES (?,?,?) ON CONFLICT(telegram_chat_id,user_id) DO UPDATE SET frozen=excluded.frozen').run(String(message.chat.id),target.id,after);
  }else{
    before=target.status;
    const transitions={freeze:['ACTIVE','FROZEN'],unfreeze:['FROZEN','ACTIVE'],suspend:[null,'SUSPENDED'],activate:['SUSPENDED','ACTIVE']};
    const transition=transitions[intent.action];requireCondition(transition,'PARSE_FAILED');
    after=transition[1];
    requireCondition(before!==after,'USER_STATE_UNCHANGED');
    requireCondition(transition[0]===null||before===transition[0],'USER_STATE_INVALID');
    db.prepare('UPDATE users SET status=?,updated_at=? WHERE id=?').run(after,Date.now(),target.id);
  }
  const event={freeze:'USER_FROZEN',unfreeze:'USER_UNFROZEN',suspend:'USER_SUSPENDED',activate:'USER_ACTIVATED'}[intent.action];
  db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?,?)').run(randomUUID(),event,actor.id,target.id,traceId,
    JSON.stringify({before,after,scope:local?'GROUP':'GLOBAL',chat_id:local?String(message.chat.id):null}),Date.now());
  return {event,user:target,scope:local?'فقط همین گروه':'سراسری'};
}
