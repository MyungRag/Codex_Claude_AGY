import {normalizeExecutionMeta} from './execution-order.js?v=0.8.0';
import {remapDecisionNodes} from './decision-core.js?v=0.8.0';
import {validatePlan,changePlan,layoutPlan,appendMessage,newNode} from './planning-model.js?v=0.8.0';
const ensure=(ok,text)=>{if(!ok)throw new Error(text);};
const id=value=>{ensure(typeof value==='string'&&/^[\w-]{1,80}$/.test(value),'정리안의 노드 ID가 올바르지 않습니다.');return value;};
const text=(value,max,label)=>{ensure(typeof value==='string'&&value.length<=max,label+' 길이와 형식을 확인해 주세요.');return value.trim();};
const metaKeys=['nodeType','order','dependsOn','functionSteps','dependencyState','dependencyIssues'];
// Keep omitted fields absent: old saved AI responses must inherit existing metadata.
const proposalMeta=n=>{const normalized=normalizeExecutionMeta(n);return Object.fromEntries(metaKeys.filter(key=>Object.hasOwn(n,key)).map(key=>[key,normalized[key]]));};
const unique=values=>[...new Set(values)];
const missingDependency=(node,old)=>`선행 작업 ‘${old?.title||node}’이 제외되었습니다. 대체 작업 또는 독립 실행 여부를 확인해 주세요.`;

