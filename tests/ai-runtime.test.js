import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiRuntime} from '../src/infra/ai-runtime.js';
import {GeminiError} from '../src/infra/gemini.js';
import {openDatabase} from '../src/infra/db/database.js';

test('model demotion survives reconstruction of runtime against persisted state',async t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());const calls=[];
 const provider={generate:async({model})=>{calls.push(model);if(model==='gemini-3.1-flash-lite')throw new GeminiError('AI_INVALID_OUTPUT');return {text:'ok'};}};
 await createAiRuntime({db,provider}).generate({});
 await createAiRuntime({db,provider}).generate({});
 assert.deepEqual(calls,['gemini-3.1-flash-lite','gemini-3.6-flash','gemini-3.6-flash']);
});

test('runtime shares gateway across foreground/background and logs no prompt or response text',async()=>{
 const logs=[];let calls=0;
 const ai=createAiRuntime({log:(...args)=>logs.push(args),provider:{generate:async()=>{calls++;return {text:'private-response'};}}});
 for(let i=0;i<4;i++)await ai.gateway.run('CORE_AI',signal=>ai.generate({prompt:'private-request',signal}));
 await assert.rejects(ai.gateway.run('POOL_GENERATION',()=>assert.fail('must reject')),{code:'AI_CLASS_INVALID'});
 await ai.gateway.run('CONVERSATIONAL_AI',signal=>ai.generate({prompt:'private-request',signal}));
 await assert.rejects(ai.gateway.run('CORE_AI',()=>assert.fail('must reject')),{code:'AI_GATEWAY_BUSY'});
 assert.equal(calls,5);
 const output=JSON.stringify(logs);assert.ok(!output.includes('private-request'));assert.ok(!output.includes('private-response'));
 assert.ok(output.includes('AI_GATEWAY_REJECTED'));
});

test('runtime switches from Lite to validated Flash on quota and preserves one deadline',async()=>{
 const calls=[];
 const ai=createAiRuntime({provider:{generate:async request=>{
   calls.push(request);
   if(request.model==='gemini-3.1-flash-lite')throw new GeminiError('AI_RATE_LIMIT',429);
   return {text:'{"kind":"CLARIFY","lines":null}'};
 }}});
 const result=await ai.gateway.run('CORE_AI',signal=>ai.generate({prompt:'synthetic',signal}));
 assert.equal(result.model,'gemini-3.6-flash');
 assert.deepEqual(calls.map(c=>c.model),['gemini-3.1-flash-lite','gemini-3.6-flash']);
 assert.notEqual(calls[0].signal,calls[1].signal);
 await ai.gateway.run('CORE_AI',signal=>ai.generate({prompt:'synthetic',signal}));
 assert.equal(calls.length,3);assert.equal(calls[2].model,'gemini-3.6-flash');
});
