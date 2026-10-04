import { requireCondition } from '../domain/errors.js';
import { settlementState } from '../domain/settlements.js';

export function parseDetails(db, message) {
  const match = message.text.trim().match(/^#dongi\s+(details|void|restore)(?:\s+#([1-9]\d*))?$/i);
  requireCondition(match, 'PARSE_FAILED');
  let invoice;
  if (match[2]) {
    requireCondition(Number.isSafeInteger(Number(match[2])), 'INVOICE_NOT_FOUND');
    invoice = db.prepare('SELECT * FROM invoices WHERE public_ref=?').get(Number(match[2]));
  } else {
    const replyId = message.reply_to_message?.message_id;
    requireCondition(Number.isSafeInteger(replyId), 'INVOICE_CONTEXT_REQUIRED');
    invoice = db.prepare(`SELECT i.* FROM receipt_messages r JOIN invoices i ON i.id=r.invoice_id
      WHERE r.chat_id=? AND r.message_id=?`).get(String(message.chat.id),replyId);
  }
  requireCondition(invoice, 'INVOICE_NOT_FOUND');
  return { intent:match[1].toLowerCase(), invoiceId:invoice.id };
}

export function loadDetails(db, id) {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id=?').get(id);
  requireCondition(invoice, 'INVOICE_NOT_FOUND');
  const entries = db.prepare(`SELECT e.*,u.public_id,u.canonical_name FROM invoice_entries e JOIN users u ON u.id=e.user_id
    WHERE e.invoice_id=? ORDER BY e.position`).all(id);
  const allocations = db.prepare(`SELECT a.*,s.public_ref AS settlement_ref,t.public_ref AS target_ref,u.public_id
    FROM settlement_allocations a JOIN invoices s ON s.id=a.settlement_invoice_id
    JOIN invoice_entries e ON e.id=a.target_invoice_entry_id JOIN invoices t ON t.id=e.invoice_id
    JOIN users u ON u.id=e.user_id WHERE s.id=? OR t.id=? ORDER BY a.created_at,a.id`).all(id,id);
  const netting=db.prepare(`SELECT n.*,p.public_ref AS positive_ref,d.public_ref AS negative_ref,u.public_id
    FROM netting_allocations n JOIN invoice_entries pe ON pe.id=n.positive_entry_id JOIN invoices p ON p.id=pe.invoice_id
    JOIN invoice_entries de ON de.id=n.negative_entry_id JOIN invoices d ON d.id=de.invoice_id
    JOIN users u ON u.id=n.user_id WHERE p.id=? OR d.id=? ORDER BY n.created_at,n.id`).all(id,id);
  return { ...invoice, entries, allocations, netting, settlement_state:settlementState(entries) };
}
