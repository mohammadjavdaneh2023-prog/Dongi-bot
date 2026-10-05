import { requireCondition } from '../domain/errors.js';
import { renderResponse } from './responses.js';

const views = { 'بانک‌های من':'banks', 'حساب من':'balance', 'ریزحساب باز':'open', 'تاریخچه':'history', 'فاکتورهای من':'invoices', 'پروفایل من':'profile', 'نام‌های مستعار':'aliases', 'راهنما':'help' };
const labels = { banks:'بانک‌های من',balance:'حساب من',open:'ریزحساب باز',history:'تاریخچه',invoices:'فاکتورهای من',profile:'پروفایل من',aliases:'نام‌های مستعار',help:'راهنما' };

export function privateRequest(text,botUsername) {
  if (views[text]) return {view:views[text],page:1};
  if (text==='بستن منو') return {close:true};
  const menu=text.match(/^\/menu(?:@([A-Za-z0-9_]+))?$/i);
  if (menu && (!menu[1] || !botUsername || menu[1].toLowerCase()===botUsername.toLowerCase())) return {view:'profile',page:1};
  if (!/^\/my(?:\s|$)/i.test(text)) return null;
  const match=text.match(/^\/my(?:\s+(banks|balance|open|history|invoices|profile|aliases|help))?(?:\s+([1-9]\d{0,5}))?$/i);
  return match ? {view:(match[1]??'profile').toLowerCase(),page:Number(match[2]??1)} : {invalid:true};
}

export function dashboard(db,actor,request) {
  requireCondition(actor?.bot_started===1,'ONBOARDING_REQUIRED');
  requireCondition(!request.invalid,'PARSE_FAILED');
  const {view,page}=request;
  const lines=[renderResponse(db,'PRIVATE_VIEW_READY'),labels[view]];
  const limit=8;const offset=(page-1)*limit;let hasNext=false;
  const sign=value=>`${value>0n?'+':''}${value.toLocaleString('en-US')}`;
  if(view==='balance') {
    const entries=db.prepare(`SELECT e.amount,e.open_amount FROM invoice_entries e JOIN invoices i ON i.id=e.invoice_id
      WHERE e.user_id=? AND i.lifecycle_status='ACTIVE'`).all(actor.id);
    const net=entries.reduce((sum,row)=>sum+BigInt(row.amount),0n);
    const credit=entries.filter(row=>row.open_amount>0).reduce((sum,row)=>sum+BigInt(row.open_amount),0n);
    const debt=entries.filter(row=>row.open_amount<0).reduce((sum,row)=>sum-BigInt(row.open_amount),0n);
    lines.push(`ماندهٔ خالص سراسری: ${sign(net)} تومان`,`طلب باز: ${credit.toLocaleString('en-US')} تومان`,`بدهی باز: ${debt.toLocaleString('en-US')} تومان`);
  } else if(view==='profile') {
    lines.push(`${actor.canonical_name} [${actor.public_id}]`,`وضعیت سراسری: ${actor.status}`,`Telegram ID: ${actor.telegram_user_id}`,'Start: بله');
  } else if(view==='help') {
    lines.push(renderResponse(db,'PRIVATE_HELP'));
  } else {
    let rows=[];
    if(view==='banks') {
      rows=db.prepare('SELECT b.id,b.name,m.weight FROM banks b JOIN bank_members m ON m.bank_id=b.id WHERE m.user_id=? ORDER BY b.id LIMIT ? OFFSET ?').all(actor.id,limit+1,offset);
      hasNext=rows.length>limit;
      for(const bank of rows.slice(0,limit)){
        const totals={CHARGE:0n,REFUND:0n,SPEND:0n};
        for(const r of db.prepare('SELECT t.kind,r.amount FROM bank_receipts r JOIN bank_transactions t ON t.id=r.transaction_id WHERE t.bank_id=? AND r.user_id=?').all(bank.id,actor.id))totals[r.kind]+=BigInt(r.amount);
        lines.push(`B${bank.id} — ${bank.name} | وزن سهم: ${bank.weight}\nشارژ من: ${totals.CHARGE} | برگشت من: ${totals.REFUND} | خرج سهم من: ${totals.SPEND} تومان\nگزارش در گروه: #DONGI bank report B${bank.id}`);
      }
    } else if(view==='aliases') {
      rows=db.prepare('SELECT alias FROM user_aliases WHERE user_id=? ORDER BY id LIMIT ? OFFSET ?').all(actor.id,limit+1,offset);
      hasNext=rows.length>limit;lines.push(...rows.slice(0,limit).map(row=>row.alias));
    } else if(view==='open') {
      rows=db.prepare(`SELECT i.public_ref,i.title,e.open_amount FROM invoice_entries e JOIN invoices i ON i.id=e.invoice_id
        WHERE e.user_id=? AND i.lifecycle_status='ACTIVE' AND e.open_amount!=0 ORDER BY i.created_at DESC,i.public_ref DESC LIMIT ? OFFSET ?`).all(actor.id,limit+1,offset);
      hasNext=rows.length>limit;lines.push(...rows.slice(0,limit).map(row=>`#${row.public_ref} — ${row.title}\nباز: ${sign(BigInt(row.open_amount))} تومان`));
    } else if(view==='invoices') {
      rows=db.prepare('SELECT public_ref,title,type,lifecycle_status FROM invoices WHERE created_by_user_id=? ORDER BY created_at DESC,public_ref DESC LIMIT ? OFFSET ?').all(actor.id,limit+1,offset);
      hasNext=rows.length>limit;lines.push(...rows.slice(0,limit).map(row=>`#${row.public_ref} — ${row.title} | ${row.type} | ${row.lifecycle_status}`));
    } else if(view==='history') {
      rows=db.prepare(`SELECT id,event,created_at,metadata_json::jsonb->>'public_ref' AS public_ref FROM audit_events a
        WHERE actor_user_id=? OR target_user_id=? OR EXISTS (
          SELECT 1 FROM invoice_entries e WHERE e.user_id=? AND e.invoice_id=metadata_json::jsonb->>'invoice_id')
        ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(actor.id,actor.id,actor.id,limit+1,offset);
      hasNext=rows.length>limit;lines.push(...rows.slice(0,limit).map(row=>`${new Date(row.created_at).toISOString()} | ${row.event}${row.public_ref?` | #${row.public_ref}`:''}`));
    }
    if(!rows.length)lines.push(renderResponse(db,'PRIVATE_LIST_EMPTY'));
    lines.push(`صفحه: ${page}`);
  }
  const keyboard=[['حساب من','ریزحساب باز'],['تاریخچه','فاکتورهای من'],['پروفایل من','نام‌های مستعار'],['بانک‌های من','راهنما'],['بستن منو']];
  const navigation=[];
  if(page>1)navigation.push(`/my ${view} ${page-1}`);
  if(hasNext)navigation.push(`/my ${view} ${page+1}`);
  if(navigation.length)keyboard.unshift(navigation);
  return {event:'PRIVATE_VIEW_READY',text:lines.join('\n'),replyMarkup:{keyboard,resize_keyboard:true,is_persistent:false}};
}
