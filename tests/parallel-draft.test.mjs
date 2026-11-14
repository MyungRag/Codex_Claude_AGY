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
  job.done=(async()=>{await delay(40);try{job.result=await this.handler(input,payload);job.status='succeeded';job.usage={inputTokens:10,outputTokens:5,totalTokens:15};}catch(error){job.status='failed';job.error=error.message;job.errorCode=error.code;}finally{job.finishedAt=new Date().toISOString();job.settled=true;}})();return this.get(job.id);
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
 const {finish}=await setup(t,{ids:['one'],config:{strategy:'verification',developers:['codex'],roles:{builder:'codex',auditor:'codex',challenger:'codex'}}}),state=await finish();assert.equal(state.tasks[0].status,'passed');assert.equal(state.tasks[0].audit.mode,'self');assert.equal(state.releases.at(-1).verification.reviewMode,'self-or-mixed');
});

test('browser environment failure remains unverified and does not manufacture an implementation defect',async t=>{
 const {runtime,input,finish}=await setup(t,{ids:['contract','consumer']});input.handoff.tasks[1].dependsOn=['contract'];runtime.workspace.check=async()=>[{id:'browser',label:'Browser',passed:false,exitCode:null,failureKind:'environment',output:'Browser process exited before assertions'}];
 const state=await finish();assert.equal(state.tasks.find(t=>t.id==='consumer').status,'limited');assert.ok(state.tasks.every(t=>!t.findings.some(f=>f.type==='implementation')));assert.ok(state.latestRunnableId);assert.ok(state.releases.at(-1).limitations.some(l=>l.status==='unverified'));assert.equal(state.releases.at(-1).stage,'draft');
});

test('real failed core checks cannot be turned into a runnable release by AI approval',async t=>{
 const {runtime,agents,finish}=await setup(t);runtime.workspace.check=async()=>[{id:'core',label:'Core regression',passed:false,exitCode:1,output:'Wrong calculation'}];const state=await finish();assert.equal(state.latestRunnableId,null);assert.ok(agents.calls.some(c=>c.kind==='development-build'&&c.payload.task.id==='two'));assert.ok(state.tasks.some(t=>t.isAssembly));
});

test('an unavailable reviewer uses the third independent AI before the author',async t=>{
 const {agents,finish}=await setup(t,{ids:['one'],config:{strategy:'integrated',roles:{builder:'codex',auditor:'claude',challenger:'agy'}},handler:(request)=>{if(request.kind==='development-audit'&&request.agent==='claude')throw new Error('Reviewer unavailable');}});
 const state=await finish();assert.equal(state.tasks[0].status,'passed');assert.equal(state.tasks[0].audit.mode,'independent');assert.equal(state.tasks[0].auditor,'agy');assert.ok(state.events.some(e=>e.type==='agent-handoff'));assert.equal(agents.calls.filter(c=>c.kind==='development-audit'&&c.agent==='claude').length,1);assert.ok(state.aiCalls.some(c=>c.agent==='claude'&&c.status==='failed'));assert.ok(state.latestRunnableId);
});

test('cancelling parallel development prevents queued calls from starting and settles every activity record',async t=>{
 const {runtime,agents,input}=await setup(t,{ids:['one','two','three'],config:{strategy:'integrated',developers:['codex'],roles:{builder:'codex',auditor:'codex',challenger:'codex'}}});
 await runtime.start(input);const deadline=Date.now()+5000;while(!agents.calls.length&&Date.now()<deadline)await delay(5);assert.equal(agents.calls.length,1);await runtime.cancel('parallel');await runtime.runs.get('parallel')?.done;
 const state=await runtime.get('parallel');assert.equal(state.status,'cancelled');assert.equal(agents.calls.length,1);assert.ok(state.aiCalls.length>=2);assert.ok(state.aiCalls.every(c=>c.status==='cancelled'&&c.finishedAt));assert.equal(state.activeAttemptId,null);
});

test('a newly free slot starts the next independent task while another provider is still waiting',async t=>{
 let release;const gate=new Promise(r=>{release=r;});t.after(()=>release());
 const {runtime,agents,input}=await setup(t,{ids:['one','two','three'],config:{maxParallel:2},handler:async(request,payload)=>{if(request.kind==='development-build'&&payload.task.id==='one'){await gate;return build('one');}return request.kind==='development-build'?build(payload.task.id):request.kind==='development-audit'?audit(payload):{summary:'Summary',risks:[],recommendation:'Continue'};}});
 await runtime.start(input);const deadline=Date.now()+5000;while(!agents.calls.some(c=>c.kind==='development-build'&&c.payload.task.id==='three')&&Date.now()<deadline)await delay(10);
 assert.ok(agents.calls.some(c=>c.kind==='development-build'&&c.payload.task.id==='three'),'free slot must not wait for the first task');assert.ok([...agents.jobs.values()].some(j=>j.context.taskId==='one'&&j.status==='running'));release();await runtime.runs.get('parallel')?.done;assert.equal((await runtime.get('parallel')).status,'completed');
});

