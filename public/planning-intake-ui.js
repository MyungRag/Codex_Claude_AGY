import {agentCardsHTML} from './execution-monitor.js?v=0.13.0';
import {runner,AGENT_INFO,isLocal} from './agent-client.js?v=0.13.0';
import {esc,jobActivityHTML,jobMetadataHTML} from './model-controls.js?v=0.13.0';
import {planningPrompt,validateIntake} from './planning-intake-model.js?v=0.13.0';
const sessions=new Map(),name=id=>AGENT_INFO.find(a=>a.id===id)?.name||id;
const finished=j=>['succeeded','failed','cancelled'].includes(j?.status);
export function draftPreview(draft,plan){
 const names=new Map([...plan.nodes,...draft.nodes].map(n=>[n.id,n.title]));
 return `<section class="intake-summary"><h3>초안 구성 · ${draft.nodes.length}개 노드 제안</h3><p>${esc(draft.summary)}</p>${draft.nodes.map(n=>`<article class="intake-node"><small>${esc(n.parentId?names.get(n.parentId):'선택한 기능')} 안에 포함 · ${n.nodeType==='group'?'기능 묶음':'구현 작업'}</small><strong>${esc(n.title)}</strong><p>${esc(n.description)}</p><details><summary>지시·완료 기준·선행 작업</summary><p>${esc(n.instructions)}</p><p>완료 기준: ${esc(n.criteria)}</p><p>선행: ${n.dependsOn.map(id=>esc(names.get(id))).join(' · ')||'없음'}</p><p>병렬 개발 후 연결: ${(n.integrationWith||[]).map(id=>esc(names.get(id))).join(' · ')||'없음'}</p><p>${esc(n.reason)}</p></details></article>`).join('')}</section>`;
}
export async function openPlanningIntake({project,plan,targetId=plan.rootId,promoteIds=[],onApply,onClose}){
 if(document.querySelector('.agent-dialog'))return;
 const key='agent-desk-intake-'+project.id;
 let session=sessions.get(key);if(session?.storage!==sessionStorage)session=null;
 if(!session){let pending;try{pending=JSON.parse(sessionStorage.getItem(key)||'null');}catch{}
  session={storage:sessionStorage,pending:pending?.version===1?pending:{version:1,baseChange:plan.changeNumber,targetId,promoteIds,agents:plan.intakeHistory[0]?.agents||[project.development?.lead||'codex'],lead:plan.intakeHistory[0]?.lead||project.development?.lead||'codex',instruction:'',draft:null,reviews:[],final:null,answers:{},repairCount:0},listeners:new Set(),work:null,error:''};sessions.set(key,session);
 }
 const p=session.pending;p.drafts??=p.draft?[p.draft]:[];const el=document.createElement('dialog');el.className='agent-dialog agent-dialog-wide intake-dialog';let heartbeat;
 const all=()=>[...new Map([...p.drafts,...p.reviews,p.final].filter(Boolean).map(j=>[j.requestId||j.id||j,j])).values()],save=()=>{sessionStorage.setItem(key,JSON.stringify(p));},notify=()=>{for(const fn of session.listeners)fn();};
 const hasResult=()=>p.final?.status==='succeeded'&&!p.validationError;
 const detach=()=>{clearInterval(heartbeat);session.listeners.delete(render);el.close();el.remove();onClose();};
 const render=()=>{
  const busy=!!session.work,started=!!p.drafts.length;
  el.innerHTML=`<header><div><span class="eyebrow">SCOPE → REVIEW → BUILD</span><h2>${p.promoteIds.length?'후속 기능을 기획에 추가':'AI와 초안 기획'}</h2></div><button class="small-icon" data-intake="close" ${busy?'disabled':''}>✕</button></header><div class="agent-dialog-body"><p>${esc(project.name)} · 핵심 범위와 기본값을 정하고 후속 기능은 따로 보관합니다. 계층은 필요한 만큼만 구성합니다.</p>${p.baseChange!==plan.changeNumber?'<p class="agent-error">기획이 변경되었습니다. 이전 결과는 보관되어 있으며 현재 기획으로 새 요청을 시작할 수 있습니다.</p>':''}<p class="agent-error" role="status">${esc(session.error||p.validationError||'')}</p>
   ${!started?`<form data-intake-form><fieldset><legend>참여 AI · 하나 또는 여러 개 선택</legend>${AGENT_INFO.map(a=>`<label class="agent-choice"><input type="checkbox" name="agents" value="${a.id}" ${p.agents.includes(a.id)?'checked':''}>${a.name}</label>`).join('')}</fieldset>${p.agents.length>1?`<label>주 AI · 독립 기획 참여와 최종 통합<select data-intake-lead>${p.agents.map(a=>`<option value="${a}" ${p.lead===a?'selected':''}>${name(a)}</option>`).join('')}</select></label>`:`<p>${esc(name(p.agents[0]))}가 기획을 완성합니다. 별도 통합 호출은 없습니다.</p>`}<label>추가 요구·반드시 포함할 기능<textarea data-intake-instruction rows="4" maxlength="6000">${esc(p.instruction)}</textarea></label><p class="helper">복수 선택 시 모두 동시에 독립 기획 → 주 AI가 자신의 안을 바탕으로 장점을 통합합니다. 중간 조작 없이 결과까지 이어집니다. AI 연결의 모델 설정을 사용합니다.</p><button class="button primary" type="submit" ${busy?'disabled':''}>초안 기획 시작</button></form>`:`<p role="status"><strong>${busy?esc(p.phase||'실행 중'):hasResult()?'기획 완료 · 내용을 확인한 뒤 반영하세요.':p.cancelled?'취소됨 · 받은 응답은 보관되어 있습니다.':`요청 중단 · 성공 응답 ${all().filter(j=>j.status==='succeeded').length}개 보관. ${all().filter(j=>j.status==='failed').map(j=>name(j.agent)+' '+(j.kind==='planning-refine'?'통합':'독립 기획')).join(' · ')} 재시도 가능`}</strong></p><section data-intake-activity>${agentCardsHTML({calls:all(),agents:p.agents,taskName:id=>plan.nodes.find(n=>n.id===id)?.title||project.name})}</section>`}
   ${busy||all().some(j=>!finished(j))?'<div class="review-actions"><button class="button" data-intake="monitor">AI 실행 확인으로 이동</button><button class="button" data-intake="cancel">요청 취소</button></div>':''}
   ${hasResult()?`${draftPreview(p.final.result,plan)}<section class="intake-defaults"><h3>적용 기본값 · 변경 가능</h3>${p.final.result.defaults.map((d,i)=>`<label>${esc(d.question)}<input data-intake-answer="${i}" value="${esc(p.answers[i]??d.answer)}"><small>${esc(d.reason)} · 다른 선택: ${d.alternatives.map(esc).join(' / ')||'직접 입력'}</small></label>`).join('')||'<p>새로 채택할 기본값 없음</p>'}</section><section class="intake-later"><h3>후속 기능 · 현재 개발에 포함하지 않음</h3>${p.final.result.deferred.map(d=>`<article><strong>${esc(d.title)}${d.required?' · 필수 요구 보류 제안':''}</strong><p>장점: ${esc(d.benefit)}</p><p>제외 이유: ${esc(d.reason)}</p><p>난점: ${esc(d.difficulty)} · 필요 조건: ${esc(d.conditions)}</p></article>`).join('')||'<p>후속 후보 없음</p>'}${p.final.result.deferred.some(d=>d.required)?'<label><input type="checkbox" data-intake-required '+(p.allowRequired?'checked':'')+'>필수 요구를 후속으로 미루는 이유를 확인했고 이번 초안에서 보류하는 데 동의합니다.</label>':''}</section><button class="button primary" data-intake="apply" ${busy||p.baseChange!==plan.changeNumber?'disabled':''}>초안 기획 반영</button>`:''}
   ${started&&!busy?`<div class="review-actions">${!hasResult()?`<button class="button" data-intake="retry">${p.drafts.some(j=>j.status==='succeeded')?'성공한 응답을 유지하고 이어가기':'독립 기획 다시 시도'}</button>`:''}<button class="button" data-intake="reset">현재 기획으로 새 요청</button></div><details><summary>참여 AI 응답·호출 정보</summary>${all().map(j=>`<article><h3>${esc(name(j.agent))} · ${esc(j.status)}</h3>${jobMetadataHTML(j)}<p>${esc(j.result?.summary||j.error||'')}</p></article>`).join('')}</details>`:''}</div>`;
 };
 const call=async(job,kind,prompt)=>{
  if(p.cancelled)throw new Error('요청을 취소했습니다.');
  if(job.status==='succeeded')return job;
  job.kind=kind;job.requestedAt||=new Date().toISOString();job.context={projectId:project.id,taskId:p.targetId,role:kind};save();notify();
  if(job.status==='unknown'&&!job.id)throw new Error('요청 번호를 확인하지 못했습니다. 새 요청 전에 기존 요청 취소를 눌러 주세요.');
  try{if(!job.id){await runner.startPending(job,prompt,kind,p.settings?.[job.agent]||runner.getSettings(job.agent));save();notify();}if(!finished(job))await runner.pollPending(job,()=>{save();notify();},{refreshInBackground:true});}
  catch(error){job.status=error.jobMayExist||!error.status&&job.id?'unknown':'failed';job.error=error.message;save();throw error;}
  save();notify();if(job.status!=='succeeded')throw new Error(job.error||'AI 응답이 완료되지 않았습니다.');return job;
 };
 const fresh=agent=>({agent,kind:'planning-draft',status:'running',requestedAt:new Date().toISOString(),requestId:crypto.randomUUID()});
 const flow=async()=>{
  if(!runner.runnerInfo)await runner.refresh();runner.requireFeature('planningIntake');
  const context={targetId:p.targetId,promoteIds:p.promoteIds,instruction:p.instruction};
  // Persist every independent request before dispatch, so reopening never creates another call.
  // A prior-version final request is resumed with its original drafts instead of being discarded.
  if(!p.final?.id){
   p.phase=p.agents.length===1?'선택한 AI가 초안 기획 중':'1/2 · 선택한 '+p.agents.length+'개 AI가 동시에 독립 기획 중';
   p.drafts=p.agents.map(agent=>p.drafts.find(j=>j.agent===agent)||fresh(agent));save();notify();
   await Promise.all(p.drafts.map(j=>call(j,'planning-draft',planningPrompt(project,plan,{...context,phase:'independent'})).catch(()=>{})));
   if(p.cancelled)throw new Error('요청을 취소했습니다.');
   if(p.drafts.some(j=>!finished(j)))throw new Error('일부 요청 상태가 불확실합니다. 기존 요청을 확인하거나 취소한 뒤 이어가세요.');
   const ready=p.drafts.filter(j=>j.status==='succeeded');
   if(!ready.length)throw new Error('독립 기획 응답을 받지 못했습니다. '+p.drafts.map(j=>name(j.agent)+': '+(j.error||'응답 실패')).join(' / '));
   p.draft=ready.find(j=>j.agent===p.lead)||ready[0];p.reviews=ready.filter(j=>j!==p.draft);
   if(p.agents.length===1)p.final=p.draft;
  }
  if(p.agents.length>1){
   p.phase='2/2 · 주 AI '+name(p.lead)+'가 독립 기획의 장점을 통합 중';p.final??=fresh(p.lead);save();notify();
   await call(p.final,'planning-refine',planningPrompt(project,plan,{...context,draft:p.draft?.result,reviews:p.reviews,phase:'refine'}));
  }
  try{validateIntake(plan,p.final.result,context);delete p.validationError;}
  catch(error){p.validationError=error.message;save();if(p.repairCount>=1||p.cancelled)throw error;const prior=p.final.result;p.repairCount=1;p.final=fresh(p.lead);p.phase='연결·형식 자동 정정 · 1/1회';save();notify();await call(p.final,'planning-refine',planningPrompt(project,plan,{...context,instruction:p.instruction+'\n정정할 오류: '+error.message,draft:prior,phase:'repair'}));validateIntake(plan,p.final.result,context);delete p.validationError;}
  save();
 };
 const start=()=>{if(session.work)return;session.error='';session.work=Promise.resolve().then(flow).catch(error=>{session.error=error.message;}).finally(()=>{session.work=null;save();notify();});notify();};
 el.addEventListener('change',e=>{if(e.target.name==='agents'){p.agents=[...el.querySelectorAll('[name=agents]:checked')].map(x=>x.value);if(!p.agents.includes(p.lead))p.lead=p.agents[0]||'codex';save();render();}if(e.target.matches('[data-intake-lead]')){p.lead=e.target.value;save();}if(e.target.matches('[data-intake-required]')){p.allowRequired=e.target.checked;save();}});
 el.addEventListener('input',e=>{if(e.target.matches('[data-intake-instruction]'))p.instruction=e.target.value;if(e.target.hasAttribute('data-intake-answer'))p.answers[e.target.dataset.intakeAnswer]=e.target.value;save();});
 el.addEventListener('submit',e=>{e.preventDefault();if(!p.agents.length){session.error='참여 AI를 하나 이상 선택해 주세요.';render();return;}p.cancelled=false;p.settings=Object.fromEntries(p.agents.map(a=>[a,runner.getSettings(a)]));save();start();});
 el.addEventListener('click',async e=>{
  const action=e.target.closest('[data-intake]')?.dataset.intake;if(!action)return;
  try{
   if(action==='close'&&!session.work)detach();
   if(action==='monitor'){save();detach();location.hash=project.id+'/activity';}
   if(action==='cancel'){p.cancelled=true;save();await Promise.all(all().filter(j=>!finished(j)).map(j=>runner.cancelPending(j)));notify();}
   if(action==='retry'&&!session.work){if(p.baseChange!==plan.changeNumber)throw new Error('기획이 바뀌어 현재 기획으로 새 요청이 필요합니다.');p.cancelled=false;p.drafts=p.drafts.filter(j=>!['failed','cancelled'].includes(j.status));if(p.draft?.status!=='succeeded'&&p.draft?.status!=='unknown')p.draft=null;if(p.final?.status!=='succeeded'||p.validationError)p.final=null;delete p.validationError;save();start();}
   if(action==='reset'&&!session.work){sessionStorage.removeItem(key);sessions.delete(key);detach();await openPlanningIntake({project,plan,targetId,promoteIds,onApply,onClose});}
   if(action==='apply'&&!session.work){if(p.baseChange!==plan.changeNumber)throw new Error('기획이 바뀌었습니다. 현재 기획으로 새 요청을 시작하세요.');el.querySelector('[data-intake=apply]').disabled=true;await onApply(p);sessionStorage.removeItem(key);sessions.delete(key);detach();}
  }catch(error){session.error=error.message;render();}
 });
 el.addEventListener('cancel',e=>{e.preventDefault();if(!session.work)detach();});
 document.body.append(el);session.listeners.add(render);render();el.showModal();heartbeat=setInterval(()=>{const panel=el.querySelector('[data-intake-activity]');if(panel)panel.innerHTML=agentCardsHTML({calls:all(),agents:p.agents,taskName:id=>plan.nodes.find(n=>n.id===id)?.title||project.name});},1000);heartbeat.unref?.();
 if(!session.work&&p.drafts.length&&!p.cancelled&&!hasResult()&&!p.validationError)start();
 if(!runner.runnerInfo)try{if(isLocal())await runner.connect(location.origin,'',{local:true});else if(runner.token)await runner.refresh();}catch(error){session.error=error.message;render();}
}
