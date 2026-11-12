import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {AgentRunner,executionError} from '../scripts/agent-runner.mjs';
import {getCatalog,normalizeCatalog} from '../scripts/agent-catalog.mjs';
import {runProcess,readClaudeModels} from '../scripts/agent-process.mjs';
import {settingsIssue,supportedEfforts} from '../public/agent-settings.js';
import {RunnerClient} from '../public/agent-client.js';
const fixture=fileURLToPath(new URL('./fixtures/agent-cli.mjs',import.meta.url));
const resolve=async agent=>({command:process.execPath,prefix:[fixture,agent]});
const complete=async(r,agent,settings={},kind='probe',prompt='연결 확인 요청')=>{const job=r.create({agent,settings,kind,prompt,requestId:crypto.randomUUID()});await r.jobs.get(job.id).done;return r.get(job.id);};

test('AGY lists only published effort variants, respects fixed budgets and never guesses Max for unknown/default models',()=>{
 const catalog={models:normalizeCatalog('agy',{models:[{slug:'gemini-a-low',label:'Gemini A (Low)'},{slug:'gemini-a-high',label:'Gemini A (High)'},{id:'fixed',supportsEffort:false},{id:'unknown'},{id:'listed',supported_efforts:[]}]})};
 assert.deepEqual(supportedEfforts('agy',{model:'gemini-a-high'},catalog),['low','high']);
 for(const model of ['fixed','unknown','listed',''])assert.deepEqual(supportedEfforts('agy',{model},catalog),[]);
 assert.match(settingsIssue('agy',{model:'gemini-a-high',effort:'max'},catalog),/Max/);
 assert.equal(settingsIssue('agy',{model:'unknown',effort:''},catalog),'');
});

test('official Claude initialize model metadata is read without sending a user message, and fixed/no metadata stays default-only',async()=>{
 const raw=await readClaudeModels(await resolve('claude'));assert.equal(raw[1].value,'opus');
 const catalog=await getCatalog('claude',{resolve});assert.equal(catalog.source,'cli');assert.equal(catalog.defaultModel,'default');
 assert.deepEqual(supportedEfforts('claude',{model:'opus'},catalog),['low','medium','high']);
 assert.deepEqual(supportedEfforts('claude',{},catalog),['low','medium','high']);
 assert.deepEqual(supportedEfforts('claude',{model:'haiku'},catalog),[]);
});

test('AGY JSON and documented tab-separated fallback preserve exact executable model IDs',async()=>{
 const catalog=await getCatalog('agy',{resolve});assert.ok(catalog.models.some(m=>m.id==='gemini-test-high'));assert.equal(catalog.defaultModel,'fixture-agy');
 const calls=[];const fallback=await getCatalog('agy',{resolve,run:async(exe,args)=>{calls.push(args);return args.length>1?{code:1,stdout:'',stderr:'unknown flag'}:{code:0,stdout:'gemini-a-high\tGemini A (High)\ngemini-a-low\tGemini A (Low)\nprogress not a model\n'};}});
 assert.equal(calls.length,2);assert.deepEqual(fallback.models.map(m=>m.id),['gemini-a-high','gemini-a-low']);
 assert.deepEqual(fallback.models[0].efforts,['low','high']);
});

test('runner rejects unsupported Claude/AGY Max before a model turn while retaining the successful default connection',async t=>{
 let turns=0;const r=new AgentRunner({resolve,run:(exe,args,opts)=>{if(args.includes('--json-schema'))turns++;return runProcess(exe,args,opts);}});t.after(()=>r.close());
 for(const agent of ['claude','agy']){
  assert.equal((await complete(r,agent)).status,'succeeded');
  const failed=await complete(r,agent,{model:agent==='claude'?'opus':'gemini-test',effort:'max'});
  assert.equal(failed.status,'failed');assert.equal(failed.errorCode,'MODEL_SETTINGS_UNSUPPORTED');
  const state=(await r.status()).find(a=>a.id===agent);assert.ok(state.verified);assert.deepEqual(state.verifiedSettings,{model:'',effort:''});
  assert.equal(r.usage().agents[agent].requests,1);
 }
 assert.equal(turns,2);
});

