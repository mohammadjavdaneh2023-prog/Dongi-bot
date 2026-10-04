import { GeminiError } from './gemini.js';

// Shared instance per bot process. Sliding window includes failed accepted jobs.
export function createAiGateway({ now = Date.now, timeoutMs=60000 } = {}) {
  let accepted = [];
  return {
    async run(kind, task) {
      if (!['CORE_AI','CONVERSATIONAL_AI'].includes(kind)) throw new GeminiError('AI_CLASS_INVALID');
      const time = now(); accepted = accepted.filter(t => time - t < 60000);
      if (accepted.length >= 5) {
        throw new GeminiError('AI_GATEWAY_BUSY');
      }
      accepted.push(time);
      return task(AbortSignal.timeout(timeoutMs));
    },
  };
}
