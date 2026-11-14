// Planning hierarchy and execution dependencies are deliberately separate graphs.
const ensure=(ok,message)=>{if(!ok)throw new Error(message);};
const validId=value=>typeof value==='string'&&/^[\w-]{1,80}$/.test(value);
const strings=(value,max,length,label)=>{
  ensure(Array.isArray(value)&&value.length<=max,`${label}은 최대 ${max}개입니다.`);
  return value.map(item=>{ensure(typeof item==='string'&&item.trim().length>0&&item.length<=length,`${label} 형식을 확인해 주세요.`);return item.trim();});
};
export function normalizeExecutionMeta(input={}){
  const nodeType=input.nodeType??'task',order=input.order??null,dependencyState=input.dependencyState??'unreviewed';
  ensure(['task','group'].includes(nodeType),'노드 유형은 작업 또는 묶음이어야 합니다.');
  ensure(order===null||(Number.isInteger(order)&&order>=1&&order<=999),'구현 우선순위는 1~999의 정수입니다.');
  ensure(['unreviewed','defined'].includes(dependencyState),'선행 작업 검토 상태가 올바르지 않습니다.');
  const dependsOn=strings(input.dependsOn??[],99,80,'선행 작업');
  ensure(dependsOn.every(validId)&&new Set(dependsOn).size===dependsOn.length,'선행 작업 ID가 중복되거나 올바르지 않습니다.');
  const integrationWith=strings(input.integrationWith??[],99,80,'병렬 개발 후 연결할 작업');
  ensure(integrationWith.every(validId)&&new Set(integrationWith).size===integrationWith.length,'통합 작업 ID가 중복되거나 올바르지 않습니다.');
  const functionSteps=strings(input.functionSteps??[],20,600,'함수 구현 단계');
  const dependencyIssues=[...new Set(strings(input.dependencyIssues??[],99,300,'선행 작업 확인 사항'))];
  return {nodeType,order,dependsOn,...(Object.hasOwn(input,'integrationWith')?{integrationWith}:{}),functionSteps,dependencyState:dependencyIssues.length?'unreviewed':dependencyState,dependencyIssues};
}
function graph(nodes,{rootId}={}){
  ensure(Array.isArray(nodes),'실행할 노드 목록이 올바르지 않습니다.');
  const entries=nodes.map((node,index)=>({node,index,meta:normalizeExecutionMeta(node)}));
  const byId=new Map(entries.map(entry=>[entry.node.id,entry]));
  ensure(entries.every(entry=>validId(entry.node.id))&&byId.size===entries.length,'실행 노드 ID가 중복되거나 올바르지 않습니다.');
  for(const {node,meta} of entries){
    ensure(meta.nodeType!=='group'||meta.dependsOn.length===0,'묶음 노드는 선행 작업을 가질 수 없습니다. 실제 작업 노드에 지정해 주세요.');
    ensure(node.id!==rootId||meta.dependsOn.length===0,'전체 목표에는 선행 작업을 지정할 수 없습니다.');
    for(const peer of meta.integrationWith||[])ensure(peer!==node.id&&byId.has(peer)&&peer!==rootId&&byId.get(peer).meta.nodeType!=='group'&&meta.nodeType!=='group','통합 대상은 다른 실제 작업 노드여야 합니다.');
    for(const predecessor of meta.dependsOn){
      ensure(predecessor!==node.id,'자기 자신을 선행 작업으로 지정할 수 없습니다.');
      ensure(byId.has(predecessor),'선행 작업이 삭제되었거나 존재하지 않습니다.');
      ensure(predecessor!==rootId&&byId.get(predecessor).meta.nodeType!=='group','선행 작업은 목표·묶음이 아닌 실제 작업 노드를 지정해 주세요.');
    }
  }
  return {entries,byId};
}
function ordered({entries}){
  const done=new Set(),result=[];
  while(result.length<entries.length){
    // Select one ready node at a time. A newly unlocked high-priority task can
    // precede an unrelated lower-priority task without overriding dependencies.
    const ready=entries.filter(({node,meta})=>!done.has(node.id)&&meta.dependsOn.every(id=>done.has(id)));
    ensure(ready.length>0,'선행 작업이 순환합니다. 구현 의존성을 확인해 주세요.');
    ready.sort((a,b)=>(a.meta.order??1000)-(b.meta.order??1000)||a.index-b.index);
    const entry=ready[0];done.add(entry.node.id);result.push(entry.node);
  }
  return result;
}
export function validateExecutionGraph(nodes,options={}){ordered(graph(nodes,options));return nodes;}
export function executionOrder(nodes){return ordered(graph(nodes));}
export function executionWaves(nodes){
  const waves=new Map();
  for(const node of executionOrder(nodes))waves.set(node.id,1+Math.max(0,...(node.dependsOn??[]).map(id=>waves.get(id))));
  return waves;
}
