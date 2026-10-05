import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { requireCondition, DomainError } from '../errors.js';
import { normalizeIdentity } from '../identity.js';

const hashToken = token => createHash('sha256').update(token).digest('hex');
const publicIdPattern = /^[A-Z]{2}[1-9][0-9]{2}$/;
const randomPublicId = () => String.fromCharCode(65 + randomInt(26), 65 + randomInt(26)) + randomInt(100, 1000);

function telegramId(value) {
  const text = String(value);
  requireCondition(/^[1-9][0-9]*$/.test(text) && Number.isSafeInteger(Number(text)), 'INVALID_TELEGRAM_ID');
  return text;
}

function canonicalName(value) {
  requireCondition(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 200, 'INVALID_USER_NAME');
  return value.trim();
}

export class OnboardingService {
  constructor(repository, options = {}) {
    const { grantTtlSeconds = 3600, now = () => repository.databaseNow(), generatePublicId = randomPublicId } = options;
    requireCondition(grantTtlSeconds === 3600, 'INVALID_GRANT_TTL');
    this.repository = repository;
    this.grantTtlMs = 3600000;
    this.now = now;
    this.fixedClock = Object.hasOwn(options, 'now');
    this.generatePublicId = generatePublicId;
  }

  choosePublicId(requested) {
    if (requested !== undefined) {
      requireCondition(publicIdPattern.test(requested), 'INVALID_PUBLIC_ID');
      requireCondition(!this.repository.byPublicId(requested), 'PUBLIC_ID_CONFLICT');
      return requested;
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = this.generatePublicId();
      requireCondition(publicIdPattern.test(candidate), 'INVALID_PUBLIC_ID');
      if (!this.repository.byPublicId(candidate)) return candidate;
    }
    throw new DomainError('PUBLIC_ID_ALLOCATION_FAILED');
  }

  run(traceId, work) {
    requireCondition(typeof traceId === 'string' && /^DNG-[A-F0-9]{32}$/.test(traceId), 'INVALID_TRACE_ID');
    return this.repository.transaction(work);
  }

  // Local bootstrap only. Never expose this operation as a Telegram/AI command.
  bootstrapOwner({ ownerTelegramId, name, publicId, traceId }) {
    const id = telegramId(ownerTelegramId);
    const normalizedName = canonicalName(name);
    return this.run(traceId, () => {
      const existing = this.repository.owner();
      if (existing) {
        requireCondition(existing.telegram_user_id === id, 'OWNER_ALREADY_CONFIGURED');
        return existing;
      }
      requireCondition(!this.repository.byTelegram(id), 'TELEGRAM_ID_CONFLICT');
      const now = this.now();
      const owner = this.repository.insertUser({ id: randomUUID(), telegram_user_id: id,
        public_id: this.choosePublicId(publicId), canonical_name: normalizedName, role: 'OWNER', now });
      this.repository.audit('OWNER_BOOTSTRAPPED', owner.id, owner.id, traceId, { public_id: owner.public_id }, now);
      return owner;
    });
  }

  // actorTelegramId comes from Telegram's authenticated sender, never parsed text or AI.
  createUser({ actorTelegramId, inputMode, name, publicId, traceId }) {
    requireCondition(inputMode === 'DETERMINISTIC', 'ADMIN_DETERMINISTIC_ONLY');
    const actorId = telegramId(actorTelegramId);
    const normalizedName = canonicalName(name);
    return this.run(traceId, () => {
      const actor = this.repository.byTelegram(actorId);
      requireCondition(actor?.role === 'OWNER', 'PERMISSION_DENIED');
      requireCondition(actor.status === 'ACTIVE', actor.status === 'FROZEN' ? 'ACTOR_FROZEN' : 'PERMISSION_DENIED');
      requireCondition(actor.bot_started === 1, 'USER_NOT_STARTED');
      const now = this.now();
      const resolvedPublicId = this.choosePublicId(publicId);
      const normalizedNameKey = normalizeIdentity(normalizedName);
      const nameConflict = this.repository.allUsers().some(candidate => normalizeIdentity(candidate.canonical_name) === normalizedNameKey)
        || this.repository.reservedName(normalizedNameKey);
      requireCondition(!nameConflict, 'USER_NAME_CONFLICT');
      const user = this.repository.insertUser({ id: randomUUID(), telegram_user_id: null,
        public_id: resolvedPublicId, canonical_name: canonicalName(name), role: 'MEMBER', now });
      const token = randomBytes(32).toString('base64url');
      const grant = this.repository.insertGrant({ id: randomUUID(), userId: user.id, hash: hashToken(token),
        expiresAt: now + this.grantTtlMs, actorId: actor.id, now, fixedClock: this.fixedClock,
        publicId: user.public_id, name: user.canonical_name, normalizedName: normalizedNameKey });
      const expiresAt = grant.expires_at;
      this.repository.audit('USER_CREATED', actor.id, user.id, traceId, { public_id: user.public_id, canonical_name: user.canonical_name }, now);
      // Plaintext exists only in the returned delivery result, never DB/Audit/logs.
      return { user, token, expiresAt };
    });
  }

