import {writeFile} from 'node:fs/promises';
import {calculatorFiles} from './calculator.mjs';
const [provider,...args]=process.argv.slice(2);
if(args.includes('--version')){console.log('fixture 1.0');process.exit();}
if(args.includes('--help')){console.log('--output-schema --ignore-user-config --ignore-rules --json-schema --safe-mode --tools --strict-mcp-config --input-format --mode');process.exit();}
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
if(provider==='agy')prompt=JSON.parse(prompt).message.content;
const value=JSON.parse(prompt.slice(prompt.indexOf('{')));let result;
if(value.role==='Builder'){
 const assumption=value.baseline.snapshot.items.find(i=>i.resolution?.kind==='assumption');
 if(!assumption?.answer)throw new Error('Builder must receive an adopted default');
 result={summary:'계산기 소스와 실제 검사 정의',files:calculatorFiles({coreOnly:value.task.id==='engine',mode:assumption.answer}),limitations:[]};
}else if(value.role==='independent Auditor'){
 const passed=value.checks.length>0&&value.checks.every(c=>c.passed);
 result={summary:passed?'호스트가 수행한 검사 확인':'실제 검사 근거 필요',verdict:passed?'pass':'hold',verifiedCriteria:passed?[{criterion:value.task.criteria,evidence:value.checks.map(c=>c.label+' '+c.codeSha).join('; ')}]:[],unverifiedCriteria:passed?[]:['호스트 실행 검사'],previousFindings:value.previousFindings.map(f=>({id:f.id,status:passed?'resolved':'open',evidence:'새 호스트 실행 결과'})),findings:[]};
}else result={summary:'실제 검사 결과와 적용 기본값을 기록했습니다.',risks:[],recommendation:'실행 가능한 초안 확인'};
if(provider==='codex'){await writeFile(args[args.indexOf('--output-last-message')+1],JSON.stringify(result));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:10}}));}
else if(provider==='claude')console.log(JSON.stringify({type:'result',is_error:false,structured_output:result}));
else console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',structured_output:result}}));
