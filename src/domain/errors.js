export class DomainError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function requireCondition(condition, code, details = {}) {
  if (!condition) throw new DomainError(code, details);
}
