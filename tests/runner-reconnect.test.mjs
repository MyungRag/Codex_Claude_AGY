import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createAppServer} from '../scripts/server.mjs';
import {AgentRunner} from '../scripts/agent-runner.mjs';
import {RunnerClient} from '../public/agent-client.js';

test('local pending cancellation renews an expired session after a runner restart',async t=>{
 let runner=new AgentRunner({resolve:async()=>null}),server=createAppServer({agentRunner:runner});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=server.address().port,base=`http://127.0.0.1:${port}`,previous=globalThis.location;
 globalThis.location=new URL(base);t.after(async()=>{globalThis.location=previous;await server.stopAgents();await new Promise(resolve=>server.close(resolve));});
 const saved=new Map(),client=new RunnerClient({storage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},preferences:null,fetcher:(url,options)=>fetch(url,{...options,headers:{...options.headers,Connection:'close'}})});
 await client.connect(base,'',{local:true});
 const expired=client.token;
 await server.stopAgents();await new Promise(resolve=>server.close(resolve));
 runner=new AgentRunner({resolve:async()=>null});server=createAppServer({agentRunner:runner});server.listen(port,'127.0.0.1');await once(server,'listening');
 const job={requestId:'cancel-after-restart',id:'old-job',status:'unknown'};
 await client.cancelPending(job);assert.equal(job.status,'cancelled');assert.notEqual(client.token,expired);
 assert.equal(JSON.parse(saved.get('agent-desk-runner')).token,client.token);
 assert.equal(runner.cancelledRequests.has(job.requestId),true);
 await assert.rejects(client.request('/api/agents/jobs/old-job'),error=>error.status===404);
});

test('hosted clients never acquire a loopback session to replace invalid pairing credentials',async t=>{
 const previous=globalThis.location;globalThis.location=new URL('https://dashboard.example');t.after(()=>{globalThis.location=previous;});
 const calls=[],client=new RunnerClient({storage:null,preferences:null,fetcher:async url=>{calls.push(url);return {ok:false,status:401,json:async()=>({error:'pairing required'})};}});
 client.base='http://127.0.0.1:4173';client.token='invalid';
 await assert.rejects(client.cancelPending({requestId:'hosted-request',status:'running'}),error=>error.status===401);
 assert.equal(calls.length,1);assert.ok(!calls[0].endsWith('/session'));
});
