import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {DevelopmentClient,parseArguments,localProgramURL} from '../public/development-client.js';
import {mountDevelopment} from '../public/development.js';
import {defaultDevelopment} from '../public/development-core.js';
const tick=()=>new Promise(r=>setTimeout(r,0));
const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await tick();}assert.fail('UI did not settle');};
function setup(t,{state,project:customProject,client:overrides={}}={}){
 const dom=new JSDOM('<main id="root"></main>',{url:'http://127.0.0.1:4173/'});
 for(const key of ['window','document','sessionStorage','localStorage','location','FormData'])globalThis[key]=dom.window[key];
 const project=customProject||{id:'example',name:'사용자 프로젝트',paths:{current:'C:\\project'},instructions:'기준 유지',planning:{baselines:[{id:'baseline1',number:1,at:'2026-01-01',snapshot:{nodes:[{id:'task1',title:'실제 작업'}]}}],handoffs:[{baselineId:'baseline1',tasks:[{nodeId:'task1',agent:'codex',dependsOn:[],instructions:'개발',deliverable:'결과',criteria:'검사 통과'}]}]}};
 const calls={save:[],start:[],preview:[],cancel:[],accept:[]};let update;
 const initial=state||{projectId:'example',status:'idle',attempts:[],tasks:[],releases:[],events:[]};
 const client={runner:{getSettings:()=>({model:'',effort:''})},connect:async()=>{},watch:(id,fn)=>{update=fn;fn(initial);return()=>{};},preview:async payload=>{calls.preview.push(payload);return {entries:[{taskId:'task1',action:'build',reason:'미개발 항목'}]};},start:async payload=>{calls.start.push(payload);return {...initial,status:'running'};},cancel:async(id,requestId)=>{calls.cancel.push({id,requestId});return {...initial,status:'cancelled'};},accept:async(id,payload)=>{calls.accept.push(payload);return {...initial,tasks:[]};},...overrides};
 const root=document.getElementById('root');const view=mountDevelopment(root,{project,revision:4,client,save:async(config,revision)=>{calls.save.push({config,revision});return revision+1;}});
 t.after(()=>{view.destroy();dom.window.close();});
 const $=s=>root.querySelector(s),click=s=>{assert.ok($(s),s);$(s).click();};
 const change=(field,value)=>{const el=$(`[data-field="${field}"]`);assert.ok(el,field);if(el.type==='checkbox')el.checked=value;else el.value=value;el.dispatchEvent(new dom.window.Event('change',{bubbles:true}));};
 const input=(field,value)=>{const el=$(`[data-field="${field}"]`);el.value=value;el.dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
 const submit=s=>$(s).dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
 return {dom,root,view,calls,project,client,$,click,change,input,submit,update:next=>update(next)};
}

test('five ordered strategies have distinct adjacent flows and inherited/overridden AI roles persist',async t=>{
 const ui=setup(t);await ui.view.ready;
 assert.deepEqual([...ui.root.querySelectorAll('[name="development-strategy"]')].map(e=>e.value),['integrated','procedural','verification','issue','assignment']);
 assert.equal(ui.$('[name="development-strategy"]:checked').value,'integrated');
 assert.equal(ui.$('[data-field="lead"]').value,'codex');
 assert.equal(ui.$('[data-field="roles.builder"]').value,'codex');
 const diagrams=new Set();for(const id of ['integrated','procedural','verification','issue','assignment']){const el=ui.$(`[name="development-strategy"][value="${id}"]`);el.checked=true;el.dispatchEvent(new ui.dom.window.Event('change',{bubbles:true}));diagrams.add(ui.$('svg').innerHTML);}
 assert.equal(diagrams.size,5);assert.equal(ui.$('[data-field="autoSwitch"]').disabled,true);
 ui.change('lead','agy');ui.change('override',true);ui.change('overrides.assignment.builder','agy');ui.change('overrides.assignment.auditor','codex');ui.submit('[data-form="settings"]');await until(()=>ui.calls.save.length===1&&!ui.view.busy);
 const saved=ui.calls.save[0];assert.equal(saved.revision,4);assert.equal(saved.config.lead,'agy');assert.equal(saved.config.roles.builder,'codex');assert.equal(saved.config.overrides.assignment.builder,'agy');
 assert.ok(ui.$('[data-dev="start"]').classList.contains('primary'));
});

test('invalid self-review and malformed commands are explained; draft navigation remains available',async t=>{
 const ui=setup(t);await ui.view.ready;
 ui.change('roles.auditor','codex');ui.submit('[data-form="settings"]');await until(()=>!ui.view.busy);assert.equal(ui.calls.save.length,0);assert.match(ui.$('.dev-alert').textContent,/Builder|Auditor|검토|달라/);
 assert.equal(ui.view.canLeave(),true);assert.ok(sessionStorage.getItem(ui.view.key));
 ui.change('roles.auditor','claude');ui.click('[data-dev="add-check"]');ui.input('checks.0.argsText','npm test && rm');ui.submit('[data-form="settings"]');await until(()=>!ui.view.busy);assert.match(ui.$('.dev-alert').textContent,/JSON/);assert.equal(ui.calls.save.length,0);
 ui.input('checks.0.argsText','["test"]');ui.input('launch.prepareText','[{"command":"npm","args":["ci"]}]');ui.submit('[data-form="settings"]');await until(()=>ui.calls.save.length===1&&!ui.view.busy);assert.deepEqual(ui.calls.save[0].config.launch.prepare,[{command:'npm',args:['ci']}]);
 ui.change('limits.maxReviews','');ui.submit('[data-form="settings"]');await until(()=>!ui.view.busy);assert.match(ui.$('.dev-alert').textContent,/정수/);
});

test('chooser works before finalization; start requires real baseline, handoff and project folder',async t=>{
 const ui=setup(t,{project:{id:'unplanned',name:'기획 전',paths:{current:''}}});await ui.view.ready;
 assert.equal(ui.root.querySelectorAll('[name="development-strategy"]').length,5);assert.equal(ui.$('[data-dev="start"]').disabled,true);assert.match(ui.root.textContent,/기획을 확정/);assert.match(ui.root.textContent,/업무 분담안/);assert.match(ui.root.textContent,/작업 폴더/);
});

test('retry preview uses real backend actions, persists config, and cancellation works during pending start',async t=>{
 let resolveStart;const active={projectId:'example',status:'completed',attempts:[{id:'old',strategy:'integrated'}],tasks:[{id:'task1',title:'기존 결과',status:'failed'}],events:[],releases:[]};
 const ui=setup(t,{state:active,client:{start:payload=>{ui.calls.start.push(payload);return new Promise(r=>{resolveStart=r;});}}});await ui.view.ready;
 assert.equal(ui.$('[data-dev="start"]').disabled,true);ui.click('[data-dev="preview"]');await until(()=>ui.view.preview&&!ui.view.busy);assert.match(ui.$('.dev-preview').textContent,/미개발 항목/);assert.equal(ui.$('[data-dev="start"]').disabled,false);
 ui.click('[data-dev="start"]');await until(()=>ui.calls.start.length===1);assert.equal(ui.calls.start[0].retry,true);assert.equal(ui.calls.start[0].baseline.id,'baseline1');assert.equal(ui.calls.start[0].project.path,'C:\\project');assert.equal(ui.view.canLeave(),true);
 ui.click('[data-dev="cancel"]');await until(()=>ui.calls.cancel.length===1);assert.equal(ui.calls.cancel[0].requestId,ui.calls.start[0].requestId);
 resolveStart({...active,status:'running'});await until(()=>ui.calls.cancel.length===2&&!ui.view.starting);assert.equal(ui.view.state.status,'cancelled');
});

test('real task findings are escaped, acceptance is explicit, and last runnable release remains visible',async t=>{
 const state={projectId:'example',status:'completed',attempts:[{id:'a',strategy:'integrated'}],tasks:[{id:'task1',title:'<img src=x onerror=alert(1)>',status:'limited',findings:[{id:'F1',summary:'<script>alert(1)</script>',severity:'medium',type:'limitation',status:'open',evidence:'실행 로그'}]}],events:[],latestRunnableId:'release1',releases:[{id:'release1',runnable:true,createdAt:'2026-01-01',codeSha:'a'.repeat(40),limitations:['미지원 기능']},{id:'release2',runnable:false}]};
 const ui=setup(t,{state});await ui.view.ready;ui.click('[data-dev="page"][data-page="results"]');assert.equal(ui.root.querySelector('script,img'),null);assert.match(ui.root.textContent,/최근 실행 가능한 버전/);assert.equal(ui.$('[data-dev="launch"][data-release="release1"]').disabled,false);assert.equal(ui.$('[data-dev="launch"][data-release="release2"]').disabled,true);
 ui.$('[name="reason"]').value='현재 버전에서 제외';ui.submit('[data-form="accept"]');await until(()=>ui.calls.accept.length===1);assert.deepEqual(ui.calls.accept[0],{taskId:'task1',findingId:'F1',reason:'현재 버전에서 제외'});
});

test('authenticated downloads retry a refreshed session without putting tokens in URLs',async()=>{
 const requests=[];let first=true;const client={base:'http://127.0.0.1:4173',token:'old',fetcher:async(url,options)=>{requests.push({url,options});if(first){first=false;return {status:401,ok:false};}return {status:200,ok:true,blob:async()=>new Blob(['zip'])};},refresh:async()=>{client.token='new';}};
 const development=new DevelopmentClient({client});assert.equal(await(await development.download('project','release')).text(),'zip');assert.equal(requests[1].options.headers.Authorization,'Bearer new');assert.ok(requests.every(r=>!r.url.includes('old')&&!r.url.includes('new')));
 await assert.rejects(()=>development.download('../escape','r'));
});

test('command arguments and returned program links reject malformed input',()=>{
 assert.deepEqual(parseArguments('["test","space value"]'),['test','space value']);assert.throws(()=>parseArguments('npm test'),/JSON/);assert.throws(()=>parseArguments('[1]'),/문자열/);assert.throws(()=>localProgramURL('javascript:alert(1)'));assert.throws(()=>localProgramURL('https://outside.example/'));assert.equal(localProgramURL('http://127.0.0.1:4321/'),'http://127.0.0.1:4321/');
});

test('lost start responses remain cancellable and cannot trigger a second writer',async t=>{
 const ui=setup(t,{client:{start:async()=>{throw new Error('연결 끊김');}}});await ui.view.ready;ui.click('[data-dev="start"]');await until(()=>!ui.view.busy&&ui.view.startUncertain);
 assert.ok(sessionStorage.getItem(ui.view.requestKey));assert.match(ui.root.textContent,/중복 실행/);assert.equal(ui.view.active,true);ui.click('[data-dev="page"][data-page="method"]');assert.equal(ui.$('[data-dev="start"]').disabled,true);
 ui.click('[data-dev="cancel"]');await until(()=>!ui.view.startUncertain);assert.equal(sessionStorage.getItem(ui.view.requestKey),null);assert.ok(ui.calls.cancel[0].requestId);
});

test('startup proof, incomplete audit and accepted limitations are separately readable; mandatory checks cannot be accepted',async t=>{
 const initial={projectId:'example',revision:4,status:'completed',attempts:[{id:'a',lead:'agy',strategy:'integrated',summary:'미지원 항목을 남겼습니다.',recommendation:'범위를 좁혀 재검토'}],tasks:[{id:'task1',title:'기능',status:'failed',findings:[{id:'task1-HOST-1',type:'implementation',severity:'high',summary:'필수 검사 실패',status:'open'},{id:'F2',type:'limitation',severity:'low',summary:'미지원 기능',status:'accepted',acceptanceReason:'다음 버전에서 지원'}]}],events:[],latestRunnableId:'release1',releases:[{id:'release1',runnable:true,verification:{startup:'http-response',audit:'incomplete',checks:[{passed:true}]},limitations:[{title:'미지원 기능',description:'저장은 다음 버전 지원',disposition:'accepted',findings:[]}]}]};
 const ui=setup(t,{state:initial});await ui.view.ready;ui.click('[data-dev="page"][data-page="results"]');assert.match(ui.root.textContent,/HTTP 응답 확인/);assert.match(ui.root.textContent,/미완료·미해결 있음/);assert.match(ui.root.textContent,/1\/1개 통과/);assert.match(ui.root.textContent,/저장은 다음 버전 지원/);assert.match(ui.root.textContent,/사용자가 이번 버전에서 수용/);assert.match(ui.root.textContent,/다음 버전에서 지원/);assert.match(ui.root.textContent,/총괄 AI의 결과 정리 · AGY/);assert.equal(ui.$('[data-form="accept"][data-finding="task1-HOST-1"]'),null);
 ui.update({...initial,revision:3,status:'idle'});assert.equal(ui.view.state.status,'completed');
});

test('pending program preparation remains cancellable across navigation and ignores a late success after cancellation',async t=>{
 let resolveLaunch,launchRequestId;const state={projectId:'example',status:'completed',attempts:[{id:'old',requestId:'old-development-request',strategy:'integrated'}],tasks:[],events:[],releases:[{id:'release1',runnable:true}],latestRunnableId:'release1'};
 const ui=setup(t,{state,client:{launch:(projectId,releaseId,requestId)=>{launchRequestId=requestId;return new Promise(resolve=>{resolveLaunch=resolve;});}}});await ui.view.ready;ui.view.requestId='old-development-request';ui.click('[data-dev="page"][data-page="results"]');ui.click('[data-dev="launch"]');await until(()=>ui.view.launchRecord);
 assert.match(ui.root.textContent,/프로그램 실행 준비 중/);assert.ok(ui.$('[data-dev="cancel"]'));assert.equal(ui.view.canLeave(),true);
 ui.view.destroy();const remount=mountDevelopment(ui.root,{project:ui.project,revision:4,client:ui.client,save:async()=>5});t.after(()=>remount.destroy());await remount.ready;
 assert.ok(ui.$('[data-dev="cancel"]'));ui.click('[data-dev="cancel"]');await until(()=>ui.calls.cancel.length===1);assert.ok(launchRequestId);assert.equal(ui.calls.cancel[0].requestId,launchRequestId);assert.notEqual(ui.calls.cancel[0].requestId,'old-development-request');
 resolveLaunch({url:'http://127.0.0.1:4321/'});await until(()=>!remount.launchRecord);assert.equal(remount.launchURLs.release1,undefined);assert.match(ui.root.textContent,/실행 준비를 취소/);assert.equal(remount.active,false);
});

test('program launch waits without a transport deadline while cancellation remains a separate request',async()=>{
 const calls=[];const client={request:async(path,options)=>{calls.push({path,options});return {};}};const development=new DevelopmentClient({client});await development.launch('example','release1','launch-request1');await development.cancel('example','launch-request1');assert.equal(calls[0].options.timeoutMs,0);assert.deepEqual(calls[0].options.body,{requestId:'launch-request1'});assert.deepEqual(calls[1].options.body,{requestId:'launch-request1'});await development.cancel('example');assert.deepEqual(calls[2].options.body,{});
});
