import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/infra/db/database.js';
import { IdentityRepository } from '../src/repositories/identity.js';
import { OnboardingService } from '../src/domain/users/onboarding.js';
import { newTraceId } from '../src/infra/logging.js';
import { createPayloadCipher, deliverOutbox } from '../src/infra/outbox.js';
import { seedResponses, renderResponse, validTemplate } from '../src/bot/responses.js';
import { createRouter } from '../src/bot/router.js';
import { pollOnce } from '../src/bot/poller.js';
import { createTelegramClient } from '../src/infra/telegram.js';
import { syncMembership } from '../src/infra/membership.js';

function fixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  seedResponses(db);
  const cipher = createPayloadCipher('ab'.repeat(32));
  const bot = { id: 9999, username: 'DongiTestBot' };
  const logs = [];
  const log = (...args) => logs.push(args);
  const service = new OnboardingService(new IdentityRepository(db));
  service.bootstrapOwner({ ownerTelegramId: '123', name: 'Owner', traceId: newTraceId() });
  const config = { grantTtlSeconds: 3600 };
  const router = createRouter({ db, cipher, bot, config, log });
  let sequence = 0;
  const update = (text, extra = {}) => ({ update_id: ++sequence, message: {
    message_id: sequence, text, date: 1700000000, from: { id: 123, is_bot: false }, chat: { id: 123, type: 'private' }, ...extra,
  } });
  const pending = () => db.prepare('SELECT * FROM response_outbox WHERE sent_at IS NULL ORDER BY id').all().map(row => cipher.decrypt(row.encrypted_payload));
  return { db, cipher, bot, log, logs, router, update, pending };
}

test('private Start, owner creation in group and invitation redemption work end to end', t => {
  const f = fixture(t);
  assert.equal(f.router(f.update('/start')).event, 'PROFILE');
  assert.equal(f.router(f.update('#DONGI user create "علی" CD123', { chat: { id: -100, type: 'supergroup' } })).event, 'USER_CREATED');
  const payloads = f.pending();
  const invitation = payloads.find(item => item.text.includes('?start='));
  assert.equal(invitation.chat_id, '123');
  assert.ok(!payloads.find(item => item.chat_id === '-100').text.includes('?start='));
  const token = invitation.text.match(/\?start=([A-Za-z0-9_-]+)/)[1];
  assert.equal(f.router(f.update(`/start ${token}`, { from: { id: 456 }, chat: { id: 456, type: 'private' } })).event, 'PROFILE');
  assert.equal(f.db.prepare("SELECT bot_started FROM users WHERE public_id = 'CD123'").get().bot_started, 1);
  const ownerNotice=f.db.prepare("SELECT encrypted_payload FROM response_outbox WHERE idempotency_key LIKE 'invitation:%:accepted'").get();
  assert.match(f.cipher.decrypt(ownerNotice.encrypted_payload).text,/کاربر علی با شناسه DONGI CD123 دعوت را پذیرفت/);
  assert.ok(!f.cipher.decrypt(ownerNotice.encrypted_payload).text.includes(token));
  f.router(f.update(`/start ${token}`, { from: { id: 456 }, chat: { id: 456, type: 'private' } }));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM response_outbox WHERE idempotency_key LIKE 'invitation:%:accepted'").get().n,1);
  assert.ok(!JSON.stringify(f.logs).includes(token));
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM response_outbox').all()).includes(token));
});

test('duplicate updates and duplicate messages do not create a second profile', t => {
  const f = fixture(t); f.router(f.update('/start'));
  const update = f.update('#DONGI user create "علی"');
  assert.equal(f.router(update).event, 'USER_CREATED');
  assert.equal(f.router(update).event, 'DUPLICATE_REQUEST');
  assert.equal(f.router({ ...update, update_id: 100 }).event, 'DUPLICATE_REQUEST');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get().n, 2);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event = 'USER_CREATED'").get().n, 1);
});

test('reissued invitation is delivered only to Owner and duplicate update never reissues twice',t=>{
 const f=fixture(t);f.router(f.update('/start'));f.router(f.update('#DONGI user create "Ali" CD123'));
 const update=f.update('#DONGI user invite CD123',{chat:{id:-100,type:'group'}});
 assert.equal(f.router(update).event,'INVITATION_REISSUED');
 assert.equal(f.router(update).event,'DUPLICATE_REQUEST');
 const payloads=f.db.prepare('SELECT encrypted_payload FROM response_outbox WHERE update_id=?').all(update.update_id).map(r=>f.cipher.decrypt(r.encrypted_payload));
 assert.ok(payloads.find(p=>p.chat_id==='123').text.includes('?start='));
 assert.ok(payloads.filter(p=>p.chat_id==='-100').every(p=>!p.text.includes('?start=')));
 assert.equal(f.db.prepare('SELECT count(*) n FROM access_grants').get().n,2);
});

test('outbox failure rolls back domain writes and produces a fallback response', t => {
  const f = fixture(t); f.router(f.update('/start'));
  f.db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON response_outbox BEGIN SELECT RAISE(ABORT, 'fail'); END");
  const result = f.router(f.update('#DONGI user create "علی"'));
  assert.equal(result.event, 'DB_TRANSACTION_FAILED');
  assert.ok(result.fallback.text.includes(result.traceId));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM access_grants').get().n, 0);
});

