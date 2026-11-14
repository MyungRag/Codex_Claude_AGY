import {normalizeExecutionMeta,validateExecutionGraph,executionOrder} from './execution-order.js?v=0.11.0';
// Shared, bounded records for questions, immutable baselines and handoff drafts.
export const decisionTypes={question:'사용자 결정',verification:'추가 확인',constraint:'제약 사항',conflict:'결정 충돌'};
export const decisionStatuses={answer:'답변 필요',check:'확인 필요',done:'결정 완료'};
export const ensure=(ok,message)=>{if(!ok)throw new Error(message);};
export const text=(v,max,label)=>{ensure(typeof v==='string'&&v.length<=max,label+' 형식을 확인해 주세요.');return v.trim();};
export const recordId=v=>{ensure(typeof v==='string'&&/^[\w-]{1,80}$/.test(v),'항목 ID가 올바르지 않습니다.');return v;};
export const array=(v,max,label)=>{ensure(Array.isArray(v)&&v.length<=max,label+' 개수와 형식을 확인해 주세요.');return v;};
const ids=(v,max=100)=>[...new Set(array(v,max,'연결').map(recordId))];
const stamp=v=>{ensure(typeof v==='string'&&Number.isFinite(Date.parse(v)),'기록 시각을 확인해 주세요.');return v;};
const agents=['codex','claude','agy'];
const options=v=>array(v??[],6,'선택지').map(o=>({label:text(o.label,400,'선택지'),impact:text(o.impact??'',1200,'선택 영향')}));
export function recommendation(raw){
 ensure(raw&&['assumption','user','unresolved'].includes(raw.kind),'추천 기본값의 결정 방식을 확인해 주세요.');
 const answer=text(raw.answer??'',6000,'추천 기본값'),reason=text(raw.reason??'',3000,'추천 이유');
 ensure(reason&&(raw.kind==='unresolved'?!answer:!!answer),'추천 기본값과 이유를 입력해 주세요.');
 return {kind:raw.kind,answer,reason,messageIds:ids(raw.messageIds??[],200)};
}
export function decisionMetadata(raw){
 const result={};
 if(raw.recommendation)result.recommendation=recommendation(raw.recommendation);
 if(raw.resolution){const r=raw.resolution;ensure(['user','assumption'].includes(r.kind)&&(!r.agent||agents.includes(r.agent)),'결정 출처를 확인해 주세요.');result.resolution={kind:r.kind,agent:r.agent||'',reason:text(r.reason??'',4000,'결정 이유'),messageIds:ids(r.messageIds??[],200),at:stamp(r.at),...(r.contextMessageIds?{contextMessageIds:ids(r.contextMessageIds,200)}:{})};}
 return result;
}
const snapshotMetadata=i=>i.recommendation||i.resolution?{...decisionMetadata(i),options:options(i.options)}:{};
export function validateItems(raw,nodes){
 const nodeIds=new Set(nodes.map(n=>n.id));const items=array(raw??[],300,'질문·결정 항목').map(i=>{
  ensure(Object.hasOwn(decisionTypes,i.type)&&Object.hasOwn(decisionStatuses,i.status),'항목 분류와 상태를 확인해 주세요.');
  const nodeLinks=ids(i.nodeIds);ensure(nodeLinks.length&&nodeLinks.every(id=>nodeIds.has(id)),'질문의 관련 노드가 없습니다.');
  const question=text(i.question,2000,'질문');ensure(question,'질문을 입력해 주세요.');const answer=text(i.answer??'',6000,'답변');ensure(i.status!=='done'||answer,'확정하려면 답변이나 확인 결론을 입력해 주세요.');
  const deferReason=text(i.deferReason??'',2000,'보류 이유');ensure(!i.deferred||deferReason,'보류 이유를 입력해 주세요.');
  return {...decisionMetadata(i),id:recordId(i.id),nodeIds:nodeLinks,type:i.type,status:i.status,question,reason:text(i.reason??'',3000,'질문 이유'),options:options(i.options),answer,evidence:text(i.evidence??'',4000,'확인 근거'),blocking:i.blocking===true,deferred:i.deferred===true,deferReason,relatedIds:ids(i.relatedIds??[],20),changedReason:text(i.changedReason??'',2000,'재확인 이유'),createdAt:stamp(i.createdAt),updatedAt:stamp(i.updatedAt),sources:array(i.sources??[],30,'AI 의견').map(s=>{ensure(agents.includes(s.agent),'제안한 AI를 확인해 주세요.');return {agent:s.agent,reason:text(s.reason??'',3000,'AI 의견'),evidence:text(s.evidence??'',4000,'AI 확인 근거'),options:options(s.options)};}),history:array(i.history??[],20,'답변 이력').map(h=>({at:stamp(h.at),action:text(h.action,100,'이력'),answer:text(h.answer??'',6000,'이전 답변'),evidence:text(h.evidence??'',4000,'이전 근거')}))};
 });const all=new Set(items.map(i=>i.id));ensure(all.size===items.length,'중복 질문 ID입니다.');for(const i of items){ensure(i.relatedIds.every(id=>all.has(id)&&id!==i.id),'연결된 결정 항목이 없습니다.');ensure(i.relatedIds.every(id=>items.find(x=>x.id===id).type!=='conflict'),'충돌 항목끼리 연결할 수 없습니다.');if(i.type==='conflict')ensure(i.relatedIds.length>=2,'충돌에는 두 개 이상의 결정 항목이 필요합니다.');}return items;
}
// Omit all-default metadata in canonical snapshots so older saved baselines and
// question fingerprints remain current after the additive migration.
const semanticExecutionMeta=n=>{const meta=normalizeExecutionMeta(n);return meta.nodeType==='task'&&meta.order===null&&!meta.dependsOn.length&&!meta.functionSteps.length&&meta.dependencyState==='unreviewed'&&!meta.dependencyIssues.length?{}:meta;};
export const semanticNode=n=>({id:n.id,title:n.title,description:n.description,instructions:n.instructions,criteria:n.criteria,...semanticExecutionMeta(n)});
const questionNode=n=>({id:n.id,title:n.title,description:n.description,instructions:n.instructions,criteria:n.criteria,nodeType:n.nodeType||'task',functionSteps:n.functionSteps||[],dependsOn:[...(n.dependsOn||[])].sort()});
export const nodeFingerprint=(plan,id)=>JSON.stringify({node:questionNode(plan.nodes.find(n=>n.id===id))});
export function normalizeQuestionFingerprint(value){try{return JSON.stringify({node:questionNode(JSON.parse(value).node)});}catch{return value;}}
export const changedQuestionNodes=(plan,nodeIds=plan.nodes.map(n=>n.id))=>nodeIds.filter(id=>plan.nodes.some(n=>n.id===id)&&!plan.questionCoverage.some(c=>c.nodeId===id&&normalizeQuestionFingerprint(c.fingerprint)===nodeFingerprint(plan,id)));
export function decisionSnapshot(project,plan){return {project:{name:project.name,description:project.description||'',instructions:project.instructions||''},rootId:plan.rootId,nodes:plan.nodes.map(semanticNode).sort((a,b)=>a.id.localeCompare(b.id)),edges:[...plan.edges].sort((a,b)=>(a.from+':'+a.to).localeCompare(b.from+':'+b.to)),items:(plan.items||[]).map(i=>({id:i.id,nodeIds:[...i.nodeIds].sort(),type:i.type,status:i.status,question:i.question,answer:i.answer,evidence:i.evidence,blocking:i.blocking,deferred:i.deferred,deferReason:i.deferReason,relatedIds:[...i.relatedIds].sort(),...snapshotMetadata(i)})).sort((a,b)=>a.id.localeCompare(b.id))};}
export const snapshotKey=snapshot=>JSON.stringify(snapshot);
function validateSnapshot(s){
 ensure(s&&s.project,'확정 기획을 확인해 주세요.');const nodes=array(s.nodes,100,'확정 노드').map(n=>({id:recordId(n.id),title:text(n.title,100,'이름'),description:text(n.description,3000,'설명'),instructions:text(n.instructions,6000,'지시'),criteria:text(n.criteria,3000,'완료 기준'),...semanticExecutionMeta(n)}));
 const nodeIds=new Set(nodes.map(n=>n.id));ensure(nodeIds.size===nodes.length&&nodeIds.has(s.rootId),'확정 기획의 목표를 확인해 주세요.');const edges=array(s.edges,400,'확정 연결').map(e=>({from:recordId(e.from),to:recordId(e.to)}));ensure(edges.every(e=>nodeIds.has(e.from)&&nodeIds.has(e.to)),'확정 기획 연결을 확인해 주세요.');
 ensure(new Set(edges.map(e=>e.from+':'+e.to)).size===edges.length&&!edges.some(e=>e.to===s.rootId),'확정 기획의 중복 연결·목표 연결을 확인해 주세요.');
 const visiting=new Set(),done=new Set();const visit=id=>{ensure(!visiting.has(id),'확정 기획에 순환 연결이 있습니다.');if(done.has(id))return;visiting.add(id);for(const edge of edges.filter(e=>e.from===id))visit(edge.to);visiting.delete(id);done.add(id);};visit(s.rootId);ensure(done.size===nodes.length,'확정 기획에 연결되지 않은 노드가 있습니다.');
 validateExecutionGraph(nodes,{rootId:s.rootId});
 const at='2000-01-01T00:00:00.000Z';const items=validateItems((s.items||[]).map(i=>({...i,createdAt:at,updatedAt:at})),nodes).map(i=>{const {id,nodeIds,type,status,question,answer,evidence,blocking,deferred,deferReason,relatedIds}=i;return {id,nodeIds,type,status,question,answer,evidence,blocking,deferred,deferReason,relatedIds,...snapshotMetadata(i)};});
 return {project:{name:text(s.project.name,80,'프로젝트'),description:text(s.project.description,1000,'목표'),instructions:text(s.project.instructions,12000,'공통 지침')},rootId:s.rootId,nodes,edges,items};
}
export function validateTasks(raw,snapshot){
 const nodes=snapshot.nodes.filter(n=>n.id!==snapshot.rootId&&n.nodeType!=='group'),valid=new Set(nodes.map(n=>n.id));
 const tasks=array(raw,nodes.length,'업무 분담').map(t=>{ensure(valid.has(t.nodeId)&&agents.includes(t.agent),'업무 담당과 노드를 확인해 주세요.');const node=nodes.find(n=>n.id===t.nodeId),meta=normalizeExecutionMeta({...node,...t,nodeType:'task'}),dependsOn=ids(meta.dependsOn);ensure(dependsOn.every(id=>valid.has(id)&&id!==t.nodeId),'선행 작업을 확인해 주세요.');return {nodeId:t.nodeId,agent:t.agent,...meta,dependsOn,instructions:text(t.instructions??'',6000,'업무 지시'),deliverable:text(t.deliverable??'',3000,'기대 결과'),criteria:text(t.criteria??'',3000,'완료 기준')};});
 ensure(tasks.every(t=>t.instructions&&t.deliverable&&t.criteria),'업무 지시·기대 결과·완료 기준을 모두 입력해 주세요.');
 ensure(tasks.length===nodes.length&&new Set(tasks.map(t=>t.nodeId)).size===nodes.length,'모든 작업 노드에 담당자가 한 번씩 지정되어야 합니다.');
 const visiting=new Set(),done=new Set();const visit=id=>{ensure(!visiting.has(id),'선행 작업이 순환합니다.');if(done.has(id))return;visiting.add(id);for(const other of tasks.find(t=>t.nodeId===id).dependsOn)visit(other);visiting.delete(id);done.add(id);};for(const t of tasks)visit(t.nodeId);
 return executionOrder(tasks.map(t=>({...t,id:t.nodeId}))).map(({id,...task})=>task);
}
export function validateDecisionState(raw,nodes){
 const items=validateItems(raw.items,nodes),nodeIds=new Set(nodes.map(n=>n.id));
 const coverage=array(raw.questionCoverage??[],100,'검토 기록').map(c=>{ensure(nodeIds.has(c.nodeId),'검토 대상 노드가 없습니다.');return {nodeId:c.nodeId,fingerprint:normalizeQuestionFingerprint(text(c.fingerprint,500000,'검토 내용')),at:stamp(c.at)};});
 const baselines=array(raw.baselines??[],10,'확정 기획 버전').map(b=>({id:recordId(b.id),number:b.number,at:stamp(b.at),note:text(b.note??'',3000,'확정 메모'),snapshot:validateSnapshot(b.snapshot)}));
 ensure(baselines.every(b=>Number.isSafeInteger(b.number)&&b.number>0)&&new Set(baselines.map(b=>b.id)).size===baselines.length&&new Set(baselines.map(b=>b.number)).size===baselines.length,'확정 버전을 확인해 주세요.');
 const handoffs=array(raw.handoffs??[],10,'업무 분담 기록').map(h=>{const base=baselines.find(b=>b.id===h.baselineId);ensure(base,'업무 분담의 확정 기획이 없습니다.');return {baselineId:base.id,tasks:validateTasks(h.tasks,base.snapshot),updatedAt:stamp(h.updatedAt),source:text(h.source??'직접 편집',100,'분담 출처')};});ensure(new Set(handoffs.map(h=>h.baselineId)).size===handoffs.length,'확정 버전당 업무 분담은 하나입니다.');
 const reviewHistory=array(raw.reviewHistory??[],3,'통합 검토 기록').map(r=>{ensure(['questions','organize'].includes(r.kind)&&agents.includes(r.lead),'통합 검토 출처를 확인해 주세요.');return {id:recordId(r.id),kind:r.kind,lead:r.lead,instruction:text(r.instruction||'',6000,'추가 요구'),summary:text(r.summary,6000,'통합 설명'),payload:text(r.payload,500000,'원본 검토'),at:stamp(r.at),...(r.contextMessageIds?{contextMessageIds:ids(r.contextMessageIds,200)}:{})};});
 return {items,questionCoverage:coverage,baselines,handoffs,reviewHistory};
}
export function remapDecisionNodes(plan,mapping){
 plan.items=(plan.items||[]).map(i=>({...i,nodeIds:[...new Set(i.nodeIds.map(id=>mapping.get(id)??id))]}));
}
const normalize=s=>s.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
export const questionKey=i=>JSON.stringify([i.type,normalize(i.question),[...i.nodeIds].sort(),[...(i.relatedIds||[])].sort()]);
export function reconcileDecisions(before,next){
 const nodes=new Set(next.nodes.map(n=>n.id));
 next.items=(next.items||[]).map(i=>({...i,nodeIds:i.nodeIds.filter(id=>nodes.has(id))})).filter(i=>i.nodeIds.length);
 const existing=new Set(next.items.map(i=>i.id));next.items=next.items.map(i=>({...i,relatedIds:i.relatedIds.filter(id=>existing.has(id))})).filter(i=>i.type!=='conflict'||i.relatedIds.length>=2);
 for(const item of next.items){const old=(before.items||[]).find(i=>i.id===item.id);if(!old)continue;
  const changed=JSON.stringify(old.nodeIds)!==JSON.stringify(item.nodeIds)||item.nodeIds.some(id=>!before.nodes.some(n=>n.id===id)||nodeFingerprint(before,id)!==nodeFingerprint(next,id));
  const relatedChanged=item.relatedIds.some(id=>{const a=(before.items||[]).find(i=>i.id===id),b=next.items.find(i=>i.id===id);return a&&b&&(a.answer!==b.answer||a.evidence!==b.evidence);});
  if((changed||relatedChanged)&&item.status==='done'){item.status='check';item.changedReason=relatedChanged?'관련 결정의 답변이 변경되었습니다. 충돌 해소 여부를 다시 확인해 주세요.':'관련 노드의 내용·관계가 변경되었습니다. 기존 답변이 유효한지 다시 확인해 주세요.';item.updatedAt=new Date().toISOString();}
 }
 // Equal questions are safe to combine only when their answers agree.
 const unique=[],mapped=new Map();for(const item of next.items){const same=unique.find(i=>questionKey(i)===questionKey(item)&&i.answer===item.answer&&i.evidence===item.evidence&&i.status===item.status&&i.deferred===item.deferred&&i.deferReason===item.deferReason);if(same){same.sources=[...same.sources,...item.sources].filter((s,i,a)=>a.findIndex(x=>JSON.stringify(x)===JSON.stringify(s))===i).slice(0,30);same.history=[...same.history,...item.history].slice(-20);same.blocking||=item.blocking;mapped.set(item.id,same.id);}else unique.push(item);}
 next.items=unique.map(i=>({...i,relatedIds:[...new Set(i.relatedIds.map(id=>mapped.get(id)||id))].filter(id=>id!==i.id)})).filter(i=>i.type!=='conflict'||i.relatedIds.length>=2);
 next.questionCoverage=(next.questionCoverage||[]).filter(c=>nodes.has(c.nodeId)&&normalizeQuestionFingerprint(c.fingerprint)===nodeFingerprint(next,c.nodeId));
}
