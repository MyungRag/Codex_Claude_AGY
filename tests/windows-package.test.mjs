import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {createWindowsPackage} from '../scripts/windows-package.mjs';
import {createAppServer} from '../scripts/server.mjs';

function readZip(bytes){
 const end=bytes.length-22;assert.equal(bytes.readUInt32LE(end),0x06054b50);
 const count=bytes.readUInt16LE(end+10),centralStart=bytes.readUInt32LE(end+16),centralSize=bytes.readUInt32LE(end+12);
 assert.equal(centralStart+centralSize,end);assert.equal(bytes.readUInt16LE(end+20),0);
 const files=new Map();let pos=centralStart;
 for(let i=0;i<count;i++){
  assert.equal(bytes.readUInt32LE(pos),0x02014b50);
  const nameLength=bytes.readUInt16LE(pos+28),extraLength=bytes.readUInt16LE(pos+30),commentLength=bytes.readUInt16LE(pos+32);
  const name=bytes.subarray(pos+46,pos+46+nameLength).toString(),offset=bytes.readUInt32LE(pos+42),size=bytes.readUInt32LE(pos+24),crc=bytes.readUInt32LE(pos+16);
  assert.equal(bytes.readUInt16LE(pos+10),0);assert.equal(bytes.readUInt32LE(pos+20),size);
  assert.equal(bytes.readUInt32LE(offset),0x04034b50);assert.equal(bytes.readUInt16LE(offset+8),0);
  assert.equal(bytes.readUInt32LE(offset+14),crc);assert.equal(bytes.readUInt32LE(offset+18),size);assert.equal(bytes.readUInt32LE(offset+22),size);
  const localNameLength=bytes.readUInt16LE(offset+26),localExtraLength=bytes.readUInt16LE(offset+28);
  assert.equal(bytes.subarray(offset+30,offset+30+localNameLength).toString(),name);
  const start=offset+30+localNameLength+localExtraLength,body=bytes.subarray(start,start+size);
  assert.ok(start+size<=centralStart);assert.ok(name.startsWith('agent-desk/'));assert.ok(!name.split('/').includes('..'));assert.ok(!files.has(name));
  let actual=0xffffffff;for(const byte of body){actual^=byte;for(let bit=0;bit<8;bit++)actual=(actual>>>1)^((actual&1)?0xedb88320:0);}
  assert.equal((actual^0xffffffff)>>>0,crc,`CRC for ${name}`);
  files.set(name,body);pos+=46+nameLength+extraLength+commentLength;
 }
 assert.equal(pos,end);return files;
}

test('Windows ZIP includes current source with valid CRCs and excludes credentials, user files, caches and symlinks',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'agent-desk-package-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const directory of ['public','scripts','tests/fixtures','public/uploads','node_modules','.git'])await mkdir(path.join(root,directory),{recursive:true});
 const allowed={'README.md':'123456789','package.json':'{"name":"test","version":"1.2.3"}','package-lock.json':'{}','start-windows.cmd':'node scripts/serve.mjs','public/index.html':'<script type="module" src="app.js"></script>','public/app.js':'export const revision=1;','scripts/serve.mjs':'console.log("current runner")','tests/package.test.mjs':'// test','tests/fixtures/agent-cli.mjs':'// fixture'};
 const excluded={'.env':'SECRET=private','.env.local':'SECRET=private','agent-desk-projects-private.json':'private','.git/config':'private','node_modules/cache.js':'private','public/.private.js':'private','public/projects.json':'private','public/uploads/private.js':'private','scripts/session.log':'private','tests/credentials.json':'private'};
 for(const [name,body] of Object.entries({...allowed,...excluded}))await writeFile(path.join(root,name),body);
 if(process.platform!=='win32')await symlink(path.join(root,'.env'),path.join(root,'public','linked-secret.js'));
 const first=await createWindowsPackage(root),files=readZip(first);
 assert.deepEqual([...files.keys()].sort(),Object.keys(allowed).map(name=>'agent-desk/'+name).sort());
 for(const [name,body] of Object.entries(allowed))assert.equal(files.get('agent-desk/'+name).toString(),body);
 assert.equal(first.readUInt32LE(14),0xcbf43926,'known CRC32 vector for the first README entry');
 await writeFile(path.join(root,'public/app.js'),'export const revision=2;');
 assert.equal(readZip(await createWindowsPackage(root)).get('agent-desk/public/app.js').toString(),'export const revision=2;');
 if(process.platform!=='win32'){
  await rm(path.join(root,'README.md'));await symlink(path.join(root,'.env'),path.join(root,'README.md'));
  await assert.rejects(createWindowsPackage(root),/regular file/);
 }
});

test('same-origin download returns the current executable package for GET and HEAD without exposing arbitrary files',async t=>{
 const server=createAppServer();server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const origin='http://127.0.0.1:'+server.address().port;
 const response=await fetch(origin+'/downloads/agent-desk-windows.zip');assert.equal(response.status,200);
 assert.equal(response.headers.get('content-type'),'application/zip');assert.equal(response.headers.get('cache-control'),'no-store');
 assert.match(response.headers.get('content-disposition'),/attachment; filename="agent-desk-windows.zip"/);
 const body=Buffer.from(await response.arrayBuffer()),files=readZip(body);assert.equal(Number(response.headers.get('content-length')),body.length);
 for(const name of ['package.json','public/decision-ui.js','scripts/server.mjs','scripts/windows-package.mjs','tests/windows-package.test.mjs'])assert.deepEqual(files.get('agent-desk/'+name),await readFile(new URL('../'+name,import.meta.url)));
 const head=await fetch(origin+'/downloads/agent-desk-windows.zip',{method:'HEAD'});assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),body.length);assert.equal((await head.arrayBuffer()).byteLength,0);
 assert.equal((await fetch(origin+'/downloads/agent-desk-windows.zip',{method:'POST'})).status,405);
 for(const pathname of ['/.env','/scripts/server.mjs','/downloads/.env','/downloads/package.json','/downloads/other.zip'])assert.equal((await fetch(origin+pathname)).status,404);
 const html=await (await fetch(origin+'/download')).text();
 assert.match(html,/href="\/downloads\/agent-desk-windows\.zip"/);assert.doesNotMatch(html,/const canonical|location\.href=canonical|opal-loach/);
});

test('an occupied port explains that the prior runner must be stopped and identifies this build directory',async t=>{
 const server=createAppServer();server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const entry=fileURLToPath(new URL('../scripts/serve.mjs',import.meta.url)),root=fileURLToPath(new URL('../',import.meta.url));
 const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
 const child=spawn(process.execPath,[entry],{env:{...process.env,PORT:String(server.address().port)},stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null)child.kill();});let output='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{output+=data;});
 const [code]=await once(child,'exit');assert.equal(code,1);assert.ok(output.includes('Agent Desk v'+version));assert.ok(output.includes(root));assert.match(output,/Ctrl\+C/);assert.match(output,/이전 실행기/);
});
