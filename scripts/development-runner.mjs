import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {DevelopmentWorkspace} from './development-workspace.mjs';
import {validateDevelopment,prepareDevelopmentTasks,planPartialRetry,resolveRoles,rotateRoles,STRATEGIES,dependencyReady} from '../public/development-core.js';
import {validateSettings} from '../public/agent-settings.js';
import {parseDevelopmentResponse} from './development-schemas.mjs';
import {normalizeExecutionMeta,executionOrder} from '../public/execution-order.js';

const now=()=>new Date().toISOString();
const clone=value=>structuredClone(value);
const id=value=>{if(typeof value!=='string'||! /^[\w-]{1,80}$/.test(value)||['__proto__','constructor','prototype'].includes(value))throw problem('프로젝트 또는 작업 ID를 확인해 주세요.');return value;};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const problem=(message,status=400)=>Object.assign(new Error(message),{status,safe:true});
const aborted=()=>Object.assign(new Error('요청이 취소되었습니다.'),{name:'AbortError',safe:true});
const checkAbort=signal=>{if(signal?.aborted)throw aborted();};
const redact=value=>String(value??'').replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})\b/g,'[비밀값 숨김]').replace(/(authorization\s*[:=]\s*|bearer\s+|(?:api[_-]?key|(?:access[_-]?)?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi,'$1[비밀값 숨김]');
const redactObject=value=>typeof value==='string'?redact(value):Array.isArray(value)?value.map(redactObject):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,redactObject(item)])):value;
const errorText=error=>error?.safe?redact(error.message):'작업을 완료하지 못했습니다. 실행 환경·AI 연결·검사 설정을 확인한 뒤 해당 작업만 다시 실행해 주세요.';
const initial=projectId=>({projectId,revision:0,status:'idle',activeAttemptId:null,attempts:[],tasks:[],events:[],releases:[],latestRunnableId:null,error:null,requests:{},cancelledRequests:[],workingPath:null,fileAuthors:{}});
const terminal=status=>['succeeded','failed','cancelled'].includes(status);
const open=task=>(task.findings??[]).filter(f=>f.status==='open');
function baselineContext(baseline,taskId){
 const snapshot=baseline?.snapshot??{},related=new Set([taskId,snapshot.rootId]);let next=true;
 const edges=[...(snapshot.edges??[]),...(snapshot.nodes??[]).filter(node=>node.parentId).map(node=>({from:node.parentId,to:node.id}))];
 while(next){next=false;for(const edge of edges)if(related.has(edge.to)&&!related.has(edge.from)){related.add(edge.from);next=true;}}
 return {nodes:(snapshot.nodes??[]).filter(node=>related.has(node.id)),edges:edges.filter(edge=>related.has(edge.from)&&related.has(edge.to)),items:(snapshot.items??[]).filter(item=>!Array.isArray(item.nodeIds)||!item.nodeIds.length||item.nodeIds.some(nodeId=>related.has(nodeId)))};
}

function submission(raw){
 if(!raw||typeof raw!=='object')throw problem('개발 요청 내용을 확인해 주세요.');
 id(raw.requestId);if(raw.requestId.length<8)throw problem('요청 ID는 8자 이상이어야 합니다.');
 const project=raw.project;if(!project||typeof project!=='object')throw problem('프로젝트 정보가 필요합니다.');
 id(project.id);for(const key of ['name','path','instructions'])if(project[key]!==undefined&&(typeof project[key]!=='string'||project[key].length>(key==='instructions'?20000:2000)))throw problem('프로젝트 정보의 크기 또는 형식을 확인해 주세요.');
 if(!project.path?.trim()||!path.isAbsolute(project.path))throw problem('프로젝트의 현재 PC 작업 폴더를 절대 경로로 지정해 주세요.');
 const config=validateDevelopment(raw.config),tasks=prepareDevelopmentTasks(raw.baseline,raw.handoff,config);
 if(!tasks.length)throw problem('저장된 업무 분담안에 개발할 작업이 없습니다.');
 const agentSettings={};for(const provider of ['codex','claude','agy'])agentSettings[provider]=validateSettings(provider,raw.agentSettings?.[provider]??{});
 const selected=raw.selection?.taskIds;
 if(selected!==undefined&&(!Array.isArray(selected)||selected.length>100||selected.some(item=>typeof item!=='string'||!tasks.some(task=>task.id===item))||new Set(selected).size!==selected.length))throw problem('다시 실행할 작업을 확인해 주세요.');
 const input={requestId:raw.requestId,project:{id:project.id,name:project.name??'',path:project.path,instructions:project.instructions??''},baseline:clone(raw.baseline),handoff:clone(raw.handoff),config,agentSettings,retry:raw.retry===true,...(selected?{selection:{taskIds:[...selected]}}:{})};
 if(JSON.stringify(input).length>500000)throw problem('개발 요청이 너무 큽니다. 기획과 업무 범위를 나누어 주세요.');
 return {input,tasks};
}

