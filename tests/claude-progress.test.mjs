import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {AgentRunner,invocation,parseResponse} from '../scripts/agent-runner.mjs';
import {normalizeCatalog} from '../scripts/agent-catalog.mjs';
import {readMetadata} from '../scripts/agent-metadata.mjs';
import {observeClaudeStream} from '../scripts/claude-stream.mjs';
import {runProcess} from '../scripts/agent-process.mjs';
import {validateSettings,supportedEfforts} from '../public/agent-settings.js';
const fixture=fileURLToPath(new URL('./fixtures/agent-cli.mjs',import.meta.url)),resolve=async agent=>({command:process.execPath,prefix:[fixture,agent]});
const catalog={models:normalizeCatalog('claude',[
 {value:'sonnet',resolvedModel:'claude-sonnet-5-5',displayName:'Sonnet 5.5',supportedEffortLevels:['low','medium','high','xhigh','max']},
 {value:'claude-sonnet-4-6',resolvedModel:'claude-sonnet-4-6',displayName:'Sonnet 4.6',supportedEffortLevels:['low','medium','high','max']},
 {value:'claude-fable-5-1[1m]',resolvedModel:'claude-fable-5-1',displayName:'Fable 5.1',supportedEffortLevels:['high','max']}
])};

test('Claude 5.5 and 4.6 remain distinct; resolved metadata does not replace the CLI selection or strip context suffixes',()=>{
 assert.equal(catalog.models[0].resolvedModel,'claude-sonnet-5-5');assert.equal(catalog.models[1].id,'claude-sonnet-4-6');
 assert.deepEqual(supportedEfforts('claude',{model:'sonnet'},catalog),['low','medium','high','xhigh','max']);
 assert.deepEqual(supportedEfforts('claude',{model:'claude-sonnet-4-6'},catalog),['low','medium','high','max']);
 const spec=invocation('claude',{prompt:'task',settings:{model:'claude-fable-5-1[1m]',effort:'max',waitMinutes:10}});
 assert.equal(spec.args[spec.args.indexOf('--model')+1],'claude-fable-5-1[1m]');assert.ok(spec.args.includes('--include-partial-messages'));assert.ok(spec.args.includes('--verbose'));
});

test('stream parsing preserves final structured output and total usage without counting deltas or exposing reasoning',()=>{
 const lines=[{type:'system',subtype:'init',model:'claude-sonnet-5-5'},{type:'stream_event',event:{type:'content_block_delta',delta:{thinking:'PRIVATE'}}},{type:'result',is_error:false,structured_output:{summary:'완료',nodes:[]},usage:{input_tokens:10,output_tokens:20}}].map(JSON.stringify).join('\n')+'\n';
 const changes=[],observe=observeClaudeStream((progress,model)=>changes.push({progress,model}));observe(lines.slice(0,40));observe(lines.slice(40));
 assert.equal(changes[1].progress.phase,'receiving');assert.equal(changes[2].progress.eventCount,3);assert.ok(!JSON.stringify(changes).includes('PRIVATE'));
 assert.deepEqual(parseResponse('claude',lines),{summary:'완료',nodes:[]});const metadata=readMetadata('claude',lines);assert.equal(metadata.actualModel,'claude-sonnet-5-5');assert.equal(metadata.usage.totalTokens,30);
});

test('runner reports the selected version and live CLI model before a timed-out result, and does not blacklist supported Max',async t=>{
 const r=new AgentRunner({resolve,catalog:async()=>catalog,timeout:600});t.after(()=>r.close());
 await r.models('claude');
 const good=r.create({agent:'claude',prompt:'연결 확인 요청',kind:'probe',requestId:crypto.randomUUID(),settings:{model:'sonnet',effort:'max'}});await r.jobs.get(good.id).done;assert.equal(r.get(good.id).status,'succeeded');
 const stalled=r.create({agent:'claude',prompt:'fixture:hang',requestId:crypto.randomUUID(),settings:{model:'sonnet',effort:'max'}});
 let running;for(let i=0;i<120;i++){running=r.get(stalled.id);if(running.progress?.phase==='receiving')break;await new Promise(resolve=>setTimeout(resolve,5));}
 assert.equal(running.status,'running');assert.equal(running.actualModel,'claude-sonnet-5-5');assert.equal(running.modelInfo.name,'Sonnet 5.5');assert.equal(running.modelInfo.selectionId,'sonnet');assert.ok(!JSON.stringify(running).includes('MUST-NOT-LEAK'));
 await r.jobs.get(stalled.id).done;const failed=r.get(stalled.id);assert.equal(failed.errorCode,'AGENT_TIMEOUT');assert.equal(failed.timeoutMs,600);assert.ok(failed.elapsedMs>=600);assert.equal(failed.usage,null);assert.equal(failed.actualModel,'claude-sonnet-5-5');
 assert.ok((await r.status()).find(a=>a.id==='claude').verified);assert.ok(supportedEfforts('claude',{model:'sonnet'},r.catalogView('claude')).includes('max'));
});

test('unlimited is accepted and explicit finite wait limits reach the process and AGY deadline',async t=>{
 assert.equal(validateSettings('claude',{waitMinutes:0}).waitMinutes,0);for(const waitMinutes of [-1,1,Infinity,NaN,'0'])assert.throws(()=>validateSettings('claude',{waitMinutes}),/대기 시간/);
 const timeouts=[],r=new AgentRunner({resolve,catalog:async()=>catalog,run:(exe,args,opts)=>{if(args.includes('--json-schema'))timeouts.push(opts.timeout);return runProcess(exe,args,opts);}});t.after(()=>r.close());
 const job=r.create({agent:'claude',prompt:'연결 확인 요청',kind:'probe',requestId:crypto.randomUUID(),settings:{model:'sonnet',effort:'max',waitMinutes:10}});await r.jobs.get(job.id).done;assert.equal(r.get(job.id).status,'succeeded');assert.deepEqual(timeouts,[600000]);
 for(const settings of [{},{waitMinutes:0}])assert.ok(!invocation('agy',{prompt:'task',settings}).args.includes('--print-timeout'));
 const agy=invocation('agy',{prompt:'task',settings:{waitMinutes:20}});assert.equal(agy.args[agy.args.indexOf('--print-timeout')+1],'20m');
});


test('default and explicit unlimited jobs keep running until cancelled, including an explicit override of a finite runner limit',async t=>{
 for(const [options,settings] of [[{},{}],[{timeout:40},{waitMinutes:0}]]){
  const r=new AgentRunner({resolve,...options});t.after(()=>r.close());
  await r.status();const created=r.create({agent:'claude',prompt:'fixture:hang',requestId:crypto.randomUUID(),settings});
  assert.equal(created.timeoutMs,0);
  for(let i=0;i<100&&r.get(created.id).progress?.phase!=='receiving';i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(r.get(created.id).progress?.phase,'receiving');
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(r.get(created.id).status,'running');
  assert.equal(r.cancel(created.id).status,'cancelled');await r.jobs.get(created.id).done;
  assert.equal(r.get(created.id).status,'cancelled');assert.equal(r.get(created.id).errorCode,undefined);
 }
});
