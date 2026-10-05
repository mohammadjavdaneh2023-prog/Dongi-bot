import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { openDatabase } from '../src/infra/db/database.js';
import { IdentityRepository } from '../src/repositories/identity.js';
import { OnboardingService } from '../src/domain/users/onboarding.js';
import { newTraceId } from '../src/infra/logging.js';
import { expirePendingInvitations } from '../src/infra/invitation-expiry.js';
import { createPayloadCipher, deliverOutbox, recoverStaleSystemDeliveries } from '../src/infra/outbox.js';
import { startInvitationExpiryWorker } from '../src/infra/invitation-expiry.js';
import { loadConfig } from '../src/infra/config.js';

function fixture(t, options = {}) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const repository = new IdentityRepository(db);
  let now = 1700000000000;
  const service = new OnboardingService(repository, { now: () => now, ...options });
  const traceId = newTraceId();
  const owner = service.bootstrapOwner({ ownerTelegramId: '123', name: 'رئیس', publicId: 'AB417', traceId });
  service.startOwner({ senderTelegramId: '123', chatType: 'private', traceId });
  return { db, repository, service, traceId, owner, current: () => now, advance: ms => { now += ms; },
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
  const f = fixture(t);
  const { token } = f.create();
  assert.throws(() => f.redeem(token, { chatType: 'group' }), { code: 'ONBOARDING_PRIVATE_ONLY' });
  assert.throws(() => f.redeem('bad'), { code: 'ONBOARDING_TOKEN_INVALID' });
  f.advance(3600000);
  assert.throws(() => f.redeem(token), { code: 'ONBOARDING_TOKEN_INVALID' });
  assert.equal(f.db.prepare('SELECT used_at FROM access_grants').get().used_at, null);
  f.advance(1);
  assert.throws(() => f.redeem(token), { code: 'ONBOARDING_TOKEN_INVALID' });
});

test('grant TTL is fixed at 3600 seconds and accepts only immediately before expiry', t => {
  const f=fixture(t);const {token}=f.create({publicId:'CD123'});
  const grant=f.db.prepare('SELECT created_at,expires_at,status FROM access_grants').get();
  assert.equal(grant.expires_at-grant.created_at,3600000);
  assert.equal(grant.status,'PENDING');
  assert.equal(loadConfig({DATABASE_URL:'postgresql://local/db'},{requireRuntimeSecrets:false}).grantTtlSeconds,3600);
  assert.throws(()=>loadConfig({DATABASE_URL:'postgresql://local/db',DONGI_GRANT_TTL_SECONDS:'86400'},{requireRuntimeSecrets:false}),/DONGI_GRANT_TTL_SECONDS/);
  f.advance(3599999);
  const accepted=f.redeem(token);
  assert.equal(accepted.bot_started,1);
  assert.equal(f.db.prepare('SELECT status FROM access_grants').get().status,'ACCEPTED');
  assert.throws(()=>f.create({publicId:'CD123',name:'دوست دیگر'}),{code:'PUBLIC_ID_CONFLICT'});
  assert.throws(()=>f.create({publicId:'EF456',name:'علی'}),{code:'USER_NAME_CONFLICT'});
  assert.throws(()=>new OnboardingService(f.repository,{grantTtlSeconds:3599}),{code:'INVALID_GRANT_TTL'});
});

