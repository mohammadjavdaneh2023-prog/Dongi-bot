import { randomUUID } from 'node:crypto';
import { planNetting } from '../domain/netting.js';
import { requireCondition } from '../domain/errors.js';

export function applyNetting(db, triggerInvoiceId, actorId, traceId) {
  requireCondition(db.isTransaction,'DB_TRANSACTION_FAILED');
  const entries=db.prepare(`SELECT e.*,i.created_at,i.public_ref FROM invoice_entries e JOIN invoices i ON i.id=e.invoice_id
    WHERE i.lifecycle_status='ACTIVE' AND e.open_amount != 0`).all();
  const planned=planNetting(entries);
  for(const item of planned) {
    const update=db.prepare('UPDATE invoice_entries SET open_amount=? WHERE id=? AND open_amount=?');
    requireCondition(update.run(item.positive_after,item.positive_entry_id,item.positive_before).changes===1,'NETTING_FAILED');
    requireCondition(update.run(item.negative_after,item.negative_entry_id,item.negative_before).changes===1,'NETTING_FAILED');
    const id=randomUUID(); const now=Date.now();
    db.prepare('INSERT INTO netting_allocations VALUES (?,?,?,?,?,?,?,?)').run(id,item.user_id,item.positive_entry_id,item.negative_entry_id,
      item.amount,now,triggerInvoiceId,'AUTO_AFTER_FINANCIAL_WRITE');
    db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?,?)').run(randomUUID(),'NETTING_APPLIED',actorId,item.user_id,traceId,
      JSON.stringify({ allocation_id:id,trigger_invoice_id:triggerInvoiceId,...item }),now);
  }
  return planned.length;
}
