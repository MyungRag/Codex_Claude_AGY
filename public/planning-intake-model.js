import {parsePlanningDraft} from './planning-intake-core.js?v=0.12.0';
import {changePlan,addNode,layoutPlan,appendMessage} from './planning-model.js?v=0.12.0';
import {addDecision} from './decision-model.js?v=0.12.0';
import {reviewPlanContext} from './review-context.js?v=0.12.0';
const ensure=(ok,message)=>{if(!ok)throw new Error(message);};
export function validateIntake(plan,raw,{targetId=plan.rootId,promoteIds=[]}={}){
 const draft=parsePlanningDraft(raw),existing=new Set(plan.nodes.map(n=>n.id)),fresh=new Set(draft.nodes.map(n=>n.id)),all=new Set([...existing,...fresh]);
 ensure(existing.has(targetId),'추가할 상위 노드가 삭제되었습니다.');ensure(!draft.nodes.some(n=>existing.has(n.id)),'새 노드의 임시 ID가 기존 노드와 겹칩니다.');
 for(const n of draft.nodes){ensure(!n.parentId||all.has(n.parentId),'상위 노드 연결을 확인해 주세요.');ensure(n.dependsOn.every(id=>all.has(id)&&id!==plan.rootId),'선행 작업 연결을 확인해 주세요.');}
 for(const n of draft.nodes)ensure((n.integrationWith||[]).every(id=>all.has(id)&&id!==n.id),'병렬 개발 후 통합할 작업을 확인해 주세요.');
 for(const d of draft.defaults)ensure(d.nodeIds.every(id=>all.has(id)),'기본값의 관련 노드를 확인해 주세요.');
 for(const d of draft.deferred)ensure((!d.parentId||all.has(d.parentId))&&d.dependsOn.every(id=>all.has(id)),'후속 기능의 연결 위치를 확인해 주세요.');
 ensure(draft.promotions.length===promoteIds.length&&new Set(draft.promotions.map(p=>p.backlogId)).size===promoteIds.length&&draft.promotions.every(p=>promoteIds.includes(p.backlogId)&&p.nodeIds.length&&p.nodeIds.every(id=>all.has(id))),'선택한 후속 기능을 누락하지 말고 관련 노드와 연결해 주세요.');
 ensure(promoteIds.every(id=>plan.backlog.some(b=>b.id===id&&b.status==='later')),'후속 기능이 이미 반영되었거나 삭제되었습니다.');
 // Validate graph and decisions on a disposable copy before exposing Apply.
 buildIntake(plan,draft,{targetId,promoteIds,id:'preview',lead:'codex',agents:['codex'],allowRequired:true});return draft;
}
function buildIntake(plan,draft,options){
 const {targetId=plan.rootId,promoteIds=[],id,lead,agents,instruction='',allowRequired=false,answers={},reviews=[]}=options;
 ensure(!draft.deferred.some(d=>d.required)||allowRequired,'필수 요구를 후속으로 미루는 이유를 확인하고 보류 동의에 체크해 주세요.');
 return changePlan(plan,promoteIds.length?'후속 기능을 기획에 추가':'주 AI의 초안 기획 반영',p=>{
  if(p.appliedRuns.includes(id))return;
  const mapped=new Map(p.nodes.map(n=>[n.id,n.id])),todo=[...draft.nodes],reused=new Set(),same=(a,b)=>['title','description','instructions','criteria','nodeType'].every(k=>String(a[k]??'').trim()===String(b[k]??'').trim())&&JSON.stringify(a.functionSteps||[])===JSON.stringify(b.functionSteps||[]);
  while(todo.length){const ready=todo.filter(n=>!n.parentId||mapped.has(n.parentId));ensure(ready.length,'상하위 연결이 순환합니다.');for(const n of ready){const parent=n.parentId?mapped.get(n.parentId):targetId,existing=p.nodes.find(old=>p.edges.some(e=>e.from===parent&&e.to===old.id)&&same(old,n)),created=existing||addNode(p,parent,{...n,dependsOn:[]});if(existing)reused.add(n.id);else created.origin='proposal';mapped.set(n.id,created.id);todo.splice(todo.indexOf(n),1);}}
  for(const n of draft.nodes){const created=p.nodes.find(v=>v.id===mapped.get(n.id));const deps=n.dependsOn.map(id=>mapped.get(id));if(reused.has(n.id))ensure(JSON.stringify([...created.dependsOn].sort())===JSON.stringify([...deps].sort()),'같은 기존 기능의 선행 관계를 바꾸는 제안입니다. 기존 관계를 보존해 다시 기획해 주세요.');else created.dependsOn=deps;const peers=(n.integrationWith||[]).map(id=>mapped.get(id));if(!reused.has(n.id)&&peers.length)created.integrationWith=peers;if(!p.proposals.some(v=>v.nodeId===created.id&&v.agent===lead&&same({...v,nodeType:n.nodeType,functionSteps:n.functionSteps},n)))p.proposals.push({id:crypto.randomUUID(),agent:lead,kind:'live',nodeId:created.id,title:n.title,description:n.description,instructions:n.instructions,criteria:n.criteria,reason:n.reason});}
  draft.defaults.forEach((d,index)=>{const item=addDecision(p,{type:'question',question:d.question,nodeIds:d.nodeIds.map(id=>mapped.get(id)),relatedIds:[],options:[d.answer,...d.alternatives.filter(a=>a!==d.answer)].map(label=>({label,impact:''})),reason:d.reason,evidence:'',recommendation:{kind:'assumption',answer:d.answer,reason:d.reason,messageIds:[]}},lead);if(item.answer||item.deferred)return;const chosen=answers[index]?.trim();item.answer=chosen||d.answer;item.status='done';item.resolution={kind:chosen?'user':'assumption',agent:chosen?'':lead,reason:d.reason,messageIds:[],at:new Date().toISOString()};});
  for(const d of draft.deferred){const same=p.backlog.find(b=>b.status==='later'&&b.title===d.title&&b.description===d.description);if(!same)p.backlog.push({...d,id:crypto.randomUUID(),parentId:d.parentId?mapped.get(d.parentId):targetId,dependsOn:d.dependsOn.map(id=>mapped.get(id)),status:'later',addedNodeIds:[],sourceRunId:id});}
  for(const promotion of draft.promotions){const item=p.backlog.find(b=>b.id===promotion.backlogId);item.status='added';item.addedNodeIds=promotion.nodeIds.map(id=>mapped.get(id));}
  if(instruction.trim())appendMessage(p,{nodeId:targetId,text:instruction});
  p.intakeHistory=[{id,lead,agents,summary:draft.summary,at:new Date().toISOString(),promotedIds:promoteIds,reviews:reviews.filter(r=>r.status==='succeeded'&&r.result).map(r=>({agent:r.agent,summary:r.result.summary}))},...p.intakeHistory].slice(0,8);
  p.appliedRuns=[...p.appliedRuns,id].slice(-300);layoutPlan(p);
 });
}
export function applyIntake(plan,raw,options){if(plan.appliedRuns.includes(options.id))return plan;return buildIntake(plan,validateIntake(plan,raw,options),options);}
export function planningPrompt(project,plan,{targetId=plan.rootId,instruction='',promoteIds=[],draft=null,reviews=[],phase='draft'}={}){
 return `실행 가능한 첫 버전의 기획을 작성하세요. 역할: ${phase}. 프로젝트 이름: ${project.name}. 사용자 지침: ${project.instructions||''}. 사용자 추가 요구: ${instruction}\n`+
 '주 AI는 핵심 사용자 흐름을 완결하는 최소 범위와 변경 가능한 합리적 기본값을 판단합니다. 명시된 필수 요구와 기존 사용자 답변을 보존하세요. 실제 계정·외부 사실을 지어내지 마세요. 어려운 핵심 기능은 대체 구현을 먼저 검토하고, 불가피하게 후속으로 미루면 required=true와 구체적 이유를 남겨 사용자 동의를 받습니다. 추가 가치에 비해 부담이 큰 선택 기능은 deferred에 장점·제외 이유·난점·필요 조건·상위 위치를 기록합니다. 후속 후보를 현재 실행 노드나 선행 조건으로 만들지 마세요.\n'+
 '노드는 기능·독립 결과물 기준입니다. 범위 결정·승인받기·기술 선택 같은 절차를 불필요한 실행 작업으로 만들지 마세요. 상하위는 포함 관계입니다. 상위를 이루는 구성 요소가 있을 때만 자식을 만들며, 단순 기능은 한 노드로 끝내세요. 계층 깊이나 개수를 강제하지 말고 불필요한 그룹을 만들지 마세요. 실행 선행 관계 dependsOn은 실제 필수 계약만 연결합니다.\n'+
 '넓은 상위 기능은 별도 개발·검증할 구성 요소를 분석하고 group 아래 task로 나누세요. 깊이나 노드 수 목표는 없지만, 서로 다른 입력·조회·검증·저장·화면 기능을 설명 한 문장으로 뭉뚱그리지 마세요. 각 필수 요구가 어느 노드에서 구현되는지 summary에 설명하세요. dependsOn에는 구현 착수에 반드시 필요한 선행 계약만 넣으세요. 명세가 정해져 독립 개발할 수 있는 하위 기능은 dependsOn=[]로 두고 integrationWith에 나중에 연결할 작업을 지정합니다. 각 병렬 작업의 instructions에 인터페이스·입출력·담당 파일 범위와 실제 통합 완료 기준을 명시하세요. 상하위 관계, 화면 순서, 데이터 흐름만으로 직렬 의존성을 만들지 마세요.\n'+
 '기존 기획은 보존합니다. 기존 노드를 응답에 복사하지 말고 신규 노드만 작성하세요. 신규 id는 임시 ID이고 parentId/dependsOn/integrationWith는 응답의 임시 ID 또는 기존 노드 ID를 참조합니다. parentId=null이면 선택한 대상 아래에 추가합니다. 이미 존재하는 기능은 새 노드를 만들지 말고 요약에 설명하세요. 기본값은 defaults에 관련 노드·대안·이유와 함께 기록합니다. 빈 답변 확인·사용자 승인 없이도 구현 가능한 업무 지시와 실제 검증 가능한 완료 기준을 작성하세요.\n'+
 (promoteIds.length?'선택한 후속 후보만 편입하세요. 후보의 필요 조건을 현재 기획과 대조하고 기존 기능을 재설계하지 마세요. promotions에 각 선택 ID를 정확히 한 번 넣고 구현 노드와 연결하세요.':'promotions는 빈 배열입니다.')+
 (phase==='critique'?'\n동일한 초안의 장점·핵심 누락·실현 가능성·과도한 복잡함만 검토하세요. 전체 기획을 새로 만들지 마세요.':['refine','repair'].includes(phase)?'\n주 AI 자신의 독립 기획을 기본 틀로 삼고 다른 독립안의 장점을 선별 반영하세요. 더 나은 접근이 있으면 자신의 안도 수정하세요. 의견 수만큼 노드를 합치거나 추가하지 마세요.':'\n지금은 독립 기획 단계입니다. 다른 AI의 안을 기다리거나 합치려 하지 말고, 주어진 요구를 분석해 자신의 완결된 초안 기획을 작성하세요.')+
 '\n문맥: '+JSON.stringify({targetId,projectDescription:project.description,plan:reviewPlanContext(plan),candidates:plan.backlog.filter(b=>promoteIds.includes(b.id)),draft,reviews:reviews.map(r=>({agent:r.agent,result:r.result}))});
}
