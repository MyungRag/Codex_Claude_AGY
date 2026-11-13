export const CONNECTION_STALE_MS=10000;
export const QUIET_OUTPUT_MS=120000;
export const durationText=ms=>{const seconds=Math.max(0,Math.floor(ms/1000));return `${Math.floor(seconds/60)}분 ${seconds%60}초`;};
const age=(stamp,now)=>{const value=Date.parse(stamp);return Number.isFinite(value)?Math.max(0,now-value):null;};

// Poll receipt proves connectivity. Process liveness and actual output are
// separate observations; elapsed time is never evidence of generation progress.
export function jobActivityState(job,now=Date.now()){
 const terminal=['succeeded','failed','cancelled'].includes(job.status),checkedAge=age(job.lastCheckedAt,now),drift=terminal?0:checkedAge??0;
 const elapsed=job.startedAt&&Number.isFinite(job.elapsedMs)?job.elapsedMs+drift:age(job.requestedAt||job.createdAt,terminal?Date.parse(job.finishedAt)||now:now)??0;
 const outputAge=Number.isFinite(job.outputIdleMs)?job.outputIdleMs+drift:age(job.activity?.lastOutputAt||job.progress?.lastActivityAt,terminal?Date.parse(job.finishedAt)||now:now);
 const unconfirmed=job.status==='unknown'||(!terminal&&((checkedAge!==null&&checkedAge>=CONNECTION_STALE_MS)||(job.id&&!job.lastCheckedAt)));
 let state='waiting',title='AI 응답 대기 중',note='AI 프로그램이 실행 중이어도 실제 생성 진행률이나 남은 시간은 알 수 없습니다.';
 if(terminal){state=job.status;title={succeeded:'응답 도착',failed:'요청 실패',cancelled:'취소됨'}[job.status];note=job.error||'';}
 else if(unconfirmed){state='unknown';title='연결 상태 확인 필요';note='현재 AI가 계속 실행 중인지 확인하지 못했습니다. 연결 확인 지연만으로 실패하거나 멈췄다고 판단하지 않습니다.';}
 else if(job.process?.state==='exited'){state='finishing';title='응답 정리 중';note='AI 프로그램은 종료됐고 실행기가 결과를 확인하고 있습니다.';}
 else if((outputAge??elapsed)>=QUIET_OUTPUT_MS){state='quiet';title='새 출력 없이 대기 중';note='최근 출력이 없습니다. AI가 내부 처리 중이거나 응답을 기다릴 수 있어 정지 여부는 확정할 수 없습니다.';}
 else if(outputAge!==null&&outputAge<15000){state='receiving';title='최근 출력 신호 수신';note='AI 프로그램의 출력이 도착했습니다. 초기화·처리 이벤트와 진단 메시지도 포함하며 완성된 답변이나 완료율을 뜻하지 않습니다.';}
 else if(!job.id||!job.startedAt){state='starting';title='요청 접수·실행 준비 중';note='실행기가 요청을 받고 AI 프로그램을 준비하고 있습니다.';}
 const connection=terminal?'최종 상태 확인':job.status==='unknown'?'확인 지연':checkedAge===null?'아직 확인 전':checkedAge>=CONNECTION_STALE_MS?'확인 지연':'연결 정상';
 const process=unconfirmed?'현재 상태 미확인':({starting:'실행 준비 중',running:'실행 중',exited:'종료됨'}[job.process?.state]||'상태 미제공');
 return {state,title,note,elapsed:durationText(elapsed),connection,process,checked:checkedAge===null?'확인 기록 없음':durationText(checkedAge)+' 전',output:outputAge===null?'아직 수신 없음':durationText(outputAge)+' 전',bytes:(job.activity?.stdoutBytes||0)+(job.activity?.stderrBytes||0),limit:job.timeoutMs>0?durationText(job.timeoutMs):'무제한'};
}
