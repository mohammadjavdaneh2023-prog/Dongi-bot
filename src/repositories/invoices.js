import { randomUUID } from 'node:crypto';
import { requireCondition } from '../domain/errors.js';
import { planAllocations } from '../domain/settlements.js';

export function loadActiveInvoices(db) {
  const invoices = db.prepare("SELECT id,lifecycle_status,source_chat_id FROM invoices WHERE lifecycle_status = 'ACTIVE'").all();
  const entries = db.prepare("SELECT e.invoice_id,e.user_id,e.amount FROM invoice_entries e JOIN invoices i ON i.id=e.invoice_id WHERE i.lifecycle_status='ACTIVE'").all();
  const byInvoice = new Map(invoices.map(invoice => [invoice.id, { ...invoice, entries: [] }]));
  for (const entry of entries) byInvoice.get(entry.invoice_id).entries.push(entry);
  return [...byInvoice.values()];
}

export function invoiceContext(db, message) {
  const users = db.prepare('SELECT * FROM users WHERE retired_at IS NULL ORDER BY public_id').all();
  const aliases = db.prepare('SELECT user_id, alias FROM user_aliases ORDER BY id').all();
  for (const user of users) user.aliases = aliases.filter(alias => alias.user_id === user.id).map(alias => alias.alias);
  return { users, actorId: users.find(user => user.telegram_user_id === String(message.from?.id))?.id,
    groupFrozenIds: new Set(db.prepare('SELECT user_id FROM group_restrictions WHERE telegram_chat_id = ? AND frozen = 1').all(String(message.chat.id)).map(row => row.user_id)) };
}

export function saveInvoice(db, invoice, message, actorId, traceId) {
  requireCondition(db.isTransaction, 'DB_TRANSACTION_FAILED');
  requireCondition(invoice.entries.reduce((sum, entry) => sum + BigInt(entry.amount), 0n) === 0n, 'ZERO_SUM_FAILED');
  const id = randomUUID();
  const now = Date.now();
  const inserted = db.prepare(`INSERT INTO invoices(id,type,lifecycle_status,title,created_at,created_by_user_id,
    source_chat_id,source_message_id,input_mode,currency,gross_amount)
    VALUES (?,?,'ACTIVE',?,?,?,?,?,'DETERMINISTIC',?,?) RETURNING public_ref`).run(id, invoice.type, invoice.title, now, actorId,
    String(message.chat.id), message.message_id, invoice.currency, invoice.gross_amount);
  const insertEntry = db.prepare(`INSERT INTO invoice_entries(id,invoice_id,user_id,addressed_as,input_names_json,amount,open_amount,position)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (const entry of invoice.entries) insertEntry.run(randomUUID(), id, entry.user_id, entry.addressed_as,
    JSON.stringify(entry.input_names), entry.amount, entry.open_amount, entry.position);
  db.prepare(`INSERT INTO audit_events(id,event,actor_user_id,target_user_id,trace_id,metadata_json,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), invoice.type === 'SETTLEMENT' ? 'SETTLEMENT_CREATED' : 'INVOICE_CREATED', actorId, actorId, traceId,
    JSON.stringify({ invoice_id: id, public_ref: Number(inserted.lastInsertRowid), ...invoice }), now);
  return { ...invoice, id, public_ref: Number(inserted.lastInsertRowid) };
}

export function saveSettlement(db, invoice, against, message, actorId, traceId) {
  requireCondition(db.isTransaction, 'DB_TRANSACTION_FAILED');
  const entries = db.prepare(`SELECT e.*,i.public_ref,i.created_at FROM invoice_entries e JOIN invoices i ON i.id=e.invoice_id
    WHERE i.lifecycle_status='ACTIVE' AND e.open_amount != 0`).all();
  if (against) {
    const active = new Set(db.prepare("SELECT public_ref FROM invoices WHERE lifecycle_status='ACTIVE'").all().map(row => row.public_ref));
    requireCondition(against.every(ref => active.has(ref)), 'SETTLEMENT_TARGET_INVALID');
  }
  const allocations = planAllocations(invoice, entries, against);
  const saved = saveInvoice(db, { ...invoice, type: 'SETTLEMENT' }, message, actorId, traceId);
  const ownEntries = db.prepare('SELECT id,user_id FROM invoice_entries WHERE invoice_id=?').all(saved.id);
  for (const allocation of allocations) {
    const changed = db.prepare('UPDATE invoice_entries SET open_amount=? WHERE id=? AND open_amount=?')
      .run(allocation.after, allocation.target_entry_id, allocation.before);
    requireCondition(changed.changes === 1, 'SETTLEMENT_ALLOCATION_FAILED');
    db.prepare('INSERT INTO settlement_allocations VALUES (?,?,?,?,?,?,?)').run(randomUUID(),saved.id,
      ownEntries.find(entry => entry.user_id === allocation.user_id).id,allocation.target_entry_id,allocation.amount,allocation.side,Date.now());
  }
  // Both sides were fully allocated, so the settlement's own entries are closed too.
  db.prepare('UPDATE invoice_entries SET open_amount=0 WHERE invoice_id=?').run(saved.id);
  db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?,?)').run(randomUUID(),'SETTLEMENT_ALLOCATED',actorId,actorId,traceId,
    JSON.stringify({ invoice_id: saved.id, allocations }),Date.now());
  return { ...saved, entries: saved.entries.map(entry => ({ ...entry, open_amount: 0 })) };
}
