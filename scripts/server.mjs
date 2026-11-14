import {createAgentAPI} from './agent-api.mjs';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {pickWindowsFolder} from './folder-picker.mjs';
import {createWindowsPackage} from './windows-package.mjs';

const root=new URL('../public/',import.meta.url);
const assets=new Map([['/','index.html'],['/index.html','index.html'],['/download','download.html'],['/download.html','download.html'],['/app.js','app.js'],['/model.js','model.js'],['/storage.js','storage.js'],['/style.css','style.css'],['/favicon.svg','favicon.svg'],['/planning.js','planning.js'],['/planning-model.js','planning-model.js'],['/planning.css','planning.css'],['/agent-client.js','agent-client.js'],['/agent-ui.js','agent-ui.js'],['/agents.css','agents.css'],['/agent-settings.js','agent-settings.js'],['/organize-model.js','organize-model.js'],['/organize-ui.js','organize-ui.js'],['/model-controls.js','model-controls.js']]);
for(const name of ['view-state.js','development-progress.js','planning-intake-core.js','planning-intake-model.js','planning-intake-ui.js','execution-monitor.js','execution-map.js','progress-model.js','agent-limits.js','review-context.js','review-model.js','lead-review-ui.js','execution-order.js','decision-ui.js','decision-core.js','decision-model.js','decision-ai-ui.js','development-core.js','development.js','development-client.js','development.css'])assets.set('/'+name,name);
const mime={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',svg:'image/svg+xml'};
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
export function createAppServer({platform=process.platform,pickFolder=pickWindowsFolder,agentRunner,developmentRunner,developmentDataRoot}={}) {
  let choosing=false;
  const agentAPI=createAgentAPI({runner:agentRunner,developmentRunner,developmentDataRoot});
  const server=createServer(async(req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname.startsWith('/api/')) {
      const port=server.address()?.port;
      const trustedHosts=[`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`];
      const localAddress=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      if(!localAddress||!trustedHosts.includes(req.headers.host)){json(res,403,{error:'이 PC에서 접속해 주세요.'});return;}
      if(pathname.startsWith('/api/agents/')){await agentAPI.handle(req,res,pathname);return;}
      if(pathname==='/api/capabilities'&&req.method==='GET'){json(res,200,{folderPicker:platform==='win32'?'native':'browser'});return;}
      if(pathname!=='/api/pick-folder'){json(res,404,{error:'알 수 없는 요청입니다.'});return;}
      if(req.method!=='POST'){json(res,405,{error:'POST 요청이 필요합니다.'});return;}
      if(req.headers.origin!==`http://${req.headers.host}`||req.headers['x-agent-desk']!=='folder-picker'){
        json(res,403,{error:'Agent Desk 화면에서 폴더를 선택해 주세요.'});return;
      }
      if(platform!=='win32'){json(res,501,{error:'Windows에서 실행하거나 브라우저 폴더 선택을 이용해 주세요.'});return;}
      if(choosing){json(res,409,{error:'이미 열린 폴더 선택창을 먼저 닫아 주세요.'});return;}
      choosing=true;req.resume();
      const controller=new AbortController();
      res.on('close',()=>{if(!res.writableEnded)controller.abort();});
      try {json(res,200,await pickFolder(controller.signal));}
      catch(error){if(!res.destroyed)json(res,500,{error:error.message});}
      finally{choosing=false;}
      return;
    }
    if(pathname==='/downloads/agent-desk-windows.zip'){
      if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'Allow':'GET, HEAD'});res.end();return;}
      try{
        const body=await createWindowsPackage();
        res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="agent-desk-windows.zip"','Content-Length':body.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
        res.end(req.method==='HEAD'?undefined:body);
      }catch{res.writeHead(500,{'Cache-Control':'no-store'});res.end('Unable to package app');}
      return;
    }
    const asset=assets.get(pathname);
    if(!asset||!['GET','HEAD'].includes(req.method)){res.writeHead(404);res.end('Not found');return;}
    try {
      const body=await readFile(fileURLToPath(new URL(asset,root)));
      res.writeHead(200,{'Content-Type':mime[asset.split('.').at(-1)],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'});
      res.end(req.method==='HEAD'?undefined:body);
    }catch{res.writeHead(500);res.end('Unable to load app');}
  });
  server.on('close',()=>{void agentAPI.close();});
  server.stopAgents=()=>agentAPI.close();
  return server;
}
