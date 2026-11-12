import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPlan,addNode,appendMessage,importProposals,parseProposals,travelHistory,validatePlan} from '../public/planning-model.js';
import {organizePlan,parseOrganization} from '../public/organize-model.js';
const item=(id,sourceIds,parentId=null)=>({id,parentId,sourceIds,title:id,description:'정리된 설명',instructions:'기존 요구 보존',criteria:'동작 확인',reason:'중복 통합'});
function sample(){const p=createPlan({name:'KAF'}),a=addNode(p,p.rootId,{title:'날짜 검색'}),b=addNode(p,p.rootId,{title:'날짜 선택'}),c=addNode(p,p.rootId,{title:'가격 비교'});importProposals(p,'codex',parseProposals(JSON.stringify({nodes:[{id:'copy',title:a.title}]})),'live');appendMessage(p,{nodeId:b.id,text:'날짜 범위를 유지'});return {p,a,b,c};}

test('AI organization merges sources, changes hierarchy, retains provenance and comments, and is undoable and idempotent',()=>{
 const {p,a,b,c}=sample(),ids=[a.id,b.id,c.id];const proposal={summary:'검색을 정리했습니다.',nodes:[item('search',[a.id,b.id]),item('compare',[c.id],'search')],excluded:[]};
 const next=organizePlan(p,ids,proposal,{agent:'agy',runId:'run-1',settings:{model:'model-a'}});
 assert.equal(next.nodes.length,3);assert.ok(next.edges.some(e=>e.from===a.id&&e.to===c.id));assert.ok(!next.edges.some(e=>e.from===p.rootId&&e.to===c.id));assert.equal(next.messages[0].nodeId,a.id);assert.equal(next.proposals[0].nodeId,a.id);assert.equal(p.nodes.length,4);
 assert.equal(organizePlan(next,[a.id,c.id],{summary:'again',nodes:[item('a',[a.id]),item('c',[c.id])],excluded:[]},{agent:'agy',runId:'run-1'}),next);
 const restored=travelHistory(next,'undo');assert.deepEqual(restored.nodes,p.nodes);assert.deepEqual(restored.proposals,p.proposals);assert.deepEqual(restored.messages,p.messages);assert.deepEqual(validatePlan(next),next);
});

test('organization rejects omitted sources, duplicate sources, cycles and deletions without reasons without changing the original',()=>{
 const {p,a,b,c}=sample(),before=structuredClone(p),ids=[a.id,b.id,c.id];
 assert.throws(()=>organizePlan(p,ids,{summary:'',nodes:[item('a',[a.id])],excluded:[]},{agent:'codex'}),/모든 선택/);
 assert.throws(()=>organizePlan(p,ids,{summary:'',nodes:[item('a',[a.id,b.id]),item('b',[b.id,c.id])],excluded:[]},{agent:'codex'}),/모든 선택/);
 assert.throws(()=>parseOrganization({summary:'',nodes:[item('a',[], 'b'),item('b',[],'a')],excluded:[]}),/순환/);
 assert.throws(()=>parseOrganization({summary:'',nodes:[],excluded:[{id:a.id,reason:''}]}),/이유/);assert.deepEqual(p,before);
});

test('selected-node organization preserves unselected boundary links and explicit exclusions keep original proposals',()=>{
 const {p,a,b,c}=sample();const child=addNode(p,a.id,{title:'선택하지 않은 하위'});
 assert.throws(()=>organizePlan(p,[a.id],{summary:'',nodes:[],excluded:[{id:a.id,reason:'제외'}]},{agent:'codex'}),/하위/);
 const next=organizePlan(p,[a.id,b.id],{summary:'합침',nodes:[item('merged-search',[a.id,b.id])],excluded:[]},{agent:'claude'});
 assert.ok(next.nodes.some(n=>n.id===c.id));assert.ok(next.edges.some(e=>e.from===a.id&&e.to===child.id));
 const removed=organizePlan(p,[a.id,child.id],{summary:'제외',nodes:[],excluded:[{id:a.id,reason:'범위 밖'},{id:child.id,reason:'상위와 함께 제외'}]},{agent:'codex'});assert.equal(removed.proposals[0].nodeId,null);assert.equal(removed.nodes.length,3);
});
