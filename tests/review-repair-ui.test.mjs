import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createPlan,addNode} from '../public/planning-model.js?v=0.13.0';
import {addDecision,updateDecision} from '../public/decision-model.js?v=0.13.0';
import {applyQuestionSynthesis} from '../public/review-model.js?v=0.13.0';
const until=async fn=>{for(let i=0;i<300;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('question repair did not settle');};
async function setup(t,{alwaysInvalid=false,holdRepair=false}={}){
 const {window}=new JSDOM('<body></body>',{url:'https://agent-desk.test/'});
 for(const key of ['window','document','localStorage','sessionStorage','location','FormData'])globalThis[key]=key==='window'?window:window[key];
 window.HTMLDialogElement.prototype.showModal=function(){};window.HTMLDialogElement.prototype.close=function(){};
 const {runner}=await import('../public/agent-client.js?v=0.13.0'),{openDecisionAI}=await import('../public/decision-ai-ui.js?v=0.13.0');
 const original=Object.fromEntries(['agents','runnerInfo','token','startPending','pollPending','cancelPending'].map(k=>[k,runner[k]]));
 t.after(()=>{Object.assign(runner,original);window.close();});
 runner.agents=['codex','claude','agy'].map(id=>({id,available:true}));runner.runnerInfo={features:{leadReview:true}};runner.token='';
 const project={id:'repair-ui',name:'계산기'},plan=createPlan(project),node=addNode(plan,plan.rootId,{title:'계산',criteria:'계산 가능'});
 const item={type:'question',nodeIds:[node.id],relatedIds:[],question:'각도 단위?',reason:'삼각함수 입력 해석',evidence:'설계 선택',blocking:true,options:[{label:'RAD',impact:'라디안'},{label:'DEG',impact:'도'}],recommendation:{kind:'assumption',answer:'DEG',reason:'일반 계산기 기본값',messageIds:[]}};
 const saved=addDecision(plan,item);updateDecision(plan,saved.id,{answer:'RAD'},'confirm');
 const jobs=['codex','claude','agy'].map(agent=>({id:'saved-'+agent,agent,status:'succeeded',result:{summary:'독립 검토',items:[item]}}));
 const good={summary:'통합',items:[{...item,question:'삼각함수의 기본 각도 해석?',existingIds:[saved.id],sourceRefs:['codex-1','claude-1','agy-1']}],omitted:[]};
 const bad=structuredClone(good);bad.items[0].existingIds=[];
 const calls=[],waiters=new Map();let applied;
 runner.startPending=async(job,prompt,kind)=>{
  calls.push({kind,prompt,agent:job.agent});const correction=prompt.includes('자동 정정 요청 (최대 1회)');
  Object.assign(job,{id:'request-'+calls.length,status:holdRepair&&correction?'running':'succeeded',result:kind==='questions'?{summary:'독립 검토',items:[item]}:structuredClone(correction&&!alwaysInvalid?good:bad)});
 };
 runner.pollPending=async(job,update)=>new Promise(resolve=>waiters.set(job.id,()=>{if(job.status!=='cancelled'){job.status='succeeded';job.result=structuredClone(alwaysInvalid?bad:good);}update(job);waiters.delete(job.id);resolve(job);}));
 runner.cancelPending=async job=>{job.status='cancelled';job.cancelRequested=true;waiters.get(job.id)?.();};
 const key='agent-desk-decisions-'+project.id+'-questions';
 const pending=()=>({version:1,baseChange:plan.changeNumber,nodeIds:[node.id],lead:'codex',instruction:'',jobs,merge:{id:'old-invalid',agent:'codex',status:'succeeded',result:structuredClone(bad),validationError:'기존 질문을 누락하거나 중복 연결했습니다.'},mergeInstruction:'',mergeKey:JSON.stringify({lead:'codex',instruction:'',ids:jobs.map(j=>j.id)}),autoMerge:false,edits:{}});
 const options={project,plan,kind:'questions',nodeIds:[node.id],onClose(){},onApply:async values=>{const data=values[0].synthesis;applied=applyQuestionSynthesis(plan,data.nodeIds,data.jobs,data.result,data);}};
 return {window,runner,plan,node,saved,calls,jobs,bad,good,key,pending,waiters,open:()=>openDecisionAI(options),applied:()=>applied,$:s=>document.querySelector(s)};
}

test('one start automatically corrects an invalid integration once, then applies without losing the user answer',async t=>{
 const f=await setup(t),{$,window}=f;await f.open();
 $('#lead-review-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
 await until(()=>$('[data-lr="apply"]')&&!$('[data-lr="apply"]').disabled);
 assert.deepEqual(f.calls.map(c=>c.kind),['questions','questions','questions','questions-merge','questions-merge']);
 assert.match(f.calls[4].prompt,/"missing"/);assert.ok(f.calls[4].prompt.includes(f.saved.id));assert.ok(f.calls[4].prompt.includes(JSON.stringify(f.bad)));
 assert.match($('[data-review-progress]').textContent,/자동 정정·검증 완료/);assert.equal(f.applied(),undefined);
 $('[data-lr="apply"]').click();await until(()=>!$('.agent-dialog'));
 assert.equal(f.applied().items.length,1);assert.equal(f.applied().items[0].id,f.saved.id);assert.equal(f.applied().items[0].answer,'RAD');assert.equal(f.applied().items[0].resolution.kind,'user');
});

test('a saved invalid integration is corrected with one lead call, while an exact missing link needs no AI call',async t=>{
 const f=await setup(t),{$}=f;
 sessionStorage.setItem(f.key,JSON.stringify(f.pending()));await f.open();
 assert.equal(f.calls.length,1);assert.match(f.calls[0].prompt,/자동 정정 요청/);assert.ok(!$('[data-lr="apply"]').disabled);
 assert.deepEqual(JSON.parse(sessionStorage.getItem(f.key)).jobs,f.jobs);$('[data-lr="close"]').click();
 const local=f.pending();local.merge.result.items[0].question=f.saved.question;sessionStorage.setItem(f.key,JSON.stringify(local));await f.open();
 assert.equal(f.calls.length,1,'exact identity repair must not request another AI');assert.match($('[data-review-normalized]').textContent,/연결을 복원/);assert.ok(!$('[data-lr="apply"]').disabled);
});

test('invalid correction stops after one attempt and reopening never creates a correction loop',async t=>{
 const f=await setup(t,{alwaysInvalid:true}),{$}=f;sessionStorage.setItem(f.key,JSON.stringify(f.pending()));await f.open();
 assert.equal(f.calls.length,1);assert.equal($('[data-lr="apply"]'),null);assert.match($('[data-review-progress]').textContent,/추가 자동 요청은 하지 않습니다/);
 const failed=JSON.parse(sessionStorage.getItem(f.key));assert.equal(failed.repairAttempts,1);assert.deepEqual(failed.repairPrevious.result,f.bad);assert.deepEqual(failed.jobs,f.jobs);
 $('[data-lr="close"]').click();await f.open();assert.equal(f.calls.length,1);assert.equal($('[data-lr="apply"]'),null);
});

test('an in-flight correction resumes by ID after reload; cancellation never restarts it',async t=>{
 const f=await setup(t,{holdRepair:true}),{$}=f;
 const restored=f.pending();restored.repairAttempts=1;restored.merge={id:'repair-in-flight',agent:'codex',status:'running',repairAttempt:1};sessionStorage.setItem(f.key,JSON.stringify(restored));
 const opening=f.open();await until(()=>f.waiters.has('repair-in-flight'));
 assert.equal(f.calls.length,0);assert.match($('[data-review-progress]').textContent,/자동 정정|연결 확인/);
 f.waiters.get('repair-in-flight')();await opening;assert.ok(!$('[data-lr="apply"]').disabled);assert.equal(f.calls.length,0);$('[data-lr="close"]').click();
 sessionStorage.setItem(f.key,JSON.stringify(f.pending()));const retry=f.open();await until(()=>f.waiters.size===1);
 assert.match($('[data-review-progress]').textContent,/자동 정정 중/);assert.equal(f.calls.length,1);$('[data-lr="cancel"]').click();await retry;
 assert.equal(JSON.parse(sessionStorage.getItem(f.key)).merge.status,'cancelled');$('[data-lr="close"]').click();await f.open();assert.equal(f.calls.length,1);assert.equal($('[data-lr="apply"]'),null);
});

test('connection recovery validates the completed original response and corrects it once',async t=>{
 const f=await setup(t),{$}=f;const saved=f.pending();saved.merge.status='unknown';sessionStorage.setItem(f.key,JSON.stringify(saved));
 let polls=0;f.runner.pollPending=async(job,update)=>{if(!polls++)throw new Error('연결 끊김');Object.assign(job,{status:'succeeded',result:f.bad});update(job);return job;};
 await f.open();assert.equal(f.calls.length,0);$('[data-lr="recover"]').click();await until(()=>$('[data-lr="apply"]')&&!$('[data-lr="apply"]').disabled);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].kind,'questions-merge');assert.match($('[data-review-progress]').textContent,/자동 정정·검증 완료/);
});

test('correction is not dispatched when its attempt budget cannot be saved',async t=>{
 const f=await setup(t);sessionStorage.setItem(f.key,JSON.stringify(f.pending()));
 const setItem=f.window.Storage.prototype.setItem;f.window.Storage.prototype.setItem=function(key,value){if(key===f.key)throw new Error('quota');return setItem.call(this,key,value);};
 t.after(()=>{f.window.Storage.prototype.setItem=setItem;});
 await f.open();assert.equal(f.calls.length,0);assert.match(f.$('.agent-error').textContent,/저장 공간이 부족/);assert.equal(f.$('[data-lr="apply"]'),null);
});
