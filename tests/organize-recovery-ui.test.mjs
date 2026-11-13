import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createPlan,addNode} from '../public/planning-model.js?v=0.9.5';
import {addDecision,updateDecision} from '../public/decision-model.js?v=0.9.5';
const node=(id,sourceIds,parentId=null,dependsOn=[])=>({id,sourceIds,parentId,title:'작업 '+id,description:'설명',instructions:'계산 기능 구현',criteria:'실제 동작',reason:'기획 정리',nodeType:'task',dependsOn,functionSteps:['구현','검증'],dependencyState:'defined',dependencyIssues:[],order:1});
async function setup(t,{ambiguous=false,failRepair=false}={}){
 const {window}=new JSDOM('<body></body>',{url:'https://agent-desk.test/'});
 for(const key of ['window','document','localStorage','sessionStorage','location','FormData'])globalThis[key]=key==='window'?window:window[key];
 window.HTMLDialogElement.prototype.showModal=function(){};window.HTMLDialogElement.prototype.close=function(){};
 const {runner}=await import('../public/agent-client.js?v=0.9.5'),{openOrganizer}=await import('../public/organize-ui.js?v=0.9.5');
 const original=Object.fromEntries(['agents','runnerInfo','token','startPending'].map(k=>[k,runner[k]]));t.after(()=>{Object.assign(runner,original);window.close();});
 runner.agents=['codex','claude','agy'].map(id=>({id,available:true}));runner.runnerInfo={features:{leadReview:true}};runner.token='';
 const project={id:'organize-recovery',name:'공학용 계산기',description:'공학용 계산기 만들기'},plan=createPlan(project),a=addNode(plan,plan.rootId,{title:'계산 엔진',criteria:'계산 가능'}),b=addNode(plan,plan.rootId,{title:'화면',criteria:'입력 가능'}),outside=addNode(plan,plan.rootId,{title:'공통 계약',criteria:'인터페이스'});
 const decision=addDecision(plan,{type:'question',question:'각도 단위?',nodeIds:[a.id],relatedIds:[],options:[]});updateDecision(plan,decision.id,{answer:'RAD'},'confirm');
 const root=plan.nodes.find(n=>n.id===plan.rootId),good={summary:'선택 작업 정리',nodes:[node('engine',[a.id]),node('screen',[b.id],'engine',ambiguous?[outside.id]:['engine'])],excluded:[]};
 const bad=ambiguous?{...good,nodes:[node(outside.id,[a.id]),node('screen',[b.id],outside.id,[outside.id])]}:{...good,nodes:[{...root,nodeType:'group',order:null,sourceIds:[],parentId:null,reason:'전체 목표를 유지하고 정리안에도 포함'},...good.nodes.map(n=>({...n,parentId:n.parentId||root.id}))]};
 const jobs=['codex','claude','agy'].map(agent=>({id:'saved-'+agent,agent,status:'succeeded',result:structuredClone(bad)})),key='agent-desk-organize-'+project.id;
 const pending={version:1,baseChange:plan.changeNumber,nodeIds:[a.id,b.id],lead:'codex',instruction:'',jobs,merge:{id:'saved-merge',agent:'codex',status:'succeeded',result:bad,validationError:'정리안 ID가 선택 범위 밖의 노드 ID와 겹칩니다.'},mergeInstruction:'',mergeKey:JSON.stringify({lead:'codex',instruction:'',ids:jobs.map(j=>j.id)}),autoMerge:false,edits:{}};
 sessionStorage.setItem(key,JSON.stringify(pending));const calls=[];let applied;
 runner.startPending=async(job,prompt,kind)=>{calls.push({prompt,kind});Object.assign(job,{id:'correction',status:'succeeded',result:structuredClone(failRepair?bad:good)});};
 return {plan,root,a,b,outside,decision,key,jobs,calls,applied:()=>applied,$:s=>document.querySelector(s),open:()=>openOrganizer({project,plan,selectedIds:[a.id,b.id],onClose(){},onApply:next=>{applied=next;}})};
}

test('restoring a root collision immediately previews the normalized tree and applies with zero AI requests',async t=>{
 const f=await setup(t),{$}=f;await f.open();
 assert.equal(f.calls.length,0);assert.match($('[data-review-normalized]').textContent,/전체 목표/);assert.equal(document.querySelectorAll('.organize-preview-tree > article').length,2);assert.match($('.organize-summary').textContent,/2개 선택 → 2개/);
 assert.equal($('[data-lr="apply"]').disabled,false);$('[data-lr="apply"]').click();
 for(let i=0;i<100&&$('.agent-dialog');i++)await new Promise(r=>setTimeout(r,5));assert.equal($('.agent-dialog'),null);
 const next=f.applied();assert.equal(next.nodes.filter(n=>n.id===f.root.id).length,1);assert.equal(next.nodes.length,f.plan.nodes.length);assert.equal(next.nodes.find(n=>n.id===f.root.id).description,f.root.description);assert.equal(next.items.find(i=>i.id===f.decision.id).answer,'RAD');
 assert.deepEqual(JSON.parse(next.reviewHistory[0].payload),f.jobs.map(({agent,result})=>({agent,result})));
});

for(const failRepair of [false,true])test(`ambiguous organization links use one organize-merge correction and ${failRepair?'stop without a reload loop':'preserve the real outside dependency'}`,async t=>{
 const f=await setup(t,{ambiguous:true,failRepair}),{$}=f;await f.open();assert.equal(f.calls.length,1);assert.equal(f.calls[0].kind,'organize-merge');assert.match(f.calls[0].prompt,/"ambiguousIds"/);assert.ok(f.calls[0].prompt.includes(f.outside.id));
 if(failRepair){assert.equal($('[data-lr="apply"]'),null);assert.match($('[data-review-progress]').textContent,/추가 자동 요청은 하지 않습니다/);$('[data-lr="close"]').click();await f.open();assert.equal(f.calls.length,1);}
 else{assert.equal($('[data-lr="apply"]').disabled,false);assert.match($('.organize-preview-tree').textContent,/공통 계약/);$('[data-lr="apply"]').click();for(let i=0;i<100&&!f.applied();i++)await new Promise(r=>setTimeout(r,5));assert.deepEqual(f.applied().nodes.find(n=>n.id===f.b.id).dependsOn,[f.outside.id]);}
});
