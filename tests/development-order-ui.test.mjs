import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountDevelopment} from '../public/development.js';

function setup(t,{nodes,tasks,state}={}){
 const dom=new JSDOM('<main id="root"></main>',{url:'http://127.0.0.1:4173/'});
 for(const key of ['window','document','sessionStorage','localStorage','location','FormData'])globalThis[key]=dom.window[key];
 const project={id:'ordered-project',name:'철근콘크리트 검토',paths:{current:'C:\\project'},planning:{baselines:[{id:'base',number:1,at:'2026-01-01',snapshot:{rootId:'root',nodes}}],handoffs:[{baselineId:'base',tasks}]}};
 const initial=state||{status:'idle',attempts:[],tasks:[],events:[],releases:[]};
 const client={runner:{getSettings:()=>({})},connect:async()=>{},watch:(_,update)=>{update(initial);return()=>{};}};
 const root=document.getElementById('root'),view=mountDevelopment(root,{project,revision:1,client,save:async()=>2});
 t.after(()=>{view.destroy();dom.window.close();});return {root,view};
}

test('development scope explains dependency-first order, excludes groups and preserves function guidance',async t=>{
 const nodes=[{id:'root',title:'목표'},{id:'group',title:'계산 묶음',nodeType:'group'},
  {id:'rules',title:'철근량·연성 규정 검토',order:1,dependsOn:['materials'],dependencyState:'defined',functionSteps:['입력 범위를 검증한다.','<script>순수 계산</script>']},
  {id:'materials',title:'재료 모델',order:5,dependsOn:['standard'],dependencyState:'defined'},
  {id:'standard',title:'설계기준',order:9,dependsOn:[],dependencyState:'defined'}];
 const tasks=['rules','group','materials','standard'].map(nodeId=>({nodeId,agent:'codex'}));
 const {root,view}=setup(t,{nodes,tasks});await view.ready;
 const list=root.querySelector('.dev-order-list');assert.ok(list);
 assert.deepEqual([...list.querySelectorAll(':scope>li')].map(li=>li.dataset.orderTask),['standard','materials','rules']);
 assert.match(root.querySelector('.dev-order-plan').textContent,/묶음 1개.*별도 개발 작업으로 실행하지 않습니다/);
 const rules=list.querySelector('[data-order-task="rules"]');assert.match(rules.textContent,/지정 우선순위: #1/);assert.match(rules.textContent,/재료 모델/);assert.match(rules.textContent,/함수 구현 단계 2개/);
 assert.equal(rules.querySelector('script'),null);assert.match(rules.querySelector('.dev-function-steps').textContent,/<script>순수 계산<\/script>/);
 assert.match(list.textContent,/선행 작업 없음/);
});

test('legacy unreviewed and removed dependency warnings do not claim the task is independent',async t=>{
 const nodes=[{id:'root',title:'목표'}, {id:'legacy',title:'기존 작업'}, {id:'damaged',title:'후속 작업',dependencyState:'unreviewed',dependencyIssues:['삭제된 선행 작업: 기준 선택']}];
 const tasks=[{nodeId:'legacy'},{nodeId:'damaged'}];
 const {root,view}=setup(t,{nodes,tasks});await view.ready;
 const legacy=root.querySelector('[data-order-task="legacy"]');assert.match(legacy.textContent,/선행 관계 미검토/);assert.doesNotMatch(legacy.textContent,/선행 작업 없음/);
 const damaged=root.querySelector('[data-order-task="damaged"]');assert.match(damaged.textContent,/선행 작업을 다시 지정/);assert.match(damaged.textContent,/삭제된 선행 작업: 기준 선택/);assert.match(damaged.textContent,/기획 확정과 업무 분담을 갱신/);
});

test('progress explains the current prerequisite statuses instead of inferring order from node hierarchy',async t=>{
 const tasks=[{id:'standard',title:'설계기준',order:8,dependsOn:[],dependencyState:'defined',status:'passed'}, {id:'materials',title:'재료 모델',order:5,dependsOn:['standard'],dependencyState:'defined',status:'running'}, {id:'rules',title:'규정 검토',order:1,dependsOn:['materials'],dependencyState:'defined',status:'pending'}];
 const {root,view}=setup(t,{nodes:[{id:'root'},...tasks],tasks:tasks.map(({id,...task})=>({...task,nodeId:id})),state:{status:'running',attempts:[{id:'attempt',strategy:'integrated'}],tasks,events:[],releases:[]}});await view.ready;
 root.querySelector('[data-dev="page"][data-page="progress"]').click();
 const materials=root.querySelector('[data-task="materials"]'),rules=root.querySelector('[data-task="rules"]');
 assert.match(materials.textContent,/설계기준 검토 통과/);assert.match(materials.textContent,/선행 작업이 모두 검토를 통과/);
 assert.match(rules.textContent,/선행 검토 대기: 재료 모델/);assert.match(rules.querySelector('.dev-prerequisites').textContent,/재료 모델 진행 중/);
});

test('invalid execution relations show an actionable error without breaking the development view',async t=>{
 const {root,view}=setup(t,{nodes:[{id:'root'},{id:'consumer',title:'계산',dependsOn:['missing']}],tasks:[{nodeId:'consumer'}]});await view.ready;
 assert.match(root.textContent,/구현 순서를 계산할 수 없습니다/);assert.ok(root.querySelector('[data-dev="planning"]'));assert.ok(root.querySelector('[data-dev="start"]'));
});
