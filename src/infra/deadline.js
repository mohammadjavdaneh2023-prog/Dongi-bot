// Also bounds providers/adapters that fail to honor AbortSignal themselves.
export async function withSignal(signal, work) {
 if(signal?.aborted) throw Object.assign(new Error('TIMEOUT'),{code:'AI_CORE_TIMEOUT'});
 let listener;
 const aborted=new Promise((_,reject)=>{
  listener=()=>reject(Object.assign(new Error('TIMEOUT'),{code:'AI_CORE_TIMEOUT'}));
  signal?.addEventListener('abort',listener,{once:true});
 });
 try{return await Promise.race([Promise.resolve().then(work),aborted]);}
 finally{signal?.removeEventListener('abort',listener);}
}
