import { createAiRuntime } from './ai-runtime.js';
import { transaction } from './db/database.js';

const provider = 'GEMINI';

export function createAiCredentialService({ db, cipher, log }) {
  const commit = work => db.isTransaction ? work() : transaction(db, work);
  function actor(telegramUserId) {
    return db.prepare('SELECT * FROM users WHERE telegram_user_id=?').get(String(telegramUserId));
  }
  return {
    manage(telegramUserId, command) {
      const user = actor(telegramUserId);
      if (!user?.bot_started) return { code: 'ONBOARDING_REQUIRED' };
      const action = command.trim().match(/^\/ai-key(?:@\w+)?(?:\s+(set|delete|disable|enable|status)(?:\s+([\s\S]+))?)?$/i);
      if (!action) return { code: 'AI_KEY_COMMAND_INVALID' };
      const operation = (action[1] ?? 'status').toLowerCase();
      const key = action[2]?.trim();
      return commit(() => {
        const existing = db.prepare('SELECT enabled FROM user_ai_credentials WHERE user_id=? AND provider=?').get(user.id, provider);
        if (operation === 'set') {
          if (!key || key.length < 20 || key.length > 512 || /\s/.test(key)) return { code: 'AI_KEY_INVALID' };
          const now = Date.now();
          db.prepare(`INSERT INTO user_ai_credentials(user_id,provider,encrypted_api_key,enabled,created_at,updated_at)
            VALUES (?,?,?,1,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET encrypted_api_key=excluded.encrypted_api_key,enabled=1,updated_at=excluded.updated_at`)
            .run(user.id, provider, cipher.encrypt(key), now, now);
          return { code: 'AI_KEY_SAVED' };
        }
        if (operation === 'delete') {
          db.prepare('DELETE FROM user_ai_credentials WHERE user_id=? AND provider=?').run(user.id, provider);
          return { code: 'AI_KEY_DELETED' };
        }
        if (operation === 'disable' || operation === 'enable') {
          if (!existing) return { code: 'AI_KEY_NOT_CONFIGURED' };
          db.prepare('UPDATE user_ai_credentials SET enabled=?,updated_at=? WHERE user_id=? AND provider=?')
            .run(operation === 'enable' ? 1 : 0, Date.now(), user.id, provider);
          return { code: operation === 'enable' ? 'AI_KEY_ENABLED' : 'AI_KEY_DISABLED' };
        }
        return { code: !existing ? 'AI_KEY_NOT_CONFIGURED' : existing.enabled ? 'AI_KEY_ACTIVE' : 'AI_KEY_INACTIVE' };
      });
    },
    runtimeForTelegramUser(telegramUserId) {
      const user = actor(telegramUserId);
      if (!user) return undefined;
      const credential = db.prepare('SELECT encrypted_api_key FROM user_ai_credentials WHERE user_id=? AND provider=? AND enabled=1').get(user.id, provider);
      if (!credential) return undefined;
      try { return createAiRuntime({ apiKey: cipher.decrypt(credential.encrypted_api_key), db, log }); }
      catch { return undefined; }
    },
  };
}
