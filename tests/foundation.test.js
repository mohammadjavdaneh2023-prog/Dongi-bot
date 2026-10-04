import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTrigger } from '../src/bot/triggers.js';
import { loadConfig } from '../src/infra/config.js';
import { createLogger, newTraceId } from '../src/infra/logging.js';

const message = (text, extra = {}) => ({ kind: 'message', chatType: 'group', text, ...extra });
test('ordinary messages and lookalike hashtags are dropped', () => {
  for (const text of ['سلام', '#dongibot invoice', 'a#dongi', '#dongi_foo', '#dongiعلی', 'هی دنگیجان']) {
    assert.equal(classifyTrigger(message(text)), 'DROP');
  }
  assert.equal(classifyTrigger(message(undefined)), 'DROP');
});
test('deterministic trigger has priority and is case insensitive', () => {
  for (const text of ['#DONGI help', '#DoNgI', 'سلام #dongi help', 'هی دنگی #Dongi']) {
    assert.equal(classifyTrigger(message(text)), 'DETERMINISTIC');
  }
});
test('AI and verified reply routing', () => {
  assert.equal(classifyTrigger(message('هی دنگی سلام')), 'AI_CORE');
  assert.equal(classifyTrigger(message('سلام', { directReplyToBot: true })), 'REPLY');
  assert.equal(classifyTrigger(message('#DONGI help', { directReplyToBot: true })), 'DETERMINISTIC');
});
test('private, service and callback gates require explicit context', () => {
  for (const [kind, flag, route] of [['callback', 'ownedCallback', 'CALLBACK'], ['service', 'requiredServiceEvent', 'MEMBERSHIP']]) {
    assert.equal(classifyTrigger({ kind }), 'DROP');
    assert.equal(classifyTrigger({ kind, [flag]: true }), route);
  }
  assert.equal(classifyTrigger(message('#DONGI', { chatType: 'private' })), 'DROP');
  assert.equal(classifyTrigger(message('/start', { chatType: 'private', inPrivateFlow: true })), 'PRIVATE');
});
test('config rejects invalid limits without echoing values', () => {
  for (const value of ['0', '-1', '1.5', 'secret', '9007199254740992']) {
    assert.throws(() => loadConfig({ DATABASE_URL:'postgresql://localhost/dongi', APP_ENCRYPTION_KEY:'0'.repeat(64), GEMINI_API_KEY:'test-key', PORT: value }), { message: 'Invalid configuration: PORT' });
  }
  assert.equal(loadConfig({DATABASE_URL:'postgresql://localhost/dongi',APP_ENCRYPTION_KEY:'0'.repeat(64),GEMINI_API_KEY:'test-key'}).port, 3000);
});
test('logs correlate traces, omit raw content and write structured JSON to stdout', () => {
  const original=process.stdout.write;let raw='';process.stdout.write=value=>{raw+=value;return true;};
  try{
    const log=createLogger({logLevel:'INFO',appVersion:'test',appEnv:'test'});const trace=newTraceId();
    log('TRIGGER_MATCHED',trace,{stage:'GATE',text:'PRIVATE_TEXT',token:'SECRET',error_message:'SECRET'});
    assert.doesNotMatch(raw,/SECRET|PRIVATE_TEXT/);const row=JSON.parse(raw);assert.equal(row.trace_id,trace);assert.equal(row.service,'dongi');
  }finally{process.stdout.write=original;}
});
