import test from 'node:test';
import assert from 'node:assert/strict';
import { acquirePollingLock, migrationsCurrent, openDatabase, transaction } from '../../src/infra/db/database.js';

test('an empty PostgreSQL schema migrates and enforces durable idempotency', t => {
  const db=openDatabase(':memory:');t.after(()=>db.close());
  assert.equal(migrationsCurrent(db),true);assert.equal(acquirePollingLock(db),true);
  transaction(db,()=>{
    db.exec("INSERT INTO users VALUES ('owner','10','AA111','Owner','OWNER','ACTIVE',1,1,1)");
    db.prepare('INSERT INTO processed_updates(update_id,chat_id,message_id,trace_id,event,created_at) VALUES (?,?,?,?,?,?)')
      .run(1,'-100',1,'DNG-00000000000000000000000000000000','HELP',1);
    db.prepare('INSERT INTO response_outbox(update_id,encrypted_payload) VALUES (?,?)').run(1,'encrypted-test-payload');
  });
  assert.throws(()=>db.prepare('INSERT INTO processed_updates(update_id,chat_id,message_id,trace_id,event,created_at) VALUES (?,?,?,?,?,?)')
    .run(2,'-100',1,'DNG-00000000000000000000000000000001','HELP',2));
  assert.equal(db.prepare("SELECT delivery_status FROM response_outbox WHERE update_id=1").get().delivery_status,'PENDING');
});
