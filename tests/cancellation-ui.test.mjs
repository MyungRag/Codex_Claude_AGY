import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {createAppServer} from '../scripts/server.mjs';
import {AgentRunner} from '../scripts/agent-runner.mjs';
import {runProcess} from '../scripts/agent-process.mjs';
import {createPlan,addNode} from '../public/planning-model.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const until=async check=>{for(let n=0;n<300;n++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Cancellation did not reach the expected state');};

test('every AI dialog cancels submitted requests with delayed or lost job responses and can close promptly',async t=>{
 const fixture=fileURLToPath(new URL('./fixtures/agent-cli.mjs',import.meta.url));
 const service=new AgentRunner({resolve:async agent=>({command:process.execPath,prefix:[fixture,agent]}),run:(exe,args,opts)=>runProcess(exe,args,{...opts,input:args.includes('--help')||args.includes('--version')?opts.input:'fixture:hang'})});
 const server=createAppServer({agentRunner:service});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port,nativeFetch=globalThis.fetch;
 t.after(async()=>{await service.close();await new Promise(r=>server.close(r));});
 for(const mode of ['delayed','lost'])for(const kind of ['probe','review','questions','organize'])await t.test(kind+' '+mode,async t=>{
  const {window}=new JSDOM('<body></body>',{url:base});
  for(const key of ['window','document','localStorage','sessionStorage','location','FormData'])globalThis[key]=key==='window'?window:window[key];
  window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
  const {runner}=await import('../public/agent-client.js?v=0.9.4');
  runner.disconnect();runner.settings={};runner.storage=sessionStorage;runner.preferences=localStorage;
  const delivered=deferred(),release=deferred();let postJob,requestId,cancels=0;
  runner.fetcher=async(url,opts)=>{
   const response=await nativeFetch(url,opts);
   if(url.endsWith('/api/agents/jobs')&&opts.method==='POST'){
    requestId=JSON.parse(opts.body).requestId;postJob=await response.clone().json();delivered.resolve();if(mode==='lost')throw new Error('POST response was lost after creating the job');await release.promise;
   }
   if(url.includes('/api/agents/requests/')&&url.endsWith('/cancel'))cancels++;
   return response;
  };
  t.after(async()=>{release.resolve();if(postJob?.id){service.cancel(postJob.id);await service.jobs.get(postJob.id).done;}window.close();});
  const project={id:'cancel-'+kind,name:'취소 확인',description:'전송 중 취소',instructions:''},plan=createPlan(project),work=addNode(plan,plan.rootId,{title:'작업',instructions:'작업한다',criteria:'완료 기준'});
  const {openConnections,openAgentReview}=await import('../public/agent-ui.js?v=0.9.4');
  const {openDecisionAI}=await import('../public/decision-ai-ui.js?v=0.9.4');
  const {openOrganizer}=await import('../public/organize-ui.js?v=0.9.4');
  const options={project,plan,onApply:()=>assert.fail('Cancelled response cannot be applied'),onClose(){}};
  if(kind==='probe')await openConnections();
  if(kind==='review')await openAgentReview(options);
  if(kind==='questions')await openDecisionAI({...options,kind,nodeIds:[work.id],prompt:'검토 요청'});
  if(kind==='organize')await openOrganizer({...options,selectedIds:[work.id]});
  const $=s=>document.querySelector(s);
  if(kind==='probe')$('[data-ac="probe"][data-agent="codex"]').click();
  else{
   for(const input of document.querySelectorAll('[name="agents"]'))input.checked=input.value==='codex';
   const form=$('form');form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  }
  await delivered.promise;
  const cancelSelector=kind==='probe'?'[data-ac="cancel-probe"]':kind==='review'?'[data-ac="cancel"]':'[data-lr="cancel"]';
  const closeSelector=['questions','organize'].includes(kind)?'[data-lr="close"]':'[data-ac="close"]';
  await until(()=>$(cancelSelector));assert.equal($(cancelSelector).disabled,false,'cancel must be enabled before the POST response arrives');
  if(mode==='lost'){await until(()=>document.body.textContent.includes('PC 실행기'));assert.equal($(closeSelector).disabled,true,'unknown request must not be silently abandoned');assert.ok(!document.querySelector('[data-ac="reset"],[data-dai="reset"],[data-org="reset"],[data-lr="reset"]')||document.querySelector('[data-lr="reset"]')?.disabled);}
  $(cancelSelector).click();
  await until(()=>service.get(postJob.id)?.status==='cancelled'&&$(closeSelector)&&!$(closeSelector).disabled);
  assert.ok(cancels>0);assert.match(requestId,/^[\w-]{8,80}$/);
  $(closeSelector).click();assert.equal($('.agent-dialog'),null,'closing must not wait for the delayed POST response');
  release.resolve();await service.jobs.get(postJob.id).done;
  assert.equal(service.get(postJob.id).status,'cancelled');
 });
});

test('cancelling while model metadata is loading prevents dispatch and stale polls cannot resurrect a cancelled job',async()=>{
 const {RunnerClient}=await import('../public/agent-client.js?v=0.9.4');
 const client=new RunnerClient({storage:null,preferences:null});client.base='http://127.0.0.1:4173';client.token='a'.repeat(64);client.runnerInfo={features:{unlimitedWait:true,requestCancellation:true,modelCapabilities:true}};
 const metadata=deferred();let posts=0;
 client.models=async()=>{await metadata.promise;return {};};
 client.request=async(path)=>{if(path.endsWith('/cancel'))return {status:'cancelled'};posts++;throw new Error('Cancelled preparation must not dispatch');};
 const job={agent:'codex',status:'running',requestId:crypto.randomUUID()};
 const starting=client.startPending(job,'prompt','review',{model:'test',effort:'high'});
 await client.cancelPending(job);assert.equal((await starting).status,'cancelled');metadata.resolve();await new Promise(r=>setTimeout(r,0));assert.equal(posts,0);
 const polling=deferred(),running={agent:'codex',id:'job-id',status:'running',requestId:crypto.randomUUID()};let updates=0;
 client.request=async path=>path.endsWith('/cancel')?{status:'cancelled',id:running.id}:polling.promise;
 const watching=client.pollPending(running,()=>{updates++;});await client.cancelPending(running);assert.equal((await watching).status,'cancelled');
 polling.resolve({id:running.id,status:'running'});await new Promise(r=>setTimeout(r,0));assert.equal(running.status,'cancelled');assert.equal(updates,0);
});
