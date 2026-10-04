import test from 'node:test';
import assert from 'node:assert/strict';
import { freeTierFlashModels, selectFreeTierModels, summarizeBenchmark } from '../src/infra/gemini-models.js';

test('free tier selection intersects discovery and excludes unverified aliases/media/pro models',()=>{
  assert.equal(freeTierFlashModels.length,7);
  assert.deepEqual(selectFreeTierModels(['gemini-3.1-flash-lite','gemini-pro-latest']),['gemini-3.1-flash-lite']);
  for(const model of ['gemini-pro-latest','gemini-flash-latest','gemini-2.5-flash-image'])
    assert.throws(()=>selectFreeTierModels([model],[model]),/MODEL_FREE_TIER_NOT_VERIFIED/);
});
test('benchmark separates wrong answers from outages and excludes error latency',()=>{
  assert.deepEqual(summarizeBenchmark([
    {passed:true,ms:1000},{passed:false,ms:2000},{passed:false,ms:10,error:'AI_PROVIDER_ERROR'},
  ],3),{passed:1,received:2,providerErrors:1,qualityFailures:1,eligible:false,medianMs:1500});
  assert.equal(summarizeBenchmark([{passed:true,ms:100}],2).eligible,false);
  assert.equal(summarizeBenchmark([{passed:true,ms:100}],1).eligible,true);
  assert.equal(summarizeBenchmark([{passed:false,error:'AI_RATE_LIMIT',ms:10}],7).medianMs,null);
});
