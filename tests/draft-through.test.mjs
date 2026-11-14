import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createPlan,addNode} from '../public/planning-model.js';
import {applyQuestionSynthesis} from '../public/review-model.js';
import {finalizePlan,createAssignments,saveAssignments} from '../public/decision-model.js';
import {defaultDevelopment} from '../public/development-core.js';
import {AgentRunner} from '../scripts/agent-runner.mjs';
import {DevelopmentRunner} from '../scripts/development-runner.mjs';
import {DevelopmentWorkspace} from '../scripts/development-workspace.mjs';
import {browserChecks,parseBrowserChecks} from '../scripts/browser-checks.mjs';
import {calculatorFiles} from './fixtures/calculator.mjs';

test('unanswered calculator choices become adopted defaults and a two-node program completes with real automatic tests',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'draft-through-')),source=path.join(root,'source');await mkdir(source);
 const cli=fileURLToPath(new URL('./fixtures/draft-cli.mjs',import.meta.url));
 const agents=new AgentRunner({resolve:async agent=>({command:process.execPath,prefix:[cli,agent]})}),runtime=new DevelopmentRunner({agentRunner:agents,dataRoot:path.join(root,'runs'),pollMs:5});
 t.after(async()=>{await runtime.close();await agents.close();await rm(root,{recursive:true,force:true});});
 const project={id:'calculator',name:'공학용 계산기',path:source,instructions:''};let plan=createPlan(project);
 const engine=addNode(plan,plan.rootId,{title:'계산 엔진',instructions:'사칙연산과 공학 함수를 구현한다.',criteria:'연산 우선순위, 각도 변환, 오류 입력 검증',dependencyState:'defined'});plan.edges.find(e=>e.to===engine.id).to='engine';engine.id='engine';
 const screen=addNode(plan,plan.rootId,{title:'계산 화면',instructions:'계산 엔진에 입력과 결과 화면을 연결한다.',criteria:'실제 버튼으로 계산 결과와 오류를 표시한다.',dependsOn:['engine'],dependencyState:'defined'});plan.edges.find(e=>e.to===screen.id).to='screen';screen.id='screen';
 const item={type:'question',nodeIds:['engine','screen'],relatedIds:[],question:'기본 각도 단위는?',reason:'계산 기준',evidence:'설계 선택',options:[{label:'RAD',impact:'라디안'},{label:'DEG',impact:'도 단위'}],blocking:true,recommendation:{kind:'assumption',answer:'DEG',reason:'일반 계산기 기본값',messageIds:[]}};
 const jobs=['codex','claude','agy'].map(agent=>({id:'review-'+agent,agent,result:{summary:'독립 검토',items:[item]}}));
 plan=applyQuestionSynthesis(plan,['engine','screen'],jobs,{summary:'각도 질문 통합',items:[{...item,existingIds:[],sourceRefs:['codex-1','claude-1','agy-1']}],omitted:[]},{id:'lead-review',lead:'codex'});
 plan=finalizePlan(project,plan);const baseline=plan.baselines[0];plan=saveAssignments(plan,baseline.id,createAssignments(baseline));
 const input={requestId:crypto.randomUUID(),project,baseline,handoff:plan.handoffs[0],config:{...defaultDevelopment(),lead:'agy'},agentSettings:{}};
 await runtime.start(input);await runtime.runs.get(project.id).done;const state=await runtime.get(project.id);
 assert.equal(state.status,'completed',JSON.stringify(state));assert.deepEqual(state.tasks.map(t=>t.status),['passed','passed']);
 assert.ok(state.latestRunnableId);const release=state.releases.find(r=>r.id===state.latestRunnableId);
 assert.equal(release.verification.audit,'pass');assert.equal(release.stage,'reviewed');assert.ok(release.verification.checks.some(c=>c.command==='browser'));assert.ok(release.verification.checks.every(c=>c.passed));
 assert.equal(release.trace.baseline.snapshot.items[0].resolution.kind,'assumption');assert.equal(release.trace.baseline.snapshot.items[0].answer,'DEG');assert.ok(release.trace.tasks.find(t=>t.id==='screen').changedPaths.includes('index.html'));
 const launch=await runtime.launch(project.id,release.id);assert.match(await(await fetch(launch.url)).text(),/공학용 계산기/);
 const check=await browserChecks(launch.url,parseBrowserChecks({checks:[{name:'후속 독립 검증',steps:[{action:'fill',selector:'#expression',value:'cos(60)'},{action:'click',selector:'#calculate'}],expect:[{selector:'#result',text:'0.5',mode:'equals'}]}]}));assert.equal(check[0].passed,true,JSON.stringify(check));
 const zip=await runtime.download(project.id,release.id);assert.ok(zip.includes(Buffer.from('_agent_desk_decisions.json')));
 await assert.rejects(readFile(path.join(source,'index.html')),{code:'ENOENT'});
});

test('automatic browser checks detect a broken result instead of equating a loaded page with functional success',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'automatic-check-')),source=path.join(root,'source');await mkdir(source);
 const workspace=new DevelopmentWorkspace({dataRoot:path.join(root,'work')});t.after(()=>rm(root,{recursive:true,force:true}));
 const work=await workspace.create({projectId:'calc',sourcePath:source,attemptId:'check'}),files=calculatorFiles();
 files.find(f=>f.path==='index.html').content=files.find(f=>f.path==='index.html').content.replace(".value=String(calculate(document.querySelector('#expression').value,document.querySelector('#mode').value))", ".value='999'");
 await workspace.apply(work,files);const sha=await workspace.commit(work,'broken fixture');
 const checks=await workspace.automaticChecks(work,{kind:'static',entry:'index.html'},{nodeId:'screen'});
 assert.ok(checks.some(c=>c.command==='browser'&&!c.passed));assert.ok(checks.every(c=>c.codeSha===sha));assert.ok(checks.filter(c=>c.command==='node').every(c=>c.passed),'core tests pass but the real UI is broken');
 assert.throws(()=>parseBrowserChecks({checks:[{name:'bad',steps:[{action:'evaluate',selector:'body',value:'alert(1)'}],expect:[{selector:'body',text:'',mode:'equals'}]}]}),/지원하지/);
});

test('browser cases have independent local storage and cookies even within one suite',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'browser-isolation-')),source=path.join(root,'source');await mkdir(source);const workspace=new DevelopmentWorkspace({dataRoot:path.join(root,'data')});const w=await workspace.create({projectId:'isolation',sourcePath:source,attemptId:'a'});
 await workspace.apply(w,[{path:'index.html',action:'write',content:`<output id="state"></output><button id="change">Change</button><script>const show=()=>document.querySelector('#state').textContent=(localStorage.getItem('value')||'0')+':'+(document.cookie.includes('value=1')?'1':'0');show();document.querySelector('#change').onclick=()=>{localStorage.setItem('value','1');document.cookie='value=1';show();};</script>`}]);await workspace.commit(w);const launch=await workspace.launch(w.path,{kind:'static',entry:'index.html'});t.after(async()=>{await launch.stop();await rm(root,{recursive:true,force:true});});
 const results=await browserChecks(launch.url,parseBrowserChecks({checks:[{name:'mutate state',steps:[{action:'click',selector:'#change'}],expect:[{selector:'#state',text:'1:1',mode:'equals'}]},{name:'fresh state',steps:[],expect:[{selector:'#state',text:'0:0',mode:'equals'}]}]}));assert.equal(results.length,2);assert.ok(results.every(c=>c.passed),JSON.stringify(results));
});
