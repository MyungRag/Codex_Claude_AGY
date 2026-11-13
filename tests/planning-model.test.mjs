import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPlan,createDemo,changePlan,travelHistory,validatePlan,addNode,removeNode,moveUnder,mergeNodes,mergeFields,layoutPlan,parseProposals,importProposals,nodeSources,appendMessage,reviewPrompt,visibleNodes} from '../public/planning-model.js';
import {validateProject,readBackup,importCopies} from '../public/model.js';
const project={name:'KAF',description:'대한항공 가격 비교 프로그램 만들기',instructions:'한국어로 설명합니다.'};
const base=()=>createPlan(project);

test('KAF sample clearly records demo provenance and combines identical proposals without losing originals',()=>{
  const p=createDemo(project);assert.equal(p.demo,true);assert.equal(p.proposals.length,12);assert.equal(p.nodes.length,9);
  const search=p.nodes.find(n=>n.title==='검색 조건 입력');assert.deepEqual(nodeSources(p,search.id).map(a=>a.id),['codex','claude','agy']);
  assert.equal(p.proposals.filter(s=>s.nodeId===search.id).length,3);
  assert.ok(p.proposals.every(s=>s.kind==='demo'));
  assert.deepEqual(validatePlan(JSON.parse(JSON.stringify(p))),p);
});

test('inserting a node splits exactly one edge; deleting just that node reconnects children; subtree deletion is reversible',()=>{
  let p=base();const parent=addNode(p,p.rootId,{title:'큰 노드'}),child=addNode(p,parent.id,{title:'세부 노드'}),other=addNode(p,p.rootId,{title:'유지'});layoutPlan(p);p=validatePlan(p);
  const inserted=changePlan(p,'사이에 추가',next=>addNode(next,parent.id,{title:'중간'},child.id));
  const middle=inserted.nodes.find(n=>n.title==='중간');
  assert.ok(inserted.edges.some(e=>e.from===parent.id&&e.to===middle.id));
  assert.ok(inserted.edges.some(e=>e.from===middle.id&&e.to===child.id));
  assert.ok(!inserted.edges.some(e=>e.from===parent.id&&e.to===child.id));
  const removed=changePlan(inserted,'중간만 삭제',next=>removeNode(next,middle.id));
  assert.ok(removed.edges.some(e=>e.from===parent.id&&e.to===child.id));
  const cascade=changePlan(removed,'가지 삭제',next=>removeNode(next,parent.id,true));
  assert.deepEqual(cascade.nodes.map(n=>n.id).sort(),[p.rootId,other.id].sort());
  const restored=travelHistory(JSON.parse(JSON.stringify(cascade)),'undo');
  assert.deepEqual(restored.nodes,removed.nodes);assert.deepEqual(restored.edges,removed.edges);
  assert.deepEqual(travelHistory(restored,'redo').nodes,cascade.nodes);
  assert.throws(()=>changePlan(p,'목표 삭제',next=>removeNode(next,p.rootId)),/전체 목표/);
});

test('merging preserves incoming and outgoing relationships, agent sources, instructions and conversations',()=>{
  let p=base();
  importProposals(p,'codex',parseProposals(JSON.stringify({nodes:[{id:'a',title:'달력',instructions:'날짜별 가격 표시'}]})));
  importProposals(p,'claude',parseProposals(JSON.stringify({nodes:[{id:'b',title:'가격 달력',instructions:'상세 조건 보기'}]})));
  const a=p.nodes.find(n=>n.title==='달력'),b=p.nodes.find(n=>n.title==='가격 달력');
  const childA=addNode(p,a.id,{title:'조회'}),childB=addNode(p,b.id,{title:'상세 보기'});
  appendMessage(p,{nodeId:b.id,text:'수하물 조건도 함께 보여줘.'});layoutPlan(p);p=validatePlan(p);
  const fields=mergeFields(p,[a.id,b.id]);assert.match(fields.instructions,/날짜별 가격 표시/);assert.match(fields.instructions,/상세 조건 보기/);
  const next=changePlan(p,'합치기',plan=>mergeNodes(plan,[a.id,b.id],{...fields,title:'통합 달력'}));
  assert.equal(next.nodes.length,p.nodes.length-1);
  assert.deepEqual(nodeSources(next,a.id).map(a=>a.id),['codex','claude']);
  assert.equal(next.messages[0].nodeId,a.id);assert.equal(next.messages[0].nodeTitle,'통합 달력');
  assert.ok(next.edges.some(e=>e.from===a.id&&e.to===childA.id));assert.ok(next.edges.some(e=>e.from===a.id&&e.to===childB.id));
  assert.equal(next.edges.filter(e=>e.from===p.rootId&&e.to===a.id).length,1);
  assert.deepEqual(travelHistory(next,'undo').proposals,p.proposals);
  assert.deepEqual(travelHistory(next,'undo').messages,p.messages);
  assert.throws(()=>changePlan(p,'상하위 합치기',plan=>mergeNodes(plan,[a.id,childA.id],fields)),/상위·하위/);
});

