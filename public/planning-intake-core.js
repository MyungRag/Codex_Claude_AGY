// Plain validation shared by the browser and CLI response boundary.
const ensure=(ok,message)=>{if(!ok)throw new Error(message);};
const text=(v,max=6000)=>{ensure(typeof v==='string'&&v.length<=max,'기획 응답의 글자 수·형식을 확인해 주세요.');return v.trim();};
const list=(v,max=100)=>{ensure(Array.isArray(v)&&v.length<=max,'기획 응답의 항목 수·형식을 확인해 주세요.');return v;};
const id=v=>{ensure(typeof v==='string'&&/^[\w-]{1,80}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v),'기획 식별자를 확인해 주세요.');return v;};
const ids=v=>list(v).map(id);
const optional=v=>v==null?null:id(v);
export function parseBacklog(raw){ensure(raw.required===undefined||typeof raw.required==='boolean','필수 요구의 후속 처리 표시를 확인해 주세요.');return {id:id(raw.id),title:text(raw.title,100),description:text(raw.description,3000),benefit:text(raw.benefit,3000),reason:text(raw.reason,3000),difficulty:text(raw.difficulty,3000),conditions:text(raw.conditions,3000),parentId:optional(raw.parentId),dependsOn:ids(raw.dependsOn??[]),required:raw.required===true,status:raw.status==='added'?'added':'later',addedNodeIds:ids(raw.addedNodeIds??[]),sourceRunId:raw.sourceRunId?id(raw.sourceRunId):''};}
export function parsePlanningDraft(raw){
 ensure(raw&&typeof raw==='object','기획 응답이 없습니다.');
 const nodes=list(raw.nodes,60).map(n=>{ensure(['task','group'].includes(n.nodeType),'노드 역할을 확인해 주세요.');return {id:id(n.id),parentId:optional(n.parentId),title:text(n.title,100),description:text(n.description,3000),instructions:text(n.instructions,6000),criteria:text(n.criteria,3000),nodeType:n.nodeType,dependsOn:ids(n.dependsOn),...(n.integrationWith?.length?{integrationWith:ids(n.integrationWith)}:{}),functionSteps:list(n.functionSteps,20).map(v=>text(v,600)),reason:text(n.reason,3000),dependencyState:'defined',dependencyIssues:[]};});
 ensure(new Set(nodes.map(n=>n.id)).size===nodes.length&&nodes.every(n=>n.title&&(n.nodeType==='group'||n.criteria)),'노드 ID가 중복되었거나 이름·완료 기준이 비어 있습니다.');
 const defaults=list(raw.defaults,60).map(d=>({question:text(d.question,2000),answer:text(d.answer,400),reason:text(d.reason,3000),alternatives:list(d.alternatives,5).map(v=>text(v,400)),nodeIds:ids(d.nodeIds)}));
 ensure(defaults.every(d=>d.question&&d.answer&&d.reason&&d.nodeIds.length),'기본값·이유·관련 노드를 함께 제시해 주세요.');
 const deferred=list(raw.deferred,60).map(parseBacklog);ensure(new Set(deferred.map(d=>d.id)).size===deferred.length&&deferred.every(d=>d.title&&d.reason),'후속 기능의 이름·제외 이유와 고유 ID가 필요합니다.');
 const promotions=list(raw.promotions,60).map(p=>({backlogId:id(p.backlogId),nodeIds:ids(p.nodeIds),reason:text(p.reason,3000)}));
 return {summary:text(raw.summary),nodes,defaults,deferred,promotions};
}
export function parsePlanningCritique(raw){return {summary:text(raw.summary),strengths:list(raw.strengths,20).map(v=>text(v,2000)),risks:list(raw.risks,20).map(v=>text(v,2000)),changes:list(raw.changes,20).map(v=>text(v,2000))};}
export function intakeState(raw){
 const backlog=list(raw.backlog??[],100).map(parseBacklog);ensure(new Set(backlog.map(b=>b.id)).size===backlog.length,'후속 기능 ID가 중복되었습니다.');
 const intakeHistory=list(raw.intakeHistory??[],8).map(h=>({id:id(h.id),lead:text(h.lead,20),agents:list(h.agents,3).map(a=>text(a,20)),summary:text(h.summary),at:text(h.at,40),promotedIds:ids(h.promotedIds??[]),reviews:list(h.reviews??[],3).map(r=>({agent:text(r.agent,20),summary:text(r.summary)}))}));
 return {backlog,intakeHistory};
}
