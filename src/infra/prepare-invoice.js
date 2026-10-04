import { parseInvoice } from '../bot/invoice-parser.js';
import { buildInvoice } from '../domain/invoices.js';
import { DomainError, requireCondition } from '../domain/errors.js';
import { invoiceContext } from '../repositories/invoices.js';
import { parseSettlement } from '../bot/settlement-parser.js';
import { parseDetails } from '../repositories/details.js';
import {syncActorAdmin} from './group-admin.js';

export async function prepareInvoice(db, telegram, update) {
  const message = update.message;
  const report = message?.text?.trim().match(/^#dongi\s+(balance|settle-plan)\s*$/i);
  const settle = /^#dongi\s+settle\s/i.test(message?.text?.trim() ?? '');
  const details = /^#dongi\s+details\b/i.test(message?.text?.trim() ?? '');
  const lifecycle = /^#dongi\s+(void|restore)\b/i.test(message?.text?.trim() ?? '');
  if (!report && !settle && !details && !lifecycle && !/^#dongi\s+invoice\b/i.test(message?.text?.trim() ?? '')) return undefined;
  try {
    requireCondition(['group', 'supergroup'].includes(message.chat.type) || ((details || lifecycle) && message.chat.type === 'private'), report ? 'REPORT_GROUP_ONLY' : 'INVOICE_GROUP_ONLY');
    requireCondition(Number.isSafeInteger(message.from?.id) && !message.from.is_bot && !message.sender_chat, 'PERMISSION_DENIED');
    if (db.prepare('SELECT update_id FROM processed_updates WHERE update_id = ? OR (chat_id = ? AND message_id = ?)')
      .get(update.update_id, String(message.chat.id), message.message_id)) return undefined;
    const context = invoiceContext(db, message);
    const intent = details || lifecycle ? parseDetails(db,message) : report ? { intent: report[1].toLowerCase() } : settle ? parseSettlement(message.text) : parseInvoice(message.text);
    const actor = context.users.find(user => user.id === context.actorId);
    const personalRead=details && message.chat.type==='private';
    requireCondition(actor && (personalRead || actor.status !== 'SUSPENDED'), 'PERMISSION_DENIED');
    requireCondition(personalRead || (actor.status !== 'FROZEN' && !context.groupFrozenIds.has(actor.id)), 'ACTOR_FROZEN');
    requireCondition(actor.bot_started === 1, 'USER_NOT_STARTED');
    if (lifecycle && actor.role !== 'OWNER') {
      if(['group','supergroup'].includes(message.chat.type)) await syncActorAdmin(db,telegram,message,actor);
      const source=db.prepare('SELECT source_chat_id,created_by_user_id FROM invoices WHERE id=?').get(intent.invoiceId);
      requireCondition(message.chat.type !== 'private' && source.source_chat_id===String(message.chat.id)
        && ((intent.intent==='void' && source.created_by_user_id===actor.id)
          || db.prepare('SELECT 1 FROM group_roles WHERE telegram_chat_id=? AND user_id=?').get(String(message.chat.id),actor.id)),'PERMISSION_DENIED');
    }
    if ((details || lifecycle) && message.chat.type === 'private') return { intent, currentMemberIds:new Set(), verifiedAt:Date.now(),updateId:update.update_id,chatId:String(message.chat.id) };
    const provisional = lifecycle ? {entries:[]} : details ? {entries:db.prepare('SELECT user_id FROM invoice_entries WHERE invoice_id=?').all(intent.invoiceId)}
      : report ? { entries: [] } : buildInvoice(intent, { ...context, currentMemberIds: new Set(context.users.map(user => user.id)) });
    const usesAll = intent.positive?.all || intent.negative?.all;
    const required = new Set([context.actorId, ...provisional.entries.map(entry => entry.user_id)]);
    const candidates = context.users.filter(user => required.has(user.id) || ((report || usesAll) && user.bot_started && user.telegram_user_id && user.status !== 'SUSPENDED'));
    const currentMemberIds = new Set();
    const verifiedAt = Date.now();
    for (const user of candidates) {
      let member;
      try { member = await telegram.call('getChatMember', { chat_id: String(message.chat.id), user_id: Number(user.telegram_user_id) }); }
      catch { throw new DomainError('MEMBERSHIP_CHECK_FAILED', { public_id: user.public_id }); }
      requireCondition(member?.user?.id === Number(user.telegram_user_id), 'MEMBERSHIP_CHECK_FAILED');
      if (['creator','administrator','member'].includes(member.status) || (member.status === 'restricted' && member.is_member === true)) currentMemberIds.add(user.id);
    }
    return { intent, currentMemberIds, verifiedAt, updateId: update.update_id, chatId: String(message.chat.id) };
  } catch (error) {
    return { error: error instanceof DomainError ? error.code : 'INTERNAL_ERROR', details: error instanceof DomainError ? error.details : {} };
  }
}
