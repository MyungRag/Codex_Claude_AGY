// A synthesis combines up to three independent responses. Its budget is separate
// from a single review; both browser and runner enforce the same finite limits.
export const REVIEW_PROMPT_LIMIT=150000;
export const SYNTHESIS_PROMPT_LIMIT=450000;
export const AGENT_JOB_BODY_LIMIT=2*1024*1024;
export const promptLimit=kind=>['organize-merge','questions-merge','planning-refine','planning-critique'].includes(kind)?SYNTHESIS_PROMPT_LIMIT:REVIEW_PROMPT_LIMIT;
export function validatePromptSize(prompt,kind){
 if(typeof prompt!=='string'||!prompt.trim())throw Object.assign(new Error('AI에 전달할 검토 내용이 비어 있습니다.'),{code:'EMPTY_PROMPT'});
 const limit=promptLimit(kind);
 if(prompt.length>limit)throw Object.assign(new Error(`검토 내용이 요청 한도를 넘었습니다 (${prompt.length.toLocaleString('ko-KR')}자 / 최대 ${limit.toLocaleString('ko-KR')}자). 기존 응답은 보관되어 있습니다. 원본 응답의 통합 대상을 줄이거나 검토 범위를 나누어 주세요.`),{code:'PROMPT_TOO_LARGE',details:{actual:prompt.length,limit}});
}
