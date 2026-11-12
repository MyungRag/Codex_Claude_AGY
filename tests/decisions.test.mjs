import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPlan,addNode,editNode,removeNode,mergeNodes,changePlan,travelHistory,validatePlan,layoutPlan,reviewPrompt} from '../public/planning-model.js';
import {addDecision,updateDecision,applyDecisionReviews,readiness,finalizePlan,createAssignments,saveAssignments,handoffDocument,decisionPrompt} from '../public/decision-model.js';
import {organizePlan} from '../public/organize-model.js';
import {validateProject,readBackup,importCopies} from '../public/model.js';
const project={id:'kaf',name:'KAF',description:'대한항공 가격 비교',instructions:'사용자 결정을 준수한다.'};
const sample=()=>{const p=createPlan(project),a=addNode(p,p.rootId,{title:'가격 검색',instructions:'검색한다',criteria:'날짜별 가격 표시'}),b=addNode(p,p.rootId,{title:'가격 비교',instructions:'비교한다',criteria:'두 항공편 비교'});return {p:validatePlan(p),a,b};};
const question=(ids,extra={})=>({type:'question',nodeIds:ids,question:'어떤 가격을 비교할까요?',reason:'범위 결정',options:[],blocking:true,...extra});
const reply=(p,id,answer='최종 결제 가격',action='confirm')=>changePlan(p,'답변',p=>updateDecision(p,id,{answer,evidence:'사용자 결정'},action));

test('legacy plans migrate and one question keeps one answer with all AI sources, without overwriting user decisions',()=>{
 let {p,a}=sample();const legacy=structuredClone(p);delete legacy.items;delete legacy.baselines;delete legacy.handoffs;delete legacy.questionCoverage;
 assert.deepEqual(validatePlan(legacy).items,[]);
 const proposal={summary:'확인',items:[question([a.id])]};
 p=applyDecisionReviews(p,['codex','claude','agy'].map(agent=>({id:'run-'+agent,agent,result:proposal})),[a.id],'questions');
 assert.equal(p.items.length,1);assert.equal(p.items[0].sources.length,3);assert.equal(p.questionCoverage.length,1);
 const id=p.items[0].id;p=reply(p,id);assert.equal(p.items[0].status,'done');
 p=applyDecisionReviews(p,[{id:'run-new',agent:'codex',result:proposal}],[a.id],'questions');assert.equal(p.items[0].answer,'최종 결제 가격');assert.equal(p.items[0].status,'done');
 assert.match(decisionPrompt(project,p,'questions'),/최종 결제 가격/);assert.match(reviewPrompt(project,p,a.id),/최종 결제 가격/);
 const before=structuredClone(p);assert.throws(()=>applyDecisionReviews(p,[{id:'bad-run',agent:'agy',result:{summary:'',items:[question(['missing'])]}}],[a.id],'questions'),/검토하지 않은/);assert.deepEqual(p,before);
});

test('node edits invalidate answers and coverage; layout preserves them; deletion and organization reconcile atomically with undo',()=>{
 let {p,a,b}=sample();p=applyDecisionReviews(p,[{id:'review-a',agent:'codex',result:{summary:'',items:[question([a.id]),question([a.id,b.id],{question:'통화는?',blocking:false})]}}],[a.id,b.id],'questions');
 p=reply(p,p.items[0].id);p=reply(p,p.items[1].id,'KRW');
 const moved=changePlan(p,'정렬',layoutPlan);assert.equal(moved.items[0].status,'done');assert.equal(moved.questionCoverage.length,2);
 const edited=changePlan(p,'변경',x=>editNode(x,a.id,{...a,title:'다구간 가격 검색'}));assert.equal(edited.items[0].status,'check');assert.equal(edited.items[0].answer,'최종 결제 가격');assert.equal(edited.questionCoverage.length,1);
 const deleted=changePlan(p,'삭제',x=>removeNode(x,a.id));assert.equal(deleted.items.length,1);assert.deepEqual(deleted.items[0].nodeIds,[b.id]);assert.equal(deleted.items[0].status,'check');assert.deepEqual(travelHistory(deleted,'undo').items,p.items);
 const proposal={summary:'범위 축소',nodes:[{id:'keep',sourceIds:[b.id],parentId:null,title:'가격 비교',description:'정리된 범위',instructions:'비교한다',criteria:'비교 결과',reason:'중복 제거'}],excluded:[{id:a.id,reason:'이번 범위 밖'}]};
 const organized=organizePlan(p,[a.id,b.id],proposal,{agent:'agy',runId:'org-1'});assert.equal(organized.items.length,1);assert.deepEqual(organized.items[0].nodeIds,[b.id]);assert.deepEqual(travelHistory(organized,'undo').items,p.items);
});

