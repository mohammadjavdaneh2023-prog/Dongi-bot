import {randomUUID} from 'node:crypto';
import {requireCondition} from '../domain/errors.js';
import {allocate} from '../domain/allocation.js';
import {parseBank} from '../bot/bank-parser.js';

const number=n=>n.toLocaleString('en-US');
const labels={CHARGE:'شارژ',REFUND:'برگشت وجه',SPEND:'خرج'};
const gcd=(a,b)=>b?gcd(b,a%b):a;
export function bankMembers(db,id){return db.prepare('SELECT m.*,u.public_id,u.canonical_name,u.status FROM bank_members m JOIN users u ON u.id=m.user_id WHERE m.bank_id=? ORDER BY u.public_id').all(id);}

export function operateBank(db,{actor,message,prepared,traceId,updateId}){
 requireCondition(db.isTransaction,'DB_TRANSACTION_FAILED');
 requireCondition(['group','supergroup'].includes(message.chat.type),'BANK_GROUP_ONLY');
 requireCondition(prepared?.updateId===updateId&&prepared.chatId===String(message.chat.id)&&prepared.actorId===actor?.id
  &&Date.now()>=prepared.verifiedAt&&Date.now()-prepared.verifiedAt<=60000,'MEMBERSHIP_CHECK_FAILED');
 requireCondition(actor?.status==='ACTIVE'&&actor.bot_started===1,'PERMISSION_DENIED');
 requireCondition(!db.prepare('SELECT 1 FROM group_restrictions WHERE telegram_chat_id=? AND user_id=? AND frozen=1').get(prepared.chatId,actor.id),'ACTOR_FROZEN');
 requireCondition(prepared.currentMemberIds.has(actor.id),'USER_NOT_IN_GROUP');
 const intent=parseBank(message.text);
 const admin=actor.role==='OWNER'||Boolean(db.prepare('SELECT 1 FROM group_roles WHERE telegram_chat_id=? AND user_id=?').get(prepared.chatId,actor.id));
 let bank;let members;
 if(intent.action==='create'){
  requireCondition(admin,'PERMISSION_DENIED');
 members=intent.members.map(m=>{const u=db.prepare('SELECT * FROM users WHERE public_id=? AND retired_at IS NULL').get(m.publicId);requireCondition(u,'UNKNOWN_USER');return {...u,user_id:u.id,weight:m.weight};}).sort((a,b)=>a.public_id.localeCompare(b.public_id));
  requireCondition(members.every(m=>prepared.currentMemberIds.has(m.user_id)),'BANK_MEMBER_ABSENT');
  requireCondition(members.every(m=>m.status==='ACTIVE'),'BANK_MEMBER_INACTIVE');
  const manager=members.find(m=>m.public_id===intent.manager);requireCondition(manager,'BANK_MANAGER_REQUIRED');
  const divisor=members.reduce((g,m)=>gcd(g,BigInt(m.weight)),0n);
  for(const m of members)m.weight=Number(BigInt(m.weight)/divisor);
  const signature=JSON.stringify({manager:manager.user_id,members:members.map(m=>[m.user_id,m.weight])});
  const duplicate=db.prepare('SELECT id FROM banks WHERE signature=?').get(signature);
  requireCondition(!duplicate,'BANK_DUPLICATE',{addressed_as:duplicate?`B${duplicate.id}`:''});
  const inserted=db.prepare('INSERT INTO banks(name,manager_id,signature,created_by,created_at) VALUES (?,?,?,?,?) RETURNING id').run(intent.name,manager.user_id,signature,actor.id,Date.now());
  bank=db.prepare('SELECT * FROM banks WHERE id=?').get(Number(inserted.lastInsertRowid));
  for(const m of members)db.prepare('INSERT INTO bank_members VALUES (?,?,?)').run(bank.id,m.user_id,m.weight);
 }else{
  bank=db.prepare('SELECT * FROM banks WHERE id=?').get(intent.bankId);requireCondition(bank,'BANK_NOT_FOUND');
  members=bankMembers(db,bank.id);
  requireCondition(admin||bank.manager_id===actor.id||(intent.action==='report'&&members.some(m=>m.user_id===actor.id)),'PERMISSION_DENIED');
  requireCondition(members.every(m=>prepared.currentMemberIds.has(m.user_id)),'BANK_MEMBER_ABSENT');
 }
 if(intent.action==='report')return {event:'BANK_REPORT',text:bankReport(db,bank,members,intent.page)};
 requireCondition(members.every(m=>m.status!=='SUSPENDED'),'BANK_MEMBER_INACTIVE');
 const kind={create:'CHARGE',charge:'CHARGE',refund:'REFUND',spend:'SPEND'}[intent.action];
 const next=BigInt(bank.balance)+(kind==='CHARGE'?1n:-1n)*BigInt(intent.amount);
 requireCondition(next>=0n,'BANK_INSUFFICIENT');requireCondition(next<=BigInt(Number.MAX_SAFE_INTEGER),'INVALID_AMOUNT');
 const amountShares=allocate(intent.amount,'WEIGHTED',members.map(m=>String(m.weight)));
 const now=Date.now();const reason=intent.action==='create'?'شارژ اولیه':intent.reason;
 const result=db.prepare('INSERT INTO bank_transactions(bank_id,kind,amount,reason,balance_after,actor_id,chat_id,message_id,created_at) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id')
  .run(bank.id,kind,intent.amount,reason,Number(next),actor.id,String(message.chat.id),message.message_id,now);
 const transactionId=Number(result.lastInsertRowid);
 members.forEach((m,i)=>db.prepare('INSERT INTO bank_receipts VALUES (?,?,?)').run(transactionId,m.user_id,amountShares[i]));
 db.prepare('UPDATE banks SET balance=? WHERE id=?').run(Number(next),bank.id);
 db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?,?)').run(randomUUID(),'BANK_'+kind,actor.id,actor.id,traceId,
  JSON.stringify({bank_id:bank.id,transaction_id:transactionId,kind,amount:intent.amount,reason,before:bank.balance,after:Number(next),created:intent.action==='create'}),now);
 const manager=members.find(m=>m.user_id===bank.manager_id);
 return {event:'BANK_CHANGED',text:[`بانک B${bank.id} — ${bank.name}`,`رسید T${transactionId} | ${labels[kind]}: ${number(intent.amount)} تومان`,
  `دلیل: ${reason}`,`مسئول: ${manager.canonical_name} [${manager.public_id}]`,
  ...members.map((m,i)=>`${m.canonical_name} [${m.public_id}] | سهم ${m.weight} | ${labels[kind]}: ${number(amountShares[i])} تومان`),
  `موجودی: ${number(Number(next))} تومان`,'این گردش در دفتر مستقل بانک ثبت شد؛ انتقال وجه واقعی توسط ربات انجام نمی‌شود.'].join('\n')};
}

