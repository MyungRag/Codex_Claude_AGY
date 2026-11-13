import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {JSDOM} from 'jsdom';
import {createPlan,newNode,validatePlan,changePlan} from '../public/planning-model.js';
import {finalizePlan,readiness,createAssignments,saveAssignments,handoffDocument,applyDecisionReviews} from '../public/decision-model.js';
import {handleDecisionSubmit} from '../public/decision-ui.js';
import {prepareDevelopmentTasks} from '../public/development-core.js';
import {DevelopmentRunner} from '../scripts/development-runner.mjs';

const project={id:'order-project',name:'실행 순서',description:'계층과 실행은 별개',instructions:''};
function fixture({issue=false}={}){
 const plan=createPlan(project),root=plan.rootId;
 const entries=[
  {id:'a-ui',title:'화면',order:1,dependsOn:['m-domain'],functionSteps:['입력 검증','도메인 결과 표시']},
  {id:'b-independent',title:'독립 문서',order:20,dependsOn:[],functionSteps:['사용 안내 작성']},
  {id:'g-group',title:'계산 모듈 묶음',nodeType:'group',criteria:''},
  {id:'m-domain',title:'도메인 계산',order:2,dependsOn:['z-core'],functionSteps:['검증된 계약 확인','순수 계산']},
  {id:'z-core',title:'입력 스키마',order:9,dependsOn:[],functionSteps:['입력 스키마 정의','경계값 검증'],...(issue?{dependencyIssues:['삭제된 규정 자료의 대체를 확인하세요.']}: {})}
 ];
 for(const entry of entries){plan.nodes.push({...newNode({instructions:'계획에 따라 구현',criteria:'필요한 검증 통과',dependencyState:'defined',...entry}),id:entry.id});plan.edges.push({from:['m-domain','z-core'].includes(entry.id)?'g-group':root,to:entry.id});}
 return finalizePlan(project,validatePlan(plan));
}
function input(plan){const baseline=plan.baselines.at(-1);return {requestId:randomUUID(),project:{...project,path:path.resolve('/tmp/order-source')},baseline,handoff:{baselineId:baseline.id,tasks:createAssignments(baseline).reverse()},config:{strategy:'assignment',limits:{maxRevisions:0,maxReviews:3,maxSwitches:0},checks:[]}};}

// The host scheduler and task pipeline are real. Model responses and filesystem
// side effects are bounded fixtures; this test does not call a provider account.
async function runner(t){
 const dataRoot=await mkdtemp(path.join(os.tmpdir(),'execution-order-')),sha='a'.repeat(40),calls=[];
 const workspace={create:async()=>({path:'/tmp/order-candidate'}),commit:async()=>sha,context:async()=>({files:[]}),apply:async(_candidate,files)=>({changedPaths:files.map(f=>f.path)}),check:async()=>[{passed:true,exitCode:0,output:'fixture passed',label:'fixture check',codeSha:sha}]};
 const runtime=new DevelopmentRunner({agentRunner:{},workspace,dataRoot});
 runtime._release=async()=>{};runtime._assembleDraft=async()=>{}; // This fixture isolates node scheduling from final runnable assembly.
 runtime._ai=async(_state,_attempt,_operation,provider,kind,payload)=>{
  calls.push({provider,kind,payload:structuredClone(payload)});
  if(kind==='development-build')return {summary:'fixture implementation',files:[{path:payload.task.id+'.js',action:'write',content:'export const ready = true;'}],limitations:[]};
  if(kind==='development-audit')return {summary:'fixture audit',verdict:'pass',verifiedCriteria:[{criterion:payload.task.criteria,evidence:'fixture check'}],unverifiedCriteria:[],previousFindings:[],findings:[]};
  return {summary:'fixture summary',recommendation:'continue',risks:[]};
 };
 t.after(async()=>{await runtime.close();await rm(dataRoot,{recursive:true,force:true});});return {runtime,calls,workspace};
}
async function done(runtime,payload){await runtime.start(payload);await runtime.runs.get(project.id)?.done;return runtime.get(project.id);}

