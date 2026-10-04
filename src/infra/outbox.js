import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { transaction } from './db/database.js';

export function createPayloadCipher(keyHex) {
  if (typeof keyHex !== 'string' || !/^[a-f0-9]{64}$/i.test(keyHex)) throw new Error('OUTBOX_KEY_REQUIRED');
  const key = Buffer.from(keyHex, 'hex');
  return {
    encrypt(payload) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    },
    decrypt(value) {
      const bytes = Buffer.from(value, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
    },
  };
}

export function createPurposeCipher(masterKeyHex, purpose) {
  if (typeof masterKeyHex !== 'string' || !/^[a-f0-9]{64}$/i.test(masterKeyHex)) throw new Error('APP_ENCRYPTION_KEY_REQUIRED');
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(purpose)) throw new Error('INVALID_CIPHER_PURPOSE');
  const derived = createHash('sha256').update(Buffer.from(masterKeyHex, 'hex')).update(`dongi:${purpose}`).digest('hex');
  return createPayloadCipher(derived);
}

export async function deliverOutbox({ db, cipher, telegram, log, now = Date.now }) {
  const rows = db.prepare(`SELECT o.*, p.trace_id,p.event FROM response_outbox o JOIN processed_updates p ON p.update_id = o.update_id
    WHERE o.delivery_status='PENDING' AND o.next_attempt_at <= ? ORDER BY o.id LIMIT 100`).all(now());
  for (const row of rows) {
    db.prepare("UPDATE response_outbox SET delivery_status='SENDING',attempts=attempts+1 WHERE id=? AND delivery_status='PENDING'").run(row.id);
    try {
      const payload = cipher.decrypt(row.encrypted_payload);
      const sent = await telegram.call('sendMessage', payload);
      transaction(db, () => {
        if (row.invoice_id && Number.isSafeInteger(sent?.message_id)) {
          db.prepare('INSERT OR IGNORE INTO receipt_messages(chat_id,message_id,invoice_id) VALUES (?,?,?)')
            .run(String(payload.chat_id),sent.message_id,row.invoice_id);
        }
        db.prepare("UPDATE response_outbox SET sent_at=?,encrypted_payload='',delivery_status='SENT',last_error_type=NULL WHERE id=?").run(now(), row.id);

      });
      log('RESPONSE_SENT', row.trace_id, { stage: 'DELIVERY', result: 'SUCCESS' });
    } catch (error) {
      if(error.code==='NETWORK'||error.code>=500){
        db.prepare("UPDATE response_outbox SET delivery_status='AMBIGUOUS',last_error_type='DELIVERY_OUTCOME_UNKNOWN' WHERE id=?").run(row.id);
        log('RESPONSE_DELIVERY_AMBIGUOUS',row.trace_id,{stage:'DELIVERY',error_type:'DELIVERY_OUTCOME_UNKNOWN',delivery_status:'AMBIGUOUS'},'ERROR');
        continue;
      }
      if([401,409].includes(error.code)){
        db.prepare("UPDATE response_outbox SET delivery_status='PENDING',last_error_type='TELEGRAM_SESSION_ERROR',next_attempt_at=? WHERE id=?")
          .run(now()+60000,row.id);
        throw error;
      }
      db.prepare("UPDATE response_outbox SET delivery_status='PENDING',last_error_type='DELIVERY_REJECTED',next_attempt_at=? WHERE id=?")
        .run(now() + Math.max(Math.min(300000, 1000 * 2 ** Math.min(row.attempts, 8)), (Number(error.retryAfter) || 0) * 1000), row.id);
      log('RESPONSE_SEND_FAILED', row.trace_id, { stage: 'DELIVERY', error_type: 'DELIVERY_FAILED' }, 'ERROR');
    }
  }
}
