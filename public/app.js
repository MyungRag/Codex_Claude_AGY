import {openConnections} from './agent-ui.js?v=0.9.5';
import {mountPlanner} from './planning.js?v=0.9.5';
import {mountDevelopment} from './development.js?v=0.9.5';
import {COLORS,MAX_FILE_BYTES,MAX_PROJECTS,validateProject,readBackup,importCopies,selectProjects} from './model.js?v=0.9.5';
import {openStore,readState,saveState} from './storage.js?v=0.9.5';

const $ = (selector, root=document) => root.querySelector(selector);
const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
  chat:'M4 4h16v12H9l-5 4V4Z',
  grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  folder:'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  plus:'M12 5v14M5 12h14',arrow:'M5 12h14m-5-5 5 5-5 5',back:'m14 6-6 6 6 6',
  search:'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  monitor:'M3 3h18v14H3z M8 21h8M12 17v4',check:'m5 12 4 4L19 6',
  star:'m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z',
  archive:'M3 3h18v5H3z M5 8v13h14V8M10 12h4',
  trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  file:'M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 12h8M8 16h6',
  link:'m10 13 4-4m-6 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
  edit:'m16 3 5 5L8 21H3v-5ZM13 6l5 5',
  close:'m6 6 12 12M6 18 18 6',download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  upload:'M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5',
  layers:'m12 3 10 6-10 6L2 9Zm-10 9 10 6 10-6M2 16l10 6 10-6',
  clock:'M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  info:'M12 11v6M12 7v1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  chevron:'m6 9 6 6 6-6', restore:'M3 10a9 9 0 1 1 2 9M3 4v6h6', copy:'M8 8h13v13H8zM16 8V3H3v13h5',
};
function icon(name, cls='') {return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.folder}"/></svg>`;}
const formatDate = v => v ? new Intl.DateTimeFormat('ko-KR',{month:'short',day:'numeric'}).format(new Date(v)) : '아직 열지 않음';
const bytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.ceil(n/1024)} KB` : `${(n/1048576).toFixed(1)} MB`;
const readPreference = (key,fallback) => {try{return localStorage.getItem(key)||fallback;}catch{return fallback;}};
const preference = (key,value) => {try{localStorage.setItem(key,value);}catch{}};
let state = {projects:[],revision:0};
let filter='all', query='', sort='recent', editing=null, pendingFiles=[], pendingImport=null, toastTimer;
let dialogRevision=0, dialogOrigin=null, busy=false;
let pendingFolderNames={}, pendingHandles={}, deleting=null, deleteRevision=0, nativePicker=false;
fetch('/api/capabilities',{cache:'no-store',signal:AbortSignal.timeout(2500)}).then(async response=>{
  if(response.ok&&response.headers.get('content-type')?.includes('application/json')) nativePicker=(await response.json()).folderPicker==='native';
}).catch(()=>{});
const channel = typeof BroadcastChannel==='function' ? new BroadcastChannel('agent-desk-projects') : null;
let planner=null,developmentView=null;
const isPlanning=()=>location.hash.endsWith('/planning');
const isDevelopment=()=>location.hash.endsWith('/development');
const activeProject = () => state.projects.find(p=>p.id===location.hash.slice(1).split('/')[0]);
async function commit(projects, revision=state.revision, folderUpdates=[],redraw=true) {
  const next = await saveState({projects},revision,folderUpdates);
  state=next;channel?.postMessage('changed');if(redraw)render();
}
function toast(message) {clearTimeout(toastTimer);const el=$('#toast');el.textContent=message;el.classList.add('visible');toastTimer=setTimeout(()=>el.classList.remove('visible'),3600);}
function goList(nextFilter='all') {filter=nextFilter;history.pushState(null,'',location.pathname);render();}
async function openProject(id) {
  const p=state.projects.find(p=>p.id===id);if(!p)return;
  await commit(state.projects.map(item=>item.id===id?{...item,lastOpenedAt:new Date().toISOString()}:item));
  history.pushState(null,'',`#${id}`);preference('agent-desk-last-project',id);render();$('#main').focus();
}
function shell() {
  const active=activeProject();
  const recent=selectProjects(state.projects).slice(0,5);
  const count=state.projects.filter(p=>!p.archived).length;
  return `<aside class="sidebar"><a href="/" class="brand" data-action="list"><span class="brand-icon">${icon('layers')}</span><span>agent<span class="brand-light">desk</span><small>YOUR AGENT WORKSPACE</small></span></a>
    <div class="workspace-name"><span class="avatar">M</span><div>내 워크스페이스<small>개인 프로젝트 공간</small></div><span class="tiny-dot"></span></div>
    <div class="nav-label">WORKSPACE</div>
    <nav aria-label="주 메뉴"><button class="nav-item ${!active&&filter==='all'?'active':''}" data-action="list">${icon('grid')}프로젝트<span class="count">${count}</span></button>
    <button class="nav-item ${!active&&filter==='pinned'?'active':''}" data-action="pinned">${icon('star')}즐겨찾기</button><button class="nav-item ${!active&&filter==='archive'?'active':''}" data-action="archive-list">${icon('archive')}보관함</button></nav>
    <div class="nav-label recent-label">최근 프로젝트<button class="small-icon" data-action="new" aria-label="프로젝트 추가">${icon('plus')}</button></div>
    <div class="recent-nav">${recent.length?recent.map(p=>`<div class="recent-row ${active?.id===p.id?'selected':''}"><button class="recent-item" data-action="open" data-id="${p.id}"><span class="project-dot ${p.color}"></span><span>${esc(p.name)}</span></button><button class="small-icon delete-project" data-action="delete" data-id="${p.id}" aria-label="${esc(p.name)} 프로젝트 삭제" title="프로젝트 삭제">${icon('trash')}</button></div>`).join(''):'<p class="sidebar-empty">프로젝트를 등록하면<br>이곳에서 빠르게 열 수 있어요.</p>'}</div>
    <div class="sidebar-bottom"><div class="agent-row"><span class="agent-symbol mint">C</span><span class="agent-symbol orange">✳</span><span class="agent-symbol blue">A</span></div><p>세 에이전트, 하나의 공간.</p><small>Codex · Claude · Antigravity</small><div class="storage-indicator"><span></span>이 브라우저에 저장됨</div></div>
  </aside>
  <div class="main-wrap"><header class="topbar"><div class="breadcrumb">워크스페이스<span>/</span><button data-action="list">프로젝트</button>${active?`<span>/</span><strong>${esc(active.name)}</strong>`:''}</div><div class="topbar-actions"><button class="button compact" data-action="agents">${icon('link')}AI 연결</button><div class="pc-select current-device">${icon('monitor')}<span>현재 PC</span></div></div></header>
  <main id="main" class="${active&&(isPlanning()||isDevelopment())?'planning-main':''}" tabindex="-1">${active?`<div class="project-subnav"><button data-action="overview" data-id="${active.id}" class="${!isPlanning()&&!isDevelopment()?'active':''}">${icon('folder')}프로젝트 정보</button><button data-action="planning" data-id="${active.id}" class="${isPlanning()?'active':''}">${icon('layers')}기획 보드</button><button data-action="development" data-id="${active.id}" class="${isDevelopment()?'active':''}">${icon('check')}개발·검토</button><span>아이디어에서 실행 가능한 결과까지</span></div>${isPlanning()?'<div id="planning-root"></div>':isDevelopment()?'<div id="development-root"></div>':detail(active)}`:list()}</main><footer class="page-footer"><span>Agent Desk <span class="muted">/</span> 프로젝트 · 기획 · 개발·검토 <small class="app-version">v0.9.5</small></span><a href="/download.html">${icon('download')} Windows 다운로드</a><button data-action="storage-info">${icon('info')}다른 PC에서 이어하기</button></footer></div>`;
}
function list() {
  const projects=selectProjects(state.projects,{query,filter,sort});
  const total=state.projects.filter(p=>!p.archived).length;
  const title=filter==='archive'?'보관한 프로젝트':filter==='pinned'?'즐겨찾는 프로젝트':'프로젝트';
  return `<div class="page-heading"><div><div class="eyebrow">MAKE ROOM FOR YOUR NEXT IDEA</div><h1>${title}<span class="title-dot">.</span></h1><p>함께 일할 에이전트들을 위한, 작업의 시작점.</p></div><button class="button primary" data-action="new">${icon('plus')}새 프로젝트</button></div>
    ${!total&&filter==='all'&&!query?welcome():''}
    <div class="list-toolbar"><div class="list-title">${filter==='archive'?'보관함':filter==='pinned'?'즐겨찾기':'내 프로젝트'}<span>${projects.length}</span></div><div class="list-controls"><div class="search">${icon('search')}<input id="search" aria-label="프로젝트 검색" placeholder="프로젝트 검색" value="${esc(query)}"><kbd>/</kbd></div><label class="sr-only" for="sort">프로젝트 정렬</label><select id="sort"><option value="recent" ${sort==='recent'?'selected':''}>최근 사용순</option><option value="name" ${sort==='name'?'selected':''}>이름순</option></select><button class="button subtle import-button" data-action="import">${icon('upload')}가져오기</button></div></div>
    <div id="project-grid" class="project-grid">${projectGrid(projects,total)}</div>
    ${total>0?`<div class="list-note">${icon('monitor')}<strong>현재 PC</strong>의 폴더와 Git 저장소 주소를 프로젝트마다 등록할 수 있어요.<button data-action="export-all">전체 프로젝트 백업 ${icon('download')}</button></div>`:''}`;
}
function welcome() {
  return `<section class="welcome"><div class="welcome-copy"><span class="pill">YOUR FIRST WORKSPACE</span><h2>좋은 작업은,<br>잘 준비된 프로젝트에서.</h2><p>프로젝트의 목표와 자료를 한곳에 모으세요.<br>매번 같은 설명을 반복하지 않아도 되도록.</p><div class="welcome-actions"><button class="button primary" data-action="new">첫 프로젝트 등록 ${icon('arrow')}</button><button class="text-button" data-action="example">예시로 둘러보기</button></div></div><div class="workspace-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="floating-tag tag-left">${icon('file')}공통 지침</div><div class="floating-tag tag-right">${icon('link')}참고 자료</div><div class="art-folder"><div class="folder-tab"></div><div class="folder-face">${icon('layers')}<span>PROJECT</span><div class="folder-dots"><i></i><i></i><i></i></div></div></div><div class="art-caption">ONE PROJECT. SHARED CONTEXT.</div></div></section>`;
}
function projectGrid(projects,total) {
  if(!projects.length) {
    if(total===0&&filter==='all'&&!query) return `<div class="onboarding-grid"><div>${icon('folder')}<h3>작업 공간 지정</h3><p>현재 PC의 작업 폴더와<br>Git 저장소 주소를 등록하세요.</p></div><div>${icon('file')}<h3>공통 지침 정리</h3><p>프로젝트의 목적과 작업 원칙을<br>한 번만 정리해 두세요.</p></div><div>${icon('link')}<h3>참고 자료 모으기</h3><p>문서, 이미지, 참고 링크를<br>프로젝트와 함께 보관하세요.</p></div></div>`;
    return `<div class="empty-results">${icon(filter==='archive'?'archive':filter==='pinned'?'star':'search')}<h3>${query?'검색 결과가 없습니다':filter==='archive'?'보관한 프로젝트가 없습니다':'즐겨찾는 프로젝트가 없습니다'}</h3><p>${query?'다른 이름이나 설명으로 검색해 보세요.':filter==='archive'?'잠시 쉬어갈 프로젝트를 보관해 두세요.':'프로젝트 카드의 별을 눌러 추가하세요.'}</p>${query?'<button class="button" data-action="clear-search">검색 초기화</button>':''}</div>`;
  }
  return projects.map(p=>`<article class="project-card"><div class="card-top"><span class="project-icon ${p.color}">${icon('folder')}</span><button class="small-icon pin ${p.pinned?'is-pinned':''}" data-action="pin" data-id="${p.id}" aria-label="${esc(p.name)} 즐겨찾기 ${p.pinned?'해제':'추가'}" aria-pressed="${p.pinned}">${icon('star')}</button><button class="small-icon delete-project" data-action="delete" data-id="${p.id}" aria-label="${esc(p.name)} 프로젝트 삭제">${icon('trash')}</button></div><h2><button data-action="open" data-id="${p.id}">${esc(p.name)}</button></h2><p class="card-description">${esc(p.description||'프로젝트 설명을 추가해 보세요.')}</p><div class="path-chip ${p.paths.current||p.folderNames?.current?'':'missing'}">${icon('monitor')}<span title="${esc(p.paths.current)}">${esc(p.paths.current||(p.folderNames?.current?`선택한 폴더 · ${p.folderNames.current}`:'현재 PC 폴더 미지정'))}</span></div><div class="card-meta"><span>${icon('file')}지침 ${p.instructions?'등록됨':'없음'}</span><span>${icon('link')}자료 ${p.links.length+p.files.length}</span></div><div class="card-bottom"><span>${p.lastOpenedAt?'최근 열기':'등록'} ${formatDate(p.lastOpenedAt||p.createdAt)}</span><button class="card-open" data-action="open" data-id="${p.id}">프로젝트 열기 ${icon('arrow')}</button></div></article>`).join('') + (filter==='archive'?'':`<button class="new-card" data-action="new"><span>${icon('plus')}</span><strong>새 프로젝트</strong><small>다음 아이디어를 위한 공간</small></button>`);
}
function detail(p) {
  return `<button class="back-link" data-action="list">${icon('back')}프로젝트 목록</button><div class="detail-heading"><span class="project-icon large ${p.color}">${icon('folder')}</span><div><div class="eyebrow">PROJECT OVERVIEW ${p.archived?'· 보관됨':''}</div><h1>${esc(p.name)}</h1><p>${esc(p.description||'프로젝트 설명이 아직 없습니다.')}</p></div><button class="button" data-action="edit" data-id="${p.id}">${icon('edit')}프로젝트 수정</button></div>
    <div class="steps"><div class="current"><b>01</b>프로젝트 선택${icon('check')}</div><div><b>02</b>기획 보드</div><div><b>03</b>업무 분담</div><div><b>04</b>실행 · 검토</div></div>
    <div class="detail-grid"><div class="detail-main"><section class="panel"><div class="panel-title"><h2>${icon('file')}공통 지침</h2><button class="text-button" data-action="edit" data-id="${p.id}">${p.instructions?'수정':'추가'} ${icon('plus')}</button></div>${p.instructions?`<p class="pre-wrap instructions">${esc(p.instructions)}</p>`:'<div class="section-empty">에이전트가 함께 참고할 작업 원칙을 적어 주세요.<br><span>예: 사용하는 언어, 코드 규칙, 결과물 형식</span></div>'}</section>
    <section class="panel"><div class="panel-title"><h2>${icon('link')}참고 자료<span class="count">${p.links.length+p.files.length}</span></h2><button class="text-button" data-action="edit" data-id="${p.id}">자료 관리 ${icon('plus')}</button></div>${p.links.length||p.files.length?`<div class="reference-list">${p.links.map(l=>`<a class="reference" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${icon('link')}<div><strong>${esc(l.name)}</strong><small>${esc(l.url)}</small></div>${icon('arrow')}</a>`).join('')}${p.files.map(f=>`<button class="reference" data-action="download-file" data-id="${p.id}" data-file="${f.id}">${icon('file')}<div><strong>${esc(f.name)}</strong><small>${bytes(f.size)} · 저장된 파일</small></div>${icon('download')}</button>`).join('')}</div>`:'<div class="section-empty">아직 등록한 참고 자료가 없습니다.<br><span>명세, 이미지, 문서 링크를 함께 보관할 수 있어요.</span></div>'}</section>
    <section class="next-step"><div class="next-icon">${icon('layers')}</div><div><span class="eyebrow">PLAN YOUR NEXT MOVE</span><h2>아이디어를 기획으로 연결하세요.</h2><p>노드를 추가하고 편집하며 목표를 구체화하세요.<br>에이전트의 제안을 비교하고 하나의 기획으로 모을 수 있어요.</p><button class="button primary" data-action="planning" data-id="${p.id}">기획 보드 ${p.planning?'이어가기':'시작하기'} ${icon('arrow')}</button></div></section></div>
    <aside class="detail-side"><section class="panel folder-panel"><div class="panel-title"><h2>${icon('monitor')}작업 폴더 · Git 저장소</h2></div><div class="pc-path current-pc"><div>${icon('monitor')}<strong>현재 PC</strong></div><code>${esc(p.paths.current||p.folderNames?.current||'폴더 미지정')}</code>${p.paths.current?'<small>전체 경로 등록됨</small>':p.folderNames?.current?'<small>선택한 폴더 · 전체 경로 미입력</small>':''}</div><div class="pc-path"><div>${icon('link')}<strong>Git 저장소 주소</strong></div><code>${p.gitUrl&&/^https?:\/\//.test(p.gitUrl)?`<a href="${esc(p.gitUrl)}" target="_blank" rel="noopener noreferrer">${esc(p.gitUrl)}</a>`:esc(p.gitUrl||'저장소 미등록')}</code></div><button class="button full" data-action="edit" data-id="${p.id}">${icon('folder')}폴더 · Git 주소 설정</button><p class="helper">폴더는 지금 사용하는 PC의 위치입니다. 다른 PC에서는 그 PC의 폴더를 지정하세요.</p></section>
    <section class="panel project-info"><h2>프로젝트 정보</h2><dl><div><dt>등록일</dt><dd>${formatDate(p.createdAt)}</dd></div><div><dt>마지막 수정</dt><dd>${formatDate(p.updatedAt)}</dd></div><div><dt>저장 위치</dt><dd>이 브라우저</dd></div></dl><button class="text-button" data-action="export-one" data-id="${p.id}">${icon('download')}프로젝트·기획 백업</button><button class="text-button" data-action="archive" data-id="${p.id}">${icon(p.archived?'restore':'archive')}${p.archived?'프로젝트 복원':'보관함으로 이동'}</button><button class="text-button delete-project" data-action="delete" data-id="${p.id}">${icon('trash')}프로젝트 삭제</button></section></aside></div>`;
}
function render(){
  planner?.destroy();planner=null;developmentView?.destroy();developmentView=null;
  $('#app').innerHTML=shell();
  const project=activeProject();
  if(project&&isPlanning())planner=mountPlanner($('#planning-root'),{
    project,revision:state.revision,toast,icon,exportProject:()=>exportProjects([state.projects.find(p=>p.id===project.id)]),
    save:async(planning,expectedRevision)=>{
      if(!state.projects.some(p=>p.id===project.id))throw new Error('프로젝트가 삭제되었습니다. 목록으로 돌아가 주세요.');
      await commit(state.projects.map(p=>p.id===project.id?{...p,planning,updatedAt:new Date().toISOString()}:p),expectedRevision,[],false);
      return state.revision;
    }
  });
  if(project&&isDevelopment())developmentView=mountDevelopment($('#development-root'),{
    project,revision:state.revision,toast,icon,exportProject:()=>exportProjects([state.projects.find(p=>p.id===project.id)]),
    goPlanning:()=>{if(developmentView&&!developmentView.canLeave())return;history.pushState(null,'',`#${project.id}/planning`);render();},
    save:async(development,expectedRevision)=>{
      if(!state.projects.some(p=>p.id===project.id))throw new Error('프로젝트가 삭제되었습니다. 목록으로 돌아가 주세요.');
      await commit(state.projects.map(p=>p.id===project.id?{...p,development,updatedAt:new Date().toISOString()}:p),expectedRevision,[],false);
      return state.revision;
    }
  });
}

