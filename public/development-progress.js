// Shared, factual projection for the planning board, execution view and saved preview.
export const roleLabel=call=>call.kind==='development-build'?'개발':call.kind==='development-audit'?'검토':call.role==='preflight-verification-plan'?'검증 계획':call.role==='overall-lead'?'총괄':'Challenger 분석';
export function taskProgress(task,state={}){
 if(!task)return {key:'unbuilt',label:'미개발 · 실행 전',detail:''};
 const calls=(state.aiCalls||[]).filter(c=>c.taskId===task.id&&['running','queued'].includes(c.status));
 if(['running','cancelling'].includes(state.status)&&calls.length){const call=calls.find(c=>c.status==='running')||calls[0];return {key:call.status==='running'?'running':'waiting',label:roleLabel(call)+(call.status==='queued'?' 대기':' 중'),detail:task.waitReason||'',agent:call.agent,role:roleLabel(call)};}
 if(state.status==='running'&&task.status==='running')return {key:'running',label:task.phase||'작업 준비 중',detail:task.waitReason||''};
 const latest=(state.releases||[]).find(r=>r.id===(state.latestPreviewId||state.latestRunnableId)),sha=latest?.codeSha||state.tasks?.find(t=>t.isAssembly)?.artifactSha;
 const integrated=task.integration&&task.integration.codeSha===sha?task.integration:null;
 if(integrated&&integrated.status!=='not_implemented')return {key:integrated.verified?'verified':integrated.status==='partial'?'partial':'implemented',label:integrated.verified?'통합 후 동작 확인':integrated.status==='partial'?'통합에서 일부 구현':'통합에서 구현 · 검증 필요',detail:integrated.summary};
 const failedCheck=(task.checks||[]).find(c=>!c.passed&&c.exitCode!==null&&c.failureKind!=='environment');
 if(task.artifactSha&&failedCheck)return {key:'failed',label:'구현됨 · 검사 실패',detail:failedCheck.label+' — '+String(failedCheck.output||'검사 실패').slice(0,400)};
 if(task.status==='passed'&&!task.needsVerification)return {key:'verified',label:'수행 완료 · 검증 통과',detail:''};
 if(task.status==='blocked')return {key:'blocked',label:task.artifactSha?'구현 있음 · 선행 재확인':'미개발 · 선행 조건 대기',detail:task.error||''};
 if(task.status==='pending'||!task.artifactSha)return {key:task.status==='pending'?'unbuilt':'failed',label:task.status==='pending'?'미개발 · 실행 전':'미개발 · 요청 실패/보류',detail:task.error||''};
 return {key:task.status==='failed'?'failed':'partial',label:task.status==='failed'?'구현됨 · 검사 실패':task.needsVerification?'구현됨 · 재검증 필요':'일부 구현 · 검증 필요',detail:task.error||''};
}
export function nodeProgress(plan,nodeId,state={}){
 const task=state.tasks?.find(t=>t.id===nodeId),children=plan.edges?.filter(e=>e.from===nodeId)||[];
 if(task)return {...taskProgress(task,state),task};
 if(!children.length)return taskProgress(null,state);
 const ids=new Set(),visit=id=>{if(ids.has(id))return;ids.add(id);for(const edge of plan.edges.filter(e=>e.from===id))visit(edge.to);};visit(nodeId);
 const leaves=plan.nodes.filter(n=>ids.has(n.id)&&n.id!==plan.rootId&&n.nodeType!=='group'),items=leaves.map(n=>taskProgress(state.tasks?.find(t=>t.id===n.id),state)),verified=items.filter(p=>p.key==='verified').length,running=items.filter(p=>p.key==='running').length,unbuilt=items.filter(p=>['unbuilt','blocked'].includes(p.key)).length;
 return {key:running?'running':verified===items.length&&items.length?'verified':'partial',label:`하위 ${verified}/${items.length}개 검증 완료`,detail:`진행 ${running} · 미개발/차단 ${unbuilt} · 나머지 ${items.length-verified-running-unbuilt}`};
}