/** Durable orchestrator. Provider processes receive text, never a writable project directory. */
export class DevelopmentRunner{
 constructor({agentRunner,workspace,dataRoot=path.join(os.homedir(),'.agent-desk','development'),pollMs=75}={}){
  if(!agentRunner)throw new Error('agentRunner is required');
  this.agentRunner=agentRunner;this.dataRoot=dataRoot;this.workspace=workspace??new DevelopmentWorkspace({dataRoot:path.join(dataRoot,'workspaces')});this.pollMs=pollMs;
  this.providerQueues=new Map();this.publishQueues=new Map();this.states=new Map();this.loading=new Map();this.writes=new Map();this.locks=new Map();this.runs=new Map();this.launches=new Map();this.launchRequests=new Map();this.closed=false;
 }
 async _exclusive(projectId,fn){const prior=this.locks.get(projectId)??Promise.resolve();const next=prior.catch(()=>{}).then(fn);this.locks.set(projectId,next);try{return await next;}finally{if(this.locks.get(projectId)===next)this.locks.delete(projectId);}}
 async _load(projectId){
  id(projectId);if(this.states.has(projectId))return this.states.get(projectId);if(this.loading.has(projectId))return this.loading.get(projectId);
  const pending=(async()=>{let state;try{state=JSON.parse(await readFile(path.join(this.dataRoot,projectId+'.json'),'utf8'));if(state.projectId!==projectId||!Array.isArray(state.tasks)||!Array.isArray(state.attempts))throw problem('저장된 개발 기록을 복구해야 합니다.',409);}catch(error){if(error.code!=='ENOENT')throw problem('저장된 개발 기록을 읽지 못했습니다. 기록 파일과 접근 권한을 확인해 주세요.',409);state=initial(projectId);}
   state.requests??={};state.cancelledRequests??=[];state.fileAuthors??={};this.states.set(projectId,state);
   if(['running','cancelling'].includes(state.status)){
    state.status='interrupted';state.error='실행기가 종료되어 작업이 중단되었습니다. 기록을 확인한 뒤 필요한 작업만 다시 실행해 주세요.';
    const attempt=state.attempts.find(a=>a.id===state.activeAttemptId);if(attempt){attempt.status='interrupted';attempt.finishedAt=now();}
    for(const task of state.tasks)if(task.status==='running'){task.status='partial';task.error=state.error;}
    for(const call of state.aiCalls||[])if(['running','queued'].includes(call.status)){call.status='interrupted';call.finishedAt=now();}
    state.activeAttemptId=null;this._event(state,'interrupted',state.error);await this._persist(state);
   }return state;
  })().finally(()=>this.loading.delete(projectId));this.loading.set(projectId,pending);return pending;
 }
 _persist(state){
  state.revision++;const content=JSON.stringify(state);const prior=this.writes.get(state.projectId)??Promise.resolve();
  const next=prior.catch(()=>{}).then(async()=>{await mkdir(this.dataRoot,{recursive:true,mode:0o700});const target=path.join(this.dataRoot,state.projectId+'.json'),temporary=target+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,content,{mode:0o600,flag:'wx'});await rename(temporary,target);}finally{await rm(temporary,{force:true}).catch(()=>{});}});
  this.writes.set(state.projectId,next);return next;
 }
 _event(state,type,message,extra={}){state.events.push({id:randomUUID(),at:now(),type,message:redact(message),...extra});}
 _view(state){
  const copy=clone(state);delete copy.requests;delete copy.cancelledRequests;delete copy.workingPath;delete copy.fileAuthors;
  for(const attempt of copy.attempts){delete attempt.input;delete attempt.inputHash;delete attempt.workspacePath;}
  for(const release of copy.releases)delete release.path;
  for(const task of copy.tasks){delete task.candidatePath;delete task.auditPath;}
  return copy;
 }
 async get(projectId){const state=await this._load(projectId),view=this._view(state);view.observedAt=now();view.aiCalls=(state.aiCalls||[]).map(call=>{const job=call.jobId?this.agentRunner.get(call.jobId):null;return {...call,...(job?{status:['failed','cancelled','succeeded','interrupted'].includes(call.status)?call.status:job.status,startedAt:job.startedAt||call.startedAt,finishedAt:job.finishedAt||call.finishedAt,activity:job.activity,process:job.process,progress:job.progress,usage:job.usage,actualModel:job.actualModel,outputIdleMs:job.outputIdleMs}:{}),error:call.error};});return view;}
 async preview(payload){
  const {input,tasks}=submission(payload),state=await this._load(input.project.id);return {projectId:state.projectId,strategy:input.config.strategy,entries:this._plan(state,input,tasks)};
 }
 _mergeTasks(state,prepared){return prepared.map(task=>{const old=state.tasks.find(item=>item.id===task.id);return old?{...old,title:task.title,...normalizeExecutionMeta(task),criteria:task.criteria,instructions:task.instructions,deliverable:task.deliverable,builder:task.builder,auditor:task.auditor,challenger:task.challenger,agent:task.agent}:task;});}
 _plan(state,input,prepared){
  const tasks=this._mergeTasks(state,prepared);let entries=state.attempts.length?planPartialRetry(tasks,{strategy:input.config.strategy}):tasks.map(task=>({taskId:task.id,action:'build',reason:'아직 개발하지 않은 작업을 실행합니다.'}));
  if(state.attempts.length){const previous=state.attempts.at(-1).input;
   entries=entries.map(entry=>{const task=tasks.find(t=>t.id===entry.taskId),old=state.tasks.find(t=>t.id===entry.taskId);if(task.disposition!=='open'||!old)return entry;
    const changed=old.criteria!==task.criteria||old.instructions!==task.instructions||old.deliverable!==task.deliverable||hash(normalizeExecutionMeta(old))!==hash(normalizeExecutionMeta(task))||previous?.project.instructions!==input.project.instructions||hash(baselineContext(previous?.baseline,task.id))!==hash(baselineContext(input.baseline,task.id));
    if(changed)return {taskId:task.id,action:'build',reason:'이 작업의 확정 기획·답변·완료 기준 또는 공통 지침이 변경되었습니다.'};
    if(input.retry&&task.artifactSha&&task.checks?.some(c=>!c.passed&&(c.exitCode===null||c.failureKind==='environment')))return {taskId:task.id,action:'verify',reason:'환경 준비 여부를 다시 확인합니다. 기존 구현을 다시 만들지 않습니다.'};
    if(task.status==='passed'&&hash(previous?.config.checks)!==hash(input.config.checks))return {taskId:task.id,action:'verify',reason:'실행 검사 설정이 변경되어 구현을 보존하고 다시 검증합니다.'};return entry;
   });
  }
  if(input.selection?.taskIds){const selected=new Set(input.selection.taskIds);entries=entries.map(entry=>selected.has(entry.taskId)?entry:{taskId:entry.taskId,action:'keep',reason:'이번 실행에서 선택하지 않은 작업을 보존합니다.'});}
  const changed=new Set(entries.filter(entry=>entry.action==='build').map(entry=>entry.taskId));let advanced=true;
  while(advanced){advanced=false;for(const task of tasks)if(task.dependsOn.some(parent=>changed.has(parent))&&!changed.has(task.id)){changed.add(task.id);advanced=true;}}
  entries=entries.map(entry=>{const task=tasks.find(t=>t.id===entry.taskId);return changed.has(task.id)&&task.status==='passed'&&task.disposition==='open'&&entry.action==='keep'?{taskId:task.id,action:'verify',reason:'변경될 선행 작업의 영향을 검증합니다. 기존 구현을 보존합니다.'}:entry;});
  // Re-evaluate downstream holds after the upstream plan/decisions changed.
  let released=true;while(released){released=false;for(const entry of entries){const task=tasks.find(t=>t.id===entry.taskId);if(entry.action!=='wait'||task.status!=='blocked'||task.retryable!==true||task.dependencyIssues.length||open(task).some(f=>f.type==='spec'))continue;if(task.dependsOn.every(id=>{const parent=tasks.find(t=>t.id===id),planned=entries.find(e=>e.taskId===id);return ['build','verify'].includes(planned?.action)||(planned?.action==='keep'&&dependencyReady(parent));})){entry.action=task.artifactSha?'verify':'build';entry.reason='선행 작업의 변경·재실행 계획을 반영해 대기 조건을 다시 평가했습니다.';released=true;}}}
  // Removed prerequisites remain an explicit hold, not a newly independent task.
  // This also applies to previously successful work and explicitly selected retries.
  const held=new Set(tasks.filter(task=>task.dependencyIssues.length).map(task=>task.id));let spread=true;
  while(spread){spread=false;for(const task of tasks)if(!held.has(task.id)&&task.dependsOn.some(parent=>held.has(parent))){held.add(task.id);spread=true;}}
  return entries.map(entry=>{if(!held.has(entry.taskId))return entry;const task=tasks.find(t=>t.id===entry.taskId);return {taskId:task.id,action:'wait',reason:task.dependencyIssues.length?'선행 관계를 먼저 확인해야 합니다: '+task.dependencyIssues.join(' · '):'선행 작업의 삭제·병합 영향을 먼저 확인해야 합니다. 기존 검토 결과만으로 완료 처리하지 않습니다.'};});
 }
 async start(payload){
  const {input,tasks}=submission(payload);if(this.closed)throw problem('실행기가 종료 중입니다.',409);
  return this._exclusive(input.project.id,async()=>{
   const state=await this._load(input.project.id),fingerprint=hash(input),previous=state.requests[input.requestId];
   if(previous){if(previous.hash!==fingerprint)throw problem('같은 요청 ID에 다른 개발 내용이 전달되었습니다.',409);return this._view(state);}
   if(state.cancelledRequests.includes(input.requestId)){state.requests[input.requestId]={hash:fingerprint,status:'cancelled'};await this._persist(state);return this._view(state);}
   const settling=this.runs.get(state.projectId);
   if(settling&&!['running','cancelling'].includes(state.status))await settling.done;
   if(this.runs.has(state.projectId)||['running','cancelling'].includes(state.status))throw problem('진행 중인 개발을 완료하거나 취소한 뒤 다른 방식을 실행해 주세요.',409);
   const entries=this._plan(state,input,tasks),attempt={id:randomUUID(),requestId:input.requestId,inputHash:fingerprint,input,baseline:{id:input.baseline.id,number:input.baseline.number},strategy:input.config.strategy,lead:input.config.lead,roles:resolveRoles(input.config),limits:clone(input.config.limits),status:'running',createdAt:now(),finishedAt:null,revisionCount:0,reviewCount:0,switchCount:0,taskCounts:{},plan:entries};
   state.tasks=this._mergeTasks(state,tasks);state.attempts.push(attempt);state.requests[input.requestId]={hash:fingerprint,attemptId:attempt.id};state.status='running';state.activeAttemptId=attempt.id;state.error=null;
   this._event(state,'started','선택한 협업 방식으로 개발·검토를 시작했습니다.',{attemptId:attempt.id,strategy:attempt.strategy,lead:attempt.lead});
   const operation={controller:new AbortController(),jobs:new Set(),done:null};this.runs.set(state.projectId,operation);
   try{await this._persist(state);}catch(error){this.runs.delete(state.projectId);throw error;}
   operation.done=Promise.resolve().then(()=>this._execute(state,attempt,operation)).finally(()=>{if(this.runs.get(state.projectId)===operation)this.runs.delete(state.projectId);});
   return this._view(state);
  });
 }
 async cancel(projectId,{requestId}={}){
  id(projectId);if(requestId!==undefined)id(requestId);
  return this._exclusive(projectId,async()=>{const state=await this._load(projectId);if(requestId&&!state.cancelledRequests.includes(requestId))state.cancelledRequests.push(requestId);
   const operation=this.runs.get(projectId),attempt=state.attempts.find(a=>a.id===state.activeAttemptId);
   for(const [key,pending] of this.launchRequests)if(key.startsWith(projectId+':')&&(!requestId||pending.requestIds.has(requestId))){
    pending.controller.abort();for(const pendingId of pending.requestIds)if(!state.cancelledRequests.includes(pendingId))state.cancelledRequests.push(pendingId);
   }
   // A launch may become ready just before its HTTP response reaches the UI.
   // Cancellation of that exact request must also stop the newly started process.
   if(requestId)for(const [key,launched] of this.launches)if(key.startsWith(projectId+':')&&launched.requestIds?.has(requestId)){await launched.stop();this.launches.delete(key);}
   if(operation&&(!requestId||attempt?.requestId===requestId)){state.status='cancelling';operation.controller.abort();for(const job of operation.jobs)this.agentRunner.cancel(job);this._event(state,'cancelling','현재 AI 요청과 실행 검사를 취소하고 있습니다.');}
   else if(!operation&&!state.attempts.length)state.status='cancelled';await this._persist(state);return this._view(state);
  });
 }
 async accept(projectId,{taskId,findingId,reason}={}){
  id(taskId);if(typeof reason!=='string'||!reason.trim()||reason.length>3000)throw problem('남은 한계를 수용하는 이유를 입력해 주세요.');
  return this._exclusive(projectId,async()=>{const state=await this._load(projectId);if(this.runs.has(projectId))throw problem('진행 중인 요청이 끝난 뒤 남은 한계를 기록해 주세요.',409);
   const task=state.tasks.find(t=>t.id===taskId);if(!task)throw problem('작업을 찾지 못했습니다.',404);
   const targets=findingId?task.findings.filter(f=>f.id===findingId):open(task);if(findingId&&!targets.length)throw problem('지적을 찾지 못했습니다.',404);
   if(targets.some(f=>f.severity==='critical'||(f.type==='implementation'&&f.severity==='high')||f.id.includes('-HOST-')))throw problem('필수 실행 검사나 핵심 구현 오류는 수용으로 통과 처리할 수 없습니다. 먼저 해결해야 합니다.',409);
   for(const finding of targets){finding.status='accepted';finding.acceptanceReason=redact(reason);finding.acceptedAt=now();}
   if(!findingId||!open(task).length)task.disposition='accepted';this._event(state,'accepted','사용자가 남은 한계를 수용했습니다. 기존 검토 판정은 변경하지 않았습니다.',{taskId,reason:redact(reason)});await this._persist(state);return this._view(state);
  });
 }
 async _queue(map,key,fn){const prior=map.get(key)||Promise.resolve();const next=prior.catch(()=>{}).then(fn);map.set(key,next);try{return await next;}finally{if(map.get(key)===next)map.delete(key);}}
 async _ai(state,attempt,operation,provider,kind,payload,task){
  const call={id:randomUUID(),attemptId:attempt.id,agent:provider,kind,role:payload.role,taskId:task?.id||null,status:'queued',requestedAt:now()};state.aiCalls??=[];state.aiCalls.push(call);await this._persist(state);
  return this._queue(this.providerQueues,provider,async()=>{
   let job,onAbort;
   try{
    checkAbort(operation.controller.signal);
    payload={...payload,decisionPolicy:'Adopted baseline AI defaults are concrete implementation requirements. Preserve explicit user answers. Isolate truly missing external facts; implement independent functionality. Do not relabel adopted defaults as unresolved specifications.'};
    const prompt=JSON.stringify(payload);if(prompt.length>145000)throw problem('코드와 기획 문맥이 AI 요청 크기를 초과합니다. 작업 범위를 나누어 주세요.');
    // Planning jobs use the same provider process pool. Wait rather than fail a task.
    while([...this.agentRunner.jobs?.values()||[]].some(j=>j.agent===provider&&!j.settled&&(j.status==='running'||j.settled===false))){checkAbort(operation.controller.signal);await delay(this.pollMs);}
    job=this.agentRunner.create({agent:provider,kind,prompt,requestId:randomUUID(),settings:attempt.input.agentSettings[provider],context:{projectId:state.projectId,taskId:task?.id,role:payload.role}});
    Object.assign(call,{jobId:job.id,status:'running',startedAt:now()});if(task)task.phase=kind==='development-build'?'구현 중':kind==='development-audit'?'검토 중':'분석 중';
    operation.jobs.add(job.id);this._event(state,'agent-start',`${provider} ${kind.replace('development-','')} 요청을 실행합니다.`,{taskId:task?.id??null,agent:provider,jobId:job.id});await this._persist(state);
    onAbort=()=>this.agentRunner.cancel(job.id);operation.controller.signal.addEventListener('abort',onAbort,{once:true});if(operation.controller.signal.aborted)onAbort();
    while(!terminal(job.status)){await delay(this.pollMs);job=this.agentRunner.get(job.id);if(!job)throw problem('AI 요청 기록을 찾지 못했습니다.');}
    await this.agentRunner.jobs?.get(job.id)?.done;checkAbort(operation.controller.signal);
    Object.assign(call,{usage:job.usage,actualModel:job.actualModel,activity:job.activity,progress:job.progress});
    if(job.status!=='succeeded')throw problem(job.error||'AI 응답을 완료하지 못했습니다. 연결·사용량·모델 설정을 확인해 주세요.');
    const result=parseDevelopmentResponse(job.result,kind);call.status='succeeded';this._event(state,'agent-complete',`${provider} 응답을 받았습니다.`,{taskId:task?.id??null,agent:provider,jobId:job.id});return result;
   }catch(error){call.status=operation.controller.signal.aborted?'cancelled':'failed';call.error=errorText(error);throw error;}
   finally{call.finishedAt=now();if(onAbort)operation.controller.signal.removeEventListener('abort',onAbort);if(job)operation.jobs.delete(job.id);await this._persist(state);}
  });
 }
 async _publish(state,attempt,operation,task,base,result){
  return this._queue(this.publishQueues,state.projectId,async()=>{
   checkAbort(operation.controller.signal);const latest=await this.workspace.context(state.workingPath),before=new Map(base.files.map(f=>[f.path,f.content])),current=new Map(latest.files.map(f=>[f.path,f.content]));
   const conflicts=result.files.filter(f=>before.get(f.path)!==current.get(f.path)&&current.get(f.path)!==(f.action==='delete'?undefined:f.content));
   if(conflicts.length)throw Object.assign(problem('다른 작업과 변경 파일이 겹쳐 최신 코드로 다시 구현합니다: '+conflicts.map(f=>f.path).join(', ')),{mergeConflict:true});
   const candidate=await this.workspace.create({projectId:state.projectId,sourcePath:attempt.input.project.path,previousPath:state.workingPath,attemptId:randomUUID()});
   const applied=await this.workspace.apply(candidate,result.files);checkAbort(operation.controller.signal);const codeSha=await this.workspace.commit(candidate,`Agent Desk ${task.id} ${task.builder}`);state.workingPath=candidate.path;return {candidate,applied,codeSha};
  });
 }
 _finding(task,attempt,source,raw,index){return {id:`${task.id}-${attempt.id.slice(0,8)}-${source}-${index+1}`,taskId:task.id,type:raw.type,severity:raw.severity,status:'open',summary:redact(raw.summary),evidence:redact(raw.evidence),remedy:redact(raw.remedy)};}
 async _analysis(state,attempt,operation,task,phase,provider=task.challenger){
  const result=await this._ai(state,attempt,operation,provider,'development-analysis',{role:phase,lead:attempt.lead,task:{id:task.id,title:task.title,instructions:task.instructions,criteria:task.criteria,...normalizeExecutionMeta(task)},baseline:attempt.input.baseline,findings:open(task),checks:task.checks,rule:'Analyze evidence and options. Do not change requirements, claim audit approval, or invent executable checks. Follow adopted defaults. Truly missing external facts affect their related tasks only. Recommend one next step.'},task);
  task.analyses??=[];task.analyses.push({at:now(),phase,agent:provider,summary:redact(result.summary),recommendation:redact(result.recommendation),risks:result.risks.map((f,i)=>this._finding(task,attempt,'ANALYSIS',f,i))});await this._persist(state);return result;
 }
 async _execute(state,attempt,operation){
  const signal=operation.controller.signal;
  try{
   checkAbort(signal);const workspace=await this.workspace.create({projectId:state.projectId,sourcePath:attempt.input.project.path,attemptId:attempt.id,previousPath:state.workingPath||undefined});checkAbort(signal);state.workingPath=workspace.path;attempt.workspacePath=workspace.path;await this._persist(state);
   const entries=new Map(attempt.plan.map(entry=>[entry.taskId,entry])),pending=new Set(attempt.plan.filter(entry=>['build','verify','analyze'].includes(entry.action)).map(entry=>entry.taskId));
   for(const entry of attempt.plan)if(entry.action==='wait'){const task=state.tasks.find(t=>t.id===entry.taskId);task.status='blocked';task.error=entry.reason;}
   while(pending.size){
    checkAbort(signal);const ready=executionOrder(state.tasks).filter(task=>pending.has(task.id)&&!task.dependsOn.some(parent=>pending.has(parent))).slice(0,attempt.input.config.maxParallel);
    if(!ready.length){for(const taskId of pending){const task=state.tasks.find(t=>t.id===taskId);task.status='blocked';task.error='선행 작업을 확인해야 합니다.';}break;}
    this._event(state,'wave-start',`독립 작업 ${ready.length}개를 진행합니다. 같은 AI 요청은 순서대로 처리합니다.`,{taskIds:ready.map(t=>t.id)});
    const outcomes=await Promise.allSettled(ready.map(async task=>{
     pending.delete(task.id);
     try{await this._task(state,attempt,operation,task,entries.get(task.id).action);}
     catch(error){if(signal.aborted||error.name==='AbortError')throw error;task.status=task.artifactSha?'partial':'failed';task.error=errorText(error);this._event(state,'task-error',task.error,{taskId:task.id});await this._persist(state);}
    }));
    checkAbort(signal);for(const outcome of outcomes)if(outcome.status==='rejected')throw outcome.reason;
    await this._release(state,attempt,operation);
   }
   checkAbort(signal);
   // The final artifact can include later edits. Never attach an earlier audit to its SHA.
   const finalSha=await this.workspace.commit(state.workingPath,'Agent Desk final source');
   for(const task of state.tasks.filter(task=>task.status==='passed'&&task.audit?.codeSha!==finalSha)){
    const counts=attempt.taskCounts[task.id],round=counts?.rounds.at(-1);
    if(round&&round.reviews>=attempt.limits.maxReviews){task.status='limited';task.retryable=true;task.findings.push(this._finding(task,attempt,'FINAL',{type:'unverified',severity:'medium',summary:'마지막 통합 코드의 추가 검토가 필요합니다.',evidence:'기존 검토 이후 다른 작업의 코드가 반영되었고 이번 조합의 검토 한도에 도달했습니다.',remedy:'이 작업의 검증만 다시 실행하거나 검토 한도를 늘려 주세요.'},0));continue;}
    try{await this._task(state,attempt,operation,task,'verify');}catch(error){if(signal.aborted)throw error;task.status='limited';task.error=errorText(error);}
   }
   // A downstream task may already have an audit for finalSha and therefore be
   // absent from the loop above. A failed prerequisite still invalidates its
   // readiness; preserve the original audit as evidence rather than rewriting it.
   for(const task of executionOrder(state.tasks))if(task.status==='passed'){
    const blocked=task.dependsOn.find(parent=>!dependencyReady(state.tasks.find(other=>other.id===parent)));
    if(blocked){task.status='blocked';task.needsVerification=true;task.retryable=true;task.error=`선행 작업 ${state.tasks.find(t=>t.id===blocked)?.title||blocked}의 필수 결과물을 확인해야 합니다.`;this._event(state,'verification-invalidated',task.error,{taskId:task.id,changedBy:blocked});}
   }
   if(state.tasks.some(t=>t.status!=='passed')||!state.latestRunnableId)await this._assembleDraft(state,attempt,operation);
   await this._release(state,attempt,operation);
   try{const report=await this._ai(state,attempt,operation,attempt.lead,'development-analysis',{role:'overall-lead',strategy:attempt.strategy,baseline:attempt.baseline,runnableRelease:state.releases.find(r=>r.id===state.latestRunnableId)?{id:state.latestRunnableId,stage:state.releases.find(r=>r.id===state.latestRunnableId).stage}:null,tasks:state.tasks.map(t=>({id:t.id,title:t.title,status:t.status,readiness:t.readiness,findings:open(t),checks:t.checks})),rule:'Summarize the actually runnable draft, separately from complete verification. Explain usable functionality, isolated missing features, and next alternatives. Partial implementation and self-review do not mean the whole project must stop. Summarize integration status, unresolved limitations and next steps. Do not override task verdicts or invent verification.'});attempt.summary=redact(report.summary);attempt.recommendation=redact(report.recommendation);}catch(error){if(signal.aborted)throw error;attempt.summary='총괄 요약을 받지 못했습니다. 개별 작업과 검사 기록을 확인해 주세요.';}
   state.status='completed';attempt.status='completed';this._event(state,'completed','개발·검토 실행이 끝났습니다. 개별 판정과 실행 가능한 버전의 한계를 확인해 주세요.');
  }catch(error){state.status=signal.aborted?'cancelled':'interrupted';attempt.status=state.status;state.error=signal.aborted?null:errorText(error);for(const task of state.tasks)if(task.status==='running'){task.status=task.artifactSha?'partial':'pending';task.error=signal.aborted?'요청을 취소했습니다.':state.error;}this._event(state,state.status,signal.aborted?'AI 요청과 검사를 취소했습니다. 기존 실행 가능한 버전은 유지됩니다.':state.error);}
  finally{attempt.finishedAt=now();state.activeAttemptId=null;await this._persist(state);}
 }
 async _task(state,attempt,operation,task,action){
  // This guard also covers final integrated re-audits, not only initial dispatch.
  const blockedDependency=task.dependsOn.find(parent=>!dependencyReady(state.tasks.find(other=>other.id===parent)));
  if(task.dependencyIssues?.length||blockedDependency){task.status='blocked';task.retryable=!task.dependencyIssues?.length;task.error=task.dependencyIssues?.length?'선행 관계를 먼저 확인해야 합니다: '+task.dependencyIssues.join(' · '):`선행 작업 ${state.tasks.find(t=>t.id===blockedDependency)?.title||blockedDependency}의 필수 결과물이 준비되지 않았습니다.`;this._event(state,'blocked',task.error,{taskId:task.id});await this._persist(state);return;}
  const config=attempt.input.config,policy=STRATEGIES.find(s=>s.id===attempt.strategy).policy,signal=operation.controller.signal;
  const existingCounts=attempt.taskCounts[task.id],counts=existingCounts??(attempt.taskCounts[task.id]={revisions:0,reviews:0,switches:0,rounds:[]});let round=counts.rounds.at(-1);if(!round){round={builder:task.builder,auditor:task.auditor,challenger:task.challenger,revisions:0,reviews:0};counts.rounds.push(round);}task.status='running';task.error=null;task.strategy=attempt.strategy;
  task.authors=[...new Set([...task.authors,...(task.changedPaths??[]).flatMap(name=>state.fileAuthors[name]??[])])];
  task.reviewMode=task.auditor===task.builder||task.authors.includes(task.auditor)?'self':'independent';
  this._event(state,'task-start','작업의 개발·검토를 시작합니다.',{taskId:task.id,builder:task.builder,auditor:task.auditor,challenger:task.challenger,action});await this._persist(state);
  if(policy.preflightAudit&&!existingCounts)try{await this._analysis(state,attempt,operation,task,'preflight-verification-plan',task.auditor);}catch(error){if(signal.aborted)throw error;this._event(state,'analysis-unavailable','사전 검토 응답을 받지 못해 구현을 계속합니다.',{taskId:task.id});}
  if(action==='analyze'||(policy.issueAnalysis&&open(task).length)||(policy.riskAnalysis&&open(task).some(f=>['critical','high'].includes(f.severity))))try{await this._analysis(state,attempt,operation,task,'risk-and-issue-analysis');}catch(error){if(signal.aborted)throw error;this._event(state,'analysis-unavailable','추가 분석 응답을 받지 못했습니다. 가능한 구현을 계속합니다.',{taskId:task.id});}
  if(action==='analyze'){task.status='limited';task.retryable=true;await this._persist(state);return;}
  let build=action==='build',submitted=false,mergeRetries=0;
  for(;;){checkAbort(signal);
   if(build){
    const context=await this.workspace.context(state.workingPath),result=await this._ai(state,attempt,operation,task.builder,'development-build',{role:'Builder',lead:attempt.lead,project:{name:attempt.input.project.name,instructions:attempt.input.project.instructions},baseline:attempt.input.baseline,task:{id:task.id,title:task.title,instructions:task.instructions,deliverable:task.deliverable,criteria:task.criteria,...normalizeExecutionMeta(task)},files:context.files,excluded:context.excluded??[],findings:open(task),checks:task.checks,configuredChecks:config.checks,launch:config.launch,rule:'Return complete meaningful source changes for this task, as relative files. Preserve unrelated work. Respect task.dependsOn contracts and use task.functionSteps as the relevant implementation and verification plan. The steps describe logical development stages, not file write order; files are applied atomically as one submission. Contract-first or mock scaffolding is allowed when clearly reported as unverified, never as working integration. Do not execute commands. Report limitations honestly. Implement all adopted baseline answers, including AI assumptions. Only truly missing external information or contradictory explicit requirements warrant spec limitations; isolate affected behavior and implement independent functionality. When configuredChecks is empty, provide agent-desk.test.mjs using node:test/assert for the implemented core behavior. For a static UI also provide agent-desk.checks.json with {checks:[{name,nodeIds:[existing task IDs],steps:[{action:"click"|"fill"|"select",selector,value}],expect:[{selector,text,mode:"equals"|"contains"}]}]}. These are executed by the host using a clean browser; use actual UI selectors and meaningful expected outputs, including invalid input. Preserve and extend earlier checks. Do not claim you executed checks. Do not edit review records, Git metadata, dependencies or secrets.'},task);
    let publication;try{publication=await this._publish(state,attempt,operation,task,context,result);}catch(error){if(error.mergeConflict&&mergeRetries++<1){this._event(state,'merge-retry',error.message,{taskId:task.id});continue;}throw error;}
    const {candidate,applied,codeSha}=publication;task.candidatePath=candidate.path;task.artifactSha=codeSha;task.readiness={ready:false,codeSha,evidence:''};
    const changed=applied.changedPaths??result.files.map(f=>f.path);task.changedPaths=[...new Set([...(task.changedPaths??[]),...changed])];
    for(const name of changed){state.fileAuthors[name]=[...new Set([...(state.fileAuthors[name]??[]),task.builder])];}
    task.authors=[...new Set([...task.authors,...task.changedPaths.flatMap(name=>state.fileAuthors[name]??[])])];
    // Combination budgets restart only as an explicit new round. Lifetime and
    // attempt totals still count every replacement of an earlier submission.
    if((task.submissionCount??0)>0)task.revisionCount++;
    if((counts.submissions??0)>0){counts.revisions++;attempt.revisionCount++;}
    if(submitted)round.revisions++;
    task.submissionCount=(task.submissionCount??0)+1;counts.submissions=(counts.submissions??0)+1;submitted=true;
    attempt.records??=[];attempt.records.push({type:'submission',at:now(),taskId:task.id,builder:task.builder,codeSha,revisionCount:task.revisionCount,reviewCount:task.reviewCount,summary:redact(result.summary),changedPaths:changed,limitations:result.limitations.map(f=>({...f,summary:redact(f.summary),evidence:redact(f.evidence),remedy:redact(f.remedy)}))});
    for(const previous of state.tasks)if(previous.id!==task.id&&previous.status==='passed'&&((previous.changedPaths??[]).some(name=>changed.includes(name))||previous.dependsOn.includes(task.id))){previous.needsVerification=true;this._event(state,'verification-invalidated','다른 작업의 변경으로 기존 검토의 재확인이 필요합니다.',{taskId:previous.id,changedBy:task.id});}
    // Preserve accepted findings; a later audit, not the Builder, resolves outstanding findings.
    for(const [index,issue] of result.limitations.entries())task.findings.push(this._finding(task,attempt,'BUILDER'+counts.revisions,issue,index));
    this._event(state,'submitted','격리된 작업 폴더에 구현을 저장했습니다.',{taskId:task.id,codeSha,builder:task.builder,revisionCount:task.revisionCount});await this._persist(state);
   }
   checkAbort(signal);task.reviewMode=task.auditor===task.builder||task.authors.includes(task.auditor)?'self':'independent';
   const auditSource=state.workingPath;const codeSha=await this.workspace.commit(auditSource,`Agent Desk ${task.id} verification`);task.artifactSha=codeSha;task.phase='실행 검사 중';await this._persist(state);
   const auditCopy=await this.workspace.create({projectId:state.projectId,sourcePath:attempt.input.project.path,previousPath:auditSource,attemptId:randomUUID()});task.auditPath=auditCopy.path;
   const checks=await this._checks(auditCopy,config,{signal,...(!task.isAssembly?{nodeId:task.id}:{})});checkAbort(signal);if(checks.some(check=>check.codeSha&&check.codeSha!==codeSha))throw problem('검사 대상 코드와 제출된 커밋 SHA가 일치하지 않습니다. 기록을 복구한 뒤 다시 검토해 주세요.');task.checks=checks.map(check=>({...check,output:redact(check.output),codeSha:check.codeSha??codeSha,at:check.at??now()}));
   const context=await this.workspace.context(auditSource);const auditPayload={role:'Auditor',reviewMode:task.reviewMode,strategy:attempt.strategy,baseline:attempt.input.baseline,codeSha,task:{id:task.id,title:task.title,instructions:task.instructions,criteria:task.criteria,...normalizeExecutionMeta(task)},files:context.files,checks:task.checks,configuredChecks:config.checks,launch:config.launch,previousFindings:open(task),rule:'Report handoff.ready and concrete evidence separately from verdict: ready means required contracts/files are usable by dependent work even if full execution evidence is missing. Never mark ready with a broken required interface or unresolved external prerequisite. Assess only this task and its implementation stage; future UI integration is not a prerequisite for a planning/contract task. Browser/environment failures are unverified evidence, not proof of implementation defects. Identify genuine faults with source evidence. If reviewMode is self, report this as self-review, not independent review. Inspect this pinned source against completion criteria and the planned functionSteps. Verify prerequisite contracts and end-to-end behavior; function names, file presence and syntax checks alone do not prove completion. Host checks ran on a separate isolated copy. Static source inspection is not execution evidence. Pass only with sufficient evidence and no unresolved implementation errors/spec ambiguity/unverified criteria. Give a status and evidence for EVERY previous finding ID. Adopted AI assumptions are concrete implementation requirements and must not be reclassified as unanswered spec issues. Truly unresolved external facts affect only relevant tasks. Suggestions alone need not fail. Report missing evidence and limitations.'};
   let audit;try{audit=await this._ai(state,attempt,operation,task.auditor,'development-audit',auditPayload,task);}catch(error){if(signal.aborted||task.auditor===task.builder)throw error;task.auditor=task.builder;task.reviewMode='self';this._event(state,'self-review','독립 검토 응답을 받지 못해 작성 AI의 자체 검토로 계속합니다.',{taskId:task.id});audit=await this._ai(state,attempt,operation,task.builder,'development-audit',{...auditPayload,reviewMode:'self'},task);}

   counts.reviews++;round.reviews++;attempt.reviewCount++;task.reviewCount++;task.readiness={ready:audit.handoff?.ready??audit.verdict==='pass',evidence:redact(audit.handoff?.evidence||audit.verifiedCriteria.map(c=>c.evidence).join(' · ')),codeSha};task.audit={mode:task.reviewMode,verdict:audit.verdict,summary:redact(audit.summary),agent:task.auditor,codeSha,at:now(),verifiedCriteria:audit.verifiedCriteria.map(c=>({criterion:redact(c.criterion),evidence:redact(c.evidence)})),unverifiedCriteria:audit.unverifiedCriteria.map(redact)};
   for(const finding of open(task)){const response=audit.previousFindings.find(item=>item.id===finding.id);if(response){finding.status=response.status==='resolved'?'resolved':'open';finding.reviewEvidence=redact(response.evidence);finding.reviewStatus=response.status;}}
   attempt.records??=[];attempt.records.push({type:'audit',at:now(),taskId:task.id,auditor:task.auditor,codeSha,revisionCount:task.revisionCount,reviewCount:task.reviewCount,report:redactObject(audit),checks:clone(task.checks)});
   for(const [index,issue] of audit.findings.entries())task.findings.push(this._finding(task,attempt,'R'+task.reviewCount,issue,index));
   for(const [index,criterion] of audit.unverifiedCriteria.entries())task.findings.push(this._finding(task,attempt,'UNVERIFIED'+task.reviewCount,{type:'unverified',severity:'medium',summary:criterion,evidence:'검토에서 필요한 실행 근거가 확인되지 않았습니다.',remedy:'필요한 자료 또는 실행 검사를 추가한 뒤 다시 검토합니다.'},index));
   for(const [index,check] of task.checks.filter(check=>!check.passed).entries())task.findings.push(this._finding(task,attempt,'HOST-'+task.reviewCount,{type:check.exitCode===null||check.failureKind==='environment'?'unverified':'implementation',severity:check.exitCode===null||check.failureKind==='environment'?'medium':'high',summary:`실행 검사 실패: ${check.label}`,evidence:check.output,remedy:'설정한 실행 검사를 통과하도록 구현 또는 환경을 수정합니다.'},index));
   const environmentOnly=task.checks.some(c=>!c.passed)&&task.checks.filter(c=>!c.passed).every(c=>c.exitCode===null||c.failureKind==='environment');
   const passed=audit.verdict==='pass'&&task.checks.every(check=>check.passed)&&!open(task).some(f=>['implementation','spec','unverified'].includes(f.type));
   task.status=passed?'passed':audit.verdict==='hold'||environmentOnly?'limited':'failed';task.retryable=!environmentOnly&&!open(task).some(f=>f.type==='spec');task.phase=passed?'완료':'한계 기록';
   if(passed){task.verifiedStrategies=[...new Set([...(task.verifiedStrategies??[]),attempt.strategy])];task.needsVerification=false;}
   this._event(state,'audit',`${task.reviewMode==='self'?'자체 검토':'독립 검토'}: ${passed?'통과':task.status==='limited'?'판정 보류':'불통과'}`,{taskId:task.id,verdict:task.audit.verdict,codeSha,auditor:task.auditor,reviewCount:task.reviewCount});await this._persist(state);
   if(policy.evidenceAnalysis&&(!passed||!config.checks.length)){try{await this._analysis(state,attempt,operation,task,'evidence-gaps');}catch(error){if(signal.aborted)throw error;this._event(state,'analysis-unavailable','추가 근거 분석을 받지 못했습니다. 기존 검토 판정은 유지합니다.',{taskId:task.id});}}
   if(passed||action==='verify'||!task.retryable)break;
   if(round.revisions<(task.isAssembly?Math.min(1,config.limits.maxRevisions):config.limits.maxRevisions)&&round.reviews<config.limits.maxReviews){build=true;task.status='running';continue;}
   if(policy.issueAnalysis)try{await this._analysis(state,attempt,operation,task,'limit-reached');}catch(error){if(signal.aborted)throw error;}
   if(config.autoSwitch&&policy.rotation&&!task.isAssembly){
    const rotated=rotateRoles({...config,roles:{builder:task.builder,auditor:task.auditor,challenger:task.challenger},overrides:{}},{authors:task.authors,switchCount:counts.switches});
    if(rotated.allowed){Object.assign(task,rotated.roles);counts.switches++;attempt.switchCount++;round={...rotated.roles,revisions:0,reviews:0};counts.rounds.push(round);submitted=false;build=true;task.status='running';this._event(state,'roles-switched',rotated.reason,{taskId:task.id,...rotated.roles});continue;}
    this._event(state,'rotation-blocked',rotated.reason,{taskId:task.id});
   }
   break;
  }
  await this._persist(state);
 }
 async _assembleDraft(state,attempt,operation){
  if(attempt.integrationAttempted)return;attempt.integrationAttempted=true;
  const earlier=state.tasks.filter(t=>!t.isAssembly),config=attempt.input.config;
  const task={id:'draft-assembly',isAssembly:true,title:'실행 가능한 초안 통합',builder:config.roles.builder,auditor:config.roles.auditor,challenger:config.roles.challenger,agent:config.roles.builder,authors:[],dependsOn:[],dependencyIssues:[],dependencyState:'defined',nodeType:'task',order:999,functionSteps:['남은 한계와 사용 가능한 기능 확인','필수 진입점·화면·기능 연결','미구현 기능 안내·비활성화 또는 명시적 대체 동작','시작·핵심 동작과 기존 기능 검사'],status:'pending',disposition:'open',revisionCount:0,reviewCount:0,artifactSha:null,checks:[],findings:[],instructions:'처음부터 끝까지 실행 가능한 v1으로 통합하세요. 기존 동작·사용자 결정은 보존하고 미구현 기능은 안내·비활성화하거나 명시적 대체 동작으로 격리하세요. 빈 화면이나 모든 기능이 비활성인 껍데기를 완성품으로 제출하지 마세요. 실제로 동작하는 핵심 사용자 흐름을 완성하세요. 대체 동작을 실제 연동 성공으로 표현하지 마세요. 해결되지 않은 기능과 시도한 방법은 limitations에 남기세요. nodeIds 없는 전체 통합 검사는 이 단계에서 실행됩니다. 기존 검사를 삭제하거나 기대값을 낮춰 실패를 숨기지 마세요. 의도적으로 제외한 기능은 화면에서 안내되는 동작을 검사하세요.',deliverable:'기존 기능과 사용 가능한 부분을 연결한 실행 초안, 진입점, 기본 기능·화면 검사, 남은 한계',criteria:'프로그램 시작, 핵심 사용자 흐름의 실제 동작, 미구현 기능의 명확한 안내, 기존 동작 보존. 후속 수정에 필요한 한계와 선택 기록.'};
  task.instructions+=' 이번 실행 범위: '+JSON.stringify(attempt.input.selection?.taskIds||earlier.map(t=>t.id))+'. 범위 밖의 기능을 임의로 재설계하지 마세요. 개별 결과: '+JSON.stringify(earlier.map(t=>({id:t.id,title:t.title,status:t.status,changedPaths:t.changedPaths,limitations:open(t).map(f=>({summary:f.summary,remedy:f.remedy}))}))).slice(0,14000);
  // Review concrete unresolved defects again on the assembled artifact. Original task verdicts are preserved.
  task.findings=earlier.flatMap(t=>open(t).filter(f=>f.type==='implementation'||f.type==='spec'||f.severity==='critical').map(f=>({...clone(f),id:'assembly-'+f.id,taskId:task.id,sourceTaskId:t.id})));
  state.tasks.push(task);this._event(state,'draft-assembly','주 개발 AI가 동작 가능한 기능을 연결하고 남은 기능을 한계로 정리합니다.',{taskId:task.id});await this._persist(state);
  try{await this._task(state,attempt,operation,task,'build');}catch(error){if(operation.controller.signal.aborted)throw error;task.status='limited';task.phase='통합 한계';task.error=errorText(error);await this._persist(state);}
 }
 async _checks(copy,config,options){
  const checks=await this.workspace.check(copy,config.checks,options);
  if(!config.checks.length&&this.workspace.automaticChecks)checks.push(...await this.workspace.automaticChecks(copy,config.launch,options));
  return checks;
 }
 async _release(state,attempt,operation){
  checkAbort(operation.controller.signal);const config=attempt.input.config;
  if(!state.workingPath)return;
  const codeSha=await this.workspace.commit(state.workingPath,'Agent Desk runnable candidate');
  const assembled=state.tasks.find(t=>t.isAssembly&&t.status==='passed'&&t.audit?.codeSha===codeSha);
  if(!assembled&&state.tasks.some(task=>task.findings.some(f=>f.status!=='resolved'&&(f.severity==='critical'||(f.type==='implementation'&&f.severity==='high')))))return;
  const taskSignature=hash({baseline:attempt.input.baseline,tasks:state.tasks.map(task=>({id:task.id,status:task.status,disposition:task.disposition,findings:task.findings,needsVerification:!!task.needsVerification,auditSha:task.audit?.codeSha,auditVerdict:task.audit?.verdict}))});
  if(state.releases.some(release=>release.codeSha===codeSha&&release.runnable&&release.taskSignature===taskSignature&&hash(release.launch)===hash(config.launch)))return;
  const checkCopy=await this.workspace.create({projectId:state.projectId,sourcePath:attempt.input.project.path,previousPath:state.workingPath,attemptId:randomUUID()});
  const checks=await this._checks(checkCopy,config,{signal:operation.controller.signal});checkAbort(operation.controller.signal);
  if(checks.some(check=>!check.passed&&check.exitCode!==null&&check.failureKind!=='environment')){this._event(state,'release-blocked','현재 후보의 실행 검사가 실패했습니다. 이전 실행 가능 버전을 유지합니다.');return;}
  const releaseId=randomUUID(),snapshot=await this.workspace.snapshot(state.workingPath,{projectId:state.projectId,releaseId});let smoke;
  try{smoke=await this.workspace.launch(snapshot,config.launch,{signal:operation.controller.signal});checkAbort(operation.controller.signal);}catch(error){if(operation.controller.signal.aborted)throw error;this._event(state,'release-blocked','현재 후보의 시작 확인에 실패했습니다. 이전 실행 가능 버전을 유지합니다.');return;}finally{await smoke?.stop?.();}
  const limitations=state.tasks.filter(task=>task.status!=='passed'||task.needsVerification||task.audit?.codeSha!==codeSha||task.findings.some(f=>f.status!=='resolved')).map(task=>({taskId:task.id,title:task.title,status:task.status,disposition:task.disposition,findings:task.findings.filter(f=>f.status!=='resolved').map(clone),...(task.needsVerification||task.audit?.codeSha!==codeSha?{description:'현재 코드 SHA에 대한 검토가 완료되지 않았습니다.'}:{})}));
  for(const check of checks.filter(c=>!c.passed))limitations.push({taskId:null,title:check.label,status:'unverified',description:check.output});
  if(!checks.length)limitations.push({taskId:null,title:'자동 검사 미설정',status:'unverified',description:'시작 HTTP 응답만 확인했습니다. 화면 동작과 기능 검증을 의미하지 않습니다.'});
  const trace={baseline:clone(attempt.input.baseline),tasks:state.tasks.map(task=>({id:task.id,title:task.title,dependsOn:task.dependsOn,decisionIds:baselineContext(attempt.input.baseline,task.id).items.map(i=>i.id),changedPaths:task.changedPaths||[],status:task.status,checks:clone(task.checks),audit:clone(task.audit||null)}))};
  const release={trace,stage:checks.length>0&&checks.every(c=>c.passed)&&state.tasks.every(t=>t.status==='passed'&&!t.needsVerification&&t.audit?.codeSha===codeSha)?'reviewed':'draft',id:releaseId,createdAt:now(),codeSha,runnable:true,limitations,entry:config.launch.entry,launch:clone(config.launch),downloadName:`${state.projectId}-${releaseId.slice(0,8)}.zip`,path:snapshot,taskSignature,verification:{reviewMode:state.tasks.some(t=>t.audit?.mode==='self')?'self-or-mixed':'independent',startup:'http-response',audit:state.tasks.every(task=>task.status==='passed'&&!task.needsVerification&&task.audit?.codeSha===codeSha)?'pass':'incomplete',checks:checks.map(check=>({...check,output:redact(check.output),codeSha}))}};
  state.releases.push(release);state.latestRunnableId=releaseId;this._event(state,'runnable','시작 확인을 통과한 실행 버전을 보관했습니다. 남은 한계와 검토 방식·판정은 별도로 표시합니다.',{releaseId,codeSha});await this._persist(state);
 }
 async _releaseById(projectId,releaseId){id(releaseId);const state=await this._load(projectId),release=state.releases.find(r=>r.id===releaseId);if(!release?.runnable)throw problem('실행 가능한 저장 버전을 찾지 못했습니다.',404);return {state,release};}
 async launch(projectId,releaseId,{requestId=randomUUID()}={}){
  id(projectId);id(releaseId);id(requestId);const key=projectId+':'+releaseId;
  // Hold the project lock only for registration and persistence, never readiness.
  // This makes both cancel-before-POST and cancel-during-prepare deterministic.
  const registration=await this._exclusive(projectId,async()=>{
   if(this.closed)throw problem('실행기가 종료 중입니다.',409);
   const {state,release}=await this._releaseById(projectId,releaseId);
   if(state.cancelledRequests.includes(requestId))throw problem('프로그램 실행 요청이 취소되었습니다.',409);
   const previous=state.requests[requestId];
   if(previous&&(previous.kind!=='launch'||previous.releaseId!==releaseId))throw problem('같은 요청 ID에 다른 실행 내용이 전달되었습니다.',409);
   const running=this.launches.get(key);let pending=this.launchRequests.get(key);
   if(previous&&!running&&!pending)throw problem('이 실행 요청은 이미 종료되었습니다. 새 요청으로 실행해 주세요.',409);
   state.requests[requestId]={kind:'launch',releaseId,createdAt:previous?.createdAt??now()};await this._persist(state);
   if(running){running.requestIds??=new Set();running.requestIds.add(requestId);return {release,result:running};}
   if(!pending){
    const controller=new AbortController();pending={controller,requestId,requestIds:new Set([requestId]),done:null};
    this.launchRequests.set(key,pending);
    pending.done=Promise.resolve().then(()=>{checkAbort(controller.signal);return this.workspace.launch(release.path,release.launch,{signal:controller.signal});}).then(async result=>{
     if(controller.signal.aborted){await result.stop();throw aborted();}
     result.requestIds=pending.requestIds;this.launches.set(key,result);return result;
    }).finally(()=>{if(this.launchRequests.get(key)===pending)this.launchRequests.delete(key);});
   }else pending.requestIds.add(requestId);
   return {release,pending};
  });
  const result=registration.result??await registration.pending.done;
  const state=await this._load(projectId);if(state.cancelledRequests.includes(requestId))throw problem('프로그램 실행 요청이 취소되었습니다.',409);
  return {url:result.url,releaseId,runnable:true,limitations:clone(registration.release.limitations)};
 }
 async stopLaunch(projectId,releaseId){id(projectId);id(releaseId);const key=projectId+':'+releaseId;this.launchRequests.get(key)?.controller.abort();const running=this.launches.get(key);await running?.stop();this.launches.delete(key);return {stopped:true,releaseId};}
 async download(projectId,releaseId){const {release}=await this._releaseById(projectId,releaseId);return this.workspace.packageRelease(release.path,{limitations:release.limitations,launch:release.launch,trace:release.trace});}
 async close(){this.closed=true;for(const operation of this.runs.values()){operation.controller.abort();for(const jobId of operation.jobs)this.agentRunner.cancel(jobId);}for(const pending of this.launchRequests.values())pending.controller.abort();await Promise.allSettled([...this.runs.values()].map(operation=>operation.done));await Promise.allSettled([...this.launchRequests.values()].map(item=>item.done));await Promise.allSettled([...this.launches.values()].map(item=>item.stop()));await Promise.allSettled([...this.writes.values()]);this.launches.clear();}
}
