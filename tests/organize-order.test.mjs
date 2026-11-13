import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createPlan,addNode,validatePlan,travelHistory} from '../public/planning-model.js';
import {organizePlan,parseOrganization,organizationPrompt} from '../public/organize-model.js';
import {ORGANIZE_SCHEMA,parseResponse} from '../scripts/agent-runner.mjs';
const item=(id,sourceIds,meta={})=>({id,parentId:null,sourceIds,title:id,description:'설명',instructions:'구현',criteria:'검증',reason:'계약을 소비하기 전에 기반을 구현',...meta});
const meta=(data={})=>({nodeType:'task',order:1,dependsOn:[],functionSteps:['입력 계약 검증','계산 결과 검증'],dependencyState:'defined',dependencyIssues:[],...data});
const proposal=nodes=>({summary:'상하위 구조와 실행 의존성을 별도로 정리',nodes,excluded:[]});
function sample(){const p=createPlan({name:'순서 검토'}),a=addNode(p,p.rootId,{title:'계약',...meta({order:3})}),b=addNode(p,p.rootId,{title:'계산',...meta({order:2,dependsOn:[a.id]})}),external=addNode(p,p.rootId,{title:'외부 화면',...meta({order:1,dependsOn:[b.id]})});return {p,a,b,external};}

test('organization resolves proposal IDs, retains outside prerequisites and remaps outside dependents through a merge',()=>{
 const {p,a,b,external}=sample();
 const foundation=addNode(p,p.rootId,{title:'공통 기준',...meta()});a.dependsOn=[foundation.id];
 const next=organizePlan(p,[a.id,b.id],proposal([item('combined',[a.id,b.id],meta({order:1,functionSteps:['새 검증 단계']}))]),{agent:'codex'});
 const merged=next.nodes.find(n=>n.id===a.id);
 assert.deepEqual(merged.dependsOn,[foundation.id]);
 assert.deepEqual(next.nodes.find(n=>n.id===external.id).dependsOn,[a.id]);
 assert.deepEqual(merged.functionSteps,['새 검증 단계','입력 계약 검증','계산 결과 검증']);
 assert.equal(merged.order,1);assert.equal(merged.dependencyState,'defined');
 assert.deepEqual(validatePlan(JSON.parse(JSON.stringify(next))),next);
 assert.deepEqual(travelHistory(next,'undo').nodes,p.nodes);
});

test('organizer creates explicit non-executable groups and keeps hierarchy distinct from execution dependencies',()=>{
 const {p,a,b}=sample();
 const result=proposal([
  item('module',[],meta({nodeType:'group',order:null,functionSteps:[]})),
  item('consumer',[b.id],{...meta({order:1,dependsOn:['provider']}),parentId:'module'}),
  item('provider',[a.id],meta({order:9}))
 ]);
 const next=organizePlan(p,[a.id,b.id],result,{agent:'agy'}),group=next.nodes.find(n=>n.title==='module');
 assert.equal(group.nodeType,'group');assert.deepEqual(next.nodes.find(n=>n.id===b.id).dependsOn,[a.id]);
 assert.ok(next.edges.some(e=>e.from===group.id&&e.to===b.id));
 assert.ok(next.edges.some(e=>e.from===p.rootId&&e.to===a.id));
 assert.throws(()=>organizePlan(p,[a.id],proposal([item('new',[],meta()),item('a',[a.id],meta())]),{agent:'agy'}),/그룹/);
});

test('legacy organization preserves implementation metadata instead of silently clearing it',()=>{
 const {p,a,b}=sample();const next=organizePlan(p,[b.id],proposal([item('renamed',[b.id])]),{agent:'claude'}),node=next.nodes.find(n=>n.id===b.id);
 assert.equal(node.order,b.order);assert.deepEqual(node.dependsOn,[a.id]);assert.deepEqual(node.functionSteps,b.functionSteps);assert.equal(node.dependencyState,'defined');
 const parsed=parseResponse('codex','',JSON.stringify(proposal([item('legacy',[a.id])])),'organize');
 assert.equal(Object.hasOwn(parsed.nodes[0],'dependsOn'),false);
});

test('excluding a prerequisite marks unselected consumers for explicit dependency repair',()=>{
 const {p,a,b}=sample();const next=organizePlan(p,[a.id],{summary:'기준 제외',nodes:[],excluded:[{id:a.id,reason:'범위 조정'}]},{agent:'codex'}),node=next.nodes.find(n=>n.id===b.id);
 assert.deepEqual(node.dependsOn,[]);assert.equal(node.dependencyState,'unreviewed');assert.match(node.dependencyIssues[0],/계약.*제외/);
 assert.equal(p.nodes.find(n=>n.id===b.id).dependencyIssues.length,0);
});

