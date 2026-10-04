export class TelegramError extends Error {
  constructor(code, retryAfter = 1) {
    super('TELEGRAM_API_FAILED');
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function createTelegramClient(token, fetchImpl = fetch) {
  if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('TELEGRAM_TOKEN_REQUIRED');
  return {
    async call(method, payload = {}, signal) {
      if (!['getMe', 'getUpdates', 'getChatMember', 'sendMessage', 'deleteMessage', 'deleteWebhook', 'answerCallbackQuery'].includes(method)) throw new Error('TELEGRAM_METHOD_UNSUPPORTED');
      try {
        const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
          signal: signal?AbortSignal.any([signal,AbortSignal.timeout(method === 'getUpdates' ? 40000 : 15000)]):AbortSignal.timeout(method === 'getUpdates' ? 40000 : 15000),
        });
        const body = await response.json();
        if (!response.ok || body.ok !== true) throw new TelegramError(body.error_code ?? response.status, body.parameters?.retry_after ?? 1);
        return body.result;
      } catch (error) {
        if(signal?.aborted)throw new TelegramError('REQUEST_TIMEOUT');
        if (error instanceof TelegramError) throw error;
        // fetch errors may include the URL containing the bot token.
        throw new TelegramError('NETWORK');
      }
    },
  };
}