test('frozen planning metadata reaches ordered handoff, groups stay structural, and reload preserves baseline currency',()=>{
 let plan=fixture(),baseline=plan.baselines[0];const tasks=createAssignments(baseline);
 assert.deepEqual(tasks.map(t=>t.nodeId),['z-core','m-domain','a-ui','b-independent']);
 assert.deepEqual(baseline.snapshot.nodes.find(n=>n.id==='a-ui').functionSteps,['입력 검증','도메인 결과 표시']);
 plan=saveAssignments(plan,baseline.id,tasks.slice().reverse());
 assert.deepEqual(plan.handoffs[0].tasks.map(t=>t.nodeId),tasks.map(t=>t.nodeId));
 assert.equal(readiness(project,validatePlan(JSON.parse(JSON.stringify(plan)))).current,true);
 assert.match(handoffDocument(baseline,plan.handoffs[0]),/\[함수 구현 순서\]/);
 const prepared=prepareDevelopmentTasks(baseline,plan.handoffs[0],{});
 assert.deepEqual(prepared.map(t=>t.id),tasks.map(t=>t.nodeId));assert.equal(prepared[0].order,9);assert.equal(prepared[0].dependencyState,'defined');
 const changed=changePlan(plan,'순서 변경',p=>{p.nodes.find(n=>n.id==='a-ui').functionSteps.push('접근성 검사');});
 assert.equal(readiness(project,changed).current,false);assert.equal(changed.baselines[0].snapshot.nodes.find(n=>n.id==='a-ui').functionSteps.length,2);
});

test('legacy snapshots without metadata remain current and unreviewed rather than assumed independent',()=>{
 let plan=createPlan(project);const node=newNode({title:'기존 작업',instructions:'구현',criteria:'검증'});plan.nodes.push(node);plan.edges.push({from:plan.rootId,to:node.id});plan=finalizePlan(project,validatePlan(plan));
 const legacy=JSON.parse(JSON.stringify(plan));for(const n of legacy.nodes)for(const key of ['nodeType','order','dependsOn','functionSteps','dependencyState','dependencyIssues'])delete n[key];
 const restored=validatePlan(legacy);assert.equal(readiness(project,restored).current,true);
 assert.equal(createAssignments(restored.baselines[0])[0].dependencyState,'unreviewed');
});

test('manual handoff save keeps execution metadata and order, with explicit repair acknowledgement',async()=>{
 let plan=fixture({issue:true});const baseline=plan.baselines[0];plan=saveAssignments(plan,baseline.id,createAssignments(baseline));
 const tasks=plan.handoffs[0].tasks,dom=new JSDOM('<form id="decision-handoff"></form>'),form=dom.window.document.querySelector('form');form.dataset.baseline=baseline.id;
 for(const task of tasks){
  for(const [name,value] of [['agent',task.agent],['instructions',task.instructions],['criteria',task.criteria],['deliverable',task.deliverable]]){const element=dom.window.document.createElement('input');element.name=name+'-'+task.nodeId;element.value=value;form.append(element);}
  for(const dependency of task.dependsOn){const element=dom.window.document.createElement('input');element.name='depends-'+task.nodeId;element.value=dependency;form.append(element);}
  const checkbox=dom.window.document.createElement('input');checkbox.type='checkbox';checkbox.name='dependency-review-'+task.nodeId;checkbox.checked=true;form.append(checkbox);
 }
 const original=globalThis.FormData;globalThis.FormData=dom.window.FormData;
 try{const host={plan,project,saving:false,toast(){},async persist(next,after){this.plan=next;after?.();}};await handleDecisionSubmit(host,{target:form,preventDefault(){}});plan=host.plan;}
 finally{globalThis.FormData=original;dom.window.close();}
 assert.deepEqual(plan.handoffs[0].tasks.map(t=>t.nodeId),['z-core','m-domain','a-ui','b-independent']);
 assert.deepEqual(plan.handoffs[0].tasks[0].functionSteps,['입력 스키마 정의','경계값 검증']);
 assert.equal(plan.handoffs[0].tasks[0].dependencyState,'defined');assert.deepEqual(plan.handoffs[0].tasks[0].dependencyIssues,[]);
});

test('actual host dispatch respects cross-hierarchy prerequisites before order and sends steps to Builder/Auditor',async t=>{
 const {runtime,calls}=await runner(t),payload=input(fixture());const state=await done(runtime,payload);
 assert.equal(state.status,'completed');assert.ok(state.tasks.every(t=>t.status==='passed'));
 const builds=calls.filter(c=>c.kind==='development-build');assert.deepEqual(builds.map(c=>c.payload.task.id),['z-core','b-independent','m-domain','a-ui']);
 assert.deepEqual(builds[3].payload.task.dependsOn,['m-domain']);assert.deepEqual(builds[3].payload.task.functionSteps,['입력 검증','도메인 결과 표시']);
 assert.deepEqual(calls.find(c=>c.kind==='development-audit'&&c.payload.task.id==='a-ui').payload.task.functionSteps,builds[3].payload.task.functionSteps);
 const retry=structuredClone(payload);retry.requestId=randomUUID();retry.retry=true;retry.handoff.tasks.find(t=>t.nodeId==='z-core').functionSteps.push('추가 계약 검사');
 const preview=await runtime.preview(retry);assert.equal(preview.entries.find(e=>e.taskId==='z-core').action,'build');assert.equal(preview.entries.find(e=>e.taskId==='a-ui').action,'verify');
});