test('explicit empty AI dependencies cannot silently erase an excluded selected prerequisite',()=>{
 const {p,a,b}=sample();const next=organizePlan(p,[a.id,b.id],{summary:'선행 작업 제외',nodes:[item('consumer',[b.id],meta({dependsOn:[]}))],excluded:[{id:a.id,reason:'범위 밖'}]},{agent:'codex'}),node=next.nodes.find(n=>n.id===b.id);
 assert.deepEqual(node.dependsOn,[]);assert.equal(node.dependencyState,'unreviewed');assert.match(node.dependencyIssues[0],/계약.*제외/);
});

test('organization rejects local and cross-boundary execution cycles atomically',()=>{
 const {p,a,b,external}=sample(),before=structuredClone(p);
 assert.throws(()=>organizePlan(p,[a.id,b.id],proposal([item('a',[a.id],meta({dependsOn:[external.id]})),item('b',[b.id],meta({dependsOn:['a']}))]),{agent:'codex'}),/순환/);
 assert.throws(()=>parseOrganization(proposal([item('a',[],meta({dependsOn:['b']})),item('b',[],meta({dependsOn:['a']}))])),/순환/);
 assert.throws(()=>parseOrganization(proposal([item('self',[],meta({dependsOn:['self']}))])),/순환/);
 assert.deepEqual(p,before);
});

test('organization rejects unknown dependency IDs and collisions with unselected nodes',()=>{
 const {p,a,b,external}=sample();
 assert.throws(()=>organizePlan(p,[a.id],proposal([item('a',[a.id],meta({dependsOn:['unknown']}))]),{agent:'codex'}),/선행 구현/);
 assert.throws(()=>organizePlan(p,[a.id],proposal([item(external.id,[a.id],meta())]),{agent:'codex'}),/겹칩니다/);
 assert.throws(()=>organizePlan(p,[a.id,b.id],proposal([item('a',[a.id],meta()),item('b',[b.id],meta({dependsOn:[a.id]}))]),{agent:'codex'}),/정리안의 노드 ID/);
});

test('organizer schema and prompt distinguish WBS, dependency scheduling and optional function layers',()=>{
 const required=ORGANIZE_SCHEMA.properties.nodes.items.required;
 for(const field of ['nodeType','order','dependsOn','functionSteps','dependencyState','dependencyIssues'])assert.ok(required.includes(field),field);
 const {p,a}=sample(),prompt=organizationPrompt({name:'계산 프로그램'},p,[a.id]);
 assert.match(prompt,/WBS/);assert.match(prompt,/실행 가능한 작업끼리만 order/);assert.match(prompt,/필요한 단계만/);assert.match(prompt,/mock/);assert.match(prompt,/설계 선택의 미답변 자체를 의존성 오류로 만들지/);
});

test('organizer preview displays resolved predecessor names, implementation steps and group semantics before apply',async t=>{
 const {window}=new JSDOM('<body></body>',{url:'http://127.0.0.1:4173'});
 const previous=new Map();for(const key of ['window','document','localStorage','sessionStorage','location']){previous.set(key,globalThis[key]);globalThis[key]=key==='window'?window:window[key];}
 window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
 t.after(()=>{window.close();for(const [key,value] of previous){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 const {p,a,b}=sample(),project={id:'preview-order',name:'검증'},result=proposal([
  item('group',[],meta({nodeType:'group',order:null,functionSteps:[]})),
  item('core',[a.id],meta({order:7})),
  item('screen',[b.id],{...meta({order:1,dependsOn:['core'],functionSteps:['<script>검증 단계</script>','실제 연동 확인']}),parentId:'group'})
 ]);
 sessionStorage.setItem('agent-desk-organize-'+project.id,JSON.stringify({selectedIds:[a.id,b.id],baseChange:p.changeNumber,agent:'codex',instruction:'',job:{id:'preview-order-job',status:'succeeded',result}}));
 const {openOrganizer}=await import('../public/organize-ui.js?v=0.9.1');
 await openOrganizer({project,plan:p,selectedIds:[a.id,b.id],onApply:()=>{},onClose:()=>{}});
 const body=document.querySelector('.organize-preview-tree');assert.ok(body);
 assert.match(body.textContent,/묶음 · 직접 실행하지 않음/);assert.match(body.textContent,/우선순위 #1/);assert.match(body.textContent,/선행 구현: core/);assert.match(body.textContent,/함수 구현 순서 \(2단계\)/);
 assert.equal(body.querySelector('script'),null);assert.ok(document.querySelector('[data-org="apply"]'));
 assert.equal(p.nodes.find(n=>n.id===b.id).title,'계산');
});