  startOwner({ senderTelegramId, chatType, traceId }) {
    requireCondition(chatType === 'private', 'ONBOARDING_PRIVATE_ONLY');
    const senderId = telegramId(senderTelegramId);
    return this.run(traceId, () => {
      const owner = this.repository.owner();
      requireCondition(owner?.telegram_user_id === senderId, 'PERMISSION_DENIED');
      requireCondition(owner.status === 'ACTIVE', 'PERMISSION_DENIED');
      if (owner.bot_started) return owner;
      const now = this.now();
      const linked = this.repository.linkUser(owner.id, senderId, now);
      this.repository.audit('USER_LINKED', owner.id, owner.id, traceId, { bot_started: true }, now);
      return linked;
    });
  }

  reissueGrant({actorTelegramId,inputMode,publicId,traceId}) {
    requireCondition(inputMode==='DETERMINISTIC','ADMIN_DETERMINISTIC_ONLY');
    const id=telegramId(actorTelegramId);
    return this.run(traceId,()=>{
      const actor=this.repository.byTelegram(id);
      requireCondition(actor?.role==='OWNER'&&actor.status==='ACTIVE','PERMISSION_DENIED');
      requireCondition(actor.bot_started===1,'USER_NOT_STARTED');
      const user=this.repository.byPublicId(publicId);
      requireCondition(user,'UNKNOWN_USER');
      requireCondition(user.telegram_user_id===null&&!user.bot_started,'USER_ALREADY_LINKED');
      requireCondition(user.status!=='SUSPENDED','TARGET_SUSPENDED');
      const now=this.now();
      const invalidated=this.repository.expireUnusedGrants(user.id,now);
      const token=randomBytes(32).toString('base64url');
      const grant=this.repository.insertGrant({id:randomUUID(),userId:user.id,hash:hashToken(token),expiresAt:now+this.grantTtlMs,actorId:actor.id,now,
        fixedClock:this.fixedClock,publicId:user.public_id,name:user.canonical_name,normalizedName:normalizeIdentity(user.canonical_name)});
      const expiresAt=grant.expires_at;
      this.repository.audit('INVITATION_REISSUED',actor.id,user.id,traceId,{public_id:user.public_id,invalidated},now);
      return {user,token,expiresAt};
    });
  }

  redeemGrant({ senderTelegramId, chatType, token, traceId }) {
    requireCondition(chatType === 'private', 'ONBOARDING_PRIVATE_ONLY');
    const senderId = telegramId(senderTelegramId);
    requireCondition(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token), 'ONBOARDING_TOKEN_INVALID');
    return this.run(traceId, () => {
      const now = this.now();
      const grant = this.repository.grantByHash(hashToken(token));
      requireCondition(grant && grant.status === 'PENDING' && grant.used_at === null && grant.revoked_at === null && grant.expires_at > now, 'ONBOARDING_TOKEN_INVALID');
      const user = this.repository.byId(grant.user_id);
      requireCondition(user.status !== 'SUSPENDED', 'TARGET_SUSPENDED');
      requireCondition(user.telegram_user_id === null && !this.repository.byTelegram(senderId), 'TELEGRAM_ID_CONFLICT');
      requireCondition(this.repository.consumeGrant(grant.id, now, this.fixedClock), 'ONBOARDING_TOKEN_INVALID');
      const linked = this.repository.linkUser(user.id, senderId, now);
      this.repository.audit('USER_LINKED', user.id, user.id, traceId, { bot_started: true, grant_id: grant.id }, now);
      const owner = this.repository.owner();
      return Object.assign(linked, { invitationAcceptance: {
        id: grant.id, ownerTelegramId: owner.telegram_user_id,
        name: grant.reserved_name, publicId: grant.reserved_public_id,
      } });
    });
  }
}
