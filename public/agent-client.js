import {validateSettings,assertCompatibleSettings} from './agent-settings.js?v=0.8.0';
export const AGENT_INFO=[
  {id:'codex',name:'Codex',short:'C',command:'codex login',docs:'https://developers.openai.com/codex/cli/'},
  {id:'claude',name:'Claude Code',short:'✳',command:'claude auth login',docs:'https://code.claude.com/docs/en/setup'},
  {id:'agy',name:'Antigravity',short:'A',command:'agy',docs:'https://antigravity.google/docs/install?tab=cli'}
];
export function runnerURL(value){const url=new URL(value);if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('현재 PC의 주소를 입력해 주세요. 예: http://127.0.0.1:4173');return url.origin;}
export const isLocal=()=>typeof location!=='undefined'&&location.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(location.hostname);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class RunnerClient{
  constructor({fetcher=(...args)=>fetch(...args),storage=globalThis.sessionStorage,preferences=globalThis.localStorage}={}){this.fetcher=fetcher;this.storage=storage;this.preferences=preferences;this.settings={};this.catalogs={};this.usage=null;try{const saved=JSON.parse(preferences?.getItem('agent-desk-models')||'{}');for(const agent of ['codex','claude','agy'])this.settings[agent]=validateSettings(agent,saved[agent]||{});}catch{this.settings={};}this.base='';this.token='';this.agents=[];this.runnerInfo=null;this.lastProbe=null;this.listeners=new Set();this.cancelWaiters=new WeakMap();try{const saved=JSON.parse(storage?.getItem('agent-desk-runner')||'null');if(saved){this.base=runnerURL(saved.base);this.token=saved.token;}}catch{}}
  emit(){for(const listener of this.listeners)listener();}
  on(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  async request(path,{method='GET',body,bootstrap=false,retrySession=true,timeoutMs=45000}={}){
    let response;try{response=await this.fetcher(this.base+path,{method,headers:{'X-Agent-Desk':'agent-runner',...(!bootstrap?{Authorization:'Bearer '+this.token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store',...(timeoutMs?{signal:AbortSignal.timeout(timeoutMs)}:{})});}catch{throw new Error('PC 실행기에 접속하지 못했습니다. start-windows.cmd 실행, 주소, 브라우저의 로컬 네트워크 접근 권한을 확인해 주세요.');}
    let data;try{data=await response.json();}catch{throw new Error('이 주소에 최신 PC 실행기가 없습니다. 다운로드한 v0.8.0 실행기를 시작해 주세요.');}
    if(response.status===401&&!bootstrap&&retrySession&&isLocal()&&this.base===location.origin){
      const session=await this.request('/api/agents/session',{bootstrap:true});
      if(!/^[a-f0-9]{64}$/.test(session.token||''))throw new Error('실행기 연결을 다시 확인해 주세요.');
      this.token=session.token;
      try{this.storage?.setItem('agent-desk-runner',JSON.stringify({base:this.base,token:this.token}));}catch{}
      return this.request(path,{method,body,bootstrap,retrySession:false,timeoutMs});
    }
    if(!response.ok){const error=new Error(data.error||'실행기 요청에 실패했습니다.');error.status=response.status;throw error;}return data;
  }
  async connect(base,token,{local=false}={}){const previous=this.base+'|'+this.token,nextBase=runnerURL(base);if(nextBase!==this.base){this.catalogs={};this.runnerInfo=null;this.lastProbe=null;this.usage=null;}this.base=nextBase;this.agents=[];this.token=local?(await this.request('/api/agents/session',{bootstrap:true})).token:token.trim();if(previous!==this.base+'|'+this.token){this.catalogs={};this.lastProbe=null;this.usage=null;}if(!/^[a-f0-9]{64}$/.test(this.token))throw new Error('실행기 화면에서 복사한 연결 코드를 입력해 주세요.');await this.refresh(true);try{this.storage?.setItem('agent-desk-runner',JSON.stringify({base:this.base,token:this.token}));}catch{}return this.agents;}
  async refresh(force=false){try{const data=await this.request(force?'/api/agents/refresh':'/api/agents/status',{method:force?'POST':'GET'});this.agents=data.agents;this.catalogs=data.catalogs||{};this.runnerInfo={version:data.version||'unknown',platform:data.platform||'unknown',features:data.features||{}};this.usage=data.usage||null;this.emit();return this.agents;}catch(error){this.agents=[];this.runnerInfo=null;this.emit();throw error;}}
  disconnect(){this.catalogs={};this.usage=null;this.base='';this.token='';this.agents=[];this.runnerInfo=null;this.lastProbe=null;try{this.storage?.removeItem('agent-desk-runner');}catch{}this.emit();}
  getSettings(agent){return this.settings[agent]||{model:'',effort:''};}
  saveSettings(agent,settings){const next=assertCompatibleSettings(agent,validateSettings(agent,settings),this.catalogs[agent]);const all={...this.settings,[agent]:next};this.preferences?.setItem('agent-desk-models',JSON.stringify(all));this.settings=all;this.emit();return next;}
  requireFeature(feature){if(!this.runnerInfo?.features?.[feature])throw new Error('이 기능은 PC 실행기 v0.8.0 이상이 필요합니다. 최신 ZIP으로 실행기를 교체해 주세요.');}
  async models(agent){this.requireFeature('modelCapabilities');const catalog=await this.request('/api/agents/models/'+agent);this.catalogs[agent]=catalog;return catalog;}
  async refreshUsage(){if(!this.runnerInfo?.features?.usage)return;this.usage=await this.request('/api/agents/usage');this.emit();}
  async start(agent,prompt,kind='review',settings=this.getSettings(agent),{requestId=crypto.randomUUID(),cancelled=()=>false}={}){settings=validateSettings(agent,settings);if(!settings.waitMinutes)this.requireFeature('unlimitedWait');else if(settings.waitMinutes!==5)this.requireFeature('requestTiming');if(settings.model||settings.effort)this.requireFeature('modelCapabilities');if(settings.effort&&!this.catalogs[agent])await this.models(agent);if(cancelled())return {agent,kind,requestId,status:'cancelled'};assertCompatibleSettings(agent,settings,this.catalogs[agent]);if(kind==='organize')this.requireFeature('organize');if(['questions','conflicts','handoff'].includes(kind))this.requireFeature('planningDecisions');return this.request('/api/agents/jobs',{method:'POST',body:{agent,prompt,kind,settings,requestId}}).catch(error=>{if(!error.status)error.jobMayExist=true;throw error;});}
  async poll(id,update=()=>{},{stop=()=>null,refreshInBackground=false}={}){while(true){const stopped=stop();if(stopped)return stopped;const job=await this.request('/api/agents/jobs/'+id);const cancelled=stop();if(cancelled)return cancelled;update(job);if(job.status!=='running'){if(job.status==='succeeded'&&job.kind==='probe'&&this.runnerInfo?.features?.modelCapabilities){try{await this.models(job.agent);}catch(error){job.catalogWarning=error.message;}}if(refreshInBackground)void this.refresh().catch(()=>{});else try{await this.refresh();}catch{}return job;}await delay(1000);}}
  waitForCancellation(job,work){let finish;const cancelled=new Promise(resolve=>{finish=resolve;}),waiters=this.cancelWaiters.get(job)||new Set();waiters.add(finish);this.cancelWaiters.set(job,waiters);return Promise.race([work,cancelled]).finally(()=>{waiters.delete(finish);if(!waiters.size)this.cancelWaiters.delete(job);});}
  async startPending(job,prompt,kind='review',settings=this.getSettings(job.agent)){
    job.requestId||=crypto.randomUUID();if(job.cancelRequested)return job;this.requireFeature('requestCancellation');
    return this.waitForCancellation(job,(async()=>{const result=await this.start(job.agent,prompt,kind,settings,{requestId:job.requestId,cancelled:()=>job.cancelRequested});
      if(job.cancelRequested&&result.status==='running'){job.id=result.id;return this.cancelPending(job);}
      Object.assign(job,result);return job;
    })());
  }
  async pollPending(job,update=()=>{},{refreshInBackground=false}={}){if(job.status==='cancelled')return job;return this.waitForCancellation(job,this.poll(job.id,value=>{Object.assign(job,value);update(job);},{stop:()=>job.cancelRequested&&job.status==='cancelled'?job:null,refreshInBackground}).then(result=>{Object.assign(job,result);return job;}));}
  async cancelPending(job){
    job.cancelRequested=true;
    // A stable request ID also cancels a POST whose response has not arrived yet.
    const result=job.requestId?await this.request('/api/agents/requests/'+job.requestId+'/cancel',{method:'POST'}):job.id?await this.cancel(job.id):null;
    if(result){Object.assign(job,result);if(result.status!=='running')for(const finish of this.cancelWaiters.get(job)||[])finish(job);}
    return job;
  }
  async cancel(id){return this.request('/api/agents/jobs/'+id+'/cancel',{method:'POST'});}
}
export const runner=new RunnerClient();

export function connectionReport(client=runner){return JSON.stringify({dashboardVersion:'0.8.0',runner:client.runnerInfo,agents:client.agents.map(({id,state,stage,code,version,missingFlags,verified})=>({id,state,stage,code,version,missingFlags,verified:!!verified})),lastProbe:client.lastProbe},null,2);}
