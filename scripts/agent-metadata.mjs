import {claudeResult,claudeReportedModel} from './claude-stream.mjs';
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const lines=stdout=>stdout.split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);
const sum=(...values)=>values.every(v=>v!==null)?values.reduce((a,b)=>a+b,0):null;
export function readMetadata(agent,stdout){
 let usage=null,model=null;
 try{
  if(agent==='codex'){
   const events=lines(stdout),u=events.findLast(e=>e.type==='turn.completed')?.usage;
   if(u)usage={inputTokens:count(u.input_tokens),outputTokens:count(u.output_tokens),cachedTokens:count(u.cached_input_tokens),cacheWriteTokens:null,reasoningTokens:count(u.reasoning_output_tokens),totalTokens:count(u.total_tokens)??sum(count(u.input_tokens),count(u.output_tokens))};
   model=events.findLast(e=>typeof e.model==='string')?.model||null;
  }else if(agent==='claude'){
   const result=claudeResult(stdout)||{},u=result.usage;
   if(u){const cached=count(u.cache_read_input_tokens),created=count(u.cache_creation_input_tokens);const input=count(u.input_tokens)===null?null:u.input_tokens+(cached??0)+(created??0);
    usage={inputTokens:input,outputTokens:count(u.output_tokens),cachedTokens:cached,cacheWriteTokens:created,reasoningTokens:null,totalTokens:count(u.total_tokens)??sum(input,count(u.output_tokens))};}
   const models=result.modelUsage&&Object.keys(result.modelUsage);model=result.model||(models?.length===1?models[0]:null)||claudeReportedModel(stdout);
  }else{
   const events=lines(stdout),result=events.findLast(e=>e.event==='result')?.result,u=result?.usage;
   if(u)usage={inputTokens:count(u.input_tokens),outputTokens:count(u.output_tokens),cachedTokens:count(u.cache_read_tokens),cacheWriteTokens:null,reasoningTokens:count(u.thinking_tokens),totalTokens:count(u.total_tokens)??sum(count(u.input_tokens),count(u.output_tokens))};
   model=result?.model||events.find(e=>e.event==='init')?.init?.model||null;
  }
 }catch{}
 if(usage&&Object.values(usage).every(v=>v===null))usage=null;
 return {usage,actualModel:typeof model==='string'&&model.length<=160?model:null};
}
export function usageSummary(records){
 const result={};for(const agent of ['codex','claude','agy']){
  const jobs=records.filter(r=>r.agent===agent);const totals={},reports={};
  for(const key of ['inputTokens','outputTokens','cachedTokens','cacheWriteTokens','reasoningTokens','totalTokens']){const values=jobs.map(r=>r.usage?.[key]).filter(v=>Number.isSafeInteger(v)&&v>=0);reports[key]=values.length;totals[key]=values.length?values.reduce((a,b)=>a+b,0):null;}
  result[agent]={requests:jobs.length,reportedRequests:jobs.filter(j=>j.usage).length,unreportedRequests:jobs.filter(j=>!j.usage).length,...totals,reports};
 }return result;
}
