import { requireCondition } from './errors.js';

export function planAllocations(invoice, openEntries, against) {
  requireCondition(invoice.entries.length === 2 && invoice.entries[0].user_id !== invoice.entries[1].user_id, 'SETTLEMENT_TARGET_INVALID');
  const allocations = [];
  for (const [index, side] of ['PAYER','RECEIVER'].entries()) {
    const own = invoice.entries[index];
    let remaining = BigInt(Math.abs(own.amount));
    const targets = openEntries.filter(entry => entry.user_id === own.user_id &&
      (index === 0 ? entry.open_amount < 0 : entry.open_amount > 0) && (!against || against.includes(entry.public_ref)));
    targets.sort((a,b) => b.created_at - a.created_at || b.public_ref - a.public_ref || a.position - b.position);
    const coverage = targets.reduce((sum, entry) => sum + BigInt(Math.abs(entry.open_amount)), 0n);
    requireCondition(coverage >= remaining, against ? 'SETTLEMENT_TARGET_INVALID' : coverage === 0n ? 'NO_OPEN_BALANCE' : 'SETTLEMENT_EXCEEDS_OPEN_BALANCE',
      { public_id: own.public_id, expected: String(remaining), actual: String(coverage) });
    for (const target of targets) {
      if (!remaining) break;
      const available = BigInt(Math.abs(target.open_amount));
      const amount = remaining < available ? remaining : available;
      allocations.push({ side, target_entry_id: target.id, user_id: own.user_id, amount: Number(amount),
        before: target.open_amount, after: target.open_amount + (index === 0 ? Number(amount) : -Number(amount)) });
      remaining -= amount;
    }
  }
  return allocations;
}

export function settlementState(entries) {
  if (entries.every(entry => entry.open_amount === 0)) return 'CLOSED';
  if (entries.every(entry => entry.open_amount === entry.amount)) return 'OPEN';
  return 'PARTIAL';
}
