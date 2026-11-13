import {validateDevelopment} from './development-core.js?v=0.9.3';
import {validatePlan} from './planning-model.js?v=0.9.3';
export const COLORS = ['mint', 'blue', 'orange', 'violet', 'pink'];
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const MAX_PROJECTS = 200;
const text = (v, max, label) => { if(typeof v !== 'string' || v.length > max) throw new Error(`${label} 형식을 확인해 주세요.`); return v.trim(); };
export const isAbsolutePath = value => /^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/.test(value) && !/[\x00-\x1f]/.test(value);
export function safeUrl(value) {
  const raw = text(value, 2048, '링크');
  if (!raw) return '';
  try { const u = new URL(raw); if (['https:', 'http:'].includes(u.protocol) && !u.username && !u.password) return u.href; } catch {}
  throw new Error('링크는 http:// 또는 https://로 시작해야 합니다.');
}
export function gitRepositoryUrl(value) {
  const raw = text(value, 2048, 'Git 저장소 주소');
  if (!raw) return '';
  if (!/[\s\x00-\x1f]/.test(raw)) {
    try {
      const url = new URL(raw);
      if (['https:', 'http:', 'ssh:'].includes(url.protocol) && url.hostname && url.pathname.length > 1 && !url.password && !url.search && !url.hash && (url.protocol === 'ssh:' || !url.username)) return raw;
    } catch {}
    if (/^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(raw)) return raw;
  }
  throw new Error('Git 저장소 주소를 확인해 주세요. 예: https://github.com/계정/저장소 또는 git@github.com:계정/저장소.git');
}
// Keep legacy locations in backups; expose only this browser's current location.
export function legacyLocationProfile(input, preferred='office') {
  return [preferred === 'home' ? 'home' : 'office', preferred === 'home' ? 'office' : 'home'].find(key => input.paths?.[key] || input.folderNames?.[key]) || 'office';
}
export function migrateProjectLocation(input, preferred='office') {
  const profile = legacyLocationProfile(input, preferred);
  const alreadyCurrent = Object.hasOwn(input.paths || {}, 'current') || Object.hasOwn(input.folderNames || {}, 'current');
  return {...input, paths:{...input.paths,current:alreadyCurrent ? input.paths?.current || '' : input.paths?.[profile] || ''}, folderNames:{...input.folderNames,current:alreadyCurrent ? input.folderNames?.current || '' : input.folderNames?.[profile] || ''}, gitUrl:input.gitUrl ?? ''};
}
export function validateProject(input) {
  if (!input || typeof input !== 'object') throw new Error('프로젝트 데이터가 올바르지 않습니다.');
  input = migrateProjectLocation(input);
  const name = text(input.name, 80, '프로젝트 이름');
  if (!name) throw new Error('프로젝트 이름을 입력해 주세요.');
  const paths = {}, folderNames = {};
  for (const key of ['current','office','home']) {
    if(key !== 'current' && !Object.hasOwn(input.paths || {},key) && !Object.hasOwn(input.folderNames || {},key)) continue;
    const path = text(input.paths?.[key] ?? '', 1024, '작업 폴더');
    if (path && !isAbsolutePath(path)) throw new Error('작업 폴더에 전체 경로를 입력해 주세요. 예: C:\\Projects\\my-app');
    paths[key] = path;
    folderNames[key] = text(input.folderNames?.[key] ?? '', 255, '폴더 이름');
  }
  if (!Array.isArray(input.links ?? []) || (input.links?.length ?? 0) > 20) throw new Error('참고 링크는 20개까지 등록할 수 있습니다.');
  const links = (input.links ?? []).map(link => ({name:text(link.name || '참고 링크', 120, '링크 이름'), url:safeUrl(link.url)})).filter(link=>link.url);
  const files = input.files ?? [];
  if (!Array.isArray(files) || files.length > 20) throw new Error('참고 파일은 20개까지 등록할 수 있습니다.');
  let size = 0;
  const checkedFiles = files.map(file => {
    const name = text(file.name, 255, '파일 이름');
    if (!name || typeof file.data !== 'string' || file.data.length > Math.ceil(MAX_FILE_BYTES/3)*4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) throw new Error('첨부 파일 데이터가 올바르지 않거나 2MB를 초과합니다.');
    const actualSize = file.data.length * 3 / 4 - (file.data.endsWith('==') ? 2 : file.data.endsWith('=') ? 1 : 0);
    if (actualSize > MAX_FILE_BYTES) throw new Error('파일은 개별 2MB까지 첨부할 수 있습니다.');
    size += actualSize;
    return {id:typeof file.id === 'string' && /^[\w-]{1,80}$/.test(file.id) ? file.id : crypto.randomUUID(),name,size:actualSize,data:file.data};
  });
  if(size > MAX_TOTAL_BYTES) throw new Error('프로젝트별 첨부 파일은 총 10MB까지 저장할 수 있습니다.');
  const date = (v, fallback) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : fallback;
  const now = new Date().toISOString();
  return {
    id: typeof input.id === 'string' && /^[\w-]{1,80}$/.test(input.id) ? input.id : crypto.randomUUID(),
    name, description:text(input.description ?? '', 1000, '프로젝트 설명'), instructions:text(input.instructions ?? '', 12000, '공통 지침'),
    planning:validatePlan(input.planning), development:validateDevelopment(input.development),
    paths, folderNames, gitUrl:gitRepositoryUrl(input.gitUrl), links, files:checkedFiles, color:COLORS.includes(input.color) ? input.color : 'mint', pinned:input.pinned === true, archived:input.archived === true,
    createdAt:date(input.createdAt,now), updatedAt:date(input.updatedAt,now), lastOpenedAt:date(input.lastOpenedAt,null)
  };
}
export function readBackup(raw) {
  if (!raw || raw.format !== 'agent-desk-projects' || raw.version !== 1 || !Array.isArray(raw.projects) || raw.projects.length > MAX_PROJECTS) throw new Error('Agent Desk 프로젝트 백업 파일이 아닙니다.');
  return raw.projects.map(validateProject);
}
export function importCopies(existing, incoming) {
  if(existing.length + incoming.length > MAX_PROJECTS) throw new Error(`프로젝트는 최대 ${MAX_PROJECTS}개까지 저장할 수 있습니다.`);
  const result = [...existing];
  for(const p of incoming) {
    let name = p.name;
    for(let n=1;result.some(item=>item.name.toLocaleLowerCase()===name.toLocaleLowerCase());n++) name = `${p.name.slice(0,60)} (가져옴 ${n})`;
    result.push({...p,id:crypto.randomUUID(),name,lastOpenedAt:null});
  }
  return result;
}
export function selectProjects(projects, {query='', filter='all', sort='recent'} = {}) {
  const normalized = query.toLocaleLowerCase().trim();
  return projects.filter(p => (filter === 'archive' ? p.archived : !p.archived) && (filter !== 'pinned' || p.pinned) && `${p.name} ${p.description} ${p.paths.current} ${p.folderNames?.current || ''} ${p.gitUrl || ''}`.toLocaleLowerCase().includes(normalized)).sort((a,b) => {
    if(sort === 'name') return a.name.localeCompare(b.name,'ko');
    if(a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastOpenedAt || b.updatedAt).localeCompare(a.lastOpenedAt || a.updatedAt);
  });
}
