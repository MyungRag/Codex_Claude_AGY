import {developmentClient} from './development-client.js?v=0.13.0';
import {programOutcome,taskProgress} from './development-progress.js?v=0.13.0';
import {jobActivityState} from './progress-model.js?v=0.13.0';
import {runner} from './agent-client.js?v=0.13.0';
export const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const e=escapeHTML;
export const names={codex:'Codex',claude:'Claude',agy:'Antigravity'};
const statusNames={queued:'요청 대기',running:'응답 생성 중',succeeded:'응답 완료',failed:'응답 실패',cancelled:'취소됨',interrupted:'실행 중단',unknown:'상태 확인 필요'};
const kinds={'planning-draft':'독립 기획','planning-critique':'초안 검토','planning-refine':'주 AI 기획 확정',review:'기획 검토',organize:'노드 독립 검토','organize-merge':'주 AI 노드 통합',questions:'질문 독립 검토','questions-merge':'주 AI 질문 통합',conflicts:'결정 충돌 검토',handoff:'업무 분담','development-build':'코드 구현','development-audit':'코드 검토','development-analysis':'분석·총괄',probe:'연결 확인'};
const duration=(start,end)=>{const seconds=Math.max(0,Math.floor(((end?Date.parse(end):Date.now())-Date.parse(start))/1000));return Number.isFinite(seconds)?`${Math.floor(seconds/60)}분 ${seconds%60}초`:'—';};
const number=value=>Number.isFinite(value)?value.toLocaleString('ko-KR'):'미제공';
export const callRole=call=>call.kind?.endsWith('-merge')||call.kind==='planning-refine'||call.role==='overall-lead'?'주 AI · 통합':call.kind==='development-build'?'개발':call.kind==='development-audit'?'검토':call.kind==='development-analysis'?(call.role==='preflight-verification-plan'?'검증 계획':'Challenger · 분석'):kinds[call.kind]||'기획';
export function mergeActivity(state={},jobs=[],projectId){
 const calls=new Map([...(state.activityHistory||[]),...(state.aiCalls||[])].map(c=>[c.jobId||c.id,{...c}]));
 for(const job of jobs.filter(j=>j.context?.projectId===projectId)){
  const previous=calls.get(job.id);calls.set(job.id,{...previous,...job,lastCheckedAt:job.observedAt||job.lastCheckedAt,...(previous?.status==='failed'?{status:'failed',error:previous.error}:{}),taskId:previous?.taskId||job.context?.taskId,role:previous?.role||job.context?.role});
 }
 return [...calls.values()].sort((a,b)=>Date.parse(a.requestedAt||a.createdAt)-Date.parse(b.requestedAt||b.createdAt));
}
export function mergedMilliseconds(items,now=Date.now()){
 const intervals=items.map(c=>[Date.parse(c.startedAt),c.finishedAt?Date.parse(c.finishedAt):['running','queued'].includes(c.status)?now:NaN]).filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>=a).sort((a,b)=>a[0]-b[0]);
 let end=0,total=0;for(const [a,b] of intervals){total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}return total;
}
const time=ms=>`${Math.floor(ms/60000)}분 ${Math.floor(ms/1000)%60}초`;
export function usageTotals(calls){
 calls=[...new Map(calls.map((c,i)=>[c.jobId||c.id||i,c])).values()];
 const reported=calls.filter(c=>Number.isFinite(c.usage?.totalTokens));
 const sum=key=>{const known=calls.filter(c=>Number.isFinite(c.usage?.[key]));return known.length?known.reduce((s,c)=>s+c.usage[key],0):null;};
 return {calls:calls.length,failed:calls.filter(c=>c.status==='failed').length,reported:reported.length,tokens:reported.length?reported.reduce((s,c)=>s+c.usage.totalTokens,0):null,input:sum('inputTokens'),output:sum('outputTokens'),milliseconds:calls.reduce((sum,c)=>sum+mergedMilliseconds([c]),0),activeMilliseconds:mergedMilliseconds(calls)};
}
export function outcomeHTML(state,projectId){
 if(!state.attempts?.length)return '';const o=programOutcome(state),c=o.counts;
 return `<section class="program-outcome ${o.active?'is-active':''}" aria-label="프로그램 결과"><h3 role="status">${e(o.title)}</h3>${o.active?'':`<p>${e(o.detail)}</p>`}<p>기능 ${c.total}개 · 코드 있음 ${c.implemented} · 연결 확인 ${c.connected} · 통합 동작 확인 ${c.verified} · 미개발 ${c.unbuilt} · 검사/요청 실패 ${c.failed}</p>${o.active?'':'<small>단계별 집계는 서로 겹칩니다. 통합 연결·동작 확인은 해당 버전의 근거가 있는 기능만 셉니다.</small>'}<div class="dev-actions"><a class="button primary" href="#${e(projectId)}/development/preview">${o.release?'실행·다운로드·기능 확인':'소스·실패 기록 확인'}</a><a class="button" href="#${e(projectId)}/development/progress">노드별 진행 보기</a></div></section>`;
}
export function agentCardsHTML({calls=[],agents=Object.keys(names),taskName=()=>'프로젝트 전체',error='',config={}}={}){
 calls=[...new Map(calls.filter(Boolean).map((c,i)=>[c.id||c.requestId||i,c])).values()];
 return `<div class="agent-stations">${agents.map(agent=>{
  const own=calls.filter(c=>c.agent===agent),current=own.findLast(c=>c.status==='running'),queued=own.filter(c=>c.status==='queued'),last=current||queued[0]||own.at(-1),stats=usageTotals(own),live=last?jobActivityState(last):null;
  const roles=[config.lead===agent?'주 AI':'',config.roles?.builder===agent?'개발':'',config.roles?.auditor===agent?'검토':'',config.roles?.challenger===agent?'Challenger':''].filter(Boolean).join(' · ');
  return `<article class="agent-station agent-${e(agent)} ${current&&!error&&live.state!=='unknown'?'is-running':''}" data-activity-agent="${e(agent)}"><div class="agent-station-top"><span class="agent-orb" aria-hidden="true"></span><span>${e(last?callRole(last):roles||'참여 AI')}</span><b>${e(error?'연결 확인 필요':current?(live.state==='unknown'?'연결 확인 필요':'실행 중'):queued.length?'요청 대기':last?statusNames[last.status]||last.status:'요청 전')}</b></div><h3>${e(names[agent]||agent)}</h3><p class="station-task">${e(last?kinds[last.kind]||last.kind||'요청 준비':'선택한 단계에서 참여합니다')}</p>${last?`<button class="monitor-node-link" data-monitor-node="${e(last.taskId||last.context?.taskId||'')}">${e(taskName(last.taskId||last.context?.taskId))}</button><p class="monitor-time">${time(stats.milliseconds)} <small>AI 누적 처리 시간</small></p><p class="dev-helper">${current?'현재 요청':'마지막 요청'} ${duration(last.startedAt||last.requestedAt||last.createdAt,last.finishedAt)} <small>${current?'경과':'소요'}</small></p><p class="dev-helper">모델: ${e(last.actualModel||last.settings?.model||'기본 모델 · 보고 대기')}</p>${current?`<p class="dev-helper">${e(live.title)}<br>실행기 ${e(live.connection)} · ${e(live.checked)}<br>최근 출력 ${e(live.output)}</p>`:`<p class="dev-helper">${last.status==='succeeded'?'응답 완료 · 다음 단계 또는 결과 확인':last.status==='failed'?'실패 · 아래 오류와 재시도 범위를 확인하세요':last.status==='cancelled'?'취소됨 · 도착한 응답은 보관됩니다':'실행 상태를 확인해 주세요'}</p>`}`:''}<div class="station-stats"><span>호출 <b>${stats.calls}</b></span><span>토큰 <b>${number(stats.tokens)}</b></span><span>대기 <b>${queued.length}</b></span></div></article>`;
 }).join('')}</div>`;
}
export function monitorHTML({calls=[],state={},plan,tab='live',error='',observedAt,config={}}={}){
 const active=calls.filter(c=>c.status==='running'),waiting=calls.filter(c=>c.status==='queued'),totals=usageTotals(calls);
 const taskName=id=>state.tasks?.find(t=>t.id===id)?.title||plan?.nodes?.find(n=>n.id===id)?.title||'프로젝트 전체';
 const heading=`<div class="monitor-heading"><div><span class="eyebrow">AGENTS AT WORK</span><h2>AI 실행 확인</h2><p>현재 실행 ${active.length}개 · 대기 ${waiting.length}개 · ${active.length>1?'여러 AI가 병렬 실행 중':active.length?'AI 응답을 기다리고 있습니다':'진행 중인 AI 호출 없음'}</p></div><span class="monitor-sync ${error?'is-stale':''}">${error?'연결 확인 필요':observedAt?'최근 확인 '+new Date(observedAt).toLocaleTimeString('ko-KR'):'실행기 연결 후 확인'}</span></div><nav class="dev-tabs" aria-label="AI 실행 세부 보기"><button class="button ${tab==='live'?'active':''}" data-monitor-tab="live" aria-pressed="${tab==='live'}">실시간 역할·작업</button><button class="button ${tab==='usage'?'active':''}" data-monitor-tab="usage" aria-pressed="${tab==='usage'}">호출·사용량 기록</button></nav>${error?`<p class="dev-warning">${e(error)} 마지막으로 확인한 상태입니다. 진행·정지 여부를 단정할 수 없습니다.</p>`:''}`;
 const cards=agentCardsHTML({calls,taskName,error,config});
 const elapsed=mergedMilliseconds((state.attempts||[]).map(a=>({...a,startedAt:a.startedAt||a.createdAt}))),clock=`<div class="monitor-clocks"><strong>개발 누적 경과 ${time(elapsed)}</strong><span>AI가 처리한 실제 경과 ${time(totals.activeMilliseconds)}</span><span>AI별 시간 합계 ${time(totals.milliseconds)}</span><small>개발 시도 사이의 휴식 시간은 제외합니다. AI 실제 경과는 병렬 호출의 겹친 시간을 한 번만, AI별 합계는 각각 셉니다.</small></div>`;
 const breakdown=`<section class="dev-card"><h3>AI·역할별 사용량</h3><p class="dev-helper">주 AI 지정은 토큰 우선 배정을 뜻하지 않습니다. 호출 횟수, 입력 문맥, 검토·수정 횟수에 따라 달라집니다. 재시도도 해당 역할에 포함합니다.</p><div class="dev-table-scroll"><table><thead><tr><th>AI / 역할</th><th>호출 / 실패</th><th>처리 시간</th><th>입력 / 출력 토큰</th><th>총 토큰</th></tr></thead><tbody>${Object.keys(names).flatMap(agent=>[...new Set(calls.filter(c=>c.agent===agent).map(callRole))].map(role=>{const stats=usageTotals(calls.filter(c=>c.agent===agent&&callRole(c)===role));return `<tr><td>${names[agent]} · ${e(role)}</td><td>${stats.calls} / ${stats.failed}</td><td>${time(stats.milliseconds)}</td><td>${number(stats.input)} / ${number(stats.output)}</td><td>${number(stats.tokens)}</td></tr>`;})).join('')}</tbody></table></div></section>`;
 const usage=`<section class="monitor-total"><strong>${number(totals.tokens)}</strong><span>보고된 토큰 합계</span><p>호출 ${totals.calls}회 · 실패 ${totals.failed}회 · 사용량 보고 ${totals.reported}/${totals.calls}회</p><small>미제공 사용량은 합계에 포함되지 않습니다. 캐시·추론 토큰을 중복 합산하지 않습니다.</small></section><div class="monitor-usage">${Object.keys(names).map(agent=>{const stats=usageTotals(calls.filter(c=>c.agent===agent));return `<article class="agent-station agent-${agent}"><h3>${names[agent]}</h3><div class="station-stats"><span>호출 <b>${stats.calls}회</b></span><span>호출 시간 <b>${Math.floor(stats.milliseconds/60000)}분</b></span><span>토큰 <b>${number(stats.tokens)}</b></span></div><meter min="0" max="${Math.max(1,totals.tokens||0)}" value="${stats.tokens||0}" aria-label="${names[agent]} 보고된 토큰 비중"></meter><small>사용량 보고 ${stats.reported}/${stats.calls}회</small></article>`;}).join('')}</div>`;
 const list=`<section class="dev-card"><h3>${tab==='live'?'최근 호출과 작업 연결':'호출별 기록'}</h3><div class="dev-table-scroll"><table><thead><tr><th>AI · 역할</th><th>작업</th><th>상태</th><th>시간</th><th>토큰</th></tr></thead><tbody>${calls.slice(tab==='live'?-8:-100).reverse().map(c=>`<tr><td>${e(names[c.agent]||c.agent)}<br><small>${e(callRole(c))}</small></td><td><button class="monitor-node-link" data-monitor-node="${e(c.taskId||'')}">${e(taskName(c.taskId))}</button><small>${e(kinds[c.kind]||c.kind)}</small></td><td>${e(statusNames[c.status]||c.status)}${c.error?`<small>${e(c.error)}</small>`:''}</td><td>${duration(c.startedAt,c.finishedAt)}</td><td>${number(c.usage?.totalTokens)}</td></tr>`).join('')||'<tr><td colspan="5">실제 AI 요청이 시작되면 기록됩니다.</td></tr>'}</tbody></table></div></section>`;
 return `<section class="execution-monitor">${heading}${clock}${state.status==='running'?`<p class="monitor-host" role="status">개발 실행 중 · ${(state.tasks||[]).filter(t=>t.status==='running').map(t=>e(t.title)+' — '+e(taskProgress(t,state).label)+(t.waitReason?' ('+e(t.waitReason)+')':'')).join(' / ')||'다음 작업·통합 결과 준비 중'}</p>`:''}${tab==='live'?`${cards}<p class="dev-helper">같은 AI는 한 번에 한 요청을 처리합니다. 서로 다른 AI의 독립 요청은 동시에 실행합니다. 출력이 없는 시간은 작업 중단의 확정 신호가 아닙니다.</p>`:usage+breakdown}${state.tasks?.some(t=>t.waitReason||t.status==='blocked')?`<details class="dev-card"><summary>대기·보류 이유</summary>${state.tasks.filter(t=>t.waitReason||t.status==='blocked').map(t=>`<p>${e(t.title)}: ${e(t.waitReason||t.error||'필수 조건 확인')}</p>`).join('')}</details>`:''}${list}</section>`;
}
// One subscription per mounted surface; no CLI availability probe on each poll.
export function watchActivity(projectId,onUpdate,{client=runner,interval=1500}={}){
 let closed=false,timer;
 const poll=async()=>{try{if(client.token){const data=await client.request('/api/agents/activity');if(!closed)onUpdate({...data,error:''});}}catch(error){if(!closed)onUpdate({error:error.message});}finally{if(!closed)timer=setTimeout(poll,interval);timer?.unref?.();}};
 void poll();return()=>{closed=true;clearTimeout(timer);};
}
export function mountActivityBanner(root,projectId){
 let stopped=false,state={};const off=developmentClient.watch(projectId,value=>{state=value;paint();},()=>{});let activity={};
 const paint=()=>{if(stopped||!root.isConnected)return;const calls=(activity.jobs||[]).filter(j=>j.context?.projectId===projectId&&j.status==='running');root.innerHTML=`<a class="global-ai-status" href="#${e(projectId)}/activity"><span class="monitor-dot ${calls.length&&!activity.error?'is-running':''}"></span><strong>AI 실행 ${activity.error?'확인 필요':calls.length+'개'}</strong><span>${activity.error?'실행기 연결 확인 중':calls.map(c=>names[c.agent]+' · '+(kinds[c.kind]||c.kind)).join(' / ')||'현재 실행 중인 호출 없음'}</span><b>실행 확인 ↗</b></a>${outcomeHTML(state,projectId)}`;};
 const stop=watchActivity(projectId,data=>{activity=data;paint();});return()=>{stopped=true;off();stop();};
}
