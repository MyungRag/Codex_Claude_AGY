import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPlan,addNode,appendMessage,travelHistory,validatePlan} from '../public/planning-model.js';
import {addDecision,updateDecision,finalizePlan,createAssignments,saveAssignments,handoffDocument} from '../public/decision-model.js';
import {applyQuestionSynthesis,validateQuestionSynthesis,questionSynthesisPrompt} from '../public/review-model.js';
import {organizePlan} from '../public/organize-model.js';

const rec=(answer='DEG',kind='assumption',messageIds=[])=>({kind,answer,reason:kind==='unresolved'?'외부 자료 확인 필요':'계산기의 기본 각도 단위',messageIds});
function sample(){const project={name:'공학용 계산기',description:'계산 가능한 웹 앱',instructions:''},p=createPlan(project),n=addNode(p,p.rootId,{title:'계산 엔진',criteria:'사칙연산과 삼각함수 계산',instructions:'계산기를 구현한다'});return {project,p,n};}
const question=(nodeId,question='각도 단위는?')=>({type:'question',nodeIds:[nodeId],relatedIds:[],question,reason:'각도 해석',evidence:'설계 선택',options:[{label:'RAD',impact:'라디안'},{label:'DEG',impact:'도 단위'}],blocking:true,recommendation:rec()});
const jobs=n=>['codex','claude','agy'].map((agent,index)=>({agent,id:'run-'+agent,status:'succeeded',result:{summary:'검토',items:[question(n.id,['각도 단위는?','삼각함수는 도 단위로 계산하나요?','DEG 또는 RAD 중 기본값은?'][index])]}}));
const merged=(n,existingIds=[])=>({summary:'같은 질문을 통합',items:[{...question(n.id),existingIds,sourceRefs:['codex-1','claude-1','agy-1']}],omitted:[]});

test('three different wordings produce one adopted default, preserving alternatives, provenance, undo and baseline',()=>{
 const {project,p,n}=sample(),raw=jobs(n),next=applyQuestionSynthesis(p,[n.id],raw,merged(n),{id:'merge-1',lead:'claude'});
 assert.equal(next.items.length,1);const item=next.items[0];
 assert.equal(item.answer,'DEG','explicit recommendation wins over the first option RAD');assert.equal(item.status,'done');assert.equal(item.resolution.kind,'assumption');
 assert.equal(item.options.length,2);assert.equal(item.sources.length,3);assert.equal(next.reviewHistory.length,1);
 assert.deepEqual(JSON.parse(next.reviewHistory[0].payload).map(x=>x.agent),['codex','claude','agy']);
 const finalized=finalizePlan(project,next),baseline=finalized.baselines[0];assert.equal(baseline.snapshot.items[0].resolution.kind,'assumption');assert.equal(baseline.snapshot.items[0].options.length,2);
 const saved=saveAssignments(finalized,baseline.id,createAssignments(baseline));
 assert.match(handoffDocument(baseline,{tasks:createAssignments(baseline)}),/AI 가정/);
 assert.equal(validatePlan(JSON.parse(JSON.stringify(next))).items[0].answer,'DEG');assert.equal(travelHistory(next,'undo').items.length,0);
 assert.equal(p.items.length,0);assert.equal(raw[0].result.items[0].question,'각도 단위는?');
});

test('repeated semantic review updates existing IDs without accumulating or overwriting the user answer',()=>{
 const {p,n}=sample();let next=applyQuestionSynthesis(p,[n.id],jobs(n),merged(n),{id:'merge-1',lead:'codex'});
 updateDecision(next,next.items[0].id,{answer:'RAD',evidence:'사용자 선택'},'confirm');const id=next.items[0].id;
 const result=merged(n,[id]);result.items[0].question='각도 입력의 기본 해석은?';
 next=applyQuestionSynthesis(next,[n.id],jobs(n),result,{id:'merge-2',lead:'agy'});
 assert.equal(next.items.length,1);assert.equal(next.items[0].id,id);assert.equal(next.items[0].answer,'RAD');assert.equal(next.items[0].resolution.kind,'user');
 assert.equal(next.items[0].question,'각도 단위는?');assert.equal(next.reviewHistory.length,2);
});

