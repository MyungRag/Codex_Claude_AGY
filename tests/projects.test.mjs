import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateProject,readBackup,importCopies,selectProjects,isAbsolutePath,migrateProjectLocation,gitRepositoryUrl} from '../public/model.js';

test('legacy paths migrate to current PC without losing Korean names or original locations',()=>{
  const p=validateProject({name:' 회원 관리 ',paths:{office:'C:\\회사 프로젝트\\회원',home:'D:\\개발\\회원'}});
  assert.equal(p.name,'회원 관리');
  assert.equal(p.paths.office,'C:\\회사 프로젝트\\회원');
  assert.equal(p.paths.home,'D:\\개발\\회원');
  assert.equal(validateProject({name:'나중에 경로 지정'}).paths.current,'');
  assert.ok(isAbsolutePath('\\\\server\\share\\project'));
  assert.throws(()=>validateProject({name:'test',paths:{office:'projects/my-app'}}),/전체 경로/);
  assert.throws(()=>validateProject({name:'test',paths:{office:'C:\\project\nother'}}),/전체 경로/);
});
test('backup round trip preserves reference file bytes and shared instructions',()=>{
  const data=Buffer.from('한국어 명세\n<요구사항> 😀');
  const p=validateProject({name:'샘플',instructions:'완료 조건\n테스트 통과',links:[{name:'문서',url:'https://example.com/spec'}],files:[{name:'명세.txt',data:data.toString('base64')}]});
  const restored=readBackup(JSON.parse(JSON.stringify({format:'agent-desk-projects',version:1,projects:[p]})))[0];
  assert.deepEqual(Buffer.from(restored.files[0].data,'base64'),data);
  assert.equal(restored.files[0].size,data.length);
  assert.equal(restored.instructions,p.instructions);
  assert.deepEqual(restored.paths,p.paths);
});
test('importing never overwrites an existing project or its files',()=>{
  const original=validateProject({name:'원본',instructions:'이 지침 보존'});
  const before=structuredClone(original);
  const imported=importCopies([original],[{...original,instructions:'가져온 지침'}]);
  assert.equal(imported.length,2);
  assert.deepEqual(imported[0],before);
  assert.notEqual(imported[1].id,original.id);
  assert.equal(imported[1].name,'원본 (가져옴 1)');
  assert.equal(imported[1].instructions,'가져온 지침');
});
test('untrusted backup links and oversized attachments are rejected before persistence',()=>{
  for(const url of ['javascript:alert(1)','data:text/html,hello','file:///C:/secret','https://user:secret@example.com'])assert.throws(()=>validateProject({name:'unsafe',links:[{url}]}),/링크/);
  assert.throws(()=>readBackup({version:1,projects:[]}),/백업/);
  assert.throws(()=>validateProject({name:' ',files:[]}),/이름/);
  assert.throws(()=>validateProject({name:'large',files:[{name:'big',data:Buffer.alloc(2*1024*1024+1).toString('base64')}]}),/2MB/);
});
test('archived projects stay out of active/pinned lists and search covers current PC paths',()=>{
  const active=validateProject({name:'살아 있는 프로젝트',pinned:true,paths:{home:'D:\\special-folder'}});
  const archived=validateProject({name:'보관됨',archived:true,pinned:true});
  assert.deepEqual(selectProjects([active,archived],{filter:'pinned'}).map(p=>p.id),[active.id]);
  assert.deepEqual(selectProjects([active,archived],{filter:'archive'}).map(p=>p.id),[archived.id]);
  assert.equal(selectProjects([active,archived],{query:'SPECIAL-folder'})[0].id,active.id);
});
test('browser folder choices retain names without fabricating absolute paths',()=>{
  const p=validateProject({name:'KAF',folderNames:{office:'한글 폴더',home:'집 작업'}});
  assert.equal(p.paths.current,'');assert.equal(p.folderNames.office,'한글 폴더');
  const copy=readBackup({format:'agent-desk-projects',version:1,projects:[p]})[0];
  assert.equal(copy.folderNames.home,'집 작업');
  assert.equal(selectProjects([p],{query:'한글 폴더'}).length,1);
});

test('migration uses the last selected location and never restores a deliberately cleared current folder',()=>{
  const old={name:'KAF',paths:{office:'C:\\Projects\\KAF',home:'D:\\작업\\KAF'},folderNames:{home:'KAF'}};
  const next=migrateProjectLocation(old,'home');
  assert.equal(next.paths.current,old.paths.home);
  assert.equal(next.folderNames.current,'KAF');
  assert.equal(next.paths.office,old.paths.office);
  const cleared=validateProject({...next,paths:{...next.paths,current:''},folderNames:{...next.folderNames,current:''}});
  assert.equal(cleared.paths.current,'');
  assert.equal(readBackup({format:'agent-desk-projects',version:1,projects:[cleared]})[0].paths.current,'');
  assert.equal(migrateProjectLocation({...old,paths:{office:old.paths.office,home:''},folderNames:{}},'home').paths.current,old.paths.office);
});
test('Git addresses support HTTPS and SSH, survive backup and are searchable',()=>{
  for(const url of ['https://github.com/MyungRag/KAF.git','git@github.com:MyungRag/KAF.git','ssh://git@git.example.com:2222/team/KAF.git']) {
    const p=validateProject({name:'project',gitUrl:url,paths:{current:'C:\\작업\\KAF'}});
    assert.equal(p.gitUrl,url);
    assert.equal(readBackup({format:'agent-desk-projects',version:1,projects:[p]})[0].gitUrl,url);
    assert.equal(selectProjects([p],{query:'kaf.git'}).length,1);
  }
  for(const url of ['javascript:alert(1)','file:///C:/KAF','https://user:secret@example.com/repo','ssh://git:secret@example.com/repo','https://github.com/repo?token=secret','git@github.com:my repo.git','just a name']) assert.throws(()=>gitRepositoryUrl(url),/Git/);
  assert.equal(gitRepositoryUrl(''),'');
});
