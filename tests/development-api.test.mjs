import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {request as httpRequest} from 'node:http';
import {createAppServer} from '../scripts/server.mjs';
import {DASHBOARD_ORIGIN} from '../scripts/agent-api.mjs';

async function fixture(t){
  const calls=[];
  const state={projectId:'project-1',revision:1,status:'idle',tasks:[],attempts:[],events:[],releases:[]};
  const developmentRunner={
    get:async id=>{calls.push(['get',id]);return {...state,projectId:id};},
    start:async payload=>{calls.push(['start',payload]);return {...state,status:'running'};},
    preview:async payload=>{calls.push(['preview',payload]);return [{taskId:'task-1',action:'verify',reason:'changed dependency'}];},
    cancel:async(...args)=>{calls.push(['cancel',...args]);return {...state,status:'cancelled'};},
    accept:async(...args)=>{calls.push(['accept',...args]);return state;},
    launch:async(...args)=>{calls.push(['launch',...args]);return {url:'http://127.0.0.1:12345/'};},
    download:async(...args)=>{calls.push(['download',...args]);return Buffer.from('PK\x03\x04fixture-release');},
    close:async()=>{}
  };
  const agentRunner={close:async()=>{},catalogView:()=>null,usage:()=>({}),status:async()=>[]};
  const server=createAppServer({agentRunner,developmentRunner});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin='http://127.0.0.1:'+server.address().port;
  const bootstrap=await fetch(origin+'/api/agents/session',{headers:{'X-Agent-Desk':'agent-runner'}});
  assert.equal(bootstrap.status,200);
  const {token}=await bootstrap.json();
  const headers={'X-Agent-Desk':'agent-runner',Authorization:'Bearer '+token,'Content-Type':'application/json',Origin:origin};
  const call=(suffix,options={})=>fetch(origin+'/api/agents/development'+suffix,{...options,headers:{...headers,...options.headers}});
  return {calls,state,developmentRunner,origin,headers,call};
}

test('development execution and release endpoints remain inside the paired loopback API boundary',async t=>{
  const {calls,origin,headers,call}=await fixture(t);
  const routes=[['GET','/project-1'],['POST','/start'],['POST','/preview'],['POST','/project-1/cancel'],['POST','/project-1/accept'],['POST','/project-1/releases/release-1/launch'],['GET','/project-1/releases/release-1/download']];
  for(const [method,route] of routes){
    const options={method,...(method==='POST'?{body:'{}'}:{})};
    assert.equal((await call(route,{...options,headers:{Authorization:''}})).status,401,route);
    assert.equal((await call(route,{...options,headers:{Origin:'https://untrusted.example'}})).status,403,route);
    assert.equal((await call(route,{...options,headers:{'X-Agent-Desk':''}})).status,403,route);
  }
  assert.equal(calls.length,0,'unauthorized requests must not touch workspaces or runtime state');
  const status=await new Promise((resolve,reject)=>{
    const req=httpRequest(origin+'/api/agents/development/project-1',{headers:{...headers,Host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end();
  });
  assert.equal(status,403);assert.equal(calls.length,0);
  const permitted=await call('/project-1',{headers:{Origin:DASHBOARD_ORIGIN}});
  assert.equal(permitted.status,200);assert.equal(permitted.headers.get('Access-Control-Allow-Origin'),DASHBOARD_ORIGIN);
});

test('development API preserves project requests, early cancellation identity, and immutable release IDs',async t=>{
  const {calls,call}=await fixture(t);
  const payload={requestId:'request-before-response',project:{id:'project-1'},config:{strategy:'integrated'}};
  const start=await call('/start',{method:'POST',body:JSON.stringify(payload)});
  assert.equal(start.status,202);assert.equal((await start.json()).status,'running');
  assert.deepEqual(calls.shift(),['start',payload]);
  const preview=await call('/preview',{method:'POST',body:JSON.stringify(payload)});
  assert.equal(preview.status,200);assert.deepEqual(await preview.json(),[{taskId:'task-1',action:'verify',reason:'changed dependency'}]);
  assert.deepEqual(calls.shift(),['preview',payload]);
  const cancel=await call('/project-1/cancel',{method:'POST',body:JSON.stringify({requestId:payload.requestId})});
  assert.equal(cancel.status,200);
  assert.deepEqual(calls.shift(),['cancel','project-1',{requestId:payload.requestId}]);
  const acceptance={taskId:'task-1',findingId:'task-1-R1-001',reason:'Optional export postponed'};
  assert.equal((await call('/project-1/accept',{method:'POST',body:JSON.stringify(acceptance)})).status,200);
  assert.deepEqual(calls.shift(),['accept','project-1',acceptance]);
  const launch=await call('/project-1/releases/release-1/launch',{method:'POST',body:'{}'});
  assert.equal(launch.status,200);assert.equal((await launch.json()).url,'http://127.0.0.1:12345/');
  assert.deepEqual(calls.shift(),['launch','project-1','release-1']);
  const launchRequest={requestId:'launch-before-response'};
  assert.equal((await call('/project-1/releases/release-1/launch',{method:'POST',body:JSON.stringify(launchRequest)})).status,200);
  assert.deepEqual(calls.shift(),['launch','project-1','release-1',launchRequest]);
  const download=await call('/project-1/releases/release-1/download?path=/etc/passwd');
  assert.equal(download.status,200);assert.match(download.headers.get('Content-Type'),/application\/zip/);
  assert.match(download.headers.get('Content-Disposition'),/^attachment;/);
  assert.equal(download.headers.get('Cache-Control'),'no-store');
  assert.equal(await download.text(),'PK\x03\x04fixture-release');
  assert.deepEqual(calls.shift(),['download','project-1','release-1'],'download paths must come only from runtime release records');
});

test('malformed IDs, unsupported methods and malformed bodies cannot dispatch development work',async t=>{
  const {calls,call}=await fixture(t);
  for(const route of ['/bad%2Fid','/bad.id','/'+'a'.repeat(81),'/project-1/releases/bad%5Cid/download']){
    const response=await call(route);assert.ok([400,404].includes(response.status),route);
  }
  for(const [method,route] of [['GET','/start'],['GET','/preview'],['GET','/project-1/cancel'],['GET','/project-1/accept'],['GET','/project-1/releases/release-1/launch'],['POST','/project-1/releases/release-1/download']]){
    const response=await call(route,{method});assert.ok([400,404,405].includes(response.status),route);
  }
  assert.equal((await call('/start',{method:'POST',body:'{'})).status,400);
  assert.equal((await call('/start',{method:'POST',body:JSON.stringify({text:'a'.repeat(600001)})})).status,400);
  assert.equal(calls.length,0);
});

test('development runtime errors are surfaced without converting missing releases into downloads',async t=>{
  const {developmentRunner,call}=await fixture(t);
  developmentRunner.download=async()=>{throw Object.assign(new Error('실행 가능한 배포본이 없습니다.'),{status:404});};
  const missing=await call('/project-1/releases/missing/download');
  assert.ok([400,404].includes(missing.status));assert.match(missing.headers.get('Content-Type'),/application\/json/);
  assert.equal((await missing.json()).error,'실행 가능한 배포본이 없습니다.');
  developmentRunner.start=async()=>{throw Object.assign(new Error('이미 개발 작업이 진행 중입니다.'),{status:409});};
  const busy=await call('/start',{method:'POST',body:'{}'});
  assert.ok([400,409].includes(busy.status));assert.match((await busy.json()).error,/진행 중/);
});
