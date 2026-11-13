import {spawn} from 'node:child_process';
import {access,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const AGENT_IDS=['codex','claude','agy'];
export async function resolveAgent(agent,{platform=process.platform,env=process.env,home=os.homedir()}={}){
  if(!AGENT_IDS.includes(agent))throw new Error('지원하지 않는 에이전트입니다.');
  const override=env[`AGENT_DESK_${agent.toUpperCase()}_BIN`];
  const localAppData=env.LOCALAPPDATA||path.join(home,'AppData','Local');
  const appData=env.APPDATA||path.join(home,'AppData','Roaming');
  const dirs=[...new Set([...(env.PATH||env.Path||'').split(platform==='win32'?';':':'),path.join(home,'.local','bin'),...(platform==='win32'?[path.join(appData,'npm'),...(agent==='agy'?[path.join(localAppData,'agy','bin')]:[])]:[])].map(dir=>dir.trim().replace(/^"|"$/g,'')).filter(Boolean))];
  // npm creates both a Unix shell shim and a Windows .cmd shim. Neither can be
  // spawned directly with shell:false on Windows: invoke the Node entry instead.
  const candidates=override?[override]:dirs.flatMap(dir=>platform==='win32'?[path.join(dir,agent+'.exe'),...(agent==='codex'?[path.join(dir,'node_modules','@openai','codex','bin','codex.js')]:agent==='claude'?[path.join(dir,'node_modules','@anthropic-ai','claude-code','cli.js')]:[])]:[path.join(dir,agent)]);
  for(const file of candidates){
    if(!path.isAbsolute(file)||/\.(cmd|bat|ps1)$/i.test(file)||(platform==='win32'&&!/\.(exe|[cm]?js)$/i.test(file)))continue;
    try{if(!(await stat(file)).isFile())continue;await access(file);return /\.[cm]?js$/i.test(file)?{command:process.execPath,prefix:[file]}:{command:file,prefix:[]};}catch{}
  }
  return null;
}
export function runProcess(executable,args,{input='',cwd,signal,timeout=0,maxBytes=4*1024*1024,env=process.env,onStdout}={}){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(new Error('요청을 취소했습니다.'));return;}
    const child=spawn(executable.command,[...executable.prefix,...args],{cwd,env,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',size=0,failure,killTimer;
    const kill=()=>{if(!child.pid)return;if(process.platform==='win32'){const killer=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill());killer.on('exit',code=>{if(code)child.kill();});}else{try{process.kill(-child.pid,'SIGTERM');}catch{}killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},800);killTimer.unref();}};
    const stop=(message,code)=>{if(failure)return;failure=Object.assign(new Error(message),{code});kill();};
    const abort=()=>stop('요청을 취소했습니다.');signal?.addEventListener('abort',abort,{once:true});
    const duration=timeout>=60000?(timeout/60000)+'분':(timeout/1000)+'초';
    const timer=timeout>0?setTimeout(()=>stop('응답 제한 시간 '+duration+'을 초과해 요청을 중단했습니다. 시간 초과만으로 로그인 실패나 모델 미지원을 판단할 수 없습니다. 진행 상태를 확인하고 최대 대기 시간을 늘리거나 추론 강도를 조정해 다시 요청해 주세요.','AGENT_TIMEOUT'),timeout):null;
    const clean=()=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);};
    child.on('error',error=>{clean();const failure=new Error(error.code==='ENOENT'?'CLI를 찾을 수 없습니다. 설치 후 실행기를 다시 시작해 주세요.':'CLI를 실행할 수 없습니다. 실행 파일과 권한을 확인해 주세요.');failure.code=error.code||'SPAWN_FAILED';reject(failure);});
    for(const [stream,key] of [[child.stdout,'out'],[child.stderr,'err']]){stream.setEncoding('utf8');stream.on('data',chunk=>{size+=Buffer.byteLength(chunk);if(size>maxBytes){stop('CLI 응답이 허용 크기를 초과했습니다.');return;}if(key==='out'){stdout+=chunk;onStdout?.(chunk);}else stderr+=chunk;});}
    child.stdin.on('error',()=>{});child.stdin.end(input);
    child.on('close',code=>{if(child.pid&&process.platform!=='win32'){try{process.kill(-child.pid,'SIGKILL');}catch{}}clean();if(failure){failure.processOutput=stdout;reject(failure);}else resolve({stdout,stderr,code});});
  });
}

