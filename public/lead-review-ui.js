import {jobActivityState} from './progress-model.js?v=0.9.4';
import {runner,AGENT_INFO,isLocal} from './agent-client.js?v=0.9.4';
import {esc,jobMetadataHTML,jobActivityHTML,modelControls,readModelControls,syncModelControl} from './model-controls.js?v=0.9.4';
import {decisionTypes} from './decision-core.js?v=0.9.4';

const label=id=>AGENT_INFO.find(a=>a.id===id)?.name||id;
const live=job=>job&&['running','unknown'].includes(job.status);
// Both review tools share the same persisted two-stage lifecycle, including cancellation.
export async function openLeadReview({project,plan,kind,nodeIds,prompt,synthesize,validate,repair,preview,onApply,onClose}){
 if(document.querySelector('.agent-dialog'))return;
 const key=kind==='organize'?'agent-desk-organize-'+project.id:'agent-desk-decisions-'+project.id+'-questions';
 const preference='agent-desk-review-lead-'+project.id+'-'+kind;
 let lead=project.development?.lead||'codex';try{lead=localStorage.getItem(preference)||lead;}catch{}
 if(!AGENT_INFO.some(a=>a.id===lead))lead='codex';
 let pending={version:1,baseChange:plan.changeNumber,nodeIds,lead,instruction:'',jobs:[],merge:null,edits:{}},busy=false,error='',cancelled=false;
 try{const saved=JSON.parse(sessionStorage.getItem(key)||'null');if(saved?.version===1){pending=saved;pending.autoMerge??=!saved.merge&&saved.jobs.some(live)&&!saved.jobs.some(j=>j.status==='cancelled'||j.cancelRequested);}}catch{}
 pending.participants||=AGENT_INFO.map(a=>a.id);
 pending.settings||=Object.fromEntries(AGENT_INFO.map(a=>[a.id,runner.getSettings(a.id)]));
 const el=document.createElement('dialog');el.className='agent-dialog agent-dialog-wide';let heartbeat=null;
 const save=()=>{try{sessionStorage.setItem(key,JSON.stringify(pending));return true;}catch{error='검토 임시 저장 공간이 부족합니다. 반영할 때까지 창을 닫지 마세요.';return false;}};
 const allJobs=()=>[...pending.jobs,...(pending.merge?[pending.merge]:[])];
 const active=()=>allJobs().some(live);
 const activityJobs=()=>live(pending.merge)?[pending.merge]:pending.jobs.some(live)?pending.jobs:[];
 const selected=()=>pending.jobs.filter(j=>j.status==='succeeded'&&j.include!==false);
 const fingerprint=()=>JSON.stringify({lead:pending.lead,instruction:pending.instruction,ids:selected().map(j=>j.id)});
 const ready=()=>pending.merge?.status==='succeeded'&&!pending.merge.validationError&&pending.mergeKey===fingerprint();
 const mergeFailed=()=>pending.merge?.status==='failed'||!!pending.merge?.validationError;
 const close=()=>{if(busy||active())return;window.clearInterval(heartbeat);el.close();el.remove();onClose();};
 const getResult=()=>{if(plan.changeNumber!==pending.baseChange)throw new Error('기획이 변경되었습니다. 현재 기획으로 새 검토를 요청해 주세요.');return validate(pending.merge.result,selected(),pending.mergeInstruction,pending.nodeIds);};
 const answerPreview=result=>result.items.map((item,index)=>{
  const previous=item.existingIds.map(id=>plan.items.find(i=>i.id===id)).find(i=>i?.answer),rec=item.recommendation,edit=pending.edits[index];
  return `<article class="decision-ai-item"><h3>${index+1}. ${esc(item.question)}</h3><small>${esc(decisionTypes[item.type])} · ${item.existingIds.length?'기존 질문 갱신':'새 질문'} · ${item.nodeIds.map(id=>esc(plan.nodes.find(n=>n.id===id)?.title||id)).join(' / ')}</small>${previous?`<p>기존 답변: <strong>${esc(previous.answer)}</strong></p>`:''}<p>${esc(rec.kind==='assumption'?'추천 기본값':rec.kind==='user'?'대화에서 전달한 요구':'외부 확인 필요')}: <strong>${esc(rec.answer||rec.reason)}</strong></p><p>${esc(rec.reason)}</p><div class="decision-options">${item.options.map((o,n)=>`<button type="button" class="button" data-choice="${index}" data-option="${n}">${esc(o.label)}${o.label===rec.answer?' · 기본값':''}</button>`).join('')}</div><label>직접 답변·추가 조건<textarea data-answer="${index}" rows="2" maxlength="6000" placeholder="비워 두면 기존 답변 또는 위 기본값을 사용합니다.">${esc(edit?.answer||'')}</textarea></label><p class="helper">${rec.kind==='unresolved'?'확인되지 않은 사실은 완료로 처리하지 않습니다.':'직접 선택한 내용이 기본값보다 우선합니다.'}</p></article>`;
 }).join('')+(result.omitted.length?`<details><summary>통합에서 제외한 제안 ${result.omitted.length}개</summary>${result.omitted.map(o=>`<p>${esc(o.ref)} · ${esc(o.reason)}</p>`).join('')}</details>`:'');
 const reviewProgress=()=>{
  if(allJobs().some(j=>j.status==='unknown'))return '연결 상태를 확인해야 합니다. 상태를 다시 확인하면 진행 중이던 검토를 이어갑니다.';
  if(activityJobs().some(j=>jobActivityState(j).state==='unknown'))return '실행기 연결 확인이 지연되고 있습니다. 현재 요청의 상태를 확인하고 있습니다.';
  if(live(pending.merge))return pending.merge.repairAttempt?`2/2 · 주 AI ${label(pending.lead)}가 질문 연결을 자동 정정 중입니다 (1/1회). 추가 버튼 조작 없이 기다리세요.`:`2/2 · 주 AI ${label(pending.lead)}가 통합 중입니다. 완료되면 통합안을 확인할 수 있습니다.`;
  if(pending.autoMerge&&!pending.merge)return `1/2 · 독립 검토 ${pending.jobs.filter(j=>!live(j)).length}/${pending.jobs.length}개 처리 완료. 끝나면 주 AI ${label(pending.lead)}가 자동으로 통합합니다. 중간에 버튼을 누를 필요가 없습니다.`;
  if(ready())return (pending.merge.repairAttempt?'자동 정정·검증 완료':'검토·통합 완료')+' · 아래 통합안을 확인한 뒤 반영하세요.';
  if(mergeFailed()&&pending.repairAttempts)return `자동 정정 1회 후에도 통합안을 확인하지 못했습니다. 추가 자동 요청은 하지 않습니다. 독립 검토 응답 ${selected().length}개는 보관되어 있습니다.`;
  if(mergeFailed())return `주 AI 통합 실패 · 독립 검토 응답 ${selected().length}개는 보관되어 있습니다. 아래 버튼으로 통합만 다시 시도하세요.`;
  return '기존 응답이 준비되어 있습니다. 주 AI 통합만 진행할 수 있습니다.';
 };
 const leadControls=()=>pending.jobs.length&&(busy||active())?`<p data-selected-lead>미리 선택한 주 AI: <strong>${esc(label(pending.lead))}</strong></p>${pending.instruction?`<p>전달한 추가 요구: ${esc(pending.instruction)}</p>`:''}`:`<label>${pending.jobs.length?'주 AI · 필요할 때만 변경':'시작 전에 주 AI 선택'}<select data-lead ${busy?'disabled':''}>${AGENT_INFO.map(a=>`<option value="${a.id}" ${pending.lead===a.id?'selected':''}>${a.name}</option>`).join('')}</select></label><label>추가 요구 · 주 AI에게 대화로 전달<textarea data-instruction rows="3" maxlength="6000" ${busy?'disabled':''} placeholder="예: 계산은 DEG를 기본으로 하고 RAD 전환도 제공해 줘.">${esc(pending.instruction)}</textarea></label>`;
 const finalPreview=()=>{try{const result=getResult();return `<section class="lead-result"><h3>주 AI 통합안 · ${esc(label(pending.lead))}</h3><p>${esc(result.summary)}</p>${result.normalizationNotes?.length?`<p class="helper" data-review-normalized>${result.normalizationNotes.map(esc).join(' ')}</p>`:''}<button class="button primary" data-lr="apply" ${busy||active()||!ready()?'disabled':''}>통합안 반영${kind==='questions'?' · 미선택은 기본값 적용':''}</button>${preview?preview(result,pending.nodeIds):answerPreview(result)}</section>`;}catch(e){return `<p class="agent-error">${esc(e.message)}</p>`;}};
 const mergeButton=()=>`<button class="button ${ready()?'':'primary'}" data-lr="merge" ${busy||active()||!selected().length?'disabled':''}>${mergeFailed()?'기존 응답으로 주 AI 통합 재시도':pending.merge?'추가 요구로 다시 통합 · 선택':'기존 응답으로 주 AI 통합'}</button>`;
 const originals=()=>`<details data-review-originals><summary>독립 검토 원본 보기 · ${pending.jobs.length}개 AI · 선택 사항</summary>${pending.jobs.map(j=>`<article><h3>${esc(label(j.agent))} · ${esc({succeeded:'응답 도착',running:'검토 중',unknown:'상태 확인 필요',failed:'응답 실패',cancelled:'취소됨'}[j.status]||j.status)}</h3>${jobMetadataHTML(j)}${j.status==='succeeded'?`<label><input type="checkbox" data-include="${j.agent}" ${j.include===false?'':'checked'} ${busy||active()?'disabled':''}> 통합에 포함</label><pre class="context-preview">${esc(JSON.stringify(j.result,null,2))}</pre>`:`<p>${esc(j.error||'')}</p>`}</article>`).join('')}</details>`;
 const render=()=>{
  if(!el.isConnected)return;
  const panels=['data-review-originals','data-review-adjust','data-review-restart','data-review-metadata','data-review-history'],opened=panels.filter(key=>el.querySelector('['+key+']')?.open);
  const working=busy||active(),hasJobs=pending.jobs.length>0;
  el.innerHTML=`<header><div><span class="eyebrow">REVIEW → LEAD → APPLY</span><h2>${kind==='organize'?'AI로 노드 정리':'AI로 질문 검토'} · 주 AI 통합</h2></div><button class="small-icon" data-lr="close" ${working?'disabled':''}>✕</button></header>
   <div class="agent-dialog-body"><p>${esc(project.name)} · 각 AI가 독립 검토한 뒤 주 AI가 하나로 정리합니다.</p>
   ${hasJobs?`<p data-review-progress role="status"><strong>${esc(reviewProgress())}</strong></p>`:''}
   <p class="agent-error" role="status" tabindex="-1">${esc(error||pending.merge?.validationError||pending.merge?.error||'')}</p>
   ${hasJobs?`
    ${working?leadControls():''}
    <section data-job-activity aria-label="현재 AI 진행 상태">${activityJobs().map(jobActivityHTML).join('')}</section>
    <div class="review-actions">${!working&&!ready()?mergeButton():''}${active()?'<button class="button" data-lr="cancel">요청 취소</button>':''}${allJobs().some(j=>j.status==='unknown')?`<button class="button" data-lr="recover" ${busy?'disabled':''}>상태 다시 확인</button>`:''}</div>
    ${ready()?finalPreview():''}
    ${!working?`<details data-review-adjust><summary>추가 요구·주 AI 변경 · 필요할 때만</summary>${leadControls()}${ready()?mergeButton():''}</details>`:''}
    ${pending.merge?.startedAt?`<details data-review-metadata><summary>주 AI 요청 정보</summary>${jobMetadataHTML(pending.merge)}</details>`:''}
    ${originals()}
    ${!working?'<details data-review-restart><summary>독립 검토부터 새로 시작 · 기존 응답 교체</summary><p>현재 기획으로 참여 AI 모두에게 새로 요청합니다. 통합만 실패했다면 위의 기존 응답 재시도를 사용하세요.</p><button class="button" data-lr="reset">현재 기획으로 새 검토</button></details>':''}
   `:`${leadControls()}<form id="lead-review-form"><fieldset class="review-agent-picks"><legend>독립 검토에 참여할 AI</legend>${AGENT_INFO.map(a=>`<label><input type="checkbox" name="agents" value="${a.id}" ${runner.agents.find(s=>s.id===a.id)?.available?(pending.participants.includes(a.id)?'checked':''):'disabled'}>${a.name}</label>`).join('')}</fieldset><details><summary>이번 검토의 모델·추론 설정</summary>${AGENT_INFO.map(a=>`<h4>${a.name}</h4>${modelControls(a.id,pending.settings[a.id],{busy})}`).join('')}</details><p class="helper">AI 연결의 모델 설정을 기본으로 사용합니다. 여기서 바꾼 값은 이번 독립 검토와 주 AI 통합에 적용됩니다. 시작 전에 주 AI를 선택하면 독립 검토 후 자동으로 한 번 더 호출합니다. 중간 조작 없이 통합안까지 만들어 드립니다.${repair?' 질문 통합 결과의 연결 오류는 주 AI가 최대 1회 자동 정정합니다.':''}</p><button class="button primary" ${busy?'disabled':''}>검토 시작 · 주 AI 통합까지 자동 진행</button></form>`}
   ${(plan.reviewHistory||[]).filter(r=>r.kind===kind).length?`<details data-review-history><summary>이전 통합 검토 기록</summary>${plan.reviewHistory.filter(r=>r.kind===kind).map(r=>`<article><strong>${esc(label(r.lead))} · ${esc(r.at)}</strong><p>${esc(r.summary)}</p><p>${esc(r.instruction)}</p><details><summary>AI별 원본</summary><pre class="context-preview">${esc(r.payload)}</pre></details></article>`).join('')}</details>`:''}</div>`;
  for(const key of opened){const panel=el.querySelector('['+key+']');if(panel)panel.open=true;}
 };
 const poll=async job=>{try{await runner.pollPending(job,()=>{job.lastCheckedAt=new Date().toISOString();render();},{refreshInBackground:true});}catch(e){job.status=e.status===404?'failed':'unknown';job.error=e.message;}save();render();};
 const start=async(job,content,jobKind)=>{job.requestedAt||=new Date().toISOString();try{if(!runner.runnerInfo)await runner.refresh();await runner.startPending(job,content,jobKind,pending.settings[job.agent]);job.lastCheckedAt=new Date().toISOString();save();render();if(job.id&&job.status==='running')await poll(job);}catch(e){job.status=e.jobMayExist?'unknown':'failed';job.error=e.message;job.errorCode=e.code;}save();render();};
 const merge=async()=>{
  if(cancelled||active()||!selected().length)return;
  if(plan.changeNumber!==pending.baseChange)throw new Error('기획이 변경되었습니다. 현재 기획으로 새 검토를 요청해 주세요.');
  // Preserve explicit answers as user input when a changed request needs another synthesis.
  let instruction=pending.instruction;
  if(pending.merge?.result?.items){const answers=Object.entries(pending.edits).filter(([,e])=>e.answer?.trim()).map(([i,e])=>({question:pending.merge.result.items[i]?.question,answer:e.answer}));if(answers.length)instruction+='\n이번 통합안에서 사용자가 직접 선택한 답변: '+JSON.stringify(answers);}
  if(instruction.length>6000)throw new Error('추가 요구와 직접 답변이 너무 깁니다. 일부 답변을 먼저 반영해 주세요.');
  pending.instruction=instruction;pending.edits={};const content=synthesize(selected(),instruction,pending.nodeIds);pending.repairAttempts=0;delete pending.repairPrevious;pending.mergeInstruction=instruction;pending.mergeKey=fingerprint();pending.merge={agent:pending.lead,status:'running',requestId:crypto.randomUUID()};save();render();
  await start(pending.merge,content,kind==='organize'?'organize-merge':'questions-merge');
  if(pending.merge.status==='succeeded'){await validateCompleted();pending.edits={};save();}
 };
 const validateCompleted=async()=>{
  try{getResult();delete pending.merge.validationError;save();return;}catch(e){
   pending.merge.validationError=e.message;save();
   if(!repair||e.code!=='QUESTION_SYNTHESIS_INVALID'||pending.repairAttempts>=1||cancelled||active()||pending.mergeKey!==fingerprint()||Object.values(pending.edits).some(edit=>edit.answer?.trim()))throw e;
   const content=repair(pending.merge.result,e,selected(),pending.mergeInstruction,pending.nodeIds);
   // Persist the bounded attempt before sending: reloads must resume this job,
   // never submit another correction or repeat the independent paid reviews.
   pending.repairAttempts=1;pending.repairPrevious={id:pending.merge.id,result:pending.merge.result,error:e.message};
   pending.merge={agent:pending.lead,status:'running',requestId:crypto.randomUUID(),repairAttempt:1};
   if(!save()){pending.merge.status='failed';pending.merge.error=error;render();return;}render();
   await start(pending.merge,content,'questions-merge');
   if(pending.merge.status==='succeeded'){
    try{getResult();delete pending.merge.validationError;}catch(failure){pending.merge.validationError=failure.message;save();throw failure;}
   }
   save();
  }
 };
 const continueAutomatically=async()=>{if(!pending.autoMerge||pending.merge||cancelled||active())return;pending.autoMerge=false;save();await merge();};
 const run=async operation=>{if(busy)return;busy=true;error='';render();try{await operation();}catch(e){error=e.message;}finally{busy=false;if(el.isConnected)save();render();if(error)el.querySelector('.agent-error')?.focus();}};
 el.addEventListener('cancel',e=>{e.preventDefault();close();});
 const collectModels=()=>{if(el.querySelector('#lead-review-form'))for(const a of AGENT_INFO)pending.settings[a.id]=readModelControls(el,a.id);};
 el.addEventListener('input',e=>{if(e.target.dataset.customModel)syncModelControl(e);collectModels();if(e.target.matches('[data-instruction]')){pending.instruction=e.target.value;const apply=el.querySelector('[data-lr="apply"]');if(apply)apply.disabled=!ready();}if(e.target.hasAttribute('data-answer'))pending.edits[e.target.dataset.answer]={answer:e.target.value};save();});
 el.addEventListener('change',e=>{syncModelControl(e);collectModels();if(e.target.matches('[data-instruction],[data-answer],[data-custom-model]')){save();return;}if(e.target.name==='agents'){pending.participants=[...el.querySelectorAll('[name=agents]:checked')].map(x=>x.value);save();return;}if(e.target.matches('[data-lead]')){pending.lead=e.target.value;try{localStorage.setItem(preference,pending.lead);}catch{}}if(e.target.dataset.include)pending.jobs.find(j=>j.agent===e.target.dataset.include).include=e.target.checked;save();render();});
 el.addEventListener('submit',e=>{e.preventDefault();const agents=new FormData(e.target).getAll('agents');void run(async()=>{if(!agents.length)throw new Error('AI 연결에서 참여할 AI를 연결해 주세요.');runner.requireFeature('leadReview');cancelled=false;pending.autoMerge=true;pending.jobs=agents.map(agent=>({agent,status:'running',requestId:crypto.randomUUID()}));save();render();await Promise.all(pending.jobs.map(j=>start(j,prompt(pending.instruction,pending.nodeIds),kind)));await continueAutomatically();});});
 el.addEventListener('click',e=>{const load=e.target.closest('[data-model-load]');if(load){void run(async()=>{collectModels();await runner.models(load.dataset.modelLoad);});return;}if(e.target.closest('[data-model-reset]')){syncModelControl(e);collectModels();save();return;}const choice=e.target.closest('[data-choice]');if(choice&&!busy){const index=choice.dataset.choice;pending.edits[index]={answer:pending.merge.result.items[index].options[Number(choice.dataset.option)].label};save();render();return;}
  const action=e.target.closest('[data-lr]')?.dataset.lr;
  if(action==='close')close();
  if(action==='merge')void run(async()=>{cancelled=false;await merge();});
  if(action==='cancel'){cancelled=true;pending.autoMerge=false;save();void Promise.all(allJobs().filter(live).map(async job=>{try{await runner.cancelPending(job);}catch(e){job.status='unknown';job.error=e.message;}})).then(()=>{save();render();});}
  if(action==='recover')void run(async()=>{await Promise.all(allJobs().filter(j=>j.id&&live(j)).map(poll));await continueAutomatically();if(pending.merge?.status==='succeeded')await validateCompleted();});
  if(action==='reset'&&!busy&&!active()){pending={version:1,baseChange:plan.changeNumber,nodeIds,lead:pending.lead,instruction:pending.instruction,settings:pending.settings,participants:pending.participants,jobs:[],merge:null,edits:{}};error='';cancelled=false;save();render();}
  if(action==='apply'&&ready())void run(async()=>{getResult();await onApply({result:pending.merge.result,jobs:selected(),id:pending.merge.id,lead:pending.lead,instruction:pending.mergeInstruction,edits:pending.edits,nodeIds:pending.nodeIds,baseChange:pending.baseChange});sessionStorage.removeItem(key);busy=false;close();});
 });
 document.body.append(el);render();el.showModal();
 // Update only the read-only status panel. Never replace input fields or buttons on timer ticks.
 heartbeat=window.setInterval(()=>{if(!el.isConnected){window.clearInterval(heartbeat);return;}const panel=el.querySelector('[data-job-activity]');if(panel)panel.innerHTML=activityJobs().map(jobActivityHTML).join('');const summary=el.querySelector('[data-review-progress] strong');if(summary&&summary.textContent!==reviewProgress())summary.textContent=reviewProgress();},1000);
 // Do not refresh CLI availability on a restored completed result; it can be saved immediately.
 if(pending.jobs.length){await run(async()=>{for(const job of allJobs().filter(j=>live(j)&&!j.id)){try{await runner.cancelPending(job);}catch(e){job.status='unknown';job.error=e.message;}}await Promise.all(allJobs().filter(j=>j.id&&live(j)).map(poll));await continueAutomatically();if(pending.merge?.status==='succeeded')await validateCompleted();});}
 else await run(async()=>{if(isLocal())await runner.connect(location.origin,'',{local:true});else if(runner.token)await runner.refresh();});
}
