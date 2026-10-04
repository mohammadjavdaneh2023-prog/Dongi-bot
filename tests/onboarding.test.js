import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/infra/db/database.js';
import { IdentityRepository } from '../src/repositories/identity.js';
import { OnboardingService } from '../src/domain/users/onboarding.js';
import { newTraceId } from '../src/infra/logging.js';

function fixture(t, options = {}) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const repository = new IdentityRepository(db);
  let now = 1700000000000;
  const service = new OnboardingService(repository, { now: () => now, ...options });
  const traceId = newTraceId();
  const owner = service.bootstrapOwner({ ownerTelegramId: '123', name: 'رئیس', publicId: 'AB417', traceId });
  service.startOwner({ senderTelegramId: '123', chatType: 'private', traceId });
  return { db, repository, service, traceId, owner, advance: ms => { now += ms; },
    create: (extra = {}) => service.createUser({ actorTelegramId: '123', inputMode: 'DETERMINISTIC', name: 'علی', traceId, ...extra }),
    redeem: (token, extra = {}) => service.redeemGrant({ senderTelegramId: '456', chatType: 'private', token, traceId, ...extra }),
  };
}

test('reissue preserves profile, invalidates every unused invitation and only new token links',t=>{
 const f=fixture(t);const first=f.create({publicId:'CD456'});
 const args={actorTelegramId:'123',inputMode:'DETERMINISTIC',publicId:'CD456',traceId:f.traceId};
 const second=f.service.reissueGrant(args);const third=f.service.reissueGrant(args);
 assert.equal(third.user.id,first.user.id);
 assert.equal(f.repository.allUsers().length,2);
 for(const token of [first.token,second.token])assert.throws(()=>f.redeem(token),{code:'ONBOARDING_TOKEN_INVALID'});
 assert.equal(f.redeem(third.token).id,first.user.id);
 assert.throws(()=>f.service.reissueGrant(args),{code:'USER_ALREADY_LINKED'});
});
test('reissue rejects nonowner/AI and rolls back invalidation when audit fails',t=>{
 const f=fixture(t);const first=f.create({publicId:'CD456'});
 const args={actorTelegramId:'123',inputMode:'DETERMINISTIC',publicId:'CD456',traceId:f.traceId};
 assert.throws(()=>f.service.reissueGrant({...args,actorTelegramId:'456'}),{code:'PERMISSION_DENIED'});
 assert.throws(()=>f.service.reissueGrant({...args,inputMode:'AI_CONFIRMED'}),{code:'ADMIN_DETERMINISTIC_ONLY'});
 f.db.exec("CREATE TRIGGER reject_reissue BEFORE INSERT ON audit_events WHEN NEW.event='INVITATION_REISSUED' BEGIN SELECT RAISE(ABORT,'test'); END");
 assert.throws(()=>f.service.reissueGrant(args),{code:'DB_TRANSACTION_FAILED'});
 assert.equal(f.redeem(first.token).id,first.user.id);
});
test('owner bootstrap is reserved, idempotent and cannot change owner', t => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const service = new OnboardingService(new IdentityRepository(db));
  const traceId = newTraceId();
  const args = { ownerTelegramId: '123', name: 'Owner', publicId: 'AB417', traceId };
  const first = service.bootstrapOwner(args);
  assert.equal(first.bot_started, 0);
  assert.equal(service.bootstrapOwner(args).id, first.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit_events').get().n, 1);
  assert.throws(() => service.bootstrapOwner({ ...args, ownerTelegramId: '999' }), { code: 'OWNER_ALREADY_CONFIGURED' });
  assert.throws(() => service.createUser({ actorTelegramId: '123', inputMode: 'DETERMINISTIC', name: 'Ali', traceId }), { code: 'USER_NOT_STARTED' });
  assert.throws(() => service.startOwner({ senderTelegramId: '999', chatType: 'private', traceId }), { code: 'PERMISSION_DENIED' });
});
test('grant is hashed, single use, and links exactly one Telegram account', t => {
  const f = fixture(t);
  const result = f.create({ publicId: 'CD123' });
  assert.equal(result.user.telegram_user_id, null);
  assert.equal(result.user.bot_started, 0);
  const grants = f.db.prepare('SELECT * FROM access_grants').all();
  assert.match(grants[0].token_hash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(grants).includes(result.token));
  const linked = f.redeem(result.token);
  assert.equal(linked.id, result.user.id);
  assert.equal(linked.telegram_user_id, '456');
  assert.equal(linked.bot_started, 1);
  for (const senderTelegramId of ['456', '789']) {
    assert.throws(() => f.redeem(result.token, { senderTelegramId }), { code: 'ONBOARDING_TOKEN_INVALID' });
  }
  const audit = f.db.prepare('SELECT * FROM audit_events WHERE target_user_id = ?').all(linked.id);
  assert.deepEqual(audit.map(row => row.event), ['USER_CREATED', 'USER_LINKED']);
  assert.ok(audit.every(row => row.trace_id === f.traceId));
  assert.ok(!JSON.stringify(audit).includes(result.token));
});
test('expiry boundary, invalid token and public chat cannot consume a grant', t => {
  const f = fixture(t, { grantTtlSeconds: 60 });
  const { token } = f.create();
  assert.throws(() => f.redeem(token, { chatType: 'group' }), { code: 'ONBOARDING_PRIVATE_ONLY' });
  assert.throws(() => f.redeem('bad'), { code: 'ONBOARDING_TOKEN_INVALID' });
  f.advance(60000);
  assert.throws(() => f.redeem(token), { code: 'ONBOARDING_TOKEN_INVALID' });
  assert.equal(f.db.prepare('SELECT used_at FROM access_grants').get().used_at, null);
});
test('only an active started Owner can create users, never through AI', t => {
  const f = fixture(t);
  for (const inputMode of ['AI_CONFIRMED', undefined]) {
    assert.throws(() => f.create({ inputMode }), { code: 'ADMIN_DETERMINISTIC_ONLY' });
  }
  assert.throws(() => f.create({ actorTelegramId: '999' }), { code: 'PERMISSION_DENIED' });
  const member = f.create(); f.redeem(member.token);
  assert.throws(() => f.create({ actorTelegramId: '456' }), { code: 'PERMISSION_DENIED' });
  f.db.prepare("UPDATE users SET status = 'FROZEN' WHERE id = ?").run(f.owner.id);
  assert.throws(() => f.create(), { code: 'ACTOR_FROZEN' });
});

