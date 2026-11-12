import {resolveAgent,runProcess,readCodexModels,readClaudeModels} from './agent-process.mjs';
import {EFFORTS,validateSettings} from '../public/agent-settings.js';
const tiers=raw=>Array.isArray(raw)?[...new Set(raw.map(e=>typeof e==='string'?e:e?.reasoningEffort??e?.value??e?.effort).filter(e=>['none','minimal','low','medium','high','xhigh','max'].includes(e)))]:null;
export function normalizeCatalog(agent,raw){
 const items=Array.isArray(raw)?raw:raw?.models??raw?.data?.models??raw?.data;
 if(!Array.isArray(items))throw new Error('모델 목록 형식을 확인하지 못했습니다. 기본값으로 사용하거나 목록을 다시 불러와 주세요.');
 const result=[];
 for(const item of items){
  if(!item||(typeof item!=='string'&&typeof item!=='object'))continue;
  const id=typeof item==='string'?item:item.slug??item.value??item.model??item.id??item.model_id??item.name;
  try{validateSettings(agent,{model:id});}catch{continue;}if(typeof id!=='string'||!id)continue;
  const effortRaw=item.supportedReasoningEfforts??item.supportedEffortLevels??item.supported_efforts??item.available_efforts??item.efforts;
  const efforts=item.supportsEffort===false||item.adjustable===false?[]:tiers(effortRaw);
  let resolvedModel=null;try{if(typeof item.resolvedModel==='string'&&item.resolvedModel){validateSettings(agent,{model:item.resolvedModel});resolvedModel=item.resolvedModel;}}catch{}
  result.push({id,resolvedModel,name:String(item.displayName??item.display_name??item.label??item.name??id).slice(0,160),efforts,isDefault:item.isDefault===true||item.is_default===true||(agent==='claude'&&id==='default')});
 }
 if(!result.length)throw new Error('선택 가능한 모델을 받지 못했습니다. CLI 로그인과 계정 권한을 확인해 주세요.');
 const models=[...new Map(result.map(m=>[m.id,m])).values()].slice(0,200);
 // AGY publishes exact variant slugs (e.g. gemini-...-medium / -high).
 // Never invent max/xhigh or a base-model ID absent from the live catalog.
 if(agent==='agy')for(const model of models){
  if(model.efforts!==null)continue;
  const match=model.id.match(/^(.+)-(low|medium|high|xhigh|max)$/);if(!match)continue;
  const siblings=models.filter(m=>m.id.match(/^(.+)-(low|medium|high|xhigh|max)$/)?.[1]===match[1]);
  const labelled=new RegExp('\\('+match[2]+'\\)$','i').test(model.name);
  if(siblings.length>1||labelled)model.efforts=EFFORTS.agy.filter(e=>siblings.some(m=>m.id===match[1]+'-'+e));
 }
 return models;
}
export function parseAgyText(text){
 return text.split(/\r?\n/).flatMap(line=>{const match=line.trim().match(/^([a-zA-Z0-9][a-zA-Z0-9._:/@-]*)\t+(.+)$/);return match?[{slug:match[1],label:match[2]}]:[];});
}
export async function getCatalog(agent,{resolve=resolveAgent,run=runProcess,readCodex=readCodexModels,readClaude=readClaudeModels,signal}={}){
 if(!EFFORTS[agent])throw new Error('지원하지 않는 에이전트입니다.');
 const executable=await resolve(agent);if(!executable)throw new Error('CLI 설치와 연결을 먼저 확인해 주세요.');
 let raw;
 if(agent==='codex')raw=await readCodex(executable,{signal});
 else if(agent==='claude')raw=await readClaude(executable,{signal});
 else{
  const result=await run(executable,['models','--output-format','json'],{signal,timeout:20000,maxBytes:1024*1024});
  try{if(result.code===0){raw=JSON.parse(result.stdout);normalizeCatalog(agent,raw);}}catch{raw=null;}
  if(!raw){
   if(signal?.aborted)throw new Error('모델 목록 확인을 취소했습니다.');
   const plain=await run(executable,['models'],{signal,timeout:15000,maxBytes:1024*1024});
   if(plain.code!==0)throw new Error('AGY 모델 목록을 읽지 못했습니다. CLI 로그인과 agy models를 확인해 주세요. 기본값은 계속 사용할 수 있습니다.');
   raw=parseAgyText(plain.stdout);
  }
 }
 const models=normalizeCatalog(agent,raw),defaultModel=raw?.defaultModel??raw?.default_model??models.find(m=>m.isDefault)?.id??null;
 return {source:'cli',models,defaultModel:models.some(m=>m.id===defaultModel)?defaultModel:null,note:'이 PC의 CLI가 제공한 모델·추론 강도입니다. 기본 모델을 확인하지 못한 경우 모델을 직접 선택하면 지원 강도가 표시됩니다.'};
}
