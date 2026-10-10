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

export function projectGroupBalance(invoices, users, currentMemberIds, chatId) {
  const scoped = invoices.filter(invoice => String(invoice.source_chat_id) === String(chatId));
  return projectBalance(scoped, users, currentMemberIds);
}

// Add the full balance of the current group, then add a zero-sum projection of
// each other historical group shared by at least two current group participants.
export function projectCombinedGroupBalance(invoices, users, currentMemberIds, chatId, sharedGroupMemberIds) {
  const base = projectGroupBalance(invoices, users, currentMemberIds, chatId);
  const byUser = new Map(base.rows.map(row => [row.user_id, { ...row }]));
  const groups = new Map();
  for (const invoice of invoices) {
    if (invoice.lifecycle_status !== 'ACTIVE' || String(invoice.source_chat_id) === String(chatId)) continue;
    if (!groups.has(String(invoice.source_chat_id))) groups.set(String(invoice.source_chat_id), new Map());
    const totals = groups.get(String(invoice.source_chat_id));
    for (const entry of invoice.entries) totals.set(entry.user_id, (totals.get(entry.user_id) ?? 0n) + BigInt(entry.amount));
  }

  let groupsIncluded = 0;
  for (const [sourceChatId, totals] of groups) {
    const verifiedMemberIds = sharedGroupMemberIds?.get(sourceChatId);
    const shared = verifiedMemberIds
      ? [...verifiedMemberIds].filter(id => byUser.has(id)).map(id => ({ id, amount: totals.get(id) ?? 0n, row: byUser.get(id) }))
      : [...totals].filter(([id]) => byUser.has(id)).map(([id, amount]) => ({ id, amount, row: byUser.get(id) }));
    if (shared.length < 2) continue;
    const offsetTotal = -shared.reduce((sum, item) => sum + item.amount, 0n);
    const count = BigInt(shared.length);
    const commonOffset = offsetTotal / count;
    const remainder = offsetTotal % count;
    const ordered = shared.sort((a, b) => a.row.public_id < b.row.public_id ? -1 : a.row.public_id > b.row.public_id ? 1 : 0);
    const remainderCount = Number(remainder < 0n ? -remainder : remainder);
    for (let index = 0; index < ordered.length; index++) {
      const roundingUnit = index < remainderCount ? (remainder < 0n ? -1n : 1n) : 0n;
      ordered[index].row.amount += ordered[index].amount + commonOffset + roundingUnit;
    }
    groupsIncluded++;
  }
  const rows = [...byUser.values()].sort((a, b) => a.public_id < b.public_id ? -1 : a.public_id > b.public_id ? 1 : 0);
  requireCondition(rows.reduce((sum, row) => sum + row.amount, 0n) === 0n, 'ZERO_SUM_FAILED');
  return { rows, included: base.included, excluded: base.excluded, groupsIncluded };
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
