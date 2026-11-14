import {test} from 'node:test';
import assert from 'node:assert/strict';
import {STRATEGIES,defaultDevelopment,validateDevelopment,resolveRoles,prepareDevelopmentTasks,planPartialRetry,rotateRoles} from '../public/development-core.js';

function planningFixture(){
 const baseline={id:'baseline-1',number:1,snapshot:{rootId:'goal',nodes:[{id:'goal',title:'계산 프로그램'},{id:'engine',title:'계산 엔진'},{id:'ui',title:'결과 화면'},{id:'export',title:'파일 내보내기'}],items:[{id:'unanswered',nodeIds:['engine'],status:'answer',question:'반올림 방식은?',blocking:true}]}};
 const handoff={baselineId:'baseline-1',tasks:[
  {nodeId:'engine',agent:'codex',dependsOn:[],instructions:'계산을 구현',criteria:'기준값 일치',deliverable:'계산 모듈'},
  {nodeId:'ui',agent:'claude',dependsOn:['engine'],instructions:'결과를 표시',criteria:'결과가 보임',deliverable:'화면'},
  {nodeId:'export',agent:'agy',dependsOn:['engine'],instructions:'결과를 저장',criteria:'저장 파일 확인',deliverable:'내보내기'}
 ]};return {baseline,handoff};
}
const task=(id,status='pending',extra={})=>({id,status,disposition:'open',dependsOn:[],findings:[],...extra});
const actions=(tasks,options)=>Object.fromEntries(planPartialRetry(tasks,options).map(entry=>[entry.taskId,entry.action]));

test('five real strategy policies remain ordered and legacy projects receive independent defaults',()=>{
 assert.deepEqual(STRATEGIES.map(s=>s.id),['integrated','procedural','verification','issue','assignment']);
 assert.equal(STRATEGIES[0].name,'통합안');
 assert.equal(new Set(STRATEGIES.map(s=>JSON.stringify(s.policy))).size,5);
 for(const s of STRATEGIES){assert.ok(s.steps.length>2);assert.ok(s.advantages.length&&s.disadvantages.length&&s.limitation);}
 const a=defaultDevelopment(),b=validateDevelopment();
 assert.equal(b.strategy,'integrated');assert.deepEqual(b.limits,{maxRevisions:2,maxReviews:3,maxSwitches:1});
 a.roles.builder='agy';a.checks.push({});a.limits.maxRevisions=8;
 assert.equal(b.roles.builder,'codex');assert.deepEqual(b.checks,[]);assert.equal(b.limits.maxRevisions,2);
});

test('overall lead is independent, overrides inherit defaults and custom budgets survive validation',()=>{
 const input=defaultDevelopment();input.lead='agy';input.overrides.verification={builder:'agy',challenger:'codex'};input.limits={maxRevisions:5,maxReviews:8,maxSwitches:2};input.autoSwitch=true;
 const config=validateDevelopment(input);
 assert.equal(config.lead,'agy');assert.deepEqual(resolveRoles(config,'verification'),{builder:'agy',auditor:'claude',challenger:'codex'});
 assert.deepEqual(resolveRoles(config,'procedural'),{builder:'codex',auditor:'claude',challenger:'agy'});
 assert.deepEqual(config.limits,{maxRevisions:5,maxReviews:8,maxSwitches:2});
 input.overrides.verification.builder='codex';assert.equal(config.overrides.verification.builder,'agy');
 assert.equal(validateDevelopment({...config,limits:{maxRevisions:0,maxReviews:1,maxSwitches:0}}).limits.maxRevisions,0);
 for(const limits of [{maxRevisions:-1},{maxReviews:0},{maxSwitches:1.5},{maxRevisions:Infinity}])assert.throws(()=>validateDevelopment({...config,limits}),/한도/);
});

test('self-review is allowed while invalid providers and unknown strategies are rejected',()=>{
 assert.equal(validateDevelopment({roles:{auditor:'codex'}}).roles.auditor,'codex');
 assert.equal(validateDevelopment({overrides:{issue:{builder:'claude'}}}).overrides.issue.builder,'claude');
 assert.throws(()=>validateDevelopment({overrides:{unknown:{}}}),/협업 방식/);
 assert.throws(()=>validateDevelopment({lead:'invented'}),/AI/);
 assert.throws(()=>validateDevelopment({strategy:'unknown'}),/협업 방식/);
 assert.throws(()=>validateDevelopment({version:2}),/버전/);
 assert.throws(()=>validateDevelopment({autoSwitch:'true'}),/자동/);
 assert.throws(()=>validateDevelopment({roles:[]}),/역할/);
});

