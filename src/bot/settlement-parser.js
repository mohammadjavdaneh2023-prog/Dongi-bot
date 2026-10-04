import { parseAmount } from '../domain/allocation.js';
import { requireCondition } from '../domain/errors.js';

export function parseSettlement(text) {
  const lines = text.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const header = lines.shift()?.match(/^#dongi\s+settle\s+(\S+)$/i);
  requireCondition(header, 'PARSE_FAILED');
  const amount = parseAmount(header[1]);
  const fields = {};
  for (const line of lines) {
    const match = line.match(/^(from|to|against)(?:\s*:\s*|\s+)(.+)$/i);
    requireCondition(match && fields[match[1].toLowerCase()] === undefined, 'PARSE_FAILED');
    fields[match[1].toLowerCase()] = match[2].trim();
  }
  requireCondition(fields.to, 'PARSE_FAILED');
  const name = value => {
    if (value.startsWith('"')) {
      requireCondition(/^"[^"\r\n]+"$/.test(value), 'PARSE_FAILED');
      return value.slice(1, -1);
    }
    requireCondition(!value.includes('"'), 'PARSE_FAILED');
    return value;
  };
  const against = fields.against?.split(/\s+/).map(ref => {
    requireCondition(/^#[1-9]\d*$/.test(ref) && Number.isSafeInteger(Number(ref.slice(1))), 'SETTLEMENT_TARGET_INVALID');
    return Number(ref.slice(1));
  });
  requireCondition(!against || new Set(against).size === against.length, 'SETTLEMENT_TARGET_INVALID');
  return { intent: 'CREATE_INVOICE', type: 'SETTLEMENT', title: 'تسویه حساب', amount, against,
    entries: [{ token: name(fields.from ?? 'me'), amount }, { token: name(fields.to), amount: -amount }] };
}
