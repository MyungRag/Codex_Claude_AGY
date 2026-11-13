import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,lstat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';
import {DevelopmentWorkspace,resolveDevelopmentCommand} from '../scripts/development-workspace.mjs';

async function fixture(t,options={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'development-workspace-')),source=path.join(root,'source');await mkdir(source);
 const workspace=new DevelopmentWorkspace({dataRoot:path.join(root,'data'),...options});
 t.after(()=>rm(root,{recursive:true,force:true}));
 return {root,source,workspace,create:()=>workspace.create({projectId:'project',attemptId:'attempt',sourcePath:source})};
}
function unzip(bytes){const entries=new Map();let offset=0;while(bytes.readUInt32LE(offset)===0x04034b50){const size=bytes.readUInt32LE(offset+18),length=bytes.readUInt16LE(offset+26),extra=bytes.readUInt16LE(offset+28),start=offset+30,name=bytes.subarray(start,start+length).toString(),body=start+length+extra;entries.set(name,bytes.subarray(body,body+size));offset=body+size;}return entries;}

test('workspace copies safe files, excludes credentials and dependencies, and initializes Git only in copy',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.source,'index.html'),'<h1>original</h1>');await writeFile(path.join(f.source,'.env'),'SECRET=yes');await writeFile(path.join(f.source,'private.pem'),'key');await mkdir(path.join(f.source,'node_modules'));await writeFile(path.join(f.source,'node_modules','dependency.js'),'dependency');
 const w=await f.create();assert.ok(w.excluded.includes('.env'));assert.ok(w.excluded.includes('private.pem'));assert.ok(w.excluded.includes('node_modules'));
 await assert.rejects(lstat(path.join(f.source,'.git')),{code:'ENOENT'});
 await f.workspace.apply(w,[{path:'index.html',action:'write',content:'changed'}]);assert.equal(await readFile(path.join(f.source,'index.html'),'utf8'),'<h1>original</h1>');
 const sha=await f.workspace.commit(w,'Initial implementation');assert.match(sha,/^[a-f0-9]{40}$/);
 assert.deepEqual((await f.workspace.context(w)).files,[{path:'index.html',content:'changed'}]);
});

test('empty and non-Git projects get local commits; previous snapshots preserve source code',async t=>{
 const f=await fixture(t),w=await f.create();assert.match(await f.workspace.commit(w),/^[a-f0-9]{40}$/);
 await f.workspace.apply(w,[{path:'src/main.js',action:'write',content:'export const n=1;'}]);await f.workspace.commit(w);
 const release=await f.workspace.snapshot(w,{projectId:'project',releaseId:'release'});
 const next=await f.workspace.create({projectId:'project',attemptId:'next',previousPath:release});assert.equal((await f.workspace.context(next)).files[0].content,'export const n=1;');
 await assert.rejects(f.workspace.apply(release,[{path:'src/main.js',action:'delete'}]),/관리되는/);
 await assert.rejects(f.workspace.snapshot(w,{projectId:'project',releaseId:'release'}),{code:'EEXIST'});
});

test('audit copies preserve the exact Git SHA and unchanged commits stay stable',async t=>{
 const f=await fixture(t),w=await f.create();await f.workspace.apply(w,[{path:'source.js',action:'write',content:'export const n=7;'}]);const sha=await f.workspace.commit(w);
 assert.equal(await f.workspace.commit(w,'No code change'),sha);
 const audit=await f.workspace.create({projectId:'project',attemptId:'audit',previousPath:w.path});
 assert.equal(await f.workspace.git(audit.path,['rev-parse','HEAD']),sha);
 const [result]=await f.workspace.check(audit,[{id:'syntax',command:'node',args:['--check','source.js']}]);assert.equal(result.codeSha,sha);assert.equal(result.passed,true);
 await f.workspace.apply(w,[{path:'source.js',action:'write',content:'export const n=8;'}]);await assert.rejects(f.workspace.create({projectId:'project',attemptId:'dirty',previousPath:w.path}),/먼저 커밋/);
});

test('all file changes validate before writes and reject traversal, reserved paths and case collisions',async t=>{
 const f=await fixture(t),w=await f.create();await f.workspace.apply(w,[{path:'index.html',action:'write',content:'original'}]);
 for(const unsafe of ['../outside.txt','/absolute','C:/Windows/file','src\\file','file:stream','.git/config','.env','node_modules/x','secrets.json','CON.txt','src/../../outside','bad./file']){
  await assert.rejects(f.workspace.apply(w,[{path:'index.html',action:'write',content:'changed'},{path:unsafe,action:'write',content:'bad'}]),undefined,unsafe);
  assert.equal(await readFile(path.join(w.path,'index.html'),'utf8'),'original');
 }
 await assert.rejects(f.workspace.apply(w,[{path:'INDEX.html',action:'write',content:'collision'}]),/충돌/);
 await assert.rejects(f.workspace.apply(w,[{path:'Src/a.js',action:'write',content:'a'},{path:'src/b.js',action:'write',content:'b'}]),/충돌/);
 const outside=path.join(f.root,'outside.txt');await writeFile(outside,'safe');
 await f.workspace.apply(w,[{path:'new.txt',action:'write',content:'fine',full:outside,old:Buffer.from('unsafe')}]);assert.equal(await readFile(outside,'utf8'),'safe');
 await f.workspace.apply(w,[{path:'new.txt',action:'delete'}]);await assert.rejects(readFile(path.join(w.path,'new.txt')),{code:'ENOENT'});
});

