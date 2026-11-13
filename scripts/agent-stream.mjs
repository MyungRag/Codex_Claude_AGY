import {observeClaudeStream} from './claude-stream.mjs';

// Only event types, model IDs and timestamps leave the parser. Event text,
// reasoning, tool output and stderr are never copied into public progress.
export function observeAgentStream(agent,update){
 if(agent==='claude')return observeClaudeStream(update);
 let buffer='',events=0;
 return chunk=>{
  buffer+=chunk;let index;
  while((index=buffer.indexOf('\n'))>=0){
   const line=buffer.slice(0,index);buffer=buffer.slice(index+1);let item;
   try{item=JSON.parse(line);}catch{continue;}
   if(!item||typeof item!=='object')continue;
   let phase=null;
   if(agent==='codex'){
    if(item.type==='thread.started')phase='initialized';
    else if(item.type==='turn.started')phase='processing';
    else if(['item.started','item.updated','item.completed'].includes(item.type))phase=item.item?.type==='agent_message'?'receiving':'processing';
    else if(item.type==='turn.completed')phase='result';
    else if(['turn.failed','error'].includes(item.type))phase='error';
   }else if(agent==='agy'){
    if(item.event==='init')phase='initialized';
    else if(['message','assistant','delta','content'].includes(item.event))phase='receiving';
    else if(item.event==='result')phase='result';
    else if(item.event==='error')phase='error';
   }
   if(!phase)continue;
   const model=item.model??item.init?.model;
   update({phase,lastActivityAt:new Date().toISOString(),eventCount:++events},typeof model==='string'&&model.length<=160?model:null);
  }
 };
}