test('integrated mode distributes implementation across selected developers instead of pinning every task to the primary',async t=>{
 const {agents,finish}=await setup(t,{ids:['one','two','three'],config:{strategy:'integrated'}});const state=await finish();assert.equal(state.status,'completed');const builders=new Set(agents.calls.filter(c=>c.kind==='development-build'&&!c.payload.task.isAssembly).map(c=>c.agent));assert.ok(builders.size>=2);assert.ok(agents.maxActive>=2);
});

test('a release check exception occurs after independent development and cannot skip final draft assembly',async t=>{
 const {runtime,agents,finish}=await setup(t,{ids:['one','two','three']});let checked=false;
 runtime._release=async()=>{checked=true;assert.ok(agents.calls.some(c=>c.kind==='development-build'&&c.payload.task.id==='three'));throw new Error('Checkpoint failure');};
 const state=await finish();assert.ok(checked);assert.equal(state.status,'completed');assert.ok(state.events.some(e=>e.type==='release-blocked'));assert.ok(agents.calls.some(c=>c.kind==='development-build'&&c.payload.task.id==='draft-assembly'));
});

test('deferring one active task cancels its request while independent work and the draft continue',async t=>{
 let release;const gate=new Promise(r=>{release=r;});t.after(()=>release());
 const {runtime,agents,input}=await setup(t,{ids:['one','two'],handler:async(request,payload)=>{if(request.kind==='development-build'&&payload.task.id==='one')await gate;return request.kind==='development-build'?build(payload.task.id):request.kind==='development-audit'?audit(payload):{summary:'Summary',risks:[],recommendation:'Continue'};}});
 const cancel=agents.cancel.bind(agents);agents.cancel=id=>{const result=cancel(id);release();return result;};
 await runtime.start(input);const deadline=Date.now()+5000;while(!agents.calls.some(c=>c.kind==='development-build'&&c.payload.task.id==='one')&&Date.now()<deadline)await delay(5);
 await runtime.defer('parallel',{taskId:'one'});await runtime.runs.get('parallel')?.done;const state=await runtime.get('parallel');assert.equal(state.status,'completed');assert.equal(state.tasks.find(t=>t.id==='one').status,'limited');assert.equal(state.tasks.find(t=>t.id==='two').status,'passed');assert.ok(state.tasks.some(t=>t.isAssembly));assert.match(state.tasks.find(t=>t.id==='one').error,/사용자/);
});


test('deferring final verification preserves the reason and still attempts final draft integration',async t=>{
 let release;const gate=new Promise(r=>{release=r;});t.after(()=>release());let finalWaiting=false;
 const {runtime,input}=await setup(t,{ids:['one','two'],config:{maxParallel:1}});
 const original=runtime._task.bind(runtime);runtime._task=async(state,attempt,operation,task,action)=>{
  if(task.id==='one'&&action==='verify'){finalWaiting=true;task.status='running';await new Promise((resolve,reject)=>{const stop=()=>reject(new Error('Aborted'));operation.controller.signal.addEventListener('abort',stop,{once:true});gate.then(()=>{operation.controller.signal.removeEventListener('abort',stop);resolve();});});}
  return original(state,attempt,operation,task,action);
 };
 await runtime.start(input);const deadline=Date.now()+5000;while(!finalWaiting&&Date.now()<deadline)await delay(5);assert.ok(finalWaiting);await runtime.defer('parallel',{taskId:'one'});await runtime.runs.get('parallel')?.done;
 const state=await runtime.get('parallel');assert.equal(state.status,'completed');assert.match(state.tasks.find(t=>t.id==='one').error,/사용자가 이 작업만 보류/);assert.ok(state.tasks.some(t=>t.isAssembly));assert.ok(state.latestRunnableId);
});

