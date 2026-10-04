import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/infra/db/database.js';
import { createAiCredentialService } from '../src/infra/ai-credentials.js';
import { createPayloadCipher } from '../src/infra/outbox.js';

test('BYOK credentials are encrypted, isolated, disableable, replaceable and deletable', t => {
  const db=openDatabase(':memory:');t.after(()=>db.close());
  db.exec("INSERT INTO users VALUES ('a','10','AA111','Ali','OWNER','ACTIVE',1,1,1),('b','11','BB222','Bea','MEMBER','ACTIVE',1,1,1)");
  const cipher=createPayloadCipher('ab'.repeat(32));
  const service=createAiCredentialService({db,cipher,log:()=>{}});
  const first='AIza-user-a-private-key-value';const second='AIza-user-b-private-key-value';
  assert.equal(service.manage(10,`/ai-key set ${first}`).code,'AI_KEY_SAVED');
  assert.equal(service.manage(11,`/ai-key set ${second}`).code,'AI_KEY_SAVED');
  const rows=db.prepare('SELECT user_id,encrypted_api_key,enabled FROM user_ai_credentials ORDER BY user_id').all();
  assert.equal(rows.length,2);assert.ok(!JSON.stringify(rows).includes(first));assert.ok(!JSON.stringify(rows).includes(second));
  assert.equal(cipher.decrypt(rows[0].encrypted_api_key),first);assert.equal(cipher.decrypt(rows[1].encrypted_api_key),second);
  assert.equal(service.manage(10,'/ai-key disable').code,'AI_KEY_DISABLED');assert.equal(service.runtimeForTelegramUser(10),undefined);
  assert.equal(service.manage(10,'/ai-key enable').code,'AI_KEY_ENABLED');assert.ok(service.runtimeForTelegramUser(10));
  assert.equal(service.manage(10,'/ai-key delete').code,'AI_KEY_DELETED');assert.equal(service.runtimeForTelegramUser(10),undefined);
  assert.ok(service.runtimeForTelegramUser(11));
});
