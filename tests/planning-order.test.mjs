import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPlan,addNode,editNode,removeNode,mergeNodes,mergeFields,layoutPlan,changePlan,travelHistory,validatePlan} from '../public/planning-model.js';
import {normalizeExecutionMeta,validateExecutionGraph,executionOrder,executionWaves} from '../public/execution-order.js';

const base=()=>createPlan({name:'실행 순서 검증',description:'기획 계층과 구현 의존성 분리'});
const named=(plan,title)=>plan.nodes.find(n=>n.title===title);

test('execution order follows dependencies before priority, preserves stable ties, and computes waves',()=>{
  const nodes=[{id:'consumer',order:1,dependsOn:['bridge']},{id:'first',order:8},{id:'bridge',order:9,dependsOn:['base']},{id:'base',order:999},{id:'second',order:8}];
  assert.deepEqual(executionOrder(nodes).map(n=>n.id),['first','second','base','bridge','consumer']);
  assert.deepEqual([...executionWaves(nodes)],[['first',1],['second',1],['base',1],['bridge',2],['consumer',3]]);
  assert.deepEqual(nodes.map(n=>n.id),['consumer','first','bridge','base','second']);
  assert.deepEqual(executionOrder([{id:'z'},{id:'a'}]).map(n=>n.id),['z','a']);
});

test('hierarchy depth stays vertical while full cross-depth dependencies determine peer placement',()=>{
  const plan=base();
  const caller=addNode(plan,plan.rootId,{title:'규정 검토',order:1,dependencyState:'defined'});
  const group=addNode(plan,plan.rootId,{title:'기반 묶음',nodeType:'group'});
  const bridge=addNode(plan,group.id,{title:'재료 모델',order:2,dependencyState:'defined'});
  const foundation=addNode(plan,plan.rootId,{title:'설계 기준',order:99,dependencyState:'defined'});
  caller.dependsOn=[bridge.id];bridge.dependsOn=[foundation.id];
  layoutPlan(plan);
  assert.ok(foundation.x<caller.x,'cross-depth transitive dependency must precede the caller on the same hierarchy row');
  assert.equal(foundation.y,caller.y);assert.ok(bridge.y>foundation.y);
  assert.deepEqual(executionOrder([caller,bridge,foundation]).map(n=>n.title),['설계 기준','재료 모델','규정 검토']);
});

test('dependency edits and invalid grouping fail atomically without changing the source plan',()=>{
  let plan=base();const a=addNode(plan,plan.rootId,{title:'a'}),b=addNode(plan,plan.rootId,{title:'b',dependsOn:[a.id]});plan=validatePlan(plan);
  const before=structuredClone(plan);
  assert.throws(()=>changePlan(plan,'의존 순환',p=>editNode(p,a.id,{...a,dependsOn:[b.id]})),/순환/);
  assert.deepEqual(plan,before);
  assert.throws(()=>changePlan(plan,'누락 선행',p=>editNode(p,a.id,{...a,dependsOn:['missing']})),/존재하지/);
  assert.throws(()=>changePlan(plan,'목표 참조',p=>editNode(p,a.id,{...a,dependsOn:[p.rootId]})),/목표·묶음/);
  assert.throws(()=>changePlan(plan,'묶음 변환',p=>editNode(p,a.id,{...a,nodeType:'group'})),/목표·묶음/);
  assert.throws(()=>validateExecutionGraph([{id:'group',nodeType:'group',dependsOn:['task']},{id:'task'}]),/묶음 노드/);
});

