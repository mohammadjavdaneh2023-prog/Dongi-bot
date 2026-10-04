import { classifyTrigger } from './triggers.js';
import { catalog, renderResponse, errorDetails } from './responses.js';
import { changeAlias } from '../domain/users/aliases.js';
import { DomainError } from '../domain/errors.js';
import { OnboardingService } from '../domain/users/onboarding.js';
import { IdentityRepository } from '../repositories/identity.js';
import { transaction } from '../infra/db/database.js';
import { newTraceId } from '../infra/logging.js';
import { buildInvoice } from '../domain/invoices.js';
import { invoiceContext, saveInvoice, saveSettlement, loadActiveInvoices } from '../repositories/invoices.js';
import { projectBalance, settlementPlan } from '../domain/balances.js';
import { loadDetails } from '../repositories/details.js';
import { applyNetting } from '../repositories/netting.js';
import { changeInvoiceLifecycle } from '../repositories/lifecycle.js';
import { manageUser } from '../repositories/management.js';
import { parseManagement } from '../infra/prepare-management.js';
import { privateRequest, dashboard } from './private-dashboard.js';
import { createPending, resolvePending } from '../repositories/ai-pending.js';
import { ownerDecoration } from './response-style.js';
import {operateBank} from '../repositories/banks.js';

const prefix = /^#dongi(?![\p{L}\p{N}_])/iu;
const safeId = value => Number.isSafeInteger(value);

