import {randomBytes,timingSafeEqual} from 'node:crypto';
import {AgentRunner,RUNNER_VERSION} from './agent-runner.mjs';
import {AGENT_JOB_BODY_LIMIT} from '../public/agent-limits.js';
export const DASHBOARD_ORIGIN='https://agent-desk-projects-mr.opal-loach-5509.chatgpt.site';
const reply=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
async function body(req,limit=600000){const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>limit)throw Object.assign(new Error(`전송할 검토 자료가 너무 큽니다 (최대 ${limit.toLocaleString('ko-KR')}바이트). 기존 응답을 보관한 채 통합 대상이나 검토 범위를 줄여 주세요.`),{code:'REQUEST_TOO_LARGE'});chunks.push(part);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
export function createAgentAPI({runner=new AgentRunner(),developmentRunner,developmentDataRoot}={}){
  const token=randomBytes(32).toString('hex');
  let development=developmentRunner,developmentPromise;
  const getDevelopment=async()=>development||(developmentPromise??=(async()=>{const {DevelopmentRunner}=await import('./development-runner.mjs');return development=new DevelopmentRunner({agentRunner:runner,...(developmentDataRoot?{dataRoot:developmentDataRoot}:{})});})());
  return {runner,async close(){await Promise.allSettled([runner.close(),development?.close()]);},async handle(req,res,pathname){
    const origin=req.headers.origin,local=`http://${req.headers.host}`;
    const allowed=origin===local||origin===DASHBOARD_ORIGIN;
    if(origin&&!allowed){reply(res,403,{error:'허용되지 않은 대시보드 주소입니다.'});return;}
    if(allowed){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
    if(req.method==='OPTIONS'){
      if(!allowed){reply(res,403,{error:'허용되지 않은 요청입니다.'});return;}
      res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-Agent-Desk');res.setHeader('Access-Control-Allow-Private-Network','true');res.setHeader('Access-Control-Max-Age','600');res.writeHead(204);res.end();return;
    }
    if(req.headers['x-agent-desk']!=='agent-runner'){reply(res,403,{error:'Agent Desk 연결 화면을 이용해 주세요.'});return;}
    if(pathname==='/api/agents/session'&&req.method==='GET'){
      if(origin&&origin!==local){reply(res,403,{error:'연결 코드는 이 PC의 실행기 화면에서 복사해 주세요.'});return;}
      reply(res,200,{token});return;
    }
    const given=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+token);
    if(given.length!==expected.length||!timingSafeEqual(given,expected)){reply(res,401,{error:'연결 코드가 만료되었거나 올바르지 않습니다. 실행기 화면에서 새 코드를 복사해 주세요.'});return;}
    try{
      if(pathname.startsWith('/api/agents/development/')){
        const prefix='/api/agents/development';
        if([prefix+'/start',prefix+'/preview'].includes(pathname)){
          if(req.method!=='POST'){reply(res,405,{error:'POST 요청이 필요합니다.'});return;}
          const payload=await body(req),service=await getDevelopment();
          reply(res,pathname.endsWith('/start')?202:200,await service[pathname.endsWith('/start')?'start':'preview'](payload));return;
        }
        const route=pathname.match(/^\/api\/agents\/development\/([\w-]{1,80})(?:\/(cancel|accept|defer)|\/releases\/([\w-]{1,80})\/(launch|download|stop))?$/);
        if(!route){reply(res,404,{error:'개발 요청 주소를 확인해 주세요.'});return;}
        const [,projectId,action,releaseId,releaseAction]=route;
        const method=action||['launch','stop'].includes(releaseAction)?'POST':'GET';
        if(req.method!==method){reply(res,405,{error:method+' 요청이 필요합니다.'});return;}
        const payload=action||['launch','stop'].includes(releaseAction)?await body(req):undefined,service=await getDevelopment();
        if(releaseAction==='download'){
          const archive=await service.download(projectId,releaseId);
          res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="agent-desk-release-${releaseId}.zip"`,'Content-Length':archive.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(archive);return;
        }
        const result=releaseAction==='stop'?await service.stopLaunch(projectId,releaseId):releaseAction==='launch'?await service.launch(projectId,releaseId,...(payload?.requestId?[{requestId:payload.requestId}]:[])):action?await service[action](projectId,payload):await service.get(projectId);
        reply(res,200,result);return;
      }
      if(pathname==='/api/agents/status'&&req.method==='GET'){reply(res,200,{version:RUNNER_VERSION,platform:process.platform,features:{planningIntake:true,executionMonitor:true,parallelDevelopment:true,modelSelection:true,modelCapabilities:true,requestTiming:true,unlimitedWait:true,requestCancellation:true,planningDecisions:true,leadReview:true,largeReviewContext:true,usage:true,organize:true,development:true},catalogs:Object.fromEntries(['codex','claude','agy'].map(id=>[id,runner.catalogView(id)]).filter(([,c])=>c)),usage:runner.usage(),agents:await runner.status()});return;}
      if(pathname==='/api/agents/refresh'&&req.method==='POST'){reply(res,200,{version:RUNNER_VERSION,platform:process.platform,features:{planningIntake:true,executionMonitor:true,parallelDevelopment:true,modelSelection:true,modelCapabilities:true,requestTiming:true,unlimitedWait:true,requestCancellation:true,planningDecisions:true,leadReview:true,largeReviewContext:true,usage:true,organize:true,development:true},catalogs:Object.fromEntries(['codex','claude','agy'].map(id=>[id,runner.catalogView(id)]).filter(([,c])=>c)),usage:runner.usage(),agents:await runner.status(true)});return;}
      if(pathname==='/api/agents/activity'&&req.method==='GET'){reply(res,200,{observedAt:new Date().toISOString(),jobs:[...runner.jobs.values()].map(job=>{const {result,error,...view}=runner.view(job);return {...view,error:error?'AI 요청 실패 · 해당 작업의 상세 기록을 확인하세요.':null};})});return;}
      if(pathname==='/api/agents/usage'&&req.method==='GET'){reply(res,200,runner.usage());return;}
      const catalog=pathname.match(/^\/api\/agents\/models\/(codex|claude|agy)$/);if(catalog&&req.method==='GET'){reply(res,200,await runner.models(catalog[1]));return;}
      if(pathname==='/api/agents/jobs'&&req.method==='POST'){reply(res,202,runner.create(await body(req,AGENT_JOB_BODY_LIMIT)));return;}
      const requestCancel=pathname.match(/^\/api\/agents\/requests\/([\w-]{8,80})\/cancel$/);
      if(requestCancel&&req.method==='POST'){reply(res,200,runner.cancelRequest(requestCancel[1]));return;}
      const match=pathname.match(/^\/api\/agents\/jobs\/([\w-]{1,80})(\/cancel)?$/);
      if(match&&req.method===(match[2]?'POST':'GET')){const job=match[2]?runner.cancel(match[1]):runner.get(match[1]);reply(res,job?200:404,job||{error:'요청 기록이 없습니다. 실행기가 재시작되었을 수 있습니다.'});return;}
      reply(res,404,{error:'알 수 없는 에이전트 요청입니다.'});
    }catch(error){reply(res,[400,404,409,422].includes(error.status)?error.status:400,{error:error instanceof SyntaxError?'JSON 요청 형식을 확인해 주세요.':error.message,...(error.code?{code:error.code}:{}),...(error.details?{details:error.details}:{})});}
  }};
}