function openDialog(content) {
  dialogOrigin=document.activeElement;
  $('#dialog-root').innerHTML=`<dialog class="dialog">${content}</dialog>`;
  const dialog=$('dialog');dialog.showModal();document.body.classList.add('dialog-open');
  dialog.addEventListener('close',()=>{document.body.classList.remove('dialog-open');dialogOrigin?.focus();});
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
}
function closeDialog(){if(busy)return;$('dialog')?.close();$('#dialog-root').innerHTML='';render();}
function formError(message){const error=$('#form-error');if(error){error.textContent=message;error.hidden=false;error.focus();}else toast(message);}
function openEditor(id) {
  editing=state.projects.find(p=>p.id===id)||null;dialogRevision=state.revision;pendingFiles=[...(editing?.files||[])];
  pendingFolderNames={current:'',...editing?.folderNames};pendingHandles={};
  const p=editing||{name:'',description:'',instructions:'',paths:{current:''},gitUrl:'',links:[],color:'mint'};
  openDialog(`<form id="project-form"><div class="dialog-header"><div><span class="eyebrow">${editing?'PROJECT SETTINGS':'A NEW BEGINNING'}</span><h2>${editing?'프로젝트 수정':'새 프로젝트'}</h2><p>함께 작업할 에이전트들을 위한 기본 정보를 준비하세요.</p></div><button type="button" class="small-icon" data-action="close-dialog" aria-label="닫기">${icon('close')}</button></div>
    <div class="dialog-body"><div id="form-error" class="form-error" role="alert" tabindex="-1" hidden></div><div class="form-section"><div class="section-number">01</div><div class="section-fields"><h3>프로젝트 기본 정보</h3><label for="project-name">프로젝트 이름 <span class="required">*</span></label><input id="project-name" name="name" required maxlength="80" placeholder="예: 에이전트 통합 대시보드" value="${esc(p.name)}" autofocus><label for="project-description">프로젝트 설명 <span class="optional">선택</span></label><textarea id="project-description" name="description" rows="2" maxlength="1000" placeholder="어떤 프로젝트인가요? 목적과 주요 기능을 간단히 적어 주세요.">${esc(p.description)}</textarea><div class="color-row"><span>프로젝트 색상</span>${COLORS.map((c,i)=>`<label class="color-option ${c}"><input type="radio" name="color" value="${c}" ${p.color===c?'checked':''} aria-label="${['민트','파랑','주황','보라','분홍'][i]}"><span>${icon('check')}</span></label>`).join('')}</div></div></div>
    <div class="form-section"><div class="section-number">02</div><div class="section-fields"><h3>작업 폴더 · Git 저장소</h3><p class="field-description">현재 PC에서 작업할 폴더와 프로젝트의 Git 저장소 주소를 등록하세요.</p>${folderField(p)}<label for="git-url">Git 저장소 주소 <span class="optional">선택</span></label><div class="input-icon">${icon('link')}<input id="git-url" name="git-url" maxlength="2048" placeholder="https://github.com/계정/저장소" value="${esc(p.gitUrl)}" spellcheck="false" autocapitalize="off" autocomplete="off"></div><p class="helper">HTTPS 또는 SSH 주소를 입력할 수 있어요. 주소를 저장하는 단계이며, 복제·동기화는 실행하지 않습니다.</p></div></div>
    <div class="form-section"><div class="section-number">03</div><div class="section-fields"><h3>공통 지침 <span class="optional">선택</span></h3><p class="field-description">모든 에이전트가 참고할 프로젝트의 작업 원칙입니다.</p><label class="sr-only" for="project-instructions">공통 지침</label><textarea id="project-instructions" name="instructions" rows="4" maxlength="12000" placeholder="예: 설명과 결과 보고서는 한국어로 작성해 주세요.\n기존 코드 스타일을 유지하고, 변경한 내용과 검증 결과를 함께 정리해 주세요.">${esc(p.instructions)}</textarea></div></div>
    <div class="form-section"><div class="section-number">04</div><div class="section-fields"><h3>참고 자료 <span class="optional">선택</span></h3><div id="link-rows">${(p.links.length?p.links:[{name:'',url:''}]).map(linkRow).join('')}</div><button type="button" class="text-button add-link" data-action="add-link">${icon('plus')}참고 링크 추가</button><label class="file-drop" for="reference-files">${icon('upload')}<strong>참고 파일 선택</strong><span>문서 · 이미지 등 / 파일당 2MB, 총 10MB</span></label><input id="reference-files" type="file" multiple class="sr-only"><div id="pending-files"></div></div></div></div>
    <div class="dialog-footer"><span>${icon('check')}이 브라우저에 저장됩니다</span><button type="button" class="button" data-action="close-dialog">취소</button><button type="submit" class="button primary" id="save-project">${editing?'변경 사항 저장':'등록하고 프로젝트 열기'}${icon('arrow')}</button></div></form>`);
  renderPendingFiles();
}
function folderField(p) {
  return `<label for="path-current">현재 PC <span class="optional">작업 폴더</span></label><div class="input-icon folder-input">${icon('folder')}<input id="path-current" name="path-current" maxlength="1024" placeholder="전체 경로를 입력하거나 오른쪽 버튼으로 선택하세요" value="${esc(p.paths.current)}" spellcheck="false" aria-describedby="folder-selection-current folder-picker-help"><button type="button" class="folder-picker-button" data-action="pick-folder" data-profile="current" aria-label="현재 PC 폴더 선택" title="폴더 선택">${icon('folder')}<span>선택</span></button></div><p class="folder-selection" id="folder-selection-current" role="status">${pendingFolderNames.current?`선택한 폴더: ${esc(pendingFolderNames.current)}`:''}</p><p class="helper" id="folder-picker-help">${nativePicker?'오른쪽 폴더 버튼을 누르면 Windows 폴더 선택창이 열립니다.':'오른쪽 버튼으로 폴더를 선택할 수 있어요. 웹에서는 폴더 이름이 표시되며, 전체 경로는 직접 입력할 수 있습니다.'}</p>`;
}
async function chooseFolder(profile,button) {
  if(busy||profile!=='current')return;
  const input=$(`#path-${profile}`), notice=$(`#folder-selection-${profile}`);
  const oldLabel=button.innerHTML;
  busy=true;button.disabled=true;$('#save-project').disabled=true;button.textContent='선택 중…';
  try {
    if(nativePicker) {
      const response=await fetch('/api/pick-folder',{method:'POST',headers:{'X-Agent-Desk':'folder-picker'},signal:AbortSignal.timeout(310000)});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'폴더 선택창을 열지 못했습니다.');
      if(result.cancelled)return;
      input.value=result.path;pendingFolderNames[profile]=result.name;pendingHandles[profile]=null;
      notice.textContent=`선택한 폴더: ${result.name} · 전체 경로가 입력되었습니다.`;
    } else {
      if(typeof window.showDirectoryPicker!=='function') throw new Error('이 브라우저에서는 폴더 선택을 지원하지 않습니다. Edge 또는 Chrome에서 페이지를 열거나, 경로를 직접 입력해 주세요.');
      // The picker must be called directly from the click, before any await.
      const handle=await window.showDirectoryPicker({id:`agent-desk-${profile}`,mode:'read'});
      pendingHandles[profile]=handle;pendingFolderNames[profile]=handle.name;input.value='';
      notice.textContent=`선택한 폴더: ${handle.name} · 웹에서는 전체 경로를 알 수 없어 폴더 이름만 표시합니다.`;
    }
    notice.classList.add('selected-folder');
  } catch(error) {
    if(error.name==='AbortError')return;
    formError(error.name==='SecurityError'?'앱 내 브라우저에서 폴더 선택이 제한되었습니다. Edge 또는 Chrome에서 이 페이지를 열어 주세요.':error.message);
  } finally {busy=false;button.disabled=false;button.innerHTML=oldLabel;const save=$('#save-project');if(save)save.disabled=false;}
}
function confirmDelete(project) {
  deleting=project.id;deleteRevision=state.revision;
  openDialog(`<div class="dialog-header"><div><span class="eyebrow">DELETE PROJECT</span><h2 id="delete-title">정말 삭제하겠습니까?</h2></div><button class="small-icon" data-action="close-dialog" aria-label="닫기">${icon('close')}</button></div><div class="dialog-body compact"><div id="form-error" class="form-error" role="alert" tabindex="-1" hidden></div><p><strong>${esc(project.name)}</strong>의 등록 정보, 공통 지침, 저장된 참고 자료를 이 브라우저에서 삭제합니다.</p><p><strong>실제 작업 폴더와 원본 파일은 삭제하지 않습니다.</strong></p><p class="helper">삭제한 등록 정보는 복원할 수 없습니다. 나중에 다시 사용하려면 보관함으로 이동하거나 설정을 내보내 주세요.</p></div><div class="dialog-footer"><button class="button" data-action="close-dialog" autofocus>No</button><button class="button danger" data-action="confirm-delete">Yes</button></div>`);
}
function linkRow(link={name:'',url:''}) {return `<div class="link-row"><input class="link-name" aria-label="참고 링크 이름" maxlength="120" placeholder="링크 이름" value="${esc(link.name)}"><input class="link-url" type="url" aria-label="참고 링크 주소" maxlength="2048" placeholder="https://" value="${esc(link.url)}"><button class="small-icon" type="button" data-action="remove-link" aria-label="참고 링크 삭제">${icon('close')}</button></div>`;}
function renderPendingFiles(){const target=$('#pending-files');if(target)target.innerHTML=pendingFiles.map(f=>`<div class="pending-file">${icon('file')}<span>${esc(f.name)}<small>${bytes(f.size)}</small></span><button type="button" class="small-icon" data-action="remove-file" data-id="${f.id}" aria-label="${esc(f.name)} 첨부 제거">${icon('close')}</button></div>`).join('');}
async function saveEditor(event) {
  event.preventDefault();if(busy)return;busy=true;$('#save-project').disabled=true;
  try {
    const form=event.target;
    const data=new FormData(form);
    const project=validateProject({...editing,name:data.get('name'),description:data.get('description'),instructions:data.get('instructions'),color:data.get('color'),paths:{...editing?.paths,current:data.get('path-current')},gitUrl:data.get('git-url'),links:[...form.querySelectorAll('.link-row')].map(row=>({name:$('.link-name',row).value,url:$('.link-url',row).value})),files:pendingFiles,folderNames:pendingFolderNames,updatedAt:new Date().toISOString()});
    if(!editing&&state.projects.length>=MAX_PROJECTS)throw new Error(`프로젝트는 최대 ${MAX_PROJECTS}개까지 등록할 수 있습니다.`);
    if(state.projects.some(p=>p.id!==project.id&&p.name.toLocaleLowerCase()===project.name.toLocaleLowerCase()))throw new Error('같은 이름의 프로젝트가 있습니다. 구분할 수 있는 이름을 입력해 주세요.');
    await commit(editing?state.projects.map(p=>p.id===project.id?project:p):[...state.projects,project],dialogRevision,Object.entries(pendingHandles).map(([profile,handle])=>({projectId:project.id,profile,handle})));
    busy=false;closeDialog();await openProject(project.id);toast(editing?'프로젝트 정보를 저장했습니다.':'새 프로젝트를 등록했습니다.');
  }catch(error){formError(error.message);}finally{busy=false;const btn=$('#save-project');if(btn)btn.disabled=false;}
}
async function attachFiles(input) {
  busy=true;$('#save-project').disabled=true;
  try {
    const additions=[];
    for(const file of input.files) {
      if(file.size>MAX_FILE_BYTES)throw new Error(`${file.name}: 파일당 2MB까지 첨부할 수 있습니다.`);
      const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=()=>reject(new Error('파일을 읽지 못했습니다.'));r.readAsDataURL(file);});
      additions.push({id:crypto.randomUUID(),name:file.name,size:file.size,data});
    }
    const candidate=[...pendingFiles,...additions];
    validateProject({name:'검증',files:candidate});pendingFiles=candidate;renderPendingFiles();
  }catch(error){formError(error.message);}finally{busy=false;input.value='';const btn=$('#save-project');if(btn)btn.disabled=false;}
}
function download(data,name,type='application/json') {
  const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
function exportProjects(projects) {download(JSON.stringify({format:'agent-desk-projects',version:1,exportedAt:new Date().toISOString(),projects},null,2),`agent-desk-projects-${new Date().toISOString().slice(0,10)}.json`);toast('프로젝트·노드·질문·답변·확정 기획·첨부를 백업했습니다.');}
async function prepareImport(input) {
  try {
    const file=input.files[0];if(!file)return;
    if(file.size>30*1024*1024)throw new Error('가져오기 파일은 30MB 이하여야 합니다. 프로젝트별로 나누어 내보내 주세요.');
    pendingImport=readBackup(JSON.parse(await file.text()));
    if(!pendingImport.length)throw new Error('파일에 등록된 프로젝트가 없습니다.');
    openDialog(`<div class="dialog-header"><div><span class="eyebrow">IMPORT PROJECTS</span><h2>프로젝트 가져오기</h2></div><button class="small-icon" data-action="close-dialog" aria-label="닫기">${icon('close')}</button></div><div class="dialog-body compact"><p><strong>${pendingImport.length}개</strong>의 프로젝트와 참고 자료를 가져옵니다.</p><p class="helper">기존 프로젝트는 유지됩니다. 이름이 겹치면 새 이름으로 추가합니다.<br>가져온 후 이 PC의 폴더 경로를 확인해 주세요.</p><div class="import-preview">${pendingImport.map(p=>`<div>${icon('folder')}${esc(p.name)}<span>${p.files.length+p.links.length}개 자료</span></div>`).join('')}</div></div><div class="dialog-footer"><button class="button" data-action="close-dialog">취소</button><button class="button primary" data-action="confirm-import">가져오기 ${icon('arrow')}</button></div>`);
  }catch(error){toast(error instanceof SyntaxError?'올바른 JSON 백업 파일을 선택해 주세요.':error.message);}finally{input.value='';}
}
async function example() {
  const old=state.projects.find(p=>p.name==='예시 · 에이전트 통합 대시보드');if(old)return openProject(old.id);
  const p=validateProject({name:'예시 · 에이전트 통합 대시보드',description:'Codex, Claude, Antigravity의 프로젝트와 업무를 한곳에서 관리하는 개인 워크스페이스.',instructions:'설명과 결과 보고서는 한국어로 작성합니다.\n작업 전 관련 코드를 확인하고 기존 구조를 유지합니다.\n변경 내용과 검증 결과, 남은 문제를 함께 정리합니다.',paths:{current:'C:\\Projects\\agent-desk'},gitUrl:'https://github.com/MyungRag/Codex_Claude_AGY',color:'mint',links:[]});
  await commit([...state.projects,p]);await openProject(p.id);toast('예시 프로젝트입니다. 폴더 경로는 실제 환경에 맞게 수정해 주세요.');
}
document.addEventListener('click',async event=>{
  const el=event.target.closest('[data-action]');if(!el)return;event.preventDefault();
  if((planner&&!planner.canLeave())||(developmentView&&!developmentView.canLeave()))return;
  const action=el.dataset.action,id=el.dataset.id,p=state.projects.find(p=>p.id===id);
  try {
    if(action==='agents')await openConnections();
    else if(action==='list')goList();
    else if(action==='pinned')goList('pinned');
    else if(action==='archive-list')goList('archive');
    else if(action==='new')openEditor();
    else if(action==='edit')openEditor(id);
    else if(['planning','overview','development'].includes(action)){history.pushState(null,'',`#${id}${action==='overview'?'':'/'+action}`);render();}
    else if(action==='open')await openProject(id);
    else if(action==='pick-folder')await chooseFolder(el.dataset.profile,el);
    else if(action==='delete'&&p)confirmDelete(p);
    else if(action==='confirm-delete'&&deleting&&!busy){
      busy=true;el.disabled=true;
      try {
        const deletedId=deleting;
        await commit(state.projects.filter(item=>item.id!==deletedId),deleteRevision);
        if(location.hash.slice(1).split('/')[0]===deletedId)history.replaceState(null,'',location.pathname);
        if(readPreference('agent-desk-last-project','')===deletedId)preference('agent-desk-last-project','');
        deleting=null;busy=false;closeDialog();toast('프로젝트 등록 정보를 삭제했습니다.');
      } finally {busy=false;el.disabled=false;}
    }
    else if(action==='pin'&&p)await commit(state.projects.map(item=>item.id===id?{...item,pinned:!item.pinned}:item));
    else if(action==='archive'&&p){await commit(state.projects.map(item=>item.id===id?{...item,archived:!item.archived}:item));goList(p.archived?'all':'archive');toast(p.archived?'프로젝트를 복원했습니다.':'보관함으로 이동했습니다. 언제든 복원할 수 있습니다.');}
    else if(action==='close-dialog')closeDialog();
    else if(action==='add-link'){if(document.querySelectorAll('.link-row').length>=20)throw new Error('링크는 20개까지 추가할 수 있습니다.');$('#link-rows').insertAdjacentHTML('beforeend',linkRow());$('#link-rows').lastElementChild.querySelector('input').focus();}
    else if(action==='remove-link')el.closest('.link-row').remove();
    else if(action==='remove-file'){pendingFiles=pendingFiles.filter(f=>f.id!==id);renderPendingFiles();}
    else if(action==='download-file'&&p){const f=p.files.find(f=>f.id===el.dataset.file);if(f){const data=Uint8Array.from(atob(f.data),c=>c.charCodeAt(0));download(data,f.name,'application/octet-stream');}}
    else if(action==='export-one'&&p)exportProjects([p]);
    else if(action==='export-all')exportProjects(state.projects);
    else if(action==='import')$('#import-input').click();
    else if(action==='confirm-import'){await commit(importCopies(state.projects,pendingImport));closeDialog();goList();toast('프로젝트를 가져왔습니다.');pendingImport=null;}
    else if(action==='example')await example();
    else if(action==='clear-search'){query='';render();$('#search')?.focus();}
    else if(action==='storage-info')openDialog(`<div class="dialog-header"><div><span class="eyebrow">CONTINUE ON ANOTHER PC</span><h2>회사·집에서 이어하기</h2></div><button class="small-icon" data-action="close-dialog" aria-label="닫기">${icon('close')}</button></div><div class="dialog-body compact"><p>프로그램 파일과 기획 데이터는 따로 옮깁니다. 프로젝트·노드·질문·답변·확정 기획·업무 분담·첨부는 <strong>현재 주소의 이 브라우저</strong>에 저장됩니다.</p><ol><li>이 PC에서 <strong>전체 프로젝트 백업</strong>으로 JSON 파일을 저장하세요.</li><li>회사 PC에 Windows 실행판을 내려받아 <strong>start-windows.cmd</strong>를 실행하세요.</li><li>프로젝트 목록의 <strong>가져오기</strong>에서 백업 JSON을 선택하세요. 기존 프로젝트를 덮어쓰지 않고 복사본으로 가져옵니다.</li><li>프로젝트 정보에서 <strong>현재 PC 폴더</strong>를 다시 선택하고, 이 PC의 CLI 로그인과 AI 연결을 확인하세요.</li><li>집으로 돌아오기 전에도 최신 기획을 백업하세요. 두 PC에서 각각 변경한 기획을 자동 병합하지 않습니다.</li></ol><p><strong>Git</strong>은 프로그램 코드의 변경 이력을 관리하고, <strong>GitHub</strong>는 코드를 보관하는 원격 저장소입니다. GitHub에 코드를 올리는 것은 <strong>push</strong>, 처음 받는 것은 <strong>clone</strong>, 이후 변경분을 받는 것은 <strong>pull</strong>이라고 합니다.</p><p class="helper">Git 주소 등록만으로 코드나 기획이 동기화되지 않습니다. 브라우저 데이터를 지우기 전에는 백업하세요. 폴더 접근 권한·CLI 로그인·모델 설정·임시 AI 응답·토큰 집계는 이 백업에 포함되지 않습니다. 진행 중인 AI 응답은 먼저 반영해 주세요.</p></div><div class="dialog-footer"><button class="button" data-action="export-all">전체 프로젝트 백업</button><a class="button" href="/download.html" target="_blank" rel="noopener">Windows 다운로드</a><button class="button primary" data-action="close-dialog">확인</button></div>`);
  }catch(error){if($('dialog[open]'))formError(error.message);else toast(error.message);}
});
document.addEventListener('submit',event=>{if(event.target.id==='project-form')saveEditor(event);});
document.addEventListener('change',event=>{
  if(event.target.id==='sort'){sort=event.target.value;render();}
  else if(event.target.id==='reference-files')attachFiles(event.target);
  else if(event.target.id==='import-input')prepareImport(event.target);
});
document.addEventListener('input',event=>{
  if(event.target.id.startsWith('path-')){
    const profile=event.target.id.slice(5);if(profile==='current'){pendingFolderNames[profile]='';pendingHandles[profile]=null;const notice=$(`#folder-selection-${profile}`);if(notice)notice.textContent='';}
  }
  if(event.target.id==='search'){query=event.target.value;const projects=selectProjects(state.projects,{query,filter,sort});$('#project-grid').innerHTML=projectGrid(projects,state.projects.filter(p=>!p.archived).length);$('.list-title span').textContent=projects.length;}
});
document.addEventListener('keydown',event=>{if(event.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&!$('dialog[open]')){event.preventDefault();$('#search')?.focus();}});
function routeChanged(){if(planner&&!planner.canLeave()){history.replaceState(null,'',`#${planner.project.id}/planning`);return;}if(developmentView&&!developmentView.canLeave()){history.replaceState(null,'',`#${developmentView.project.id}/development`);return;}render();}
window.addEventListener('popstate',routeChanged);
window.addEventListener('hashchange',routeChanged);
channel?.addEventListener('message',async()=>{state=await readState();if(planner)planner.notifyExternal();else if(developmentView)developmentView.notifyExternal();else if(!$('dialog[open]'))render();});
try {await openStore(readPreference('agent-desk-pc','office'));state=await readState();render();}
catch(error){$('#app').innerHTML=`<div class="fatal"><h1>저장 공간을 열지 못했습니다.</h1><p>${esc(error.message)}</p><p>다른 일반 브라우저 창에서 다시 시도해 주세요.</p><button class="button" onclick="location.reload()">다시 시도</button></div>`;}
