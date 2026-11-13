import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {DevelopmentRunner} from '../scripts/development-runner.mjs';
import {defaultDevelopment} from '../public/development-core.js';

const issue=(overrides={})=>({type:'implementation',severity:'medium',summary:'Saved export is incomplete',evidence:'The export action returns no file.',remedy:'Implement the export.',...overrides});
const analysis=()=>({summary:'Fixture integration summary',risks:[],recommendation:'Inspect recorded evidence.'});
const audit=(overrides={})=>({summary:'Pinned fixture inspected',verdict:'pass',verifiedCriteria:[{criterion:'Page exists',evidence:'Host file check passed against the pinned SHA.'}],unverifiedCriteria:[],previousFindings:[],findings:[],...overrides});
const build=(content='<main data-ready>Working page</main>')=>({summary:'Created working page',files:[{path:'index.html',action:'write',content}],limitations:[]});

class FixtureAgents{
  constructor(handler){this.jobs=new Map();this.calls=[];this.handler=handler;}
  create(input){
    const job={id:randomUUID(),status:'running'},call={...input,payload:JSON.parse(input.prompt)};
    this.calls.push(call);this.jobs.set(job.id,job);
    job.done=Promise.resolve().then(()=>this.handler(call,this.calls)).then(result=>{if(job.status!=='cancelled'){job.result=result;job.status='succeeded';}},error=>{job.status='failed';job.error=error.message;});
    return {id:job.id,status:job.status};
  }
  get(id){const {done,...job}=this.jobs.get(id);return job;}
  cancel(id){const job=this.jobs.get(id);if(job)job.status='cancelled';return job;}
}

async function fixture(t,handler){
  const root=await mkdtemp(path.join(os.tmpdir(),'development-review-')),source=path.join(root,'source');await mkdir(source);
  const agents=new FixtureAgents(handler??(call=>call.kind==='development-build'?build():call.kind==='development-audit'?audit():analysis()));
  const runner=new DevelopmentRunner({agentRunner:agents,dataRoot:path.join(root,'state'),pollMs:1});
  t.after(async()=>{await runner.close();await rm(root,{recursive:true,force:true});});
  const config={...defaultDevelopment(),strategy:'assignment',limits:{maxRevisions:0,maxReviews:1,maxSwitches:0},checks:[{id:'page-check',label:'Generated page check',command:'node',args:['--input-type=module','-e',"import {readFileSync} from 'node:fs'; if(!readFileSync('index.html','utf8').includes('data-ready')) process.exit(1);"]}]};
  const node=(id,title)=>({id,title,description:'',instructions:'Implement the page.',criteria:'Page exists'});
  const baseline={id:'baseline-1',number:1,snapshot:{project:{name:'Review fixture',description:'Review test',instructions:''},rootId:'goal',nodes:[node('goal','Working page'),node('page','Page')],edges:[{from:'goal',to:'page'}],items:[{id:'currency',nodeIds:['page'],type:'question',question:'Which currency?',status:'done',answer:'KRW',evidence:'User selection',blocking:false,deferred:false,deferReason:'',relatedIds:[]}]}};
  const handoff={baselineId:'baseline-1',tasks:[{nodeId:'page',agent:'codex',dependsOn:[],instructions:'Implement the selected page.',deliverable:'Page files',criteria:'Page exists'}]};
  const input={requestId:randomUUID(),project:{id:'review-project',name:'Review fixture',path:source,instructions:''},baseline,handoff,config,agentSettings:{}};
  return {runner,agents,input};
}
async function finish(runner,input){await runner.start(input);await runner.runs.get(input.project.id)?.done;return runner.get(input.project.id);}

test('real generated files, host checks, independent audit and runnable snapshot refer to one exact SHA',async t=>{
  const {runner,agents,input}=await fixture(t);
  const state=await finish(runner,input);
  assert.equal(state.status,'completed',state.error);assert.equal(state.tasks[0].status,'passed',state.tasks[0].error);
  const release=state.releases.find(r=>r.id===state.latestRunnableId);assert.ok(release,'a successful real startup must produce a release');
  assert.match(release.codeSha,/^[a-f0-9]{40}$/);assert.equal(release.codeSha,state.tasks[0].audit.codeSha);
  assert.equal(state.tasks[0].checks[0].codeSha,release.codeSha);assert.equal(state.tasks[0].checks[0].passed,true);
  assert.equal(release.verification.audit,'pass');
  for(const call of agents.calls.filter(c=>['development-build','development-audit'].includes(c.kind)))assert.equal(call.payload.baseline.snapshot.items[0].answer,'KRW','saved planning decisions must reach both roles');
  const launch=await runner.launch(input.project.id,release.id);assert.match(await (await fetch(launch.url)).text(),/data-ready/);
});