export function parseOrganization(raw){
 if(typeof raw==='string'){ensure(raw.length<=500000,'정리안이 너무 큽니다.');raw=JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g,''));}
 ensure(raw&&typeof raw==='object','정리안이 올바르지 않습니다.');const summary=text(raw.summary,6000,'정리 설명');
 ensure(Array.isArray(raw.nodes)&&raw.nodes.length<=99,'정리 후 노드는 최대 99개입니다.');
 ensure(Array.isArray(raw.excluded)&&raw.excluded.length<=99,'제외할 노드를 확인해 주세요.');
 const nodes=raw.nodes.map(n=>{ensure(Array.isArray(n.sourceIds)&&n.sourceIds.length<=99,'원본 노드 목록을 확인해 주세요.');const title=text(n.title,100,'노드 이름');ensure(title,'노드 이름을 입력해 주세요.');return {id:id(n.id),parentId:n.parentId==null?null:id(n.parentId),sourceIds:n.sourceIds.map(id),title,description:text(n.description,3000,'설명'),instructions:text(n.instructions,6000,'업무 지시'),criteria:text(n.criteria,3000,'완료 기준'),reason:text(n.reason,3000,'정리 이유'),...proposalMeta(n)};});
 const ids=new Set(nodes.map(n=>n.id));ensure(ids.size===nodes.length,'정리안에 중복된 노드 ID가 있습니다.');
 const seen=new Set();const visit=n=>{ensure(!seen.has(n.id),'정리안에 순환 연결이 있습니다.');seen.add(n.id);if(n.parentId){const parent=nodes.find(x=>x.id===n.parentId);ensure(parent,'정리안의 상위 노드가 없습니다.');visit(parent);}seen.delete(n.id);};for(const n of nodes)visit(n);
 const checked=new Set(),active=new Set();const checkDeps=node=>{ensure(!active.has(node.id),'정리안의 선행 구현 관계가 순환합니다.');if(checked.has(node.id))return;active.add(node.id);ensure(node.nodeType!=='group'||!(node.dependsOn||[]).length,'그룹에는 선행 구현을 지정할 수 없습니다. 실제 작업 노드를 선택해 주세요.');for(const dep of node.dependsOn||[]){const predecessor=nodes.find(n=>n.id===dep);if(predecessor){ensure(predecessor.nodeType!=='group','선행 구현은 그룹이 아닌 실제 작업 노드를 선택해 주세요.');checkDeps(predecessor);}}active.delete(node.id);checked.add(node.id);};for(const node of nodes)checkDeps(node);
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
 ensure(proposal.nodes.every(n=>!plan.nodes.some(old=>old.id===n.id&&!selection.has(old.id))),'정리안 ID가 선택 범위 밖의 노드 ID와 겹칩니다. 새 정리안 ID를 사용해 주세요.');
 for(const n of proposal.nodes){ensure(n.sourceIds.length||!n.nodeType||n.nodeType==='group','새로 추가하는 노드는 그룹이어야 합니다.');for(const dep of n.dependsOn||[])ensure(proposal.nodes.some(other=>other.id===dep)||plan.nodes.some(old=>old.id===dep&&!selection.has(dep)&&old.id!==plan.rootId),'선행 구현은 정리안의 노드 ID 또는 선택 범위 밖의 기존 작업 ID를 사용해 주세요.');}

 ensure(!plan.edges.some(e=>excluded.has(e.from)&&!selection.has(e.to)),'선택하지 않은 하위 노드가 있습니다. 관련 하위 노드도 함께 선택해 정리해 주세요.');
 if(runId&&plan.appliedRuns?.includes(runId))return plan;
 const next=changePlan(plan,'AI 노드 정리 · '+(settings.model||agent||'AI'),p=>{
  const oldToNew=new Map(),keyToId=new Map();
  for(const n of proposal.nodes){const nid=n.sourceIds[0]||crypto.randomUUID();keyToId.set(n.id,nid);for(const old of n.sourceIds)oldToNew.set(old,nid);}
  const edges=p.edges.filter(e=>!selection.has(e.from)&&!selection.has(e.to));
  for(const e of p.edges){if(selection.has(e.from)===selection.has(e.to)||(e.from===p.rootId&&selection.has(e.to)))continue;const from=oldToNew.get(e.from)||(!selection.has(e.from)?e.from:null),to=oldToNew.get(e.to)||(!selection.has(e.to)?e.to:null);if(from&&to)edges.push({from,to});}
  for(const n of proposal.nodes){const nid=keyToId.get(n.id);if(n.parentId)edges.push({from:keyToId.get(n.parentId),to:nid});else if(!edges.some(e=>e.to===nid))edges.push({from:p.rootId,to:nid});}
  const oldNodes=p.nodes;
  const remapExisting=dep=>oldToNew.get(dep)||(!selection.has(dep)?dep:null);
  p.nodes=p.nodes.filter(n=>!selection.has(n.id)).map(node=>{
   const meta=normalizeExecutionMeta(node),removed=meta.dependsOn.filter(dep=>excluded.has(dep));
   return {...node,...meta,dependsOn:unique(meta.dependsOn.map(remapExisting).filter(Boolean)),dependencyIssues:unique([...meta.dependencyIssues,...removed.map(dep=>missingDependency(dep,oldNodes.find(old=>old.id===dep)))]),dependencyState:removed.length?'unreviewed':meta.dependencyState};
  });
  for(const n of proposal.nodes){
   const sources=oldNodes.filter(old=>n.sourceIds.includes(old.id)),sourceMeta=sources.map(normalizeExecutionMeta),nid=keyToId.get(n.id);
   const inheritedDeps=unique(sourceMeta.flatMap(meta=>meta.dependsOn));
   // Never silently discard dependencies outside the edited scope. Merges retain every source prerequisite.
   const retainDeps=!Object.hasOwn(n,'dependsOn')||sources.length>1?inheritedDeps:inheritedDeps.filter(dep=>!selection.has(dep));
   const lost=inheritedDeps.filter(dep=>excluded.has(dep));
   const inheritedSteps=unique(sourceMeta.flatMap(meta=>meta.functionSteps));
   const meta=normalizeExecutionMeta({
    nodeType:n.nodeType??(sources.length?sourceMeta[0].nodeType:'group'),
    order:n.order!==undefined?n.order:sourceMeta.map(meta=>meta.order).filter(v=>v!==null).sort((a,b)=>a-b)[0]??null,
    dependsOn:unique([...(n.dependsOn||[]).map(dep=>keyToId.get(dep)||dep),...retainDeps.map(remapExisting).filter(Boolean)]).filter(dep=>dep!==nid),
    functionSteps:n.functionSteps!==undefined?(sources.length>1?unique([...n.functionSteps,...inheritedSteps]):n.functionSteps):inheritedSteps,
    dependencyState:n.dependencyState??(sourceMeta.length&&sourceMeta.every(meta=>meta.dependencyState==='defined')?'defined':'unreviewed'),
    dependencyIssues:unique([...(n.dependencyIssues||[]),...sourceMeta.flatMap(meta=>meta.dependencyIssues),...lost.map(dep=>missingDependency(dep,oldNodes.find(old=>old.id===dep)))])
   });
   if(meta.dependencyIssues.length)meta.dependencyState='unreviewed';
   if(meta.nodeType==='group')ensure(!meta.dependsOn.length,'기존 선행 구현을 가진 작업을 그룹으로 바꿀 수 없습니다. 선행 관계를 먼저 확인해 주세요.');
   const created=newNode({...n,...meta});created.id=nid;created.origin='proposal';created.status='review';p.nodes.push(created);
  }
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
 return `당신은 프로젝트 기획을 정리하는 편집자입니다. 한국어로 응답하세요. 코드를 실행하거나 파일을 읽지 마세요.\n프로젝트: ${project.name}\n목표: ${project.description}\n공통 지침: ${project.instructions||''}\n사용자 의견: ${instruction}\n전체 기획 맥락: ${JSON.stringify({rootId:plan.rootId,nodes:plan.nodes,edges:plan.edges,messages:plan.messages,questionsAndDecisions:plan.items||[]})}\n정리할 노드 ID: ${JSON.stringify(selectedIds)}\n전체 목표와 선택하지 않은 노드는 유지하세요. 선택 노드의 중복 통합, 이름·설명·업무 지시·완료 기준의 정돈, 계층 재구성을 제안하세요. 중요한 요구와 완료 기준, 확정된 사용자 답변을 누락하지 마세요. 미확인 제약을 확인된 사실로 단정하지 마세요. 각 선택 ID는 새 nodes의 sourceIds에 정확히 한 번 포함되거나 excluded에 이유와 함께 포함되어야 합니다. 병합 시 sourceIds에 모든 원본 ID를 넣으세요. 그룹 노드를 새로 만들 때만 sourceIds를 비울 수 있습니다. parentId는 응답 안의 id 또는 null만 사용하세요. 선택하지 않은 노드에 연결된 관계와 선행 의존성은 유지됩니다. 다음을 별도로 설계하세요.\n1. parentId는 기능·모듈의 포함 관계(WBS)입니다. 상위 노드가 무조건 먼저 실행되거나 하위 노드가 무조건 먼저 실행되는 것은 아닙니다. 실행할 일이 없는 묶음은 nodeType=group, 실제 설계·구현·검증 작업은 task로 지정하세요. 새 노드(sourceIds가 빈 배열)는 group만 허용됩니다.\n2. dependsOn은 이 작업을 시작하기 전에 실제로 완료되어야 하는 선행 작업입니다. 근거를 reason에 설명하세요. 선택 범위 안에서는 이번 응답의 id를, 밖에서는 기존 실제 작업의 id를 사용하세요. 목표·그룹·자기 자신을 선행 작업으로 넣거나 순환을 만들지 마세요. 기반 계약·데이터 모델·계산 검증과 소비하는 API·UI·통합 작업 사이의 의존성을 검토하세요.\n3. order는 1~999의 구현 우선순위(그룹은 null)입니다. 실행기는 dependsOn을 먼저 만족시키고, 실행 가능한 작업끼리만 order를 비교합니다. 배열·상하위 배치·order 번호만으로 의존성을 대신하지 마세요.\n4. functionSteps는 이 노드 내부의 구현·검증 순서 문자열 목록(최대 20개)입니다. 스키마·입력 검증 → 순수 계산 → 상태 변경 → 스토리지·API·프로세스 → UI의 5단계를 참고하되 해당 노드에 필요한 단계만 쓰세요. 계약 우선 설계·mock·UI 시제품도 허용하되 실제 구현·연동 검증과 구분하고 완료 기준을 적으세요. 함수 이름이나 파일 존재만으로 완료라고 주장하지 마세요.\n5. 의존성을 검토하고 지정했다면 dependencyState=defined(독립 작업은 dependsOn=[]), 미정 조건 때문에 판단하지 못했다면 unreviewed로 두고 dependencyIssues에 확인할 내용을 적으세요. 사용자 미답변을 임의로 확정하지 마세요. 그룹의 dependsOn/functionSteps는 빈 배열입니다.\n새 노드는 최대 99개입니다. id는 영문, 숫자, 하이픈, 밑줄로 작성하고 title과 설명은 한국어로 작성하세요. JSON은 {summary,nodes:[{id,parentId,sourceIds,title,description,instructions,criteria,reason,nodeType,order,dependsOn,functionSteps,dependencyState,dependencyIssues}],excluded:[{id,reason}]} 형식입니다. 기존 노드 ID와 새 응답의 id를 혼동하지 마세요.`;
}
