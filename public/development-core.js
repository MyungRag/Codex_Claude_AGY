import {array,ensure,recordId,text,validateTasks} from './decision-core.js';
import {normalizeExecutionMeta} from './execution-order.js';

export const DEVELOPMENT_AGENTS=Object.freeze(['codex','claude','agy']);
const roleNames=['builder','auditor','challenger'];

// These are execution policies, not an automatic sequence of five attempts.
export const STRATEGIES=[
 {id:'integrated',name:'통합안',purpose:'운영 절차·독립 검증·쟁점 분석을 함께 적용합니다.',advantages:['착수 전 위험과 검증 기준을 함께 확인합니다.','교착 시 한도 안에서 다른 AI 조합으로 재시도합니다.'],disadvantages:['AI 호출과 검증 시간이 더 필요합니다.','역할과 기록을 함께 관리해야 합니다.'],limitation:'AI 조합을 바꿔도 부족한 요구사항·환경·자료까지 해결되지는 않습니다.',steps:['확정 기획과 역할 확인','검증 계획·위험 분석','Builder 구현·자체 검사','고정 코드에서 Auditor 독립 검토','미해결 쟁점 분석·제한된 조합 교체','실행 결과·남은 한계 기록'],policy:{preflightAudit:true,riskAnalysis:true,evidenceAnalysis:true,issueAnalysis:true,rotation:true}},
 {id:'procedural',name:'운영 절차 중심',purpose:'역할·전달서·검토 기록을 명확히 남기며 진행합니다.',advantages:['누가 무엇을 구현·검토했는지 추적하기 쉽습니다.','기획 변경과 구현 오류를 구분합니다.'],disadvantages:['기록과 전달 절차에 시간이 듭니다.','절차만으로 구현 품질이 보장되지는 않습니다.'],limitation:'독립 검토에 필요한 실행 환경과 근거는 별도로 확보해야 합니다.',steps:['확정 기획·완료 기준 확인','Auditor 검증 계획','Builder 구현·전달서','입력·코드 SHA 대조','Auditor 독립 검토·수정','누적 기록·인계'],policy:{preflightAudit:true,riskAnalysis:false,evidenceAnalysis:false,issueAnalysis:false,rotation:false}},
 {id:'verification',name:'검증 중심',purpose:'실제 실행 근거와 회귀 검사를 중심으로 완료를 판단합니다.',advantages:['정적 확인과 실제 실행 성공을 구분합니다.','기존 기능에 미친 영향을 추가로 점검합니다.'],disadvantages:['검사 환경과 테스트 준비 비용이 큽니다.','검증할 수 없는 요구사항은 보류됩니다.'],limitation:'자동 검사를 통과해도 검사에 포함되지 않은 동작까지 보장하지 않습니다.',steps:['완료 기준·검사 명령 확인','Builder 구현·실제 검사','고정 코드에서 Auditor 검토','제3 AI의 검증 근거 점검','영향받는 기능 재검증','실행 가능 여부·미검증 기록'],policy:{preflightAudit:false,riskAnalysis:false,evidenceAnalysis:true,issueAnalysis:false,rotation:false}},
 {id:'issue',name:'쟁점 분석 중심',purpose:'실패 원인과 기획·구현의 충돌을 분석한 뒤 필요한 부분을 수정합니다.',advantages:['같은 수정을 반복하는 원인을 찾는 데 유리합니다.','기획 변경·환경 문제·구현 오류를 나눕니다.'],disadvantages:['분석이 길어지면 구현이 늦어질 수 있습니다.','분석 제안에도 검증이 필요합니다.'],limitation:'분석 담당 AI는 사용자의 기획 결정을 대신하거나 검토 실패를 통과로 바꾸지 않습니다.',steps:['확정 기획·미해결 지적 확인','Challenger 쟁점·대안 분석','관련 작업만 Builder 구현','Auditor 독립 검토','미해결 원인·사용자 결정 정리'],policy:{preflightAudit:false,riskAnalysis:false,evidenceAnalysis:false,issueAnalysis:true,rotation:false}},
 {id:'assignment',name:'기존 업무 분담안',purpose:'기획에서 지정한 작업별 담당 AI와 선행 관계를 유지합니다.',advantages:['기존 담당과 업무 분담을 그대로 활용합니다.','서로 독립적인 작업을 계속 진행할 수 있습니다.'],disadvantages:['여러 AI가 작성한 결과를 통합·검증해야 합니다.','공유 코드 변경으로 다른 작업에 영향이 생길 수 있습니다.'],limitation:'작업별 담당이 달라도 같은 코드의 작성자가 최종 검토를 맡을 수는 없습니다.',steps:['기존 업무 분담 불러오기','선행 작업 확인','작업별 담당 AI 구현','다른 AI의 독립 검토','통합 결과·남은 작업 기록'],policy:{preflightAudit:false,riskAnalysis:false,evidenceAnalysis:false,issueAnalysis:false,rotation:false}}
];
for(const strategy of STRATEGIES){for(const key of ['advantages','disadvantages','steps','policy'])Object.freeze(strategy[key]);Object.freeze(strategy);}
Object.freeze(STRATEGIES);
const strategyIds=new Set(STRATEGIES.map(s=>s.id));
const object=(value,label)=>{ensure(value&&typeof value==='object'&&!Array.isArray(value),label+' 형식을 확인해 주세요.');return value;};
const agent=(value,label)=>{ensure(DEVELOPMENT_AGENTS.includes(value),label+' AI를 확인해 주세요.');return value;};
const strategyId=value=>{ensure(strategyIds.has(value),'협업 방식을 확인해 주세요.');return value;};

