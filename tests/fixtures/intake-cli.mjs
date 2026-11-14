// Deterministic responses for real CLI/process + browser verification. No paid AI calls.
import {readFile,writeFile} from 'node:fs/promises';
import {calculatorFiles} from './calculator.mjs';
const [provider,...args]=process.argv.slice(2);
if(args.includes('--version')){console.log('intake fixture 1.0');process.exit();}
if(args.includes('--help')){console.log('--output-schema --ignore-user-config --ignore-rules --json-schema --safe-mode --tools --strict-mcp-config --input-format --mode');process.exit();}
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;if(provider==='agy')prompt=JSON.parse(prompt).message.content;
const schemaArg=args[args.indexOf(args.includes('--output-schema')?'--output-schema':'--json-schema')+1],schema=JSON.parse(provider==='claude'?schemaArg:await readFile(schemaArg,'utf8'));let result;
await new Promise(r=>setTimeout(r,800));
const node=(id,title,parentId=null,type='task',dependsOn=[])=>({id,title,parentId,nodeType:type,description:title+' 기능',instructions:title+'을 구현하고 실제 결과를 확인하세요.',criteria:type==='group'?'하위 구성 완료':'호스트 기능 검사 통과',dependsOn,functionSteps:[],reason:'핵심 사용자 흐름'});
if(schema.properties.defaults){
 const ctx=JSON.parse(prompt.split('\n문맥: ')[1]);
 if(ctx.candidates.length){const parent=ctx.plan.nodes.find(n=>n.title==='계산 기능')?.id||ctx.plan.rootId;result={summary:'선택한 그래프만 계산 기능 아래에 편입합니다.',nodes:[node('plot','함수 그래프',parent)],defaults:[],deferred:[],promotions:ctx.candidates.map(b=>({backlogId:b.id,nodeIds:['plot'],reason:'계산 기능을 확장합니다.'}))};}
 else result={summary:'사칙·공학 연산과 입력 화면을 먼저 완성하고 그래프는 후속으로 보관합니다.',nodes:[node('calculator','계산 기능',null,'group'),node('engine','계산 엔진','calculator'),node('screen','계산 화면','calculator','task',['engine']),node('guide','사용 안내')],defaults:[{question:'각도 기본값',answer:'DEG',reason:'일반 계산기 기본값이며 화면에서 변경할 수 있습니다.',alternatives:['RAD'],nodeIds:['engine','screen']}],deferred:[{id:'graph',title:'함수 그래프',description:'함수 값을 시각화합니다.',benefit:'변화 추이를 쉽게 확인합니다.',reason:'첫 버전의 기본 계산 완성에 집중합니다.',difficulty:'좌표 변환·확대와 화면 검사가 필요합니다.',conditions:'계산 엔진의 함수 평가 결과가 준비되어야 합니다.',parentId:'calculator',dependsOn:['engine'],required:false}],promotions:[]};
}else if(schema.properties.strengths)result={summary:provider+'가 핵심 범위와 구현 가능성을 검토했습니다.',strengths:['핵심 계산부터 실행 가능'],risks:['그래프까지 포함하면 범위가 커짐'],changes:['그래프는 후속 후보로 유지']};
else{
 const value=JSON.parse(prompt.slice(prompt.indexOf('{')));
 if(value.role==='Builder'){
  await new Promise(r=>setTimeout(r,1600));
  const mode=value.baseline.snapshot.items.find(i=>i.resolution?.kind==='assumption')?.answer||'DEG';
  const files=value.task.title==='사용 안내'?[{path:'GUIDE.md',action:'write',content:'# 계산기 사용 안내\n수식 입력 후 계산을 누릅니다. 그래프는 후속 기능입니다.'}]:calculatorFiles({coreOnly:value.task.title==='계산 엔진',mode});
  for(const file of files)if(file.path==='agent-desk.checks.json'){const definition=JSON.parse(file.content),screen=value.baseline.snapshot.nodes.find(n=>n.title==='계산 화면').id;for(const check of definition.checks)check.nodeIds=[screen];file.content=JSON.stringify(definition);}
  result={summary:'검증용 계산기 소스',files,limitations:[]};
 }else if(value.role==='Auditor'){
  const passed=(value.task.title==='사용 안내'||value.checks.length>0)&&value.checks.every(c=>c.passed),evidence=value.checks.map(c=>c.label+' '+c.codeSha).join('; ')||'고정된 GUIDE.md 내용을 확인했습니다.';
  result={summary:passed?'호스트 실행 근거 확인':'검사 근거 필요',verdict:passed?'pass':'hold',handoff:{ready:passed,evidence},verifiedCriteria:passed?[{criterion:value.task.criteria,evidence}]:[],unverifiedCriteria:passed?[]:['호스트 실행 검사'],previousFindings:value.previousFindings.map(f=>({id:f.id,status:passed?'resolved':'open',evidence})),findings:[]};
 }else result={summary:'실제 실행 결과와 남은 후보를 기록했습니다.',risks:[],recommendation:'초안 실행 후 후속 기능 선택'};
}
if(provider==='codex'){await writeFile(args[args.indexOf('--output-last-message')+1],JSON.stringify(result));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:50}}));}
else if(provider==='claude')console.log(JSON.stringify({type:'result',is_error:false,structured_output:result}));
else console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',structured_output:result}}));