test('deleted prerequisite holds affected tasks while unrelated work runs; holds invalidate previously passed descendants even when unselected',async t=>{
 const {runtime,calls}=await runner(t),payload=input(fixture());await done(runtime,payload);calls.length=0;
 const retry=input(fixture({issue:true}));retry.retry=true;retry.selection={taskIds:['b-independent']};
 const preview=await runtime.preview(retry);assert.ok(['z-core','m-domain','a-ui'].every(id=>preview.entries.find(e=>e.taskId===id).action==='wait'));
 const held=await done(runtime,retry);assert.ok(held.tasks.filter(t=>t.id!=='b-independent').every(t=>t.status==='blocked'));
 assert.equal(held.tasks.find(t=>t.id==='b-independent').status,'passed');assert.ok(!calls.some(c=>c.kind==='development-build'&&c.payload.task.id!=='b-independent'));
 const other=await runner(t),fresh=await done(other.runtime,input(fixture({issue:true})));
 assert.equal(fresh.tasks.find(t=>t.id==='b-independent').status,'passed');assert.deepEqual(other.calls.filter(c=>c.kind==='development-build').map(c=>c.payload.task.id),['b-independent']);
});


test('changed structural group instructions invalidate its executable descendants and downstream verification',async t=>{
 const {runtime}=await runner(t),payload=input(fixture());await done(runtime,payload);
 const retry=structuredClone(payload);retry.requestId=randomUUID();retry.retry=true;retry.baseline.snapshot.nodes.find(n=>n.id==='g-group').instructions='변경된 상위 규정: 계수 0.80을 확인하세요.';
 const entries=(await runtime.preview(retry)).entries;
 assert.equal(entries.find(e=>e.taskId==='z-core').action,'build');assert.equal(entries.find(e=>e.taskId==='m-domain').action,'build');
 assert.equal(entries.find(e=>e.taskId==='a-ui').action,'verify');assert.equal(entries.find(e=>e.taskId==='b-independent').action,'keep');
});

test('question coverage accepts valid long execution metadata without dropping the fingerprint',()=>{
 let plan=createPlan(project);const node=newNode({title:'긴 구현 계획',instructions:'i'.repeat(6000),description:'d'.repeat(3000),criteria:'c'.repeat(3000),functionSteps:Array.from({length:20},(_,i)=>String(i)+'s'.repeat(590))});
 plan.nodes.push(node);plan.edges.push({from:plan.rootId,to:node.id});plan=validatePlan(plan);
 const reviewed=applyDecisionReviews(plan,[{id:'review-long',agent:'codex',result:{summary:'',items:[]}}],[node.id],'questions');
 assert.equal(reviewed.questionCoverage.length,1);assert.ok(reviewed.questionCoverage[0].fingerprint.length>20000);
 assert.equal(validatePlan(reviewed).questionCoverage[0].fingerprint,reviewed.questionCoverage[0].fingerprint);
});


test('failed final prerequisite audit invalidates a downstream task already audited at the final SHA',async t=>{
 const {runtime,workspace}=await runner(t),payload=input(fixture()),root=payload.baseline.snapshot.rootId;
 payload.baseline.snapshot.nodes=payload.baseline.snapshot.nodes.filter(n=>[root,'z-core','a-ui'].includes(n.id));
 payload.baseline.snapshot.nodes.find(n=>n.id==='a-ui').dependsOn=['z-core'];payload.baseline.snapshot.edges=[{from:root,to:'z-core'},{from:root,to:'a-ui'}];
 payload.handoff.tasks=payload.handoff.tasks.filter(task=>['z-core','a-ui'].includes(task.nodeId));payload.handoff.tasks.find(task=>task.nodeId==='a-ui').dependsOn=['z-core'];
 let version=0;const sha=()=>String(version).padStart(40,'0');
 workspace.apply=async(_candidate,files)=>{version++;return {changedPaths:files.map(f=>f.path)};};workspace.commit=async()=>sha();workspace.check=async()=>[{passed:true,exitCode:0,output:'fixture passed',label:'fixture',codeSha:sha()}];
 const original=runtime._ai.bind(runtime);runtime._ai=async(...args)=>{const result=await original(...args),kind=args[4],context=args[5];if(kind==='development-audit'&&context.task.id==='z-core'&&version===2)return {...result,verdict:'fail',findings:[{type:'implementation',severity:'high',summary:'Final integration broke core',evidence:'fixture regression',remedy:'repair integration'}]};return result;};
 const state=await done(runtime,payload),core=state.tasks.find(task=>task.id==='z-core'),ui=state.tasks.find(task=>task.id==='a-ui');
 assert.equal(core.status,'failed');assert.equal(ui.status,'blocked');assert.equal(ui.needsVerification,true);assert.equal(ui.audit.codeSha,sha());assert.equal(ui.audit.verdict,'pass');assert.match(ui.error,/필수 결과물/);
});