test('public IDs validate, remain immutable, and generated collisions retry', t => {
  let attempts = 0;
  const f = fixture(t, { generatePublicId: () => ++attempts === 1 ? 'AB417' : 'CD123' });
  assert.equal(f.create().user.public_id, 'CD123');
  assert.equal(attempts, 2);
  for (const publicId of ['ab417', 'ABC123', 'AB099', 'AB1000', 'AB۴۱۷']) {
    assert.throws(() => f.create({ publicId }), { code: 'INVALID_PUBLIC_ID' });
  }
  assert.throws(() => f.create({ publicId: 'CD123' }), { code: 'PUBLIC_ID_CONFLICT' });
  assert.throws(() => f.db.prepare('UPDATE users SET public_id = ? WHERE id = ?').run('ZZ999', f.owner.id));
});

test('Telegram identity conflicts and suspended profiles leave tokens unused', t => {
  const f = fixture(t);
  const first = f.create(); f.redeem(first.token);
  const second = f.create();
  assert.throws(() => f.redeem(second.token), { code: 'TELEGRAM_ID_CONFLICT' });
  f.db.prepare("UPDATE users SET status = 'SUSPENDED' WHERE id = ?").run(second.user.id);
  assert.throws(() => f.redeem(second.token, { senderTelegramId: '789' }), { code: 'TARGET_SUSPENDED' });
  assert.equal(f.db.prepare('SELECT used_at FROM access_grants WHERE user_id = ?').get(second.user.id).used_at, null);
});

test('audit failure rolls back new profile and its grant', t => {
  const f = fixture(t);
  f.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.throws(() => f.create(), { code: 'DB_TRANSACTION_FAILED' });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM access_grants').get().n, 0);
});

test('failed audit rolls back token consumption and link; retry succeeds', t => {
  const f = fixture(t);
  const { token, user } = f.create();
  f.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.throws(() => f.redeem(token), { code: 'DB_TRANSACTION_FAILED' });
  assert.equal(f.repository.byId(user.id).telegram_user_id, null);
  assert.equal(f.db.prepare('SELECT used_at FROM access_grants').get().used_at, null);
  f.db.exec('DROP TRIGGER fail_audit');
  assert.equal(f.redeem(token).bot_started, 1);
});

test('audit is append-only and foreign keys enforce references', t => {
  const f = fixture(t);
  assert.throws(() => f.db.exec('DELETE FROM audit_events'));
  assert.throws(() => f.db.exec("UPDATE audit_events SET event = 'FAKE'"));
  assert.throws(() => f.repository.audit('TEST', 'missing', f.owner.id, f.traceId, {}, 1));
});

test('PostgreSQL migrations are safe to run repeatedly', () => {
  let db = openDatabase(process.env.TEST_DATABASE_URL);
  try { assert.equal(db.prepare('SELECT count(*)::integer AS n FROM schema_migrations').get().n, 1); }
  finally { db.close(); }
  db = openDatabase(process.env.TEST_DATABASE_URL);
  try { assert.equal(db.prepare('SELECT count(*)::integer AS n FROM schema_migrations').get().n, 1); }
  finally { db.close(); }
});
