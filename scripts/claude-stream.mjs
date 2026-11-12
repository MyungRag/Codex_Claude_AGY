// Parse only public CLI event metadata. Never expose reasoning text or prompt
// fragments through job status or diagnostics.
export function claudeMessages(stdout){
 try{const value=JSON.parse(stdout);if(value&&typeof value==='object')return Array.isArray(value)?value:[value];}catch{}
 return stdout.split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
}
export function claudeResult(stdout){return claudeMessages(stdout).findLast(message=>message.type==='result'||Object.hasOwn(message,'is_error')||Object.hasOwn(message,'structured_output')||(!message.type&&Object.hasOwn(message,'usage')))||null;}
export function claudeReportedModel(stdout){
 const events=claudeMessages(stdout);
 for(let i=events.length-1;i>=0;i--){const item=events[i],model=item.model??item.message?.model??item.event?.message?.model;if(typeof model==='string'&&model.length<=160)return model;}
 return null;
}
export function observeClaudeStream(update){
 let buffer='',events=0;
 return chunk=>{
  buffer+=chunk;let index;
  while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);let item;try{item=JSON.parse(line);}catch{continue;}
   if(!item||typeof item!=='object')continue;
   const phase=item.type==='result'?'result':item.type==='assistant'||item.type==='stream_event'?'receiving':item.type==='system'&&item.subtype==='init'?'initialized':null;
   if(!phase)continue;
   const model=item.model??item.message?.model??item.event?.message?.model;
   update({phase,lastActivityAt:new Date().toISOString(),eventCount:++events},typeof model==='string'&&model.length<=160?model:null);
  }
 };
}
