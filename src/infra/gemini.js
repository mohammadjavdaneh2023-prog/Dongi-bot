import {withSignal} from './deadline.js';
// Provider errors deliberately exclude response bodies, prompts and credentials.
export class GeminiError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}
export function createGemini({ apiKey, fetchImpl = fetch }) {
  if (!apiKey) throw new GeminiError('AI_NOT_CONFIGURED');
  const base = 'https://generativelanguage.googleapis.com/v1beta/';
  async function request(path, body, signal) {
    let response;
    try {
      response = await fetchImpl(base + path, {
        method: body ? 'POST' : 'GET', signal,
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new GeminiError(signal?.aborted ? 'AI_CORE_TIMEOUT' : 'AI_PROVIDER_ERROR'); }
    if (!response.ok) throw new GeminiError(response.status === 429 ? 'AI_RATE_LIMIT' : 'AI_PROVIDER_ERROR', response.status);
    try { return await response.json(); } catch { throw new GeminiError('AI_INVALID_OUTPUT'); }
  }
  return {
    async models(signal = AbortSignal.timeout(15000)) {
      const models = []; let token;
      do {
        const data = await request('models?pageSize=1000' + (token ? '&pageToken=' + encodeURIComponent(token) : ''), null, signal);
        models.push(...(data.models ?? []).filter(m => m.supportedGenerationMethods?.includes('generateContent')).map(m => m.name.replace(/^models\//, '')));
        token = data.nextPageToken;
      } while (token);
      return models;
    },
    async generate({ model, prompt, schema, signal = AbortSignal.timeout(60000) }) {
      if (!/^gemini-[a-z0-9.-]+$/.test(model)) throw new GeminiError('AI_MODEL_INVALID');
      const data = await request(`models/${model}:generateContent`, {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 2048,
          ...(schema ? { responseMimeType: 'application/json', responseJsonSchema: schema } : {}) },
      }, signal);
      const candidate = data.candidates?.[0];
      if (candidate?.finishReason !== 'STOP') throw new GeminiError('AI_INVALID_OUTPUT');
      const text = candidate.content?.parts?.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
      if (!text) throw new GeminiError('AI_INVALID_OUTPUT');
      return { text, usage: data.usageMetadata };
    },
  };
}

// Each model gets one bounded attempt, including validation. Failures demote it
// persistently; the request walks an immutable snapshot to avoid repeated attempts.
export function createGeminiFallback(provider, models, { db, attemptMs=40000, totalMs=30000*models.length } = {}) {
  let order=[...models];
  if(db){
    try {const saved=JSON.parse(db.prepare("SELECT value FROM runtime_state WHERE key='ai_model_order'").get()?.value??'[]');
      if(Array.isArray(saved))order=[...new Set([...saved.filter(m=>models.includes(m)),...models])];
    }catch{/* A corrupt preference must not disable the provider. */}
  }
  return async function generate(request) {
    const total=AbortSignal.timeout(totalMs);
    const signal=request.signal?AbortSignal.any([request.signal,total]):total;
    let last = new GeminiError('AI_MODELS_UNAVAILABLE');
    for (const model of [...order]) {
      if (signal.aborted) throw new GeminiError('AI_CORE_TIMEOUT');
      const attempt=AbortSignal.any([signal,AbortSignal.timeout(attemptMs)]);
      try {
        const response=await withSignal(attempt,()=>provider.generate({ ...request, model, signal:attempt }));
        const validated=request.validate?await withSignal(attempt,()=>request.validate(response.text)):undefined;
        return {...response,model,validated};
      }
      catch (error) {
        last = error;
        order=[...order.filter(m=>m!==model),model];
        if(db)db.prepare("INSERT INTO runtime_state VALUES ('ai_model_order',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(order));
        if(signal.aborted)throw new GeminiError('AI_CORE_TIMEOUT');
      }
    }
    throw last;
  };
}