test('a pending invitation reserves its name and ID; expiry releases only the temporary profile',t=>{
 const f=fixture(t);const first=f.create({publicId:'CD123'});
 assert.throws(()=>f.create({publicId:'CD123',name:'دیگر'}),{code:'PUBLIC_ID_CONFLICT'});
 assert.throws(()=>f.create({publicId:'EF456',name:'علی'}),{code:'USER_NAME_CONFLICT'});
 const cipher=createPayloadCipher('ab'.repeat(32));
 const dbNow=f.repository.databaseNow();
 f.db.prepare('UPDATE access_grants SET expires_at=? WHERE id=?').run(dbNow-1,f.db.prepare('SELECT id FROM access_grants').get().id);
 assert.equal(expirePendingInvitations({db:f.db,cipher}),1);
 const retired=f.db.prepare('SELECT public_id,retired_at FROM users WHERE id=?').get(first.user.id);
 assert.equal(retired.public_id,'CD123');assert.ok(retired.retired_at);
 assert.equal(f.repository.byPublicId('CD123'),undefined);
 const replacement=f.create({publicId:'CD123',name:'علی'});
 assert.equal(replacement.user.public_id,'CD123');
 assert.equal(f.db.prepare("SELECT status FROM access_grants WHERE user_id=?").get(replacement.user.id).status,'PENDING');
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM response_outbox WHERE idempotency_key LIKE 'invitation:%:expired'").get().n,1);
});

test('expiration notification is queued once and transient Telegram failure can retry from outbox',async t=>{
 const f=fixture(t);f.create({publicId:'CD123'});
 f.db.prepare('UPDATE access_grants SET expires_at=?').run(f.repository.databaseNow()-1);
 const cipher=createPayloadCipher('ab'.repeat(32));
 assert.equal(expirePendingInvitations({db:f.db,cipher}),1);
 assert.equal(expirePendingInvitations({db:f.db,cipher}),0);
 const queued=f.db.prepare("SELECT id,idempotency_key,delivery_status FROM response_outbox WHERE idempotency_key IS NOT NULL").get();
 assert.equal(queued.idempotency_key,`invitation:${f.db.prepare('SELECT id FROM access_grants').get().id}:expired`);
 await deliverOutbox({db:f.db,cipher,log:()=>{},now:()=>Date.now()+60000,telegram:{call:async()=>{throw Object.assign(new Error('temporary'),{code:'NETWORK'});}}});
 assert.equal(f.db.prepare('SELECT delivery_status FROM response_outbox WHERE id=?').get(queued.id).delivery_status,'PENDING');
 f.db.prepare("UPDATE response_outbox SET delivery_status='SENDING',sending_started_at=? WHERE id=?").run(f.repository.databaseNow()-120001,queued.id);
 recoverStaleSystemDeliveries(f.db);
 assert.equal(f.db.prepare('SELECT delivery_status FROM response_outbox WHERE id=?').get(queued.id).delivery_status,'PENDING');
 const sent=[];
 await deliverOutbox({db:f.db,cipher,log:()=>{},now:()=>Date.now()+120000,telegram:{call:async(_method,payload)=>{sent.push(payload);return {message_id:1};}}});
 assert.equal(sent.length,1);assert.match(sent[0].text,/دعوت علی با شناسه DONGI CD123/);
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM response_outbox WHERE idempotency_key=?").get(queued.idempotency_key).n,1);
});

test('expiry worker processes persisted rows immediately and removes its timer and shutdown listener',async t=>{
 const f=fixture(t);f.create({publicId:'CD123'});
 f.db.prepare('UPDATE access_grants SET expires_at=?').run(f.repository.databaseNow()-1);
 const controller=new AbortController();const cipher=createPayloadCipher('ab'.repeat(32));
 startInvitationExpiryWorker({db:f.db,cipher,signal:controller.signal,intervalMs:5});
 assert.equal(f.db.prepare("SELECT status FROM access_grants").get().status,'EXPIRED');
 assert.equal(getEventListeners(controller.signal,'abort').length,1);
 controller.abort();
 assert.equal(getEventListeners(controller.signal,'abort').length,0);
 await new Promise(resolve=>setTimeout(resolve,15));
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event='INVITATION_EXPIRED'").get().n,1);
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
  const second = f.create({ name: 'سارا' });
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
  try { assert.equal(db.prepare('SELECT count(*)::integer AS n FROM schema_migrations').get().n, 2); }
  finally { db.close(); }
  db = openDatabase(process.env.TEST_DATABASE_URL);
  try { assert.equal(db.prepare('SELECT count(*)::integer AS n FROM schema_migrations').get().n, 2); }
  finally { db.close(); }
});