test('deleting a dependency preserves an unresolved issue through save and undo instead of declaring independence',()=>{
  let plan=base();const a=addNode(plan,plan.rootId,{title:'필수 기반'}),b=addNode(plan,plan.rootId,{title:'후속 기능',dependsOn:[a.id],dependencyState:'defined',functionSteps:['계약 확인','순수 계산','UI 결합']});plan=validatePlan(plan);
  const removed=changePlan(plan,'기반 삭제',p=>removeNode(p,a.id));
  const pending=named(removed,'후속 기능');assert.deepEqual(pending.dependsOn,[]);assert.equal(pending.dependencyState,'unreviewed');assert.match(pending.dependencyIssues[0],/필수 기반/);
  const loaded=validatePlan(JSON.parse(JSON.stringify(removed)));assert.deepEqual(named(loaded,'후속 기능'),pending);
  const edited=changePlan(loaded,'설명 수정',p=>editNode(p,b.id,{...pending,description:'설명만 변경'}));
  assert.deepEqual(named(edited,'후속 기능').dependencyIssues,pending.dependencyIssues);
  const undo=travelHistory(removed,'undo');assert.deepEqual(named(undo,'후속 기능').dependsOn,[a.id]);assert.equal(named(undo,'후속 기능').dependencyState,'defined');
  assert.deepEqual(named(travelHistory(undo,'redo'),'후속 기능').dependencyIssues,pending.dependencyIssues);
});

test('merging combines function steps and external prerequisites and redirects downstream references',()=>{
  let plan=base();const foundation=addNode(plan,plan.rootId,{title:'기반'});
  const a=addNode(plan,plan.rootId,{title:'A',order:2,dependsOn:[foundation.id],dependencyState:'defined',functionSteps:['스키마 확인','계산 구현']});
  const b=addNode(plan,plan.rootId,{title:'B',order:3,dependsOn:[a.id],dependencyState:'defined',functionSteps:['계산 구현','입출력 연결']});
  const child=addNode(plan,plan.rootId,{title:'후속',dependsOn:[a.id,b.id],dependencyState:'defined'});plan=validatePlan(plan);
  const merged=changePlan(plan,'노드 병합',p=>mergeNodes(p,[a.id,b.id],{...mergeFields(p,[a.id,b.id]),title:'A+B'}));
  const result=named(merged,'A+B');assert.deepEqual(result.dependsOn,[foundation.id]);assert.equal(result.order,2);
  assert.deepEqual(result.functionSteps,['스키마 확인','계산 구현','입출력 연결']);assert.deepEqual(merged.nodes.find(n=>n.id===child.id).dependsOn,[a.id]);
  assert.deepEqual(travelHistory(merged,'undo').nodes,plan.nodes);
});

test('merging nonadjacent dependency nodes rejects newly created cycles atomically',()=>{
  let plan=base();const a=addNode(plan,plan.rootId,{title:'A'}),mid=addNode(plan,plan.rootId,{title:'중간',dependsOn:[a.id]}),b=addNode(plan,plan.rootId,{title:'B',dependsOn:[mid.id]});plan=validatePlan(plan);
  const before=structuredClone(plan);
  assert.throws(()=>changePlan(plan,'순환 병합',p=>mergeNodes(p,[a.id,b.id],{title:'A+B'})),/순환/);assert.deepEqual(plan,before);
});

test('legacy metadata defaults to unreviewed and malformed order or steps are rejected',()=>{
  const plan=base(),node=addNode(plan,plan.rootId,{title:'기존 노드'});
  for(const key of Object.keys(normalizeExecutionMeta()))delete node[key];
  const loaded=validatePlan(JSON.parse(JSON.stringify(plan)));assert.deepEqual(normalizeExecutionMeta(named(loaded,'기존 노드')),normalizeExecutionMeta());
  assert.equal(named(loaded,'기존 노드').dependencyState,'unreviewed');
  for(const input of [{order:0},{order:1.5},{order:1000},{dependsOn:['x','x']},{functionSteps:Array(21).fill('단계')},{functionSteps:['']},{nodeType:'unknown'}])assert.throws(()=>normalizeExecutionMeta(input));
  assert.equal(normalizeExecutionMeta({dependencyState:'defined',dependencyIssues:['미해결 의존성']}).dependencyState,'unreviewed');
});
