import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/infra/db/database.js';
import { IdentityRepository } from '../src/repositories/identity.js';
import { changeAlias } from '../src/domain/users/aliases.js';
import { newTraceId } from '../src/infra/logging.js';
import { invoiceContext } from '../src/repositories/invoices.js';
import { resolveIdentity } from '../src/domain/identity.js';
import { createRouter } from '../src/bot/router.js';
import { createPayloadCipher } from '../src/infra/outbox.js';
import { errorDetails, seedResponses } from '../src/bot/responses.js';
import { prepareInvoice } from '../src/infra/prepare-invoice.js';
import { prepareManagement } from '../src/infra/prepare-management.js';

test('current group admin can manage member aliases; demotion revokes access',async t=>{
 const f=setup(t);
 let admin=true;
 const telegram={call:async(_,p)=>({user:{id:p.user_id},status:p.user_id===11&&admin?'administrator':'member'})};
 for(const [id,expected] of [[1,'ALIAS_ADDED'],[2,'PERMISSION_DENIED']]){
  const update={update_id:id,message:{message_id:id,from:{id:11},chat:{id:-100,type:'group'},text:'#DONGI alias CD456 add تست'}};
  assert.equal(f.router(update,await prepareManagement(f.db,telegram,update)).event,expected);
  admin=false;
 }
});

function setup(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  db.exec(`INSERT INTO users VALUES ('owner','10','AB123','رئیس','OWNER','ACTIVE',1,1,1),
    ('member','11','CD456','علی','MEMBER','ACTIVE',1,1,1)`);
  const repository = new IdentityRepository(db);
  const change = extra => changeAlias(repository, { actorTelegramId: '10', inputMode: 'DETERMINISTIC', publicId: 'CD456', action: 'add', alias: 'علی جان', traceId: newTraceId(), ...extra });
  const cipher = createPayloadCipher('ab'.repeat(32)); seedResponses(db);
  const router = createRouter({ db, cipher, bot: { id: 99, username: 'TestBot' }, config: {}, log: () => {} });
  return { db, repository, change, cipher, router };
}
test('owner alias changes persist, normalize, resolve and audit removal', t => {
  const f = setup(t); f.change();
  const context = invoiceContext(f.db, { from: { id: 10 }, chat: { id: -100 } });
  assert.equal(resolveIdentity('علي‌جان', context.users).user.id, 'member');
  f.change({ action: 'remove', alias: 'علي‌جان' });
  assert.equal(f.db.prepare('SELECT count(*) n FROM user_aliases').get().n, 0);
  assert.deepEqual(f.db.prepare('SELECT event FROM audit_events ORDER BY rowid').all().map(row => row.event), ['ALIAS_ADDED','ALIAS_REMOVED']);
});
test('alias ownership, normalized conflicts, reserved names and AI gate are enforced', t => {
  const f = setup(t); f.change();
  assert.throws(() => f.change({ alias: 'علي‌جان' }), { code: 'ALIAS_CONFLICT' });
  for (const alias of ['رئیس','AB123','cd456']) assert.throws(() => f.change({ alias }), { code: 'ALIAS_CONFLICT' });
  for (const alias of ['me','ALL','ـ','']) assert.throws(() => f.change({ alias }), { code: 'INVALID_ALIAS' });
  assert.throws(() => f.change({ actorTelegramId: '11' }), { code: 'PERMISSION_DENIED' });
  assert.throws(() => f.change({ inputMode: 'AI_CONFIRMED' }), { code: 'ADMIN_DETERMINISTIC_ONLY' });
  assert.throws(() => f.change({ publicId: 'AB123', action: 'remove' }), { code: 'ALIAS_NOT_FOUND' });
});
test('audit failure rolls back both alias add and removal', t => {
  const f = setup(t); f.change();
  f.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'failure'); END");
  assert.throws(() => f.change({ action: 'remove' }), { code: 'DB_TRANSACTION_FAILED' });
  assert.throws(() => f.change({ alias: 'علی دوم' }), { code: 'DB_TRANSACTION_FAILED' });
  assert.equal(f.db.prepare('SELECT count(*) n FROM user_aliases').get().n, 1);
});
test('alias command is idempotent through Router and has a pooled receipt', t => {
  const f = setup(t);
  const update = { update_id: 1, message: { message_id: 1, from: { id: 10 }, chat: { id: 10, type: 'private' }, text: '#DONGI alias CD456 add علی جان' } };
  assert.equal(f.router(update).event, 'ALIAS_ADDED');
  assert.equal(f.router(update).event, 'DUPLICATE_REQUEST');
  assert.equal(f.db.prepare('SELECT count(*) n FROM user_aliases').get().n, 1);
  const text = f.cipher.decrypt(f.db.prepare('SELECT encrypted_payload FROM response_outbox').get().encrypted_payload).text;
  assert.match(text, /علی جان/); assert.match(text, /CD456/);
});
test('financial error details survive preparation and reach user without arbitrary metadata', async t => {
  const f = setup(t);
  const update = { update_id: 1, message: { message_id: 1, from: { id: 10 }, chat: { id: -100, type: 'group' }, text: '#DONGI invoice "x"\nAB123 +100\nCD456 -90' } };
  const prepared = await prepareInvoice(f.db, { call: async () => { throw new Error('unexpected network'); } }, update);
  assert.equal(prepared.details.difference, '10');
  assert.equal(f.router(update, prepared).event, 'ZERO_SUM_FAILED');
  const text = f.cipher.decrypt(f.db.prepare('SELECT encrypted_payload FROM response_outbox').get().encrypted_payload).text;
  assert.match(text, /اختلاف جمع \(تومان\): 10/);
  assert.equal(errorDetails({ secret: 'SECRET', raw_amount: '1e3' }), 'مقدار ورودی: 1e3');
});
