import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPlan,validatePlan,travelHistory} from '../public/planning-model.js';
import {applyIntake,validateIntake,planningPrompt} from '../public/planning-intake-model.js';
import {changedQuestionNodes} from '../public/decision-core.js';
import {applyDecisionReviews,finalizePlan,createAssignments} from '../public/decision-model.js';
const project={id:'intake',name:'계산기',description:'실행되는 계산기'};
const node=(id,parentId=null,nodeType='task')=>({id,parentId,nodeType,title:id,description:id+' 기능',instructions:'핵심 동작 구현',criteria:'2+3=5',dependsOn:[],functionSteps:[],reason:'필요한 기능'});
const draft=()=>({summary:'핵심 계산 먼저',nodes:[node('core',null,'group'),node('engine','core')],defaults:[{question:'각도 기본값',answer:'DEG',reason:'일반 사용 기준',alternatives:['RAD'],nodeIds:['engine']}],deferred:[{id:'graph',title:'그래프',description:'함수 시각화',benefit:'그래프로 확인',reason:'초안 범위 축소',difficulty:'별도 시각화 검사',conditions:'계산 엔진 완료',parentId:'core',dependsOn:['engine'],required:false}],promotions:[]});
const options={id:'run-1',lead:'codex',agents:['codex','claude']};
test('first plan keeps a complete core, records defaults, and stores optional functions outside execution',()=>{
 const initial=createPlan(project),p=applyIntake(initial,draft(),options);assert.equal(initial.nodes.length,1);assert.equal(p.nodes.length,3);assert.equal(p.backlog.length,1);assert.equal(p.items[0].answer,'DEG');assert.equal(p.items[0].resolution.kind,'assumption');assert.equal(p.intakeHistory[0].lead,'codex');
 const saved=validatePlan(JSON.parse(JSON.stringify(p)));assert.deepEqual(saved,p);const final=finalizePlan(project,p),tasks=createAssignments(final.baselines.at(-1));assert.equal(tasks.length,1);assert.equal(tasks[0].nodeId,p.nodes.find(n=>n.title==='engine').id);assert.ok(!JSON.stringify(tasks).includes('그래프'));
 assert.equal(travelHistory(p,'undo').backlog.length,0);assert.equal(travelHistory(travelHistory(p,'undo'),'redo').backlog.length,1);assert.deepEqual(applyIntake(p,draft(),options),p);
});
test('hierarchy can end at one task or contain natural nested children without mandatory depth',()=>{
 const initial=createPlan(project),simple={summary:'한 기능',nodes:[node('simple')],defaults:[],deferred:[],promotions:[]};assert.equal(applyIntake(initial,simple,options).nodes.length,2);
 const deep={...simple,nodes:[node('group',null,'group'),node('part','group','group'),node('leaf','part')]},p=applyIntake(initial,deep,options);assert.ok(p.edges.some(e=>e.from===p.nodes.find(n=>n.title==='part').id&&e.to===p.nodes.find(n=>n.title==='leaf').id));
});
test('promotion attaches only selected candidates, preserves previous answers and asks only for new nodes',()=>{
 let p=applyIntake(createPlan(project),draft(),options);p=applyDecisionReviews(p,[{id:'covered',agent:'codex',result:{summary:'검토',items:[]}}],p.nodes.map(n=>n.id),'questions');assert.deepEqual(changedQuestionNodes(p),[]);
 const parent=p.nodes.find(n=>n.title==='core').id,engine=p.nodes.find(n=>n.title==='engine').id,candidate=p.backlog[0].id;
 const added={summary:'그래프 편입',nodes:[{...node('plot',parent),dependsOn:[engine]}],defaults:[],deferred:[],promotions:[{backlogId:candidate,nodeIds:['plot'],reason:'엔진을 사용'}]};
 const next=applyIntake(p,added,{...options,id:'promotion',promoteIds:[candidate]});assert.equal(next.backlog[0].status,'added');assert.equal(next.items[0].answer,'DEG');assert.deepEqual(changedQuestionNodes(next),next.backlog[0].addedNodeIds);assert.equal(next.nodes.length,p.nodes.length+1);assert.throws(()=>validateIntake(p,{...added,promotions:[]},{promoteIds:[candidate]}),/후속 기능/);
});
test('required deferral needs explicit acknowledgement; invalid links and cycles cannot be applied',()=>{
 const p=createPlan(project),d=draft();d.deferred[0].required=true;assert.throws(()=>applyIntake(p,d,options),/필수 요구/);assert.equal(applyIntake(p,d,{...options,allowRequired:true}).backlog[0].required,true);
 const malformed=draft();malformed.deferred[0].required='false';assert.throws(()=>validateIntake(p,malformed),/필수 요구/);
 const bad=draft();bad.nodes[0].parentId='engine';assert.throws(()=>validateIntake(p,bad),/순환/);bad.nodes[0].parentId='missing';assert.throws(()=>validateIntake(p,bad),/상위/);
 assert.match(planningPrompt(project,p),/계층 깊이나 개수를 강제하지/);
});
test('explicit default edits and existing user answers are preserved',()=>{
 const initial=createPlan(project),p=applyIntake(initial,draft(),{...options,answers:{0:'RAD'}});assert.equal(p.items[0].answer,'RAD');assert.equal(p.items[0].resolution.kind,'user');
 const repeated={summary:'기존 답변 유지',nodes:[],defaults:[{...draft().defaults[0],nodeIds:[p.nodes.find(n=>n.title==='engine').id]}],deferred:[],promotions:[]};const next=applyIntake(p,repeated,{...options,id:'repeat'});assert.equal(next.items.length,1);assert.equal(next.items[0].answer,'RAD');
});

