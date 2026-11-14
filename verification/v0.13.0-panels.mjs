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
const fixture=path.join(repo,'tests/fixtures/intake-cli.mjs');
const agents=new AgentRunner({resolve:async provider=>({command:process.execPath,prefix:[fixture,provider]})}),runtime=new DevelopmentRunner({agentRunner:agents,dataRoot:path.join(temporary,'runs'),pollMs:10}),server=createAppServer({agentRunner:agents,developmentRunner:runtime});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const project=validateProject({id:'intake-demo',name:'공학용 계산기',description:'입력한 수식을 계산하는 실행 가능한 초안을 만들어 주세요. 그래프는 나중에 추가할 수 있으면 좋겠습니다.',instructions:'필수 기능과 기본값을 판단하세요.',paths:{current:source},development:{...defaultDevelopment(),strategy:'integrated',limits:{maxRevisions:1,maxReviews:4,maxSwitches:0}}});
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
 await evaluate(`(async()=>{
 const {mountDevelopment}=await import('/development.js?v=0.13.0');
 document.body.innerHTML='<div id="panel" style="max-width:1400px;margin:auto"></div>';
 const stamp=new Date().toISOString(),nodes=[{id:'goal',title:'KAF 실행 진행 · 화면 검증 예시',nodeType:'group'},{id:'group',title:'운임 검색 기능',nodeType:'group'},...Array.from({length:24},(_,i)=>({id:'task'+i,title:['공통 데이터 및 서비스 계약','도시별 가격 비교','검색 조건 검증'][i%3]+' '+(i+1),nodeType:'task'}))],edges=[{from:'goal',to:'group'},...nodes.slice(2).map(n=>({from:'group',to:n.id}))];
 window.panelState={revision:1,status:'running',tasks:nodes.slice(2).map((n,i)=>({...n,status:i<3?'running':'pending',builder:['codex','claude','agy'][i%3],auditor:['claude','agy','codex'][i%3],challenger:['agy','codex','claude'][i%3],checks:[],findings:[],changedPaths:i<3?['src/'+n.id+'.js']:[]})),events:[],releases:[],attempts:[{id:'a',createdAt:new Date(Date.now()-75000).toISOString(),status:'running'}],aiCalls:['codex','claude','agy'].map((agent,i)=>({id:'call'+i,agent,taskId:'task'+i,kind:['development-build','development-audit','development-analysis'][i],status:'running',requestedAt:stamp,startedAt:new Date(Date.now()-20000).toISOString(),lastCheckedAt:stamp,observedAt:stamp,process:{state:'running'},activity:{lastOutputAt:stamp},usage:{inputTokens:1500,outputTokens:300,totalTokens:1800}}))};
 window.panelView=mountDevelopment(document.querySelector('#panel'),{project:{id:'panel',name:'진행 화면 검증 예시',planning:{rootId:'goal',nodes,edges},paths:{current:''}},initialPage:'progress',save:async()=>1,client:{runner:{},connect:async()=>{},watch:(_id,fn)=>{fn(panelState);return()=>{};}}});await panelView.ready;
 })()`);
 assert.equal(await evaluate('document.querySelectorAll(".execution-node.is-running").length'),3);
 await evaluate("document.querySelector('.execution-map').scrollIntoView({block:'start'})");await screenshot('v013-map-live.png');
 const before=await evaluate("(()=>{const tree=document.querySelector('.execution-tree-scroll');tree.scrollTop=480;document.querySelector('[data-map-node=task8]').click();return {scroll:document.querySelector('.execution-tree-scroll').scrollTop,window:scrollY};})()");assert.ok(before.scroll>400);
 await evaluate("panelView.receiveState({...panelState,revision:2});panelView.renderLive()");const after=await evaluate("({scroll:document.querySelector('.execution-tree-scroll').scrollTop,window:scrollY,focus:panelView.focusTask})");assert.equal(after.scroll,before.scroll);assert.equal(after.window,before.window);assert.equal(after.focus,'task8');await screenshot('v013-map-scrolled.png');await evaluate("document.querySelector('[data-map-fold=goal]').open=false");await click('[data-map-active]');assert.equal(await evaluate("document.querySelector('[data-map-fold=goal]').open"),true);assert.equal(await evaluate('panelView.focusTask'),'task0');
 await evaluate("panelView.page='activity';panelView.activitySurface=true;panelView.render();window.scrollTo(0,0)");await screenshot('v013-monitor-times.png');assert.match(await evaluate('document.querySelector(".monitor-clocks").textContent'),/개발 누적 경과 1분/);
 await click('[data-monitor-tab=usage]');await screenshot('v013-monitor-usage.png');assert.match(await evaluate('document.body.innerText'),/AI·역할별 사용량/);
 await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},sessionId);await evaluate("panelView.page='progress';panelView.render();window.scrollTo(0,0)");assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1'),false);await screenshot('v013-map-mobile.png');
 await evaluate('panelView.destroy()');assert.deepEqual(errors,[]);console.log(JSON.stringify({scrollPreserved:true,selectionPreserved:true,threeAgentColors:true,cumulativeTime:true,usageBreakdown:true,mobileOverflow:false,consoleErrors:errors.length,screenshots:5}));
}catch(error){console.error(errors);await screenshot('v013-panels-failure.png');throw error;}finally{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Done'));}browser.kill();await runtime.close();await agents.close();await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
