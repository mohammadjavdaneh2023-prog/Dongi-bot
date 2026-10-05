import { transaction } from './db/database.js';
import { enqueueSystemNotification } from './outbox.js';
import { IdentityRepository } from '../repositories/identity.js';
import { newTraceId } from './logging.js';

export function expirePendingInvitations({ db, cipher, log = () => {}, limit = 100 }) {
  return transaction(db, () => {
    const repository = new IdentityRepository(db, { participatesInTransaction: true });
    const expired = repository.pendingExpiredInvitations(limit);
    for (const invitation of expired) {
      if (!repository.markInvitationExpired(invitation.id, repository.databaseNow())) continue;
      const now = repository.databaseNow();
      repository.retireInviteUser(invitation.user_id, now);
      repository.audit('INVITATION_EXPIRED', invitation.created_by, invitation.user_id, newTraceId(), {
        public_id: invitation.reserved_public_id, name: invitation.reserved_name,
      }, now);
      const owner = repository.owner();
      if (owner?.telegram_user_id) enqueueSystemNotification(db, cipher, {
        key: `invitation:${invitation.id}:expired`, chatId: owner.telegram_user_id,
        event: 'INVITATION_EXPIRED', text: `⌛ دعوت ${invitation.reserved_name} با شناسه DONGI ${invitation.reserved_public_id} پس از یک ساعت منقضی شد. نام و شناسه دوباره آزاد هستند.`,
      });
      log('INVITATION_EXPIRED', newTraceId(), { stage: 'INVITATION', result: 'COMMITTED' });
    }
    return expired.length;
  });
}

export function startInvitationExpiryWorker({ db, cipher, log = () => {}, signal, intervalMs = 15000 }) {
  let running = false;
  let stopped = false;
  const run = () => {
    if (running || stopped) return;
    running = true;
    try {
      expirePendingInvitations({ db, cipher, log });
    } catch {
      try { log('INVITATION_EXPIRY_FAILED', newTraceId(), { stage: 'INVITATION', error_type: 'STORAGE_OR_OUTBOX_FAILURE' }, 'ERROR'); } catch { /* Preserve worker availability. */ }
    } finally {
      running = false;
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    signal?.removeEventListener('abort', stop);
  };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  return stop;
}
