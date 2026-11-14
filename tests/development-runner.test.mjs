import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {AgentRunner} from '../scripts/agent-runner.mjs';
import {DevelopmentRunner} from '../scripts/development-runner.mjs';
import {parseDevelopmentResponse} from '../scripts/development-schemas.mjs';
import {defaultDevelopment} from '../public/development-core.js';

// An actual child-process fixture for all three official CLI response envelopes.
// No installed provider, account, network, or paid request is used.
const cli=String.raw`
import {writeFile} from 'node:fs/promises';
const [provider,...args]=process.argv.slice(2);
if(args.includes('--version')){console.log('fixture 1.0');process.exit();}
if(args.includes('--help')){console.log('--output-schema --ignore-user-config --ignore-rules --json-schema --safe-mode --tools --strict-mcp-config --input-format --mode');process.exit();}
let input='';for await(const chunk of process.stdin)input+=chunk;
if(provider==='agy')input=JSON.parse(input).message.content;
const value=JSON.parse(input.slice(input.indexOf('{'))),instructions=value.task?.instructions||'';
if(instructions==='HANG'){setInterval(()=>{},1000);await new Promise(()=>{});}
const previous=value.previousFindings||[];
const issue={type:'implementation',severity:instructions==='CRITICAL'?'critical':'medium',summary:'Fixture defect',evidence:'Pinned source has BAD marker',remedy:'Replace BAD with GOOD'};
let result;
if(value.role==='Builder'){
 const bad=instructions==='FAIL'||instructions==='CRITICAL'||(instructions==='ROTATE'&&provider==='codex');
 const files=instructions==='REMOVE_ENTRY'?[{path:'index.html',action:'delete',content:''}]:[{path:value.task.id==='app'?'index.html':value.task.id+'.txt',action:'write',content:value.task.id==='app'?'<html><body>'+(bad?'BAD':'GOOD')+'</body></html>':'GOOD'}];
 result={summary:'Source proposal',files,limitations:[]};
}else if(value.role==='Auditor'){
 const failed=instructions==='FAIL'||instructions==='CRITICAL'||value.files.some(file=>file.path==='index.html'&&file.content.includes('BAD'));
 result={summary:failed?'Defect found':'Criteria verified',verdict:failed?'fail':'pass',verifiedCriteria:failed?[]:[{criterion:value.task.criteria,evidence:'Pinned file content and supplied successful host check'}],unverifiedCriteria:[],previousFindings:previous.map(f=>({id:f.id,status:failed?'open':'resolved',evidence:failed?'Defect persists':'Verified fixed source'})),findings:failed?[issue]:[]};
}else result={summary:'Coordination evidence reviewed',risks:[],recommendation:'Continue only within approved scope'};
if(provider==='codex'){await writeFile(args[args.indexOf('--output-last-message')+1],JSON.stringify(result));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:10}}));}
else if(provider==='claude')console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:result}));
else console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',structured_output:result}}));
`;

