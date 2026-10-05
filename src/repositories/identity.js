import { randomUUID } from 'node:crypto';
import { transaction } from '../infra/db/database.js';

export class IdentityRepository {
  constructor(db, { participatesInTransaction = false } = {}) {
    this.db = db;
    this.participatesInTransaction = participatesInTransaction;
  }
  transaction(work) {
    if (this.participatesInTransaction) {
      if (!this.db.isTransaction) throw new Error('Missing enclosing transaction');
      return work();
    }
    return transaction(this.db, work);
  }
  owner() { return this.db.prepare("SELECT * FROM users WHERE role = 'OWNER'").get(); }
  byId(id) { return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id); }
  byTelegram(id) { return this.db.prepare('SELECT * FROM users WHERE telegram_user_id = ?').get(id); }
  byPublicId(id) { return this.db.prepare('SELECT * FROM users WHERE public_id = ? AND retired_at IS NULL').get(id); }
  allUsers() { return this.db.prepare('SELECT * FROM users WHERE retired_at IS NULL').all(); }
  databaseNow() { return this.db.prepare("SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now").get().now; }
  reservedName(name, excludingUserId) {
    return this.db.prepare(`SELECT 1 FROM access_grants WHERE normalized_name=? AND status IN ('PENDING','ACCEPTED')
      AND user_id<>? LIMIT 1`).get(name, excludingUserId ?? '');
  }
  aliasByNormalized(alias) { return this.db.prepare('SELECT * FROM user_aliases WHERE normalized_alias = ?').get(alias); }
  insertAlias(userId, alias, normalized, actorId) {
    this.db.prepare('INSERT INTO user_aliases(id,user_id,alias,normalized_alias,created_by_user_id,created_at) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), userId, alias, normalized, actorId, Date.now());
  }
  removeAlias(id) { this.db.prepare('DELETE FROM user_aliases WHERE id = ?').run(id); }
  insertUser(user) {
    this.db.prepare(`INSERT INTO users
      (id, telegram_user_id, public_id, canonical_name, role, status, bot_started, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'ACTIVE', 0, ?, ?)`).run(
      user.id, user.telegram_user_id, user.public_id, user.canonical_name, user.role, user.now, user.now,
    );
    return this.byId(user.id);
  }
  insertGrant(grant) {
    if (grant.fixedClock) {
      this.db.prepare(`INSERT INTO access_grants
        (id,user_id,token_hash,expires_at,created_by,created_at,status,reserved_public_id,reserved_name,normalized_name,reservation_enforced)
        VALUES (?,?,?,?,?,?,'PENDING',?,?,?,1)`).run(grant.id,grant.userId,grant.hash,grant.expiresAt,grant.actorId,grant.now,
        grant.publicId,grant.name,grant.normalizedName);
      return { created_at: grant.now, expires_at: grant.expiresAt };
    }
    return this.db.prepare(`WITH server_time AS (SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS created_at)
      INSERT INTO access_grants
      (id,user_id,token_hash,expires_at,created_by,created_at,status,reserved_public_id,reserved_name,normalized_name,reservation_enforced)
      SELECT ?,?,?,created_at+3600000,?,created_at,'PENDING',?,?,?,1 FROM server_time RETURNING created_at,expires_at`)
      .get(grant.id,grant.userId,grant.hash,grant.actorId,grant.publicId,grant.name,grant.normalizedName);
  }
  grantByHash(hash) { return this.db.prepare('SELECT * FROM access_grants WHERE token_hash = ?').get(hash); }
  expireUnusedGrants(userId, now) {
    return this.db.prepare("UPDATE access_grants SET revoked_at=?, status='EXPIRED' WHERE user_id=? AND status='PENDING'").run(now,userId).changes;
  }
  consumeGrant(id, now, fixedClock = false) {
    if (fixedClock) return this.db.prepare("UPDATE access_grants SET used_at=?,status='ACCEPTED' WHERE id=? AND status='PENDING' AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?")
      .run(now,id,now).changes === 1;
    return this.db.prepare("UPDATE access_grants SET used_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint, status='ACCEPTED' WHERE id = ? AND status='PENDING' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > (extract(epoch FROM clock_timestamp()) * 1000)::bigint")
      .run(id).changes === 1;
  }
  pendingExpiredInvitations(limit = 100) {
    return this.db.prepare("SELECT id,user_id,reserved_public_id,reserved_name,created_by,expires_at FROM access_grants WHERE status='PENDING' AND expires_at <= (extract(epoch FROM clock_timestamp()) * 1000)::bigint ORDER BY expires_at,id LIMIT ? FOR UPDATE SKIP LOCKED")
      .all(limit);
  }
  markInvitationExpired(id, now) {
    return this.db.prepare("UPDATE access_grants SET status='EXPIRED',revoked_at=? WHERE id=? AND status='PENDING' AND expires_at <= (extract(epoch FROM clock_timestamp()) * 1000)::bigint")
      .run(now,id).changes === 1;
  }
  retireInviteUser(id, now) {
    this.db.prepare('UPDATE users SET retired_at=? WHERE id=? AND bot_started=0 AND telegram_user_id IS NULL AND retired_at IS NULL').run(now,id);
  }
  linkUser(id, telegramId, now) {
    this.db.prepare('UPDATE users SET telegram_user_id = ?, bot_started = 1, updated_at = ? WHERE id = ?')
      .run(telegramId, now, id);
    return this.byId(id);
  }
  audit(event, actorId, targetId, traceId, metadata, now) {
    this.db.prepare(`INSERT INTO audit_events
      (id, event, actor_user_id, target_user_id, trace_id, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), event, actorId, targetId, traceId, JSON.stringify(metadata), now);
  }
}
