// Standard text input/output Free Tier verified against Google's pricing on 2026-10-02.
// This describes model availability, NOT the billing tier of the API key's project.
export const freeTierFlashModels = Object.freeze([
  'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite',
  'gemini-2.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash',
]);

export function selectFreeTierModels(available, requested = freeTierFlashModels) {
  for (const model of requested) {
    if (!freeTierFlashModels.includes(model)) throw new Error('MODEL_FREE_TIER_NOT_VERIFIED');
  }
  return [...new Set(requested)].filter(model => available.includes(model));
}

export function summarizeBenchmark(cases, expectedCount) {
  const received = cases.filter(c => !c.error);
  const times = received.map(c => c.ms).sort((a,b) => a-b);
  const passed = cases.filter(c => c.passed).length;
  const middle = Math.floor(times.length/2);
  return {
    passed, received: received.length, providerErrors: cases.filter(c => c.error).length,
    qualityFailures: received.filter(c => !c.passed).length,
    eligible: cases.length === expectedCount && passed === expectedCount,
    medianMs: times.length ? (times.length % 2 ? times[middle] : (times[middle-1]+times[middle])/2) : null,
  };
}