test('provider rejection in a successful exit envelope disables only that model/effort and keeps normal settings usable',async t=>{
 let turns=0;const r=new AgentRunner({resolve,catalog:async()=>({models:[{id:'opus',efforts:['high','max']}]}),run:(exe,args,opts)=>{
  if(args.includes('--json-schema')){turns++;if(args.includes('max'))return Promise.resolve({code:0,stderr:'',stdout:JSON.stringify({is_error:true,result:'unsupported effort max for this model; secret-token-MUST-NOT-LEAK'})});}
  return runProcess(exe,args,opts);
 }});t.after(()=>r.close());
 assert.equal((await complete(r,'claude')).status,'succeeded');
 const failed=await complete(r,'claude',{model:'opus',effort:'max'});assert.equal(failed.errorCode,'EFFORT_UNSUPPORTED');assert.ok(!failed.error.includes('MUST-NOT-LEAK'));
 assert.ok((await r.status()).find(a=>a.id==='claude').verified);
 assert.deepEqual(supportedEfforts('claude',{model:'opus'},r.catalogView('claude')),['high']);
 await complete(r,'claude',{model:'opus',effort:'max'});assert.equal(turns,2);
 assert.equal((await complete(r,'claude',{model:'opus',effort:'high'})).status,'succeeded');assert.equal(turns,3);
});

test('capability read failure does not prevent default requests, no automatic paid fallback occurs',async t=>{
 let turns=0;const r=new AgentRunner({resolve,catalog:async()=>{throw new Error('offline');},run:(exe,args,opts)=>{if(args.includes('--json-schema'))turns++;return runProcess(exe,args,opts);}});t.after(()=>r.close());
 const failed=await complete(r,'agy',{model:'gemini-a-high',effort:'high'});assert.equal(failed.errorCode,'MODEL_CAPABILITIES_UNAVAILABLE');assert.equal(turns,0);
 assert.equal((await complete(r,'agy')).status,'succeeded');assert.equal(turns,1);
 assert.equal(executionError('quota 429 effort max').code,'QUOTA_LIMIT');assert.equal(executionError('model has no "max" effort (available: low, medium, high)').code,'EFFORT_UNSUPPORTED');
});

test('client blocks stale saved Max, clears catalog on PC changes, and discovers capabilities after a successful default probe',async()=>{
 const saved={getItem:()=>JSON.stringify({agy:{model:'',effort:'max'}}),setItem:()=>{}},paths=[],catalog={models:[{id:'model',efforts:['high'],isDefault:true}]};
 const client=new RunnerClient({preferences:saved,storage:null,fetcher:async(url)=>{paths.push(url);return {ok:true,json:async()=>url.includes('/models/')?catalog:url.includes('/jobs/')?{id:'job',agent:'agy',kind:'probe',status:'succeeded'}:{agents:[],features:{modelCapabilities:true},catalogs:{agy:catalog}}};}});
 client.runnerInfo={features:{modelCapabilities:true}};client.catalogs.agy=catalog;
 await assert.rejects(client.start('agy','prompt'),/Max/);assert.equal(paths.length,0);
 client.saveSettings('agy',{model:'',effort:''});await client.poll('job');assert.ok(paths.some(p=>p.endsWith('/models/agy')));
 client.disconnect();assert.deepEqual(client.catalogs,{});assert.equal(client.usage,null);
});

test('Claude catalog cancellation and timeout terminate the metadata process',async()=>{
 const executable={command:process.execPath,prefix:['-e','setInterval(()=>{},1000)','--']};
 await assert.rejects(readClaudeModels(executable,{timeout:50}),/초과/);
 const controller=new AbortController();const work=readClaudeModels(executable,{signal:controller.signal});setTimeout(()=>controller.abort(),30);await assert.rejects(work,/취소/);
});
