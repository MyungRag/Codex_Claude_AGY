import {executionOrder,executionWaves,normalizeExecutionMeta} from './execution-order.js?v=0.9.3';
import {decisionWorkspace,decisionCount,handleDecisionClick,handleDecisionSubmit,decisionInput} from './decision-ui.js?v=0.9.3';
import {openOrganizer} from './organize-ui.js?v=0.9.3';
import {openConnections,openAgentReview,paintConnections} from './agent-ui.js?v=0.9.3';
import {runner} from './agent-client.js?v=0.9.3';
import {AGENTS,NODE_WIDTH,NODE_HEIGHT,validatePlan,createPlan,createDemo,changePlan,travelHistory,addNode,editNode,removeNode,moveUnder,mergeFields,mergeNodes,layoutPlan,visibleNodes,childrenOf,descendants,nodeSources,similarPairs,parseProposals,importProposals,appendMessage,reviewPrompt} from './planning-model.js?v=0.9.3';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statuses={draft:'초안',review:'결정 필요',confirmed:'확정'};
const time=value=>new Intl.DateTimeFormat('ko-KR',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
const badge=a=>`<span class="agent-badge ${a.id}" title="${a.name}"><i>${a.short}</i>${a.name}</span>`;
const button=(action,label,extra='')=>`<button type="button" data-pa="${action}" ${extra}>${label}</button>`;

export function mountPlanner(root,options){return new Planner(root,options);}
class Planner {
  constructor(root,{project,revision,save,toast,icon,exportProject}){
    Object.assign(this,{root,project,revision,save,toast,icon,exportProject});
    this.page='board';this.decisionDirty=false;this.plan=validatePlan(project.planning);this.selected=this.plan?.rootId||null;this.tab='content';this.mode='graph';this.scale=.8;this.collapsed=new Set();this.chosen=new Set();this.multiselect=false;this.editing=false;this.dirty=false;this.drafts=new Map();this.chatTarget=null;this.filter='all';this.fitNext=true;this.saving=false;this.stale=false;
    this.click=e=>this.onClick(e);this.submit=e=>this.onSubmit(e);this.input=e=>this.onInput(e);this.pointer=e=>this.onPointerDown(e);this.key=e=>this.onKey(e);
    root.addEventListener('click',this.click);root.addEventListener('submit',this.submit);root.addEventListener('input',this.input);root.addEventListener('change',this.input);root.addEventListener('pointerdown',this.pointer);root.addEventListener('keydown',this.key);
    this.unload=e=>{if(this.hasDraft()){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',this.unload);
    this.offRunner=runner.on(()=>paintConnections(this.root));
    this.render();
  }
  destroy(){this.disposed=true;this.offRunner?.();for(const [type,handler] of [['click',this.click],['submit',this.submit],['input',this.input],['change',this.input],['pointerdown',this.pointer],['keydown',this.key]])this.root.removeEventListener(type,handler);window.removeEventListener('beforeunload',this.unload);this.endDrag?.();}
  hasDraft(){return this.decisionDirty||this.agentDialogOpen||this.dirty||[...this.drafts.values()].some(v=>v.trim())||!!this.modalDirty;}
  canLeave(){if(this.agentDialogOpen){this.toast('AI 요청 창을 먼저 닫아 주세요.');return false;}if(this.saving){this.toast('저장을 마친 뒤 이동해 주세요.');return false;}if(this.hasDraft()){this.toast('작성 중인 수정·대화를 먼저 저장하거나 비워 주세요.');return false;}return true;}
  guard(){if(this.decisionDirty){this.toast('작성 중인 질문·답변·분담안을 먼저 저장해 주세요.');return false;}if(this.saving){this.toast('변경 내용을 저장하고 있습니다.');return false;}if(this.dirty){this.toast('노드의 변경 사항을 저장하거나 취소해 주세요.');return false;}return true;}
  notifyExternal(){this.stale=true;const slot=this.root.querySelector('.planner-alert');if(slot)slot.innerHTML='다른 탭에서 프로젝트가 변경되었습니다. 작성 중인 내용을 복사한 뒤 페이지를 새로고침해 주세요. 현재 변경은 덮어쓰지 않습니다.';}
  error(error){const target=this.root.querySelector('.planner-dialog[open] .plan-form-error');if(target){target.textContent=error.message;target.hidden=false;target.focus();}else{this.toast(error.message);const slot=this.root.querySelector('.planner-alert');if(slot)slot.textContent=error.message;}}
  async persist(next,after){
    if(this.saving)return false;this.saving=true;this.root.setAttribute('aria-busy','true');
    try{const revision=await this.save(next,this.revision);if(this.disposed)return false;this.revision=revision;this.plan=next;after?.();this.render();return true;}
    catch(error){this.error(error);return false;}
    finally{this.saving=false;this.root.removeAttribute('aria-busy');}
  }
  async mutate(label,operation,after){return this.persist(changePlan(this.plan,label,operation),()=>{this.toast(label);after?.();});}
  render(){
    if(this.disposed)return;
    const old=this.root.querySelector('.graph-viewport'), scroll=old?{left:old.scrollLeft,top:old.scrollTop}:null;
    const plan=this.plan, n=plan?.nodes.length||0;
    this.root.innerHTML=`<section class="planner"><header class="planner-heading"><div><div class="eyebrow">IDEAS BECOME A PLAN</div><h1>기획 보드<span>.</span></h1><p>${esc(this.project.description||'아이디어를 나누고, 연결하고, 함께 구체화하세요.')}</p></div><div class="planner-heading-actions">${button('connections',this.icon('link')+' AI 연결','class="button"')}${button('ai-review','AI 기획 요청','class="button primary"')}${plan?button('export',this.icon('download')+' 내보내기','class="button subtle"'):''}${button('import',this.icon('upload')+' 제안 가져오기','class="button"')}${plan?button('chat-all',this.icon('chat')+' 전체 대화','class="button primary"'):''}</div></header>
      <div class="planner-connections"><div>${AGENTS.map(a=>`<span class="connection">${badge(a)}<small data-connection="${a.id}">연결 확인 전</small><small data-agent-tokens="${a.id}">토큰 —</small></span>`).join('')}</div><span>${plan?.demo?'<b class="demo-label">KAF 시연 데이터</b>':'AI 제안 · 직접 편집'} · ${plan?'브라우저에 저장됨 · 변경 '+plan.changeNumber:'아직 시작하지 않음'}</span></div>
      <div class="planner-alert" role="status">${this.stale?'다른 탭에서 정보가 변경되었습니다. 새로고침 후 이어서 편집해 주세요.':''}</div>
      ${plan?`<div class="planner-workspace"><div class="planner-board"><div class="board-toolbar"><div class="board-tabs" aria-label="기획 보기">${button('mode-graph','통합 기획도',`class="${this.mode==='graph'?'active':''}" aria-pressed="${this.mode==='graph'}"`)}${button('mode-execution','구현 순서',`class="${this.mode==='execution'?'active':''}" aria-pressed="${this.mode==='execution'}"`)}${button('mode-compare','에이전트별 비교',`class="${this.mode==='compare'?'active':''}" aria-pressed="${this.mode==='compare'}"`)}</div><div class="board-tools">${button('undo',this.icon('back'),`title="되돌리기" aria-label="되돌리기" ${!plan.undo.length?'disabled':''}`)}${button('redo',this.icon('arrow'),`title="다시 실행" aria-label="다시 실행" ${!plan.redo.length?'disabled':''}`)}${button('history',this.icon('clock'),'title="변경 이력" aria-label="변경 이력"')}${button('layout',this.icon('grid'),'title="자동 정렬" aria-label="자동 정렬"')}</div></div>
      <div class="board-subtoolbar"><span><strong>${n}</strong>개 노드 · <strong>${plan.nodes.filter(n=>nodeSources(plan,n.id).length>1).length}</strong>개 공동 제안</span><div>${button('candidates','유사 노드 '+similarPairs(plan).length,`class="text-button"`)}${button('select-all','전체 선택','class="text-button"')}${button('organize','AI로 노드 정리','class="text-button"')}${button('multi',this.multiselect?'선택 마치기':'여러 노드 선택',`class="text-button ${this.multiselect?'active':''}"`)}${button('add-root','+ 노드 추가','class="text-button"')}</div></div>
      ${this.mode==='graph'?this.graphHTML():this.mode==='execution'?this.executionHTML():this.compareHTML()}
      <div class="board-bottom"><span>${this.multiselect?`${this.chosen.size}개 선택됨 · 합칠 노드를 선택하세요`:this.mode==='execution'?'선행 작업 완료가 우선 · 목록의 노드를 눌러 상세 보기':'노드를 끌어 이동 · 연결선의 +로 추가 · 노드를 눌러 상세 보기'}</span>${this.multiselect?button('merge','선택 노드 합치기',`class="button primary compact" ${this.chosen.size<2?'disabled':''}`):this.mode==='graph'?`<div class="zoom-tools">${button('zoom-out','−','aria-label="축소"')}<span>${Math.round(this.scale*100)}%</span>${button('zoom-in','+','aria-label="확대"')}${button('fit','화면에 맞추기')}</div>`:''}</div></div><aside class="plan-inspector">${this.inspectorHTML()}</aside></div>
      <div class="planner-footnote">${this.icon('info')}${plan.demo?'시연 데이터는 편집 체험을 위한 예시이며 실제 AI 응답이 아닙니다.':'AI 기획 요청으로 의견을 받아 확인 후 반영하세요. 반영한 의견은 다음 요청에도 전달됩니다.'} ${button('prompt','검토 요청문 복사','class="text-button"')}</div>`:this.welcomeHTML()}</section>`;
    if(plan){const nav=`<nav class="planning-pages" aria-label="기획 단계">${button('page-board','기획도',`class="${this.page==='board'?'active':''}"`)}${button('page-decisions','질문·결정 '+decisionCount(plan),`class="${this.page==='decisions'?'active':''}"`)}${button('page-finalize','기획 확정 · 업무 분담',`class="${this.page==='finalize'?'active':''}"`)}${button('export','다른 PC로 옮길 백업','class="text-button"')}</nav>`;this.root.querySelector('.planner-alert').insertAdjacentHTML('afterend',nav);if(this.page!=='board'){this.root.querySelector('.planner-workspace').outerHTML=`<div class="decision-history">${button('undo','↶ 되돌리기',`class="button" ${!plan.undo.length?'disabled':''}`)}${button('redo','↷ 다시 실행',`class="button" ${!plan.redo.length?'disabled':''}`)}${button('history','변경 이력','class="text-button"')}</div>`+decisionWorkspace(this);this.root.querySelector('.planner-footnote')?.remove();}}
    paintConnections(this.root);
    if(plan&&this.mode==='graph'&&this.page==='board'){if(this.fitNext){this.fitNext=false;this.fit();}else{this.applyScale();const vp=this.root.querySelector('.graph-viewport');if(scroll){vp.scrollLeft=scroll.left;vp.scrollTop=scroll.top;}}}
  }
  welcomeHTML(){return `<div class="planning-welcome"><div class="planning-illustration" aria-hidden="true"><div class="mini-goal">${this.icon('layers')} 하나의 목표</div><div class="mini-lines"></div><div class="mini-children"><span>아이디어</span><i>+</i><span>구체적인 작업</span><i>+</i><span>완료 기준</span></div></div><span class="eyebrow">START WITH YOUR IDEA</span><h2>아이디어를, 한눈에 보이는 기획으로.</h2><p>프로젝트 설명을 바탕으로 기본 구조를 만들고<br>노드를 직접 편집하거나 세 에이전트의 제안을 가져오세요.</p><blockquote>${esc(this.project.description||'프로젝트 설명이 비어 있습니다. 빈 기획에서 목표를 직접 적을 수 있어요.')}</blockquote><div class="welcome-plan-actions">${button('ai-review','AI와 기획 시작','class="button primary"')}${button('start-template','설명으로 초안 만들기 '+this.icon('arrow'),'class="button primary"')}${button('start-blank','빈 기획 시작','class="button"')}</div><small>기본 초안은 규칙 기반의 편집 틀입니다. AI와 기획 시작은 연결된 CLI에 실제로 요청합니다.</small><div class="planning-demo">${button('start-demo',this.icon('grid')+' KAF 시연으로 기능 둘러보기','class="text-button"')}<span>중복 제안 통합 · 노드 편집 · 에이전트별 비교</span></div></div>`;}
  graphHTML(){
    const nodes=visibleNodes(this.plan,this.collapsed),visible=new Set(nodes.map(n=>n.id));
    const width=Math.max(680,...nodes.map(n=>n.x+NODE_WIDTH+70)),height=Math.max(400,...nodes.map(n=>n.y+NODE_HEIGHT+100));
    this.graphSize={width,height};
    const edges=this.plan.edges.filter(e=>visible.has(e.from)&&visible.has(e.to)&&!this.collapsed.has(e.from));
    const lines=edges.map(e=>{const a=this.plan.nodes.find(n=>n.id===e.from),b=this.plan.nodes.find(n=>n.id===e.to),x1=a.x+NODE_WIDTH/2,y1=a.y+NODE_HEIGHT,x2=b.x+NODE_WIDTH/2,y2=b.y;return {...e,x1,y1,x2,y2,mx:(x1+x2)/2,my:(y1+y2)/2};});
    return `<div class="graph-viewport" tabindex="0" aria-label="기획 노드 캔버스"><div class="graph-space"><div class="graph-world" style="width:${width}px;height:${height}px"><svg class="graph-edges" width="${width}" height="${height}" aria-hidden="true"><defs><marker id="plan-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0 6 3 0 6" fill="none" stroke="#607d6b"/></marker></defs>${lines.map(e=>`<path data-from="${e.from}" data-to="${e.to}" d="M${e.x1},${e.y1} C${e.x1},${e.my} ${e.x2},${e.my} ${e.x2},${e.y2-6}" marker-end="url(#plan-arrow)"/>`).join('')}</svg>${lines.map(e=>button('edge-add','+',`class="edge-add" style="left:${e.mx-13}px;top:${e.my-13}px" data-from="${e.from}" data-to="${e.to}" aria-label="${esc(this.plan.nodes.find(n=>n.id===e.from).title)}와 ${esc(this.plan.nodes.find(n=>n.id===e.to).title)} 사이에 노드 추가"`)).join('')}${nodes.map(node=>this.nodeHTML(node)).join('')}</div></div>${nodes.length===1?'<div class="canvas-hint">목표 아래의 +를 눌러 첫 번째 작업을 추가하세요.</div>':''}</div>`;
  }
  nodeHTML(node){const root=node.id===this.plan.rootId,agents=nodeSources(this.plan,node.id),count=childrenOf(this.plan,node.id).length,comments=this.plan.messages.filter(m=>m.nodeId===node.id).length;
    return `<article class="plan-node ${root?'goal-node':''} ${this.selected===node.id?'selected':''} ${this.chosen.has(node.id)?'chosen':''}" data-node="${node.id}" style="left:${node.x}px;top:${node.y}px;width:${NODE_WIDTH}px;height:${NODE_HEIGHT}px"><div class="node-top">${!root&&node.order?`<span class="node-order" title="선행 작업이 끝난 노드 사이의 우선순위">우선 #${node.order}</span>`:''}<span class="node-status ${node.status}">${root?'전체 목표':node.nodeType==='group'?'기능 묶음':statuses[node.status]}</span><div>${this.multiselect&&!root?`<input type="checkbox" data-select-node="${node.id}" aria-label="${esc(node.title)} 합치기 선택" ${this.chosen.has(node.id)?'checked':''}>`:''}${button('edit',this.icon('edit'),`data-id="${node.id}" title="노드 수정" aria-label="${esc(node.title)} 수정"`)}${!root?button('delete','−',`data-id="${node.id}" title="노드 삭제" aria-label="${esc(node.title)} 삭제"`):''}</div></div><button class="node-title" data-pa="select" data-id="${node.id}" title="${esc(node.title)}">${esc(node.title)}</button><p>${esc(node.description||'설명과 업무 지시를 추가해 보세요.')}</p>${!root?`<div class="node-meta-pill" title="${esc((node.functionSteps||[]).join(' → '))}">${node.nodeType==='group'?'하위 작업을 묶는 노드 · 직접 실행 안 함':node.dependencyIssues?.length?'선행 작업 재확인 필요':`선행 ${(node.dependsOn||[]).length} · 함수 ${(node.functionSteps||[]).length}단계${node.dependencyState!=='defined'?' · 미검토':''}`}</div>`:''}<div class="node-origins">${agents.length?agents.map(badge).join(''):`<span class="origin-user">${node.origin==='template'?'기본 초안':root?'프로젝트 목표':'직접 추가'}</span>`}</div><div class="node-bottom">${count?button('collapse',`${this.collapsed.has(node.id)?'▸':'▾'} 하위 ${count}`,`data-id="${node.id}" aria-expanded="${!this.collapsed.has(node.id)}"`):'<span class="node-leaf">세부 작업</span>'}${button('node-decisions','질문 '+decisionCount(this.plan,node.id),`data-id="${node.id}"`)}${button('chat',`${this.icon('chat')} 대화${comments?' '+comments:''}`,`data-id="${node.id}"`)}</div>${button('add-child','+',`class="node-add-child" data-id="${node.id}" title="하위 노드 추가" aria-label="${esc(node.title)} 아래에 노드 추가"`)}</article>`;
  }
  executionHTML(){
    const tasks=this.plan.nodes.filter(n=>n.id!==this.plan.rootId&&n.nodeType!=='group'),ordered=executionOrder(tasks),waves=executionWaves(tasks),name=id=>this.plan.nodes.find(n=>n.id===id)?.title||id;
    return `<section class="execution-plan" aria-label="노드 구현 순서"><h2>선행 작업부터, 준비된 순서대로</h2><p>상하위는 기능의 포함 관계입니다. 실행은 선행 작업이 끝난 뒤 진행하며, 동시에 준비되면 우선순위 숫자가 작은 작업부터 시작합니다. 같은 단계라도 현재 실행기는 차례로 실행합니다.</p>${tasks.some(n=>n.dependencyState!=='defined')?'<p class="execution-notice">선행 관계 미검토 노드가 있습니다. AI로 노드 정리 또는 노드 편집에서 관계를 확인하세요. 선행 0개가 검토 완료를 뜻하지는 않습니다.</p>':''}<ol class="execution-list">${ordered.map((n,i)=>`<li data-execution-node="${n.id}"><span class="execution-number">${i+1}</span><div><button type="button" class="execution-title" data-pa="select" data-id="${n.id}">${esc(n.title)}</button><small>의존 단계 ${waves.get(n.id)} · ${n.order?'우선순위 '+n.order:'우선순위 미지정'} · ${n.dependencyState==='defined'?'선행 관계 검토됨':'선행 관계 미검토'}</small><p>선행 작업: ${(n.dependsOn||[]).length?n.dependsOn.map(id=>`<button type="button" data-pa="select" data-id="${esc(id)}">${esc(name(id))}</button>`).join(', '):n.dependencyState==='defined'?'없음':'아직 지정하지 않음'}</p>${n.dependencyIssues?.length?`<ul class="execution-notice">${n.dependencyIssues.map(issue=>`<li>${esc(issue)}</li>`).join('')}</ul>`:''}${n.functionSteps?.length?`<details><summary>함수 구현 단계 ${n.functionSteps.length}개</summary><ol>${n.functionSteps.map(step=>`<li>${esc(step)}</li>`).join('')}</ol></details>`:''}</div>${button('edit','수정',`data-id="${n.id}" class="text-button"`)}</li>`).join('')||'<li>실행할 작업이 없습니다. 기능 묶음 아래에 작업 노드를 추가하세요.</li>'}</ol><p>기능 묶음은 직접 실행하지 않습니다. 확정 기획과 업무 분담에 반영한 뒤 개발·검토에서 실행합니다.</p></section>`;
  }
  executionFieldsHTML(node){
    if(node.id===this.plan.rootId)return '';
    const meta=normalizeExecutionMeta(node);
    return `<fieldset class="execution-editor"><legend>구현 순서 · 선행 작업</legend><label>노드 역할<select name="nodeType"><option value="task" ${meta.nodeType==='task'?'selected':''}>실행할 작업</option><option value="group" ${meta.nodeType==='group'?'selected':''}>기능 묶음 (직접 실행 안 함)</option></select></label><label>구현 우선순위<input type="number" name="order" min="1" max="999" step="1" value="${meta.order??''}" placeholder="미지정"></label><p class="helper">선행 작업이 끝난 노드 사이에서 작은 번호부터 실행합니다. 상하위 위치나 번호가 선행 관계를 대신하지 않습니다.</p><label>먼저 완료할 작업 (여러 개 선택)<select name="dependsOn" multiple size="5">${this.plan.nodes.filter(n=>n.id!==node.id&&n.id!==this.plan.rootId&&n.nodeType!=='group').map(n=>`<option value="${n.id}" ${meta.dependsOn.includes(n.id)?'selected':''}>${esc(n.title)}</option>`).join('')}</select></label><p class="helper">Ctrl(Windows) 또는 ⌘(Mac)를 누르고 선택하면 여러 작업을 선택하거나 해제할 수 있습니다. 기능 묶음은 선행 작업을 비워 주세요.</p><label>선행 관계 검토<select name="dependencyState"><option value="unreviewed" ${meta.dependencyState==='unreviewed'?'selected':''}>미검토 · 관계 확인 필요</option><option value="defined" ${meta.dependencyState==='defined'?'selected':''}>검토 완료 · 위 관계로 진행</option></select></label>${meta.dependencyIssues.length?`<div class="execution-notice"><ul>${meta.dependencyIssues.map(issue=>`<li>${esc(issue)}</li>`).join('')}</ul><label class="execution-check"><input type="checkbox" name="resolveDependencies">대체 선행 작업 또는 제외 범위를 확인했습니다. 재확인 알림을 해제합니다.</label></div>`:''}<label>함수 구현 단계 (한 줄에 하나, 최대 20개)<textarea name="functionSteps" rows="5" maxlength="12019" placeholder="입력 스키마와 검증 계약 정의&#10;계산 함수 구현과 경계값 검사&#10;결과 표시와 통합 검증">${esc(meta.functionSteps.join('\n'))}</textarea></label><p class="helper">스키마·검증 → 계산 → 상태 → 외부 연동 → UI 중 필요한 단계만 적으세요. 계약·모의 구현은 실제 동작 검증과 구분합니다.</p></fieldset>`;
  }
  executionDetailsHTML(node){
    if(node.id===this.plan.rootId)return '<p class="inspector-tip">상하위 연결은 기능 구조입니다. 구현 순서 탭에서 선행 작업과 실행 순서를 확인하세요.</p>';
    const meta=normalizeExecutionMeta(node),names=meta.dependsOn.map(id=>this.plan.nodes.find(n=>n.id===id)?.title||id);
    return `<div class="detail-field execution-details"><h3>구현 순서 · 선행 작업</h3><p>${meta.nodeType==='group'?'기능 묶음 · 직접 실행하지 않음':`우선순위 ${meta.order??'미지정'} · ${meta.dependencyState==='defined'?'선행 관계 검토됨':'선행 관계 미검토'}`}</p><p>선행 작업: ${esc(names.join(', ')||(meta.dependencyState==='defined'?'없음':'아직 지정하지 않음'))}</p>${meta.dependencyIssues.length?`<ul class="execution-notice">${meta.dependencyIssues.map(issue=>`<li>${esc(issue)}</li>`).join('')}</ul>`:''}<h3>함수 구현 단계</h3>${meta.functionSteps.length?`<ol>${meta.functionSteps.map(step=>`<li>${esc(step)}</li>`).join('')}</ol>`:'<p>아직 지정하지 않았습니다.</p>'}</div>`;
  }
  compareHTML(){return `<div class="proposal-comparison"><p class="compare-explainer">원래 제안은 그대로 보관됩니다. 같은 내용이 통합되어도 각 에이전트의 이유를 확인할 수 있어요.</p><div class="proposal-columns">${AGENTS.map(agent=>{const proposals=this.plan.proposals.filter(p=>p.agent===agent.id);return `<section class="proposal-column"><header>${badge(agent)}<span>${proposals.length}개 제안</span></header>${proposals.length?proposals.map(p=>`<article class="original-proposal"><span class="proposal-kind">${p.kind==='demo'?'시연 예시':p.kind==='live'?'실제 AI 응답':'가져온 제안'} · ${p.nodeId?nodeSources(this.plan,p.nodeId).length>1?'공동 노드로 통합':'단독 제안':'기획에서 제외됨'}</span><h3>${esc(p.title)}</h3><p>${esc(p.description)}</p>${p.reason?`<p class="proposal-reason">${esc(p.reason)}</p>`:''}<div>${p.nodeId?button('locate','노드 보기 ↗',`data-id="${p.nodeId}" class="text-button"`):button('restore-proposal','다시 추가',`data-id="${p.id}" class="text-button"`)}</div></article>`).join(''):`<div class="no-proposals">아직 가져온 제안이 없습니다.${button('import',agent.name+' 제안 가져오기',`data-agent="${agent.id}" class="text-button"`)}</div>`}</section>`;}).join('')}</div></div>`;}
  inspectorHTML(){
    const node=this.plan.nodes.find(n=>n.id===this.selected)||this.plan.nodes[0];this.selected=node.id;
    return `<div class="inspector-heading"><span class="eyebrow">${this.tab==='chat'&&this.chatTarget===null?'PROJECT CONVERSATION':'NODE INSPECTOR'}</span><h2>${this.tab==='chat'&&this.chatTarget===null?'전체 기획 대화':esc(node.title)}</h2></div><div class="inspector-tabs">${['content','chat','sources'].map((tab,i)=>button('tab-'+tab,['내용','대화','원본 제안'][i],`class="${this.tab===tab?'active':''}" aria-pressed="${this.tab===tab}"`)).join('')}</div><div class="inspector-body">${this.tab==='content'?this.detailsHTML(node):this.tab==='chat'?this.chatHTML():this.sourcesHTML(node)}</div>`;
  }
  detailsHTML(node){if(this.editing)return `<form id="node-editor" class="plan-form"><label>노드 이름<input name="title" maxlength="100" value="${esc(node.title)}" required></label><label>설명<textarea name="description" maxlength="3000" rows="3">${esc(node.description)}</textarea></label><label>업무 지시<textarea name="instructions" maxlength="6000" rows="4" placeholder="구체적인 작업 범위와 요구사항">${esc(node.instructions)}</textarea></label><label>완료 기준<textarea name="criteria" maxlength="3000" rows="3" placeholder="무엇을 확인하면 완료인가요?">${esc(node.criteria)}</textarea></label>${this.executionFieldsHTML(node)}<label>기획 상태<select name="status">${Object.entries(statuses).map(([key,value])=>`<option value="${key}" ${node.status===key?'selected':''}>${value}</option>`).join('')}</select></label><p class="helper">수정한 내용은 저장 후 그래프와 다음 검토 요청에 반영됩니다.</p><div class="inspector-form-actions">${button('cancel-edit','취소','class="button"')}<button class="button primary" type="submit">변경 사항 저장</button></div></form>`;
    return `<span class="detail-state ${node.status}">${statuses[node.status]}</span><div class="detail-field"><h3>설명</h3><p>${esc(node.description||'아직 설명이 없습니다.')}</p></div><div class="detail-field"><h3>업무 지시</h3><p>${esc(node.instructions||'어떤 작업이 필요한지 구체적으로 적어 주세요.')}</p></div><div class="detail-field"><h3>완료 기준</h3><p>${esc(node.criteria||'원하는 결과를 확인할 기준을 적어 주세요.')}</p></div>${this.executionDetailsHTML(node)}<div class="detail-field"><h3>제안 출처</h3><div class="inspector-sources">${nodeSources(this.plan,node.id).map(badge).join('')||'<span class="muted">직접 작성 / 기본 초안</span>'}</div></div><div class="inspector-actions">${button('edit',this.icon('edit')+' 내용 수정',`data-id="${node.id}" class="button full"`)}${button('add-child','+ 하위 노드 추가',`data-id="${node.id}" class="button full"`)}${node.id!==this.plan.rootId?button('reparent','상위 노드 변경',`data-id="${node.id}" class="text-button"`):''}</div><p class="inspector-tip">노드를 선택한 뒤 대화 탭에서 이 부분에 대한 의견을 남길 수 있어요.</p>`;
  }
  sourcesHTML(node){const proposals=this.plan.proposals.filter(p=>p.nodeId===node.id);return proposals.length?proposals.map(p=>`<article class="inspector-proposal">${badge(AGENTS.find(a=>a.id===p.agent))}<small>${p.kind==='demo'?'시연 예시 · 실제 AI 응답 아님':p.kind==='live'?'CLI에서 받은 실제 제안':'사용자가 가져온 제안'}</small><h3>${esc(p.title)}</h3><p>${esc(p.description)}</p>${p.instructions?`<h4>업무 지시</h4><p>${esc(p.instructions)}</p>`:''}${p.criteria?`<h4>완료 기준</h4><p>${esc(p.criteria)}</p>`:''}${p.reason?`<h4>제안 이유</h4><p>${esc(p.reason)}</p>`:''}</article>`).join(''):'<div class="inspector-empty">직접 만든 노드입니다.<br>각 에이전트의 제안을 가져오면 이곳에서 원본을 비교할 수 있어요.</div>';}
  chatHTML(){const messages=this.plan.messages.filter(m=>this.chatTarget===null||m.nodeId===this.chatTarget),target=this.chatTarget||'all';return `<div class="chat-scope">${this.chatTarget?`이 노드에 대한 대화 ${button('chat-all','전체 보기','class="text-button"')}`:'전체 기획과 노드별 대화를 모아 봅니다.'}</div><div class="planning-messages">${messages.length?messages.map(m=>`<article class="plan-message ${m.author==='user'?'mine':''}"><div><strong>${m.author==='user'?'나':AGENTS.find(a=>a.id===m.author).name}</strong><small>${m.author!=='user'?(m.kind==='demo'?'시연 예시':m.kind==='live'?'실제 AI 응답':'가져온 응답'):time(m.at)}</small></div><span>${esc(m.nodeTitle)}${m.nodeId&&!this.plan.nodes.some(n=>n.id===m.nodeId)?' · 삭제된 노드':''}</span><p>${esc(m.text)}</p><div class="message-actions">${button('message-node','노드로 추가',`data-id="${m.id}" class="text-button"`)}${this.chatTarget?button('message-instruction','업무 지시에 반영',`data-id="${m.id}" class="text-button"`):''}</div></article>`).join(''):'<div class="inspector-empty">추가할 기능, 바꾸고 싶은 조건,<br>아직 결정하지 못한 내용을 남겨 주세요.</div>'}</div><form id="planning-chat" class="plan-form chat-composer"><label class="sr-only" for="planning-message">기획 의견</label><textarea id="planning-message" name="message" maxlength="6000" rows="3" placeholder="이 기획에 대한 의견을 남겨 주세요." required>${esc(this.drafts.get(target)||'')}</textarea><div><small>저장한 요구는 다음 노드 정리·질문 검토의 주 AI 통합에 전달됩니다.</small><button type="submit" class="button primary compact">의견 저장 ↑</button></div></form><div class="chat-exchange">${button('ai-chat','AI에 검토 요청','class="text-button"')}${button('prompt','검토 요청문 복사','class="text-button"')}${button('import-reply','AI 응답 가져오기','class="text-button"')}</div>`;}
  openModal(title,body,footer=''){
    this.modalDirty=false;this.root.querySelector('.planner-dialog')?.remove();
    this.root.insertAdjacentHTML('beforeend',`<dialog class="planner-dialog"><form id="plan-dialog-form"><div class="plan-dialog-heading"><h2 id="plan-dialog-title">${title}</h2>${button('close-modal','×','aria-label="닫기"')}</div><div class="plan-dialog-body"><p class="plan-form-error" role="alert" tabindex="-1" hidden></p>${body}</div><div class="plan-dialog-footer">${button('close-modal','취소','class="button"')}${footer}</div></form></dialog>`);
    const modal=this.root.querySelector('.planner-dialog');modal.setAttribute('aria-labelledby','plan-dialog-title');modal.showModal();modal.addEventListener('cancel',e=>{if(this.saving)e.preventDefault();else{this.modalDirty=false;this.modal=null;}});
  }
  closeModal(){if(this.saving)return;const modal=this.root.querySelector('.planner-dialog');modal?.close();modal?.remove();this.modalDirty=false;this.modal=null;}
  fieldsHTML(fields){return `<div class="plan-form"><label>노드 이름<input name="title" maxlength="100" value="${esc(fields.title||'')}" placeholder="예: 가격 변동 알림" required autofocus></label><label>설명<textarea name="description" maxlength="3000" rows="3">${esc(fields.description||'')}</textarea></label><label>업무 지시<textarea name="instructions" maxlength="6000" rows="3">${esc(fields.instructions||'')}</textarea></label><label>완료 기준<textarea name="criteria" maxlength="3000" rows="2">${esc(fields.criteria||'')}</textarea></label></div>`;}
  addDialog(parentId,betweenId=null,prefill={}){
    this.modal={type:'add',parentId,betweenId};
    const parent=this.plan.nodes.find(n=>n.id===parentId);
    this.openModal('노드 추가',`<p class="plan-dialog-intro">${esc(parent.title)}에 새로운 아이디어를 연결합니다.</p>${betweenId?'<div class="add-choice"><label><input type="radio" name="placement" value="between" checked> 두 노드 사이에 넣기</label><label><input type="radio" name="placement" value="branch"> 같은 단계에 가지 추가</label></div>':''}${this.fieldsHTML(prefill)}`,'<button class="button primary" type="submit">노드 추가</button>');
  }
  importDialog(agent='codex',reply=false){this.modal={type:'import',targetId:this.tab==='chat'?this.chatTarget:this.selected};this.openModal('에이전트의 제안 가져오기',`<p class="plan-dialog-intro">각 도구에서 받은 응답을 붙여넣으세요. 자동 연결 없이도 같은 기획에 모아 볼 수 있습니다.</p><div class="plan-form"><label>제안한 에이전트<select name="agent">${AGENTS.map(a=>`<option value="${a.id}" ${agent===a.id?'selected':''}>${a.name}</option>`).join('')}</select></label><label>응답 종류<select name="kind"><option value="nodes" ${!reply?'selected':''}>노드 제안 · JSON</option><option value="reply" ${reply?'selected':''}>검토 의견 · 일반 텍스트</option></select></label><label>응답 내용<textarea name="response" rows="10" maxlength="200000" placeholder='{"nodes":[{"id":"n1","title":"제안 이름","description":"설명","parentId":null}]}' required></textarea></label></div><p class="helper">검토 요청문을 복사하면 프로젝트 설명·공통 지침·현재 노드·피드백과 응답 형식이 함께 전달됩니다. 이름·설명·지시·완료 기준과 상위 노드가 모두 같은 제안만 자동 통합합니다.</p>${this.plan?button('prompt','검토 요청문 복사','class="text-button"'):''}`,'<button type="submit" class="button primary">기획에 가져오기</button>');}
  applyScale(){const world=this.root.querySelector('.graph-world'),space=this.root.querySelector('.graph-space');if(!world||!space)return;world.style.transform=`scale(${this.scale})`;space.style.width=this.graphSize.width*this.scale+'px';space.style.height=this.graphSize.height*this.scale+'px';const label=this.root.querySelector('.zoom-tools>span');if(label)label.textContent=Math.round(this.scale*100)+'%';}
  fit(){const vp=this.root.querySelector('.graph-viewport');if(!vp)return;this.scale=Math.max(.08,Math.min(1,(vp.clientWidth||850)/this.graphSize.width,(vp.clientHeight||560)/this.graphSize.height));this.applyScale();vp.scrollLeft=0;vp.scrollTop=0;}
  focusNode(id){this.page='board';this.selected=id;this.collapsed.clear();this.mode='graph';this.fitNext=true;this.render();}
  async copyPrompt(){const content=reviewPrompt(this.project,this.plan,this.tab==='chat'?this.chatTarget:this.selected);try{await navigator.clipboard.writeText(content);this.toast('검토 요청문을 복사했습니다. 사용할 에이전트에 붙여넣으세요.');}catch{this.modal={type:'copy'};this.openModal('검토 요청문',`<p class="plan-dialog-intro">아래 내용을 선택해 복사한 뒤 각 에이전트에 붙여넣으세요.</p><div class="plan-form"><textarea rows="15" readonly>${esc(content)}</textarea></div>`);this.root.querySelector('.planner-dialog textarea').select();}}
  async organize(){
    if(!this.plan||this.plan.nodes.length<2){this.toast('정리할 작업 노드를 먼저 추가해 주세요.');return;}
    if(this.hasDraft()){this.toast('작성 중인 의견과 수정 내용을 먼저 저장해 주세요.');return;}
    const selectedIds=this.chosen.size?[...this.chosen]:this.plan.nodes.filter(n=>n.id!==this.plan.rootId).map(n=>n.id);
    this.agentDialogOpen=true;
    await openOrganizer({project:this.project,plan:this.plan,selectedIds,onClose:()=>{this.agentDialogOpen=false;},onApply:async(next,baseChange)=>{
      if(this.stale||this.plan.changeNumber!==baseChange)throw new Error('기획이 변경되었습니다. 현재 내용을 확인한 뒤 다시 정리해 주세요.');
      if(!await this.persist(next,()=>{this.chosen.clear();this.collapsed.clear();this.multiselect=false;this.selected=next.rootId;this.tab='content';this.mode='graph';this.fitNext=true;this.toast('AI 정리안을 적용했습니다. 되돌리기로 복원할 수 있습니다.');}))throw new Error('기획을 저장하지 못했습니다. 응답은 유지됩니다.');
    }});
  }
  async requestAI(targetId=null){
    if(this.hasDraft()){this.toast('작성 중인 의견과 수정 내용을 먼저 저장해 주세요.');return;}
    if(!this.plan){const initial=createPlan(this.project);if(!await this.persist(initial,()=>{this.selected=initial.rootId;}))return;}
    this.agentDialogOpen=true;
    await openAgentReview({project:this.project,plan:this.plan,targetId,onClose:()=>{this.agentDialogOpen=false;},onApply:async(jobs,target,instruction)=>{
      if(this.stale)throw new Error('다른 탭에서 기획이 변경되었습니다. 응답은 임시 보관됩니다. 창을 닫고 새로고침한 뒤 AI 기획 요청을 다시 여세요.');
      if(target&&!this.plan.nodes.some(n=>n.id===target))throw new Error('요청 대상 노드가 삭제되었습니다. 응답을 비우고 다시 요청해 주세요.');
      const next=changePlan(this.plan,'실제 AI 의견과 노드 반영',p=>{
        p.appliedRuns??=[];
        if(instruction?.trim()&&jobs.some(job=>!p.appliedRuns.includes(job.id)))appendMessage(p,{nodeId:target,text:instruction});
        for(const job of jobs){if(p.appliedRuns.includes(job.id))continue;
          if(job.result.nodes.length)importProposals(p,job.agent,job.result.nodes,'live',target||p.rootId);
          if(job.result.summary)appendMessage(p,{nodeId:target,author:job.agent,text:job.result.summary,kind:'live'});
          p.appliedRuns.push(job.id);
        }
        p.appliedRuns=p.appliedRuns.slice(-300);layoutPlan(p);
      });
      if(!await this.persist(next,()=>{this.fitNext=true;this.tab='chat';this.chatTarget=target;this.toast('AI 의견과 제안을 기획에 반영했습니다.');}))throw new Error('기획을 저장하지 못했습니다. 응답은 유지됩니다. 저장 오류를 해결한 뒤 다시 반영하세요.');
    }});
  }
  async onClick(event){
    if(event.target.closest('[data-dec]')){try{await handleDecisionClick(this,event);}catch(error){this.error(error);}return;}
    const el=event.target.closest('[data-pa]');if(!el||!this.root.contains(el))return;event.preventDefault();const action=el.dataset.pa,id=el.dataset.id;
    if(this.ignoreClick){this.ignoreClick=false;return;}
    try{
      if(action==='close-modal'){this.closeModal();return;}
      if(action==='cancel-edit'){this.dirty=false;this.editing=false;this.render();return;}
      if(action==='prompt'){if(this.plan)await this.copyPrompt();return;}
      if(action==='connections'){await openConnections();return;}
      if(!this.guard())return;
      if(action.startsWith('page-')){this.page=action.slice(5);this.render();return;}
      if(action==='node-decisions'){this.page='decisions';this.decisionState={tab:'answer',node:id,selected:null,newItem:false};this.render();return;}
      if(action==='organize'){await this.organize();return;}
      if(action==='select-all'&&this.plan){this.chosen=new Set(this.plan.nodes.filter(n=>n.id!==this.plan.rootId).map(n=>n.id));this.multiselect=true;this.render();return;}
      if(action==='ai-review'||action==='ai-chat'){await this.requestAI(action==='ai-chat'?this.chatTarget:null);return;}
      if(action.startsWith('start-')){const next=action==='start-demo'?createDemo(this.project):createPlan(this.project,action==='start-template');await this.persist(next,()=>{this.selected=next.rootId;this.fitNext=true;});return;}
      if(action==='import'||action==='import-reply'){this.importDialog(el.dataset.agent,action==='import-reply');return;}
      if(!this.plan)return;
      if(action==='select'){this.selected=id;this.chatTarget=id;this.editing=false;if(this.multiselect&&id!==this.plan.rootId){this.chosen.has(id)?this.chosen.delete(id):this.chosen.add(id);}this.render();}
      else if(action==='edit'){this.selected=id;this.tab='content';this.editing=true;this.render();this.root.querySelector('#node-editor input')?.focus();}
      else if(action==='chat'||action==='chat-all'){this.chatTarget=action==='chat'?id:null;if(id)this.selected=id;this.tab='chat';this.editing=false;this.render();this.root.querySelector('#planning-message')?.focus();}
      else if(action.startsWith('tab-')){this.tab=action.slice(4);if(this.tab==='chat')this.chatTarget=this.selected;this.editing=false;this.render();}
      else if(action==='add-child'||action==='add-root'){this.addDialog(action==='add-root'?this.plan.rootId:id);}
      else if(action==='edge-add'){this.addDialog(el.dataset.from,el.dataset.to);}
      else if(action==='delete'){const node=this.plan.nodes.find(n=>n.id===id),count=descendants(this.plan,id).size;this.modal={type:'delete',id};this.openModal('이 노드를 삭제할까요?',`<p class="plan-dialog-intro"><strong>${esc(node.title)}</strong>을 기획에서 삭제합니다. 변경은 되돌릴 수 있습니다.</p>${count?`<div class="add-choice"><label><input type="radio" name="scope" value="one" checked> 이 노드만 삭제 · 하위 연결 유지</label><label><input type="radio" name="scope" value="all"> 연결된 하위 ${count}개 노드도 함께 삭제</label></div>`:''}`,'<button type="submit" class="button danger">노드 삭제</button>');}
      else if(action==='collapse'){this.collapsed.has(id)?this.collapsed.delete(id):this.collapsed.add(id);this.render();}
      else if(action==='multi'){this.multiselect=!this.multiselect;if(!this.multiselect)this.chosen.clear();this.render();}
      else if(action==='merge'){const ids=[...this.chosen];if(ids.length<2)return;this.modal={type:'merge',ids};this.openModal('선택한 노드 합치기',`<p class="plan-dialog-intro">${ids.map(i=>esc(this.plan.nodes.find(n=>n.id===i)?.title)).join(' + ')}<br>원본 제안·대화·연결 관계를 함께 보존합니다. 합칠 내용을 아래에서 수정하세요.</p>${this.fieldsHTML(mergeFields(this.plan,ids))}`,'<button type="submit" class="button primary">합치기 적용</button>');}
      else if(action==='reparent'){this.modal={type:'reparent',id};const excluded=descendants(this.plan,id);excluded.add(id);this.openModal('상위 노드 변경',`<p class="plan-dialog-intro">선택한 노드의 기존 상위 연결을 아래 노드로 변경합니다. 하위 노드는 함께 이동합니다.</p><div class="plan-form"><label>새 상위 노드<select name="parent">${this.plan.nodes.filter(n=>!excluded.has(n.id)).map(n=>`<option value="${n.id}">${esc(n.title)}</option>`).join('')}</select></label></div>`,'<button type="submit" class="button primary">관계 변경</button>');}
      else if(action==='undo'||action==='redo'){await this.persist(travelHistory(this.plan,action),()=>{this.selected=null;this.chatTarget=null;this.chosen.clear();this.collapsed.clear();this.editing=false;this.toast(action==='undo'?'변경을 되돌렸습니다.':'변경을 다시 적용했습니다.');});}
      else if(action==='layout'){await this.mutate('노드 자동 정렬',p=>layoutPlan(p),()=>{this.fitNext=true;});}
      else if(action==='zoom-in'||action==='zoom-out'){this.scale=Math.min(1.5,Math.max(.3,this.scale+(action==='zoom-in'?.1:-.1)));this.applyScale();}
      else if(action==='fit')this.fit();
      else if(['mode-graph','mode-execution','mode-compare'].includes(action)){this.mode=action.slice(5);this.render();}
      else if(action==='locate'){this.closeModal();this.focusNode(id);}
      else if(action==='candidate-select'){const ids=el.dataset.ids.split(',');this.closeModal();this.chosen=new Set(ids);this.multiselect=true;this.mode='graph';this.render();}
      else if(action==='candidates'){this.modal={type:'info'};const pairs=similarPairs(this.plan);this.openModal('통합을 검토할 노드',`<p class="plan-dialog-intro">이름의 공통 단어로 찾은 후보입니다. 의미와 범위가 같은지는 내용을 비교해 결정하세요.</p>${pairs.length?pairs.map(ids=>`<div class="candidate-row"><span>${ids.map(i=>esc(this.plan.nodes.find(n=>n.id===i).title)).join(' ↔ ')}</span>${button('candidate-select','두 노드 선택',`data-ids="${ids.join(',')}" class="button compact"`)}</div>`).join(''):'<p>자동으로 찾은 후보가 없습니다. 캔버스에서 여러 노드를 직접 선택해 합칠 수 있습니다.</p>'}`);}
      else if(action==='history'){this.modal={type:'info'};this.openModal('기획 변경 이력',this.plan.history.length?`<ol class="plan-history">${this.plan.history.map(h=>`<li><strong>${esc(h.label)}</strong><time>${time(h.at)}</time></li>`).join('')}</ol>`:'<p>첫 번째 변경부터 이곳에 기록됩니다.</p>');}
      else if(action==='export')this.exportProject();
      else if(action==='restore-proposal'){const source=this.plan.proposals.find(p=>p.id===id);await this.mutate('제외된 제안 다시 추가',p=>{const node=addNode(p,p.rootId,source);node.origin='proposal';p.proposals.find(s=>s.id===id).nodeId=node.id;layoutPlan(p);this.selected=node.id;});}
      else if(action==='message-node'){const message=this.plan.messages.find(m=>m.id===id);this.addDialog(this.chatTarget||this.plan.rootId,null,{title:message.text.split('\n')[0].slice(0,100),description:message.text.slice(0,3000)});}
      else if(action==='message-instruction'){const message=this.plan.messages.find(m=>m.id===id);await this.mutate('대화 내용을 업무 지시에 반영',p=>{const node=p.nodes.find(n=>n.id===this.chatTarget);node.instructions=[node.instructions,message.text].filter(Boolean).join('\n\n');node.status='draft';});}
    }catch(error){this.error(error);}
  }
  async onSubmit(event){
    if(event.target.id.startsWith('decision-')){try{await handleDecisionSubmit(this,event);}catch(error){this.error(error);}return;}
    if(!['plan-dialog-form','node-editor','planning-chat'].includes(event.target.id))return;event.preventDefault();if(this.saving)return;
    try{
      const data=Object.fromEntries(new FormData(event.target));
      if(event.target.id==='node-editor'){if(event.target.elements.nodeType){const form=new FormData(event.target);Object.assign(data,{nodeType:form.get('nodeType'),order:form.get('order')?Number(form.get('order')):null,dependsOn:form.getAll('dependsOn'),functionSteps:String(form.get('functionSteps')||'').split('\n').map(v=>v.trim()).filter(Boolean),dependencyState:form.get('dependencyState')});if(form.has('resolveDependencies'))data.dependencyIssues=[];}await this.mutate('노드 내용 수정',p=>editNode(p,this.selected,data),()=>{this.dirty=false;this.editing=false;});return;}
      if(event.target.id==='planning-chat'){const target=this.chatTarget;await this.mutate('기획 의견 저장',p=>appendMessage(p,{nodeId:target,text:data.message}),()=>{this.drafts.delete(target||'all');});return;}
      const m=this.modal;if(!m)return;
      const after=()=>{this.modalDirty=false;this.modal=null;this.fitNext=true;};
      if(m.type==='decision-delete'){await this.mutate('질문·답변 삭제',p=>{p.items=p.items.filter(i=>i.id!==m.id);},after);return;}
      if(m.type==='add')await this.mutate('노드 추가',p=>{const node=addNode(p,m.parentId,data,data.placement==='between'?m.betweenId:null);layoutPlan(p);this.selected=node.id;this.tab='content';},after);
      else if(m.type==='delete')await this.mutate('노드 삭제',p=>{removeNode(p,m.id,data.scope==='all');layoutPlan(p);this.selected=p.rootId;this.chatTarget=null;this.tab='content';this.chosen.clear();},after);
      else if(m.type==='merge')await this.mutate('선택한 노드 합치기',p=>{this.selected=mergeNodes(p,m.ids,data);layoutPlan(p);this.multiselect=false;this.chosen.clear();},after);
      else if(m.type==='reparent')await this.mutate('상위 노드 변경',p=>{moveUnder(p,m.id,data.parent);layoutPlan(p);},after);
      else if(m.type==='import'){
        const initial=this.plan||createPlan(this.project),target=m.targetId||initial.rootId;
        const nodes=data.kind==='nodes'?parseProposals(data.response):null;let result;
        const next=changePlan(initial,data.kind==='nodes'?'에이전트 노드 제안 가져오기':'에이전트 검토 의견 가져오기',p=>{if(nodes){result=importProposals(p,data.agent,nodes,'import',target);layoutPlan(p);}else appendMessage(p,{nodeId:m.targetId,author:data.agent,text:data.response,kind:'import'});});
        await this.persist(next,()=>{after();this.selected=target;if(!nodes){this.tab='chat';this.chatTarget=m.targetId;}this.toast(result?`${result.added}개 노드 추가 · ${result.combined}개 동일 제안 통합`:'검토 의견을 가져왔습니다.');});
      }
    }catch(error){this.error(error);}
  }
  onInput(event){
    decisionInput(this,event);
    if(event.target.closest('#node-editor'))this.dirty=true;
    if(event.target.id==='planning-message')this.drafts.set(this.chatTarget||'all',event.target.value);
    if(event.target.closest('#plan-dialog-form'))this.modalDirty=true;
    if(event.target.dataset.selectNode){if(this.dirty){event.target.checked=!event.target.checked;this.toast('수정 내용을 먼저 저장해 주세요.');return;}const id=event.target.dataset.selectNode;event.target.checked?this.chosen.add(id):this.chosen.delete(id);this.render();}
  }
  onKey(event){if(['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)||this.root.querySelector('dialog[open]'))return;if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();const action=event.shiftKey?'redo':'undo';this.root.querySelector(`[data-pa="${action}"]`)?.click();}if(event.key==='Escape'&&this.multiselect){this.chosen.clear();this.multiselect=false;this.render();}}
  updateEdgesWhileDragging(id,x,y){
    const position=nodeId=>nodeId===id?{x,y}:this.plan.nodes.find(n=>n.id===nodeId);
    for(const path of this.root.querySelectorAll('.graph-edges path[data-from]')){
      if(path.dataset.from!==id&&path.dataset.to!==id)continue;
      const a=position(path.dataset.from),b=position(path.dataset.to),x1=a.x+NODE_WIDTH/2,y1=a.y+NODE_HEIGHT,x2=b.x+NODE_WIDTH/2,y2=b.y,my=(y1+y2)/2;
      path.setAttribute('d',`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2-6}`);
      const plus=this.root.querySelector(`.edge-add[data-from="${path.dataset.from}"][data-to="${path.dataset.to}"]`);
      if(plus){plus.style.left=(x1+x2)/2-13+'px';plus.style.top=my-13+'px';}
    }
  }
  onPointerDown(event){
    const control=event.target.closest('button,input,textarea,select,dialog');
    if(event.button!==0||this.saving||this.dirty||(control&&!control.matches('.node-title')))return;
    const card=event.target.closest('.plan-node'),vp=event.target.closest('.graph-viewport');if(!vp)return;
    const node=card&&this.plan.nodes.find(n=>n.id===card.dataset.node),start={x:event.clientX,y:event.clientY,left:vp.scrollLeft,top:vp.scrollTop,nx:node?.x,ny:node?.y};let moved=false,lastX,lastY;
    const move=e=>{const dx=e.clientX-start.x,dy=e.clientY-start.y;if(Math.abs(dx)+Math.abs(dy)<4&&!moved)return;moved=true;
      if(node){lastX=Math.max(0,Math.min(49000,start.nx+dx/this.scale));lastY=Math.max(0,Math.min(49000,start.ny+dy/this.scale));card.style.left=lastX+'px';card.style.top=lastY+'px';card.classList.add('dragging');this.updateEdgesWhileDragging(node.id,lastX,lastY);}
      else{vp.scrollLeft=start.left-dx;vp.scrollTop=start.top-dy;}
    };
    const end=async e=>{this.endDrag?.();if(moved){this.ignoreClick=true;setTimeout(()=>{this.ignoreClick=false;},0);}if(e.type==='pointercancel'){if(moved)this.render();return;}if(moved&&node){try{await this.mutate('노드 위치 이동',p=>{const n=p.nodes.find(n=>n.id===node.id);n.x=Math.round(lastX);n.y=Math.round(lastY);});}catch(error){this.error(error);}if(!this.disposed)this.render();}};
    this.endDrag=()=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',end);document.removeEventListener('pointercancel',end);this.endDrag=null;};
    document.addEventListener('pointermove',move);document.addEventListener('pointerup',end,{once:true});document.addEventListener('pointercancel',end,{once:true});
  }
}
