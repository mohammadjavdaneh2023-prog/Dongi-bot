import { randomUUID } from 'node:crypto';
import { requireCondition } from '../domain/errors.js';

export function changeInvoiceLifecycle(db, { actor, message, invoiceId, action, traceId, currentMemberIds }) {
  requireCondition(db.isTransaction,'DB_TRANSACTION_FAILED');
  requireCondition(['void','restore'].includes(action),'PARSE_FAILED');
  requireCondition(actor && actor.status !== 'SUSPENDED','PERMISSION_DENIED');
  requireCondition(actor.status !== 'FROZEN','ACTOR_FROZEN');
  requireCondition(actor.bot_started===1,'USER_NOT_STARTED');
  const invoice=db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId);
  requireCondition(invoice,'INVOICE_NOT_FOUND');
  if(message.chat.type !== 'private') {
    requireCondition(currentMemberIds.has(actor.id),'USER_NOT_IN_GROUP');
    requireCondition(!db.prepare('SELECT 1 FROM group_restrictions WHERE telegram_chat_id=? AND user_id=? AND frozen=1')
      .get(String(message.chat.id),actor.id),'ACTOR_FROZEN');
  }
  if(actor.role !== 'OWNER') {
    requireCondition(message.chat.type !== 'private' && invoice.source_chat_id===String(message.chat.id)
      && ((action==='void' && invoice.created_by_user_id===actor.id)
        || db.prepare('SELECT 1 FROM group_roles WHERE telegram_chat_id=? AND user_id=?').get(String(message.chat.id),actor.id)),'PERMISSION_DENIED');
  }
  requireCondition(invoice.lifecycle_status === (action==='void'?'ACTIVE':'VOID'),action==='void'?'INVOICE_ALREADY_VOID':'INVOICE_NOT_VOID');
  const settlement=db.prepare(`SELECT 1 FROM settlement_allocations a JOIN invoice_entries e ON e.id=a.target_invoice_entry_id
    WHERE a.settlement_invoice_id=? OR e.invoice_id=? LIMIT 1`).get(invoiceId,invoiceId);
  const netting=db.prepare(`SELECT 1 FROM netting_allocations n JOIN invoice_entries p ON p.id=n.positive_entry_id
    JOIN invoice_entries d ON d.id=n.negative_entry_id WHERE p.invoice_id=? OR d.invoice_id=? LIMIT 1`).get(invoiceId,invoiceId);
  requireCondition(!settlement && !netting,'INVOICE_HAS_DEPENDENCIES');
  requireCondition(!db.prepare('SELECT 1 FROM invoice_entries WHERE invoice_id=? AND open_amount != amount LIMIT 1').get(invoiceId),'INVOICE_HAS_DEPENDENCIES');
  const status=action==='void'?'VOID':'ACTIVE';
  db.prepare('UPDATE invoices SET lifecycle_status=? WHERE id=?').run(status,invoiceId);
  const event=action==='void'?'INVOICE_VOIDED':'INVOICE_RESTORED';
  db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?,?)').run(randomUUID(),event,actor.id,actor.id,traceId,
    JSON.stringify({invoice_id:invoiceId,public_ref:invoice.public_ref,before:invoice.lifecycle_status,after:status}),Date.now());
  return {event,public_ref:invoice.public_ref,id:invoiceId};
}