test('repeated identical planning does not accumulate nodes, defaults, or future candidates',()=>{
 const p=applyIntake(createPlan(project),draft(),options),again=applyIntake(p,draft(),{...options,id:'another-run'});assert.equal(again.nodes.length,p.nodes.length);assert.equal(again.items.length,p.items.length);assert.equal(again.backlog.length,p.backlog.length);assert.equal(again.proposals.length,p.proposals.length);
});

test('parallel integration contracts survive ID remapping, persistence and finalized assignments without becoming hard prerequisites',()=>{
 const d=draft();d.nodes.push({...node('screen','core'),integrationWith:['engine']});d.nodes[1].integrationWith=['screen'];const p=applyIntake(createPlan(project),d,options),engine=p.nodes.find(n=>n.title==='engine'),screen=p.nodes.find(n=>n.title==='screen');assert.deepEqual(engine.integrationWith,[screen.id]);assert.deepEqual(screen.integrationWith,[engine.id]);assert.deepEqual(engine.dependsOn,[]);assert.deepEqual(validatePlan(JSON.parse(JSON.stringify(p))),p);
 const base=finalizePlan(project,p).baselines.at(-1);assert.deepEqual(createAssignments(base).find(t=>t.nodeId===engine.id).integrationWith,[screen.id]);const invalid=draft();invalid.nodes[1].integrationWith=['missing'];assert.throws(()=>validateIntake(createPlan(project),invalid),/통합|노드|작업/);
});

test('explicitly cleared integration peers stay cleared through handoff validation',async()=>{
 const {saveAssignments}=await import('../public/decision-model.js');const d=draft();d.nodes.push({...node('screen','core'),integrationWith:['engine']});let p=finalizePlan(project,applyIntake(createPlan(project),d,options));const base=p.baselines.at(-1),tasks=createAssignments(base),screen=tasks.find(t=>t.integrationWith?.length);screen.integrationWith=[];p=saveAssignments(p,base.id,tasks);const saved=validatePlan(JSON.parse(JSON.stringify(p)));assert.deepEqual(saved.handoffs[0].tasks.find(t=>t.nodeId===screen.nodeId).integrationWith,[]);
});
