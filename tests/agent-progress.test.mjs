import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {AgentRunner} from '../scripts/agent-runner.mjs';
import {observeAgentStream} from '../scripts/agent-stream.mjs';
import {jobActivityState} from '../public/progress-model.js';
const fixture=fileURLToPath(new URL('./fixtures/agent-cli.mjs',import.meta.url));
const resolve=async agent=>({command:process.execPath,prefix:[fixture,agent]});
const pause=ms=>new Promise(r=>setTimeout(r,ms));

test('chunked agent events expose activity metadata, never text, reasoning, or tool output',()=>{
 const samples={codex:[{type:'thread.started'},{type:'item.updated',item:{type:'reasoning',text:'PRIVATE'}},{type:'item.completed',item:{type:'agent_message',text:'PRIVATE'}},{type:'turn.completed'}],agy:[{event:'init',init:{model:'gemini-fixture'}},{event:'message',content:'PRIVATE'},{event:'result',result:{text:'PRIVATE'}}],claude:[{type:'system',subtype:'init',model:'claude-fixture'},{type:'stream_event',event:{type:'content_block_delta',delta:{thinking:'PRIVATE'}}},{type:'result',result:'PRIVATE'}]};
 for(const [agent,events] of Object.entries(samples)){
  const changes=[],observe=observeAgentStream(agent,(progress,model)=>changes.push({progress,model}));
  const lines='not-json\n'+events.map(JSON.stringify).join('\n')+'\n';
  for(let i=0;i<lines.length;i+=7)observe(lines.slice(i,i+7));
  assert.equal(changes.length,events.length);assert.equal(changes.at(-1).progress.phase,'result');
  assert.equal(changes.at(-1).progress.eventCount,events.length);assert.ok(!JSON.stringify(changes).includes('PRIVATE'));
 }
});

for(const agent of ['codex','claude','agy'])test(`${agent}: process liveness, output freshness, and polling are distinct; cancellation stops the real fixture process`,async t=>{
 const r=new AgentRunner({resolve});t.after(()=>r.close());
 const created=r.create({agent,prompt:'fixture:progress-hang',requestId:crypto.randomUUID()});
 for(let i=0;i<400;i++){const j=r.get(created.id);if(j.progress?.eventCount>=2&&j.activity?.stderrBytes>0)break;await pause(5);}
 const before=r.get(created.id);assert.equal(before.status,'running');assert.equal(before.process.state,'running');
 assert.ok(before.progress.eventCount>=2);assert.ok(before.activity.stdoutBytes>0);assert.ok(before.activity.stderrBytes>0);
 assert.ok(!/PRIVATE|MUST-NOT-LEAK/.test(JSON.stringify(before)));
 await pause(30);const after=r.get(created.id);
 assert.ok(Date.parse(after.observedAt)>Date.parse(before.observedAt));assert.ok(after.elapsedMs>before.elapsedMs);
 assert.deepEqual(after.activity,before.activity,'polling must not invent new output');assert.ok(after.outputIdleMs>before.outputIdleMs);
 assert.equal(r.cancel(created.id).status,'cancelled');await r.jobs.get(created.id).done;
 assert.equal(r.get(created.id).process.state,'exited');assert.equal(r.get(created.id).settled,true);
 const elapsed=r.get(created.id).elapsedMs;await pause(15);assert.equal(r.get(created.id).elapsedMs,elapsed);
});

test('progress UI distinguishes silence from disconnection without claiming stopped or estimating completion',()=>{
 const now=Date.parse('2026-11-14T00:00:00Z');
 const job={id:'job',status:'running',lastCheckedAt:new Date(now-1000).toISOString(),startedAt:new Date(now-200000).toISOString(),elapsedMs:199000,outputIdleMs:130000,process:{state:'running'},activity:{stdoutBytes:100,stderrBytes:20},timeoutMs:0};
 const quiet=jobActivityState(job,now);assert.equal(quiet.state,'quiet');assert.equal(quiet.connection,'연결 정상');assert.equal(quiet.process,'실행 중');assert.equal(quiet.elapsed,'3분 20초');assert.match(quiet.note,/정지 여부는 확정할 수 없습니다/);assert.equal(quiet.bytes,120);
 const stale=jobActivityState(job,now+10000);assert.equal(stale.state,'unknown');assert.equal(stale.process,'현재 상태 미확인');assert.equal(stale.connection,'확인 지연');assert.equal(stale.elapsed,'3분 30초');
 const recent=jobActivityState({...job,outputIdleMs:0},now);assert.equal(recent.state,'receiving');
 const disconnected=jobActivityState({...job,status:'unknown'},now);assert.equal(disconnected.connection,'확인 지연');
 assert.equal(jobActivityState({status:'running',requestedAt:new Date(now).toISOString()},now).state,'starting');
 assert.equal(jobActivityState({...job,process:{state:'exited'}},now).state,'finishing');
 const finished={...job,status:'succeeded',finishedAt:new Date(now).toISOString(),elapsedMs:200000};
 assert.equal(jobActivityState(finished,now+60000).elapsed,'3분 20초');assert.equal(jobActivityState(finished,now+60000).output,jobActivityState(finished,now).output);
});
