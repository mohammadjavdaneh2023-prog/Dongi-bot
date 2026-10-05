import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { randomInt, randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/infra/db/database.js';
import { IdentityRepository } from '../../src/repositories/identity.js';
import { OnboardingService } from '../../src/domain/users/onboarding.js';
import { newTraceId } from '../../src/infra/logging.js';

function runWorker(data){
 let resolveReady,rejectReady,resolveResult,rejectResult;
 const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
 const result=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
 const worker=new Worker(new URL('../fixtures/invitation-race-worker.js',import.meta.url),{workerData:data});
 worker.on('message',message=>message.ready?resolveReady():resolveResult(message));worker.once('error',error=>{rejectReady(error);rejectResult(error);});
 return {ready,result,start:()=>worker.postMessage('GO')};
}

test('simultaneous acceptance and expiry have one durable winner and one owner notice',async t=>{
 assert.ok(process.env.TEST_DATABASE_URL,'race test requires a disposable real PostgreSQL database');
 const db=openDatabase(process.env.TEST_DATABASE_URL);
 t.after(()=>db.close());
 const repository=new IdentityRepository(db);
 let owner=repository.owner();
 if(!owner){
  const ownerTelegramId=String(Date.now()+randomInt(10000,90000));
  const service=new OnboardingService(repository);const traceId=newTraceId();
  owner=service.bootstrapOwner({ownerTelegramId,name:`Owner ${randomUUID()}`,traceId});
 }
 new OnboardingService(repository).startOwner({senderTelegramId:owner.telegram_user_id,chatType:'private',traceId:newTraceId()});
 const invitation=new OnboardingService(repository).createUser({actorTelegramId:owner.telegram_user_id,inputMode:'DETERMINISTIC',
  name:`Race ${randomUUID()}`,traceId:newTraceId()});
 const base={databaseUrl:process.env.TEST_DATABASE_URL,encryptionKey:'ab'.repeat(32)};
 const acceptance=runWorker({...base,action:'accept',token:invitation.token,telegramId:String(Date.now()+randomInt(100000,900000))});
 const expiry=runWorker({...base,action:'expire'});
 await Promise.all([acceptance.ready,expiry.ready]);
 db.prepare('UPDATE access_grants SET expires_at=? WHERE user_id=?').run(repository.databaseNow()+250,invitation.user.id);
 acceptance.start();expiry.start();
 const results=await Promise.all([
  acceptance.result,expiry.result,
 ]);
 const grant=db.prepare('SELECT status,used_at FROM access_grants WHERE user_id=?').get(invitation.user.id);
 assert.ok(['ACCEPTED','EXPIRED'].includes(grant.status));
 assert.notEqual(grant.status,'PENDING');
 const profile=repository.byId(invitation.user.id);
 const notices=db.prepare("SELECT idempotency_key FROM response_outbox WHERE idempotency_key LIKE ?").all(`invitation:${db.prepare('SELECT id FROM access_grants WHERE user_id=?').get(invitation.user.id).id}:%`);
 assert.equal(notices.length,1);
 assert.equal(grant.status==='ACCEPTED',Boolean(profile.telegram_user_id));
 assert.ok(results.some(result=>result.result==='accepted'||result.result==='expired'||result.result==='rejected'));
});