export function createRouter({ db, cipher, bot, config, log, aiCredentials }) {
  // Logging failure must never turn a committed operation into a reported rollback.
  const safeLog = (...args) => { try { log(...args); } catch { process.stderr.write('LOG_WRITE_FAILED\n'); } };
  const render = (event, vars, role) => renderResponse(db, event, vars, role);
  const queue = (updateId, chatId, text, invoiceId = null, replyMarkup, replyTo) => {
    db.prepare('INSERT INTO response_outbox(update_id, encrypted_payload, invoice_id) VALUES (?, ?, ?)')
      .run(updateId, cipher.encrypt({ chat_id: String(chatId), text, link_preview_options: { is_disabled: true },...(replyTo?{reply_parameters:{message_id:replyTo}}:{}),...(replyMarkup?{reply_markup:replyMarkup}:{}) }),invoiceId);
  };

  return function route(update, preparedInvoice) {
    const message = update.message;
    if (!message || !safeId(update.update_id) || !safeId(message.message_id) || !safeId(message.chat?.id)) return { dropped: true };
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    const start = text.match(/^\/start(?:@([A-Za-z0-9_]+))?(?:\s+(\S+))?$/i);
    const addressedStart = start && (!start[1] || start[1].toLowerCase() === bot.username.toLowerCase());
    const privateView=message.chat.type==='private'?privateRequest(text):null;
    const privateAiKey=message.chat.type==='private'&&/^\/ai-key(?:@\w+)?(?:\s|$)/i.test(text);
    const routeKind = classifyTrigger({
      kind: 'message', chatType: message.chat.type, text,
      inPrivateFlow: Boolean(addressedStart || prefix.test(text) || privateView || privateAiKey),
      directReplyToBot: message.reply_to_message?.from?.id === bot.id,
    });
    if (routeKind === 'DROP') return { dropped: true };
    const traceId = newTraceId();
    const started = performance.now();
    const context = { telegram_update_id: update.update_id, chat_id: message.chat.id,
      message_id: message.message_id, stage: 'ROUTER', operation: routeKind };
    safeLog('TRIGGER_MATCHED', traceId, context);
    const findProcessed = () => db.prepare('SELECT * FROM processed_updates WHERE update_id = ? OR (chat_id = ? AND message_id = ?)')
      .get(update.update_id, String(message.chat.id), message.message_id);
    const saveResult = (event, responses) => {
      db.prepare('INSERT INTO processed_updates(update_id, chat_id, message_id, trace_id, event, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(update.update_id, String(message.chat.id), message.message_id, traceId, event, Date.now());
      for (const response of responses) queue(update.update_id, response.chatId, response.text,response.invoiceId,response.replyMarkup,
        String(response.chatId)===String(message.chat.id)?(message.response_to_message_id??message.message_id):undefined);
    };

    const execute = () => {
      if (!safeId(message.from?.id) || message.from.is_bot || message.sender_chat) throw new DomainError('PERMISSION_DENIED');
      const repository = new IdentityRepository(db, { participatesInTransaction: true });
      const service = new OnboardingService(repository, config);
      const actor = repository.byTelegram(String(message.from.id));
      const role = actor?.role ?? 'GENERAL';
      const response = (event, vars = {}) => ({ event, responses: [{ chatId: message.chat.id, text: render(event, vars, role) }] });
      if(privateAiKey){
        const result=aiCredentials.manage(message.from.id,text);
        const messages={AI_KEY_SAVED:'کلید AI شما با رمزگذاری ذخیره و فعال شد.',AI_KEY_DELETED:'کلید AI شما حذف شد.',
          AI_KEY_DISABLED:'کلید AI شما غیرفعال شد.',AI_KEY_ENABLED:'کلید AI شما فعال شد.',AI_KEY_ACTIVE:'کلید AI شما فعال است.',
          AI_KEY_INACTIVE:'کلید AI شما ذخیره است اما غیرفعال است.',AI_KEY_NOT_CONFIGURED:'هنوز کلید AI ثبت نکرده‌اید.',
          AI_KEY_INVALID:'کلید معتبر نیست.',AI_KEY_COMMAND_INVALID:'دستور نامعتبر است. از /ai-key status|set|enable|disable|delete استفاده کنید.',
          ONBOARDING_REQUIRED:'ابتدا Bot را Start کنید.'};
        return {event:result.code,responses:[{chatId:message.chat.id,text:messages[result.code]??messages.AI_KEY_COMMAND_INVALID}]};
      }
      if(preparedInvoice?.error)throw new DomainError(preparedInvoice.error,preparedInvoice.details);
      if(privateView) {
        const view=dashboard(db,actor,privateView);
        return {event:view.event,responses:[{chatId:message.chat.id,text:view.text,replyMarkup:view.replyMarkup}]};
      }
      if(preparedInvoice?.conversationText||preparedInvoice?.conversationEvent){
        if(preparedInvoice.conversationText)return {event:'CONVERSATION_READY',responses:[{chatId:message.chat.id,text:preparedInvoice.conversationText}]};
        return response(preparedInvoice.conversationEvent);
      }
      if (routeKind === 'AI_CORE' || /^#DONGI ai-(confirm|cancel) /i.test(text)) {
        if(preparedInvoice?.error)throw new DomainError(preparedInvoice.error);
        if(!preparedInvoice)return response('FEATURE_UNAVAILABLE');
        const linesFor=invoice=>[`${invoice.title} | ${invoice.type}`,...invoice.entries.map(e=>`${e.canonical_name} [${e.public_id}] ${e.amount>0?'+':''}${e.amount} تومان`)];
        if(preparedInvoice.aiAction){
          const result=resolvePending(db,{...preparedInvoice,action:preparedInvoice.aiAction,message,traceId});
          const resultResponse=response(result.event);
          if(result.invoice){
            resultResponse.responses[0].text+='\n#'+result.invoice.public_ref+'\n'+linesFor(result.invoice).join('\n');
            resultResponse.responses[0].invoiceId=result.invoice.id;
            if(result.nettingCount)resultResponse.responses[0].text+='\n'+render('NETTING_COMPLETED');
          }
          return resultResponse;
        }
        const proposal=preparedInvoice.proposal;
        if(!proposal?.intent)return response(proposal?.kind==='ADMIN_REJECTED'?'AI_ADMIN_REJECTED':proposal?.kind==='CHAT'?'AI_CHAT':'AI_CLARIFY');
        const pending=createPending(db,{proposal,message,verified:preparedInvoice.verified,traceId});
        const body=render('AI_PREVIEW_READY')+'\n'+(proposal.scaleNote??'مبلغ‌ها به تومان‌اند؛ پیش از تأیید بررسی کن.')+'\n'+proposal.command+'\n'+linesFor(pending.built).join('\n')+'\n'+pending.allocations.map(a=>`تخصیص ${pending.built.entries.find(e=>e.user_id===a.user_id).public_id}: ${a.amount} تومان`).join('\n');
        // All proposal rows must fit in the preview that the user actually confirms.
        if(body.length>3500)throw new DomainError('AI_INVALID_OUTPUT');
        return {event:'AI_PREVIEW_READY',responses:[{chatId:message.chat.id,text:body,replyMarkup:{inline_keyboard:[[
          {text:'تأیید',callback_data:`dai:confirm:${pending.token}`},{text:'لغو',callback_data:`dai:cancel:${pending.token}`}]]}}]};
      }
      if (routeKind === 'REPLY' && !prefix.test(text)) return response('INTERACTION_DISMISS');
      if (addressedStart && message.chat.type === 'private') {
        let user;
        if (start[2]) user = service.redeemGrant({ senderTelegramId: message.from.id, chatType: 'private', token: start[2], traceId });
        else if (actor?.role === 'OWNER') user = service.startOwner({ senderTelegramId: message.from.id, chatType: 'private', traceId });
        else if (actor?.bot_started) user = actor;
        else return response('ONBOARDING_REQUIRED');
        const result=response('PROFILE', { name: user.canonical_name, public_id: user.public_id, status: user.status });
        result.responses[0].replyMarkup=dashboard(db,user,{view:'profile',page:1}).replyMarkup;
        return result;
      }
      if (!prefix.test(text)) throw new DomainError('PARSE_FAILED');
      const command = text.replace(prefix, '').trim();
      if (/^help$/i.test(command)) return response('HELP');
      if(/^bank\b/i.test(command)){
        const result=operateBank(db,{actor,message,prepared:preparedInvoice,traceId,updateId:update.update_id});
        const responses=[];
        for(let i=0;i<result.text.length;i+=3500)responses.push({chatId:message.chat.id,text:result.text.slice(i,i+3500)});
        return {event:result.event,responses};
      }
      if(/^(?:freeze\b|unfreeze\b|user\s+(?:suspend|activate)\b)/i.test(command)) {
        if(preparedInvoice?.error) throw new DomainError(preparedInvoice.error,preparedInvoice.details);
        const intent=parseManagement(text);
        if(!preparedInvoice||preparedInvoice.updateId!==update.update_id||preparedInvoice.chatId!==String(message.chat.id)
          ||Date.now()-preparedInvoice.verifiedAt>60000) throw new DomainError('MEMBERSHIP_CHECK_FAILED');
        const changed=manageUser(db,{actor,message,intent,currentMemberIds:preparedInvoice.currentMemberIds,traceId});
        return response(changed.event,{name:changed.user.canonical_name,public_id:changed.user.public_id,scope:changed.scope});
      }
      if (/^(void|restore)\b/i.test(command)) {
        if(preparedInvoice?.error) throw new DomainError(preparedInvoice.error,preparedInvoice.details);
        const action=command.split(/\s/)[0].toLowerCase();
        if(!preparedInvoice || preparedInvoice.intent?.intent!==action || preparedInvoice.updateId!==update.update_id
          || preparedInvoice.chatId!==String(message.chat.id) || Date.now()-preparedInvoice.verifiedAt>60000) throw new DomainError('MEMBERSHIP_CHECK_FAILED');
        const changed=changeInvoiceLifecycle(db,{actor,message,invoiceId:preparedInvoice.intent.invoiceId,action,traceId,currentMemberIds:preparedInvoice.currentMemberIds});
        // Restoring active financial truth may reintroduce opposite open items.
        if(action==='restore') applyNetting(db,changed.id,actor.id,traceId);
        return {event:changed.event,responses:[{chatId:message.chat.id,text:render(changed.event,{invoice_ref:`#${changed.public_ref}`}),invoiceId:changed.id}]};
      }
      if (/^details\b/i.test(command)) {
        if (preparedInvoice?.error) throw new DomainError(preparedInvoice.error,preparedInvoice.details);
        if (!preparedInvoice || preparedInvoice.intent?.intent !== 'details' || preparedInvoice.updateId !== update.update_id
          || preparedInvoice.chatId !== String(message.chat.id) || Date.now()-preparedInvoice.verifiedAt > 60000) throw new DomainError('MEMBERSHIP_CHECK_FAILED');
        if (!actor || (message.chat.type!=='private' && actor.status === 'SUSPENDED')) throw new DomainError('PERMISSION_DENIED');
        if (message.chat.type!=='private' && actor.status === 'FROZEN') throw new DomainError('ACTOR_FROZEN');
        if (!actor.bot_started) throw new DomainError('USER_NOT_STARTED');
        const invoice = loadDetails(db,preparedInvoice.intent.invoiceId);
        if (message.chat.type === 'private') {
          if (actor.role !== 'OWNER' && invoice.created_by_user_id!==actor.id && !invoice.entries.some(entry=>entry.user_id===actor.id)) throw new DomainError('PERMISSION_DENIED');
        } else {
          const ctx=invoiceContext(db,message);
          if (ctx.groupFrozenIds.has(actor.id)) throw new DomainError('ACTOR_FROZEN');
          if (!preparedInvoice.currentMemberIds.has(actor.id)) throw new DomainError('USER_NOT_IN_GROUP');
          const eligible=new Set(ctx.users.filter(user=>user.bot_started && user.status!=='SUSPENDED' && preparedInvoice.currentMemberIds.has(user.id)).map(user=>user.id));
          if (!invoice.entries.every(entry=>eligible.has(entry.user_id))) throw new DomainError('INVOICE_NOT_VISIBLE');
        }
        const number=value=>`${value>0?'+':''}${value.toLocaleString('en-US')}`;
        const lines=[render('DETAILS_READY'),`#${invoice.public_ref} — ${invoice.title}`,`نوع: ${invoice.type}`,
          `وضعیت: ${invoice.lifecycle_status} / ${invoice.settlement_state}`,`نسخه: ${invoice.revision}`,
          ...invoice.entries.map(entry=>`${entry.canonical_name} [${entry.public_id}] | اصل: ${number(entry.amount)} | باز: ${number(entry.open_amount)}`),
          `مبلغ فاکتور: ${invoice.gross_amount.toLocaleString('en-US')} تومان`,
          ...invoice.allocations.map(item=>`تخصیص ${item.public_id}: تسویه #${item.settlement_ref} → فاکتور #${item.target_ref} | ${item.amount.toLocaleString('en-US')} تومان | ${item.side}`),
          ...invoice.netting.map(item=>`تهاتر ${item.public_id}: طلب #${item.positive_ref} ↔ بدهی #${item.negative_ref} | ${item.amount.toLocaleString('en-US')} تومان`)];
        const output=lines.join('\n'); const responses=[];
        for(let i=0;i<output.length;i+=3500) responses.push({chatId:message.chat.id,text:output.slice(i,i+3500),invoiceId:invoice.id});
        return {event:'DETAILS_READY',responses};
      }
      if (/^(balance|settle-plan)$/i.test(command)) {
        if (preparedInvoice?.error) throw new DomainError(preparedInvoice.error, preparedInvoice.details);
        if (!preparedInvoice || preparedInvoice.updateId !== update.update_id || preparedInvoice.chatId !== String(message.chat.id)
          || preparedInvoice.intent?.intent !== command.toLowerCase() || Date.now() - preparedInvoice.verifiedAt > 60000) throw new DomainError('MEMBERSHIP_CHECK_FAILED');
        const ctx = invoiceContext(db, message);
        const user = ctx.users.find(item => item.id === ctx.actorId);
        if (!user || user.status === 'SUSPENDED') throw new DomainError('PERMISSION_DENIED');
        if (user.status === 'FROZEN' || ctx.groupFrozenIds.has(user.id)) throw new DomainError('ACTOR_FROZEN');
        if (!user.bot_started) throw new DomainError('USER_NOT_STARTED');
        if (!preparedInvoice.currentMemberIds.has(user.id)) throw new DomainError('USER_NOT_IN_GROUP');
        const balance = projectBalance(loadActiveInvoices(db), ctx.users, preparedInvoice.currentMemberIds);
        const plan = command.toLowerCase() === 'settle-plan' ? settlementPlan(balance.rows) : null;
        const event = plan ? (plan.length ? 'SETTLEMENT_PLAN_READY' : 'NO_SETTLEMENT_NEEDED') : 'BALANCE_READY';
        const lines = plan ? plan.map(row => `${row.from_name} [${row.from}] → ${row.to_name} [${row.to}]: ${row.amount.toLocaleString('en-US')} تومان`)
          : balance.rows.map(row => `${row.name} [${row.public_id}]  ${row.amount > 0n ? '+' : ''}${row.amount.toLocaleString('en-US')}`);
        if (!plan) lines.push('جمع: 0 تومان');
        lines.push(`فاکتورهای لحاظ‌شده: ${balance.included}`, `فاکتورهای مرتبطِ خارج از تراز: ${balance.excluded}`);
        const output = render(event) + '\n' + lines.join('\n');
        const responses = [];
        for (let i = 0; i < output.length; i += 3500) responses.push({ chatId: message.chat.id, text: output.slice(i, i + 3500) });
        return { event, responses };
      }
      if (/^alias\b/i.test(command)) {
        if(preparedInvoice?.error) throw new DomainError(preparedInvoice.error,preparedInvoice.details);
        if(actor?.role!=='OWNER' && (!preparedInvoice || preparedInvoice.updateId!==update.update_id || preparedInvoice.chatId!==String(message.chat.id))) throw new DomainError('MEMBERSHIP_CHECK_FAILED');
        const match = command.match(/^alias\s+(\S+)\s+(add|remove)\s+(.+)$/i);
        if (!match) throw new DomainError('PARSE_FAILED');
        const result = changeAlias(repository, { actorTelegramId: message.from.id, inputMode: 'DETERMINISTIC',
          publicId: match[1], action: match[2].toLowerCase(), alias: match[3], traceId, groupAccess:preparedInvoice });
        return response(result.event, { alias: result.alias, name: result.user.canonical_name, public_id: result.user.public_id });
      }
      if (/^(invoice|settle)(?:\s|$)/i.test(command)) {
        if (preparedInvoice?.error) throw new DomainError(preparedInvoice.error, preparedInvoice.details);
        if (!preparedInvoice || preparedInvoice.updateId !== update.update_id || preparedInvoice.chatId !== String(message.chat.id)
          || Date.now() - preparedInvoice.verifiedAt > 60000) throw new DomainError('MEMBERSHIP_CHECK_FAILED');
        const financialContext = invoiceContext(db, message);
        const built = buildInvoice(preparedInvoice.intent, { ...financialContext, currentMemberIds: preparedInvoice.currentMemberIds });
        const isSettlement = preparedInvoice.intent.type === 'SETTLEMENT';
        const invoice = isSettlement ? saveSettlement(db, built, preparedInvoice.intent.against, message, financialContext.actorId, traceId)
          : saveInvoice(db, built, message, financialContext.actorId, traceId);
        const nettingCount=applyNetting(db,invoice.id,financialContext.actorId,traceId);
        const amountText = value => value === 0 ? '0' : `${value > 0 ? '+' : '-'}${Math.abs(value).toLocaleString('en-US')}`;
        const lines = [`🧾 #${invoice.public_ref} — ${invoice.title}`,
          ...invoice.entries.map(entry => `${entry.canonical_name} [${entry.public_id}]  ${amountText(entry.amount)}`),
          'جمع: 0 ✅', `مبلغ فاکتور: ${invoice.gross_amount.toLocaleString('en-US')} تومان`];
        const event = isSettlement ? 'SETTLEMENT_CREATED' : 'INVOICE_CREATED';
        if(nettingCount) lines.push(render('NETTING_COMPLETED'));
        const receipt = render(event,{},role) + '\n' + lines.join('\n');
        // Plain text chunks preserve all participants when a receipt exceeds Telegram's limit.
        const chunks = [];
        for (let i = 0; i < receipt.length; i += 3500) chunks.push({ chatId: message.chat.id, text: receipt.slice(i, i + 3500),invoiceId:invoice.id });
        return { event, responses: chunks };
      }
      if (/^user\b/i.test(command)) {
        const reissue=command.match(/^user\s+invite\s+(\S+)$/i);
        if(reissue){
          const result=service.reissueGrant({actorTelegramId:message.from.id,inputMode:'DETERMINISTIC',publicId:reissue[1],traceId});
          const invitation={chatId:message.from.id,text:render('USER_INVITATION',{name:result.user.canonical_name,public_id:result.user.public_id,
            link:`https://t.me/${bot.username}?start=${result.token}`,expires:new Date(result.expiresAt).toISOString()},role)};
          return {event:'INVITATION_REISSUED',responses:message.chat.type==='private'?[invitation]:[invitation,{chatId:message.chat.id,text:render('INVITATION_REISSUED')}]};
        }
        const match = command.match(/^user\s+create\s+"([^"\r\n]+)"(?:\s+(\S+))?$/i);
        if (!match) throw new DomainError('PARSE_FAILED');
        const result = service.createUser({ actorTelegramId: message.from.id, inputMode: 'DETERMINISTIC', name: match[1], publicId: match[2], traceId });
        const vars = { name: result.user.canonical_name, public_id: result.user.public_id,
          link: `https://t.me/${bot.username}?start=${result.token}`, expires: new Date(result.expiresAt).toISOString() };
        const invitation = { chatId: message.from.id, text: render('USER_INVITATION', vars, role) };
        return { event: 'USER_CREATED', responses: message.chat.type === 'private' ? [invitation]
          : [invitation, { chatId: message.chat.id, text: render('USER_CREATED', vars, role) }] };
      }
      if (/^(invoice|settle|balance|settle-plan|details|void|restore|freeze|unfreeze|alias|settings)\b/i.test(command)) return response('FEATURE_UNAVAILABLE');
      throw new DomainError(command ? 'UNKNOWN_COMMAND' : 'PARSE_FAILED');
    };

    try {
      const result = transaction(db, () => {
        const duplicate = findProcessed();
        if (duplicate) {
          const pending = db.prepare('SELECT id FROM response_outbox WHERE update_id = ? AND sent_at IS NULL').get(duplicate.update_id);
          if (!pending) queue(duplicate.update_id, message.chat.id, render('DUPLICATE_REQUEST'),null,undefined,message.response_to_message_id??message.message_id);
          return { event: 'DUPLICATE_REQUEST', traceId: duplicate.trace_id };
        }
        safeLog('DB_TRANSACTION_STARTED', traceId, context);
        const outcome = execute();
        const responseActor=db.prepare('SELECT role FROM users WHERE telegram_user_id=?').get(String(message.from?.id));
        if(ownerDecoration({event:outcome.event,role:responseActor?.role,
          deterministic:prefix.test(text)&&!/^#DONGI ai-/i.test(text)})) {
          const first=outcome.responses[0];
          if(first)first.text=render('OWNER_SUCCESS',{},'OWNER')+'\n'+first.text;
        }
        saveResult(outcome.event, outcome.responses);
        return { event: outcome.event, traceId };
      });
      safeLog('DB_TRANSACTION_COMMITTED', traceId, context);
      safeLog('REQUEST_COMPLETED', traceId, { ...context, duration_ms: performance.now() - started, result: result.event });
      return result;
    } catch (error) {
      const event = error instanceof DomainError && catalog[error.code] ? error.code : 'INTERNAL_ERROR';
      safeLog('REQUEST_FAILED', traceId, { ...context, error_type: event }, 'ERROR');
      const detailText = error instanceof DomainError ? errorDetails(error.details) : '';
      const errorText = render(event, { trace_id: traceId }) + (detailText ? '\n' + detailText : '');
      try {
        transaction(db, () => {
          // Never replace a result already committed by another worker.
          if (!findProcessed()) saveResult(event, [{ chatId: message.chat.id, text: errorText }]);
        });
        return { event, traceId };
      } catch {
        // DB unavailable: caller must attempt a direct fallback and leave offset unchanged on send failure.
        return { event, traceId, fallback: { chat_id: String(message.chat.id), text: errorText,reply_parameters:{message_id:message.response_to_message_id??message.message_id} } };
      }
    }
  };
}
