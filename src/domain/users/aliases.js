import { requireCondition } from '../errors.js';
import { normalizeIdentity } from '../identity.js';

export function changeAlias(repository, { actorTelegramId, inputMode, publicId, action, alias, traceId, groupAccess }) {
  requireCondition(inputMode === 'DETERMINISTIC', 'ADMIN_DETERMINISTIC_ONLY');
  requireCondition(['add', 'remove'].includes(action), 'PARSE_FAILED');
  requireCondition(typeof alias === 'string' && alias.trim().length > 0 && alias.length <= 200 && !/[\r\n]/.test(alias), 'INVALID_ALIAS');
  const normalized = normalizeIdentity(alias);
  requireCondition(normalized && !['me','all'].includes(normalized), 'INVALID_ALIAS');
  requireCondition(/^DNG-[A-F0-9]{32}$/.test(traceId ?? ''), 'INVALID_TRACE_ID');
  return repository.transaction(() => {
    const actor = repository.byTelegram(String(actorTelegramId));
    requireCondition(actor && (actor.role === 'OWNER' || (groupAccess?.currentMemberIds?.has(actor.id)
      && Date.now()-groupAccess.verifiedAt<=60000
      && repository.db.prepare('SELECT 1 FROM group_roles WHERE telegram_chat_id=? AND user_id=?').get(groupAccess.chatId,actor.id))), 'PERMISSION_DENIED');
    requireCondition(actor.status !== 'FROZEN', 'ACTOR_FROZEN');
    requireCondition(actor.status === 'ACTIVE', 'PERMISSION_DENIED');
    requireCondition(actor.bot_started === 1, 'USER_NOT_STARTED');
    const user = repository.byPublicId(publicId);
    requireCondition(user, 'UNKNOWN_USER', { addressed_as: publicId });
    if(actor.role!=='OWNER') {
      requireCondition(groupAccess.currentMemberIds.has(user.id),'USER_NOT_IN_GROUP');
      requireCondition(user.role!=='OWNER','OWNER_PROTECTED');
      requireCondition(!repository.db.prepare('SELECT 1 FROM group_restrictions WHERE telegram_chat_id=? AND user_id=? AND frozen=1').get(groupAccess.chatId,actor.id),'ACTOR_FROZEN');
    }
    const existing = repository.aliasByNormalized(normalized);
    if (action === 'add') {
      requireCondition(!existing, 'ALIAS_CONFLICT', { addressed_as: alias });
      const conflict = repository.allUsers().some(candidate =>
        normalizeIdentity(candidate.public_id) === normalized || (candidate.id !== user.id && normalizeIdentity(candidate.canonical_name) === normalized));
      requireCondition(!conflict, 'ALIAS_CONFLICT', { addressed_as: alias });
      repository.insertAlias(user.id, alias.trim(), normalized, actor.id);
    } else {
      requireCondition(existing?.user_id === user.id, 'ALIAS_NOT_FOUND', { addressed_as: alias });
      repository.removeAlias(existing.id);
    }
    const event = action === 'add' ? 'ALIAS_ADDED' : 'ALIAS_REMOVED';
    const savedAlias = action === 'add' ? alias.trim() : existing.alias;
    repository.audit(event, actor.id, user.id, traceId, { alias: savedAlias, normalized_alias: normalized,
      before: action === 'remove' ? savedAlias : null, after: action === 'add' ? savedAlias : null }, Date.now());
    return { event, user, alias: savedAlias };
  });
}