async function setup(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'development-runtime-test-')),source=path.join(root,'source'),fixture=path.join(root,'cli.mjs'),dataRoot=path.join(root,'data');await mkdir(source);await writeFile(fixture,cli);await writeFile(path.join(source,'original.txt'),'unchanged');
 const agentRunner=new AgentRunner({resolve:async provider=>({command:process.execPath,prefix:[fixture,provider]})}),runtime=new DevelopmentRunner({agentRunner,dataRoot,pollMs:10});
 t.after(async()=>{await runtime.close();await agentRunner.close();await rm(root,{recursive:true,force:true});});return {root,source,dataRoot,agentRunner,runtime};
}
function payload(source,{strategy='assignment',instructions='GOOD',tasks=['app'],config={}}={}){
 const baseline={id:'baseline-1',number:1,snapshot:{rootId:'goal',nodes:[{id:'goal',title:'Goal'},...tasks.map(id=>({id,title:id}))],items:[{id:'unanswered',nodeIds:['app'],question:'Unknown choice',status:'answer'}]}};
 return {requestId:randomUUID(),project:{id:'project-1',name:'Fixture app',path:source,instructions:'Keep unrelated work'},baseline,handoff:{baselineId:baseline.id,tasks:tasks.map(id=>({nodeId:id,agent:'codex',dependsOn:[],instructions:id==='app'?instructions:'GOOD',criteria:'Meaningful source exists and check passes',deliverable:'Executable source'}))},config:{...defaultDevelopment(),strategy,limits:{maxRevisions:0,maxReviews:1,maxSwitches:1},checks:[{id:'exists',label:'Entry exists',command:'node',args:['-e',"require('node:fs').accessSync('index.html')"]}],...config},agentSettings:{}};
}
async function finished(runtime,projectId='project-1'){
 const deadline=Date.now()+20000;while(Date.now()<deadline){const state=await runtime.get(projectId);if(!['running','cancelling'].includes(state.status)){await runtime.runs.get(projectId)?.done;return runtime.get(projectId);}await delay(20);}throw new Error('Runtime did not finish');
}

test('real CLI envelopes build isolated files, run checks, pin independent audit and launch/download a release',async t=>{
 const {source,runtime,agentRunner,dataRoot}=await setup(t),input=payload(source,{config:{lead:'agy'}});
 const accepted=await runtime.start(input);assert.equal(accepted.status,'running');assert.ok(accepted.activeAttemptId);
 const state=await finished(runtime);assert.equal(state.status,'completed');assert.equal(state.tasks[0].status,'passed',JSON.stringify(state));
 assert.match(state.tasks[0].artifactSha,/^[a-f0-9]{40}$/);assert.equal(state.tasks[0].checks[0].passed,true);assert.equal(state.tasks[0].checks[0].codeSha,state.tasks[0].audit.codeSha);
 assert.equal(state.tasks[0].audit.agent,'claude');assert.ok([...agentRunner.jobs.values()].some(job=>job.agent==='agy'&&JSON.parse(job.prompt).role==='overall-lead'));
 const builder=[...agentRunner.jobs.values()].find(job=>job.kind==='development-build');assert.equal(JSON.parse(builder.prompt).baseline.snapshot.items[0].question,'Unknown choice');assert.equal(builder.timeoutMs,20*60000);
 assert.equal(await readFile(path.join(source,'original.txt'),'utf8'),'unchanged');await assert.rejects(readFile(path.join(source,'index.html')),{code:'ENOENT'});
 assert.ok(state.latestRunnableId);const launch=await runtime.launch('project-1',state.latestRunnableId);assert.match(await (await fetch(launch.url)).text(),/GOOD/);
 const zip=await runtime.download('project-1',state.latestRunnableId);assert.equal(zip.subarray(0,2).toString(),'PK');
 assert.ok(state.attempts[0].records.some(record=>record.type==='submission'));assert.ok(state.attempts[0].records.some(record=>record.type==='audit'));
 const count=agentRunner.jobs.size;await runtime.start(input);assert.equal(agentRunner.jobs.size,count);await assert.rejects(runtime.start({...input,project:{...input.project,name:'different'}}),/같은 요청/);
 const stored=JSON.parse(await readFile(path.join(dataRoot,'project-1.json'),'utf8'));assert.ok(stored.workingPath);assert.ok(stored.attempts[0].input);assert.equal(state.workingPath,undefined);assert.equal(state.attempts[0].input,undefined);
});