test('explicit dialog answer and newly linked user conversation override defaults; old chat cannot overwrite later decisions',()=>{
 const {project,p,n}=sample();let next=applyQuestionSynthesis(p,[n.id],jobs(n),merged(n),{id:'chosen',lead:'codex',edits:{0:{answer:'RAD, 소수점 8자리'}}});
 assert.equal(next.items[0].answer,'RAD, 소수점 8자리');assert.equal(next.items[0].resolution.kind,'user');
 const result=merged(n,[next.items[0].id]);result.items[0].recommendation=rec('DEG','user',['review-input']);
 next=applyQuestionSynthesis(next,[n.id],jobs(n),result,{id:'chat-change',lead:'codex',instruction:'기본 각도는 DEG로 변경해 줘'});
 assert.equal(next.items[0].answer,'DEG');assert.match(next.messages.at(-1).text,/DEG/);
 appendMessage(next,{text:'오래된 RAD 요청'});const message=next.messages.at(-1);message.at='2001-01-01T00:00:00Z';
 result.items[0].recommendation=rec('RAD','user',[message.id]);
 const preserved=applyQuestionSynthesis(next,[n.id],jobs(n),result,{id:'old-chat',lead:'codex'});assert.equal(preserved.items[0].answer,'DEG');
 assert.match(questionSynthesisPrompt(project,next,[n.id],jobs(n),'DEG로 변경'),/오래된 RAD 요청/);
});

test('synthesis rejects omitted sources, lost existing questions, mismatched nodes and contradictory saved answers atomically',()=>{
 const {p,n}=sample();const first=addDecision(p,question(n.id));updateDecision(p,first.id,{answer:'DEG'},'confirm');
 const before=structuredClone(p),raw=merged(n,[first.id]);
 for(const mutate of [r=>r.items[0].sourceRefs.pop(),r=>r.items[0].existingIds=[],r=>r.items[0].nodeIds=['missing'],r=>r.items[0].recommendation=rec('RAD','user',['invented'])]){
  const bad=structuredClone(raw);mutate(bad);assert.throws(()=>applyQuestionSynthesis(p,[n.id],jobs(n),bad,{id:'bad',lead:'codex'}));assert.deepEqual(p,before);
 }
 const second=addDecision(p,question(n.id,'두 번째 질문'));updateDecision(p,second.id,{answer:'RAD'},'confirm');raw.items[0].existingIds.push(second.id);
 assert.throws(()=>validateQuestionSynthesis(p,[n.id],jobs(n),raw),/서로 다른 기존 답변/);
});

test('external fact checks and explicit deferrals remain unresolved while design defaults are adopted',()=>{
 const {project,p,n}=sample(),input=question(n.id);input.type='verification';input.question='실제 API 계정이 있나요?';input.recommendation=rec('','unresolved');
 const result={summary:'외부 확인 분리',items:[{...input,existingIds:[],sourceRefs:['codex-1']}],omitted:[]};
 const next=applyQuestionSynthesis(p,[n.id],[{agent:'codex',id:'fact',result:{summary:'',items:[input]}}],result,{id:'fact-merged',lead:'codex'});
 assert.equal(next.items[0].status,'check');assert.equal(next.items[0].answer,'');
 const deferred=addDecision(next,question(n.id));updateDecision(next,deferred.id,{deferReason:'검토 후 답변'},'defer');
 const base=finalizePlan(project,next).baselines[0];assert.equal(base.snapshot.items.find(i=>i.id===deferred.id).answer,'');
});

test('deep node organization and split subtasks preserve source IDs and questions with explicit trace',()=>{
 const {p,n}=sample();const original=addDecision(p,question(n.id));
 const node=(id,parentId,sourceIds,type='group')=>({id,parentId,sourceIds,title:id,description:'포함 관계',instructions:'실제 구현',criteria:'동작 확인',reason:'기능 분리',nodeType:type,dependsOn:[],functionSteps:[],order:type==='task'?1:null,dependencyState:'defined',dependencyIssues:[]});
 const result={summary:'여러 깊이로 정리',nodes:[node('engine',null,[n.id]),node('parser','engine',[]),node('tokens','parser',[]),{...node('number','tokens',[],'task'),derivedFrom:[n.id]}],excluded:[]};
 const next=organizePlan(p,[n.id],result,{agent:'claude',runId:'deep',review:{jobs:[{agent:'codex',result}]}});
 assert.equal(next.nodes.length,5);const task=next.nodes.find(x=>x.title==='number');let depth=0,id=task.id;while(id!==p.rootId){id=next.edges.find(e=>e.to===id).from;depth++;}assert.equal(depth,4);
 assert.equal(next.items[0].id,original.id);assert.deepEqual(next.items[0].nodeIds,[n.id]);assert.equal(next.reviewHistory[0].kind,'organize');
 assert.equal(travelHistory(next,'undo').nodes.length,2);
});
