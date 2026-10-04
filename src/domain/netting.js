// Deterministic newest-first pairing; input rows are never mutated.
export function planNetting(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.open_amount) continue;
    if (!groups.has(entry.user_id)) groups.set(entry.user_id, []);
    groups.get(entry.user_id).push({ ...entry, remaining: BigInt(entry.open_amount) });
  }
  const result = [];
  const order = (a,b) => b.created_at-a.created_at || b.public_ref-a.public_ref || a.position-b.position;
  for (const userId of [...groups.keys()].sort()) {
    const rows=groups.get(userId);
    const positive=rows.filter(row=>row.remaining>0n).sort(order);
    const negative=rows.filter(row=>row.remaining<0n).sort(order);
    let p=0; let n=0;
    while(p<positive.length && n<negative.length) {
      const credit=positive[p]; const debt=negative[n];
      const amount=credit.remaining < -debt.remaining ? credit.remaining : -debt.remaining;
      result.push({ user_id:userId, positive_entry_id:credit.id, negative_entry_id:debt.id, amount:Number(amount),
        positive_before:Number(credit.remaining), negative_before:Number(debt.remaining),
        positive_after:Number(credit.remaining-amount), negative_after:Number(debt.remaining+amount) });
      credit.remaining-=amount; debt.remaining+=amount;
      if(credit.remaining===0n) p++;
      if(debt.remaining===0n) n++;
    }
  }
  return result;
}
