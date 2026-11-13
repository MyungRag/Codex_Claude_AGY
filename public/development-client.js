import {runner,isLocal} from './agent-client.js?v=0.9.0';

const ROOT='/api/agents/development';
const identifier=value=>{if(!/^[\w-]{1,80}$/.test(value||''))throw new Error('프로젝트 또는 실행 기록의 ID가 올바르지 않습니다.');return encodeURIComponent(value);};
export function parseArguments(value,label='인수'){
  let parsed;try{parsed=JSON.parse(value||'[]');}catch{throw new Error(label+'는 JSON 문자열 배열로 입력해 주세요. 예: ["run", "build"]');}
  if(!Array.isArray(parsed)||parsed.some(v=>typeof v!=='string'||v.includes('\0')))throw new Error(label+'는 문자열 배열이어야 합니다.');
  return parsed;
}
export function localProgramURL(value){
  let url;try{url=new URL(value);}catch{throw new Error('프로그램 실행 주소를 확인하지 못했습니다.');}
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)throw new Error('실행기가 현재 PC의 프로그램 주소를 반환하지 않았습니다.');
  return url.href;
}
export class DevelopmentClient{
  constructor({client=runner,pollMs=1500}={}){this.runner=client;this.pollMs=pollMs;}
  async connect(){
    if(!this.runner.base||!this.runner.token){
      if(!isLocal())throw new Error('AI 연결에서 현재 PC 실행기를 연결해 주세요.');
      await this.runner.connect(location.origin,'',{local:true});
    }else await this.runner.refresh();
    if(!this.runner.runnerInfo?.features?.development)throw new Error('개발·검토를 지원하는 최신 PC 실행기를 다운로드해 실행해 주세요.');
  }
  get(projectId){return this.runner.request(ROOT+'/'+identifier(projectId));}
  start(payload){return this.runner.request(ROOT+'/start',{method:'POST',body:payload});}
  preview(payload){return this.runner.request(ROOT+'/preview',{method:'POST',body:payload});}
  cancel(projectId,requestId){return this.runner.request(ROOT+'/'+identifier(projectId)+'/cancel',{method:'POST',body:requestId?{requestId}:{}});}
  accept(projectId,payload){return this.runner.request(ROOT+'/'+identifier(projectId)+'/accept',{method:'POST',body:payload});}
  launch(projectId,releaseId,requestId){return this.runner.request(ROOT+'/'+identifier(projectId)+'/releases/'+identifier(releaseId)+'/launch',{method:'POST',body:requestId?{requestId}:{},timeoutMs:0});}
  async download(projectId,releaseId){
    const path=ROOT+'/'+identifier(projectId)+'/releases/'+identifier(releaseId)+'/download';
    const fetchBlob=()=>this.runner.fetcher(this.runner.base+path,{headers:{'X-Agent-Desk':'agent-runner',Authorization:'Bearer '+this.runner.token},cache:'no-store'});
    let response=await fetchBlob();
    if(response.status===401){await this.runner.refresh();response=await fetchBlob();}
    if(!response.ok){let data;try{data=await response.json();}catch{}throw new Error(data?.error||'실행 파일을 다운로드하지 못했습니다.');}
    return response.blob();
  }
  watch(projectId,onState,onError=()=>{}){
    let closed=false,timer;
    const poll=async()=>{try{const state=await this.get(projectId);if(!closed)onState(state);}catch(error){if(!closed)onError(error);}finally{if(!closed)timer=setTimeout(poll,this.pollMs);}};
    poll();return()=>{closed=true;clearTimeout(timer);};
  }
}
export const developmentClient=new DevelopmentClient();
