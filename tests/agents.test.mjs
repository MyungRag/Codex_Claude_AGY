import {request as httpRequest} from 'node:http';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {AgentRunner,invocation,parseResponse} from '../scripts/agent-runner.mjs';
import {runProcess,resolveAgent} from '../scripts/agent-process.mjs';
import {createAppServer} from '../scripts/server.mjs';
import {DASHBOARD_ORIGIN} from '../scripts/agent-api.mjs';
const fixture=fileURLToPath(new URL('./fixtures/agent-cli.mjs',import.meta.url));
const resolve=async agent=>({command:process.execPath,prefix:[fixture,agent]});
const make=()=>new AgentRunner({resolve});
const send=(runner,agent,prompt='기획 요청',requestId=crypto.randomUUID())=>runner.create({agent,prompt,requestId});
async function completed(runner,job){await runner.jobs.get(job.id).done;return runner.get(job.id);}

test('three official CLI adapters exchange real process stdin/output, validate graphs and isolate working directories',async()=>{
 const runner=make();const statuses=await runner.status();assert.ok(statuses.every(s=>s.available&&!s.verified));
 const jobs=['codex','claude','agy'].map(a=>send(runner,a));const done=await Promise.all(jobs.map(j=>completed(runner,j)));assert.ok(done.every(j=>j.status==='succeeded'));assert.equal(done[2].result.nodes[0].title,'검색 조건');assert.ok((await runner.status()).every(s=>s.verified));
 const invalid=await completed(runner,send(runner,'agy','fixture:cycle'));assert.equal(invalid.status,'failed');assert.match(invalid.error,/JSON/);
 const quota=await completed(runner,send(runner,'claude','fixture:quota'));assert.equal(quota.status,'failed');assert.match(quota.error,/사용량/);await runner.close();
});

test('prompt never enters shell arguments, duplicate requests do not launch twice, busy agents reject, cancellation stops the process',async()=>{
 const prompt='$(touch nope) & powershell "danger"; 기획';for(const a of ['codex','claude','agy']){const spec=invocation(a,{schemaFile:'/tmp/schema',outputFile:'/tmp/output',prompt});assert.ok(!spec.args.some(arg=>arg.includes(prompt)));assert.ok(spec.input.includes(a==='agy'?'기획':prompt));assert.ok(!spec.args.includes('--dangerously-skip-permissions'));}
 const runner=make();await runner.status();const key=crypto.randomUUID(),job=send(runner,'agy','fixture:hang',key);assert.equal(send(runner,'agy','fixture:hang',key).id,job.id);assert.throws(()=>send(runner,'agy','different'),/이미/);assert.throws(()=>send(runner,'claude','different',key),/식별자/);
 await new Promise(r=>setTimeout(r,80));assert.equal(runner.cancel(job.id).status,'cancelled');await runner.jobs.get(job.id).done;assert.equal(runner.get(job.id).result,undefined);await runner.close();
});

test('process timeout, output limits and failed structured result reject without leaking raw output',async()=>{
 await assert.rejects(runProcess(await resolve('agy'),[],{input:'fixture:hang',timeout:100}),/제한 시간/);
 await assert.rejects(runProcess(await resolve('agy'),[],{input:'fixture:overflow',maxBytes:1000}),/크기/);
 assert.throws(()=>parseResponse('agy','{"event":"result","result":{"status":"ERROR","response":"secret-token"}}'),e=>!e.message.includes('secret-token'));
 assert.throws(()=>parseResponse('claude','{"is_error":true,"result":"secret-token"}'),/JSON/);
});

