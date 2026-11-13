import {spawn} from 'node:child_process';
import {access,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export function parseBrowserChecks(raw){
 if(!raw||!Array.isArray(raw.checks)||raw.checks.length>30)throw new Error('agent-desk.checks.json에는 최대 30개의 checks가 필요합니다.');
 const string=(v,max)=>{if(typeof v!=='string'||v.length>max)throw new Error('브라우저 검사 문자열 형식이 올바르지 않습니다.');return v;};
 return raw.checks.map(c=>{
  if(!Array.isArray(c.steps)||c.steps.length>60||!Array.isArray(c.expect)||!c.expect.length||c.expect.length>20)throw new Error('검사 steps와 expect를 확인해 주세요.');
  const nodeIds=c.nodeIds??[];if(!Array.isArray(nodeIds)||nodeIds.length>100||nodeIds.some(id=>typeof id!=='string'||!/^[\w-]{1,80}$/.test(id)))throw new Error('검사의 관련 노드 ID를 확인해 주세요.');
  return {name:string(c.name,200),nodeIds,steps:c.steps.map(s=>{if(!['click','fill','select'].includes(s.action))throw new Error('지원하지 않는 브라우저 검사 동작입니다.');return {action:s.action,selector:string(s.selector,500),value:string(s.value??'',2000)};}),expect:c.expect.map(e=>{if(!['equals','contains'].includes(e.mode))throw new Error('검사 비교 방식은 equals 또는 contains입니다.');return {selector:string(e.selector,500),text:string(e.text,2000),mode:e.mode};})};
 });
}
async function browserExecutable(){
 const candidates=process.platform==='win32'?[...['PROGRAMFILES','PROGRAMFILES(X86)','LOCALAPPDATA'].flatMap(key=>process.env[key]?[path.join(process.env[key],'Microsoft','Edge','Application','msedge.exe'),path.join(process.env[key],'Google','Chrome','Application','chrome.exe')]:[])]:process.platform==='darwin'?['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']:['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/opt/google/chrome/chrome'];
 for(const candidate of candidates)try{await access(candidate);return candidate;}catch{}
 throw Object.assign(new Error('자동 화면 검사에 Chrome 또는 Edge가 필요합니다. 설치 후 검증을 다시 실행해 주세요.'),{unavailable:true});
}
// Dedicated temporary browser profile. The pipe is private to this process; no listening debug port.
export async function browserChecks(url,checks,{signal}={}){
 const executable=await browserExecutable(),profile=await mkdtemp(path.join(os.tmpdir(),'agent-desk-browser-'));
 let child,sequence=0,buffer='',failure=null;const events=new Map(),requests=new Map(),results=[],runtimeErrors=[];
 const failAll=error=>{failure=error;for(const {reject,timer} of requests.values()){clearTimeout(timer);reject(error);}requests.clear();for(const {reject,timer} of events.values()){clearTimeout(timer);reject(error);}events.clear();};
 const abort=()=>{failAll(new Error('브라우저 검사가 취소되었습니다.'));child?.kill();};
 const waitEvent=(sessionId,method)=>new Promise((resolve,reject)=>{const key=sessionId+':'+method,timer=setTimeout(()=>{events.delete(key);reject(Object.assign(new Error('페이지 준비 시간이 초과되었습니다.'),{unavailable:true}));},15000);events.set(key,{resolve,reject,timer});});
 const command=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
  if(failure||signal?.aborted){reject(failure||new Error('검사가 취소되었습니다.'));return;}
  const id=++sequence,timer=setTimeout(()=>{requests.delete(id);reject(Object.assign(new Error('브라우저 검사 응답 시간이 초과되었습니다.'),{unavailable:true}));},15000);
  requests.set(id,{resolve,reject,timer});child.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');
 });
 try{
  if(signal?.aborted)throw new Error('검사가 취소되었습니다.');
  child=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions',...(process.platform==='linux'&&process.getuid?.()===0?['--no-sandbox']:[]),'--user-data-dir='+profile,'--remote-debugging-pipe','about:blank'],{stdio:['ignore','ignore','ignore','pipe','pipe'],windowsHide:true});
  child.once('error',error=>failAll(Object.assign(error,{unavailable:true})));child.once('exit',()=>failAll(Object.assign(new Error('검사 브라우저가 종료되었습니다.'),{unavailable:true})));
  signal?.addEventListener('abort',abort,{once:true});child.stdio[3].on('error',failAll);
  child.stdio[4].on('data',chunk=>{buffer+=chunk.toString();if(buffer.length>2000000){failAll(new Error('브라우저 검사 응답이 너무 큽니다.'));child.kill();return;}let index;while((index=buffer.indexOf('\0'))>=0){const raw=buffer.slice(0,index);buffer=buffer.slice(index+1);let message;try{message=JSON.parse(raw);}catch{continue;}const eventKey=message.sessionId+':'+message.method,event=events.get(eventKey);if(event){events.delete(eventKey);clearTimeout(event.timer);event.resolve(message.params);}if(message.method==='Runtime.exceptionThrown')runtimeErrors.push(message.params.exceptionDetails.text||'JavaScript exception');const pending=requests.get(message.id);if(pending){clearTimeout(pending.timer);requests.delete(message.id);message.error?pending.reject(new Error(message.error.message)):pending.resolve(message.result);}}});
  for(const check of checks){
   const startErrors=runtimeErrors.length;let targetId;
   try{
    ({targetId}=await command('Target.createTarget',{url:'about:blank'}));const {sessionId}=await command('Target.attachToTarget',{targetId,flatten:true});
    await command('Runtime.enable',{},sessionId);await command('Page.enable',{},sessionId);await Promise.all([waitEvent(sessionId,'Page.loadEventFired'),command('Page.navigate',{url},sessionId)]);
    const expression=`(async()=>{const check=${JSON.stringify(check)};const wait=ms=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<100&&document.readyState!=='complete';i++)await wait(50);const find=async selector=>{for(let i=0;i<40;i++){const el=document.querySelector(selector);if(el)return el;await wait(50);}throw new Error('요소 없음: '+selector);};for(const step of check.steps){const el=await find(step.selector);if(step.action==='click')el.click();else{el.value=step.value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}await wait(25);}for(const expected of check.expect){const el=await find(expected.selector);let actual;for(let i=0;i<40;i++){actual=String('value' in el?el.value:el.textContent).trim();if(expected.mode==='equals'?actual===expected.text:actual.includes(expected.text))break;await wait(50);}if(!(expected.mode==='equals'?actual===expected.text:actual.includes(expected.text)))throw new Error(expected.selector+' 예상: '+expected.text+' / 실제: '+actual);}return '브라우저에서 입력·결과 확인 완료';})()`;
    const evaluated=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);
    if(evaluated.exceptionDetails)throw new Error(evaluated.exceptionDetails.exception?.description||evaluated.exceptionDetails.text);
    if(runtimeErrors.length>startErrors)throw new Error('페이지 JavaScript 오류: '+runtimeErrors.slice(startErrors).join('; '));
    results.push({label:check.name,passed:true,exitCode:0,output:evaluated.result.value});
   }catch(error){if(signal?.aborted)throw error;results.push({label:check.name,passed:false,exitCode:error.unavailable?null:1,failureKind:error.unavailable?'environment':'assertion',output:error.message});}
   finally{if(targetId&&!failure)await command('Target.closeTarget',{targetId}).catch(()=>{});}
  }
  return results;
 }finally{
  signal?.removeEventListener('abort',abort);failAll(new Error('검사 종료'));
  if(child?.pid){const stopped=new Promise(resolve=>child.once('exit',resolve));if(child.exitCode===null){child.kill();await Promise.race([stopped,new Promise(resolve=>setTimeout(resolve,2000))]);}}
  await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});
 }
}
