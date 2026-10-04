import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate } from '../../src/domain/allocation.js';
import { createPayloadCipher, createPurposeCipher } from '../../src/infra/outbox.js';
import { loadConfig } from '../../src/infra/config.js';
import { createHealthServer } from '../../src/infra/health.js';

test('allocation remains exact',()=>assert.deepEqual(allocate(10,'WEIGHTED',['1','2']),[3,7]));
test('purpose-specific encryption keys cannot decrypt each other',()=>{
  const master='ab'.repeat(32);const one=createPurposeCipher(master,'outbox');const two=createPurposeCipher(master,'test-purpose');
  assert.throws(()=>two.decrypt(one.encrypt('secret')));
  assert.deepEqual(createPayloadCipher(master).decrypt(createPayloadCipher(master).encrypt({ok:true})),{ok:true});
});
test('production config requires PostgreSQL, encryption, and one global AI key',()=>{
  const config=loadConfig({DATABASE_URL:'postgresql://localhost/dongi',APP_ENCRYPTION_KEY:'ab'.repeat(32),GEMINI_API_KEY:'test-key'});
  assert.equal(config.port,3000);assert.equal(config.defaultTimezone,'Asia/Tehran');assert.equal(config.aiApiKey,'test-key');
  assert.throws(()=>loadConfig({DATABASE_URL:'postgresql://localhost/dongi',APP_ENCRYPTION_KEY:'ab'.repeat(32)}),/GEMINI_API_KEY/);
});
test('health server exposes liveness, readiness and version without secrets',async t=>{
  const server=createHealthServer({port:0,version:'abc123',readiness:()=>({started:false})});
  await new Promise(resolve=>server.once('listening',resolve));t.after(()=>server.close());
  const port=server.address().port;
  const health=await fetch(`http://127.0.0.1:${port}/healthz`);assert.equal(health.status,200);
  const ready=await fetch(`http://127.0.0.1:${port}/readyz`);assert.equal(ready.status,503);
  const version=await fetch(`http://127.0.0.1:${port}/version`);assert.deepEqual(await version.json(),{version:'abc123'});
});
