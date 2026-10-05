import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase, transaction } from '../../src/infra/db/database.js';
import { IdentityRepository } from '../../src/repositories/identity.js';
import { OnboardingService } from '../../src/domain/users/onboarding.js';
import { expirePendingInvitations } from '../../src/infra/invitation-expiry.js';
import { createPayloadCipher, enqueueSystemNotification } from '../../src/infra/outbox.js';
import { newTraceId } from '../../src/infra/logging.js';

const db=openDatabase(workerData.databaseUrl);
parentPort.postMessage({ready:true});
await new Promise(resolve=>parentPort.once('message',resolve));
try{
 if(workerData.action==='accept'){
  const service=new OnboardingService(new IdentityRepository(db,{participatesInTransaction:true}));
  const traceId=newTraceId();const cipher=createPayloadCipher(workerData.encryptionKey);
  transaction(db,()=>{
   const user=service.redeemGrant({senderTelegramId:workerData.telegramId,chatType:'private',token:workerData.token,traceId});
   enqueueSystemNotification(db,cipher,{key:`invitation:${user.invitationAcceptance.id}:accepted`,chatId:user.invitationAcceptance.ownerTelegramId,
    event:'INVITATION_ACCEPTED',text:`✅ کاربر ${user.invitationAcceptance.name} با شناسه DONGI ${user.invitationAcceptance.publicId} دعوت را پذیرفت و وارد شد.`,traceId});
  });
  parentPort.postMessage({result:'accepted'});
 }else{
  const count=expirePendingInvitations({db,cipher:createPayloadCipher(workerData.encryptionKey)});
  parentPort.postMessage({result:'expired',count});
 }
}catch(error){
 parentPort.postMessage({result:error.code==='ONBOARDING_TOKEN_INVALID'?'rejected':'failed',code:error.code});
}finally{
 await db.close();
}
