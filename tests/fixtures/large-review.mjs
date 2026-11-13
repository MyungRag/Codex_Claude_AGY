import {createPlan,addNode,appendMessage} from '../../public/planning-model.js';
export function largeReview({instructionRepeats=90}={}){
 const project={name:'공학용 계산기',description:'계산과 화면 동작을 구현',instructions:'입력과 오류 처리 보존'},plan=createPlan(project);
 const scope=Array.from({length:26},(_,i)=>addNode(plan,plan.rootId,{title:'계산 기능 '+i,instructions:'사용자 요구 '.repeat(50)+'원본 끝 '+i,criteria:'올바른 결과와 오류 입력을 확인한다.'}).id);
 appendMessage(plan,{text:'사용자 추가 요구: 오프라인 동작과 DEG/RAD 전환을 반드시 보존'});
 appendMessage(plan,{author:'agy',text:'과거 AI 설명 반복 '.repeat(350),kind:'live'});
 const jobs=['codex','claude','agy'].map(agent=>({id:'cached-'+agent,agent,status:'succeeded',result:{summary:agent+'의 독립 검토',nodes:scope.map((id,i)=>({id:agent+'-'+i,parentId:null,sourceIds:[id],derivedFrom:[],title:'계산 기능 '+i,description:'계산 규칙 설명 '.repeat(50),instructions:'정확한 수식 처리와 각도 전환을 구현한다. '.repeat(instructionRepeats)+agent+'-요구사항-끝-'+i,criteria:'정상 입력과 잘못된 입력을 실제로 검사한다. '.repeat(20),reason:'계산 요구와 입력 계약을 보존한다.',nodeType:'task',order:i+1,dependsOn:[],functionSteps:['입력 검증','계산','결과 검증'],dependencyState:'defined',dependencyIssues:[]})),excluded:[]}}));
 return {project,plan,scope,jobs};
}