test('bounded combination switching changes the two active providers without resetting cumulative history',async t=>{
 const {source,runtime}=await setup(t),input=payload(source,{strategy:'integrated',instructions:'ROTATE',config:{autoSwitch:true}});
 await runtime.start(input);const state=await finished(runtime);assert.equal(state.tasks[0].status,'passed',JSON.stringify(state));
 assert.equal(state.tasks[0].builder,'claude');assert.equal(state.tasks[0].auditor,'agy');assert.equal(state.tasks[0].reviewCount,2);assert.equal(state.tasks[0].revisionCount,1);assert.equal(state.attempts[0].revisionCount,1);assert.equal(state.attempts[0].switchCount,1);assert.equal(state.attempts[0].taskCounts.app.rounds.length,2);
 assert.deepEqual(state.tasks[0].authors,['codex','claude']);assert.ok(state.tasks[0].findings.every(f=>f.status==='resolved'));
 const next=payload(source,{strategy:'procedural',config:{roles:{builder:'agy',auditor:'codex',challenger:'claude'}}});next.retry=true;next.baseline.id='baseline-2';next.baseline.number=2;next.handoff.baselineId='baseline-2';next.handoff.tasks[0].instructions='CHANGED';
 await runtime.start(next);const blocked=await finished(runtime);assert.equal(blocked.tasks[0].error,null);assert.equal(blocked.tasks[0].audit.mode,'self');assert.equal(blocked.tasks[0].reviewCount,3);
});

test('failed candidate preserves last runnable artifact and unrelated successful tasks',async t=>{
 const {source,runtime}=await setup(t);await runtime.start(payload(source));const good=await finished(runtime),releaseId=good.latestRunnableId;
 const retry=payload(source,{instructions:'REMOVE_ENTRY'});retry.retry=true;retry.baseline.id='baseline-2';retry.handoff.baselineId='baseline-2';
 await runtime.start(retry);const failed=await finished(runtime);assert.equal(failed.latestRunnableId,releaseId);assert.notEqual(failed.tasks[0].status,'passed');
 const launch=await runtime.launch('project-1',releaseId);assert.match(await(await fetch(launch.url)).text(),/GOOD/);
});

test('early cancellation is durable, in-flight unlimited process is cancellable, and restart marks interruption',async t=>{
 const {source,runtime,agentRunner,dataRoot}=await setup(t),early=payload(source);
 await runtime.cancel('project-1',{requestId:early.requestId});assert.equal((await runtime.start(early)).status,'cancelled');assert.equal(agentRunner.jobs.size,0);
 const input=payload(source,{instructions:'HANG'});await runtime.start(input);const deadline=Date.now()+4000;while(![...agentRunner.jobs.values()].some(job=>job.kind==='development-build')&&Date.now()<deadline)await delay(10);
 await runtime.cancel('project-1',{requestId:input.requestId});const stopped=await finished(runtime);assert.equal(stopped.status,'cancelled');assert.ok([...agentRunner.jobs.values()].every(job=>job.settled));
 const location=path.join(dataRoot,'project-1.json'),saved=JSON.parse(await readFile(location,'utf8'));saved.status='running';saved.activeAttemptId=saved.attempts.at(-1).id;saved.tasks[0].status='running';await writeFile(location,JSON.stringify(saved));
 const restored=new DevelopmentRunner({agentRunner,dataRoot});t.after(()=>restored.close());const state=await restored.get('project-1');assert.equal(state.status,'interrupted');assert.equal(state.tasks[0].status,'partial');assert.equal(state.activeAttemptId,null);
});

test('critical findings cannot be accepted into a runnable release; mode preview retains successful work',async t=>{
 const {source,runtime}=await setup(t);await runtime.start(payload(source,{instructions:'CRITICAL',tasks:['app','notes']}));const state=await finished(runtime);assert.equal(state.latestRunnableId,null);assert.ok(state.tasks.some(task=>task.id==='notes'&&task.reviewCount>0),'independent task still ran');
 await assert.rejects(runtime.accept('project-1',{taskId:'app',reason:'ignore'}),/핵심 구현 오류/);
 const preview=await runtime.preview(payload(source,{strategy:'issue',instructions:'CRITICAL',tasks:['app','notes']}));assert.equal(preview.entries.find(entry=>entry.taskId==='app').action,'build');
});

