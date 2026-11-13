import {browserChecks,parseBrowserChecks} from './browser-checks.mjs';
import {createServer} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {spawn} from 'node:child_process';
import {lstat, mkdir, readdir, readFile, writeFile, rm, rename, realpath, copyFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {runProcess} from './agent-process.mjs';

const LIMITS={files:4000,fileBytes:8*1024*1024,totalBytes:64*1024*1024,contextBytes:120000,changes:100,changeBytes:1024*1024};
const OMIT=new Set(['node_modules','__pycache__','venv','vendor','coverage']);
const TEXT=/\.(?:[cm]?[jt]sx?|html?|css|scss|json|md|txt|ya?ml|toml|xml|svg|csv|py|rs|go|java|c|cpp|h|sql|sh|bat|cmd|ps1|svelte|vue|lock)$/i;
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8'};
function fail(message){throw Object.assign(new Error(message),{safe:true});}
function id(value){if(typeof value!=='string'||!/^\w[\w-]{0,79}$/.test(value))fail('작업 식별자가 올바르지 않습니다.');return value;}
function forbiddenPart(part){return part.startsWith('.')||OMIT.has(part.toLowerCase())||/^(?:_agent_desk_|start-agent-desk-windows\.cmd$|AGENT-DESK-README\.txt$)/i.test(part)||/^(?:credentials?|secrets?|id_rsa|id_ed25519)(?:\.|$)/i.test(part)||/\.(pem|key|p12|pfx|jks|keystore)$/i.test(part);}
function relative(value){
 if(typeof value!=='string'||!value||value.length>240||value.includes('\\')||/[\x00-\x1f<>:"|?*]/.test(value)||path.isAbsolute(value))fail('파일 경로는 안전한 상대 경로여야 합니다.');
 const parts=value.split('/');
 if(parts.some(part=>!part||part==='.'||part==='..'||forbiddenPart(part)||/[ .]$/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))fail('보호된 파일 또는 허용되지 않는 경로입니다: '+value);
 return parts.join('/');
}
function inside(root,target){const diff=path.relative(root,target);return diff===''||(!diff.startsWith('..'+path.sep)&&diff!=='..'&&!path.isAbsolute(diff));}
function redact(value){return String(value).replace(/(bearer\s+)[\w.\-]+/gi,'$1[REDACTED]').replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi,'$1[REDACTED]').replace(/\b(?:sk-[\w-]{15,}|gh[pousr]_[\w]{20,})\b/g,'[REDACTED]');}
function checkAbort(signal){if(signal?.aborted)fail('요청을 취소했습니다.');}
function executionEnvironment(root){const result={};for(const name of ['PATH','Path','SystemRoot','WINDIR','PATHEXT','TEMP','TMP','LANG','LC_ALL','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','REQUESTS_CA_BUNDLE','NO_PROXY','no_proxy'])if(process.env[name])result[name]=process.env[name];for(const name of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy']){try{const value=new URL(process.env[name]);if(!value.username&&!value.password)result[name]=value.href;}catch{}}return {...result,HOME:root,USERPROFILE:root};}
async function safeFile(root,name,{missing=false}={}){
 const parts=relative(name).split('/');let current=root;
 for(let index=0;index<parts.length;index++){
  current=path.join(current,parts[index]);let info;
  try{info=await lstat(current);}catch(error){if(error.code==='ENOENT'&&missing)return current;throw error;}
  if(info.isSymbolicLink())fail('심볼릭 링크는 사용할 수 없습니다: '+name);
  if(index<parts.length-1&&!info.isDirectory())fail('상위 경로가 폴더가 아닙니다: '+name);
 }
 return path.join(root,...parts);
}
async function listFiles(root,limits=LIMITS){
 const files=[],excluded=[],names=new Set();let total=0,visited=0;
 async function walk(directory,prefix=''){
  const entries=await readdir(directory,{withFileTypes:true});
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
   if(++visited>limits.files*3)fail('폴더 항목 수가 허용 범위를 초과했습니다. 대상 범위를 줄여 주세요.');
   const name=prefix+entry.name;
   try{relative(name);}catch{excluded.push(name);continue;}
   if(names.has(name.toLowerCase()))fail('Windows에서 구분할 수 없는 파일 이름이 있습니다: '+name);names.add(name.toLowerCase());
   const file=path.join(directory,entry.name),info=await lstat(file);
   if(info.isSymbolicLink()){excluded.push(name);continue;}
   if(info.isDirectory()){await walk(file,name+'/');continue;}
   if(!info.isFile()){excluded.push(name);continue;}
   total+=info.size;
   if(info.size>limits.fileBytes||total>limits.totalBytes||files.length>=limits.files)fail('프로젝트 파일 크기 또는 개수가 허용 범위를 초과했습니다. 파일을 임의로 생략하지 않았습니다.');
   files.push({path:name,size:info.size});
  }
 }
 await walk(root);return {files,excluded,totalBytes:total};
}
async function copyTree(source,target,limits){
 const inventory=await listFiles(source,limits);await mkdir(target,{recursive:true});
 for(const file of inventory.files){const from=await safeFile(source,file.path),to=path.join(target,file.path);await mkdir(path.dirname(to),{recursive:true});await copyFile(from,to);}
 return inventory;
}
async function sourceDigest(root,limits){const hash=createHash('sha256');for(const file of (await listFiles(root,limits)).files){hash.update(file.path);hash.update('\0');hash.update(await readFile(await safeFile(root,file.path)));hash.update('\0');}return hash.digest('hex');}

// npm.cmd cannot be spawned with shell:false on Windows. Execute npm's JS entry.
export async function resolveDevelopmentCommand(command,{platform=process.platform,env=process.env,execPath=process.execPath}={}){
 if(typeof command!=='string'||!command||command.length>500||/[\r\n\x00;&|<>`]/.test(command)||/\.(cmd|bat|ps1)$/i.test(command)||/^(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|sh|bash|zsh)$/i.test(path.basename(command)))fail('명령은 셸 문자열이 아닌 실행 파일이어야 합니다.');
 if(command==='node'||command==='node.exe')return {command:execPath,prefix:[]};
 if(platform==='win32'&&(command==='npm'||command==='npx')){
  const leaf=command==='npm'?'npm-cli.js':'npx-cli.js',dirs=[path.dirname(execPath),...(env.PATH||env.Path||'').split(';')].filter(Boolean);
  const candidates=[...(env.npm_execpath&&command==='npm'?[env.npm_execpath]:[]),...dirs.map(dir=>path.join(dir,'node_modules','npm','bin',leaf))];
  for(const candidate of candidates){try{if((await lstat(candidate)).isFile()&&!/\.(cmd|bat)$/i.test(candidate))return {command:execPath,prefix:[candidate]};}catch{}}
  fail('npm 실행 파일을 찾지 못했습니다. Node.js의 npm 설치를 확인해 주세요.');
 }
 return {command,prefix:[]};
}
function commandConfig(value){
 if(!value||typeof value.command!=='string'||!Array.isArray(value.args)||value.args.length>100||value.args.some(arg=>typeof arg!=='string'||arg.length>8000||arg.includes('\0')))fail('명령과 인수를 명시적으로 설정해 주세요.');
 return value;
}
async function freePort(port=0){
 const server=createNetServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});const assigned=server.address().port;await new Promise(resolve=>server.close(resolve));return assigned;
}
function launchDefinition(raw={}){
 if(raw.kind==='command'){
  const command=commandConfig(typeof raw.command==='string'?{command:raw.command,args:raw.args||[]}:raw.command);
  const value=raw.url;if(typeof value!=='string'||!value)fail('실행 준비 상태를 확인할 로컬 HTTP 주소를 설정해 주세요.');
  let url;try{url=new URL(value.replaceAll('{port}','4174'));}catch{fail('실행 확인 주소가 올바르지 않습니다.');}
  if(url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname)||url.username||url.password||url.hash)fail('실행 확인 주소는 로컬 HTTP 주소만 사용할 수 있습니다.');
  const prepare=raw.prepare||[];if(!Array.isArray(prepare)||prepare.length>10)fail('실행 준비 명령은 최대 10개입니다.');prepare.forEach(commandConfig);
  return {kind:'command',command,url:value,prepare};
 }
 if(raw.kind&&raw.kind!=='static')fail('지원하지 않는 실행 방식입니다.');
 return {kind:'static',entry:relative(raw.entry||'index.html')};
}

export class DevelopmentWorkspace{
 constructor({dataRoot=path.join(os.tmpdir(),'agent-desk-development'),run=runProcess,limits={},startupTimeout=20000}={}){
  this.dataRoot=path.resolve(dataRoot);this.run=run;this.limits={...LIMITS,...limits};this.startupTimeout=startupTimeout;
 }
 async root(workspace,{mutable=false}={}){
  const value=typeof workspace==='string'?workspace:workspace?.path;
  if(typeof value!=='string')fail('작업 폴더가 없습니다.');
  const root=path.resolve(value),scope=path.join(this.dataRoot,mutable?'workspaces':'');
  if(!inside(scope,root)||root===scope)fail('관리되는 작업 폴더만 사용할 수 있습니다.');
  const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink())fail('작업 폴더가 올바르지 않습니다.');
  if(await realpath(root)!==root)fail('작업 폴더 경로에 심볼릭 링크가 있습니다.');return root;
 }
 async create({projectId,sourcePath,attemptId,previousPath}={}){
  id(projectId);id(attemptId);
  const destination=path.join(this.dataRoot,'workspaces',projectId,attemptId);
  if(typeof (previousPath||sourcePath)!=='string'||!path.isAbsolute(previousPath||sourcePath))fail('프로젝트의 절대 경로가 필요합니다.');
  const source=previousPath?await this.root(previousPath):path.resolve(sourcePath),info=await lstat(source);
  if(!info.isDirectory()||info.isSymbolicLink()||await realpath(source)!==source)fail('프로젝트는 심볼릭 링크가 아닌 실제 폴더여야 합니다.');
  if(inside(source,this.dataRoot))fail('작업 저장 폴더를 원본 프로젝트 내부에 둘 수 없습니다.');
  await mkdir(path.dirname(destination),{recursive:true});if(await realpath(path.dirname(destination))!==path.dirname(destination))fail('작업 저장 경로에 심볼릭 링크가 있습니다.');await mkdir(destination);
  try{const inventory=await copyTree(source,destination,this.limits);await this.git(destination,['init','--quiet']);await this.git(destination,['config','user.name','Agent Desk']);await this.git(destination,['config','user.email','agent-desk@localhost']);
   // Managed working copies retain the exact reviewed SHA; exported releases
   // intentionally omit Git metadata and begin a new local history if reused.
   if(previousPath&&inside(path.join(this.dataRoot,'workspaces'),source)){
    let sha;try{sha=await this.git(source,['rev-parse','HEAD']);}catch{}
    if(sha){const tracked=(await this.git(source,['ls-files','-z'])).split('\0').filter(Boolean).map(relative);
     if(await this.git(source,['diff','HEAD','--name-only'])||inventory.files.some(file=>!tracked.includes(file.path)))fail('이전 작업 폴더의 변경 사항을 먼저 커밋해 주세요.');
     await this.git(destination,['fetch','--quiet','--no-tags','--no-recurse-submodules',source,sha]);await this.git(destination,['reset','--mixed','--quiet',sha]);
    }
   }
   return {path:destination,excluded:inventory.excluded};}
  catch(error){await rm(destination,{recursive:true,force:true});throw error;}
 }
 async git(root,args){const result=await this.run({command:'git',prefix:['-c','core.hooksPath=.git/agent-desk-no-hooks','-c','core.autocrlf=false']},args,{cwd:root,env:{...executionEnvironment(root),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'},maxBytes:512*1024});if(result.code!==0)fail('Git 작업 실패: '+redact(result.stderr||result.stdout));return result.stdout.trim();}
 async context(workspace,{paths}={}){
  const root=await this.root(workspace),inventory=await listFiles(root,this.limits),wanted=paths?new Set(paths.map(relative)):null,files=[],excluded=[...inventory.excluded];let bytes=0;
  if(wanted)for(const name of wanted)if(!inventory.files.some(file=>file.path===name))fail('요청한 문맥 파일이 없습니다: '+name);
  for(const file of inventory.files){
   if(wanted&&!wanted.has(file.path))continue;
   if(!wanted&&!TEXT.test(file.path)&&!/(^|\/)(?:Dockerfile|Makefile|LICENSE)$/i.test(file.path)){excluded.push(file.path);continue;}
   const body=await readFile(await safeFile(root,file.path));
   if(body.includes(0)){if(wanted)fail('바이너리 파일은 문맥으로 읽을 수 없습니다: '+file.path);excluded.push(file.path);continue;}
   bytes+=body.length;if(bytes>this.limits.contextBytes)fail('AI에 전달할 파일 문맥이 크기 한도를 초과했습니다. 작업 파일 범위를 지정해 주세요. 내용을 임의로 잘라내지 않았습니다.');
   files.push({path:file.path,content:body.toString('utf8')});
  }
  return {files,excluded,totalBytes:bytes};
 }
 async apply(workspace,files){
  const root=await this.root(workspace,{mutable:true});
  if(!Array.isArray(files)||files.length>this.limits.changes)fail('한 번에 변경할 파일 수를 초과했습니다.');
  const seen=new Set(),prepared=[],existing=(await listFiles(root,this.limits)).files.map(file=>file.path);let total=0;
  for(const file of files){
   const name=relative(file?.path),folded=name.toLowerCase();if(seen.has(folded))fail('같은 파일의 중복 또는 대소문자 충돌입니다.');seen.add(folded);
   if(existing.some(value=>value!==name&&value.toLowerCase()===folded))fail('기존 파일과 대소문자가 충돌합니다.');
   for(const value of [...existing,...prepared.map(item=>item.name)]){const left=value.split('/'),right=name.split('/');for(let i=0;i<Math.min(left.length,right.length);i++){if(left[i].toLowerCase()!==right[i].toLowerCase())break;if(left[i]!==right[i])fail('폴더 또는 파일 이름의 대소문자가 충돌합니다.');}}
   if(!['write','delete'].includes(file.action))fail('파일 변경 동작이 올바르지 않습니다.');
   if(file.action==='write'&&(typeof file.content!=='string'||file.content.includes('\0')))fail('작성할 파일은 텍스트여야 합니다.');
   total+=Buffer.byteLength(file.content||'');if(total>this.limits.changeBytes)fail('파일 변경 크기 한도를 초과했습니다.');
   await safeFile(root,name,{missing:true});const full=path.join(root,name);let old=null;
   try{const info=await lstat(full);if(!info.isFile()||info.isSymbolicLink())fail('일반 파일만 변경할 수 있습니다.');old=await readFile(full);}catch(error){if(error.code!=='ENOENT')throw error;}
   prepared.push({name,full,old,action:file.action,content:file.content});
  }
  // All paths are checked before writing. Roll back a partially failed batch.
  try{for(const file of prepared){if(file.action==='delete')await rm(file.full,{force:true});else{await mkdir(path.dirname(file.full),{recursive:true});await writeFile(file.full,file.content,{flag:'w'});}}}
  catch(error){for(const file of prepared){if(file.old===null)await rm(file.full,{force:true}).catch(()=>{});else await writeFile(file.full,file.old).catch(()=>{});}throw error;}
  return {changedPaths:prepared.map(file=>file.name)};
 }
 async commit(workspace,message='Agent Desk development submission'){
  const root=await this.root(workspace,{mutable:true}),inventory=await listFiles(root,this.limits);
  // Stage only the validated inventory; never credentials or dependency output.
  const tracked=(await this.git(root,['ls-files','-z'])).split('\0').filter(Boolean).map(relative),names=[...new Set([...tracked,...inventory.files.map(file=>file.path)])];
  for(let offset=0;offset<names.length;offset+=100)await this.git(root,['add','--all','--',...names.slice(offset,offset+100)]);
  if(!await this.git(root,['diff','--cached','--name-only'])){try{return await this.git(root,['rev-parse','HEAD']);}catch{}}
  await this.git(root,['-c','commit.gpgsign=false','commit','--allow-empty','--quiet','-m',String(message).slice(0,500)]);return this.git(root,['rev-parse','HEAD']);
 }
 async check(workspace,checks=[],{signal}={}){
  const root=await this.root(workspace,{mutable:true});if(!Array.isArray(checks)||checks.length>30)fail('검사 설정이 올바르지 않습니다.');
  const sha=await this.git(root,['rev-parse','HEAD']),results=[],before=await sourceDigest(root,this.limits);
  for(const check of checks){checkAbort(signal);commandConfig(check);let result,error;
   try{result=await this.run(await resolveDevelopmentCommand(check.command),check.args,{cwd:root,signal,timeout:check.automatic?30000:0,maxBytes:256*1024,env:executionEnvironment(root)});if(await sourceDigest(root,this.limits)!==before||await this.git(root,['rev-parse','HEAD'])!==sha)error=new Error('검사 명령이 검토 대상 소스를 변경했습니다. 변경된 파일은 고정 커밋의 검사 결과로 인정할 수 없습니다.');}catch(cause){checkAbort(signal);error=cause;}
   results.push({id:check.id||String(results.length+1),label:check.label||check.command,command:check.command,args:check.args,exitCode:result?.code??(check.automatic&&error?.code==='AGENT_TIMEOUT'?1:null),passed:!error&&result?.code===0,output:redact(error?.message||[result?.stdout,result?.stderr].filter(Boolean).join('\n')),codeSha:sha,at:new Date().toISOString()});
  }
  return results;
 }
 async automaticChecks(workspace,launch,{signal,nodeId}={}){
  const root=await this.root(workspace,{mutable:true}),files=(await listFiles(root,this.limits)).files.map(f=>f.path),results=[];
  if(files.includes('agent-desk.test.mjs'))results.push(...await this.check(workspace,[{id:'auto-unit',label:'기본 기능 검사 · Node.js',command:'node',args:['--test','agent-desk.test.mjs'],automatic:true}],{signal}));
  if(launch.kind!=='static'||!files.includes(launch.entry)||!files.includes('agent-desk.checks.json'))return results;
  const sha=await this.git(root,['rev-parse','HEAD']);let server;
  try{
   const manifest=await readFile(await safeFile(root,'agent-desk.checks.json'),'utf8');if(manifest.length>200000)throw new Error('브라우저 검사 정의가 너무 큽니다.');
   const checks=parseBrowserChecks(JSON.parse(manifest)).filter(c=>!nodeId||c.nodeIds.includes(nodeId));
   if(!checks.length)return results;
   server=await this.launch(root,launch,{signal});
   const checked=await browserChecks(server.url,checks,{signal});
   results.push(...checked.map((c,index)=>({...c,id:'auto-browser-'+index,command:'browser',args:[],codeSha:sha,at:new Date().toISOString()})));
  }catch(error){checkAbort(signal);results.push({id:'auto-browser',label:'기본 화면 검사',command:'browser',args:[],passed:false,exitCode:error.unavailable?null:1,failureKind:error.unavailable?'environment':'definition',output:error.message,codeSha:sha,at:new Date().toISOString()});}
  finally{await server?.stop();}
  return results;
 }
 async snapshot(workspace,{projectId,releaseId}={}){
  id(projectId);id(releaseId);const source=await this.root(workspace),destination=path.join(this.dataRoot,'releases',projectId,releaseId);
  await mkdir(path.dirname(destination),{recursive:true});if(await realpath(path.dirname(destination))!==path.dirname(destination))fail('릴리스 저장 경로에 심볼릭 링크가 있습니다.');await mkdir(destination);
  try{await copyTree(source,destination,this.limits);return destination;}catch(error){await rm(destination,{recursive:true,force:true});throw error;}
 }
 async packageRelease(releasePath,{limitations=[],launch={kind:'static',entry:'index.html'},trace=null}={}){
  const root=await this.root(releasePath),definition=launchDefinition(launch),inventory=await listFiles(root,this.limits),entries=[];
  for(const file of inventory.files)entries.push({name:file.path,body:await readFile(await safeFile(root,file.path))});
  const add=(name,text)=>entries.push({name,body:Buffer.from(text)});
  if(trace)add('_agent_desk_decisions.json',JSON.stringify(trace,null,2));
  add('_agent_desk_launch.json',JSON.stringify(definition,null,2));
  add('_agent_desk_limitations.json',JSON.stringify({createdAt:new Date().toISOString(),limitations,excluded:inventory.excluded,verification:'실행 가능 상태와 독립 검토 통과 여부는 별도입니다. 이 패키지에 Node.js 또는 의존성은 포함되지 않습니다.'},null,2));
  add('_agent_desk_start.mjs',downloadLauncher());
  add('start-agent-desk-windows.cmd','@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\nnode "_agent_desk_start.mjs"\r\nif errorlevel 1 pause\r\n');
  add('AGENT-DESK-README.txt','Agent Desk 프로그램 실행\r\n\r\n1. ZIP 전체를 새 폴더에 압축 해제합니다.\r\n2. Node.js 20 이상을 설치합니다.\r\n3. start-agent-desk-windows.cmd를 실행합니다.\r\n4. 표시된 로컬 주소를 브라우저로 엽니다. 종료하려면 Ctrl+C를 누릅니다.\r\n\r\n명령 실행 프로젝트의 외부 의존성은 포함하지 않습니다. package.json이 있다면 프로젝트 안내에 따라 npm install 등 필요한 설치를 먼저 수행하세요.\r\n미해결 사항은 _agent_desk_limitations.json에 기록됩니다. 실행 가능은 모든 기능 또는 검토 통과를 의미하지 않습니다.\r\n');
  return zip(entries);
 }
 async launch(releasePath,raw={},{signal}={}){
  checkAbort(signal);const root=await this.root(releasePath),launch=launchDefinition(raw);
  if(launch.kind==='static')return this.staticLaunch(root,launch,signal);
  // A command can write caches, so run a fresh copy, never the release snapshot.
  const runRoot=path.join(this.dataRoot,'launches',randomUUID());await copyTree(root,runRoot,this.limits);
  try{return await this.commandLaunch(runRoot,launch,signal);}catch(error){await rm(runRoot,{recursive:true,force:true});throw error;}
 }
 async staticLaunch(root,launch,signal){
  const entry=await safeFile(root,launch.entry);if(!(await lstat(entry)).isFile())fail('실행할 정적 진입 파일이 없습니다.');
  const server=createServer(async(request,response)=>{
   try{
    if(!['127.0.0.1:'+server.address().port,'localhost:'+server.address().port].includes(request.headers.host)){response.writeHead(403);response.end();return;}
    if(!['GET','HEAD'].includes(request.method)){response.writeHead(405);response.end();return;}
    let pathname=decodeURIComponent(new URL(request.url,'http://127.0.0.1').pathname).slice(1);if(!pathname)pathname=launch.entry;
    const file=await safeFile(root,pathname),info=await lstat(file);if(!info.isFile())throw new Error('not file');
    const body=await readFile(file);response.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});response.end(request.method==='HEAD'?undefined:body);
   }catch{response.writeHead(404);response.end('Not found');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  let stopped=false;const stop=async()=>{if(stopped)return;stopped=true;signal?.removeEventListener('abort',abort);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};const abort=()=>{void stop();};signal?.addEventListener('abort',abort,{once:true});
  const url=`http://127.0.0.1:${server.address().port}/`;
  try{checkAbort(signal);const response=await fetch(url,{signal:AbortSignal.timeout(3000)});if(!response.ok)fail('정적 프로그램 실행 확인에 실패했습니다.');await response.arrayBuffer();return {url,stop,kind:'static'};}catch(error){await stop();throw error;}
 }
 async commandLaunch(root,launch,signal){
  for(const preparation of launch.prepare){checkAbort(signal);const result=await this.run(await resolveDevelopmentCommand(preparation.command),preparation.args,{cwd:root,signal,timeout:0,maxBytes:256*1024,env:executionEnvironment(root)});if(result.code!==0)fail('설정된 실행 준비 명령이 실패했습니다: '+redact(result.stderr||result.stdout));}
  checkAbort(signal);
  const template=launch.url.includes('{port}'),parsed=new URL(launch.url.replaceAll('{port}','4174'));
  const port=await freePort(template?0:Number(parsed.port||80)),url=launch.url.replaceAll('{port}',String(port));
  const executable=await resolveDevelopmentCommand(launch.command.command);
  const child=spawn(executable.command,[...executable.prefix,...launch.command.args.map(arg=>arg.replaceAll('{port}',String(port)))],{cwd:root,env:{...executionEnvironment(root),PORT:String(port),HOST:'127.0.0.1'},shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
  let output='',failure=null,closed=false,stopPromise;const closedPromise=new Promise(resolve=>child.once('close',()=>{closed=true;resolve();}));
  child.once('error',error=>{failure=error;});
  for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{if(Buffer.byteLength(output)<64000)output+=bytes.toString();});
  const stop=()=>stopPromise||=(async()=>{
   signal?.removeEventListener('abort',abort);
   if(child.pid){
    if(process.platform==='win32')await new Promise(resolve=>{const killer=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});killer.on('error',()=>{child.kill();resolve();});killer.on('close',resolve);});
    else{try{process.kill(-child.pid,'SIGKILL');}catch{}}
   }
   if(!closed)await closedPromise;await rm(root,{recursive:true,force:true});
  })();const abort=()=>{void stop();};signal?.addEventListener('abort',abort,{once:true});
  try{
   const deadline=Date.now()+this.startupTimeout;
   while(Date.now()<deadline){
    checkAbort(signal);if(failure||closed)fail('프로그램 시작 실패: '+redact(failure?.message||output||'프로세스가 종료되었습니다.'));
    try{const response=await fetch(url,{signal:AbortSignal.timeout(600),redirect:'error'});await response.arrayBuffer();if(response.ok&&!closed){checkAbort(signal);return {url,stop,kind:'command',pid:child.pid};}}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
   }
   fail('프로그램이 설정된 주소에서 실행 준비를 완료하지 못했습니다. '+redact(output));
  }catch(error){await stop();throw error;}
 }
}

const crcTable=Uint32Array.from({length:256},(_,value)=>{for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);return value>>>0;});
function zip(entries){
 const local=[],central=[];let offset=0,size=0;
 for(const entry of entries){const filename=Buffer.from('program/'+entry.name),body=entry.body;let crc=0xffffffff;for(const byte of body)crc=(crc>>>8)^crcTable[(crc^byte)&255];crc=(crc^0xffffffff)>>>0;
  const header=Buffer.alloc(30),directory=Buffer.alloc(46);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(33,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(body.length,18);header.writeUInt32LE(body.length,22);header.writeUInt16LE(filename.length,26);
  directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt16LE(33,14);directory.writeUInt32LE(crc,16);directory.writeUInt32LE(body.length,20);directory.writeUInt32LE(body.length,24);directory.writeUInt16LE(filename.length,28);directory.writeUInt32LE(offset,42);
  local.push(header,filename,body);central.push(directory,filename);offset+=30+filename.length+body.length;size+=46+filename.length;
 }
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(size,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,...central,end]);
}
function downloadLauncher(){return `import {createServer} from 'node:http';
import {readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const config=JSON.parse(await readFile(path.join(root,'_agent_desk_launch.json'),'utf8'));
const OMIT=new Set(${JSON.stringify([...OMIT])});
const MIME=${JSON.stringify(MIME)};
${fail.toString()}
${forbiddenPart.toString()}
${relative.toString()}
${safeFile.toString()}
${executionEnvironment.toString()}
${resolveDevelopmentCommand.toString()}
async function start(spec,env){const executable=await resolveDevelopmentCommand(spec.command);return spawn(executable.command,[...executable.prefix,...spec.args],{cwd:root,env,shell:false,stdio:'inherit'});}
if(config.kind==='command'){
 const env=executionEnvironment(root);
 for(const spec of config.prepare||[]){const child=await start(spec,env);await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error('실행 준비 명령 실패: '+spec.command)));});}
 const placeholder=config.url.includes('{port}'),parsed=new URL(config.url.replaceAll('{port}','4174'));
 const probe=createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(placeholder?0:Number(parsed.port||80),'127.0.0.1',resolve);});const port=probe.address().port;await new Promise(r=>probe.close(r));
 const ready=config.url.replaceAll('{port}',String(port));
 const child=await start({...config.command,args:config.command.args.map(arg=>arg.replaceAll('{port}',String(port)))},{...env,PORT:String(port),HOST:'127.0.0.1'});
 let closed=false,failed;child.on('error',error=>{failed=error;closed=true;});child.on('close',code=>{closed=true;process.exitCode=code||0;});
 const deadline=Date.now()+20000;let verified=false;
 while(Date.now()<deadline&&!closed){try{const response=await fetch(ready,{signal:AbortSignal.timeout(600),redirect:'error'});await response.arrayBuffer();if(response.ok&&!closed){verified=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
 if(!verified){child.kill();throw failed||new Error('프로그램 실행 준비를 확인하지 못했습니다.');}
 console.log('브라우저에서 여세요: '+ready);
}else{
 await safeFile(root,config.entry);
 const server=createServer(async(req,res)=>{try{if(!['127.0.0.1:'+server.address().port,'localhost:'+server.address().port].includes(req.headers.host))throw Error();const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||config.entry;const file=await safeFile(root,name),body=await readFile(file);res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});res.end(body);}catch{res.writeHead(404);res.end('Not found');}});
 server.listen(0,'127.0.0.1',()=>console.log('브라우저에서 여세요: http://127.0.0.1:'+server.address().port+'/'));
}
`;}
