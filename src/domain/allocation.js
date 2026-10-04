import { requireCondition } from './errors.js';

const digits = value => value.replace(/[۰-۹٠-٩]/g, char => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(char) >= 0 ? '۰۱۲۳۴۵۶۷۸۹'.indexOf(char) : '٠١٢٣٤٥٦٧٨٩'.indexOf(char)));

export function parseAmount(text) {
  requireCondition(typeof text === 'string', 'INVALID_AMOUNT');
  const value = digits(text.trim());
  requireCondition(/^[0-9]+$/.test(value), 'INVALID_AMOUNT', { raw_amount: text });
  const amount = Number(value);
  requireCondition(Number.isSafeInteger(amount) && amount > 0, 'INVALID_AMOUNT', { raw_amount: text });
  return amount;
}

function fraction(value) {
  requireCondition(typeof value === 'string', 'INVALID_SHARE');
  const text = digits(value);
  requireCondition(/^\d+(?:\.\d{1,6})?$/.test(text) && text.length <= 30, 'INVALID_SHARE', { raw_amount: value });
  const [whole, decimal = ''] = text.split('.');
  const denominator = 10n ** BigInt(decimal.length);
  const numerator = BigInt(whole) * denominator + BigInt(decimal || '0');
  requireCondition(numerator > 0n, 'INVALID_SHARE', { raw_amount: value });
  return { numerator, denominator };
}

// Output position is input position. BigInt intermediates avoid rounding drift.
export function allocate(amount, mode, values) {
  requireCondition(Number.isSafeInteger(amount) && amount > 0, 'INVALID_AMOUNT');
  requireCondition(Array.isArray(values) && values.length > 0, 'INVALID_SHARE');
  requireCondition(['EQUAL', 'WEIGHTED', 'PERCENTAGE', 'EXACT_AMOUNT'].includes(mode), 'INVALID_SHARE');
  const total = BigInt(amount);
  if (mode === 'EXACT_AMOUNT') {
    const shares = values.map(parseAmount);
    const actual = shares.reduce((sum, value) => sum + BigInt(value), 0n);
    requireCondition(actual === total, 'SHARE_TOTAL_MISMATCH', { expected: String(total), actual: String(actual) });
    return shares;
  }
  const ratios = values.map(value => mode === 'EQUAL' ? { numerator: 1n, denominator: 1n } : fraction(value));
  const scale = ratios.reduce((max, ratio) => ratio.denominator > max ? ratio.denominator : max, 1n);
  const weights = ratios.map(ratio => ratio.numerator * (scale / ratio.denominator));
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (mode === 'PERCENTAGE') requireCondition(sum === 100n * scale, 'PERCENTAGE_TOTAL_INVALID', { expected: '100%', actual: `${sum}/${scale}%` });
  const shares = weights.map(weight => total * weight / sum);
  const remainders = weights.map((weight, index) => ({ index, remainder: total * weight % sum }));
  remainders.sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  const remaining = Number(total - shares.reduce((a, b) => a + b, 0n));
  for (let i = 0; i < remaining; i++) shares[remainders[i].index] += 1n;
  return shares.map(Number);
}
