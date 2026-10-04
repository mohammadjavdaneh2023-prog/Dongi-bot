import {parseAmount} from '../domain/allocation.js';
import {requireCondition} from '../domain/errors.js';

export function parseBank(text){
 requireCondition(typeof text==='string'&&text.length<=4096,'BANK_SYNTAX');
 const lines=text.trim().split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
 const create=lines[0]?.match(/^#dongi\s+bank\s+create\s+"([^"\r\n]{1,100})"\s+(\S+)$/i);
 if(create){
  requireCondition(lines.length===3&&create[1].trim(),'BANK_SYNTAX');
  const fields={};
  for(const line of lines.slice(1)){
   const m=line.match(/^(members|manager):\s*(.+)$/i);
   requireCondition(m&&!fields[m[1].toLowerCase()],'BANK_SYNTAX');fields[m[1].toLowerCase()]=m[2];
  }
  requireCondition(fields.members&&/^[A-Z]{2}[1-9][0-9]{2}$/.test(fields.manager??''),'BANK_SYNTAX');
  const members=fields.members.split(/\s+/).map(token=>{
   const m=token.match(/^([A-Z]{2}[1-9][0-9]{2})\*([0-9۰-۹٠-٩]+)$/);
   requireCondition(m,'BANK_SYNTAX');return {publicId:m[1],weight:parseAmount(m[2])};
  });
  requireCondition(members.length>=1&&members.length<=32&&new Set(members.map(m=>m.publicId)).size===members.length,'BANK_SYNTAX');
  requireCondition(members.some(m=>m.publicId===fields.manager),'BANK_MANAGER_REQUIRED');
  return {action:'create',name:create[1].trim(),amount:parseAmount(create[2]),manager:fields.manager,members};
 }
 requireCondition(lines.length===1,'BANK_SYNTAX');
 const report=lines[0].match(/^#dongi\s+bank\s+report\s+B([1-9]\d*)(?:\s+([1-9]\d{0,5}))?$/i);
 if(report){requireCondition(Number.isSafeInteger(Number(report[1])),'BANK_SYNTAX');return {action:'report',bankId:Number(report[1]),page:Number(report[2]??1)};}
 const change=lines[0].match(/^#dongi\s+bank\s+(charge|refund|spend)\s+B([1-9]\d*)\s+(\S+)\s+"([^"\r\n]{1,200})"$/i);
 requireCondition(change&&Number.isSafeInteger(Number(change[2]))&&change[4].trim(),'BANK_SYNTAX');
 return {action:change[1].toLowerCase(),bankId:Number(change[2]),amount:parseAmount(change[3]),reason:change[4].trim()};
}