export function defaultDevelopment(){
 return {version:1,strategy:'integrated',lead:'codex',roles:{builder:'codex',auditor:'claude',challenger:'agy'},overrides:{},limits:{maxRevisions:2,maxReviews:3,maxSwitches:1},autoSwitch:false,checks:[],launch:{kind:'static',entry:'index.html',command:null,url:'',prepare:[]}};
}
function rolesFrom(raw,base){
 const result={...base};object(raw,'역할');
 for(const role of roleNames)if(Object.hasOwn(raw,role))result[role]=agent(raw[role],role);
 ensure(result.builder!==result.auditor,'주개발자와 주검토자는 서로 다른 AI여야 합니다.');
 return result;
}
function commandFrom(raw){
 object(raw,'실행 명령');const command=text(raw.command,1000,'실행 파일');
 ensure(command&&!/[\x00-\x1f\x7f|;&<>`]/.test(command),'실행 파일에는 하나의 명령만 입력해 주세요. 인수는 별도로 입력합니다.');
 const args=array(raw.args??[],100,'명령 인수').map(value=>{ensure(typeof value==='string'&&value.length<=8000&&!/[\x00\r\n]/.test(value),'명령 인수 형식을 확인해 주세요.');return value;});
 return {command,args};
}
function relativeEntry(value){
 const entry=text(value,500,'실행 파일 경로').replaceAll('\\','/');
 ensure(entry&&!entry.startsWith('/')&&!/[:\x00-\x1f?#]/.test(entry)&&entry.split('/').every(part=>part&&part!=='.'&&part!=='..'),'실행 파일은 작업 폴더 안의 상대 경로여야 합니다.');
 return entry;
}

export function validateDevelopment(raw){
 const defaults=defaultDevelopment();if(raw===undefined)return defaults;object(raw,'개발·검토 설정');
 ensure(raw.version===undefined||raw.version===1,'지원하지 않는 개발·검토 설정 버전입니다.');
 const strategy=strategyId(raw.strategy??defaults.strategy),lead=agent(raw.lead??defaults.lead,'총괄 담당');
 const roles=rolesFrom(raw.roles??{},defaults.roles),overrides={};
 for(const [id,value] of Object.entries(object(raw.overrides??{},'방안별 역할'))){
  strategyId(id);rolesFrom(value,roles);overrides[id]={};
  for(const role of roleNames)if(Object.hasOwn(value,role))overrides[id][role]=agent(value[role],role);
 }
 const limits={};object(raw.limits??{},'진행 한도');
 for(const [key,fallback] of Object.entries(defaults.limits)){
  const value=raw.limits?.[key]??fallback;
  ensure(Number.isSafeInteger(value)&&value>=(key==='maxReviews'?1:0)&&value<=1000,'수정·검토·조합 교체 한도는 0~1000의 정수이며 검토는 1회 이상이어야 합니다.');limits[key]=value;
 }
 ensure(raw.autoSwitch===undefined||typeof raw.autoSwitch==='boolean','자동 조합 교체 설정을 확인해 주세요.');
 const checks=array(raw.checks??[],30,'실행 검사').map(check=>{object(check,'검사');return {id:recordId(check.id),label:text(check.label??check.command,200,'검사 이름'),...commandFrom(check)};});
 ensure(new Set(checks.map(check=>check.id)).size===checks.length,'검사 ID가 중복되었습니다.');
 const launchRaw=object(raw.launch??{},'프로그램 실행'),kind=launchRaw.kind??'static';
 ensure(kind==='static'||kind==='command','프로그램 실행 방식을 확인해 주세요.');
 const entry=relativeEntry(launchRaw.entry??'index.html'),command=launchRaw.command==null?null:commandFrom(launchRaw.command),url=text(launchRaw.url??'',2000,'실행 확인 주소'),prepare=array(launchRaw.prepare??[],10,'실행 준비 명령').map(commandFrom);
 if(kind==='command'){
  ensure(command,'프로그램 실행 명령을 입력해 주세요.');
  let parsed;try{parsed=new URL(url.replaceAll('{port}','4174'));}catch{}
  ensure(parsed&&parsed.protocol==='http:'&&['127.0.0.1','localhost'].includes(parsed.hostname)&&!parsed.username&&!parsed.password&&!parsed.hash,'실행 확인 주소는 http://127.0.0.1:{port}/ 같은 현재 PC의 HTTP 주소여야 합니다.');
 }
 return {version:1,strategy,lead,roles,overrides,limits,autoSwitch:raw.autoSwitch===true,checks,launch:{kind,entry,command,url,prepare}};
}

export function resolveRoles(config,strategy=config?.strategy??'integrated'){
 const checked=validateDevelopment(config);strategyId(strategy);
 return rolesFrom(checked.overrides[strategy]??{},checked.roles);
}

export function prepareDevelopmentTasks(baseline,handoff,config){
 ensure(baseline?.snapshot&&Array.isArray(baseline.snapshot.nodes),'확정 기획이 필요합니다.');
 ensure(baseline.snapshot.nodes.some(node=>node.id===baseline.snapshot.rootId)&&baseline.snapshot.nodes.length>1,'확정 기획에 목표와 개발할 작업이 필요합니다.');
 ensure(handoff&&Array.isArray(handoff.tasks),'저장된 업무 분담안이 필요합니다.');
 if(handoff.baselineId!==undefined)ensure(handoff.baselineId===baseline.id,'업무 분담안과 확정 기획 버전이 다릅니다.');
 const checked=validateDevelopment(config),primary=resolveRoles(checked),tasks=validateTasks(handoff.tasks,baseline.snapshot);
 return tasks.map(task=>{
  const node=baseline.snapshot.nodes.find(n=>n.id===task.nodeId),builder=checked.strategy==='assignment'?task.agent:primary.builder;
  // Assignment mode preserves the named developer; its independent reviewer may differ from the project default.
  const auditor=primary.auditor===builder?DEVELOPMENT_AGENTS.find(value=>value!==builder&&value!==primary.builder)??DEVELOPMENT_AGENTS.find(value=>value!==builder):primary.auditor;
  const challenger=checked.strategy==='assignment'&&(primary.challenger===builder||primary.challenger===auditor)?DEVELOPMENT_AGENTS.find(value=>value!==builder&&value!==auditor):primary.challenger;
  return {id:recordId(task.nodeId),title:text(node.title,100,'작업 이름'),...normalizeExecutionMeta(task),criteria:task.criteria,instructions:task.instructions,deliverable:task.deliverable,status:'pending',disposition:'open',agent:builder,builder,auditor,challenger,authors:[],findings:[],checks:[],revisionCount:0,reviewCount:0,artifactSha:null,error:null};
 });
}

function taskGraph(tasks){
 array(tasks,100,'개발 작업');const byId=new Map();
 for(const task of tasks){object(task,'개발 작업');const id=recordId(task.id);ensure(!byId.has(id),'작업 ID가 중복되었습니다.');byId.set(id,task);}
 const visiting=new Set(),done=new Set();
 const visit=id=>{ensure(!visiting.has(id),'선행 작업이 순환합니다.');if(done.has(id))return;visiting.add(id);for(const parent of array(byId.get(id).dependsOn??[],100,'선행 작업')){ensure(byId.has(parent)&&parent!==id,'선행 작업이 없거나 자기 자신을 참조합니다.');visit(parent);}visiting.delete(id);done.add(id);};
 for(const id of byId.keys())visit(id);return byId;
}
const openFindings=task=>(task.findings??[]).filter(finding=>!['resolved','accepted'].includes(finding.status));
const keptDisposition=task=>task.disposition==='accepted'||task.disposition==='excluded';

export function planPartialRetry(tasks,{strategy,changedTaskIds=[]}={}){
 if(strategy!==undefined)strategyId(strategy);
 const byId=taskGraph(tasks),changed=new Set(array(changedTaskIds,100,'변경된 작업').map(recordId));
 ensure([...changed].every(id=>byId.has(id)),'변경된 작업 ID를 확인해 주세요.');
 const result=new Map();
 for(const task of tasks){
  const findings=openFindings(task);let action,reason;
  if(keptDisposition(task)){action='keep';reason=task.disposition==='accepted'?'사용자가 수용한 한계를 유지합니다.':'이번 범위에서 제외한 작업을 유지합니다.';}
  else if(task.status==='running'){action='wait';reason='실행 중인 요청을 완료하거나 취소한 뒤 재시도합니다.';}
  else if(task.status==='blocked'&&task.retryable!==true){action='wait';reason='기획·환경·자료 등 선행 조건을 해결한 뒤 재개합니다.';}
  else if(findings.some(f=>f.type==='spec')){action='wait';reason='기획 변경이나 사용자 결정이 먼저 필요합니다.';}
  else if(task.status==='limited'&&task.retryable!==true){action='analyze';reason='남은 한계의 원인과 수정 가능한 범위를 먼저 분석합니다.';}
  else if(task.status==='passed'){
   const needsEvidence=['integrated','verification'].includes(strategy)&&!(task.verifiedStrategies??[]).includes(strategy)&&task.strategy!==strategy;
   action=needsEvidence?'verify':'keep';reason=needsEvidence?'완료한 구현을 보존하고 새 방식에서 필요한 검증만 추가합니다.':'통과한 구현과 검증 결과를 유지합니다.';
  }
  else {action='build';reason=task.status==='pending'?'아직 개발하지 않은 작업을 실행합니다.':'실패·부분 구현·수정 가능한 한계만 다시 구현합니다.';}
  result.set(task.id,{taskId:task.id,action,reason});
 }
 // Both explicit changes and planned code changes invalidate completed downstream evidence.
 for(const entry of result.values())if(entry.action==='build')changed.add(entry.taskId);
 let advanced=true;
 while(advanced){advanced=false;for(const task of tasks)if((task.dependsOn??[]).some(id=>changed.has(id))&&!changed.has(task.id)){changed.add(task.id);advanced=true;}}
 for(const task of tasks){const entry=result.get(task.id);if(task.status==='passed'&&!keptDisposition(task)&&changed.has(task.id)&&['keep','verify'].includes(entry.action)){entry.action='verify';entry.reason='변경된 작업의 영향을 확인합니다. 기존 구현은 다시 만들지 않습니다.';}}
 // A preserved incomplete dependency is not evidence that its dependents are ready.
 let blocked=true;
 while(blocked){blocked=false;for(const task of tasks){const entry=result.get(task.id);if(!['build','verify','analyze'].includes(entry.action))continue;
  const dependency=(task.dependsOn??[]).find(id=>{const parent=byId.get(id),plan=result.get(id);return plan.action==='wait'||plan.action==='analyze'||(plan.action==='keep'&&parent.status!=='passed');});
  if(dependency){entry.action='wait';entry.reason=`선행 작업 ${byId.get(dependency)?.title||dependency}의 미해결 조건을 먼저 확인해야 합니다.`;blocked=true;}
 }}
 return tasks.map(task=>result.get(task.id));
}

export function rotateRoles(config,{strategy=config?.strategy??'integrated',authors=[],switchCount=0}={}){
 const checked=validateDevelopment(config),current=resolveRoles(checked,strategy);
 ensure(Number.isSafeInteger(switchCount)&&switchCount>=0,'조합 교체 누적 횟수를 확인해 주세요.');
 const contributors=new Set(array(authors,100,'코드 작성자').map(value=>agent(value,'코드 작성자')));
 const roles={builder:current.auditor,auditor:current.challenger,challenger:current.builder};
 if(switchCount>=checked.limits.maxSwitches)return {allowed:false,roles:current,reason:'설정한 AI 조합 교체 한도에 도달했습니다.'};
 if(roles.builder===roles.auditor||contributors.has(roles.auditor))return {allowed:false,roles:current,reason:'기존 코드 작성자가 자신의 코드를 최종 검토할 수 없습니다. 독립 검토자를 확보해야 합니다.'};
 return {allowed:true,roles,reason:'기존 검토자가 개발을 맡고 제3 AI가 독립 검토합니다. 이전 작성자는 조언을 맡습니다.'};
}