test('ordinary group messages are dropped without content logging or storage', t => {
  const f = fixture(t);
  assert.deepEqual(f.router(f.update('PRIVATE NORMAL TEXT', { chat: { id: -100, type: 'group' } })), { dropped: true });
  assert.equal(f.logs.length, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM processed_updates').get().n, 0);
});

test('AI, malformed commands and unauthorized actors receive deterministic failures', t => {
  const f = fixture(t);
  assert.equal(f.router(f.update('هی دنگی علی رو فریز کن', { chat: { id: -100, type: 'group' } })).event, 'FEATURE_UNAVAILABLE');
  assert.equal(f.router(f.update('#DONGI user create Ali')).event, 'PARSE_FAILED');
  assert.equal(f.router(f.update('#DONGI user create "Ali"', { from: { id: 456 } })).event, 'PERMISSION_DENIED');
  assert.equal(f.router(f.update('#DONGI help', { sender_chat: { id: -100 } })).event, 'PERMISSION_DENIED');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
});

test('delivery retries use committed outbox and clear sensitive payload after success', async t => {
  const f = fixture(t); f.router(f.update('/start'));
  const request = f.update('#DONGI user create "Ali"'); f.router(request);
  const telegram = { call: async () => { throw new Error('network token=SECRET'); } };
  const options = { ...f, telegram, now: () => 1700000000000 };
  await deliverOutbox(options);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM response_outbox WHERE sent_at IS NULL').get().n, 2);
  assert.ok(!JSON.stringify(f.logs).includes('SECRET'));
  const sent = [];
  await deliverOutbox({ ...options, now: () => 1700000005000, telegram: { call: async (_, payload) => sent.push(payload) } });
  assert.equal(sent.length, 2);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM response_outbox WHERE encrypted_payload != ''").get().n, 0);
  assert.equal(f.router(request).event, 'DUPLICATE_REQUEST');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get().n, 2);
});

test('response pool enforces placeholders, role-specific selection and corrupted-row fallback', t => {
  const f = fixture(t);
  assert.equal(validTemplate('PROFILE', '{{name}}'), false);
  assert.equal(validTemplate('HELP', '{{secret}}'), false);
  f.db.prepare("UPDATE response_pool SET template = '{{bad}}' WHERE event_key = 'HELP'").run();
  assert.match(renderResponse(f.db, 'HELP'), /#DONGI help/);
  f.db.prepare("INSERT INTO response_pool(event_key, actor_role, template, created_at) VALUES ('HELP', 'OWNER', 'راهنمای رئیس', 1)").run();
  assert.equal(renderResponse(f.db, 'HELP', {}, 'OWNER'), 'راهنمای رئیس');
  assert.throws(() => renderResponse(f.db, 'PROFILE', {}));
});

test('cipher rejects wrong keys and tampered payloads', () => {
  const cipher = createPayloadCipher('ab'.repeat(32));
  const encrypted = cipher.encrypt({ token: 'SECRET' });
  assert.deepEqual(cipher.decrypt(encrypted), { token: 'SECRET' });
  assert.throws(() => createPayloadCipher('cd'.repeat(32)).decrypt(encrypted));
  const bytes = Buffer.from(encrypted, 'base64'); bytes[30] ^= 1;
  assert.throws(() => cipher.decrypt(bytes.toString('base64')));
});

test('membership updates are silent and older events cannot overwrite newer state', async t => {
  const f = fixture(t);
  const join = { update_id: 50, message: { message_id: 20, date: 200, chat: { id: -100, type: 'group' }, new_chat_members: [{ id: 456 }] } };
  const leave = { update_id: 49, message: { message_id: 19, date: 199, chat: { id: -100, type: 'group' }, left_chat_member: { id: 456 } } };
  syncMembership(f.db, join); syncMembership(f.db, leave);
  assert.equal(f.db.prepare('SELECT is_member FROM group_membership_cache').get().is_member, 1);
  const calls = [];
  await pollOnce({ ...f, telegram: { call: async (method, payload) => { calls.push({ method, payload }); return method === 'getUpdates' ? [join] : {}; } } });
  assert.deepEqual(calls.map(call => call.method), ['getUpdates']);
  assert.equal(f.db.prepare("SELECT value FROM runtime_state WHERE key = 'offset'").get().value, '51');
});

test('poller retains offset if direct DB-error fallback delivery fails', async t => {
  const f = fixture(t);
  const update = f.update('#DONGI help');
  f.db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON response_outbox BEGIN SELECT RAISE(ABORT, 'fail'); END");
  const telegram = { call: async method => { if (method === 'getUpdates') return [update]; throw new Error('network'); } };
  await assert.rejects(pollOnce({ ...f, telegram }));
  assert.equal(f.db.prepare("SELECT value FROM runtime_state WHERE key = 'offset'").get(), undefined);
});

test('Telegram client uses JSON and strips token-bearing transport exceptions', async () => {
  let request;
  const client = createTelegramClient('123:secret', async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ ok: true, result: { id: 123 } }) }; });
  assert.deepEqual(await client.call('getMe'), { id: 123 });
  assert.equal(request.options.method, 'POST');
  const failure = createTelegramClient('123:secret', async () => { throw new Error('https://api.telegram.org/bot123:secret/getMe'); });
  await assert.rejects(failure.call('getMe'), error => !error.message.includes('secret') && error.code === 'NETWORK');
});
