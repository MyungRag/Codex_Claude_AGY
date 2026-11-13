import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {DevelopmentRunner} from '../scripts/development-runner.mjs';
import {defaultDevelopment,dependencyReady} from '../public/development-core.js';

const audit=payload=>({summary:'Pinned contract checked',verdict:'pass',handoff:{ready:true,evidence:'Required source export exists in the pinned files'},verifiedCriteria:[{criterion:'Required export exists',evidence:'Pinned source and successful supplied host check'}],unverifiedCriteria:[],previousFindings:(payload.previousFindings||[]).map(f=>({id:f.id,status:'resolved',evidence:'Checked corrected or isolated behavior in assembled source'})),findings:[]});
const build=(id,files)=>({summary:'Implemented '+id,files:files||[{path:id+'.js',action:'write',content:'export const ready = true;'}],limitations:[]});
class Agents{
 constructor(handler){this.jobs=new Map();this.calls=[];this.handler=handler;this.maxActive=0;}
 create(input){
  assert.ok(![...this.jobs.values()].some(j=>j.agent===input.agent&&!j.settled),'one active call per provider');
  const job={id:randomUUID(),agent:input.agent,kind:input.kind,status:'running',startedAt:new Date().toISOString(),context:input.context},payload=JSON.parse(input.prompt);this.jobs.set(job.id,job);this.calls.push({...input,payload});
  this.maxActive=Math.max(this.maxActive,[...this.jobs.values()].filter(j=>!j.settled).length);
  job.done=(async()=>{await delay(40);try{job.result=await this.handler(input,payload);job.status='succeeded';job.usage={inputTokens:10,outputTokens:5,totalTokens:15};}catch(error){job.status='failed';job.error=error.message;}finally{job.finishedAt=new Date().toISOString();job.settled=true;}})();return this.get(job.id);
 }
 get(id){const {done,...job}=this.jobs.get(id);return job;}
 cancel(id){const job=this.jobs.get(id);if(job){job.status='cancelled';job.settled=true;}return job;}
}
async function setup(t,{ids=['one','two'],handler,config={}}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'parallel-draft-')),source=path.join(root,'source');await mkdir(source);await writeFile(path.join(source,'index.html'),'<main>READY</main>');
 const agents=new Agents((input,payload)=>handler?.(input,payload)??(input.kind==='development-build'?build(payload.task.id):input.kind==='development-audit'?audit(payload):{summary:'Summary of actual task statuses',risks:[],recommendation:'Keep remaining limitations'}));
 const runtime=new DevelopmentRunner({agentRunner:agents,dataRoot:path.join(root,'state'),pollMs:2});
 const baseline={id:'baseline',number:1,snapshot:{rootId:'goal',nodes:[{id:'goal',title:'Goal'},...ids.map(id=>({id,title:id}))],edges:ids.map(id=>({from:'goal',to:id})),items:[]}};
 const input={requestId:randomUUID(),project:{id:'parallel',name:'Parallel fixture',path:source,instructions:''},baseline,handoff:{baselineId:'baseline',tasks:ids.map((id,index)=>({nodeId:id,agent:['codex','claude','agy'][index%3],dependsOn:[],instructions:'Implement '+id,deliverable:id+' export',criteria:'Source export and host check'}))},config:{...defaultDevelopment(),strategy:'assignment',limits:{maxRevisions:0,maxReviews:4,maxSwitches:0},checks:[{id:'core',label:'Core startup content',command:'node',args:['-e',"if(!require('fs').readFileSync('index.html','utf8').includes('READY'))process.exit(1)"]}],...config}};
 t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true});});
 const finish=async()=>{await runtime.start(input);await runtime.runs.get('parallel')?.done;return runtime.get('parallel');};return {runtime,agents,input,finish,source};
}

test('independent providers actually overlap, same provider queues, and disjoint files survive atomic integration',async t=>{
 const {runtime,agents,finish,source}=await setup(t,{ids:['one','two','three']}),state=await finish();
 assert.ok(agents.maxActive>=2);assert.ok(state.tasks.every(task=>task.status==='passed'));assert.ok(state.latestRunnableId);
 const stored=await runtime._load('parallel');for(const id of ['one','two','three'])assert.match(await readFile(path.join(stored.workingPath,id+'.js'),'utf8'),/ready = true/);
 await assert.rejects(readFile(path.join(source,'one.js')),{code:'ENOENT'});
 assert.ok(state.aiCalls.every(call=>call.status==='succeeded'&&call.finishedAt));assert.ok(state.aiCalls.some(call=>call.usage?.totalTokens===15));
 const release=state.releases.find(r=>r.id===state.latestRunnableId);const launched=await runtime.launch('parallel',release.id);assert.match(await(await fetch(launched.url)).text(),/READY/);await runtime.stopLaunch('parallel',release.id);assert.equal(runtime.launches.size,0);
});

test('shared-file collision retries against latest source without overwriting the first contribution',async t=>{
 const {runtime,agents,finish}=await setup(t,{handler:(input,payload)=>input.kind==='development-build'?build(payload.task.id,[{path:'shared.txt',action:'write',content:(payload.files.find(f=>f.path==='shared.txt')?.content||'')+payload.task.id+'\n'}]):undefined});
 const state=await finish(),stored=await runtime._load('parallel');assert.ok(state.events.some(e=>e.type==='merge-retry'));const contents=await readFile(path.join(stored.workingPath,'shared.txt'),'utf8');assert.match(contents,/one/);assert.match(contents,/two/);
 assert.equal(agents.calls.filter(c=>c.kind==='development-build').length,3);assert.ok(state.tasks.every(task=>task.status==='passed'));
});

