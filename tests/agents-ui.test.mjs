import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';
import {createAppServer} from '../scripts/server.mjs';
import {AgentRunner} from '../scripts/agent-runner.mjs';
import {runProcess} from '../scripts/agent-process.mjs';
import {validateProject} from '../public/model.js';
const until=async check=>{for(let n=0;n<300;n++){if(await check())return;await new Promise(r=>setTimeout(r,15));}assert.fail('UI did not reach expected state');};

test('local connection, response test, parallel planning with partial failure, preview, live provenance and repeated feedback survive reload',async t=>{
 const fixture=fileURLToPath(new URL('./fixtures/agent-cli.mjs',import.meta.url));let requestCount=0;const prompts=[];
 const service=new AgentRunner({resolve:async agent=>({command:process.execPath,prefix:[fixture,agent]}),run:(exe,args,opts)=>{if(!args.includes('--help')&&!args.includes('--version')){requestCount++;prompts.push(opts.input);if(exe.prefix[1]==='claude')return Promise.resolve({code:1,stdout:'',stderr:'quota 429'});}return runProcess(exe,args,opts);}});
 const server=createAppServer({agentRunner:service});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const nativeFetch=globalThis.fetch;const dom=new JSDOM(await readFile(new URL('../public/index.html',import.meta.url),'utf8'),{url:base});const {window}=dom;
 t.after(async()=>{window.close();globalThis.fetch=nativeFetch;await service.close();await new Promise(r=>server.close(r));});
 for(const key of ['window','document','localStorage','sessionStorage','history','location','FormData'])globalThis[key]=key==='window'?window:window[key];
 globalThis.indexedDB=new IDBFactory();globalThis.BroadcastChannel=undefined;globalThis.fetch=(url,options)=>nativeFetch(new URL(url,base),options);
 window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
 let clipboard='';Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async value=>{clipboard=value;}}}});
 const storage=await import('../public/storage.js?v=0.9.1');await storage.openStore();await storage.saveState({projects:[validateProject({id:'kaf',name:'KAF',description:'대한항공 가격 비교 프로그램',instructions:'한국어로 대화'})]},0);
 await import('../public/app.js');const $=s=>document.querySelector(s),click=s=>{assert.ok($(s),s);$(s).click();},submit=s=>$(s).dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
 click('[data-action="agents"]');await until(()=>$('.agent-connection-list')?.textContent.includes('설치 확인'));assert.equal(requestCount,0);
 click('[data-ac="copy-token"]');await until(()=>clipboard.length===64);assert.ok(!document.body.textContent.includes(clipboard));
 assert.match($('.runner-diagnostics').textContent,/v0.9.1/);const pairToken=clipboard;click('[data-ac="copy-diagnostics"]');await until(()=>clipboard!==pairToken);assert.ok(!clipboard.includes(pairToken));assert.equal(JSON.parse(clipboard).runner.version,'0.9.1');
 click('[data-ac="probe"][data-agent="codex"]');await until(()=>$('.agent-error').textContent.includes('응답을 확인'));assert.equal(requestCount,1);assert.match($('.agent-connection-list').textContent,/응답 확인됨/);click('[data-ac="close"]');
 click('[data-action="open"][data-id="kaf"]');await until(()=>location.hash==='#kaf');click('[data-action="planning"]');click('[data-pa="ai-review"]');await until(()=>$('#agent-review-form button[type="button"]')&&!$('#agent-review-form .primary').disabled);
 const saved=async()=>(await storage.readState()).projects[0].planning;assert.equal((await saved()).nodes.length,1);
 $('#agent-review-form textarea').value='가격 출처를 검토해 줘';submit('#agent-review-form');await until(()=>$('.review-results')?.textContent.includes('응답 실패')&&!$('[data-ac="apply"]').disabled);
 assert.equal(requestCount,4);assert.equal((await saved()).nodes.length,1);assert.ok(prompts.some(p=>p.includes('가격 출처를 검토')));
 click('[data-ac="apply"]');await until(()=>!$('.agent-dialog'));let plan=await saved();assert.equal(plan.nodes.length,2);assert.equal(plan.proposals.length,2);assert.ok(plan.proposals.every(p=>p.kind==='live'));assert.equal(plan.messages.length,3);assert.equal(plan.messages[0].text,'가격 출처를 검토해 줘');assert.ok(plan.messages.slice(1).every(m=>m.kind==='live'));assert.equal(plan.appliedRuns.length,2);assert.equal(sessionStorage.getItem('agent-desk-review-kaf'),null);
 click('[data-pa="mode-compare"]');assert.match($('.proposal-comparison').textContent,/실제 AI 응답/);
 click('[data-pa="ai-review"]');await until(()=>$('#agent-review-form')&&!$('#agent-review-form .primary').disabled);assert.match($('.context-preview').textContent,/검토 의견 codex/);assert.match($('.context-preview').textContent,/검토 의견 agy/);click('[data-ac="close"]');
 click('[data-action="overview"]');click('[data-action="planning"]');plan=await saved();assert.equal(plan.appliedRuns.length,2);assert.equal(plan.nodes.length,2);
});

test('hosted client only contacts loopback after explicit pairing, keeps token out of URLs and rejects arbitrary network hosts',async()=>{
 const {RunnerClient,runnerURL,connectionReport}=await import('../public/agent-client.js?v=0.9.1');const calls=[];const storage=new Map();const client=new RunnerClient({storage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},fetcher:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({agents:[]})};}});
 assert.equal(calls.length,0);assert.throws(()=>runnerURL('https://example.com'),/현재 PC/);assert.throws(()=>runnerURL('http://127.0.0.1:4173/secret'),/현재 PC/);assert.throws(()=>runnerURL('http://user:pass@localhost:4173'),/현재 PC/);
 const token='a'.repeat(64);await client.connect('http://127.0.0.1:4173',token);assert.equal(calls.length,1);assert.ok(!calls[0].url.includes(token));assert.equal(calls[0].options.headers.Authorization,'Bearer '+token);assert.ok(storage.get('agent-desk-runner').includes(token));assert.ok(!connectionReport(client).includes(token));assert.ok(calls[0].url.endsWith('/api/agents/refresh'));assert.equal(calls[0].options.method,'POST');
});
