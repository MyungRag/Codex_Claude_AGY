// Shared, factual projection for the planning board, execution view and saved preview.
export const roleLabel=call=>call.kind==='development-build'?'개발':call.kind==='development-audit'?'검토':call.role==='preflight-verification-plan'?'검증 계획':call.role==='overall-lead'?'총괄':'Challenger 분석';
export function taskProgress(task,state={}){
 if(state.connectionError&&['running','cancelling'].includes(state.status))return {key:'waiting',label:'연결 확인 필요 · 마지막 상태',detail:state.connectionError};
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

// Source, integrated behavior and execution evidence are different milestones.
export function programOutcome(state={}){
 const tasks=(state.tasks||[]).filter(t=>!t.isAssembly),release=(state.releases||[]).find(r=>r.id===(state.latestPreviewId||state.latestRunnableId));
 const connected=t=>release&&t.integration?.codeSha===release.codeSha&&['implemented','partial'].includes(t.integration.status);
 const verified=t=>connected(t)&&t.integration.verified===true;
 const counts={total:tasks.length,implemented:tasks.filter(t=>t.changedPaths?.length||t.artifactSha).length,connected:tasks.filter(connected).length,verified:tasks.filter(verified).length,unbuilt:tasks.filter(t=>!t.artifactSha&&!t.changedPaths?.length).length,failed:tasks.filter(t=>taskProgress(t,state).key==='failed').length};
 const active=['running','cancelling'].includes(state.status),latest=state.attempts?.at(-1);
 const newerFailure=state.lastPreviewFailure&&(!release||Date.parse(state.lastPreviewFailure.at)>Date.parse(release.createdAt));
 const title=active?'프로그램 개발 진행 중':state.status==='cancelled'?'개발 취소 · 저장 결과 보존':newerFailure?'시작 실패 · 복구 결과 확인':release?(release.stage==='reviewed'?'프로그램 검토 완료':'실행 가능한 초안 확보 · 남은 기능 확인'):latest?'실행 가능한 초안 미확보':'개발 시작 전';
 return {title,counts,release,active,sourceAvailable:state.sourceAvailable,detail:active?'현재 구현·검사·통합을 진행하고 있습니다. 실행 가능한 초안을 확보하면 이곳에서 바로 열 수 있습니다.':newerFailure?state.lastPreviewFailure.message:release?'시작 응답과 기능 검증은 별도입니다. 아래 기능별 상태와 검사 근거를 확인하세요.':latest?'AI 응답은 끝났지만 앱 실행 완료는 아닙니다. 생성 소스와 실패 기록을 확인할 수 있습니다.':''};
}
