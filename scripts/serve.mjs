import { spawn } from 'node:child_process';
import { createAppServer } from './server.mjs';
const port = Number(process.env.PORT || 4173);
const host = '127.0.0.1'; // The runner only listens on this computer.
const server = createAppServer();
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Open http://127.0.0.1:${port} or set PORT.` : error.message); process.exitCode = 1; });
server.listen(port, host, () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`Agent Desk: ${url}\nPress Ctrl+C to stop.`);
  if (process.argv.includes('--open') && process.platform === 'win32') spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {detached:true, stdio:'ignore'}).unref();
});

for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await server.stopAgents();server.close(()=>process.exit(0));server.closeIdleConnections();});
