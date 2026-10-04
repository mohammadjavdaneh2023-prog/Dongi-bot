import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate, parseAmount } from '../src/domain/allocation.js';
import { resolveIdentity, normalizeIdentity } from '../src/domain/identity.js';

test('amount parser accepts all digit scripts without implicit thousands', () => {
  for (const text of ['600', '۶۰۰', '٦٠٠']) assert.equal(parseAmount(text), 600);
  for (const text of ['0', '-1', '1e3', '600 هزار', '1.5', '1,000', '9007199254740992']) {
    assert.throws(() => parseAmount(text), { code: 'INVALID_AMOUNT' });
  }
});
test('equal, weighted, percentage and exact allocations preserve the total', () => {
  assert.deepEqual(allocate(10, 'EQUAL', [null, null, null]), [4, 3, 3]);
  assert.deepEqual(allocate(800000, 'WEIGHTED', ['1', '1', '2']), [200000, 200000, 400000]);
  assert.deepEqual(allocate(100, 'PERCENTAGE', ['33.3', '33.3', '33.4']), [33, 33, 34]);
  assert.deepEqual(allocate(780000, 'EXACT_AMOUNT', ['180000', '250000', '350000']), [180000, 250000, 350000]);
  assert.deepEqual(allocate(3, 'WEIGHTED', ['۰.۵', '١.٥']), [1, 2]);
});
test('invalid totals and shares are rejected instead of guessed', () => {
  assert.throws(() => allocate(10, 'PERCENTAGE', ['20', '70']), { code: 'PERCENTAGE_TOTAL_INVALID' });
  assert.throws(() => allocate(10, 'EXACT_AMOUNT', ['3', '5']), { code: 'SHARE_TOTAL_MISMATCH' });
  for (const values of [[], ['0'], ['-1'], ['NaN'], ['1e3'], ['0.0000001']]) {
    assert.throws(() => allocate(10, 'WEIGHTED', values), { code: 'INVALID_SHARE' });
  }
});
test('allocation conservation holds across small totals and large integer boundaries', () => {
  for (const amount of [1, 2, 7, 101, 100000, Number.MAX_SAFE_INTEGER]) {
    for (let count = 1; count <= 20; count++) {
      const result = allocate(amount, 'WEIGHTED', Array.from({ length: count }, (_, i) => String(i + 1)));
      assert.equal(result.reduce((sum, value) => sum + BigInt(value), 0n), BigInt(amount));
      assert.ok(result.every(value => Number.isSafeInteger(value) && value >= 0));
    }
  }
});
const users = [
  { id: '1', public_id: 'AB417', canonical_name: 'محمد رضا', aliases: ['ممد'] },
  { id: '2', public_id: 'CD123', canonical_name: 'علی', aliases: ['علي جان'] },
];
test('identity resolution follows exact ID, name, alias then conservative normalization', () => {
  for (const token of ['AB417', 'محمد رضا', 'ممد', 'محمد‌رضا', 'محمدرضا']) {
    const result = resolveIdentity(token, users);
    assert.equal(result.user.id, '1'); assert.equal(result.addressed_as, token);
  }
  assert.equal(resolveIdentity('عَلي', users).user.id, '2');
  assert.equal(resolveIdentity('علی‌جان', users).user.id, '2');
  assert.equal(normalizeIdentity('كـي ۱۲٣'), 'کی123');
  assert.throws(() => resolveIdentity('محمدر', users), { code: 'UNKNOWN_USER' });
});
test('legacy ambiguity is rejected and exact canonical name outranks alias', () => {
  const conflicting = [...users, { id: '3', public_id: 'EF456', canonical_name: 'حسن', aliases: ['ممد', 'علی'] }];
  assert.throws(() => resolveIdentity('ممد', conflicting), { code: 'AMBIGUOUS_USER' });
  assert.equal(resolveIdentity('علی', conflicting).user.id, '2');
  const normalizedConflict = [...users, { id: '4', public_id: 'GH789', canonical_name: 'محمدرضا', aliases: [] }];
  assert.throws(() => resolveIdentity('محمد‌رضا', normalizedConflict), { code: 'AMBIGUOUS_USER' });
});
