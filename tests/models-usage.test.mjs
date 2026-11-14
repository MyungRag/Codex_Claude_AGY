import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {AgentRunner,invocation} from '../scripts/agent-runner.mjs';
import {readMetadata,usageSummary} from '../scripts/agent-metadata.mjs';
import {normalizeCatalog} from '../scripts/agent-catalog.mjs';
import {validateSettings} from '../public/agent-settings.js';
import {RunnerClient} from '../public/agent-client.js';

test('model and reasoning settings reach all CLI adapters as separate arguments and invalid values are rejected',()=>{
 const opts={schemaFile:'schema.json',outputFile:'output.json',prompt:'task',settings:{model:'gpt-6-astra',effort:'xhigh'}};
 const codex=invocation('codex',opts);assert.equal(codex.args[codex.args.indexOf('--model')+1],'gpt-6-astra');assert.ok(codex.args.includes('model_reasoning_effort="xhigh"'));
 for(const agent of ['claude','agy']){const args=invocation(agent,{...opts,settings:{model:agent==='claude'?'opus':'provider/model-id',effort:'high'}}).args;assert.ok(args.includes('--model'));assert.equal(args[args.indexOf('--effort')+1],'high');}
 for(const model of ['--evil','x; curl bad','$(command)','model\narg'])assert.throws(()=>validateSettings('codex',{model}),/모델 ID/);
 assert.throws(()=>validateSettings('agy',{effort:'ultra'}),/추론/);
 assert.ok(!invocation('codex',{...opts,settings:{}}).args.includes('--model'));
});

test('provider token totals do not double-count cached or reasoning tokens, absent usage stays unknown',()=>{
 const codex=readMetadata('codex',JSON.stringify({type:'turn.completed',usage:{input_tokens:1000,output_tokens:100,cached_input_tokens:800,reasoning_output_tokens:70}}));assert.equal(codex.usage.totalTokens,1100);assert.equal(codex.usage.reasoningTokens,70);
 const claude=readMetadata('claude',JSON.stringify({usage:{input_tokens:100,cache_read_input_tokens:700,cache_creation_input_tokens:50,output_tokens:80},modelUsage:{opus:{inputTokens:850,outputTokens:80}}}));assert.equal(claude.usage.inputTokens,850);assert.equal(claude.usage.totalTokens,930);assert.equal(claude.actualModel,'opus');
 const agy=readMetadata('agy',[{event:'step_update',step_update:{usage:{input_tokens:500,output_tokens:10}}},{event:'result',result:{usage:{input_tokens:500,output_tokens:10,cache_read_tokens:400,thinking_tokens:8,total_tokens:510}}}].map(JSON.stringify).join('\n'));assert.equal(agy.usage.totalTokens,510);
 assert.equal(readMetadata('codex','{}').usage,null);assert.equal(readMetadata('claude','{"usage":{"input_tokens":-1}}').usage,null);
 const total=usageSummary([{agent:'codex',usage:codex.usage},{agent:'codex',usage:null}]);assert.equal(total.codex.totalTokens,1100);assert.equal(total.codex.unreportedRequests,1);assert.equal(total.agy.totalTokens,null);
});

test('runner captures usage even on invalid response, polling does not recount, request dedup includes model settings',async()=>{
 const fixture=fileURLToPath(new URL('./fixtures/agent-cli.mjs',import.meta.url)),runner=new AgentRunner({resolve:async agent=>({command:process.execPath,prefix:[fixture,agent]})});
 const request={agent:'agy',prompt:'fixture:cycle',requestId:crypto.randomUUID(),settings:{model:'gemini-test',effort:'high'}};
 const first=runner.create(request);assert.equal(runner.create(request).id,first.id);assert.throws(()=>runner.create({...request,settings:{model:'another'}}),/식별자/);
 await runner.jobs.get(first.id).done;assert.equal(runner.get(first.id).status,'failed');assert.equal(runner.get(first.id).usage.totalTokens,840);
 for(let i=0;i<4;i++)runner.get(first.id);assert.equal(runner.usage().agents.agy.requests,1);assert.equal(runner.usage().agents.agy.totalTokens,840);await runner.close();
});

test('model catalog preserves CLI IDs and supported efforts; saved selections survive clients and old runners cannot ignore them',async()=>{
 const catalog=normalizeCatalog('codex',[{id:'label',model:'gpt-6-astra',displayName:'GPT-6 Astra',supportedReasoningEfforts:[{reasoningEffort:'xhigh'}]}]);assert.equal(catalog[0].id,'gpt-6-astra');assert.deepEqual(catalog[0].efforts,['xhigh']);
 assert.equal(normalizeCatalog('agy',{models:[{id:'model-a',display_name:'Model A'}]})[0].name,'Model A');
 const map=new Map(),storage={getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v)},calls=[];
 const a=new RunnerClient({storage,preferences:storage,fetcher:async(url,options)=>{calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({id:'job'})};}});a.catalogs.codex={models:catalog};a.saveSettings('codex',{model:'gpt-6-astra',effort:'xhigh'});
 const b=new RunnerClient({storage,preferences:storage});assert.deepEqual(b.getSettings('codex'),{model:'gpt-6-astra',effort:'xhigh'});
 await assert.rejects(a.start('codex','prompt'),/v0.12.0/);assert.equal(calls.length,0);
 a.runnerInfo={features:{modelSelection:true,modelCapabilities:true,unlimitedWait:true}};await a.start('codex','prompt');assert.deepEqual(calls[0].settings,{model:'gpt-6-astra',effort:'xhigh'});
});