test('changing a saved decision invalidates the affected completed task even when handoff text is unchanged',async t=>{
  const {runner,agents,input}=await fixture(t);
  const first=await finish(runner,input);assert.equal(first.tasks[0].status,'passed');
  const changed=structuredClone(input);changed.requestId=randomUUID();changed.retry=true;changed.baseline.id='baseline-2';changed.baseline.number=2;changed.handoff.baselineId='baseline-2';changed.baseline.snapshot.items[0].answer='USD';
  const preview=await runner.preview(changed);assert.ok(['build','verify'].includes(preview.entries[0].action),'changed confirmed decisions cannot retain an old pass without work');
  await finish(runner,changed);
  assert.ok(agents.calls.some(call=>call.kind==='development-audit'&&call.payload.baseline.snapshot.items[0].answer==='USD'));
});

test('adopting a default releases dependent work after the prerequisite passes without bypassing its audit',async t=>{
  const {runner,agents,input}=await fixture(t,call=>{
    if(call.kind==='development-build')return call.payload.task.id==='dependent'?{summary:'Dependent feature',files:[{path:'dependent.txt',action:'write',content:'Uses the adopted currency'}],limitations:[]}:build();
    if(call.kind!=='development-audit')return analysis();
    if(call.payload.task.id==='page'&&!call.payload.baseline.snapshot.items[0].answer)return audit({verdict:'hold',findings:[issue({type:'spec',summary:'Currency is undecided'})]});
    return audit({previousFindings:call.payload.previousFindings.map(f=>({id:f.id,status:'resolved',evidence:'The new baseline supplies the adopted currency; the host check passes.'}))});
  });
  input.config.limits.maxReviews=3;
  Object.assign(input.baseline.snapshot.items[0],{status:'answer',answer:'',evidence:''});
  input.baseline.snapshot.nodes.push({id:'dependent',title:'Dependent feature',description:'',instructions:'Use the page currency.',criteria:'Output exists'});
  input.baseline.snapshot.edges.push({from:'goal',to:'dependent'});
  input.handoff.tasks.push({nodeId:'dependent',agent:'codex',dependsOn:['page'],instructions:'Use the page currency.',deliverable:'Dependent file',criteria:'Output exists'});
  const first=await finish(runner,input);
  assert.equal(first.tasks.find(t=>t.id==='page').status,'limited');assert.equal(first.tasks.find(t=>t.id==='dependent').status,'blocked');
  assert.equal(agents.calls.some(c=>c.kind==='development-build'&&c.payload.task.id==='dependent'),false);
  const changed=structuredClone(input);changed.requestId=randomUUID();changed.retry=true;changed.baseline.id='baseline-2';changed.baseline.number=2;changed.handoff.baselineId='baseline-2';
  Object.assign(changed.baseline.snapshot.items[0],{status:'done',answer:'KRW',resolution:{kind:'assumption',agent:'codex',reason:'Project default',messageIds:[],at:new Date().toISOString()}});
  const preview=await runner.preview(changed);assert.deepEqual(preview.entries.map(e=>e.action),['build','build']);
  const selected=await runner.preview({...changed,selection:{taskIds:['page']}});assert.equal(selected.entries.find(e=>e.taskId==='dependent').action,'keep');
  const second=await finish(runner,changed);assert.ok(second.tasks.every(t=>t.status==='passed'),JSON.stringify(second.tasks.map(t=>({id:t.id,status:t.status,error:t.error}))));
  assert.ok(agents.calls.some(c=>c.kind==='development-build'&&c.payload.task.id==='dependent'));
});

test('omitting an old finding from a later audit never silently resolves it',async t=>{
  let audits=0;
  const {runner,input}=await fixture(t,call=>call.kind==='development-build'?build():call.kind==='development-audit'?(++audits===1?audit({verdict:'fail',findings:[issue()]}):audit()):analysis());
  const first=await finish(runner,input),findingId=first.tasks[0].findings[0].id;
  const second=await finish(runner,{...input,requestId:randomUUID(),retry:true});
  assert.equal(second.tasks[0].findings.find(f=>f.id===findingId)?.status,'open');
  assert.notEqual(second.tasks[0].status,'passed','an incomplete report cannot erase a confirmed outstanding error');
});

