import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {organizationPrompt,organizationSynthesisPrompt} from '../public/organize-model.js';
import {questionSynthesisPrompt} from '../public/review-model.js';
import {addDecision,updateDecision} from '../public/decision-model.js';
import {validatePromptSize,REVIEW_PROMPT_LIMIT,SYNTHESIS_PROMPT_LIMIT} from '../public/agent-limits.js';
import {AgentRunner} from '../scripts/agent-runner.mjs';
import {createAppServer} from '../scripts/server.mjs';

import {largeReview} from './fixtures/large-review.mjs';

test('26-node synthesis omits old AI repetition but preserves every current requirement and all three complete responses',()=>{
 const {project,plan,scope,jobs}=largeReview(),before=structuredClone({plan,jobs});
 const prompt=organizationSynthesisPrompt(project,plan,scope,jobs);
 assert.ok(prompt.length>REVIEW_PROMPT_LIMIT&&prompt.length<SYNTHESIS_PROMPT_LIMIT,String(prompt.length));
 assert.doesNotThrow(()=>validatePromptSize(prompt,'organize-merge'));
 assert.throws(()=>validatePromptSize(prompt,'organize'),e=>e.code==='PROMPT_TOO_LARGE'&&e.details.actual===prompt.length);
 assert.ok(!prompt.includes('과거 AI 설명 반복'));assert.match(prompt,/사용자 추가 요구: 오프라인/);
 for(const id of scope)assert.ok(prompt.includes(id));
 for(const agent of ['codex','claude','agy'])for(let i=0;i<26;i++)assert.ok(prompt.includes(agent+'-요구사항-끝-'+i));
 assert.deepEqual({plan,jobs},before,'prompt compaction must never mutate saved originals');
 assert.ok(organizationPrompt(project,plan,scope).length<REVIEW_PROMPT_LIMIT);
});

test('question synthesis sends current answers and options once without resending answer histories or old AI sources',()=>{
 const {project,plan,scope}=largeReview();const item=addDecision(plan,{type:'question',question:'각도 단위?',nodeIds:[scope[0]],options:[{label:'DEG',impact:'도 단위'},{label:'RAD',impact:'라디안'}]});
 updateDecision(plan,item.id,{answer:'DEG',evidence:'사용자가 선택한 기본값'},'confirm');
 item.sources=[{agent:'codex',reason:'이전 AI 원문 반복',evidence:'',options:[]}];item.history[0].answer='과거 답변 반복';
 const prompt=questionSynthesisPrompt(project,plan,[scope[0]],[]);
 assert.equal(prompt.split('각도 단위?').length-1,1);assert.match(prompt,/사용자가 선택한 기본값/);assert.match(prompt,/RAD/);assert.match(prompt,/오프라인 동작/);
 assert.ok(!prompt.includes('이전 AI 원문 반복')&&!prompt.includes('과거 답변 반복'));
});

test('large Korean synthesis passes the HTTP byte limit and real CLI adapter while oversized requests fail before dispatch',async t=>{
 const fixture=fileURLToPath(new URL('./fixtures/agent-cli.mjs',import.meta.url)),runner=new AgentRunner({resolve:async agent=>({command:process.execPath,prefix:[fixture,agent]})});
 const server=createAppServer({agentRunner:runner});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await runner.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const base='http://127.0.0.1:'+server.address().port,headers={'X-Agent-Desk':'agent-runner','Content-Type':'application/json'};
 const token=(await(await fetch(base+'/api/agents/session',{headers})).json()).token;headers.Authorization='Bearer '+token;
 const {project,plan,scope,jobs}=largeReview(),prompt=organizationSynthesisPrompt(project,plan,scope,jobs);
 const body=JSON.stringify({agent:'codex',kind:'organize-merge',prompt,requestId:crypto.randomUUID()});assert.ok(Buffer.byteLength(body)>600000,Buffer.byteLength(body));
 const response=await fetch(base+'/api/agents/jobs',{method:'POST',headers,body});assert.equal(response.status,202);const job=await response.json();await runner.jobs.get(job.id).done;
 assert.equal(runner.get(job.id).status,'succeeded',runner.get(job.id).error);assert.equal(runner.jobs.get(job.id).prompt,prompt);assert.deepEqual(runner.get(job.id).result.nodes[0].sourceIds,scope);
 for(const kind of ['organize','organize-merge','questions-merge']){
  const limit=kind==='organize'?REVIEW_PROMPT_LIMIT:SYNTHESIS_PROMPT_LIMIT;
  const rejected=await fetch(base+'/api/agents/jobs',{method:'POST',headers,body:JSON.stringify({agent:'codex',kind,prompt:'가'.repeat(limit+1),requestId:crypto.randomUUID()})});
  assert.equal(rejected.status,400);const error=await rejected.json();assert.equal(error.code,'PROMPT_TOO_LARGE');assert.deepEqual(error.details,{actual:limit+1,limit});assert.match(error.error,/기존 응답은 보관/);
 }
 assert.equal(runner.jobs.size,1);assert.equal(runner.usageRecords.length,1,'rejected requests cannot call the AI or consume another review');
});
