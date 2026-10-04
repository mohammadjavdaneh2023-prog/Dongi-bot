import { requireCondition } from './errors.js';

export function projectBalance(invoices, users, currentMemberIds) {
  const eligible = users.filter(user => currentMemberIds.has(user.id) && user.bot_started && user.telegram_user_id && user.public_id && user.status !== 'SUSPENDED');
  const balances = new Map(eligible.map(user => [user.id, { user_id: user.id, public_id: user.public_id, name: user.canonical_name, amount: 0n }]));
  let included = 0;
  let excluded = 0;
  for (const invoice of invoices) {
    if (invoice.lifecycle_status !== 'ACTIVE') continue;
    if (!invoice.entries.some(entry => balances.has(entry.user_id))) continue;
    if (!invoice.entries.every(entry => balances.has(entry.user_id))) { excluded++; continue; }
    requireCondition(invoice.entries.reduce((sum, entry) => sum + BigInt(entry.amount), 0n) === 0n, 'ZERO_SUM_FAILED');
    included++;
    for (const entry of invoice.entries) balances.get(entry.user_id).amount += BigInt(entry.amount);
  }
  const rows = [...balances.values()].sort((a, b) => a.public_id < b.public_id ? -1 : a.public_id > b.public_id ? 1 : 0);
  requireCondition(rows.reduce((sum, row) => sum + row.amount, 0n) === 0n, 'ZERO_SUM_FAILED');
  return { rows, included, excluded };
}

export function settlementPlan(rows) {
  requireCondition(rows.reduce((sum, row) => sum + row.amount, 0n) === 0n, 'ZERO_SUM_FAILED');
  const debtors = rows.filter(row => row.amount < 0n).map(row => ({ ...row, remaining: -row.amount }));
  const creditors = rows.filter(row => row.amount > 0n).map(row => ({ ...row, remaining: row.amount }));
  const order = (a, b) => a.remaining === b.remaining ? (a.public_id < b.public_id ? -1 : a.public_id > b.public_id ? 1 : 0) : a.remaining > b.remaining ? -1 : 1;
  const transfers = [];
  while (debtors.length && creditors.length) {
    debtors.sort(order); creditors.sort(order);
    const debtor = debtors[0]; const creditor = creditors[0];
    const amount = debtor.remaining < creditor.remaining ? debtor.remaining : creditor.remaining;
    transfers.push({ from: debtor.public_id, from_name: debtor.name, to: creditor.public_id, to_name: creditor.name, amount });
    debtor.remaining -= amount; creditor.remaining -= amount;
    if (debtor.remaining === 0n) debtors.shift();
    if (creditor.remaining === 0n) creditors.shift();
  }
  return transfers;
}