test('deep sibling components with integration contracts build concurrently before either finishes',async t=>{
 let release;const gate=new Promise(r=>{release=r;});t.after(()=>release());
 const {runtime,agents,input}=await setup(t,{ids:['one','two'],handler:async(request,payload)=>{if(request.kind==='development-build'){await gate;return build(payload.task.id);}return request.kind==='development-audit'?audit(payload):{summary:'Done',risks:[],recommendation:'Run'};}});
 input.baseline.snapshot.nodes.push({id:'group',title:'Nested component',nodeType:'group'},{id:'parent',title:'Subsystem',nodeType:'group'});input.baseline.snapshot.edges=[{from:'goal',to:'parent'},{from:'parent',to:'group'},{from:'group',to:'one'},{from:'group',to:'two'}];
 input.handoff.tasks[0].integrationWith=['two'];input.handoff.tasks[1].integrationWith=['one'];await runtime.start(input);
 const end=Date.now()+5000;while(agents.calls.filter(c=>c.kind==='development-build').length<2&&Date.now()<end)await delay(10);
 assert.equal(agents.calls.filter(c=>c.kind==='development-build').length,2);assert.equal([...agents.jobs.values()].filter(j=>j.status==='running').length,2);assert.deepEqual(agents.calls[0].payload.task.integrationWith,['two']);release();await runtime.runs.get('parallel')?.done;assert.equal((await runtime.get('parallel')).status,'completed');
});

test('an unrelated spec limitation does not veto a pinned usable handoff or independent consumer',async t=>{
 const {input,agents,finish}=await setup(t,{ids:['contract','consumer'],handler:(request,payload)=>request.kind==='development-audit'&&payload.task.id==='contract'?{...audit(payload),verdict:'hold',findings:[{type:'spec',severity:'medium',summary:'External API account unavailable',evidence:'Local contract works; live API credentials not provided',remedy:'Keep manual entry usable'}]}:undefined});
 input.handoff.tasks[1].dependsOn=['contract'];const state=await finish();assert.ok(agents.calls.some(c=>c.kind==='development-build'&&c.payload.task.id==='consumer'));assert.ok(state.tasks[0].findings.some(f=>f.type==='spec'));assert.equal(state.tasks[1].status,'passed');
});

test('failed assertions preserve an executable preview, rotate bounded repair builders, and map integration evidence to original nodes',async t=>{
 const {runtime,agents,finish}=await setup(t,{handler:(request,payload)=>request.kind==='development-audit'&&payload.task.id==='draft-assembly'?{...audit(payload),taskResults:[{taskId:'one',status:'implemented',summary:'Local behavior exists',evidence:'one.js export',checkIds:['invented']},{taskId:'two',status:'partial',summary:'Remote integration missing',evidence:'two.js local stub',checkIds:[]}]}:undefined});
 runtime.workspace.check=async()=>[{id:'core',label:'Core regression',passed:false,exitCode:1,output:'Wrong calculation'}];const state=await finish(),attempts=agents.calls.filter(c=>c.kind==='development-build'&&c.payload.task.id==='draft-assembly');
 assert.equal(attempts.length,3);assert.equal(new Set(attempts.map(c=>c.agent)).size,3);assert.equal(state.latestRunnableId,null);assert.ok(state.latestPreviewId);const release=state.releases.find(r=>r.id===state.latestPreviewId);assert.equal(release.stage,'preview');assert.equal(release.verification.checks[0].passed,false);
 const launched=await runtime.launch('parallel',release.id);assert.match(await(await fetch(launched.url)).text(),/READY/);assert.equal((await runtime.download('parallel',release.id)).subarray(0,2).toString(),'PK');
 assert.equal(state.tasks[0].status,'failed');assert.equal(state.tasks[0].integration.verified,false,'invented check IDs cannot substantiate runtime success');assert.equal(state.tasks[1].integration.status,'partial');assert.ok(state.tasks.every(t=>t.phase!=='분석 중'));
});

test('startup failure reaches the next repair AI with previous code and is fixed within the bounded attempts',async t=>{
 const {runtime,agents,finish}=await setup(t,{ids:['one'],handler:(request,payload)=>request.kind==='development-build'&&payload.task.id==='draft-assembly'?build('draft-assembly',[{path:'index.html',action:'write',content:payload.findings.some(f=>f.evidence.includes('fixture startup defect'))?'<main>READY repaired</main>':'<main>READY</main>'}]):undefined});
 const launch=runtime.workspace.launch.bind(runtime.workspace);runtime.workspace.launch=async(p,...args)=>{if(!(await readFile(path.join(p,'index.html'),'utf8')).includes('repaired'))throw Object.assign(new Error('fixture startup defect'),{safe:true});return launch(p,...args);};
 const state=await finish();assert.ok(state.latestRunnableId,JSON.stringify({events:state.events.filter(e=>e.type==='release-blocked'),tasks:state.tasks.map(t=>({id:t.id,error:t.error,findings:t.findings})),calls:agents.calls.filter(c=>c.kind==='development-build').map(c=>({id:c.payload.task.id,findings:c.payload.findings}))}));const assemblyCalls=agents.calls.filter(c=>c.kind==='development-build'&&c.payload.task.id==='draft-assembly');assert.equal(assemblyCalls.length,1,'first recovery must receive the initial failed startup');assert.ok(assemblyCalls[0].payload.findings.some(f=>f.evidence.includes('fixture startup defect')));
});