test('only identical scoped proposals combine; title-only overlap or another parent stays distinct',()=>{
  const p=base();const source={id:'a',title:'가격 조회',description:'조건 A',criteria:'총액 표시'};
  importProposals(p,'codex',[source]);importProposals(p,'claude',[source]);
  assert.equal(p.nodes.length,2);assert.equal(p.proposals.length,2);
  importProposals(p,'agy',[{...source,criteria:'세전 요금 표시'}]);assert.equal(p.nodes.length,3);
  importProposals(p,'codex',[source]);assert.equal(p.proposals.length,3);
  const parent=addNode(p,p.rootId,{title:'다른 비교 범위'});
  importProposals(p,'codex',[source],'import',parent.id);assert.equal(p.nodes.length,5);
  validatePlan(p);
});

test('invalid imports and cyclic edits fail atomically, including cycles hidden in disconnected nodes',()=>{
  for(const nodes of [
    [{id:'a',parentId:'missing',title:'a'}],
    [{id:'a',parentId:'b',title:'a'},{id:'b',parentId:'a',title:'b'}],
    [{id:'a',title:'a'},{id:'a',title:'duplicate'}]
  ])assert.throws(()=>parseProposals(JSON.stringify({nodes})));
  const p=base(),a=addNode(p,p.rootId,{title:'a'}),b=addNode(p,a.id,{title:'b'});layoutPlan(p);const before=structuredClone(p);
  assert.throws(()=>changePlan(p,'순환',next=>moveUnder(next,a.id,b.id)),/하위/);assert.deepEqual(p,before);
  assert.throws(()=>validatePlan({...p,edges:[{from:a.id,to:b.id},{from:b.id,to:a.id}]}),/연결/);
  assert.throws(()=>validatePlan({...p,nodes:[...p.nodes,{...a}]}),/중복/);
});

test('plan, history and chat survive project backup/import and ordinary project edits',()=>{
  const p=validateProject({...project,paths:{current:'C:\\KAF'},planning:createDemo(project)});
  p.planning=changePlan(p.planning,'의견 저장',plan=>appendMessage(plan,{text:'가격 확보 방법을 먼저 정해줘.'}));
  const saved=validateProject({...p,description:'설명만 수정'});
  assert.deepEqual(saved.planning,p.planning);
  const restored=readBackup({format:'agent-desk-projects',version:1,projects:[JSON.parse(JSON.stringify(saved))]})[0];
  assert.deepEqual(restored.planning,p.planning);
  assert.equal(importCopies([saved],[restored])[1].planning.messages[0].text,'가격 확보 방법을 먼저 정해줘.');
  assert.equal(validateProject(project).planning,null);
  assert.equal(createPlan({...project,instructions:'가'.repeat(12000)}).nodes.length,1);
});

test('shared children stay visible through expanded parents and review prompt carries prior decisions and exclusions',()=>{
  const p=base(),a=addNode(p,p.rootId,{title:'a'}),b=addNode(p,p.rootId,{title:'b'}),shared=addNode(p,a.id,{title:'shared'});p.edges.push({from:b.id,to:shared.id});
  assert.ok(visibleNodes(p,new Set([a.id])).some(n=>n.id===shared.id));
  assert.ok(!visibleNodes(p,new Set([a.id,b.id])).some(n=>n.id===shared.id));
  importProposals(p,'agy',[{id:'optional',title:'회원가입'}]);const optional=p.nodes.find(n=>n.title==='회원가입');appendMessage(p,{nodeId:optional.id,text:'이번에는 회원가입이 필요 없습니다.'});removeNode(p,optional.id);
  const request=reviewPrompt(project,p);assert.match(request,/한국어로 설명합니다/);assert.match(request,/이번에는 회원가입이 필요 없습니다/);assert.match(request,/제외된 제안:\n회원가입/);
});
