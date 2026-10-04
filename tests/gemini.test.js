import test from 'node:test';
import assert from 'node:assert/strict';
import { createGemini, createGeminiFallback, GeminiError } from '../src/infra/gemini.js';
import { createAiGateway } from '../src/infra/ai-gateway.js';

test('Gemini sends credential only in header and requests structured output', async () => {
  const provider=createGemini({apiKey:'private-key',fetchImpl:async(url,options)=>{
    assert.ok(!url.includes('private-key'));
    assert.equal(options.headers['x-goog-api-key'],'private-key');
    assert.equal(JSON.parse(options.body).generationConfig.responseMimeType,'application/json');
    return {ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:'secret thought',thought:true},{text:'{}'}]}}]})};
  }});
  assert.equal((await provider.generate({model:'gemini-2.5-flash',prompt:'synthetic',schema:{type:'object'}})).text,'{}');
});
test('provider errors are sanitized and truncation rejected', async()=>{
  const denied=createGemini({apiKey:'secret',fetchImpl:async()=>({ok:false,status:403,json:async()=>({error:{message:'secret'}})})});
  await assert.rejects(denied.generate({model:'gemini-2.5-flash',prompt:'x'}),e=>e.status===403&&!e.message.includes('secret'));
  const partial=createGemini({apiKey:'secret',fetchImpl:async()=>({ok:true,json:async()=>({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'{}'}]}}]})})});
  await assert.rejects(partial.generate({model:'gemini-2.5-flash',prompt:'x'}),{code:'AI_INVALID_OUTPUT'});
});
test('all failures advance once, persist demotion, and share a bounded total',async()=>{
 const called=[];let fail=true;
 const generate=createGeminiFallback({generate:async({model})=>{called.push(model);if(fail&&model==='a')throw new GeminiError('AI_INVALID_OUTPUT');return {text:'ok'};}},['a','b']);
 assert.equal((await generate({})).model,'b');fail=false;
 assert.equal((await generate({})).model,'b');assert.deepEqual(called,['a','b','b']);
 for(const error of [new GeminiError('AI_PROVIDER_ERROR',403),new GeminiError('AI_INVALID_OUTPUT'),new Error('network')]){
  let calls=0;const run=createGeminiFallback({generate:async()=>{calls++;throw error;}},['a','b']);
  await assert.rejects(run({}));assert.equal(calls,2);
 }
});
test('invalid semantic output retries, ignored cancellation is bounded',async()=>{
 let calls=0;
 const generate=createGeminiFallback({generate:async()=>({text:++calls===1?'bad':'good'})},['a','b']);
 const result=await generate({validate:text=>{if(text==='bad')throw new Error('invalid');return text;}});
 assert.equal(result.validated,'good');assert.equal(calls,2);
 const keepAlive=setInterval(()=>{},100);
 try {
  const run=createGeminiFallback({generate:()=>new Promise(()=>{})},['a','b'],{attemptMs:10,totalMs:25});
  await assert.rejects(run({}),{code:'AI_CORE_TIMEOUT'});
 }finally{clearInterval(keepAlive);}
});
test('gateway counts failed jobs and no longer accepts pool generation',async()=>{
 let time=0;const gateway=createAiGateway({now:()=>time});
 await assert.rejects(gateway.run('POOL_GENERATION',()=>true),{code:'AI_CLASS_INVALID'});
 for(let i=0;i<5;i++)await gateway.run('CORE_AI',()=>true);
 await assert.rejects(gateway.run('CORE_AI',()=>true),{code:'AI_GATEWAY_BUSY'});
 time=60000;assert.equal(await gateway.run('CORE_AI',()=>true),true);
});
