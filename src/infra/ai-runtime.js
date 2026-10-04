import {createGemini,createGeminiFallback} from './gemini.js';
import {createAiGateway} from './ai-gateway.js';
import {newTraceId} from './logging.js';

// Only models with validated financial proposals belong in this list.
export const coreModels=Object.freeze(['gemini-3.1-flash-lite','gemini-3.6-flash']);
export function createAiRuntime({apiKey,db,log=()=>{},provider=createGemini({apiKey})}){
 const safeLog=(...args)=>{try{log(...args);}catch{/* Logging must not change AI behavior. */}};
 const generate=createGeminiFallback(provider,coreModels,{db});
 const gateway=createAiGateway({timeoutMs:30000*coreModels.length});
 return {
  async generate(request){
   const trace=newTraceId();const started=performance.now();
   safeLog('AI_PROVIDER_REQUEST_STARTED',trace,{stage:'AI'});
   try{
    const response=await generate(request);
    safeLog('AI_PROVIDER_RESPONSE_RECEIVED',trace,{stage:'AI',ai_model:response.model,duration_ms:performance.now()-started});
    return response;
   }catch(error){
    safeLog(error.code==='AI_CORE_TIMEOUT'?'AI_TIMEOUT':'AI_PROVIDER_FAILED',trace,{stage:'AI',error_type:error.code??'AI_PROVIDER_ERROR',duration_ms:performance.now()-started},'ERROR');throw error;
   }
  },
  gateway:{async run(kind,task){
   const trace=newTraceId();safeLog('AI_GATEWAY_REQUESTED',trace,{stage:'AI',ai_class:kind});
   let accepted=false;
   try{
    const result=await gateway.run(kind,signal=>{accepted=true;safeLog('AI_GATEWAY_ACCEPTED',trace,{stage:'AI',ai_class:kind});return task(signal);});

    return result;
   }catch(error){if(!accepted)safeLog('AI_GATEWAY_REJECTED',trace,{stage:'AI',ai_class:kind,error_type:error.code});throw error;}
  }},
 };
}
