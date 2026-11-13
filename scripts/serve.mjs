import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createAppServer } from './server.mjs';
const {version} = JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const sourceDirectory = fileURLToPath(new URL('../',import.meta.url));
const port = Number(process.env.PORT || 4173);
const host = '127.0.0.1'; // The runner only listens on this computer.
const server = createAppServer();
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Agent Desk v${version}을 시작하지 못했습니다. 포트 ${port}를 기존 실행기가 사용 중입니다.\n기존 실행기 명령창에서 Ctrl+C로 종료한 뒤 이 폴더에서 다시 실행하세요: ${sourceDirectory}\n현재 브라우저는 이전 실행기에 연결되어 있을 수 있습니다.` : error.message); process.exitCode = 1; });
server.listen(port, host, () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`Agent Desk v${version}: ${url}\nSource: ${sourceDirectory}\nPress Ctrl+C to stop.`);
  if (process.argv.includes('--open') && process.platform === 'win32') spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {detached:true, stdio:'ignore'}).unref();
});

for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await server.stopAgents();server.close(()=>process.exit(0));server.closeIdleConnections();});
