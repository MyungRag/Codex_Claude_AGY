// Reproducible Chromium UI verification with deterministic CLI responses; no paid AI calls.
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createAppServer} from '../scripts/server.mjs';
import {AgentRunner} from '../scripts/agent-runner.mjs';
import {DevelopmentRunner} from '../scripts/development-runner.mjs';
import {createPlan,addNode} from '../public/planning-model.js';
import {addDecision,finalizePlan,createAssignments,saveAssignments} from '../public/decision-model.js';
import {validateProject} from '../public/model.js';
import {defaultDevelopment} from '../public/development-core.js';
const repo=fileURLToPath(new URL('../',import.meta.url)),temporary=await mkdtemp(path.join(os.tmpdir(),'agent-monitor-ui-')),source=path.join(temporary,'source');await mkdir(source);
const fixture=path.join(temporary,'fixture.mjs');let fixtureCode=await readFile(path.join(repo,'tests/fixtures/draft-cli.mjs'),'utf8');fixtureCode=fixtureCode.replace("'./calculator.mjs'",JSON.stringify(path.join(repo,'tests/fixtures/calculator.mjs'))).replace("if(value.role==='Builder'){", "await new Promise(r=>setTimeout(r,3000));\nif(value.role==='Builder'){")
.replace("result={summary:'계산기 소스와 실제 검사 정의',files:calculatorFiles({coreOnly:value.task.id==='engine',mode:assumption.answer}),limitations:[]};", "result={summary:'테스트용 CLI 소스 응답',files:value.task.id==='guide'?[{path:'GUIDE.md',action:'write',content:'# 계산기 사용 안내'}]:calculatorFiles({coreOnly:value.task.id==='engine',mode:assumption.answer}),limitations:[]};")
.replace("const passed=value.checks.length>0&&value.checks.every(c=>c.passed);", "const passed=(value.task.id==='guide'||value.checks.length>0)&&value.checks.every(c=>c.passed);");fixtureCode=fixtureCode.replace("evidence:value.checks.map(c=>c.label+' '+c.codeSha).join('; ')","evidence:value.checks.map(c=>c.label+' '+c.codeSha).join('; ')||'Pinned GUIDE.md usage document reviewed'");await writeFile(fixture,fixtureCode);
const agents=new AgentRunner({resolve:async provider=>({command:process.execPath,prefix:[fixture,provider]})}),runtime=new DevelopmentRunner({agentRunner:agents,dataRoot:path.join(temporary,'runs'),pollMs:10}),server=createAppServer({agentRunner:agents,developmentRunner:runtime});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
let project={id:'monitor-demo',name:'공학용 계산기 · 실행 확인',description:'테스트용 CLI 응답으로 진행 화면을 검증합니다.',instructions:'기본값을 적용하고 실행 가능한 초안을 만듭니다.',paths:{current:source}};let plan=createPlan(project);
for(const [id,title,dependsOn] of [['engine','계산 엔진',[]],['guide','사용 안내',[]],['screen','계산 화면',['engine']]]){const node=addNode(plan,plan.rootId,{title,instructions:title+' 구현',criteria:'실제 결과 확인',dependsOn,dependencyState:'defined'});plan.edges.find(e=>e.to===node.id).to=id;node.id=id;}
addDecision(plan,{type:'question',question:'기본 각도 단위',nodeIds:['engine','screen'],relatedIds:[],options:[{label:'DEG',impact:'도 단위'},{label:'RAD',impact:'라디안'}],recommendation:{kind:'assumption',answer:'DEG',reason:'일반 계산기 기본값',messageIds:[]}});
plan=finalizePlan(project,plan);const baseline=plan.baselines.at(-1),assignments=createAssignments(baseline).map(t=>({...t,agent:t.nodeId==='guide'?'agy':t.nodeId==='screen'?'claude':'codex'}));plan=saveAssignments(plan,baseline.id,assignments);
project=validateProject({...project,planning:plan,development:{...defaultDevelopment(),strategy:'assignment',limits:{maxRevisions:1,maxReviews:3,maxSwitches:0}}});
const browser=spawn('/usr/bin/chromium',['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--no-default-browser-check','--user-data-dir='+path.join(temporary,'browser'),'--remote-debugging-pipe','about:blank'],{stdio:['ignore','ignore','ignore','pipe','pipe']});
let seq=0,buffer='';const pending=new Map(),errors=[];browser.stdio[4].on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\0'))>=0){let message;try{message=JSON.parse(buffer.slice(0,index));}catch{}buffer=buffer.slice(index+1);if(!message)continue;if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);const p=pending.get(message.id);if(p){pending.delete(message.id);clearTimeout(p.timer);message.error?p.reject(new Error(message.error.message)):p.resolve(message.result);}}});
const command=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method));},20000);pending.set(id,{resolve,reject,timer});browser.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');});
const {targetId}=await command('Target.createTarget',{url:origin}),{sessionId}=await command('Target.attachToTarget',{targetId,flatten:true});await command('Runtime.enable',{},sessionId);await command('Page.enable',{},sessionId);
const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
const waitFor=async(expression,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await evaluate(expression))return;await delay(150);}throw new Error('UI condition timed out: '+expression);};
const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const screenshot=async name=>{const {data}=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},sessionId);await writeFile(path.join(repo,'verification',name),Buffer.from(data,'base64'));};
try{
 await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false},sessionId);await waitFor('document.querySelector("#project-grid")');
 await evaluate(`(async()=>{const store=await import('/storage.js?v=0.10.0');await store.openStore();const state=await store.readState();await store.saveState({...state,projects:[${JSON.stringify(project)}]},state.revision);location.hash='#monitor-demo/development';location.reload();})()`);
 await waitFor('document.querySelector("[data-dev=start]") && !document.querySelector("[data-dev=start]").disabled');await click('[data-dev=start]');await waitFor('document.querySelector("[data-dev=page][data-page=activity]")');await click('[data-dev=page][data-page=activity]');
 await waitFor('document.querySelectorAll(".agent-station.is-running").length>=2');await screenshot('execution-live-desktop.png');
 await click('[data-monitor-tab=usage]');await screenshot('execution-usage-desktop.png');
 await click('[data-dev=page][data-page=progress]');await waitFor('document.querySelector(".execution-map")');await screenshot('execution-map-desktop.png');
 const end=Date.now()+90000;let result;while(Date.now()<end){result=await runtime.get('monitor-demo');if(result.status==='completed')break;await delay(500);}assert.equal(result.status,'completed');assert.ok(result.tasks.every(t=>t.status==='passed'),JSON.stringify(result.tasks.map(t=>({id:t.id,status:t.status,error:t.error}))));assert.ok(result.latestRunnableId,JSON.stringify(result.tasks.map(t=>({id:t.id,status:t.status,error:t.error}))));
 await click('[data-dev=page][data-page=preview]');await waitFor('document.querySelector("[data-dev=launch]")');await click('[data-dev=launch]');await waitFor('document.querySelector("iframe.program-preview")');await screenshot('execution-preview-desktop.png');
 const frameId=await evaluate('document.querySelector("iframe").getAttribute("src")');await delay(1900);assert.equal(await evaluate('document.querySelector("iframe").getAttribute("src")'),frameId);
 await click('[data-dev=page][data-page=activity]');await click('[data-monitor-tab=usage]');await screenshot('execution-usage-completed.png');
 await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},sessionId);await click('[data-monitor-tab=live]');await evaluate('window.scrollTo(0,0)');await screenshot('execution-live-mobile.png');
 assert.equal(await evaluate('document.documentElement.scrollWidth>window.innerWidth+1'),false,'mobile page should not overflow horizontally');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ui:'passed',tasks:result.tasks.map(t=>({id:t.id,status:t.status,reviewMode:t.audit?.mode})),calls:result.aiCalls.length,release:!!result.latestRunnableId,consoleErrors:errors.length,screenshots:6}));
}catch(error){console.error('Browser errors:',errors);console.error((await evaluate('document.body.innerText')).slice(-2200));await screenshot('execution-verification-failure.png');throw error;}finally{
 for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Browser verification ended'));}pending.clear();browser.kill();await runtime.close();await agents.close();await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
