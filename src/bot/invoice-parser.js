import { parseAmount } from '../domain/allocation.js';
import { requireCondition } from '../domain/errors.js';

const failUnless = value => requireCondition(value, 'PARSE_FAILED');

function tokens(text) {
  const result = [];
  const pattern = /\s*(?:"([^"\r\n]+)"|([^\s"*×:%]+)|([*×:%]))/gy;
  let position = 0;
  while (position < text.length) {
    pattern.lastIndex = position;
    const match = pattern.exec(text);
    failUnless(match);
    result.push({ value: match[1] ?? match[2] ?? match[3], quoted: match[1] !== undefined });
    position = pattern.lastIndex;
  }
  return result;
}

function parseSide(text, exact = false) {
  const list = tokens(text.trim());
  failUnless(list.length);
  if (!exact && !list[0].quoted && list[0].value.toLowerCase() === 'all') {
    const exclusions = [];
    for (let i = 1; i < list.length; i++) {
      const item = list[i];
      failUnless(!item.quoted && item.value.startsWith('-'));
      const name = item.value.slice(1) || list[++i]?.value;
      failUnless(name);
      exclusions.push(name);
    }
    return { mode: 'EQUAL', all: true, exclusions, members: [] };
  }
  const members = [];
  let hasWeights = false;
  let hasPercentages = false;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    failUnless(!['*', '×', '%', ':'].includes(item.value));
    const member = { token: item.value, value: '1' };
    if (exact) {
      const number = list[++i];
      failUnless(number && !number.quoted);
      parseAmount(number.value);
      member.value = number.value;
    } else if (['*', '×'].includes(list[i + 1]?.value)) {
      i += 2;
      failUnless(list[i] && !list[i].quoted);
      member.value = list[i].value;
      hasWeights = true;
    } else if (list[i + 2]?.value === '%') {
      failUnless(!list[i + 1].quoted);
      member.value = list[i + 1].value;
      member.percentage = true;
      hasPercentages = true;
      i += 2;
    }
    members.push(member);
  }
  failUnless(!(hasWeights && hasPercentages));
  if (hasPercentages) failUnless(members.every(member => member.percentage));
  return { mode: exact ? 'EXACT_AMOUNT' : hasPercentages ? 'PERCENTAGE' : hasWeights ? 'WEIGHTED' : 'EQUAL', members };
}

export function parseInvoice(text) {
  failUnless(typeof text === 'string' && text.length <= 4096);
  const lines = text.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const header = lines.shift()?.match(/^#dongi\s+invoice\s+"([^"\r\n]+)"(?:\s+(\S+))?$/i);
  failUnless(header && header[1].trim() && header[1].length <= 200 && lines.length);
  const intent = { intent: 'CREATE_INVOICE', title: header[1], input_mode: 'DETERMINISTIC' };
  if (header[2] === undefined) {
    const entries = lines.map(line => {
      const parts = tokens(line);
      failUnless(parts.length === 2 && !parts[1].quoted);
      const signed = parts[1].value.match(/^([+-]?)([0-9۰-۹٠-٩]+)$/);
      failUnless(signed);
      const zero = /^[0۰٠]+$/.test(signed[2]);
      failUnless(zero || signed[1]);
      return { token: parts[0].value, amount: zero ? 0 : (signed[1] === '-' ? -1 : 1) * parseAmount(signed[2]) };
    });
    return { ...intent, entries };
  }
  intent.amount = parseAmount(header[2]);
  const sections = {};
  let current;
  for (const line of lines) {
    const section = line.match(/^(paid|between|share|credit|debt)(?:\s*:\s*|\s+|$)(.*)$/i);
    if (section) {
      current = section[1].toLowerCase();
      failUnless(sections[current] === undefined);
      sections[current] = section[2];
    } else if (current) sections[current] += ` ${line}`;
    else {
      failUnless(lines.length === 1);
      sections.between = line;
    }
  }
  if ('credit' in sections || 'debt' in sections) {
    failUnless(Object.keys(sections).length === 2 && 'credit' in sections && 'debt' in sections);
    intent.positive = parseSide(sections.credit);
    intent.negative = parseSide(sections.debt);
  } else {
    failUnless(('between' in sections) !== ('share' in sections));
    intent.positive = sections.paid === undefined ? { mode: 'EXACT_AMOUNT', members: [{ token: 'me', value: String(intent.amount) }] } : parseSide(sections.paid, true);
    intent.negative = parseSide(sections.between ?? sections.share, 'share' in sections);
  }
  return intent;
}