test('checks retain literal argument values and launch uses safe explicit readiness configuration',()=>{
 const input={checks:[{id:'unit',command:'node',args:['--test','a b.test.mjs','  literal  ']}],launch:{kind:'command',command:{command:'npm',args:['run','start']},url:'http://127.0.0.1:{port}/health',prepare:[{command:'npm',args:['ci']}]}};
 const config=validateDevelopment(input);
 assert.deepEqual(config.checks[0].args,['--test','a b.test.mjs','  literal  ']);
 assert.deepEqual(config.launch.command,{command:'npm',args:['run','start']});
 assert.equal(config.launch.url,'http://127.0.0.1:{port}/health');
 assert.deepEqual(config.launch.prepare,[{command:'npm',args:['ci']}]);
 assert.deepEqual(validateDevelopment({launch:{entry:'index.html'}}).launch.prepare,[]);
 assert.throws(()=>validateDevelopment({launch:{prepare:Array.from({length:11},()=>({command:'npm',args:['ci']}))}}),/준비 명령/);
 assert.throws(()=>validateDevelopment({launch:{prepare:[{command:'npm ci && npm start',args:[]}]}}),/하나의 명령/);
 assert.equal(validateDevelopment({launch:{entry:'public\\index.html'}}).launch.entry,'public/index.html');
 for(const entry of ['../index.html','/etc/passwd','C:\\Users\\index.html','a/../index.html','a//index.html'])assert.throws(()=>validateDevelopment({launch:{entry}}),/상대 경로/);
 for(const url of ['https://example.com','http://example.com','http://user:pass@localhost:3000/','http://localhost:3000/#fake'])assert.throws(()=>validateDevelopment({...input,launch:{...input.launch,url}}),/현재 PC/);
 assert.throws(()=>validateDevelopment({checks:[{id:'bad',command:'npm test && node app.js',args:[]}]}),/하나의 명령/);
 assert.throws(()=>validateDevelopment({checks:[{id:'same',command:'node'},{id:'same',command:'node'}]}),/중복/);
 assert.throws(()=>validateDevelopment({launch:{kind:'command',url:'http://localhost:3000'}}),/실행 명령/);
});

test('prepared tasks use stable planning ids, distributed developers and pending questions do not block all work',()=>{
 const {baseline,handoff}=planningFixture(),snapshot=structuredClone({baseline,handoff});
 const config=defaultDevelopment();config.roles={builder:'agy',auditor:'codex',challenger:'claude'};
 const prepared=prepareDevelopmentTasks(baseline,handoff,config);
 assert.deepEqual(prepared.map(t=>t.id),['engine','ui','export']);
 assert.deepEqual(prepared.map(t=>t.builder),['agy','codex','claude']);assert.ok(prepared.every(t=>t.agent===t.builder));
 assert.ok(prepared.every(t=>t.status==='pending'&&t.reviewCount===0&&t.revisionCount===0));
 assert.deepEqual(prepared[1].dependsOn,['engine']);assert.deepEqual(prepared[0].authors,[]);
 prepared[1].dependsOn.push('export');assert.deepEqual({baseline,handoff},snapshot);
});

test('assignment policy preserves individual developers and assigns independent reviewers explicitly',()=>{
 const {baseline,handoff}=planningFixture();
 const prepared=prepareDevelopmentTasks(baseline,handoff,{strategy:'assignment'});
 assert.deepEqual(prepared.map(t=>t.builder),['codex','claude','agy']);
 for(const t of prepared){assert.notEqual(t.builder,t.auditor);assert.equal(new Set([t.builder,t.auditor,t.challenger]).size,3);}
 assert.equal(prepared[0].auditor,'claude');assert.equal(prepared[1].auditor,'agy');
 const primary=prepareDevelopmentTasks(baseline,handoff,{roles:{challenger:'codex'}});
 assert.ok(primary.every(t=>t.challenger==='codex'),'outside assignment mode an explicitly selected Challenger is preserved');
});

