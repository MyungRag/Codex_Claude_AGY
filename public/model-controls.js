import {jobActivityState} from './progress-model.js?v=0.11.0';
import {runner,AGENT_INFO} from './agent-client.js?v=0.11.0';
import {MODEL_PRESETS,EFFORT_LABELS,settingLabel,formatTokens,modelCapability,supportedEfforts,settingsIssue} from './agent-settings.js?v=0.11.0';
export const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function effortOptions(agent,settings,catalog){
 const efforts=supportedEfforts(agent,settings,catalog),invalid=settings.effort&&!efforts.includes(settings.effort);
 return '<option value="">기본값</option>'+efforts.map(e=>`<option value="${esc(e)}" ${settings.effort===e?'selected':''}>${esc(EFFORT_LABELS[e]||e)}</option>`).join('')+(invalid?`<option value="${esc(settings.effort)}" selected disabled>${esc(EFFORT_LABELS[settings.effort]||settings.effort)} · 지원 확인 필요</option>`:'');
}
function capabilityNote(agent,settings,catalog){
 const issue=settingsIssue(agent,settings,catalog);if(issue)return issue;
 const model=modelCapability(catalog,settings.model);
 if(!model||model.efforts===null||model.efforts===undefined)return '추론 강도 지원 정보가 없습니다. 기본값으로 사용할 수 있으며, 목록에서 모델을 선택하면 확인된 강도가 표시됩니다.';
 if(!model.efforts.length)return '이 모델은 추론 강도를 별도로 조정하지 않습니다. 기본값으로 사용하세요.';
 return '선택한 모델에서 확인된 추론 강도만 표시합니다.'+(settings.effort==='max'?' Max는 응답이 오래 걸릴 수 있습니다. 최대 대기 시간을 확인하세요.':' 추론 강도는 응답 속도를 보장하는 설정이 아닙니다.');
}
function verificationNote(agent,settings){
 const state=runner.agents.find(a=>a.id===agent),verified=state?.verifiedSettings;
 if(!verified)return '선택한 설정 · 응답 테스트 전';
 const same=verified.model===settings.model&&verified.effort===settings.effort;
 return same?'선택한 설정 · 최근 응답 확인됨':'선택한 설정 · 응답 테스트 전 (최근 성공: '+settingLabel(verified)+')';
}
function modelIdentity(agent,settings){
 const model=modelCapability(runner.catalogs[agent],settings.model);
 return '선택 모델: '+(model?.name||settings.model||'기본 모델')+(settings.model?' · CLI 선택값: '+settings.model:'')+(model?.resolvedModel?' · CLI 해석 모델: '+model.resolvedModel:'');
}
export function modelControls(agent,settings=runner.getSettings(agent),{busy=false}={}){
 const catalog=runner.catalogs[agent],models=catalog?.models||MODEL_PRESETS[agent];const custom=!!settings.model&&!models.some(m=>m.id===settings.model);
 return `<div class="model-controls" data-model-controls="${agent}"><div class="model-select-row"><label>AI 모델<select data-model-select="${agent}" ${busy?'disabled':''}><option value="">기본 모델</option>${models.map(m=>`<option value="${esc(m.id)}" ${m.id===settings.model?'selected':''}>${esc(m.name)}</option>`).join('')}<option value="__custom" ${custom?'selected':''}>모델 ID 직접 입력</option></select></label><label>추론 강도<select data-effort-select="${agent}" ${busy?'disabled':''}>${effortOptions(agent,settings,catalog)}</select></label></div><p class="helper" data-model-identity>${esc(modelIdentity(agent,settings))}</p><label>최대 대기 시간<select data-wait-select="${agent}" ${busy?'disabled':''}>${[0,5,10,20].map(n=>`<option value="${n}" ${(settings.waitMinutes??0)===n?'selected':''}>${n?n+'분':'무제한 (기본값)'}</option>`).join('')}</select></label><label data-custom-label ${custom?'':'hidden'}>모델 ID<input data-custom-model="${agent}" maxlength="160" value="${custom?esc(settings.model):''}" placeholder="CLI가 사용하는 정확한 모델 ID" ${busy?'disabled':''}></label><p class="helper" data-capability-note role="status">${esc(capabilityNote(agent,settings,catalog))}</p><small data-model-verification>${esc(verificationNote(agent,settings))}</small><div class="model-control-note"><small>${esc(catalog?.note||'기본값으로 응답 테스트에 성공하면 모델 목록을 자동으로 불러옵니다. 먼저 목록을 불러올 수도 있습니다.')}</small><button type="button" class="text-button" data-model-load="${agent}" ${busy?'disabled':''}>모델 목록 ${catalog?'새로고침':'불러오기'}</button><button type="button" class="text-button" data-model-reset="${agent}" ${busy?'disabled':''}>기본값으로 재설정</button></div></div>`;
}
export function readModelControls(root,agent){const control=root.querySelector(`[data-model-controls="${agent}"]`);const selected=control.querySelector('[data-model-select]').value;return {model:selected==='__custom'?control.querySelector('[data-custom-model]').value.trim():selected,effort:control.querySelector('[data-effort-select]').value,...(control.querySelector('[data-wait-select]').value!=='0'?{waitMinutes:Number(control.querySelector('[data-wait-select]').value)}:{})};}
export function syncModelControl(event){
 const control=event.target.closest('[data-model-controls]');if(!control)return;
 const agent=control.dataset.modelControls,reset=event.target.closest('[data-model-reset]');
 if(reset){control.querySelector('[data-wait-select]').value='0';control.querySelector('[data-model-select]').value='';control.querySelector('[data-effort-select]').value='';control.querySelector('[data-custom-model]').value='';}
 const custom=control.querySelector('[data-model-select]').value==='__custom';control.querySelector('[data-custom-label]').hidden=!custom;
 if(event.target.dataset.modelSelect&&custom)control.querySelector('[data-custom-model]').focus();
 let settings=readModelControls(control.parentElement,agent);
 const changed=!!event.target.dataset.modelSelect||!!event.target.dataset.customModel||!!reset;
 if(changed){const select=control.querySelector('[data-effort-select]'),previous=settings.effort;if(!supportedEfforts(agent,settings,runner.catalogs[agent]).includes(settings.effort))settings.effort='';select.innerHTML=effortOptions(agent,settings,runner.catalogs[agent]);control.querySelector('[data-capability-note]').textContent=(previous&&previous!==settings.effort?'모델 변경으로 추론 강도를 기본값으로 돌렸습니다. ':'')+capabilityNote(agent,settings,runner.catalogs[agent]);}
 else control.querySelector('[data-capability-note]').textContent=capabilityNote(agent,settings,runner.catalogs[agent]);
 control.querySelector('[data-model-identity]').textContent=modelIdentity(agent,settings);
 control.querySelector('[data-model-verification]').textContent=verificationNote(agent,settings);
}
export function usageHTML(usage,{compact=false}={}){
 if(!usage)return '<p class="token-usage muted">토큰 사용량 미제공</p>';
 return `<div class="token-usage ${compact?'compact':''}"><span>입력 <strong>${formatTokens(usage.inputTokens)}</strong></span><span>출력 <strong>${formatTokens(usage.outputTokens)}</strong></span><span>합계 <strong>${formatTokens(usage.totalTokens)}</strong></span>${compact?'':`<small>캐시 읽기 ${formatTokens(usage.cachedTokens)} · 캐시 생성 ${formatTokens(usage.cacheWriteTokens)} · 추론 ${formatTokens(usage.reasoningTokens)}<br>캐시·추론 세부 값은 합계에 다시 더하지 않습니다.</small>`}</div>`;
}
export function usageDashboard(){return `<section class="usage-dashboard"><header><div><span class="eyebrow">TOKEN USAGE</span><h3>에이전트별 사용량</h3></div><button class="text-button" type="button" data-usage-refresh>새로고침</button></header><p>현재 PC 실행기를 시작한 뒤 이 대시보드에서 보낸 요청을 집계합니다. 응답 완료 시 갱신됩니다.</p><div class="usage-agent-grid">${AGENT_INFO.map(a=>{const u=runner.usage?.agents?.[a.id];return `<article><strong>${a.name}</strong>${usageHTML(u,{compact:true})}<small>${u?`${u.requests}회 요청 · ${u.unreportedRequests}회 사용량 미제공`:'아직 집계가 없습니다.'}</small></article>`;}).join('')}</div>${runner.usage?.since?`<small>집계 시작: ${esc(new Date(runner.usage.since).toLocaleString('ko-KR'))}</small>`:''}</section>`;}
export function jobProgressText(job){
 if(!job.startedAt)return job.status==='running'?'CLI 실행 준비 중…':'';
 const seconds=Math.floor((job.elapsedMs||0)/1000),elapsed=Math.floor(seconds/60)+'분 '+seconds%60+'초';
 const phase={starting:'CLI 첫 이벤트 대기',initialized:'CLI 초기화 확인 · 모델 응답 대기',processing:'AI 요청 처리 이벤트 수신',error:'CLI 오류 이벤트 수신',receiving:'응답 이벤트 수신 중',result:'최종 응답 수신'}[job.progress?.phase]||'응답 대기';
 const last=job.progress?.lastActivityAt?' · 최근 이벤트 '+new Date(job.progress.lastActivityAt).toLocaleTimeString('ko-KR'):'';
 return `${phase} · 경과 ${elapsed} / ${job.timeoutMs>0?'최대 '+Math.round(job.timeoutMs/60000)+'분':'대기 무제한'}${last}`;
}
export function jobMetadataHTML(job){
 const selected=job.modelInfo?.name?job.modelInfo.name+' · '+(EFFORT_LABELS[job.settings?.effort||'']||job.settings?.effort):settingLabel(job.settings);
 return `<div class="job-model"><span>요청 모델: ${esc(selected)}</span>${job.modelInfo?`<span>CLI 선택값: ${esc(job.settings?.model||'기본값')}${job.modelInfo.resolvedModel?' · 해석 모델: '+esc(job.modelInfo.resolvedModel):''}</span>`:''}${job.actualModel?`<span>CLI 보고 모델: ${esc(job.actualModel)}</span>`:''}<span class="job-progress">${esc(jobProgressText(job))}</span></div>${usageHTML(job.usage)}`;
}

export function jobActivityHTML(job){
 const view=jobActivityState(job),name=AGENT_INFO.find(a=>a.id===job.agent)?.name||job.agent;
 const size=view.bytes<1024?view.bytes+' B':(view.bytes/1024).toFixed(1)+' KB';
 return `<article class="job-activity" data-activity-state="${view.state}"><header><strong>${esc(name)}</strong><span>${esc(view.title)}</span></header><dl><div><dt>경과 시간</dt><dd>${esc(view.elapsed)}</dd></div><div><dt>실행기 연결</dt><dd>${esc(view.connection)} · ${esc(view.checked)}</dd></div><div><dt>AI 프로그램</dt><dd>${esc(view.process)}</dd></div><div><dt>최근 출력 수신</dt><dd>${esc(view.output)}</dd></div></dl><p>${esc(view.note)}</p><small>출력 수신량 ${size} · 최대 대기 ${esc(view.limit)} · 실행기 연결 확인은 AI 출력 수신과 별개입니다.</small></article>`;
}
