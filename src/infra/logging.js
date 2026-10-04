import { randomUUID } from 'node:crypto';

const fields = new Set([
  'telegram_update_id', 'chat_id', 'message_id', 'dongi_user_id', 'public_id',
  'actor_role', 'actor_status', 'handler', 'operation', 'stage', 'result',
  'duration_ms', 'error_type', 'ai_model', 'ai_class', 'delivery_status',
]);
const priorities = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
export const newTraceId = () => `DNG-${randomUUID().replaceAll('-', '').toUpperCase()}`;

export function createLogger({ logLevel = 'INFO', appVersion = 'dev', appEnv = 'production' } = {}) {
  const threshold = priorities[logLevel] ?? priorities.INFO;
  return function log(event, traceId, metadata = {}, level = 'INFO') {
    if (!/^[A-Z][A-Z0-9_]*$/.test(event)) throw new Error('Invalid log event');
    if (!/^DNG-[A-F0-9]{32}$/.test(traceId)) throw new Error('Invalid trace ID');
    if (!(level in priorities)) throw new Error('Invalid log level');
    if (priorities[level] < threshold) return;
    const row = { timestamp: new Date().toISOString(), level, service: 'dongi', version: appVersion, environment: appEnv, event, trace_id: traceId };
    for (const key of fields) {
      const value = metadata[key];
      if (['string', 'number', 'boolean'].includes(typeof value)) row[key] = value;
    }
    const target = level === 'ERROR' ? process.stderr : process.stdout;
    target.write(`${JSON.stringify(row)}\n`);
  };
}