test('symlinks are excluded from copies and rejected in all apply ancestors',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.root,'outside.txt'),'private');await symlink(path.join(f.root,'outside.txt'),path.join(f.source,'linked.txt'));
 const w=await f.create();assert.ok(w.excluded.includes('linked.txt'));await symlink(f.root,path.join(w.path,'linked-folder'));
 await assert.rejects(f.workspace.apply(w,[{path:'linked-folder/outside.txt',action:'write',content:'bad'}]),/심볼릭/);assert.equal(await readFile(path.join(f.root,'outside.txt'),'utf8'),'private');
});

test('bounded context and copy reject excess instead of silently dropping text',async t=>{
 const f=await fixture(t,{limits:{contextBytes:10}});await writeFile(path.join(f.source,'long.txt'),'12345678901');const w=await f.create();await assert.rejects(f.workspace.context(w),/한도를 초과/);
 await assert.rejects(f.workspace.context(w,{paths:['missing.txt']}),/없습니다/);
 const tiny=new DevelopmentWorkspace({dataRoot:path.join(f.root,'tiny'),limits:{fileBytes:5}});await assert.rejects(tiny.create({projectId:'p',attemptId:'a',sourcePath:f.source}),/허용 범위/);
 await assert.rejects(f.workspace.create({projectId:'p',attemptId:'bad',sourcePath:f.root}),/원본 프로젝트 내부/);
});

test('real configured checks report code SHA, redact secrets, isolate environment, and detect modified code',async t=>{
 const f=await fixture(t),w=await f.create();await f.workspace.apply(w,[{path:'index.html',action:'write',content:'original'}]);const sha=await f.workspace.commit(w);
 const prior=process.env.AGENT_DESK_TEST_SECRET;process.env.AGENT_DESK_TEST_SECRET='private-host-value';t.after(()=>{if(prior===undefined)delete process.env.AGENT_DESK_TEST_SECRET;else process.env.AGENT_DESK_TEST_SECRET=prior;});
 let results=await f.workspace.check(w,[{id:'test',label:'Test',command:'node',args:['-e','if(process.env.AGENT_DESK_TEST_SECRET)process.exit(9);console.log("token=hidden-value");']}]);
 assert.equal(results[0].passed,true);assert.equal(results[0].codeSha,sha);assert.match(results[0].output,/REDACTED/);assert.doesNotMatch(results[0].output,/hidden-value/);
 results=await f.workspace.check(w,[{id:'mutate',command:'node',args:['-e','require("node:fs").writeFileSync("index.html","mutated")']}]);assert.equal(results[0].passed,false);assert.match(results[0].output,/소스를 변경/);
 results=await f.workspace.check(w,[{id:'fail',command:'node',args:['-e','process.exit(2)']}]);assert.equal(results[0].exitCode,2);assert.equal(results[0].passed,false);
});

test('configured checks stay cancellable without an automatic timeout',async t=>{
 const f=await fixture(t),w=await f.create();await f.workspace.commit(w);const controller=new AbortController();
 const promise=f.workspace.check(w,[{id:'wait',command:'node',args:['-e','setInterval(()=>{},1000)']}],{signal:controller.signal});setTimeout(()=>controller.abort(),150);await assert.rejects(promise,/취소/);
});

test('release ZIP excludes secrets, includes runnable Windows launcher, and frozen contents survive later edits',async t=>{
 const f=await fixture(t),w=await f.create();await f.workspace.apply(w,[{path:'index.html',action:'write',content:'<h1>release</h1>'}]);await f.workspace.commit(w);
 const release=await f.workspace.snapshot(w,{projectId:'project',releaseId:'r1'});await f.workspace.apply(w,[{path:'index.html',action:'write',content:'new code'}]);
 await writeFile(path.join(release,'.env'),'do-not-package');const zip=await f.workspace.packageRelease(release,{limitations:[{summary:'Optional export pending'}],launch:{kind:'static',entry:'index.html'}}),entries=unzip(zip);
 assert.equal(entries.get('program/index.html').toString(),'<h1>release</h1>');assert.equal(entries.has('program/.env'),false);assert.equal(entries.has('program/.git/config'),false);assert.ok(entries.has('program/start-agent-desk-windows.cmd'));assert.match(entries.get('program/_agent_desk_limitations.json').toString(),/Optional export pending/);
 const script=path.join(f.root,'download-start.mjs');await writeFile(script,entries.get('program/_agent_desk_start.mjs'));const checked=await f.workspace.run({command:process.execPath,prefix:[]},['--check',script],{});assert.equal(checked.code,0,checked.stderr);
 const launched=await f.workspace.launch(release,{kind:'static',entry:'index.html'});t.after(launched.stop);assert.equal(await (await fetch(launched.url)).text(),'<h1>release</h1>');assert.equal((await fetch(launched.url+'.env')).status,404);assert.equal((await fetch(launched.url+'%2e%2e%2foutside.txt')).status,404);await launched.stop();await assert.rejects(fetch(launched.url));
});

