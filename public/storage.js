import {migrateProjectLocation,legacyLocationProfile} from './model.js?v=0.9.5';
let database;
export async function openStore(legacyProfile='office') {
  database = await new Promise((resolve,reject) => {
    const req = indexedDB.open('agent-desk-projects',3);
    req.onupgradeneeded = () => {
      for(const name of ['workspace','folders']) if(!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      const workspace=req.transaction.objectStore('workspace'), folders=req.transaction.objectStore('folders');
      const previous=workspace.get('state');
      previous.onsuccess=()=>{
        if(!previous.result)return;
        const state=previous.result;
        for(const project of state.projects) {
          if(Object.hasOwn(project.paths || {},'current') || Object.hasOwn(project.folderNames || {},'current'))continue;
          const handle=folders.get(`${project.id}:${legacyLocationProfile(project,legacyProfile)}`);
          handle.onsuccess=()=>{if(handle.result)folders.put(handle.result,`${project.id}:current`);};
        }
        workspace.put({...state,projects:state.projects.map(p=>migrateProjectLocation(p,legacyProfile)),revision:(state.revision || 0)+1},'state');
      };
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error('브라우저 저장 공간을 열 수 없습니다. 일반 브라우저 창에서 다시 열어 주세요.'));
    req.onblocked = () => reject(new Error('다른 Agent Desk 탭을 닫고 다시 열어 주세요.'));
  });
  database.onversionchange = () => database.close();
}
export function readState() {
  return new Promise((resolve,reject) => {
    const req = database.transaction('workspace').objectStore('workspace').get('state');
    req.onsuccess = () => resolve(req.result || {projects:[],revision:0});
    req.onerror = () => reject(req.error);
  });
}
export function saveState(state, expectedRevision, folderUpdates=[]) {
  return new Promise((resolve,reject) => {
    const tx = database.transaction(['workspace','folders'],'readwrite');
    const store = tx.objectStore('workspace');
    const folders = tx.objectStore('folders');
    const req = store.get('state');
    let conflict = false;
    req.onsuccess = () => {
      if((req.result?.revision || 0) !== expectedRevision) {conflict = true;tx.abort();return;}
      const retained = new Set(state.projects.map(p=>p.id));
      for(const previous of req.result?.projects || []) if(!retained.has(previous.id)) {
        for(const profile of ['current','office','home'])folders.delete(`${previous.id}:${profile}`);
      }
      for(const {projectId,profile,handle} of folderUpdates) {
        if(!retained.has(projectId) || profile !== 'current') continue;
        const key=`${projectId}:${profile}`;
        if(handle) folders.put(handle,key); else folders.delete(key);
      }
      store.put({...state,revision:expectedRevision+1},'state');
    };
    tx.oncomplete = () => resolve({...state,revision:expectedRevision+1});
    tx.onabort = tx.onerror = () => reject(new Error(conflict ? '다른 탭에서 정보가 변경되었습니다. 입력한 내용을 복사한 뒤 창을 닫고 다시 시도해 주세요.' : '저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.'));
  });
}
