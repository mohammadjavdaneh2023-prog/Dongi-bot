import { DomainError } from './errors.js';

export function normalizeIdentity(value) {
  return value.normalize('NFKC').toLowerCase().replace(/ي/g, 'ی').replace(/ك/g, 'ک')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[۰-۹٠-٩]/g, char => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(char) >= 0 ? '۰۱۲۳۴۵۶۷۸۹'.indexOf(char) : '٠١٢٣٤٥٦٧٨٩'.indexOf(char)))
    .replace(/[\s\u200c]+/g, '');
}

// Users and aliases are supplied by the repository; no fuzzy auto-selection.
export function resolveIdentity(token, users) {
  if (typeof token !== 'string' || !token.trim()) throw new DomainError('UNKNOWN_USER');
  const text = token.trim();
  const normalized = normalizeIdentity(text);
  const tiers = [
    user => user.public_id === text,
    user => user.canonical_name === text,
    user => (user.aliases ?? []).includes(text),
    user => normalizeIdentity(user.canonical_name) === normalized,
    user => (user.aliases ?? []).some(alias => normalizeIdentity(alias) === normalized),
  ];
  for (const matches of tiers) {
    const candidates = [...new Map(users.filter(matches).map(user => [user.id, user])).values()];
    if (candidates.length > 1) throw new DomainError('AMBIGUOUS_USER', { addressed_as: token, candidates: candidates.map(user => user.public_id).join(', ') });
    if (candidates.length === 1) return { user: candidates[0], addressed_as: token };
  }
  throw new DomainError('UNKNOWN_USER', { addressed_as: token });
}
