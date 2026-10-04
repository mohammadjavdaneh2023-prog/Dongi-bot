import { allocate } from './allocation.js';
import { resolveIdentity } from './identity.js';
import { requireCondition } from './errors.js';

// Pure domain builder: currentMemberIds must be verified by the Telegram adapter.
export function buildInvoice(intent, { users, actorId, currentMemberIds, groupFrozenIds = new Set() }) {
  requireCondition(intent?.intent === 'CREATE_INVOICE', 'PARSE_FAILED');
  const actor = users.find(user => user.id === actorId);
  requireCondition(actor, 'PERMISSION_DENIED');
  requireCondition(actor.status !== 'FROZEN' && !groupFrozenIds.has(actor.id), 'ACTOR_FROZEN');
  requireCondition(actor.status === 'ACTIVE', 'PERMISSION_DENIED');
  requireCondition(actor.bot_started === 1 || actor.bot_started === true, 'USER_NOT_STARTED');
  requireCondition(currentMemberIds.has(actor.id), 'USER_NOT_IN_GROUP');
  const eligible = user => user.public_id && user.telegram_user_id && user.bot_started && user.status !== 'SUSPENDED' && currentMemberIds.has(user.id);
  function resolve(token) {
    const result = token.toLowerCase() === 'me' ? { user: actor, addressed_as: token } : resolveIdentity(token, users);
    const details = { addressed_as: token, public_id: result.user.public_id };
    requireCondition(result.user.status !== 'SUSPENDED', 'TARGET_SUSPENDED', details);
    requireCondition(result.user.bot_started && result.user.telegram_user_id, 'USER_NOT_STARTED', details);
    requireCondition(currentMemberIds.has(result.user.id), 'USER_NOT_IN_GROUP', details);
    requireCondition(result.user.public_id, 'UNKNOWN_USER');
    return result;
  }
  const rows = new Map();
  function add(resolved, amount) {
    const id = resolved.user.id;
    if (!rows.has(id)) rows.set(id, { user_id: id, public_id: resolved.user.public_id,
      canonical_name: resolved.user.canonical_name, addressed_as: resolved.addressed_as,
      input_names: [], amount: 0n, position: rows.size });
    const row = rows.get(id);
    row.input_names.push(resolved.addressed_as);
    row.amount += BigInt(amount);
  }
  function side(spec, sign) {
    let members;
    if (spec.all) {
      const excluded = new Set(spec.exclusions.map(token => resolve(token).user.id));
      members = users.filter(eligible).filter(user => !excluded.has(user.id))
        .sort((a, b) => a.public_id < b.public_id ? -1 : a.public_id > b.public_id ? 1 : 0)
        .map(user => ({ token: user.public_id, value: '1' }));
    } else members = spec.members;
    const resolved = members.map(member => resolve(member.token));
    requireCondition(new Set(resolved.map(item => item.user.id)).size === resolved.length, 'DUPLICATE_PARTICIPANT');
    const amounts = allocate(intent.amount, spec.mode, members.map(member => member.value));
    for (let i = 0; i < resolved.length; i++) add(resolved[i], sign * amounts[i]);
  }
  if (intent.entries) {
    const seen = new Set();
    for (const entry of intent.entries) {
      requireCondition(Number.isSafeInteger(entry.amount), 'INVALID_AMOUNT');
      const resolved = resolve(entry.token);
      requireCondition(!seen.has(resolved.user.id), 'DUPLICATE_PARTICIPANT');
      seen.add(resolved.user.id);
      add(resolved, entry.amount);
    }
  } else {
    side(intent.positive, 1);
    side(intent.negative, -1);
  }
  requireCondition(rows.size > 0, 'PARSE_FAILED');
  const sum = [...rows.values()].reduce((total, row) => total + row.amount, 0n);
  requireCondition(sum === 0n, 'ZERO_SUM_FAILED', { difference: String(sum) });
  const gross = [...rows.values()].reduce((total, row) => total + (row.amount > 0n ? row.amount : 0n), 0n);
  requireCondition(gross <= BigInt(Number.MAX_SAFE_INTEGER), 'INVALID_AMOUNT');
  const entries = [...rows.values()].map(row => {
    requireCondition(row.amount >= -BigInt(Number.MAX_SAFE_INTEGER) && row.amount <= BigInt(Number.MAX_SAFE_INTEGER), 'INVALID_AMOUNT');
    return { ...row, amount: Number(row.amount), open_amount: Number(row.amount) };
  });
  return { title: intent.title, type: 'EXPENSE', currency: 'TOMAN', gross_amount: Number(gross), entries };
}