test('merging remaps shared questions, combines equal answers only and preserves conflicting answers',()=>{
 let {p,a,b}=sample();p=changePlan(p,'질문',x=>{addDecision(x,question([a.id]),'codex');addDecision(x,question([b.id]),'claude');});
 const merged=changePlan(p,'통합',x=>mergeNodes(x,[a.id,b.id],{...a,title:'가격 조회'}));assert.equal(merged.items.length,1);assert.equal(merged.items[0].sources.length,2);
 p=reply(p,p.items[0].id,'운임');p=reply(p,p.items[1].id,'세금 포함');const different=changePlan(p,'통합',x=>mergeNodes(x,[a.id,b.id],{...a,title:'가격 조회'}));assert.equal(different.items.length,2);assert.deepEqual(different.items.map(i=>i.answer),['운임','세금 포함']);assert.ok(different.items.every(i=>i.status==='check'));
 const organization=organizePlan(p,[a.id,b.id],{summary:'통합',nodes:[{id:'keep',sourceIds:[a.id,b.id],parentId:null,...{title:'가격 조회',description:'',instructions:'검색',criteria:'결과',reason:'통합'}}],excluded:[]},{agent:'agy'});assert.ok(organization.items.every(i=>i.nodeIds[0]===a.id));
});

test('conflicts link two real decisions and re-open when a related answer changes; deleted questions remove orphan conflicts',()=>{
 let {p,a,b}=sample();p=changePlan(p,'질문',x=>{addDecision(x,question([a.id]));addDecision(x,question([b.id],{question:'세금도 포함하나요?'}));});p=reply(p,p.items[0].id,'총액');p=reply(p,p.items[1].id,'세금 제외');const ids=p.items.map(i=>i.id);
 p=changePlan(p,'충돌',x=>addDecision(x,question([a.id],{type:'conflict',relatedIds:ids,question:'총액과 세금 제외 중 어느 쪽인가요?'}),'agy'));
 assert.deepEqual(new Set(p.items[2].nodeIds),new Set([a.id,b.id]));const conflict=p.items[2].id;p=reply(p,conflict,'총액 기준으로 통일');p=reply(p,ids[1],'운임만');assert.equal(p.items[2].status,'check');assert.match(p.items[2].changedReason,/관련 결정/);
 const removed=changePlan(p,'질문 삭제',x=>{x.items=x.items.filter(i=>i.id!==ids[0]);});assert.ok(!removed.items.some(i=>i.id===conflict));assert.deepEqual(travelHistory(removed,'undo').items,p.items);
});

test('readiness gates important unanswered questions, conflicts and missing criteria; explicit deferral and immutable baselines survive backup',()=>{
 let {p,a,b}=sample();p=changePlan(p,'질문',x=>addDecision(x,question([a.id])));assert.equal(readiness(project,p).ready,false);assert.throws(()=>finalizePlan(project,p),/중요/);
 p=changePlan(p,'보류',x=>updateDecision(x,x.items[0].id,{deferReason:'실데이터 연동 전 확인'},'defer'));assert.equal(readiness(project,p).ready,true);
 const missing=changePlan(p,'기준 지움',x=>editNode(x,a.id,{...a,criteria:''}));assert.equal(readiness(project,missing).missing.length,1);
 p=finalizePlan(project,p,'1차 범위');assert.equal(readiness(project,p).current,true);assert.throws(()=>finalizePlan(project,p),/이미 확정/);
 const snapshot=structuredClone(p.baselines[0].snapshot);const tasks=createAssignments(p.baselines[0]);tasks[1].dependsOn=[tasks[0].nodeId];p=saveAssignments(p,p.baselines[0].id,tasks);
 assert.equal(readiness(project,p).current,true);assert.match(handoffDocument(p.baselines[0],p.handoffs[0]),/실데이터 연동 전 확인/);
 p=changePlan(p,'내용 수정',x=>editNode(x,b.id,{...b,title:'수하물 포함 비교'}));assert.equal(readiness(project,p).current,false);assert.deepEqual(p.baselines[0].snapshot,snapshot);
 p=finalizePlan(project,p);assert.equal(p.baselines[1].number,2);
 const original=validateProject({...project,planning:p});const backup=JSON.stringify({format:'agent-desk-projects',version:1,projects:[original]});const copies=importCopies([original],readBackup(JSON.parse(backup)));assert.equal(copies.length,2);assert.notEqual(copies[1].id,original.id);assert.deepEqual(copies[1].planning,p);
 const corrupt=structuredClone(p);corrupt.baselines[0].snapshot.edges.push({from:a.id,to:a.id});assert.throws(()=>validatePlan(corrupt),/순환/);
});

test('handoff requires every node once, meaningful instructions and acyclic execution dependencies',()=>{
 let {p}=sample();p=finalizePlan(project,p);const base=p.baselines[0],tasks=createAssignments(base);
 assert.throws(()=>saveAssignments(p,base.id,tasks.slice(1)),/모든 작업/);
 assert.throws(()=>saveAssignments(p,base.id,tasks.map(t=>({...t,instructions:''}))),/업무 지시/);
 assert.throws(()=>saveAssignments(p,base.id,tasks.map((t,i)=>({...t,dependsOn:[tasks[1-i].nodeId]}))),/순환/);
 assert.throws(()=>saveAssignments(p,base.id,tasks.map(t=>({...t,agent:'unknown'}))),/담당/);
});