test('unavailable check environment retains unverified evidence and resumes verification without rebuilding',async t=>{
 const {source,runtime,agentRunner}=await setup(t),input=payload(source,{config:{checks:[{id:'missing',label:'Unavailable tool',command:'agent-desk-fixture-missing-tool',args:[]}]}});
 await runtime.start(input);const held=await finished(runtime);assert.equal(held.tasks[0].status,'limited');assert.equal(held.tasks[0].reviewCount,1);assert.equal(held.tasks[0].revisionCount,0);
 const next=payload(source);next.retry=true;const preview=await runtime.preview(next);assert.equal(preview.entries[0].action,'verify');
 const before=[...agentRunner.jobs.values()].filter(job=>job.kind==='development-build').length;await runtime.start(next);const resumed=await finished(runtime);assert.equal(resumed.tasks[0].status,'passed',JSON.stringify(resumed));assert.equal([...agentRunner.jobs.values()].filter(job=>job.kind==='development-build').length,before);
});

test('launch cancellation tombstones prevent late POSTs and cancel only the matching pending launch',async t=>{
 const {source,runtime,agentRunner,dataRoot}=await setup(t);await runtime.start(payload(source));const state=await finished(runtime),projectId='project-1',releaseId=state.latestRunnableId;
 const cancelledId=randomUUID();await runtime.cancel(projectId,{requestId:cancelledId});
 const restored=new DevelopmentRunner({agentRunner,dataRoot});t.after(()=>restored.close());
 await assert.rejects(restored.launch(projectId,releaseId,{requestId:cancelledId}),/취소/);assert.equal(restored.launchRequests.size,0);
 const original=runtime.workspace.launch.bind(runtime.workspace);let markStarted,calls=0;const started=new Promise(resolve=>{markStarted=resolve;});
 runtime.workspace.launch=async(_path,_config,{signal}={})=>{calls++;markStarted();return new Promise((resolve,reject)=>{const stop=()=>reject(new Error('fixture launch cancelled'));if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});});};
 const launchId=randomUUID(),pending=runtime.launch(projectId,releaseId,{requestId:launchId});const rejected=assert.rejects(pending,/cancelled|취소/);await started;
 await runtime.cancel(projectId,{requestId:randomUUID()});assert.equal(runtime.launchRequests.get(projectId+':'+releaseId).controller.signal.aborted,false);
 await runtime.cancel(projectId,{requestId:launchId});await rejected;assert.equal(calls,1);assert.equal(runtime.launchRequests.size,0);
 await assert.rejects(runtime.launch(projectId,releaseId,{requestId:launchId}),/취소/);assert.equal(calls,1);
 runtime.workspace.launch=original;
 const freshId=randomUUID(),result=await runtime.launch(projectId,releaseId,{requestId:freshId});assert.match(await(await fetch(result.url)).text(),/GOOD/);
 await runtime.cancel(projectId,{requestId:freshId});assert.equal(runtime.launches.size,0);await assert.rejects(fetch(result.url));
});

test('structured response validators reject unsupported paths, false passes, duplicate reports, and oversized changes',()=>{
 assert.throws(()=>parseDevelopmentResponse({summary:'x',files:[{path:'../outside',action:'write',content:'x'}],limitations:[]},'development-build'));
 const audit={summary:'x',verdict:'pass',verifiedCriteria:[{criterion:'works',evidence:'static'}],unverifiedCriteria:[],previousFindings:[],findings:[]};
 assert.throws(()=>parseDevelopmentResponse({...audit,unverifiedCriteria:['missing execution']},'development-audit'));
 assert.throws(()=>parseDevelopmentResponse({...audit,previousFindings:[{id:'old',status:'open',evidence:'still broken'}]},'development-audit'));
 assert.throws(()=>parseDevelopmentResponse({summary:'x',files:[{path:'ok.js',action:'write',content:'x'.repeat(300001)}],limitations:[]},'development-build'));
});
