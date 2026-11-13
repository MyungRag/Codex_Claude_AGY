import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateProject,readBackup,importCopies} from '../public/model.js';
import {createPlan,addNode,validatePlan} from '../public/planning-model.js';
import {finalizePlan,createAssignments,saveAssignments} from '../public/decision-model.js';
import {defaultDevelopment} from '../public/development-core.js';

function projectWithBaseline(){
 const project=validateProject({id:'concrete-tool',name:'철근콘크리트 계산기',description:'휨 강도 계산',instructions:'설계 기준을 임의로 바꾸지 않는다.',paths:{current:'C:\\Projects\\Concrete'},gitUrl:'https://github.com/example/concrete',links:[{name:'기준 문서',url:'https://example.com/spec'}],files:[{id:'ref',name:'기준.txt',data:Buffer.from('기준 원문').toString('base64')}]});
 let planning=createPlan(project);
 addNode(planning,planning.rootId,{title:'휨 강도 계산',instructions:'입력 단면을 계산한다.',criteria:'고정 예제의 값과 일치한다.'});
 planning=finalizePlan(project,validatePlan(planning),'첫 계산 범위');
 planning=saveAssignments(planning,planning.baselines[0].id,createAssignments(planning.baselines[0]));
 return validateProject({...project,planning});
}
const backup=projects=>JSON.parse(JSON.stringify({format:'agent-desk-projects',version:1,projects}));

test('legacy project migration adds development defaults without changing the planning baseline or source data',()=>{
 const current=projectWithBaseline(),legacy=structuredClone(current);delete legacy.development;
 const before=structuredClone(legacy),migrated=validateProject(legacy);
 assert.deepEqual(migrated.development,defaultDevelopment());
 assert.deepEqual(migrated.planning,legacy.planning);
 for(const key of ['id','instructions','paths','gitUrl','links','files'])assert.deepEqual(migrated[key],legacy[key]);
 assert.deepEqual(legacy,before,'migration must not mutate its source');
 const restored=readBackup(backup([legacy]))[0];
 assert.deepEqual(restored.development,defaultDevelopment());assert.deepEqual(restored.planning,legacy.planning);
});

test('project backup and copy import preserve primary roles, mode overrides, budgets, checks and planning independently',()=>{
 const original=projectWithBaseline();
 const config={...defaultDevelopment(),strategy:'verification',lead:'agy',roles:{builder:'claude',auditor:'codex',challenger:'agy'},overrides:{verification:{builder:'agy',challenger:'claude'},issue:{builder:'codex',auditor:'agy',challenger:'claude'}},limits:{maxRevisions:4,maxReviews:6,maxSwitches:2},autoSwitch:true,checks:[{id:'tests',label:'단위 검사',command:'node',args:['--test','tests/*.test.mjs']}],launch:{kind:'command',entry:'index.html',command:{command:'npm',args:['run','start']},url:'http://127.0.0.1:{port}/',prepare:[{command:'npm',args:['ci']}]}};
 const configured=validateProject({...original,development:config}),before=structuredClone(configured);
 const restored=readBackup(backup([configured]))[0];
 assert.deepEqual(restored.development,config);assert.deepEqual(restored.planning,configured.planning);
 const copies=importCopies([configured],[restored]);
 assert.equal(copies.length,2);assert.notEqual(copies[1].id,configured.id);assert.notEqual(copies[1].name,configured.name);
 assert.deepEqual(copies[1].development,config);assert.deepEqual(copies[1].planning,configured.planning);
 for(const key of ['instructions','paths','gitUrl','links','files'])assert.deepEqual(copies[1][key],configured[key]);
 assert.deepEqual(copies[0],before);
 // Imported runtime progress is intentionally not part of the saved project configuration.
 const withUntrustedRuntime=validateProject({...configured,development:{...config,tasks:[{id:'forged',status:'passed'}],latestRunnableId:'forged-release'}});
 assert.equal(Object.hasOwn(withUntrustedRuntime.development,'tasks'),false);assert.equal(Object.hasOwn(withUntrustedRuntime.development,'latestRunnableId'),false);
});

test('editing project details keeps development settings and backup preserves self-review configuration',()=>{
 const original=projectWithBaseline();original.development={...defaultDevelopment(),lead:'claude',limits:{maxRevisions:0,maxReviews:1,maxSwitches:0}};
 const edited=validateProject({...original,description:'설명만 수정'});
 assert.deepEqual(edited.development,original.development);assert.deepEqual(edited.planning,original.planning);
 const invalid={...original,development:{...defaultDevelopment(),roles:{builder:'codex',auditor:'codex',challenger:'agy'}}};
 assert.equal(validateProject(invalid).development.roles.auditor,'codex');
 assert.doesNotThrow(()=>readBackup(backup([invalid])));
 const badOverride={...original,development:{...defaultDevelopment(),overrides:{verification:{builder:'claude'}}}};
 assert.doesNotThrow(()=>readBackup(backup([badOverride])));
 assert.deepEqual(original.planning,edited.planning);
});
