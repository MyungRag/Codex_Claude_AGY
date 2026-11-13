import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createPlan,addNode} from '../public/planning-model.js?v=0.9.0';
import {applyQuestionSynthesis} from '../public/review-model.js?v=0.9.0';
const until=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('lead review did not finish');};

test('the selected lead integrates three independent results, reuses them for chat, and restores user edits after a failed save',async t=>{
 const {window}=new JSDOM('<body></body>',{url:'https://agent-desk.test/'});
 for(const key of ['window','document','localStorage','sessionStorage','location','FormData'])globalThis[key]=key==='window'?window:window[key];
 window.HTMLDialogElement.prototype.showModal=function(){};window.HTMLDialogElement.prototype.close=function(){};
 const {runner}=await import('../public/agent-client.js?v=0.9.0');const original={startPending:runner.startPending,agents:runner.agents,runnerInfo:runner.runnerInfo,token:runner.token};
 t.after(()=>{Object.assign(runner,original);window.close();});
 runner.agents=['codex','claude','agy'].map(id=>({id,available:true}));runner.runnerInfo={features:{leadReview:true}};runner.token='';
 const project={id:'lead-ui',name:'계산기',instructions:'',development:{lead:'codex'}},plan=createPlan(project),node=addNode(plan,plan.rootId,{title:'계산',criteria:'정확한 결과'}),calls=[];
 const proposal={type:'question',nodeIds:[node.id],relatedIds:[],question:'각도 단위?',reason:'입력 해석',evidence:'설계 선택',options:[{label:'DEG',impact:'도'},{label:'RAD',impact:'라디안'}],blocking:true,recommendation:{kind:'assumption',answer:'DEG',reason:'일반 계산기',messageIds:[]}};
 runner.startPending=async(job,prompt,kind)=>{
  calls.push({agent:job.agent,kind,prompt});
  if(kind==='questions-merge')assert.equal(calls.filter(c=>c.kind==='questions').length,3);
  const selected=prompt.includes('기본값은 RAD'),rec=selected?{kind:'user',answer:'RAD',reason:'사용자 추가 요구',messageIds:['review-input']}:proposal.recommendation;
  Object.assign(job,{id:'job-'+calls.length,status:'succeeded',result:kind==='questions-merge'?{summary:'주 AI 통합',items:[{...proposal,existingIds:[],sourceRefs:['codex-1','claude-1','agy-1'],recommendation:rec}],omitted:[]}:{summary:job.agent+' 독립 검토',items:[proposal]}});return job;
 };
 const {openDecisionAI}=await import('../public/decision-ai-ui.js?v=0.9.0');let saved,fail=true;
 const options={project,plan,kind:'questions',nodeIds:[node.id],onClose(){},onApply:async jobs=>{if(fail)throw new Error('저장 실패');const d=jobs[0].synthesis;saved=applyQuestionSynthesis(plan,d.nodeIds,d.jobs,d.result,d);}};
 await openDecisionAI(options);const $=s=>document.querySelector(s);
 const participant=$('[name=agents][value=agy]');participant.checked=false;participant.dispatchEvent(new window.Event('change',{bubbles:true}));
 $('[data-lead]').value='agy';$('[data-lead]').dispatchEvent(new window.Event('change',{bubbles:true}));
 assert.equal($('[name=agents][value=agy]').checked,false,'changing lead must preserve participant selection');$('[name=agents][value=agy]').checked=true;$('[name=agents][value=agy]').dispatchEvent(new window.Event('change',{bubbles:true}));
 $('#lead-review-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await until(()=>$('[data-lr="apply"]')&&!$('[data-lr="apply"]').disabled);
 assert.deepEqual(calls.map(c=>c.agent),['codex','claude','agy','agy']);assert.equal(calls[3].kind,'questions-merge');
 $('[data-instruction]').value='기본값은 RAD로 바꿔 줘';$('[data-instruction]').dispatchEvent(new window.Event('input',{bubbles:true}));assert.equal($('[data-lr="apply"]').disabled,true);
 $('[data-lr="merge"]').click();await until(()=>calls.length===5&&$('[data-lr="apply"]')&&!$('[data-lr="apply"]').disabled);
 assert.equal(calls[4].agent,'agy');assert.equal(calls.filter(c=>c.kind==='questions').length,3);assert.match($('.lead-result').textContent,/대화에서 전달한 요구/);
 $('[data-answer="0"]').value='RAD, 소수점 8자리';const applyButton=$('[data-lr="apply"]');$('[data-answer="0"]').dispatchEvent(new window.Event('input',{bubbles:true}));$('[data-answer="0"]').dispatchEvent(new window.Event('change',{bubbles:true}));assert.equal($('[data-lr="apply"]'),applyButton,'blur must not replace the button before the native click');$('[data-lr="apply"]').click();await until(()=>$('.agent-error')?.textContent==='저장 실패');
 assert.equal($('[data-answer="0"]').value,'RAD, 소수점 8자리');assert.ok(sessionStorage.getItem('agent-desk-decisions-lead-ui-questions'));
 $('[data-lr="close"]').click();assert.equal($('.agent-dialog'),null);await openDecisionAI(options);assert.equal(calls.length,5,'restored completed result does not request any AI');
 assert.equal($('[data-answer="0"]').value,'RAD, 소수점 8자리');fail=false;$('[data-lr="apply"]').click();await until(()=>!$('.agent-dialog'));
 assert.equal(saved.items[0].answer,'RAD, 소수점 8자리');assert.equal(saved.items[0].resolution.kind,'user');assert.equal(saved.items[0].sources.length,3);assert.equal(saved.reviewHistory[0].lead,'agy');assert.equal(sessionStorage.getItem('agent-desk-decisions-lead-ui-questions'),null);
 const legacyJobs=['codex','claude','agy'].map(agent=>({agent,id:'legacy-'+agent,status:'succeeded',result:{summary:'기존 미반영 응답',items:[proposal]}}));
 sessionStorage.setItem('agent-desk-decisions-lead-ui-questions',JSON.stringify({jobs:legacyJobs,nodeIds:[node.id],baseChange:plan.changeNumber}));
 await openDecisionAI(options);$('[data-dai="lead-upgrade"]').click();await until(()=>$('[data-lr="merge"]')&&!$('[data-lr="merge"]').disabled);
 assert.equal(calls.length,5,'upgrading cached replies must not re-request independent reviews');
 assert.equal(JSON.parse(sessionStorage.getItem('agent-desk-decisions-lead-ui-questions')).version,1);
 $('[data-lr="merge"]').click();await until(()=>calls.length===6&&$('[data-lr="apply"]')&&!$('[data-lr="apply"]').disabled);
 $('[data-lr="apply"]').click();await until(()=>!$('.agent-dialog'));assert.equal(saved.items[0].resolution.kind,'assumption');

});