test('command launch verifies a real child HTTP server and stops it; release files remain immutable',async t=>{
 const f=await fixture(t,{startupTimeout:3000}),w=await f.create();await f.workspace.apply(w,[{path:'server.mjs',action:'write',content:'import {createServer} from "node:http";import {writeFileSync} from "node:fs";writeFileSync("cache.txt","runtime");createServer((q,s)=>s.end("ready")).listen(Number(process.env.PORT),process.env.HOST);'}]);await f.workspace.commit(w);
 const release=await f.workspace.snapshot(w,{projectId:'project',releaseId:'r1'}),running=await f.workspace.launch(release,{kind:'command',command:{command:'node',args:['server.mjs']},url:'http://127.0.0.1:{port}/'});t.after(running.stop);
 assert.equal(await (await fetch(running.url)).text(),'ready');await assert.rejects(readFile(path.join(release,'cache.txt')),{code:'ENOENT'});await running.stop();await assert.rejects(fetch(running.url));
});

test('explicit preparation restores dependencies only in launch copy and is packaged for Windows',async t=>{
 const f=await fixture(t,{startupTimeout:2000}),w=await f.create();await f.workspace.apply(w,[{path:'server.mjs',action:'write',content:'import {createServer} from "node:http";import value from "./node_modules/local-dependency.mjs";createServer((q,s)=>s.end(value)).listen(Number(process.env.PORT),process.env.HOST);'}]);await f.workspace.commit(w);
 const release=await f.workspace.snapshot(w,{projectId:'project',releaseId:'dependencies'});
 const prepare=[{command:'node',args:['-e','const fs=require("node:fs");fs.mkdirSync("node_modules",{recursive:true});fs.writeFileSync("node_modules/local-dependency.mjs",\'export default "prepared";\');']}];
 const launch={kind:'command',command:{command:'node',args:['server.mjs']},url:'http://127.0.0.1:{port}/',prepare};
 const running=await f.workspace.launch(release,launch);t.after(running.stop);assert.equal(await (await fetch(running.url)).text(),'prepared');await running.stop();await assert.rejects(lstat(path.join(release,'node_modules')),{code:'ENOENT'});
 const entries=unzip(await f.workspace.packageRelease(release,{launch}));assert.deepEqual(JSON.parse(entries.get('program/_agent_desk_launch.json')).prepare,prepare);assert.match(entries.get('program/_agent_desk_start.mjs').toString(),/for\(const spec of config.prepare/);
});

test('readiness cannot reuse an existing listener and failed commands never return a runnable URL',async t=>{
 const f=await fixture(t,{startupTimeout:400}),w=await f.create();await f.workspace.commit(w);const release=await f.workspace.snapshot(w,{projectId:'project',releaseId:'r1'});
 const server=createServer((q,s)=>s.end('other service'));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 await assert.rejects(f.workspace.launch(release,{kind:'command',command:{command:'node',args:['-e','setInterval(()=>{},1000)']},url:`http://127.0.0.1:${server.address().port}/`}),{code:'EADDRINUSE'});
 await assert.rejects(f.workspace.launch(release,{kind:'command',command:{command:'node',args:['-e','process.exit(1)']},url:'http://127.0.0.1:{port}/'}),/시작 실패/);
 await assert.rejects(f.workspace.launch(release,{kind:'command',command:{command:'node',args:['-e','setInterval(()=>{},1000)']},url:'http://127.0.0.1:{port}/'}),/준비를 완료/);
 await assert.rejects(f.workspace.launch(release,{kind:'command',command:{command:'node',args:[]},url:'http://example.com/'}),/로컬 HTTP/);
});

test('Windows npm resolves JS entry directly without a shell shim',async t=>{
 const f=await fixture(t),bin=path.join(f.root,'node'),npm=path.join(bin,'node_modules','npm','bin','npm-cli.js');await mkdir(path.dirname(npm),{recursive:true});await writeFile(npm,'');
 assert.deepEqual(await resolveDevelopmentCommand('npm',{platform:'win32',execPath:path.join(bin,'node.exe'),env:{PATH:bin}}),{command:path.join(bin,'node.exe'),prefix:[npm]});
 await assert.rejects(resolveDevelopmentCommand('npm.cmd'),/실행 파일/);await assert.rejects(resolveDevelopmentCommand('node; echo unsafe'),/실행 파일/);await assert.rejects(resolveDevelopmentCommand('powershell'),/실행 파일/);
});
