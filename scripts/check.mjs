import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
for(const dir of ['public','scripts'])for(const name of await readdir(dir)){if(!/\.(js|mjs)$/.test(name))continue;const result=spawnSync(process.execPath,['--check',dir+'/'+name],{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);}
console.log('All application and runner modules passed syntax checks.');
