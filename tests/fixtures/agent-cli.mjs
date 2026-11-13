import {writeFile,readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
const [agent,...args]=process.argv.slice(2);
if(args.includes('--version')){console.log(agent+' 99.0.0');process.exit(0);}
if(args.includes('--help')){console.log('--output-schema --ignore-user-config --ignore-rules --json-schema --safe-mode --tools --strict-mcp-config --input-format --mode');process.exit(0);}
if(args[0]==='models'){console.log(JSON.stringify({models:[{slug:'gemini-test',label:'Gemini Test',efforts:['low','high']},{slug:'gemini-test-low',label:'Gemini Test (Low)'},{slug:'gemini-test-high',label:'Gemini Test (High)'},{slug:'fixture-agy',label:'AGY default',efforts:['low','high'],is_default:true}]}));process.exit(0);}
if(args[0]==='app-server'||(agent==='claude'&&args.includes('--input-format'))){
 for await(const line of createInterface({input:process.stdin})){
  const message=JSON.parse(line);
  if(message.method==='initialize')console.log(JSON.stringify({id:0,result:{}}));
  else if(message.method==='model/list')console.log(JSON.stringify({id:message.id,result:{data:[{model:'gpt-6-astra',displayName:'GPT-6 Astra',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'xhigh'},{reasoningEffort:'max'}]}]}}));
  else if(message.type==='control_request')console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{models:[{value:'default',displayName:'Default',supportsEffort:true,supportedEffortLevels:['low','medium','high']},{value:'opus',displayName:'Opus',supportedEffortLevels:['low','medium','high']},{value:'haiku',displayName:'Haiku',supportsEffort:false}]}}}));
  else if(message.method!=='initialized')throw new Error('Catalog process must not receive user prompts');
 }
 process.exit(0);
}
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const selectedModel=args.includes('--model')?args[args.indexOf('--model')+1]:'fixture-claude',actualModel=selectedModel==='sonnet'?'claude-sonnet-5-5':selectedModel;
if(agent==='claude'&&args.includes('--include-partial-messages')){
 console.log(JSON.stringify({type:'system',subtype:'init',model:actualModel}));
 console.log(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'private reasoning MUST-NOT-LEAK'}}}));
}

if(prompt.includes('fixture:slow'))await new Promise(r=>setTimeout(r,1500));
if(prompt.includes('fixture:hang'))await new Promise(()=>setInterval(()=>{},1000));
if(prompt.includes('fixture:quota')){console.error('quota 429');process.exit(1);}
if(prompt.includes('fixture:overflow')){console.log('x'.repeat(100000));process.exit(0);}
const output={summary:'검토 의견 '+agent,nodes:prompt.includes('연결 확인 요청')?[]:[{id:'search',parentId:null,title:'검색 조건',description:'날짜와 노선을 입력한다.',instructions:'입력 검증 포함',criteria:'날짜 선택 가능',reason:'첫 단계'}]};
if(prompt.includes('정리할 노드 ID:')){const ids=JSON.parse(prompt.match(/정리할 노드 ID: (.+)\n/)[1]);output.nodes=[{...output.nodes[0],id:'organized',title:'정리된 검색 흐름',sourceIds:ids}];output.excluded=[];}
if(prompt.includes('fixture:cycle'))output.nodes[0].parentId='search';
const schemaArg=args.includes('--output-schema')?args[args.indexOf('--output-schema')+1]:args[args.indexOf('--json-schema')+1];
const schema=JSON.parse(agent==='claude'?schemaArg:await readFile(schemaArg,'utf8'));
if(schema.properties.items){delete output.nodes;output.items=[{type:'question',nodeIds:['work-a'],relatedIds:[],question:'어떤 가격을 비교할까요?',reason:'범위 확인',evidence:'사용자 확인 필요',options:[{label:'최종 가격',impact:'세금 포함'}],blocking:true}];}
if(schema.properties.tasks){delete output.nodes;output.tasks=[{nodeId:'work-a',agent:'codex',dependsOn:[],instructions:'최종 가격을 비교한다',deliverable:'가격 비교 화면',criteria:'세금 포함 확인'}];}

if(agent==='codex'){await writeFile(args[args.indexOf('--output-last-message')+1],JSON.stringify(output));console.log(JSON.stringify({type:'thread.started'}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1000,cached_input_tokens:400,output_tokens:50,reasoning_output_tokens:10}}));}
else if(agent==='claude')console.log(JSON.stringify({type:'result',is_error:false,structured_output:output,usage:{input_tokens:100,cache_read_input_tokens:400,cache_creation_input_tokens:50,output_tokens:20},modelUsage:{[actualModel]:{inputTokens:550,outputTokens:20}}}));
else{console.log(JSON.stringify({event:'init',init:{model:args.includes('--model')?args[args.indexOf('--model')+1]:'fixture-agy'}}));console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',structured_output:output,usage:{input_tokens:800,output_tokens:40,thinking_tokens:15,cache_read_tokens:100,total_tokens:840}}}));}
