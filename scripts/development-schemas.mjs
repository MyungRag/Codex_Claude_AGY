// Structured proposals only. The host, never the AI, writes files and runs configured checks.
const string={type:'string'};
const object=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const list=items=>({type:'array',items});
const finding=object({type:{type:'string',enum:['implementation','spec','suggestion','unverified','limitation']},severity:{type:'string',enum:['critical','high','medium','low','info']},summary:string,evidence:string,remedy:string});
export const DEVELOPMENT_BUILD_SCHEMA=object({summary:string,files:list(object({path:string,action:{type:'string',enum:['write','delete']},content:string})),limitations:list(finding)});
export const DEVELOPMENT_AUDIT_SCHEMA=object({summary:string,verdict:{type:'string',enum:['pass','fail','hold']},verifiedCriteria:list(object({criterion:string,evidence:string})),unverifiedCriteria:list(string),previousFindings:list(object({id:string,status:{type:'string',enum:['resolved','partial','open','regressed','unverified']},evidence:string})),findings:list(finding)});
export const DEVELOPMENT_ANALYSIS_SCHEMA=object({summary:string,risks:list(finding),recommendation:string});
export const DEVELOPMENT_SCHEMAS={'development-build':DEVELOPMENT_BUILD_SCHEMA,'development-audit':DEVELOPMENT_AUDIT_SCHEMA,'development-analysis':DEVELOPMENT_ANALYSIS_SCHEMA};
const fail=()=>{throw new Error('개발 응답 형식 또는 크기가 올바르지 않습니다. 다시 요청해 주세요.');};
const text=(v,max=12000)=>{if(typeof v!=='string'||v.length>max)fail();return v;};
const array=(v,max)=>{if(!Array.isArray(v)||v.length>max)fail();return v;};
const one=(v,allowed)=>{if(!allowed.includes(v))fail();return v;};
function findings(v){return array(v,100).map(f=>{if(!f||typeof f!=='object')fail();return {type:one(f.type,['implementation','spec','suggestion','unverified','limitation']),severity:one(f.severity,['critical','high','medium','low','info']),summary:text(f.summary,3000),evidence:text(f.evidence),remedy:text(f.remedy)};});}
export function parseDevelopmentResponse(value,kind){
  if(!value||typeof value!=='object'||Array.isArray(value))fail();
  const summary=text(value.summary,6000);
  if(kind==='development-build'){
    let size=0;const seen=new Set();
    const files=array(value.files,100).map(file=>{if(!file||typeof file!=='object')fail();const name=text(file.path,500),action=one(file.action,['write','delete']),content=text(file.content,300000);if(!name||seen.has(name)||/^(?:[A-Za-z]:|[\\/])/.test(name)||name.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'))fail();seen.add(name);size+=Buffer.byteLength(content);if(size>2000000)fail();return {path:name,action,content};});
    return {summary,files,limitations:findings(value.limitations)};
  }
  if(kind==='development-audit'){
    const verdict=one(value.verdict,['pass','fail','hold']),verifiedCriteria=array(value.verifiedCriteria,150).map(c=>({criterion:text(c.criterion,3000),evidence:text(c.evidence)})),unverifiedCriteria=array(value.unverifiedCriteria,150).map(c=>text(c,3000)),issues=findings(value.findings);
    if(verdict==='pass'&&(!verifiedCriteria.length||verifiedCriteria.some(c=>!c.criterion.trim()||!c.evidence.trim())||unverifiedCriteria.length||issues.some(f=>f.type==='implementation'||f.type==='spec'||f.type==='unverified')))fail();
    const previousFindings=array(value.previousFindings,500).map(f=>({id:text(f.id,200),status:one(f.status,['resolved','partial','open','regressed','unverified']),evidence:text(f.evidence)}));
    if(new Set(previousFindings.map(f=>f.id)).size!==previousFindings.length||previousFindings.some(f=>!f.evidence.trim())||(verdict==='pass'&&previousFindings.some(f=>f.status!=='resolved')))fail();
    return {summary,verdict,verifiedCriteria,unverifiedCriteria,previousFindings,findings:issues};
  }
  if(kind==='development-analysis')return {summary,risks:findings(value.risks),recommendation:text(value.recommendation)};
  fail();
}
