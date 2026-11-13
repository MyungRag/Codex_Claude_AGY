import {spawn} from 'node:child_process';

// Fixed script: no path, project name or other browser input is executed as code.
const pickerScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select the project folder'
$dialog.ShowNewFolderButton = $false
try {
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $result = @{ cancelled = $false; path = $dialog.SelectedPath }
  } else { $result = @{ cancelled = $true } }
  [Console]::WriteLine(($result | ConvertTo-Json -Compress))
} finally { $dialog.Dispose() }
`;
export function pickWindowsFolder(signal) {
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-STA','-EncodedCommand',Buffer.from(pickerScript,'utf16le').toString('base64')],{windowsHide:true,stdio:['ignore','pipe','pipe'],signal,timeout:300000});
    let output='';
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(output.length>16000)child.kill();});
    child.on('error',error=>reject(new Error(error.name==='AbortError'?'폴더 선택이 취소되었습니다.':'Windows 폴더 선택창을 열 수 없습니다. 경로를 직접 입력해 주세요.')));
    child.on('close',code=>{
      if(code!==0){reject(new Error('폴더 선택창이 종료되었습니다. 다시 선택하거나 경로를 직접 입력해 주세요.'));return;}
      try {
        const result=JSON.parse(output.replace(/^\uFEFF/, '').trim());
        if(result.cancelled===true){resolve({cancelled:true});return;}
        if(typeof result.path!=='string'||!result.path)throw new Error();
        resolve({cancelled:false,path:result.path,name:result.path.replace(/[\\/]+$/,'').split(/[\\/]/).at(-1)||result.path});
      }catch{reject(new Error('선택한 폴더 경로를 읽지 못했습니다.'));}
    });
  });
}
