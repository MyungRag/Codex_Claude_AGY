import {test} from 'node:test';
import assert from 'node:assert/strict';
import {taskProgress,nodeProgress} from '../public/development-progress.js';
import {agentCardsHTML} from '../public/execution-monitor.js';
test('node phases derive from actual roles and keep terminal results, never stale analysis text',()=>{
 const task={id:'a',status:'limited',artifactSha:'sha',phase:'분석 중',integration:{codeSha:'sha',status:'implemented',verified:true,summary:'Real check passed'}};
 const state={status:'running',aiCalls:[{taskId:'a',kind:'development-analysis',agent:'agy',status:'running'}]};assert.equal(taskProgress(task,state).role,'Challenger 분석');assert.equal(taskProgress(task,state).agent,'agy');
 state.status='completed';state.tasks=[{isAssembly:true,artifactSha:'sha'}];assert.equal(taskProgress(task,state).label,'통합 후 동작 확인');state.tasks[0].artifactSha='new';assert.equal(taskProgress(task,state).label,'일부 구현 · 검증 필요');
 assert.match(taskProgress({id:'failed',status:'limited',artifactSha:'s',checks:[{label:'검색',passed:false,exitCode:1,output:'결과 누락'}]},{}).detail,/결과 누락/);
 assert.match(taskProgress({id:'b',status:'blocked'},state).label,/미개발/);
 const plan={rootId:'root',nodes:[{id:'root'},{id:'group',nodeType:'group'},{id:'a'},{id:'b'}],edges:[{from:'root',to:'group'},{from:'group',to:'a'},{from:'group',to:'b'}]};assert.match(nodeProgress(plan,'root',{tasks:[{id:'a',status:'passed',artifactSha:'s'}]}).label,/1\/2/);
});
test('shared request cards show current planning roles and retain explicit success/failure/cancellation',()=>{
 const calls=[{id:'a',agent:'codex',kind:'planning-draft',status:'running',lastCheckedAt:new Date().toISOString()},{id:'b',agent:'claude',kind:'planning-draft',status:'failed'},{id:'c',agent:'agy',kind:'planning-draft',status:'cancelled'}];let html=agentCardsHTML({calls});assert.match(html,/독립 기획/);assert.match(html,/is-running/);assert.match(html,/응답 실패/);assert.match(html,/취소됨/);calls[0].status='succeeded';html=agentCardsHTML({calls});assert.match(html,/응답 완료/);assert.doesNotMatch(html,/is-running/);
});
