import {realpathSync,existsSync} from 'node:fs';
import{readFile,writeFile,mkdir,mkdtemp,rm,chmod,lstat,realpath,rename}from'node:fs/promises';import{execFileSync}from'node:child_process';import{createHash,randomUUID}from'node:crypto';import{join,resolve}from'node:path';import{tmpdir}from'node:os';import{fileURLToPath,pathToFileURL}from'node:url';
export const A2A_VERSION='0.4.0';
export const ARTIFACTS={
 'darwin-x64':['a2a_0.4.0_darwin_amd64.tar.gz','3b5859fd8f114c45dc878885382e7a47210a61cbebf3c9a3144bd6840295e1bf'],
 'darwin-arm64':['a2a_0.4.0_darwin_arm64.tar.gz','26573b82a42598232fdfdede65ab748a46c8c83059470bedf60c2e024141bd38'],
 'linux-x64':['a2a_0.4.0_linux_amd64.tar.gz','b1242b3e0aaea26002bc61824d318b590b47dbc5e509a9a1f31a17c8be4198a7'],
 'linux-arm64':['a2a_0.4.0_linux_arm64.tar.gz','36382ad763580a364cfe345f87650ecfe7793c6f1b866f94eac5e6a303a5e177'],
 'win32-x64':['a2a_0.4.0_windows_amd64.zip','0da25ed269bc52579b54c8a144574dd6ef1150e7c33e68200e219b49882bca4d'],
 'win32-arm64':['a2a_0.4.0_windows_arm64.zip','6ed7a20802d0b17f9708ed92f8d5a77049ec8e846438a6be3975304e797947e0'],
};
const cacheFiles=['a2a','a2a.exe','installed.json','A2A-CLI-LICENSE'];
async function safeOutput(output,create=false){
 let stat;try{stat=await lstat(output);}catch(e){if(e.code!=='ENOENT')throw e;if(!create)return;try{await mkdir(output);}catch(error){if(error.code!=='EEXIST')throw error;}stat=await lstat(output);}
 if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('Refusing a symlink or unsafe A2A cache directory.');
 for(const name of cacheFiles){let file;try{file=await lstat(join(output,name));}catch(e){if(e.code==='ENOENT')continue;throw e;}if(file.isSymbolicLink()||!file.isFile()||file.nlink>1)throw Error('Refusing a symlink, hardlink or unsafe A2A cache file.');}
}
async function atomicCacheFile(output,name,bytes,mode=0o600){
 await safeOutput(output,true);const temporary=join(output,'.'+name+'.'+randomUUID()+'.tmp');
 try{await writeFile(temporary,bytes,{flag:'wx',mode});await chmod(temporary,mode);await safeOutput(output);await rename(temporary,join(output,name));}finally{await rm(temporary,{force:true});}
}
export async function installA2A({root=fileURLToPath(new URL('../',import.meta.url)),archivePath,platform=process.platform,arch=process.arch}={}){
 const row=ARTIFACTS[platform+'-'+arch];if(!row)throw Error('Unsupported A2A CLI platform: '+platform+'-'+arch);const [file,sha256]=row;const binary=platform==='win32'?'a2a.exe':'a2a';const output=join(await realpath(resolve(root)),'bin');await safeOutput(output);
 try{const installed=JSON.parse(await readFile(join(output,'installed.json'),'utf8'));const bytes=await readFile(join(output,binary));if(installed.version===A2A_VERSION&&installed.platform===platform+'-'+arch&&installed.archiveSha256===sha256&&createHash('sha256').update(bytes).digest('hex')===installed.binarySha256)return {version:A2A_VERSION,platform:platform+'-'+arch,cached:true};}catch{}
 const temporary=await mkdtemp(join(tmpdir(),'zesia-a2a-install-'));
 try{let bytes;if(archivePath)bytes=await readFile(archivePath);else{const response=await fetch('https://github.com/a2aproject/a2a-cli/releases/download/v'+A2A_VERSION+'/'+file,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error('Could not download the pinned A2A CLI.');bytes=Buffer.from(await response.arrayBuffer());}
  if(createHash('sha256').update(bytes).digest('hex')!==sha256)throw Error('A2A CLI archive checksum mismatch.');const archive=join(temporary,file);await writeFile(archive,bytes);const extracted=join(temporary,'extracted');await mkdir(extracted);
  if(platform==='win32'){const quote=s=>"'"+s.replaceAll("'","''")+"'";execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Expand-Archive -LiteralPath '+quote(archive)+' -DestinationPath '+quote(extracted)],{windowsHide:true});}else execFileSync('tar',['-xzf',archive,'-C',extracted]);
  const data=await readFile(join(extracted,binary));await safeOutput(output,true);await atomicCacheFile(output,binary,data,0o755);await atomicCacheFile(output,'A2A-CLI-LICENSE',await readFile(join(extracted,'LICENSE')));const installed={version:A2A_VERSION,platform:platform+'-'+arch,archiveSha256:sha256,binarySha256:createHash('sha256').update(data).digest('hex')};await atomicCacheFile(output,'installed.json',JSON.stringify(installed,null,2)+'\n');return installed;
 }finally{await rm(temporary,{recursive:true,force:true});}
}
if(typeof Bun!=='undefined'?import.meta.main:(process.argv[1]&&existsSync(process.argv[1])&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url)))){const at=process.argv.indexOf('--archive');const rt=process.argv.indexOf('--root');console.log(JSON.stringify(await installA2A({...(at>=0?{archivePath:resolve(process.argv[at+1])}:{}),...(rt>=0?{root:resolve(process.argv[rt+1])}:{})})));}