test('Windows npm shims resolve to Node entrypoints without cmd.exe or shell execution',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'agent-resolve-'));try{
  await writeFile(path.join(dir,'codex.cmd'),'do not run');assert.equal(await resolveAgent('codex',{platform:'win32',env:{PATH:dir},home:dir}),null);
  const js=path.join(dir,'custom.js');await writeFile(js,'');const exe=await resolveAgent('codex',{platform:'win32',env:{AGENT_DESK_CODEX_BIN:js},home:dir});assert.equal(exe.command,process.execPath);assert.deepEqual(exe.prefix,[js]);
  assert.equal(await resolveAgent('codex',{platform:'win32',env:{AGENT_DESK_CODEX_BIN:path.join(dir,'codex.cmd')},home:dir}),null);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('loopback agent API requires pairing, rejects remote bootstrap and origins, supports exact CORS and job cancellation',async t=>{
 const runner=make(),server=createAppServer({agentRunner:runner});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await runner.close();await new Promise(r=>server.close(r));});
 const base='http://127.0.0.1:'+server.address().port;
 const call=(p,options={})=>fetch(base+'/api/agents/'+p,options);
 assert.equal((await call('session')).status,403);
 assert.equal((await call('session',{headers:{'X-Agent-Desk':'agent-runner',Origin:DASHBOARD_ORIGIN}})).status,403);
 const token=(await (await call('session',{headers:{'X-Agent-Desk':'agent-runner'}})).json()).token;assert.match(token,/^[a-f0-9]{64}$/);
 const headers={'X-Agent-Desk':'agent-runner',Authorization:'Bearer '+token,Origin:DASHBOARD_ORIGIN,'Content-Type':'application/json'};
 assert.equal((await call('status',{headers:{...headers,Origin:'https://evil.example'}})).status,403);
 assert.equal((await call('status',{headers:{...headers,Authorization:'Bearer wrong'}})).status,401);
 assert.equal(await new Promise(resolve=>{const req=httpRequest(base+'/api/agents/status',{headers:{...headers,Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.end();}),403);
 const preflight=await call('jobs',{method:'OPTIONS',headers:{Origin:DASHBOARD_ORIGIN,'Access-Control-Request-Private-Network':'true'}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),DASHBOARD_ORIGIN);assert.equal(preflight.headers.get('Access-Control-Allow-Private-Network'),'true');
 const status=await call('status',{headers});assert.equal(status.status,200);assert.ok((await status.json()).agents.every(a=>a.available));
 assert.equal((await call('jobs',{method:'POST',headers,body:JSON.stringify({agent:'shell',prompt:'touch file',requestId:crypto.randomUUID()})})).status,400);
 const created=await call('jobs',{method:'POST',headers,body:JSON.stringify({agent:'codex',prompt:'기획',requestId:crypto.randomUUID()})});assert.equal(created.status,202);const job=await created.json();await runner.jobs.get(job.id).done;
 const finished=await (await call('jobs/'+job.id,{headers})).json();assert.equal(finished.status,'succeeded');assert.ok(!('prompt' in finished));assert.ok(!('token' in finished));
 const hung=send(runner,'agy','fixture:hang');const cancelled=await call('jobs/'+hung.id+'/cancel',{method:'POST',headers});assert.equal((await cancelled.json()).status,'cancelled');
 assert.equal((await call('jobs',{method:'POST',headers,body:'{'})).status,400);
});

test('Windows npm install with extensionless sh/cmd shims selects the supported Node entrypoint',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'windows-npm-layout-'));
 try{
  const {mkdir}=await import('node:fs/promises');const dir=path.join(root,'npm');
  for(const [agent,entry] of [['codex','node_modules/@openai/codex/bin/codex.js'],['claude','node_modules/@anthropic-ai/claude-code/cli.js']]){
   const file=path.join(dir,entry);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'');
   await writeFile(path.join(dir,agent),'#!/bin/sh\nexit 1');await writeFile(path.join(dir,agent+'.cmd'),'@echo off');
   const resolved=await resolveAgent(agent,{platform:'win32',env:{Path:'"'+dir+'"'},home:root});
   assert.deepEqual(resolved,{command:process.execPath,prefix:[file]});
  }
  const invalid=await resolveAgent('codex',{platform:'win32',env:{AGENT_DESK_CODEX_BIN:path.join(dir,'codex')},home:root});assert.equal(invalid,null);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('AGY Windows installer location is discovered before PATH refresh, including default LocalAppData',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'windows-agy-layout-'));
 try{
  const {mkdir}=await import('node:fs/promises');const local=path.join(root,'AppData','Local'),exe=path.join(local,'agy','bin','agy.exe');
  await mkdir(path.dirname(exe),{recursive:true});await writeFile(exe,'');
  for(const env of [{PATH:'',LOCALAPPDATA:local},{PATH:''}])assert.deepEqual(await resolveAgent('agy',{platform:'win32',env,home:root}),{command:exe,prefix:[]});
 }finally{await rm(root,{recursive:true,force:true});}
});

test('CLI diagnostics distinguish launch errors from missing capabilities and accept help on stderr',async()=>{
 const runner=new AgentRunner({resolve:async id=>({command:id,prefix:[]}),run:async(exe,args)=>{
  if(exe.command==='codex'){const error=new Error('실행 실패');error.code='ENOEXEC';throw error;}
  if(args.includes('--version'))return {code:0,stdout:'',stderr:'CLI 1.0'};
  return {code:0,stdout:'',stderr:exe.command==='agy'?'--input-format --json-schema --mode':'--json-schema --tools --strict-mcp-config'};
 }});
 const results=await runner.status();assert.equal(results[0].stage,'version');assert.equal(results[0].code,'ENOEXEC');assert.equal(results[0].state,'error');
 assert.equal(results[1].state,'unverified');assert.equal(results[1].canTest,true);assert.equal(results[1].available,false);assert.deepEqual(results[1].missingFlags,['--safe-mode']);assert.match(results[1].hint,/--safe-mode/);
 assert.equal(results[2].available,true);assert.equal(results[2].version,'CLI 1.0');await runner.close();
});

