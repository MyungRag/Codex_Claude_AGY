// Deterministic generated program for orchestration tests, never a paid model response.
export function calculatorFiles({coreOnly=false,mode='DEG'}={}){
 const core=String.raw`export function calculate(source,mode='DEG'){
 const tokens=[];let rest=source.trim();while(rest){const m=/^(\d+(?:\.\d*)?(?:e[-+]?\d+)?|[a-z]+|[+*/^()\-])/i.exec(rest);if(!m)throw new Error('잘못된 입력');tokens.push(m[0]);rest=rest.slice(m[0].length).trim();}
 let at=0;const powers={'+':10,'-':10,'*':20,'/':20,'^':40};
 const expression=(minimum=0)=>{let token=tokens[at++],left;
 if(token==='-'||token==='+')left=(token==='-'?-1:1)*expression(30);
 else if(token==='('){left=expression();if(tokens[at++]!==')')throw new Error('괄호 오류');}
 else if(token==='pi')left=Math.PI;else if(token==='e')left=Math.E;
 else if(token&&/^\d/.test(token))left=Number(token);
 else if(['sin','cos','tan','sqrt','log','ln'].includes(token)){if(tokens[at++]!=='(')throw new Error('함수 괄호');const value=expression();if(tokens[at++]!==')')throw new Error('함수 괄호');const angle=mode==='DEG'?value*Math.PI/180:value;left=token==='sin'?Math.sin(angle):token==='cos'?Math.cos(angle):token==='tan'?Math.tan(angle):token==='sqrt'?Math.sqrt(value):token==='log'?Math.log10(value):Math.log(value);}
 else throw new Error('잘못된 입력');
 while((powers[tokens[at]]??-1)>=minimum){const op=tokens[at++],right=expression(powers[op]+(op==='^'?0:1));if(op==='+')left+=right;else if(op==='-')left-=right;else if(op==='*')left*=right;else if(op==='/')left/=right;else left**=right;}
 if(!Number.isFinite(left))throw new Error('계산 범위 오류');return left;};
 const value=expression();if(at!==tokens.length)throw new Error('남은 입력');return Number(value.toPrecision(12));
}`;
 const unit=String.raw`import {test} from 'node:test';import assert from 'node:assert/strict';import {calculate} from './calculator.mjs';
 test('operator precedence and parentheses',()=>{assert.equal(calculate('1+2*3'),7);assert.equal(calculate('(1+2)*3'),9);assert.equal(calculate('-2^2'),-4);assert.equal(calculate('2^3^2'),512);});
 test('scientific operations and angle units',()=>{assert.equal(calculate('sin(30)','DEG'),0.5);assert.equal(calculate('sin(pi/2)','RAD'),1);assert.equal(calculate('log(100)'),2);assert.equal(calculate('sqrt(9)'),3);});
 test('invalid input and division by zero',()=>{for(const input of ['1/0','sqrt(-1)','(2+3','hello','2+'])assert.throws(()=>calculate(input));});`;
 const files=[{path:'calculator.mjs',action:'write',content:core},{path:'agent-desk.test.mjs',action:'write',content:unit}];
 if(coreOnly)return files;
 const input=(expression,expected,selected=mode)=>({name:expression+' → '+expected,nodeIds:['screen'],steps:[{action:'select',selector:'#mode',value:selected},{action:'fill',selector:'#expression',value:expression},{action:'click',selector:'#calculate',value:''}],expect:[{selector:'#result',text:expected,mode:'equals'}]});
 files.push({path:'index.html',action:'write',content:`<!doctype html><html lang="ko"><meta charset="utf-8"><title>공학용 계산기 · 검증용 초안</title><style>body{background:#14231c;color:#dff7e8;font:18px system-ui;max-width:620px;margin:60px auto;padding:24px}input,select,button{font:inherit;padding:12px;border-radius:8px;margin:8px 0}input{width:90%}output{display:block;font-size:36px;margin:24px 0}small{display:block;line-height:1.8}</style><h1>공학용 계산기</h1><label>각도 단위 <select id="mode"><option ${mode==='DEG'?'selected':''}>DEG</option><option ${mode==='RAD'?'selected':''}>RAD</option></select></label><input id="expression" aria-label="수식" placeholder="sin(30) + sqrt(9)"><button id="calculate">계산</button><output id="result">0</output><small>사칙연산 · 괄호 · 거듭제곱 · sin/cos/tan · sqrt/log/ln · pi/e</small><p>초안 기본값: ${mode} · 선택 메뉴에서 변경 가능</p><script type="module">import {calculate} from './calculator.mjs';document.querySelector('#calculate').onclick=()=>{try{document.querySelector('#result').value=String(calculate(document.querySelector('#expression').value,document.querySelector('#mode').value));}catch{document.querySelector('#result').value='오류';}};</script></html>`});
 files.push({path:'agent-desk.checks.json',action:'write',content:JSON.stringify({checks:[input('1+2*3','7'),input('(1+2)*3','9'),input('sin(30)','0.5','DEG'),input('sin(pi/2)','1','RAD'),input('log(100)','2'),input('1/0','오류'),input('sqrt(-1)','오류')]})});
 return files;
}
