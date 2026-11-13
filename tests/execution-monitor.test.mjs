import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mergeActivity,monitorHTML,usageTotals} from '../public/execution-monitor.js';
import {executionMapHTML} from '../public/execution-map.js';
import {mountDevelopment} from '../public/development.js';
import {createPlan,newNode,changePlan,validatePlan} from '../public/planning-model.js';
import {applyDecisionReviews,updateDecision,addDecision} from '../public/decision-model.js';
import {changedQuestionNodes,semanticNode} from '../public/decision-core.js';

const project={id:'monitor',name:'계산기',description:'계산 앱',paths:{current:'/tmp/calculator'}};
function planFixture(){const plan=createPlan(project);for(const id of ['engine','screen']){plan.nodes.push({...newNode({title:id,instructions:'구현',criteria:'실제 동작'}),id});plan.edges.push({from:plan.rootId,to:id});}return validatePlan(plan);}

test('question coverage survives position, priority and parent rearrangement; only changed content asks again',()=>{
 let plan=planFixture();plan=applyDecisionReviews(plan,[{id:'review-empty',agent:'codex',result:{summary:'No questions',items:[]}}],plan.nodes.map(n=>n.id),'questions');assert.deepEqual(changedQuestionNodes(plan),[]);
 const rearranged=changePlan(plan,'배치 변경',p=>{p.nodes.find(n=>n.id==='screen').x=500;p.nodes.find(n=>n.id==='screen').order=3;p.edges=p.edges.map(edge=>edge.to==='screen'?{from:'engine',to:'screen'}:edge);});assert.deepEqual(changedQuestionNodes(rearranged),[]);
 const changed=changePlan(rearranged,'화면 조건 변경',p=>{p.nodes.find(n=>n.id==='screen').criteria='키보드 입력도 동작';});assert.deepEqual(changedQuestionNodes(changed),['screen']);
 const added=changePlan(changed,'기능 추가',p=>{p.nodes.push({...newNode({title:'기록'}),id:'history'});p.edges.push({from:'screen',to:'history'});});assert.deepEqual(changedQuestionNodes(added),['screen','history']);assert.deepEqual(changedQuestionNodes(validatePlan(JSON.parse(JSON.stringify(added)))),['screen','history']);
});

test('old coverage migrates without rereview and unrelated user answers are preserved',()=>{
 let plan=planFixture();const item=addDecision(plan,{type:'question',question:'각도?',nodeIds:['engine'],relatedIds:[],options:[],reason:'',evidence:''});updateDecision(plan,item.id,{answer:'RAD'},'confirm');
 plan.questionCoverage=plan.nodes.map(node=>({nodeId:node.id,fingerprint:JSON.stringify({node:semanticNode(node),parents:plan.edges.filter(e=>e.to===node.id).map(e=>e.from)}),at:new Date().toISOString()}));plan=validatePlan(plan);assert.deepEqual(changedQuestionNodes(plan),[]);
 const changed=changePlan(plan,'화면만 수정',p=>{p.nodes.find(n=>n.id==='screen').instructions='버튼을 크게';});assert.deepEqual(changedQuestionNodes(changed),['screen']);assert.equal(changed.items[0].answer,'RAD');assert.equal(changed.items[0].status,'done');
});

test('activity combines persisted development and live planning calls without duplicate token counting',()=>{
 const state={aiCalls:[{id:'call',jobId:'job',agent:'codex',status:'failed',error:'Invalid structured response',usage:{totalTokens:15}}]},jobs=[{id:'job',agent:'codex',status:'succeeded',context:{projectId:'monitor'},usage:{totalTokens:15}},{id:'question',agent:'claude',status:'running',kind:'questions',context:{projectId:'monitor'}},{id:'other',agent:'agy',status:'running',context:{projectId:'another'}}];
 const calls=mergeActivity(state,jobs,'monitor');assert.equal(calls.length,2);assert.equal(calls[0].status,'failed');assert.equal(usageTotals(calls).tokens,15);assert.equal(usageTotals(calls).reported,1);
 const html=monitorHTML({calls,error:'Disconnected',tab:'live'});assert.match(html,/진행·정지 여부를 단정할 수 없습니다/);assert.doesNotMatch(html,/agent-station agent-claude is-running/);assert.match(monitorHTML({calls,tab:'usage'}),/사용량 보고 1\/2회/);
});

test('execution map keeps recursive containment and dependencies separate with escaped source labels',()=>{
 const plan=planFixture();plan.nodes.push({id:'leaf',title:'<script>leaf</script>'});plan.edges.push({from:'screen',to:'leaf'});plan.edges=plan.edges.map(edge=>edge.to==='screen'?{from:'engine',to:'screen'}:edge);
 const html=executionMapHTML(plan,{tasks:[{id:'leaf',status:'running',builder:'codex',dependsOn:['engine']}]},'leaf',true);assert.match(html,/data-map-node="leaf"/);assert.match(html,/필수 선행 작업/);assert.match(html,/&lt;script&gt;leaf/);assert.doesNotMatch(html,/<script>/);
 const assembly=executionMapHTML(plan,{tasks:[{id:'draft-assembly',title:'실행 가능한 초안 통합',isAssembly:true,status:'running',builder:'codex',dependsOn:[]}]},'draft-assembly');assert.match(assembly,/data-map-node="draft-assembly"/);assert.match(assembly,/실행 가능한 초안 통합/);
});

test('two AI subtabs show actual calls; node navigation and running preview survive live polling',async t=>{
 const dom=new JSDOM('<main id="root"></main>',{url:'http://127.0.0.1:4173/'});for(const key of ['window','document','sessionStorage','localStorage','location','FormData'])globalThis[key]=dom.window[key];
 const plan=planFixture(),state={tasks:[{id:'engine',title:'계산 엔진',status:'running',builder:'codex',checks:[],findings:[]}],status:'running',attempts:[],events:[],releases:[{id:'release',codeSha:'1234',createdAt:new Date().toISOString(),stage:'draft',runnable:true,limitations:[]}],latestRunnableId:'release',aiCalls:[{id:'c',agent:'codex',taskId:'engine',kind:'development-build',status:'running',startedAt:new Date().toISOString(),usage:{totalTokens:20}}]};let receive;
 const root=document.querySelector('#root'),view=mountDevelopment(root,{project:{...project,planning:plan},initialPage:'activity',save:async()=>1,client:{runner:{},connect:async()=>{},watch:(_id,callback)=>{receive=callback;callback(state);return()=>{};}}});t.after(()=>{view.destroy();dom.window.close();});await view.ready;
 assert.equal(root.querySelectorAll('[data-monitor-tab]').length,2);assert.match(root.textContent,/Codex/);root.querySelector('[data-monitor-tab="usage"]').click();assert.match(root.textContent,/보고된 토큰 합계/);root.querySelector('[data-monitor-node="engine"]').click();assert.equal(view.page,'progress');assert.equal(view.focusTask,'engine');
 view.launchURLs.release='http://127.0.0.1:4174/';view.page='preview';view.render();const iframe=root.querySelector('iframe');assert.ok(iframe);receive({...state,revision:2});assert.equal(root.querySelector('iframe'),iframe,'polling must not reload the running program');
});