test('explicit deferral of draft assembly does not restart it with another provider',async t=>{
 let release;const gate=new Promise(r=>{release=r;});t.after(()=>release());
 const {runtime,agents,input}=await setup(t,{ids:['one'],handler:async(request,payload)=>{if(request.kind==='development-build'&&payload.task.id==='draft-assembly')await gate;return request.kind==='development-build'?build(payload.task.id):request.kind==='development-audit'?audit(payload):{summary:'Done',risks:[],recommendation:'Run'};}});
 runtime.workspace.check=async()=>[{id:'core',label:'Core',passed:false,exitCode:1,output:'Failed'}];const cancel=agents.cancel.bind(agents);agents.cancel=id=>{const result=cancel(id);release();return result;};await runtime.start(input);const end=Date.now()+6000;while(!agents.calls.some(c=>c.kind==='development-build'&&c.payload.task.id==='draft-assembly')&&Date.now()<end)await delay(10);
 await runtime.defer('parallel',{taskId:'draft-assembly'});await runtime.runs.get('parallel')?.done;assert.equal(agents.calls.filter(c=>c.kind==='development-build'&&c.payload.task.id==='draft-assembly').length,1);assert.equal((await runtime.get('parallel')).status,'completed');
});

test('HTTP startup alone preserves a draft but does not end the remaining functional recovery attempts',async t=>{
 const {runtime,agents,finish}=await setup(t,{ids:['one'],handler:(request,payload)=>request.kind==='development-audit'?{...audit(payload),verdict:'hold',unverifiedCriteria:['No functional runtime evidence']}:undefined});runtime.workspace.check=async()=>[];
 const state=await finish();assert.ok(state.latestPreviewId);assert.equal(state.releases.at(-1).stage,'draft');assert.equal(agents.calls.filter(c=>c.kind==='development-build'&&c.payload.task.id==='draft-assembly').length,3);assert.equal(state.releases.at(-1).verification.audit,'incomplete');
});


test('quota handoff resumes the audit stage without rebuilding and persists the error category',async t=>{
 const {agents,finish}=await setup(t,{ids:['one'],handler:(request,payload)=>{if(request.kind==='development-audit'&&request.agent==='claude')throw Object.assign(new Error('Quota exhausted'),{code:'QUOTA_LIMIT'});}});
 const state=await finish();assert.equal(agents.calls.filter(c=>c.kind==='development-build').length,1);assert.equal(state.tasks[0].reviewMode,'independent');assert.equal(state.tasks[0].auditor,'agy');assert.ok(state.aiCalls.some(c=>c.errorCode==='QUOTA_LIMIT'));assert.ok(state.latestRunnableId);
});

test('failed builder hands current request to available lead and skips that provider for the remaining attempt',async t=>{
 const {agents,input,finish}=await setup(t,{ids:['one'],handler:(request)=>{if(request.agent==='claude')throw Object.assign(new Error('Quota'),{code:'QUOTA_LIMIT'});}});input.handoff.tasks[0].agent='claude';
 const state=await finish();const builds=agents.calls.filter(c=>c.kind==='development-build');assert.deepEqual(builds.map(c=>c.agent),['claude','codex']);assert.equal(state.tasks[0].builder,'codex');assert.equal(state.attempts[0].unavailable.claude.code,'QUOTA_LIMIT');assert.ok(state.latestRunnableId);
});

test('automatic handoff can be disabled and does not turn a cancellation into a new request',async t=>{
 const {agents,finish}=await setup(t,{ids:['one'],config:{autoFailover:false,draftAttempts:1},handler:request=>{if(request.kind==='development-build')throw Object.assign(new Error('Quota'),{code:'QUOTA_LIMIT'});}});
 const state=await finish();assert.equal(agents.calls.filter(c=>c.kind==='development-build'&&c.payload.task.id==='one').length,1);assert.equal(state.events.filter(e=>e.type==='agent-handoff').length,0);
});

