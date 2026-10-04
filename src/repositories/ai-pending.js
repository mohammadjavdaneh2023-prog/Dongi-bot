import { randomBytes, randomUUID } from 'node:crypto';
import { requireCondition } from '../domain/errors.js';
import { buildInvoice } from '../domain/invoices.js';
import { planAllocations } from '../domain/settlements.js';
import { validateAiIntent, hasAmbiguousMention } from '../bot/ai-intent.js';
import { invoiceContext, saveInvoice, saveSettlement } from './invoices.js';
import { applyNetting } from './netting.js';

function preview(db,intent,context) {
  const built=buildInvoice(intent,context);
  if(intent.type==='SETTLEMENT') built.type='SETTLEMENT';
  const allocations=intent.type==='SETTLEMENT' ? planAllocations(built,db.prepare(`SELECT e.*,i.public_ref,i.created_at
    FROM invoice_entries e JOIN invoices i ON i.id=e.invoice_id WHERE i.lifecycle_status='ACTIVE' AND e.open_amount!=0`).all(),intent.against) : [];
  return {built,allocations};
}
function audit(db,event,actor,token,traceId,now) {
  db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?,?)').run(randomUUID(),event,actor,actor,traceId,JSON.stringify({pending_token:token}),now);
}
function contextFor(db,message,verified,now) {
  requireCondition(['group','supergroup'].includes(message.chat.type),'INVOICE_GROUP_ONLY');
  requireCondition(Number.isSafeInteger(message.from?.id)&&!message.from.is_bot&&!message.sender_chat,'PERMISSION_DENIED');
  requireCondition(verified?.chatId===String(message.chat.id)&&verified.actorTelegramId===String(message.from.id)
    && Number.isFinite(verified.verifiedAt)&&now>=verified.verifiedAt&&now-verified.verifiedAt<=60000
    && verified.currentMemberIds instanceof Set,'MEMBERSHIP_CHECK_FAILED');
  return {...invoiceContext(db,message),currentMemberIds:verified.currentMemberIds};
}

// Caller owns the transaction, including the outbox and processed update.
export function createPending(db,{proposal,message,verified,traceId,now=Date.now()}) {
  requireCondition(db.isTransaction,'DB_TRANSACTION_FAILED');
  const parsed=validateAiIntent(JSON.stringify({kind:proposal.kind,lines:proposal.command?.split('\n')}));
  requireCondition(parsed.intent,'AI_INVALID_OUTPUT');
  const context=contextFor(db,message,verified,now);
  requireCondition(!hasAmbiguousMention(message.text??'',context),'AMBIGUOUS_USER');
  const snapshot=preview(db,parsed.intent,context);
  const token=randomBytes(18).toString('hex');
  const expiresAt=now+5*60*1000;
  db.prepare(`INSERT INTO ai_pending VALUES (?,?,?,?,?,?,?,?,'PENDING',NULL)`).run(token,context.actorId,String(message.chat.id),
    message.message_id,JSON.stringify(parsed.intent),JSON.stringify(snapshot),now,expiresAt);
  audit(db,'AI_PREVIEW_CREATED',context.actorId,token,traceId,now);
  return {token,expiresAt,...snapshot};
}

export function resolvePending(db,{token,action,message,verified,traceId,now=Date.now()}) {
  requireCondition(db.isTransaction,'DB_TRANSACTION_FAILED');
  requireCondition(['confirm','cancel'].includes(action),'AI_CONFIRMATION_INVALID');
  const row=db.prepare('SELECT * FROM ai_pending WHERE token=?').get(token);
  const actor=db.prepare('SELECT id FROM users WHERE telegram_user_id=?').get(String(message.from?.id));
  requireCondition(row&&row.actor_id===actor?.id&&row.chat_id===String(message.chat.id)&&!message.from?.is_bot&&!message.sender_chat,'AI_CONFIRMATION_INVALID');
  requireCondition(row.status==='PENDING','AI_CONFIRMATION_USED');
  requireCondition(now<row.expires_at,'AI_CONFIRMATION_EXPIRED');
  if(action==='cancel') {
    db.prepare("UPDATE ai_pending SET status='CANCELLED' WHERE token=?").run(token);
    audit(db,'AI_PREVIEW_CANCELLED',actor.id,token,traceId,now);
    return {event:'AI_PREVIEW_CANCELLED'};
  }
  const context=contextFor(db,message,verified,now);
  const intent=JSON.parse(row.intent_json);
  const snapshot=preview(db,intent,context);
  requireCondition(JSON.stringify(snapshot)===row.preview_json,'AI_PREVIEW_CHANGED');
  const source={...message,message_id:row.source_message_id};
  const invoice=intent.type==='SETTLEMENT'
    ?saveSettlement(db,snapshot.built,intent.against,source,actor.id,traceId)
    :saveInvoice(db,snapshot.built,source,actor.id,traceId);
  db.prepare("UPDATE invoices SET input_mode='AI_CONFIRMED' WHERE id=?").run(invoice.id);
  const nettingCount=applyNetting(db,invoice.id,actor.id,traceId);
  db.prepare("UPDATE ai_pending SET status='CONFIRMED',invoice_id=? WHERE token=?").run(invoice.id,token);
  audit(db,'AI_PREVIEW_CONFIRMED',actor.id,token,traceId,now);
  return {event:'AI_PREVIEW_CONFIRMED',invoice,nettingCount};
}
