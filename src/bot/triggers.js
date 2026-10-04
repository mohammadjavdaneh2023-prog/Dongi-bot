// Trust flags must come from the adapter's verified context, never message text.
const deterministic = /(?<![\p{L}\p{N}_])#dongi(?![\p{L}\p{N}_])/iu;
const intelligent = /(?<![\p{L}\p{N}_])هی\s+دنگی(?![\p{L}\p{N}_])/u;

export function classifyTrigger(input) {
  if (input.kind === 'service') return input.requiredServiceEvent === true ? 'MEMBERSHIP' : 'DROP';
  if (input.kind === 'callback') return input.ownedCallback === true ? 'CALLBACK' : 'DROP';
  if (input.kind !== 'message') return 'DROP';
  if (input.chatType === 'private') return input.inPrivateFlow === true ? 'PRIVATE' : 'DROP';
  if (!['group', 'supergroup'].includes(input.chatType)) return 'DROP';
  const text = typeof input.text === 'string' ? input.text : '';
  if (deterministic.test(text)) return 'DETERMINISTIC';
  if (intelligent.test(text)) return 'AI_CORE';
  if (input.directReplyToBot === true) return 'REPLY';
  return 'DROP';
}
