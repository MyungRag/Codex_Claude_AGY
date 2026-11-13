import {lstat,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot=fileURLToPath(new URL('../',import.meta.url));
const rootFiles=['README.md','package.json','package-lock.json','start-windows.cmd'];
const sourceDirectories=[['public',new Set(['.html','.js','.css','.svg'])],['scripts',new Set(['.mjs'])],['tests',new Set(['.mjs'])],['tests/fixtures',new Set(['.mjs'])]];
const maxPackageBytes=64*1024*1024;
const crcTable=Uint32Array.from({length:256},(_,value)=>{for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);return value>>>0;});
function crc32(bytes){let value=0xffffffff;for(const byte of bytes)value=(value>>>8)^crcTable[(value^byte)&255];return (value^0xffffffff)>>>0;}

// Stored ZIP entries need no external archiver and work with Windows Extract All.
function zip(entries){
 const local=[],central=[];let offset=0,centralSize=0;
 for(const {name,body} of entries){
  const filename=Buffer.from('agent-desk/'+name),crc=crc32(body),header=Buffer.alloc(30),directory=Buffer.alloc(46);
  header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(33,12);
  header.writeUInt32LE(crc,14);header.writeUInt32LE(body.length,18);header.writeUInt32LE(body.length,22);header.writeUInt16LE(filename.length,26);
  directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt16LE(33,14);
  directory.writeUInt32LE(crc,16);directory.writeUInt32LE(body.length,20);directory.writeUInt32LE(body.length,24);directory.writeUInt16LE(filename.length,28);directory.writeUInt32LE(offset,42);
  local.push(header,filename,body);central.push(directory,filename);offset+=header.length+filename.length+body.length;centralSize+=directory.length+filename.length;
 }
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralSize,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,...central,end]);
}

export async function createWindowsPackage(root=projectRoot){
 const entries=[];let total=0;
 const add=async name=>{
  const filename=path.join(root,name),stat=await lstat(filename);
  if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Package source must be a regular file.');
  total+=stat.size;if(total>maxPackageBytes)throw new Error('Package source exceeds the size limit.');
  const body=await readFile(filename);entries.push({name,body});
 };
 for(const name of rootFiles)await add(name);
 // Deliberately do not recurse: no credentials, project backups, caches, or user attachments.
 for(const [directory,extensions] of sourceDirectories){
  const dir=path.join(root,directory),stat=await lstat(dir);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Package directory must be a regular directory.');
  const files=await readdir(dir,{withFileTypes:true});
  for(const file of files.sort((a,b)=>a.name.localeCompare(b.name))){
   if(file.name.startsWith('.')||!file.isFile()||!extensions.has(path.extname(file.name)))continue;
   await add(directory+'/'+file.name);
  }
 }
 if(entries.length>65535)throw new Error('Too many package files.');
 return zip(entries);
}