// Read the official Codex model catalog; never start a thread or model turn.
export function readCodexModels(executable,{timeout=15000,signal}={}){
 if(signal?.aborted)return Promise.reject(new Error('모델 목록 확인을 취소했습니다.'));
 return new Promise((resolve,reject)=>{
  const child=spawn(executable.command,[...executable.prefix,'app-server'],{shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
  let done=false,buffer='',bytes=0,models=[],pages=0;const seen=new Set();
  const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);child.stdin.end();
   if(child.pid){if(process.platform==='win32'){const killer=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill());}else{try{process.kill(-child.pid,'SIGKILL');}catch{}}}
   error?reject(error):resolve(models);
  };
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  const next=cursor=>{pages++;send({id:pages,method:'model/list',params:{limit:100,includeHidden:false,...(cursor?{cursor}:{})}});};
  const timer=setTimeout(()=>finish(new Error('모델 목록 확인 시간이 초과되었습니다.')),timeout);
  const abort=()=>finish(new Error('모델 목록 확인을 취소했습니다.'));signal?.addEventListener('abort',abort,{once:true});
  child.on('error',()=>finish(new Error('Codex 모델 목록을 실행할 수 없습니다.')));child.on('close',()=>{if(!done)finish(new Error('Codex가 모델 목록을 반환하지 않았습니다.'));});
  child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>1024*1024){finish(new Error('모델 목록이 너무 큽니다.'));return;}buffer+=chunk;
   let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);let message;try{message=JSON.parse(line);}catch{continue;}
    if(message.id===undefined)continue;if(message.error){finish(new Error('Codex 모델 목록을 읽지 못했습니다. CLI 로그인을 확인해 주세요.'));return;}
    if(message.id===0){send({method:'initialized'});next();}
    else if(message.id===pages){if(!Array.isArray(message.result?.data)){finish(new Error('모델 목록 형식이 지원되지 않습니다.'));return;}models.push(...message.result.data);const cursor=message.result.nextCursor;if(cursor&&pages<5&&!seen.has(cursor)){seen.add(cursor);next(cursor);}else{finish();return;}}
   }
  });send({id:0,method:'initialize',params:{clientInfo:{name:'agent_desk',version:'0.9.2'}}});
 });
}

// Claude Agent SDK initialize handshake: only a control message, never a user
// prompt. Read the account's model capabilities without starting a model turn.
export async function readClaudeModels(executable,{timeout=20000,signal}={}){
 const {mkdtemp,rm}=await import('node:fs/promises');
 const cwd=await mkdtemp(path.join(os.tmpdir(),'agent-desk-catalog-'));
 try{return await new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(new Error('모델 목록 확인을 취소했습니다.'));return;}
  const child=spawn(executable.command,[...executable.prefix,'-p','--input-format','stream-json','--output-format','stream-json','--verbose','--safe-mode','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disable-slash-commands','--permission-mode','plan','--no-session-persistence'],{cwd,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
  let done=false,buffer='',bytes=0;
  const finish=(error,models)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);child.stdin.end();
   if(child.pid){if(process.platform==='win32'){const killer=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill());killer.on('exit',code=>{if(code)child.kill();});}else{try{process.kill(-child.pid,'SIGKILL');}catch{}}}
   error?reject(error):resolve(models);
  };
  const abort=()=>finish(new Error('모델 목록 확인을 취소했습니다.'));
  const timer=setTimeout(()=>finish(new Error('Claude 모델 목록 확인 시간이 초과되었습니다. 기본값은 계속 사용할 수 있습니다.')),timeout);
  signal?.addEventListener('abort',abort,{once:true});
  child.on('error',()=>finish(new Error('Claude 모델 목록을 실행할 수 없습니다.')));
  child.on('close',()=>{if(!done)finish(new Error('Claude가 모델 목록을 반환하지 않았습니다. CLI 로그인과 버전을 확인해 주세요.'));});
  child.stdin.on('error',()=>{});child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024*1024)finish(new Error('모델 목록이 너무 큽니다.'));});child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>1024*1024){finish(new Error('모델 목록이 너무 큽니다.'));return;}buffer+=chunk;
   let index;while(!done&&(index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);let message;try{message=JSON.parse(line);}catch{continue;}
    if(message.type!=='control_response'||message.response?.request_id!=='agent-desk-models')continue;
    const response=message.response;
    if(response.subtype==='error'||!Array.isArray(response.response?.models)){finish(new Error('Claude 모델 지원 정보를 읽지 못했습니다. 기본값으로 테스트하거나 CLI를 업데이트해 주세요.'));return;}
    finish(null,response.response.models);
   }
  });child.stdin.write(JSON.stringify({type:'control_request',request_id:'agent-desk-models',request:{subtype:'initialize',hooks:null}})+'\n');
 });}finally{await rm(cwd,{recursive:true,force:true}).catch(()=>{});}
}