function bankReport(db,bank,members,page){
 const manager=members.find(m=>m.user_id===bank.manager_id);
 const lines=[`بانک B${bank.id} — ${bank.name}`,`موجودی: ${number(bank.balance)} تومان`,`مسئول: ${manager.canonical_name} [${manager.public_id}]`];
 for(const m of members){
  const totals={CHARGE:0n,REFUND:0n,SPEND:0n};
  for(const r of db.prepare('SELECT t.kind,r.amount FROM bank_receipts r JOIN bank_transactions t ON t.id=r.transaction_id WHERE t.bank_id=? AND r.user_id=?').all(bank.id,m.user_id))totals[r.kind]+=BigInt(r.amount);
  lines.push(`${m.canonical_name} [${m.public_id}] | سهم ${m.weight} | شارژ ${number(totals.CHARGE)} | برگشت ${number(totals.REFUND)} | خرج ${number(totals.SPEND)} | ماندهٔ سهم ${number(totals.CHARGE-totals.REFUND-totals.SPEND)} تومان`);
 }
 const rows=db.prepare('SELECT t.*,u.public_id FROM bank_transactions t JOIN users u ON u.id=t.actor_id WHERE bank_id=? ORDER BY t.id DESC LIMIT 11 OFFSET ?').all(bank.id,(page-1)*10);
 for(const r of rows.slice(0,10))lines.push(`T${r.id} | ${labels[r.kind]} ${number(r.amount)} تومان | ${r.reason} | عامل ${r.public_id} | ${new Date(r.created_at).toISOString()}`);
 lines.push(`صفحه ${page}`);if(rows.length>10)lines.push(`#DONGI bank report B${bank.id} ${page+1}`);
 return lines.join('\n');
}
