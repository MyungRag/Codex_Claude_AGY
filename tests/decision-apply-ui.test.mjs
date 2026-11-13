import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createPlan,addNode,validatePlan} from '../public/planning-model.js?v=0.8.0';
import {addDecision,updateDecision} from '../public/decision-model.js?v=0.8.0';

const until=async check=>{for(let n=0;n<100;n++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.fail('Decision application did not finish');};
const proposal=(nodeId,type='question',question='어떤 가격을 비교하나요?')=>({type,nodeIds:[nodeId],relatedIds:[],question,reason:'구현 범위 확인',evidence:'사용자 확인 필요',options:[],blocking:true});
const job=(id,items,agent='codex',include=true)=>({id,agent,status:'succeeded',include,result:{summary:'질문 검토 완료',items}});

async function setup(t){
 const {window}=new JSDOM('<main id="planning-root"></main>',{url:'https://agent-desk.test/'});
 for(const key of ['window','document','localStorage','sessionStorage','location','FormData'])globalThis[key]=key==='window'?window:window[key];
 window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
 window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
 const {mountPlanner}=await import('../public/planning.js?v=0.8.0');
 const {handleDecisionClick}=await import('../public/decision-ui.js?v=0.8.0');
 const project={id:'apply-review',name:'질문 반영',description:'선택 결과 반영 확인',instructions:''};
 project.planning=createPlan(project);
 const work=addNode(project.planning,project.planning.rootId,{title:'가격 비교',criteria:'최종 가격 표시'});
 const other=addNode(project.planning,project.planning.rootId,{title:'예약',criteria:'예약 완료 표시'});
 let saved=structuredClone(project.planning),failSave=false,saveGate=null;const messages=[];
 const host=mountPlanner(document.querySelector('main'),{project,revision:0,icon:()=>'',toast:m=>messages.push(m),exportProject(){},save:async(next,revision)=>{if(failSave)throw new Error('저장 실패');if(saveGate)await saveGate;saved=validatePlan(next);return revision+1;}});
 host.page='decisions';host.render();
 t.after(()=>{host.destroy();window.close();});
 const key='agent-desk-decisions-'+project.id+'-questions';
 const open=async(jobs,nodeIds=[work.id],baseChange=host.plan.changeNumber)=>{
  sessionStorage.setItem(key,JSON.stringify({jobs,nodeIds,baseChange}));
  await handleDecisionClick(host,{target:document.querySelector('[data-dec="ai-questions"]'),preventDefault(){}});
 };
 const apply=async()=>{document.querySelector('[data-dai="apply"]').click();await until(()=>!document.querySelector('.agent-dialog'));};
 return {host,work,other,open,apply,key,messages,saved:()=>saved,failSave:value=>{failSave=value;},holdSave:promise=>{saveGate=promise;}};
}

test('applying constraints opens the saved item in the check tab and preserves it after serialization',async t=>{
 const ctx=await setup(t);await ctx.open([job('constraint-run',[proposal(ctx.work.id,'constraint','예산 한도는 얼마인가요?')])]);
 await ctx.apply();assert.equal(ctx.saved().items.length,1);assert.equal(ctx.saved().items[0].status,'check');
 assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').dataset.tab,'check');
 assert.match(document.querySelector('.decision-detail').textContent,/예산 한도/);
 assert.equal(sessionStorage.getItem(ctx.key),null);
 ctx.host.plan=validatePlan(JSON.parse(JSON.stringify(ctx.saved())));ctx.host.render();
 assert.match(document.querySelector('.decision-list').textContent,/예산 한도/);
});

test('applying questions from the completed tab selects the new unanswered question',async t=>{
 const ctx=await setup(t);const previous=addDecision(ctx.host.plan,proposal(ctx.work.id,'question','기존 확정 질문'));
 updateDecision(ctx.host.plan,previous.id,{answer:'기존 답변'},'confirm');
 ctx.host.decisionState.tab='done';ctx.host.render();
 await ctx.open([job('question-run',[proposal(ctx.work.id)])]);await ctx.apply();
 assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').dataset.tab,'answer');
 assert.match(document.querySelector('.decision-detail').textContent,/어떤 가격/);
 assert.equal(ctx.saved().items.find(i=>i.id===previous.id).answer,'기존 답변');
 assert.equal(ctx.saved().items.find(i=>i.id===previous.id).status,'done');
});

test('restored review results remain visible when the current node filter differs from the reviewed node',async t=>{
 const ctx=await setup(t);ctx.host.decisionState.node=ctx.other.id;ctx.host.render();
 await ctx.open([job('restored-run',[proposal(ctx.work.id)])]);await ctx.apply();
 assert.match(document.querySelector('.decision-list').textContent,/어떤 가격/);
 assert.equal(document.querySelector('#decision-answer').dataset.itemId,ctx.saved().items[0].id);
});

test('changing included responses updates the apply button and applies only selected successful jobs',async t=>{
 const ctx=await setup(t);
 await ctx.open([job('codex-run',[proposal(ctx.work.id)]),job('claude-run',[proposal(ctx.work.id,'constraint','예산 한도는?')],'claude',false)]);
 document.querySelector('[data-dai-include="codex"]').click();
 assert.equal(document.querySelector('[data-dai="apply"]').disabled,true);
 document.querySelector('[data-dai-include="claude"]').click();
 assert.equal(document.querySelector('[data-dai="apply"]').disabled,false);
 await ctx.apply();assert.equal(ctx.saved().items.length,1);
 assert.equal(ctx.saved().items[0].question,'예산 한도는?');
 assert.deepEqual(ctx.saved().appliedRuns,['claude-run']);
});

test('an initially unselected restored result can be selected and applied',async t=>{
 const ctx=await setup(t);await ctx.open([job('unselected-run',[proposal(ctx.work.id)],'codex',false)]);
 assert.equal(document.querySelector('[data-dai="apply"]').disabled,true);
 document.querySelector('[data-dai-include="codex"]').click();
 assert.equal(document.querySelector('[data-dai="apply"]').disabled,false);
 await ctx.apply();assert.equal(ctx.saved().items.length,1);
});

test('all three restored AI reviews apply when one ordinary question contains invalid decision links',async t=>{
 const ctx=await setup(t);
 const jobs=[job('valid-codex',[proposal(ctx.work.id)],'codex'),job('valid-claude',[proposal(ctx.work.id,'verification','계약 확인은?')],'claude'),job('bad-links-agy',[{...proposal(ctx.work.id,'constraint','예산 한도는?'),relatedIds:[ctx.work.id,'invented-decision']}],'agy')];
 await ctx.open(jobs);document.querySelector('[data-dai="apply"]').click();
 await until(()=>!document.querySelector('.agent-dialog')||document.querySelector('.agent-error')?.textContent);
 assert.equal(document.querySelector('.agent-dialog'),null,document.querySelector('.agent-error')?.textContent);
 assert.equal(ctx.saved().items.length,3);assert.deepEqual(ctx.saved().appliedRuns,jobs.map(j=>j.id));
 assert.deepEqual(ctx.saved().items.at(-1).relatedIds,[]);assert.equal(ctx.saved().items.at(-1).question,'예산 한도는?');
 assert.equal(sessionStorage.getItem(ctx.key),null);
});

test('a real invalid conflict identifies its AI response and can be excluded without losing the other reviews',async t=>{
 const ctx=await setup(t);
 await ctx.open([job('keep-codex',[proposal(ctx.work.id)],'codex'),job('keep-claude',[proposal(ctx.work.id,'constraint','예산은?')],'claude'),job('reject-agy',[{...proposal(ctx.work.id,'conflict','서로 충돌하나요?'),relatedIds:['missing-a','missing-b']}],'agy')]);
 document.querySelector('[data-dai="apply"]').click();await until(()=>document.querySelector('.agent-error')?.textContent.includes('AGY 응답의 1번 항목'));
 assert.equal(ctx.saved().items.length,0);assert.ok(sessionStorage.getItem(ctx.key));
 document.querySelector('[data-dai-include="agy"]').click();await ctx.apply();
 assert.equal(ctx.saved().items.length,2);assert.deepEqual(ctx.saved().appliedRuns,['keep-codex','keep-claude']);
});

test('completed results can be applied while refreshing agent connections is still pending',async t=>{
 const ctx=await setup(t),{runner}=await import('../public/agent-client.js?v=0.8.0');
 const originalRequest=runner.request,originalRefresh=runner.refresh;
 let finishRefresh,refreshStarted=false;
 const refresh=new Promise(resolve=>{finishRefresh=resolve;});
 const completed=job('completed-before-refresh',[proposal(ctx.work.id)]);
 runner.request=async path=>{assert.equal(path,'/api/agents/jobs/'+completed.id);return completed;};
 runner.refresh=async()=>{refreshStarted=true;await refresh;};
 const opening=ctx.open([{id:completed.id,agent:'codex',status:'running'}]);
 t.after(async()=>{finishRefresh();await opening;runner.request=originalRequest;runner.refresh=originalRefresh;});
 await until(()=>refreshStarted&&document.querySelector('.review-results')?.textContent.includes('응답 도착'));
 assert.equal(document.querySelector('[data-dai="apply"]').disabled,false,'finished reviews must not wait for unrelated CLI connection checks');
 await ctx.apply();assert.equal(ctx.saved().items.length,1);assert.equal(sessionStorage.getItem(ctx.key),null);
 finishRefresh();await opening;await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(sessionStorage.getItem(ctx.key),null,'late connection refresh must not restore an already applied review');
});

test('failed persistence preserves the review and selection for retry',async t=>{
 const ctx=await setup(t);const before=structuredClone(ctx.host.decisionState);ctx.failSave(true);
 await ctx.open([job('retry-run',[proposal(ctx.work.id,'constraint')])]);
 document.querySelector('[data-dai="apply"]').click();await until(()=>document.querySelector('.agent-error')?.textContent.includes('저장하지 못했습니다'));
 assert.deepEqual(ctx.host.decisionState,before);assert.equal(ctx.saved().items.length,0);
 assert.ok(sessionStorage.getItem(ctx.key));ctx.failSave(false);await ctx.apply();
 assert.equal(ctx.saved().items.length,1);assert.equal(sessionStorage.getItem(ctx.key),null);
});

test('in-dialog diagnostics identify a pending save without including project or review content',async t=>{
 const ctx=await setup(t);let finishSave;
 ctx.holdSave(new Promise(resolve=>{finishSave=resolve;}));t.after(()=>finishSave());
 await ctx.open([job('pending-save-run',[proposal(ctx.work.id,'constraint','비공개 질문 내용')])]);
 document.querySelector('[data-dai="apply"]').click();await until(()=>ctx.host.saving);
 assert.ok(document.querySelector('.agent-dialog'));
 const details=document.querySelector('.decision-diagnostics');details.open=true;
 details.dispatchEvent(new window.Event('toggle'));
 const text=document.querySelector('[data-dai-diagnostics]').value,report=JSON.parse(text);
 assert.equal(report.build,'decision-review-links-fix4');assert.equal(report.applyClicks,1);
 assert.equal(report.applyPhase,'saving-plan');assert.equal(report.busy,true);assert.equal(report.host.saving,true);
 assert.deepEqual(report.jobs,[{agent:'codex',status:'succeeded',included:true,hasResult:true,items:1}]);
 for(const privateText of ['비공개 질문 내용',ctx.host.project.name,ctx.host.project.description,ctx.work.id,'pending-save-run'])assert.equal(text.includes(privateText),false);
 document.querySelector('[data-dai="copy-diagnostics"]').click();
 await until(()=>document.querySelector('[data-dai-copy-status]').textContent.length>0);
 finishSave();await until(()=>!document.querySelector('.agent-dialog'));assert.equal(ctx.saved().items.length,1);
});

test('failed apply attempts expose the failure phase and focus the error without clearing responses',async t=>{
 const ctx=await setup(t);await ctx.open([job('invalid-node-run',[proposal('unknown-node')])]);
 document.querySelector('[data-dai="apply"]').click();await until(()=>document.querySelector('.agent-error')?.textContent.includes('검토하지 않은 노드'));
 const report=JSON.parse(document.querySelector('[data-dai-diagnostics]').value);
 assert.equal(report.applyPhase,'failed');assert.equal(report.applyClicks,1);assert.equal(report.busy,false);
 assert.equal(document.activeElement,document.querySelector('.agent-error'));
 assert.ok(sessionStorage.getItem(ctx.key));assert.equal(ctx.saved().items.length,0);
});

test('a stale review is rejected without clearing pending results or changing the plan',async t=>{
 const ctx=await setup(t);await ctx.open([job('stale-run',[proposal(ctx.work.id)])],[ctx.work.id],ctx.host.plan.changeNumber+1);
 document.querySelector('[data-dai="apply"]').click();await until(()=>document.querySelector('.agent-error')?.textContent.includes('기획이 변경'));
 assert.equal(ctx.saved().items.length,0);assert.ok(sessionStorage.getItem(ctx.key));
});

test('an empty proposal saves review coverage and explains that no questions changed',async t=>{
 const ctx=await setup(t);await ctx.open([job('empty-run',[])]);await ctx.apply();
 assert.equal(ctx.saved().items.length,0);assert.equal(ctx.saved().questionCoverage[0].nodeId,ctx.work.id);
 assert.match(ctx.messages.at(-1),/새로 추가되거나 변경된 질문·확인 항목은 없습니다/);
});

test('a duplicate proposal opens the updated source on the existing confirmed answer',async t=>{
 const ctx=await setup(t),input=proposal(ctx.work.id),previous=addDecision(ctx.host.plan,input);
 updateDecision(ctx.host.plan,previous.id,{answer:'세금 포함',evidence:'사용자가 확인함'},'confirm');
 ctx.host.render();await ctx.open([job('duplicate-run',[input])]);await ctx.apply();
 assert.equal(ctx.saved().items.length,1);assert.equal(ctx.saved().items[0].status,'done');
 assert.equal(ctx.saved().items[0].answer,'세금 포함');assert.equal(ctx.saved().items[0].evidence,'사용자가 확인함');
 assert.equal(ctx.saved().items[0].sources.length,1);
 assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').dataset.tab,'done');
 assert.equal(document.querySelector('#decision-answer').dataset.itemId,previous.id);
 assert.match(ctx.messages.at(-1),/기존 항목 1개의 AI 의견/);
});