test('hidden AGY help flags do not claim an outdated CLI; explicit response test verifies capabilities before planning',async()=>{
 let modelCalls=0;
 const runner=new AgentRunner({resolve,run:async(exe,args,opts)=>{
  if(args.includes('--help')&&exe.prefix[1]==='agy')return {code:0,stdout:'Usage: agy [flags]\n--mode plan\n--help',stderr:''};
  if(!args.includes('--help')&&!args.includes('--version'))modelCalls++;
  return runProcess(exe,args,opts);
 }});
 const first=(await runner.status()).find(a=>a.id==='agy');assert.equal(first.state,'unverified');assert.equal(first.canTest,true);assert.equal(first.available,false);assert.equal(modelCalls,0);
 const refused=await completed(runner,send(runner,'agy'));assert.equal(refused.status,'failed');assert.equal(modelCalls,0);
 const probe=runner.create({agent:'agy',kind:'probe',prompt:'연결 확인 요청',requestId:crypto.randomUUID()});assert.equal((await completed(runner,probe)).status,'succeeded');
 const verified=(await runner.status()).find(a=>a.id==='agy');assert.equal(verified.available,true);assert.ok(verified.verified);assert.equal(modelCalls,1);
 const refreshed=(await runner.status(true)).find(a=>a.id==='agy');assert.equal(refreshed.available,true);
 assert.equal((await completed(runner,send(runner,'agy'))).status,'succeeded');assert.equal(modelCalls,2);await runner.close();
});

test('all CLI adapters accept separate questions, conflicts and handoff response schemas and account for usage',async()=>{
 const runner=make();try{await runner.status();for(const kind of ['questions','conflicts','handoff']){const jobs=['codex','claude','agy'].map(agent=>runner.create({agent,kind,prompt:'기획 검토',requestId:crypto.randomUUID()}));const done=await Promise.all(jobs.map(j=>completed(runner,j)));for(const job of done){assert.equal(job.status,'succeeded',job.error);assert.ok(job.usage);if(kind==='handoff')assert.equal(job.result.tasks[0].nodeId,'work-a');else assert.equal(job.result.items[0].question,'어떤 가격을 비교할까요?');}}}finally{await runner.close();}
});


test('request-ID cancellation prevents late dispatch, stops an existing job, and keeps bounded tombstones',async t=>{
 let runs=0;const runner=new AgentRunner({resolve,run:(...args)=>{runs++;return runProcess(...args);}});t.after(()=>runner.close());
 const early=crypto.randomUUID();assert.deepEqual(runner.cancelRequest(early),{requestId:early,status:'cancelled'});
 const cancelled=send(runner,'agy','fixture:hang',early);assert.equal(cancelled.status,'cancelled');await runner.jobs.get(cancelled.id).done;
 assert.equal(runs,0);assert.equal(runner.jobs.get(cancelled.id).dispatched,undefined);
 assert.equal(send(runner,'agy','fixture:hang',early).id,cancelled.id);
 assert.throws(()=>runner.cancelRequest('bad'),/식별자/);
 await runner.status();const running=send(runner,'claude','fixture:hang');
 for(let i=0;i<100&&runner.get(running.id).progress?.phase!=='receiving';i++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(runner.cancelRequest(running.requestId).id,running.id);await runner.jobs.get(running.id).done;
 assert.equal(runner.get(running.id).status,'cancelled');
 runner.cancelledRequests.set('expired-request',Date.now()-3600001);
 for(let i=0;i<305;i++)runner.cancelRequest('request-'+i);
 assert.equal(runner.cancelledRequests.has('expired-request'),false);assert.equal(runner.cancelledRequests.size,300);
});

test('request-ID cancellation API requires authentication and cancels a create request that arrives later',async t=>{
 const runner=make(),server=createAppServer({agentRunner:runner});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await runner.close();await new Promise(resolve=>server.close(resolve));});
 const base='http://127.0.0.1:'+server.address().port,requestId=crypto.randomUUID(),endpoint=base+'/api/agents/requests/'+requestId+'/cancel';
 assert.equal((await fetch(endpoint,{method:'POST',headers:{'X-Agent-Desk':'agent-runner'}})).status,401);
 const token=(await (await fetch(base+'/api/agents/session',{headers:{'X-Agent-Desk':'agent-runner'}})).json()).token;
 const headers={'X-Agent-Desk':'agent-runner',Authorization:'Bearer '+token,'Content-Type':'application/json'};
 assert.equal((await fetch(endpoint,{method:'POST',headers:{...headers,Origin:'https://evil.example'}})).status,403);
 const cancelled=await fetch(endpoint,{method:'POST',headers});assert.equal(cancelled.status,200);assert.deepEqual(await cancelled.json(),{requestId,status:'cancelled'});
 const response=await fetch(base+'/api/agents/jobs',{method:'POST',headers,body:JSON.stringify({agent:'agy',prompt:'fixture:hang',requestId})});
 assert.equal(response.status,202);const job=await response.json();assert.equal(job.status,'cancelled');assert.equal(runner.jobs.get(job.id).dispatched,undefined);
 const status=await (await fetch(base+'/api/agents/status',{headers})).json();assert.equal(status.features.unlimitedWait,true);assert.equal(status.features.requestCancellation,true);
});