test('usable verified handoff releases dependents despite incomplete acceptance; mere source SHA does not',async t=>{
 const {agents,input,finish}=await setup(t,{ids:['contract','consumer'],handler:(request,payload)=>request.kind==='development-audit'&&payload.task.id==='contract'?{...audit(payload),verdict:'hold',unverifiedCriteria:['Full browser integration is not available yet']}:undefined});
 input.handoff.tasks[1].dependsOn=['contract'];const state=await finish();assert.ok(agents.calls.some(c=>c.kind==='development-build'&&c.payload.task.id==='consumer'));assert.equal(state.tasks.find(t=>t.id==='contract').status,'limited');assert.equal(state.tasks.find(t=>t.id==='consumer').status,'passed');
 assert.equal(dependencyReady({status:'limited',artifactSha:'sha',findings:[]}),false);
 assert.equal(dependencyReady({status:'limited',artifactSha:'sha',readiness:{ready:true,codeSha:'other',evidence:'stale'}}),false);
});

test('unready prerequisite blocks its consumer only; independent functionality and bounded draft assembly proceed',async t=>{
 const {agents,input,finish}=await setup(t,{ids:['contract','consumer','independent'],handler:(request,payload)=>request.kind==='development-audit'&&payload.task.id==='contract'?{...audit(payload),verdict:'hold',handoff:{ready:false,evidence:'Required external contract is missing'},unverifiedCriteria:['Contract incomplete']}:undefined});
 input.handoff.tasks[1].dependsOn=['contract'];const state=await finish();assert.equal(state.tasks.find(t=>t.id==='consumer').status,'blocked');assert.ok(!agents.calls.some(c=>c.kind==='development-build'&&c.payload.task.id==='consumer'));assert.ok(agents.calls.some(c=>c.kind==='development-build'&&c.payload.task.id==='independent'));assert.equal(agents.calls.filter(c=>c.kind==='development-build'&&c.payload.task.id==='draft-assembly').length,1);assert.ok(state.latestRunnableId);assert.ok(state.releases.at(-1).limitations.some(l=>l.taskId==='consumer'));
});

test('single-provider setup completes with explicit self-review rather than throwing an author error',async t=>{
 const {finish}=await setup(t,{ids:['one'],config:{strategy:'verification',roles:{builder:'codex',auditor:'codex',challenger:'codex'}}}),state=await finish();assert.equal(state.tasks[0].status,'passed');assert.equal(state.tasks[0].audit.mode,'self');assert.equal(state.releases.at(-1).verification.reviewMode,'self-or-mixed');
});

test('browser environment failure remains unverified and does not manufacture an implementation defect',async t=>{
 const {runtime,input,finish}=await setup(t,{ids:['contract','consumer']});input.handoff.tasks[1].dependsOn=['contract'];runtime.workspace.check=async()=>[{id:'browser',label:'Browser',passed:false,exitCode:null,failureKind:'environment',output:'Browser process exited before assertions'}];
 const state=await finish();assert.equal(state.tasks.find(t=>t.id==='consumer').status,'limited');assert.ok(state.tasks.every(t=>!t.findings.some(f=>f.type==='implementation')));assert.ok(state.latestRunnableId);assert.ok(state.releases.at(-1).limitations.some(l=>l.status==='unverified'));assert.equal(state.releases.at(-1).stage,'draft');
});

test('real failed core checks cannot be turned into a runnable release by AI approval',async t=>{
 const {runtime,agents,finish}=await setup(t);runtime.workspace.check=async()=>[{id:'core',label:'Core regression',passed:false,exitCode:1,output:'Wrong calculation'}];const state=await finish();assert.equal(state.latestRunnableId,null);assert.ok(agents.calls.some(c=>c.kind==='development-build'&&c.payload.task.id==='two'));assert.ok(state.tasks.some(t=>t.isAssembly));
});

test('an unavailable independent reviewer falls back once to explicitly labeled self-review',async t=>{
 const {agents,finish}=await setup(t,{ids:['one'],config:{strategy:'integrated',roles:{builder:'codex',auditor:'claude',challenger:'agy'}},handler:(request)=>{if(request.kind==='development-audit'&&request.agent==='claude')throw new Error('Reviewer unavailable');}});
 const state=await finish();assert.equal(state.tasks[0].status,'passed');assert.equal(state.tasks[0].audit.mode,'self');assert.ok(state.events.some(e=>e.type==='self-review'));assert.equal(agents.calls.filter(c=>c.kind==='development-audit'&&c.agent==='claude').length,1);assert.ok(state.aiCalls.some(c=>c.agent==='claude'&&c.status==='failed'));assert.ok(state.latestRunnableId);
});

test('cancelling a wave prevents queued calls from starting and settles every activity record',async t=>{
 const {runtime,agents,input}=await setup(t,{ids:['one','two','three'],config:{strategy:'integrated',roles:{builder:'codex',auditor:'codex',challenger:'codex'}}});
 await runtime.start(input);const deadline=Date.now()+5000;while(!agents.calls.length&&Date.now()<deadline)await delay(5);assert.equal(agents.calls.length,1);await runtime.cancel('parallel');await runtime.runs.get('parallel')?.done;
 const state=await runtime.get('parallel');assert.equal(state.status,'cancelled');assert.equal(agents.calls.length,1);assert.ok(state.aiCalls.length>=2);assert.ok(state.aiCalls.every(c=>c.status==='cancelled'&&c.finishedAt));assert.equal(state.activeAttemptId,null);
});
