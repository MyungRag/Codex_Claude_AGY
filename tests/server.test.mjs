import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {createAppServer} from '../scripts/server.mjs';

async function listen(t,options={}) {
  const server=createAppServer(options);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin=`http://127.0.0.1:${server.address().port}`;
  return {server,origin,headers:{Origin:origin,'X-Agent-Desk':'folder-picker'}};
}
test('native folder endpoint returns a selected Unicode path and cancellation without mutation',async t=>{
  const results=[{path:'C:\\회사 자료\\KAF',name:'KAF',cancelled:false},{cancelled:true}];
  const {origin,headers}=await listen(t,{platform:'win32',pickFolder:async()=>results.shift()});
  assert.equal((await (await fetch(origin+'/api/capabilities')).json()).folderPicker,'native');
  const first=await fetch(origin+'/api/pick-folder',{method:'POST',headers});
  assert.equal(first.status,200);assert.equal((await first.json()).path,'C:\\회사 자료\\KAF');
  const cancelled=await fetch(origin+'/api/pick-folder',{method:'POST',headers});
  assert.deepEqual(await cancelled.json(),{cancelled:true});
});
test('remote origins, missing UI header, GETs and rebinding hosts cannot launch the picker',async t=>{
  let calls=0;
  const {origin,headers}=await listen(t,{platform:'win32',pickFolder:async()=>{calls++;return {cancelled:true};}});
  for(const options of [{method:'GET'},{method:'POST',headers:{Origin:origin}},{method:'POST',headers:{...headers,Origin:'https://untrusted.example'}}]){
    const response=await fetch(origin+'/api/pick-folder',options);assert.ok([403,405].includes(response.status));
  }
  const status=await new Promise((resolve,reject)=>{
    const req=http.request(origin+'/api/pick-folder',{method:'POST',headers:{...headers,Host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();
  });
  assert.equal(status,403);assert.equal(calls,0);
});
test('a second native picker cannot start while the first is open',async t=>{
  let release, started;
  const entered=new Promise(resolve=>{started=resolve;});
  const {origin,headers}=await listen(t,{platform:'win32',pickFolder:()=>{started();return new Promise(resolve=>{release=resolve;});}});
  const first=fetch(origin+'/api/pick-folder',{method:'POST',headers});await entered;
  const second=await fetch(origin+'/api/pick-folder',{method:'POST',headers});assert.equal(second.status,409);
  release({cancelled:true});assert.equal((await first).status,200);
});
test('non-Windows keeps browser picking and static routes do not expose source files',async t=>{
  const {origin,headers}=await listen(t,{platform:'linux'});
  assert.equal((await (await fetch(origin+'/api/capabilities')).json()).folderPicker,'browser');
  assert.equal((await fetch(origin+'/api/pick-folder',{method:'POST',headers})).status,501);
  assert.equal((await fetch(origin+'/scripts/folder-picker.mjs')).status,404);
  assert.equal((await fetch(origin+'/download')).status,200);
});

test('versioned planner assets and nested module imports are served with correct MIME types',async t=>{
  const {origin}=await listen(t);
  const html=await (await fetch(origin)).text();assert.match(html,/planning\.css\?v=0\.11\.0/);
  for(const name of ['app.js','model.js','storage.js','planning.js','planning-model.js','planning.css']){
    const response=await fetch(`${origin}/${name}?v=0.11.0`);
    assert.equal(response.status,200,name);
    assert.match(response.headers.get('content-type'),name.endsWith('.css')?/text\/css/:/javascript/);
    assert.ok((await response.text()).length>100);
  }
});

test('the browser entry point and every transitive module import are served',async t=>{
  const {origin}=await listen(t);
  const html=await (await fetch(origin)).text();
  const entry=html.match(/<script\s+type="module"\s+src="([^"]+)"/);
  assert.ok(entry,'the page must declare its browser module entry point');
  const pending=[new URL(entry[1],origin).href], visited=new Set();
  while(pending.length){
    const url=pending.shift();
    if(visited.has(url))continue;
    visited.add(url);
    const response=await fetch(url);
    assert.equal(response.status,200,`browser module ${url}`);
    assert.match(response.headers.get('content-type')||'',/javascript/,url);
    const source=await response.text();
    // Follow the app's static imports/re-exports, including version query strings and cycles.
    for(const match of source.matchAll(/^\s*(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/gm)){
      const specifier=match[1];
      if(!specifier.startsWith('.')&&!specifier.startsWith('/'))continue;
      const dependency=new URL(specifier,url);
      assert.equal(dependency.origin,origin,'browser modules must stay on this server');
      pending.push(dependency.href);
    }
  }
  const modules=new Set([...visited].map(url=>new URL(url).pathname));
  for(const name of ['decision-ui.js','decision-core.js','decision-model.js','decision-ai-ui.js']){
    assert.ok(modules.has(`/${name}`),`the decision workflow must load ${name}`);
  }
});
