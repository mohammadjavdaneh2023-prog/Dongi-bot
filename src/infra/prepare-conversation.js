import { classifyTrigger } from '../bot/triggers.js';
import { dongiPersona } from '../bot/persona.js';

export async function conversationReply(ai,message,role='MEMBER') {
 if(!ai)return {conversationEvent:'INTERACTION_DISMISS'};
 try {
  const validate=text=>{
   const value=JSON.parse(text);
   if(!value||Object.keys(value).join(',')!=='text'||typeof value.text!=='string'||!value.text.trim()||value.text.length>1000||/[\u0000-\u0008]/.test(value.text))throw Object.assign(new Error('invalid'),{code:'AI_INVALID_OUTPUT'});
   return value;
  };
  const result=await ai.gateway.run('CONVERSATIONAL_AI',signal=>ai.generate({signal,
   validate,
   prompt:`${dongiPersona}\nActor role: ${role}\nReturn JSON {"text":"your response"}.\nMessage: ${JSON.stringify(message.text?.slice(0,4096))}\nReplied-to context: ${JSON.stringify(message.reply_to_message?.text?.slice(0,2000)??'')}`,
   schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}));
  const value=result.validated??validate(result.text);
  return {conversationText:value.text};
 }catch(error){return {conversationEvent:error.code==='AI_GATEWAY_BUSY'?'AI_GATEWAY_BUSY':'INTERACTION_DISMISS'};}
}

export async function prepareConversation(db,telegram,update,ai,bot,random=Math.random) {
 const message=update.message;
 if(!message||classifyTrigger({kind:'message',chatType:message.chat?.type,text:message.text,directReplyToBot:message.reply_to_message?.from?.id===bot.id})!=='REPLY')return;
 if(db.prepare('SELECT 1 FROM processed_updates WHERE update_id=? OR (chat_id=? AND message_id=?)').get(update.update_id,String(message.chat.id),message.message_id))return;
 const actor=db.prepare('SELECT * FROM users WHERE telegram_user_id=?').get(String(message.from?.id));
 if(!Number.isSafeInteger(message.from?.id)||message.from.is_bot||message.sender_chat||!actor?.bot_started||actor.status!=='ACTIVE')return {conversationEvent:'INTERACTION_DISMISS'};
 if(db.prepare('SELECT 1 FROM group_restrictions WHERE telegram_chat_id=? AND user_id=? AND frozen=1').get(String(message.chat.id),actor.id))return {conversationEvent:'INTERACTION_DISMISS'};
 if(random()>=0.1)return {conversationEvent:'INTERACTION_DISMISS'};
 try{
  const member=await telegram.call('getChatMember',{chat_id:String(message.chat.id),user_id:message.from.id});
  if(member?.user?.id!==message.from.id||!(['creator','administrator','member'].includes(member.status)||(member.status==='restricted'&&member.is_member)))return {conversationEvent:'INTERACTION_DISMISS'};
 }catch{return {conversationEvent:'INTERACTION_DISMISS'};}
 return conversationReply(ai,message,actor.role);
}
