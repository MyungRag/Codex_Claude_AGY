import {randomBytes,timingSafeEqual} from 'node:crypto';
import {AgentRunner,RUNNER_VERSION} from './agent-runner.mjs';
export const DASHBOARD_ORIGIN='https://agent-desk-projects-mr.opal-loach-5509.chatgpt.site';
const reply=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
async function body(req){const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>600000)throw new Error('요청이 너무 큽니다. 기획 범위를 줄여 주세요.');chunks.push(part);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
export function createAgentAPI({runner=new AgentRunner()}={}){
  const token=randomBytes(32).toString('hex');
  return {runner,async handle(req,res,pathname){
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
      if(pathname==='/api/agents/status'&&req.method==='GET'){reply(res,200,{version:RUNNER_VERSION,platform:process.platform,features:{modelSelection:true,modelCapabilities:true,requestTiming:true,planningDecisions:true,usage:true,organize:true},catalogs:Object.fromEntries(['codex','claude','agy'].map(id=>[id,runner.catalogView(id)]).filter(([,c])=>c)),usage:runner.usage(),agents:await runner.status()});return;}
      if(pathname==='/api/agents/refresh'&&req.method==='POST'){reply(res,200,{version:RUNNER_VERSION,platform:process.platform,features:{modelSelection:true,modelCapabilities:true,requestTiming:true,planningDecisions:true,usage:true,organize:true},catalogs:Object.fromEntries(['codex','claude','agy'].map(id=>[id,runner.catalogView(id)]).filter(([,c])=>c)),usage:runner.usage(),agents:await runner.status(true)});return;}
      if(pathname==='/api/agents/usage'&&req.method==='GET'){reply(res,200,runner.usage());return;}
      const catalog=pathname.match(/^\/api\/agents\/models\/(codex|claude|agy)$/);if(catalog&&req.method==='GET'){reply(res,200,await runner.models(catalog[1]));return;}
      if(pathname==='/api/agents/jobs'&&req.method==='POST'){reply(res,202,runner.create(await body(req)));return;}
      const match=pathname.match(/^\/api\/agents\/jobs\/([\w-]{1,80})(\/cancel)?$/);
      if(match&&req.method===(match[2]?'POST':'GET')){const job=match[2]?runner.cancel(match[1]):runner.get(match[1]);reply(res,job?200:404,job||{error:'요청 기록이 없습니다. 실행기가 재시작되었을 수 있습니다.'});return;}
      reply(res,404,{error:'알 수 없는 에이전트 요청입니다.'});
    }catch(error){reply(res,400,{error:error instanceof SyntaxError?'JSON 요청 형식을 확인해 주세요.':error.message});}
  }};
}
