function positiveInteger(value, fallback, key, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === '') return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
    throw new Error(`Invalid configuration: ${key}`);
  }
  return Number(value);
}

function required(env, key) {
  const value = env[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing configuration: ${key}`);
  return value.trim();
}

export function loadConfig(env = process.env, { requireRuntimeSecrets = true } = {}) {
  const databaseUrl = required(env, 'DATABASE_URL');
  if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) throw new Error('Invalid configuration: DATABASE_URL');
  const encryptionKey = requireRuntimeSecrets ? required(env, 'APP_ENCRYPTION_KEY') : env.APP_ENCRYPTION_KEY;
  if (encryptionKey && !/^[a-f0-9]{64}$/i.test(encryptionKey)) throw new Error('Invalid configuration: APP_ENCRYPTION_KEY');
  const aiApiKey = requireRuntimeSecrets ? required(env, 'GEMINI_API_KEY') : env.GEMINI_API_KEY;
  const port = positiveInteger(env.PORT, 3000, 'PORT', 65535);
  const grantTtlSeconds = positiveInteger(env.DONGI_GRANT_TTL_SECONDS, 86400, 'DONGI_GRANT_TTL_SECONDS', 31536000);
  const logLevel = (env.LOG_LEVEL ?? 'INFO').toUpperCase();
  if (!['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(logLevel)) throw new Error('Invalid configuration: LOG_LEVEL');
  return Object.freeze({
    appEnv: env.APP_ENV ?? 'production', appVersion: env.APP_VERSION ?? 'dev', databaseUrl,
    defaultTimezone: env.DEFAULT_TIMEZONE ?? 'Asia/Tehran', encryptionKey, aiApiKey, port, logLevel,
    grantTtlSeconds, grantTtlMs: grantTtlSeconds * 1000,
  });
}
