import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerDecoration,extraSeeds} from '../src/bot/response-style.js';
import {catalog,validTemplate,seedResponses,renderResponse} from '../src/bot/responses.js';
import {openDatabase} from '../src/infra/db/database.js';

test('owner decoration obeys probability, success and deterministic gates',()=>{
 const args={event:'INVOICE_CREATED',role:'OWNER',deterministic:true};
 assert.equal(ownerDecoration({...args,random:()=>0.49}),true);
 assert.equal(ownerDecoration({...args,random:()=>0.5}),false);
 assert.equal(ownerDecoration({...args,hasPayload:false,random:()=>0.99}),true);
 for(const extra of [{role:'MEMBER'},{deterministic:false},{event:'AI_PREVIEW_CONFIRMED'},{event:'PARSE_FAILED'}])
  assert.equal(ownerDecoration({...args,...extra,random:()=>0}),false);
});
test('all bundled variants satisfy placeholders and seeds remain idempotent',t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());
 for(const [event,spec] of Object.entries(catalog))for(const template of spec.templates)assert.ok(validTemplate(event,template),event);
 seedResponses(db);const n=db.prepare('SELECT count(*) n FROM response_pool').get().n;seedResponses(db);
 assert.equal(db.prepare('SELECT count(*) n FROM response_pool').get().n,n);
 assert.ok(extraSeeds.INVOICE_CREATED.includes(renderResponse(db,'INVOICE_CREATED',{},'GENERAL',()=>0.999)));
 assert.ok(!db.prepare("SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='response_pool'").all().some(c=>c.name==='allow_ai_expansion'));
});
