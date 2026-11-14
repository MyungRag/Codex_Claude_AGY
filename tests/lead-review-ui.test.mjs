import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createPlan,addNode} from '../public/planning-model.js?v=0.13.0';
import {applyQuestionSynthesis} from '../public/review-model.js?v=0.13.0';
const until=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('lead review did not finish');};

test('the selected lead integrates three independent results, reuses them for chat, and restores user edits after a failed save',async t=>{
 const {window}=new JSDOM('<body></body>',{url:'https://agent-desk.test/'});
 for(const key of ['window','document','localStorage','sessionStorage','location','FormData'])globalThis[key]=key==='window'?window:window[key];
 window.HTMLDialogElement.prototype.showModal=function(){};window.HTMLDialogElement.prototype.close=function(){};
 const {runner}=await import('../public/agent-client.js?v=0.13.0');const original={startPending:runner.startPending,agents:runner.agents,runnerInfo:runner.runnerInfo,token:runner.token};
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
 const {openDecisionAI}=await import('../public/decision-ai-ui.js?v=0.13.0');let saved,fail=true;
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

async function automaticReviewFixture(t,kind){
 const {window}=new JSDOM('<body></body>',{url:'https://agent-desk.test/'});
 for(const key of ['window','document','localStorage','sessionStorage','location','FormData'])globalThis[key]=key==='window'?window:window[key];
 window.HTMLDialogElement.prototype.showModal=function(){};window.HTMLDialogElement.prototype.close=function(){};
 const {runner}=await import('../public/agent-client.js?v=0.13.0'),{openLeadReview}=await import('../public/lead-review-ui.js?v=0.13.0');
 const original={startPending:runner.startPending,pollPending:runner.pollPending,cancelPending:runner.cancelPending,refresh:runner.refresh,agents:runner.agents,runnerInfo:runner.runnerInfo,token:runner.token};
 t.after(()=>{Object.assign(runner,original);window.close();});
 runner.agents=['codex','claude','agy'].map(id=>({id,available:true}));runner.runnerInfo={features:{leadReview:true}};runner.token='';
 const calls=[],finish=new Map();let applied=0;
 runner.startPending=async(job,prompt,jobKind)=>{calls.push({agent:job.agent,kind:jobKind,prompt});Object.assign(job,{id:'auto-'+calls.length,status:'running'});};
 runner.pollPending=async(job,update)=>new Promise(resolve=>{finish.set(job.id,()=>{job.status='succeeded';job.result={summary:'통합안',items:[],omitted:[]};update(job);finish.delete(job.id);resolve(job);});});
 runner.cancelPending=async job=>{finish.get(job.id)?.();job.status='cancelled';job.cancelRequested=true;};
 const project={id:'auto-'+kind,name:'계산기'},plan=createPlan(project),options={project,plan,kind,nodeIds:[plan.rootId],prompt:()=> '독립 검토',synthesize:jobs=>JSON.stringify(jobs),validate:r=>r,preview:()=>'<p>통합 결과</p>',onApply:()=>{applied++;},onClose(){}};
 const key=kind==='organize'?'agent-desk-organize-'+project.id:'agent-desk-decisions-'+project.id+'-questions';
 return {window,runner,calls,finish,key,options,open:()=>openLeadReview(options),applied:()=>applied,$:s=>document.querySelector(s)};
}

test('live status is visible without opening details and heartbeat never replaces controls or loses open panels',async t=>{
 const f=await automaticReviewFixture(t,'organize'),{$,window,finish}=f;
 let tick;window.setInterval=fn=>{tick=fn;return 1;};
 await f.open();$('#lead-review-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await until(()=>finish.size===3);
 const panel=$('[data-job-activity]');assert.ok(panel);assert.equal(panel.closest('details'),null);assert.equal(panel.querySelectorAll('.job-activity').length,3);
 const button=$('[data-lr="cancel"]');$('[data-review-originals]').open=true;tick();
 assert.equal($('[data-lr="cancel"]'),button);assert.equal($('[data-review-originals]').open,true);
 finish.get('auto-1')();await until(()=>$('[data-review-progress]').textContent.includes('1/3'));
 assert.equal($('[data-review-originals]').open,true,'poll render keeps user-opened details');
 finish.get('auto-2')();finish.get('auto-3')();await until(()=>finish.has('auto-4'));
 assert.equal($('[data-job-activity]').querySelectorAll('.job-activity').length,1,'synthesis shows only the current lead');
 finish.get('auto-4')();await until(()=>$('[data-lr="apply"]')&&!$('[data-lr="apply"]').disabled);
 const input=$('[data-instruction]'),apply=$('[data-lr="apply"]');input.value='보존할 입력';input.dispatchEvent(new window.Event('input',{bubbles:true}));tick();
 assert.equal($('[data-instruction]'),input);assert.equal(input.value,'보존할 입력');assert.equal($('[data-lr="apply"]'),apply);
});

test('opening the monitor and returning during review shares the original flow without duplicate requests',async t=>{
 const f=await automaticReviewFixture(t,'questions'),{$,window,calls,finish}=f;
 await f.open();$('#lead-review-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await until(()=>finish.size===3);
 $('[data-lr="monitor"]').click();assert.equal($('.agent-dialog'),null);assert.match(location.hash,/activity/);
 const returning=f.open();await until(()=>!!$('.agent-dialog'));assert.equal(calls.length,3);
 for(const id of ['auto-1','auto-2','auto-3'])finish.get(id)();await until(()=>finish.has('auto-4'));
 assert.equal(calls.length,4);assert.equal(calls[3].kind,'questions-merge');finish.get('auto-4')();await returning;
 assert.ok($('[data-lr="apply"]'));assert.equal(calls.length,4);$('[data-lr="apply"]').click();await until(()=>!$('.agent-dialog'));assert.equal(f.applied(),1);
});

for(const kind of ['questions','organize'])test(`${kind}: select the lead before starting and automatically synthesize after every independent review settles`,async t=>{
 const f=await automaticReviewFixture(t,kind),{$,window,calls,finish}=f;
 await f.open();assert.match($('[data-lead]').parentElement.textContent,/시작 전에 주 AI 선택/);
 $('[data-lead]').value='claude';$('[data-lead]').dispatchEvent(new window.Event('change',{bubbles:true}));
 $('#lead-review-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await until(()=>finish.size===3);
 assert.equal($('[data-lead]'),null);assert.match($('[data-selected-lead]').textContent,/Claude/);assert.equal($('[data-lr="merge"]'),null);
 assert.match($('[data-review-progress]').textContent,/자동으로 통합/);
 finish.get('auto-1')();finish.get('auto-2')();await until(()=>$('[data-review-progress]').textContent.includes('2/3'));
 assert.equal(calls.length,3,'the lead waits for every participating review');finish.get('auto-3')();await until(()=>finish.has('auto-4'));
 assert.equal(calls[3].agent,'claude');assert.equal($('[data-lr="merge"]'),null);assert.match($('[data-review-progress]').textContent,/2\/2.*Claude/);
 finish.get('auto-4')();await until(()=>$('[data-lr="apply"]')&&!$('[data-lr="apply"]').disabled);
 assert.equal(f.applied(),0,'automatic synthesis does not apply the plan without review');$('[data-lr="apply"]').click();await until(()=>!$('.agent-dialog'));assert.equal(f.applied(),1);
});

test('restored in-flight reviews continue to the preselected lead once; cancelled work never resumes automatically',async t=>{
 const f=await automaticReviewFixture(t,'questions'),{$,calls,finish,window}=f;
 // v0.9.0 saved jobs did not yet include the automatic-continuation flag.
 sessionStorage.setItem(f.key,JSON.stringify({version:1,baseChange:0,nodeIds:f.options.nodeIds,lead:'agy',instruction:'',jobs:['codex','claude','agy'].map(agent=>({id:'restored-'+agent,agent,status:'running'})),merge:null,edits:{}}));
 let refreshed=0;f.runner.runnerInfo=null;f.runner.refresh=async()=>{refreshed++;f.runner.runnerInfo={features:{leadReview:true}};};
 const opening=f.open();await until(()=>finish.size===3);assert.equal(calls.length,0,'existing reviews are polled, not re-requested');
 for(const id of [...finish.keys()])finish.get(id)();await until(()=>finish.has('auto-1'));
 assert.equal(calls.length,1);assert.equal(refreshed,1,'reload restores runner capabilities before the new synthesis request');assert.equal(calls[0].agent,'agy');finish.get('auto-1')();await opening;
 $('[data-lr="close"]').click();await f.open();assert.equal(calls.length,1,'a completed synthesis is not requested again after reopening');
 $('[data-lr="reset"]').click();$('#lead-review-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await until(()=>finish.size===3);
 $('[data-lr="cancel"]').click();await until(()=>$('[data-lr="close"]')&&!$('[data-lr="close"]').disabled);
 assert.equal(JSON.parse(sessionStorage.getItem(f.key)).autoMerge,false);assert.equal(calls.length,4);
 $('[data-lr="close"]').click();await f.open();assert.equal(calls.length,4,'cancelled reviews must not restart on reopening');
});

test('a saved failed synthesis presents one retry using existing replies, and invalid results do not trigger a retry loop',async t=>{
 const f=await automaticReviewFixture(t,'organize'),{$,calls,finish}=f;
 const jobs=['codex','claude','agy'].map(agent=>({id:'saved-'+agent,agent,status:'succeeded',result:{summary:agent+' 원본 응답 보존',nodes:[],excluded:[]}}));
 sessionStorage.setItem(f.key,JSON.stringify({version:1,baseChange:0,nodeIds:f.options.nodeIds,lead:'codex',instruction:'',jobs,merge:{agent:'codex',status:'failed',error:'요청 내용을 확인해 주세요.'},edits:{}}));
 let invalid=true;f.options.validate=result=>{if(invalid)throw new Error('통합안의 노드 연결을 확인해 주세요.');return result;};
 await f.open();assert.equal(calls.length,0);assert.match($('[data-review-progress]').textContent,/주 AI 통합 실패/);
 assert.match($('[data-lr="merge"]').textContent,/기존 응답.*재시도/);assert.equal($('[data-review-originals]').open,false);assert.equal($('[data-review-restart]').open,false);
 assert.ok($('[data-lr="merge"]').compareDocumentPosition($('[data-review-originals]'))&window.Node.DOCUMENT_POSITION_FOLLOWING,'retry is visible before the long original outputs');
 $('[data-lr="merge"]').click();await until(()=>finish.has('auto-1'));assert.equal(calls[0].kind,'organize-merge');finish.get('auto-1')();await until(()=>$('.agent-error').textContent.includes('노드 연결'));
 assert.equal(calls.length,1);assert.equal($('[data-lr="apply"]'),null);assert.match($('[data-review-progress]').textContent,/통합 실패/);
 assert.deepEqual(JSON.parse(sessionStorage.getItem(f.key)).jobs,jobs,'validation failure retains all independent replies');
 invalid=false;$('[data-lr="merge"]').click();await until(()=>finish.has('auto-2'));finish.get('auto-2')();await until(()=>$('[data-lr="apply"]')&&!$('[data-lr="apply"]').disabled);
 assert.equal(calls.length,2);assert.ok(calls.every(c=>c.kind==='organize-merge'),'retry never re-runs the three independent reviews');assert.equal(f.applied(),0);
});
