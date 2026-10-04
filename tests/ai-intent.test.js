import test from 'node:test';
import assert from 'node:assert/strict';
import { aiIntentPrompt, interpretAi, validateAiIntent,validateExactAmount } from '../src/bot/ai-intent.js';

test('exact flag rejects guessed thousands but accepts explicit units',()=>{
 assert.throws(()=>validateExactAmount('هی دنگی ۸۰۰ #exact',{amount:800000}),{code:'AI_INVALID_OUTPUT'});
 validateExactAmount('هی دنگی ۸۰۰ #exact',{amount:800});
 validateExactAmount('هی دنگی ۸۰۰ هزار تومان #exact',{amount:800000});
 validateExactAmount('هی دنگی ۸۰۰۰۰۰ ریال #exact',{amount:80000});
});
import { createAiGateway } from '../src/infra/ai-gateway.js';

const context = () => ({actorId:'a',currentMemberIds:new Set(['a','b']),groupFrozenIds:new Set(),users:[
  {id:'a',public_id:'AA111',canonical_name:'رضا',telegram_user_id:'1',status:'ACTIVE',bot_started:1,aliases:[]},
  {id:'b',public_id:'BB222',canonical_name:'علی',telegram_user_id:'2',status:'ACTIVE',bot_started:1,aliases:['علی جان']},
  {id:'c',public_id:'CC333',canonical_name:'خارج گروه',telegram_user_id:'3',status:'ACTIVE',bot_started:1,aliases:[]},
]});
const encoded = command => JSON.stringify({kind:'INVOICE',lines:command.split('\n')});
test('AI contract rejects extra fields, admin commands, raw net arithmetic and malformed JSON',()=>{
  for(const text of ['```json\n{}\n```','null',JSON.stringify({kind:'CHAT',lines:null,extra:1}),
    encoded('#DONGI freeze BB222'),encoded('#DONGI invoice "x"\nAA111 +100\nBB222 -100'),
    JSON.stringify({kind:'INVOICE',lines:['#DONGI invoice "x" 600\nbetween: me BB222']}),
    JSON.stringify({kind:'ADMIN_REJECTED',lines:['#DONGI void #1']})])
    assert.throws(()=>validateAiIntent(text),{code:'AI_INVALID_OUTPUT'});
  assert.deepEqual(validateAiIntent('{"kind":"ADMIN_REJECTED","lines":null}'),{kind:'ADMIN_REJECTED'});
});
test('AI preview uses domain allocation, preserves zero participants and never mutates context',async()=>{
  const ctx=context();const before=JSON.stringify(ctx.users);
  const result=await interpretAi({text:'synthetic',context:ctx,gateway:createAiGateway(),generate:async()=>({
    text:encoded('#DONGI invoice "شام" 600\npaid: AA111 300 BB222 300\nbetween: AA111 BB222'),model:'test'})});
  assert.deepEqual(result.preview.entries.map(e=>e.amount),[0,0]);
  assert.equal(result.intent.input_mode,'AI_CONFIRMED');
  assert.equal(JSON.stringify(ctx.users),before);
});
test('AI proposal cannot bypass current membership or suspended identities',async()=>{
  const ctx=context();
  await assert.rejects(interpretAi({text:'synthetic',context:ctx,gateway:createAiGateway(),generate:async()=>({
    text:encoded('#DONGI invoice "شام" 600\npaid: me 600\nbetween: me CC333')})}),{code:'USER_NOT_IN_GROUP'});
  ctx.users[1].status='SUSPENDED';
  await assert.rejects(interpretAi({text:'synthetic',context:ctx,gateway:createAiGateway(),generate:async()=>({
    text:encoded('#DONGI invoice "شام" 600\nbetween: me BB222')})}),{code:'TARGET_SUSPENDED'});
});
test('frozen actors never reach Gemini and prompt excludes unrelated users and Telegram IDs',async()=>{
  const ctx=context();const prompt=aiIntentPrompt('hi',ctx);
  assert.ok(!prompt.includes('CC333'));assert.ok(!prompt.includes('telegram_user_id'));
  ctx.groupFrozenIds.add('a');
  await assert.rejects(interpretAi({text:'hi',context:ctx,gateway:createAiGateway(),generate:()=>assert.fail('must not call')}),{code:'ACTOR_FROZEN'});
});
test('AI cannot bypass ambiguous source name by inventing a split between both candidates',async()=>{
 const ctx=context();ctx.currentMemberIds.add('c');ctx.users[1].aliases=['رفیق'];ctx.users[2].aliases=['رفیق'];
 const result=await interpretAi({text:'هی دنگی شام 600 تومان، بین من و رفیق',context:ctx,gateway:createAiGateway(),generate:async()=>({
   text:encoded('#DONGI invoice "شام" 600\nbetween: me BB222 CC333')})});
 assert.equal(result.kind,'CLARIFY');assert.equal(result.preview,undefined);
});