test('missing criteria, wrong baseline, dependency cycles and missing assignments cannot start',()=>{
 const {baseline,handoff}=planningFixture();
 assert.throws(()=>prepareDevelopmentTasks(baseline,{...handoff,baselineId:'different'},{}),/버전/);
 assert.throws(()=>prepareDevelopmentTasks(baseline,{tasks:handoff.tasks.slice(1)},{}),/한 번씩/);
 const empty=structuredClone(handoff);empty.tasks[0].criteria='';assert.throws(()=>prepareDevelopmentTasks(baseline,empty,{}),/완료 기준/);
 const cycle=structuredClone(handoff);cycle.tasks[0].dependsOn=['ui'];assert.throws(()=>prepareDevelopmentTasks(baseline,cycle,{}),/순환/);
 assert.throws(()=>prepareDevelopmentTasks({snapshot:{rootId:'goal',nodes:[{id:'goal',title:'목표'}]}},{tasks:[]},{}),/개발할 작업/);
});

test('partial retry rebuilds only unfinished work and reverifies transitive completed dependents',()=>{
 const tasks=[task('engine','failed',{artifactSha:'old',revisionCount:2,reviewCount:3}),task('ui','passed',{dependsOn:['engine']}),task('export','passed',{dependsOn:['ui']}),task('independent','passed'),task('new-feature'),task('partial','partial')];
 const before=structuredClone(tasks);
 assert.deepEqual(actions(tasks,{strategy:'procedural'}),{engine:'build',ui:'verify',export:'verify',independent:'keep','new-feature':'build',partial:'build'});
 assert.deepEqual(tasks,before,'planning must not reset counters or mutate stored evidence');
 assert.deepEqual(actions([task('a','passed'),task('b','passed',{dependsOn:['a']})],{changedTaskIds:['a']}),{a:'verify',b:'verify'});
});

test('accepted and excluded limits are preserved while unresolved prerequisites hold only their dependents',()=>{
 const tasks=[
  task('accepted','limited',{disposition:'accepted'}),task('excluded','partial',{disposition:'excluded'}),task('unbuilt-dependency','pending',{dependsOn:['accepted']}),
  task('environment','blocked'),task('waiting','pending',{dependsOn:['environment']}),task('downstream','passed',{dependsOn:['waiting']}),
  task('spec','failed',{findings:[{type:'spec',status:'open'}]}),task('limited','limited'),task('repairable','limited',{retryable:true}),task('independent')
 ];
 assert.deepEqual(actions(tasks),{accepted:'keep',excluded:'keep','unbuilt-dependency':'wait',environment:'wait',waiting:'wait',downstream:'wait',spec:'wait',limited:'analyze',repairable:'build',independent:'build'});
});

test('switching to stronger evidence mode adds verification without rebuilding completed artifacts',()=>{
 const tasks=[task('a','passed',{strategy:'procedural'}),task('b','passed',{verifiedStrategies:['verification']}),task('c','passed',{strategy:'verification'}),task('accepted','limited',{disposition:'accepted'})];
 assert.deepEqual(actions(tasks,{strategy:'verification'}),{a:'verify',b:'keep',c:'keep',accepted:'keep'});
 assert.deepEqual(actions(tasks,{strategy:'assignment'}),{a:'keep',b:'keep',c:'keep',accepted:'keep'});
 assert.throws(()=>planPartialRetry(tasks,{changedTaskIds:['unknown']}),/ID/);
 assert.throws(()=>planPartialRetry([task('a','passed',{dependsOn:['b']}),task('b','passed',{dependsOn:['a']})]),/순환/);
});

test('role rotation preserves independent audit and configurable global switching budget',()=>{
 const config=defaultDevelopment();
 const rotation=rotateRoles(config,{authors:['codex'],switchCount:0});
 assert.equal(rotation.allowed,true);assert.deepEqual(rotation.roles,{builder:'claude',auditor:'agy',challenger:'codex'});
 assert.equal(rotateRoles(config,{authors:['codex'],switchCount:1}).allowed,false);
 assert.equal(rotateRoles({...config,limits:{...config.limits,maxSwitches:2}},{authors:['codex'],switchCount:1}).allowed,true);
 const own=rotateRoles(config,{authors:['codex','agy'],switchCount:0});assert.equal(own.allowed,true);
 const next={...config,roles:rotation.roles,limits:{...config.limits,maxSwitches:3}};
 assert.equal(rotateRoles(next,{authors:['codex','claude'],switchCount:1}).allowed,true,'review provenance is tracked at execution rather than rejecting the role');
 assert.deepEqual(config.roles,{builder:'codex',auditor:'claude',challenger:'agy'});
});
