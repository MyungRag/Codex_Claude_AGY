import {remapDecisionNodes} from './decision-core.js?v=0.7.0';
import {validatePlan,changePlan,layoutPlan,appendMessage,newNode} from './planning-model.js?v=0.7.0';
const ensure=(ok,text)=>{if(!ok)throw new Error(text);};
const id=value=>{ensure(typeof value==='string'&&/^[\w-]{1,80}$/.test(value),'정리안의 노드 ID가 올바르지 않습니다.');return value;};
const text=(value,max,label)=>{ensure(typeof value==='string'&&value.length<=max,label+' 길이와 형식을 확인해 주세요.');return value.trim();};
export function parseOrganization(raw){
 if(typeof raw==='string'){ensure(raw.length<=500000,'정리안이 너무 큽니다.');raw=JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g,''));}
 ensure(raw&&typeof raw==='object','정리안이 올바르지 않습니다.');const summary=text(raw.summary,6000,'정리 설명');
 ensure(Array.isArray(raw.nodes)&&raw.nodes.length<=99,'정리 후 노드는 최대 99개입니다.');
 ensure(Array.isArray(raw.excluded)&&raw.excluded.length<=99,'제외할 노드를 확인해 주세요.');
 const nodes=raw.nodes.map(n=>{ensure(Array.isArray(n.sourceIds)&&n.sourceIds.length<=99,'원본 노드 목록을 확인해 주세요.');const title=text(n.title,100,'노드 이름');ensure(title,'노드 이름을 입력해 주세요.');return {id:id(n.id),parentId:n.parentId==null?null:id(n.parentId),sourceIds:n.sourceIds.map(id),title,description:text(n.description,3000,'설명'),instructions:text(n.instructions,6000,'업무 지시'),criteria:text(n.criteria,3000,'완료 기준'),reason:text(n.reason,3000,'정리 이유')};});
 const ids=new Set(nodes.map(n=>n.id));ensure(ids.size===nodes.length,'정리안에 중복된 노드 ID가 있습니다.');
 const seen=new Set();const visit=n=>{ensure(!seen.has(n.id),'정리안에 순환 연결이 있습니다.');seen.add(n.id);if(n.parentId){const parent=nodes.find(x=>x.id===n.parentId);ensure(parent,'정리안의 상위 노드가 없습니다.');visit(parent);}seen.delete(n.id);};for(const n of nodes)visit(n);
 const excluded=raw.excluded.map(e=>{const reason=text(e.reason,3000,'제외 이유');ensure(reason,'노드를 제외하려면 이유가 필요합니다.');return {id:id(e.id),reason};});
 return {summary,nodes,excluded};
}
export function organizePlan(plan,selectedIds,raw,{agent,runId,instruction='',settings={}}={}){
 if(runId&&plan.appliedRuns?.includes(runId))return plan;
 const proposal=parseOrganization(raw),selection=new Set(selectedIds);
 ensure(selection.size>0&&selection.size===selectedIds.length&&!selection.has(plan.rootId),'정리할 작업 노드를 선택해 주세요. 전체 목표는 유지됩니다.');
 ensure([...selection].every(i=>plan.nodes.some(n=>n.id===i)),'선택한 노드가 변경되었습니다. 다시 요청해 주세요.');
 const covered=[...proposal.nodes.flatMap(n=>n.sourceIds),...proposal.excluded.map(e=>e.id)];
 ensure(covered.length===selection.size&&new Set(covered).size===selection.size&&covered.every(i=>selection.has(i)),'모든 선택 노드가 정리안에 한 번씩 포함되거나 제외 이유가 있어야 합니다.');
 const excluded=new Set(proposal.excluded.map(e=>e.id));
 ensure(!plan.edges.some(e=>excluded.has(e.from)&&!selection.has(e.to)),'선택하지 않은 하위 노드가 있습니다. 관련 하위 노드도 함께 선택해 정리해 주세요.');
 if(runId&&plan.appliedRuns?.includes(runId))return plan;
 const next=changePlan(plan,'AI 노드 정리 · '+(settings.model||agent||'AI'),p=>{
  const oldToNew=new Map(),keyToId=new Map();
  for(const n of proposal.nodes){const nid=n.sourceIds[0]||crypto.randomUUID();keyToId.set(n.id,nid);for(const old of n.sourceIds)oldToNew.set(old,nid);}
  const edges=p.edges.filter(e=>!selection.has(e.from)&&!selection.has(e.to));
  for(const e of p.edges){if(selection.has(e.from)===selection.has(e.to)||(e.from===p.rootId&&selection.has(e.to)))continue;const from=oldToNew.get(e.from)||(!selection.has(e.from)?e.from:null),to=oldToNew.get(e.to)||(!selection.has(e.to)?e.to:null);if(from&&to)edges.push({from,to});}
  for(const n of proposal.nodes){const nid=keyToId.get(n.id);if(n.parentId)edges.push({from:keyToId.get(n.parentId),to:nid});else if(!edges.some(e=>e.to===nid))edges.push({from:p.rootId,to:nid});}
  p.nodes=p.nodes.filter(n=>!selection.has(n.id));
  for(const n of proposal.nodes){const created=newNode(n);created.id=keyToId.get(n.id);created.origin='proposal';created.status='review';p.nodes.push(created);}
  p.edges=[...new Map(edges.map(e=>[e.from+':'+e.to,e])).values()];
  p.proposals=p.proposals.map(source=>({...source,nodeId:oldToNew.get(source.nodeId)|| (excluded.has(source.nodeId)?null:source.nodeId)}));
  remapDecisionNodes(p,oldToNew);
  p.messages=p.messages.map(message=>({...message,nodeId:oldToNew.get(message.nodeId)||message.nodeId}));
  for(const n of proposal.nodes)p.proposals.push({id:crypto.randomUUID(),agent,kind:'live',nodeId:keyToId.get(n.id),title:n.title,description:n.description,instructions:n.instructions,criteria:n.criteria,reason:n.reason});
  if(instruction.trim())appendMessage(p,{text:instruction});
  if(proposal.summary)appendMessage(p,{author:agent,text:proposal.summary,kind:'live'});
  if(runId)p.appliedRuns=[...(p.appliedRuns||[]),runId].slice(-300);layoutPlan(p);
 });
 return validatePlan(next);
}
export function organizationPrompt(project,plan,selectedIds,instruction=''){
 return `당신은 프로젝트 기획을 정리하는 편집자입니다. 한국어로 응답하세요. 코드를 실행하거나 파일을 읽지 마세요.\n프로젝트: ${project.name}\n목표: ${project.description}\n공통 지침: ${project.instructions||''}\n사용자 의견: ${instruction}\n전체 기획 맥락: ${JSON.stringify({rootId:plan.rootId,nodes:plan.nodes,edges:plan.edges,messages:plan.messages,questionsAndDecisions:plan.items||[]})}\n정리할 노드 ID: ${JSON.stringify(selectedIds)}\n전체 목표와 선택하지 않은 노드는 유지하세요. 선택 노드의 중복 통합, 이름·설명·업무 지시·완료 기준의 정돈, 계층 재구성을 제안하세요. 중요한 요구와 완료 기준, 확정된 사용자 답변을 누락하지 마세요. 미확인 제약을 확인된 사실로 단정하지 마세요. 각 선택 ID는 새 nodes의 sourceIds에 정확히 한 번 포함되거나 excluded에 이유와 함께 포함되어야 합니다. 병합 시 sourceIds에 모든 원본 ID를 넣으세요. 그룹 노드를 새로 만들 때만 sourceIds를 비울 수 있습니다. parentId는 응답 안의 id 또는 null만 사용하세요. 선택하지 않은 노드에 연결된 관계는 유지됩니다. 새 노드는 최대 99개입니다. id는 영문, 숫자, 하이픈, 밑줄로 작성하고 title과 설명은 한국어로 작성하세요. JSON은 {summary,nodes:[{id,parentId,sourceIds,title,description,instructions,criteria,reason}],excluded:[{id,reason}]} 형식입니다. 기존 노드 ID와 새 응답의 id를 혼동하지 마세요.`;
}