test('unavailable providers are attempted at most once per request, then independent work ends truthfully',async t=>{
 const {agents,finish}=await setup(t,{ids:['one'],handler:()=>{throw Object.assign(new Error('Offline'),{code:'AGENT_REQUEST_FAILED'});}});const state=await finish();
 assert.ok(agents.calls.length<=3);assert.equal(state.tasks[0].status,'limited');assert.equal(state.tasks[0].artifactSha,null);assert.equal(state.sourceAvailable,false);
});

test('startup repair receives actual failure and adopts a generated launch manifest on the next assembly',async t=>{
 const {agents,finish,runtime,source}=await setup(t,{ids:['one'],config:{checks:[],draftAttempts:2},handler:(request,payload)=>{
  if(request.kind==='development-build')return build(payload.task.id,payload.task.id==='draft-assembly'?[{path:'web.html',action:'write',content:'<main><button id="work">Run</button><output>Ready</output><script>document.querySelector("button").onclick=()=>document.querySelector("output").textContent="Works"</script></main>'},{path:'agent-desk.launch.json',action:'write',content:JSON.stringify({kind:'static',entry:'web.html'})}]:[{path:'service.js',action:'write',content:'export const calculate=n=>n*2;'}]);
 }});await rm(path.join(source,'index.html'));const state=await finish();
 const repair=agents.calls.find(c=>c.kind==='development-build'&&c.payload.task.id==='draft-assembly');assert.ok(repair.payload.previousStartupFailure);assert.ok(state.latestPreviewId);const release=state.releases.find(r=>r.id===state.latestPreviewId);assert.equal(release.launch.entry,'web.html');const running=await runtime.launch('parallel',release.id);assert.match(await(await fetch(running.url)).text(),/Works/);
});

test('exhausted startup repair still provides source and failure evidence without a runnable label',async t=>{
 const {runtime,source,finish}=await setup(t,{ids:['one'],config:{checks:[],draftAttempts:1}});await rm(path.join(source,'index.html'));const state=await finish();assert.equal(state.latestPreviewId,null);assert.equal(state.sourceAvailable,true);assert.ok(state.lastPreviewFailure);
 const archive=await runtime.downloadSource('parallel');assert.equal(archive.readUInt32LE(0),0x04034b50);assert.ok(archive.includes(Buffer.from('one.js')));assert.ok(archive.includes(Buffer.from('_agent_desk_records.json')));assert.equal(archive.includes(Buffer.from('start-agent-desk-windows.cmd')),false);
});

test('handoff uses an available provider when the preferred lead is busy, and keeps cancellation final',async t=>{
 const {runtime,agents,input}=await setup(t,{ids:['one'],handler:(request,payload)=>{if(request.agent==='agy')throw Object.assign(new Error('Timed out'),{code:'AGENT_TIMEOUT'});}});
 const state=await runtime._load('parallel'),attempt={id:'direct',input:{...input,agentSettings:{}},roles:input.config.roles},operation={controller:new AbortController(),jobs:new Set()},task={id:'one',builder:'agy',authors:[],status:'running'};
 runtime.providerQueues.set('codex',new Promise(()=>{}));try{await runtime._ai(state,attempt,operation,'agy','development-build',{role:'Builder',task:{id:'one'}},task);}finally{runtime.providerQueues.delete('codex');}
 assert.deepEqual(agents.calls.map(c=>c.agent),['agy','claude']);assert.equal(task.builder,'claude');assert.equal(state.aiCalls[0].errorCode,'AGENT_TIMEOUT');
 operation.controller.abort();await assert.rejects(runtime._ai(state,attempt,operation,'codex','development-build',{role:'Builder',task:{id:'one'}},task),{name:'AbortError'});assert.equal(agents.calls.length,2);
});

test('self review is the final fallback only after both independent providers fail',async t=>{
 const {finish}=await setup(t,{ids:['one'],handler:request=>{if(request.kind==='development-audit'&&request.agent!=='codex')throw Object.assign(new Error('quota'),{code:'QUOTA_LIMIT'});}});const state=await finish();assert.equal(state.tasks[0].reviewMode,'self');assert.equal(state.tasks[0].audit.agent,'codex');assert.equal(state.aiCalls.filter(c=>c.kind==='development-audit'&&c.status==='failed').length,2);assert.ok(state.events.some(e=>e.type==='self-review'));
});
