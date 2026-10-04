import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInvoice } from '../src/bot/invoice-parser.js';
import { buildInvoice } from '../src/domain/invoices.js';

const users = ['Ali', 'Hasan', 'Reza'].map((name, index) => ({ id: String(index), public_id: ['AB123', 'CD456', 'EF789'][index], canonical_name: name,
  telegram_user_id: String(index + 1), status: 'ACTIVE', bot_started: 1, aliases: index === 0 ? ['علی جان'] : [] }));
const context = { users, actorId: '0', currentMemberIds: new Set(['0', '1', '2']) };
const build = text => buildInvoice(parseInvoice(text), context);
const amounts = invoice => Object.fromEntries(invoice.entries.map(entry => [entry.canonical_name, entry.amount]));

test('simple and shorthand invoices net payer consumption correctly', () => {
  for (const body of ['between: me Hasan Reza', 'me Hasan Reza', 'BETWEEN\nme\nHasan\nReza']) {
    const invoice = build(`#DoNgI invoice "غذا" 600\n${body}`);
    assert.deepEqual(amounts(invoice), { Ali: 400, Hasan: -200, Reza: -200 });
    assert.equal(invoice.gross_amount, 400);
  }
});
test('weighted, percent, exact shares and multiple payers follow spec', () => {
  assert.deepEqual(amounts(build('#DONGI invoice "x" 800\nbetween: me Hasan Reza×2')), { Ali: 600, Hasan: -200, Reza: -400 });
  assert.deepEqual(amounts(build('#DONGI invoice "x" 1000\nbetween:\nAli 20%\nHasan 30%\nReza 50%')), { Ali: 800, Hasan: -300, Reza: -500 });
  assert.deepEqual(amounts(build('#DONGI invoice "x" 780\nshare: Ali 180 Hasan 250 Reza 350')), { Ali: 600, Hasan: -250, Reza: -350 });
  assert.deepEqual(amounts(build('#DONGI invoice "x" 900\npaid: me 600 Hasan 300\nbetween: me Hasan Reza')), { Ali: 300, Hasan: 0, Reza: -300 });
});
test('zero entries and original aliases are retained, even all-zero invoices', () => {
  const invoice = build('#DONGI invoice "x" 200\nbetween: "علی جان"');
  assert.equal(invoice.entries.length, 1);
  assert.equal(invoice.entries[0].amount, 0);
  assert.equal(invoice.entries[0].open_amount, 0);
  assert.deepEqual(invoice.entries[0].input_names, ['me', 'علی جان']);
  assert.equal(invoice.gross_amount, 0);
});
test('all members and exclusions use stable public ID ordering', () => {
  assert.deepEqual(amounts(build('#DONGI invoice "x" 9\nbetween: all -Reza')), { Ali: 4, Hasan: -4 });
  assert.equal(build('#DONGI invoice "x" 1\nbetween: all').entries.length, 3);
});
test('direct ledger accepts explicit zero and rejects nonzero totals', () => {
  assert.deepEqual(amounts(build('#DONGI invoice "x"\nAli +100\nHasan -100\nReza 0')), { Ali: 100, Hasan: -100, Reza: 0 });
  assert.throws(() => build('#DONGI invoice "x"\nAli +100\nHasan -90'), { code: 'ZERO_SUM_FAILED' });
});
test('credit/debt DSL uses independent distributions', () => {
  assert.deepEqual(amounts(build('#DONGI invoice "x" 200\ncredit: Ali 10% Hasan 90%\ndebt: Reza')), { Ali: 20, Hasan: 180, Reza: -200 });
});
test('ambiguous grammar and duplicate resolved identities fail without guessing', () => {
  for (const body of ['between: Ali 20% Hasan', 'between: Ali*2 Hasan 50%', 'between: Ali\nbetween: Hasan', 'between: Ali\nshare: Hasan 20', 'paid: Ali 20']) {
    assert.throws(() => parseInvoice(`#DONGI invoice "x" 20\n${body}`), { code: 'PARSE_FAILED' });
  }
  assert.throws(() => build('#DONGI invoice "x" 20\nbetween: me "علی جان"'), { code: 'DUPLICATE_PARTICIPANT' });
});
test('eligibility applies even to zero entries; frozen targets remain participants', () => {
  const intent = parseInvoice('#DONGI invoice "x"\nAli +100\nHasan -100\nReza 0');
  assert.throws(() => buildInvoice(intent, { ...context, currentMemberIds: new Set(['0', '1']) }), { code: 'USER_NOT_IN_GROUP' });
  for (const [change, code] of [[{ status: 'SUSPENDED' }, 'TARGET_SUSPENDED'], [{ bot_started: 0 }, 'USER_NOT_STARTED']]) {
    assert.throws(() => buildInvoice(intent, { ...context, users: users.map(user => user.id === '2' ? { ...user, ...change } : user) }), { code });
  }
  assert.equal(buildInvoice(intent, { ...context, users: users.map(user => user.id === '2' ? { ...user, status: 'FROZEN' } : user) }).entries.length, 3);
  assert.throws(() => buildInvoice(intent, { ...context, groupFrozenIds: new Set(['0']) }), { code: 'ACTOR_FROZEN' });
});
