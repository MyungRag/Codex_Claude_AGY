export const EFFORTS={codex:['low','medium','high','xhigh','max'],claude:['low','medium','high','xhigh','max'],agy:['low','medium','high','xhigh','max']};
export const EFFORT_LABELS={'':'기본값',low:'Low',medium:'Medium',high:'High',xhigh:'Extra High',max:'Max',none:'None',minimal:'Minimal'};
export const MODEL_PRESETS={
 codex:[{id:'gpt-6-astra',name:'GPT-6 Astra'},{id:'gpt-6.1-sol',name:'GPT-6.1 Sol'}],
 claude:[{id:'opus',name:'Claude Opus'},{id:'sonnet',name:'Claude Sonnet'},{id:'haiku',name:'Claude Haiku'}],
 agy:[]
};
export function validateSettings(agent,value={}){
 if(!EFFORTS[agent]||!value||typeof value!=='object'||Array.isArray(value))throw new Error('모델 설정을 확인해 주세요.');
 const model=value.model??'',effort=value.effort??'';
 if(typeof model!=='string'||(model!==''&&!/^[a-zA-Z0-9][a-zA-Z0-9._:/@\[\]-]{0,159}$/.test(model)))throw new Error('모델 ID는 영문·숫자와 . _ : / @ [ ] -만 사용할 수 있습니다.');
 if(typeof effort!=='string'||(effort!==''&&![...EFFORTS[agent],...(agent==='codex'?['none','minimal']:[])].includes(effort)))throw new Error('지원하지 않는 추론 강도입니다.');
 const waitMinutes=value.waitMinutes;if(waitMinutes!==undefined&&![5,10,20].includes(waitMinutes))throw new Error('최대 대기 시간은 5분, 10분, 20분 중에서 선택해 주세요.');
 return {model,effort,...(waitMinutes!==undefined?{waitMinutes}:{})};
}
// Syntax validation is separate from capabilities. A global list of effort names
// never proves that a particular model/account accepts those efforts.
export function modelCapability(catalog,model=''){
 return catalog?.models?.find(m=>model?m.id===model:m.id===catalog.defaultModel||m.isDefault)||null;
}
export function supportedEfforts(agent,settings={},catalog){
 const model=modelCapability(catalog,settings.model),blocked=catalog?.blockedSettings||[];
 return (model?.efforts||[]).filter(e=>[...EFFORTS[agent],'none','minimal'].includes(e)&&!blocked.some(b=>b.model===(settings.model||'')&&b.effort===e));
}
export function settingsIssue(agent,settings={},catalog){
 const blocked=catalog?.blockedSettings?.find(b=>b.model===(settings.model||'')&&b.effort===(settings.effort||''));
 if(blocked)return blocked.message||'이 모델·추론 강도는 CLI가 거절한 설정입니다. 다른 설정을 선택해 주세요.';
 if(settings.effort&&!supportedEfforts(agent,settings,catalog).includes(settings.effort))return '선택한 모델에서 '+(EFFORT_LABELS[settings.effort]||settings.effort)+' 지원을 확인하지 못했습니다. 모델 목록을 불러온 뒤 지원되는 강도 또는 기본값을 선택해 주세요.';
 return '';
}
export function assertCompatibleSettings(agent,settings,catalog){
 const issue=settingsIssue(agent,settings,catalog);if(issue){const error=new Error(issue);error.code='MODEL_SETTINGS_UNSUPPORTED';throw error;}return settings;
}
export const settingLabel=value=>`${value?.model||'기본 모델'} · ${EFFORT_LABELS[value?.effort||'']||value?.effort}`;
export function formatTokens(value){return Number.isSafeInteger(value)&&value>=0?new Intl.NumberFormat('ko-KR').format(value):'미제공';}