test('optional open and accepted limitations remain in release metadata and downloaded package',async t=>{
  const limitation=issue({type:'limitation',severity:'low',summary:'CSV export remains unavailable',evidence:'The optional export is deferred.'});
  const {runner,input}=await fixture(t,call=>call.kind==='development-build'?build():call.kind==='development-audit'?audit({findings:[limitation]}):analysis());
  const first=await finish(runner,input),finding=first.tasks[0].findings[0];
  assert.equal(first.tasks[0].status,'passed');
  const release=first.releases.find(r=>r.id===first.latestRunnableId);
  assert.match(JSON.stringify(release.limitations),/CSV export remains unavailable/,'pass must not hide known optional limits');
  await runner.accept(input.project.id,{taskId:'page',findingId:finding.id,reason:'Retain the core page for this version.'});
  const second=await finish(runner,{...input,requestId:randomUUID(),retry:true});
  const accepted=second.releases.find(r=>r.id===second.latestRunnableId);
  assert.match(JSON.stringify(accepted.limitations),/CSV export remains unavailable/);
  assert.match(JSON.stringify(accepted.limitations),/Retain the core page/);
  assert.match((await runner.download(input.project.id,accepted.id)).toString('utf8'),/CSV export remains unavailable/);
});

test('redacting audit evidence preserves a valid report and the original secret never enters public records',async t=>{
  const {runner,input}=await fixture(t,call=>call.kind==='development-build'?build():call.kind==='development-audit'?audit({verifiedCriteria:[{criterion:'Page exists',evidence:'Host output token=fixture_private_secret confirms the fixture.'}]}):analysis());
  const state=await finish(runner,input);
  assert.equal(state.tasks[0].status,'passed',state.tasks[0].error);
  assert.ok(state.attempts[0].records.some(record=>record.type==='audit'));
  assert.ok(!JSON.stringify(state).includes('fixture_private_secret'));
});

test('a later shared-file author can re-audit with truthful self-review provenance',async t=>{
  const {runner,agents,input}=await fixture(t,call=>call.kind==='development-build'?build(`<main data-ready>${call.payload.task.id}</main>`):call.kind==='development-audit'?audit():analysis());
  input.config.limits.maxReviews=3;
  input.baseline.snapshot.nodes.push({id:'shared',title:'Shared update',description:'',instructions:'Extend the page.',criteria:'Page exists'});
  input.baseline.snapshot.edges.push({from:'goal',to:'shared'});
  input.handoff.tasks.push({nodeId:'shared',agent:'claude',dependsOn:[],instructions:'Extend the page.',deliverable:'Updated page',criteria:'Page exists'});
  const state=await finish(runner,input);
  const firstTask=state.tasks.find(task=>task.id==='page');
  assert.equal(firstTask.status,'passed');
  assert.equal(firstTask.audit.mode,'self');
  assert.ok(agents.calls.filter(call=>call.kind==='development-audit'&&call.payload.task.id==='page').length>=2);

});

test('a mutating release check cannot contaminate canonical source or block independent development',async t=>{
  const {runner,input}=await fixture(t,call=>call.kind==='development-build'?(call.payload.task.id==='extra'?{summary:'Independent feature',files:[{path:'extra.txt',action:'write',content:'Extra feature'}],limitations:[]}:build()):call.kind==='development-audit'?audit():analysis());
  input.config.limits.maxReviews=3;
  input.baseline.snapshot.nodes.push({id:'extra',title:'Independent feature',description:'',instructions:'Add separate output.',criteria:'Output exists'});
  input.baseline.snapshot.edges.push({from:'goal',to:'extra'});
  input.handoff.tasks.push({nodeId:'extra',agent:'codex',dependsOn:[],instructions:'Add separate output.',deliverable:'Separate file',criteria:'Output exists'});
  input.config.maxParallel=1; // Preserve this test's intentionally ordered second-check corruption.
  const counter=path.join(path.dirname(input.project.path),'fixture-check-counter');
  input.config.checks[0].args=['--input-type=module','-e',`import {existsSync,readFileSync,writeFileSync} from 'node:fs'; const file=${JSON.stringify(counter)}; const count=existsSync(file)?Number(readFileSync(file,'utf8')):0; writeFileSync(file,String(count+1)); if(count===1)writeFileSync('index.html','BROKEN BY CHECK'); if(!readFileSync('index.html','utf8').includes('data-ready'))process.exit(1);`];
  const state=await finish(runner,input);
  assert.equal(state.tasks.find(task=>task.id==='extra').status,'passed','a dirty disposable check copy must not prevent later independent work');
  const release=state.releases.find(item=>item.id===state.latestRunnableId);assert.ok(release);
  const {url}=await runner.launch(input.project.id,release.id);assert.match(await (await fetch(url)).text(),/data-ready/);
});
