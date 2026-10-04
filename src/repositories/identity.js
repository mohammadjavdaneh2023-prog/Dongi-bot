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
  byPublicId(id) { return this.db.prepare('SELECT * FROM users WHERE public_id = ?').get(id); }
  allUsers() { return this.db.prepare('SELECT * FROM users').all(); }
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
    this.db.prepare(`INSERT INTO access_grants
      (id, user_id, token_hash, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(grant.id, grant.userId, grant.hash, grant.expiresAt, grant.actorId, grant.now);
  }
  grantByHash(hash) { return this.db.prepare('SELECT * FROM access_grants WHERE token_hash = ?').get(hash); }
  expireUnusedGrants(userId, now) {
    return this.db.prepare('UPDATE access_grants SET revoked_at=? WHERE user_id=? AND used_at IS NULL AND revoked_at IS NULL').run(now,userId).changes;
  }
  consumeGrant(id, now) {
    return this.db.prepare('UPDATE access_grants SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?')
      .run(now, id, now).changes === 1;
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
