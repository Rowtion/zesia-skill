import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,rm,copyFile,readdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join,relative} from 'node:path';
import {installA2A} from './install-a2a.mjs';
const root=resolve(import.meta.dirname,'..');
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const target=process.platform+'-'+process.arch;
if(!['darwin-arm64','darwin-x64','linux-arm64','linux-x64','win32-x64'].includes(target))throw Error('Unsupported standalone platform: '+target);
const dirty=Boolean(execFileSync('git',['status','--porcelain','--untracked-files=all'],{cwd:root,encoding:'utf8'}).trim());
if(dirty&&!process.argv.includes('--allow-dirty'))throw Error('Commit public source before producing a release asset.');
const sourceSha=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const bunVersion=execFileSync('bun',['--version'],{encoding:'utf8'}).trim();
if(bunVersion!=='1.3.13')throw Error('Build with pinned Bun 1.3.13.');
const directory=join(root,'dist/native/'+target);await rm(directory,{recursive:true,force:true});
await mkdir(join(directory,'scripts'),{recursive:true});await mkdir(join(directory,'licenses'));
const binary=join(directory,'scripts/zesia'+(process.platform==='win32'?'.exe':''));
execFileSync('bun',['build',join(root,'cli.mjs'),'--compile','--no-compile-autoload-dotenv','--no-compile-autoload-bunfig','--define','ZESIA_COMPILED=true','--define','ZESIA_RUNTIME_VERSION='+JSON.stringify(pkg.version),'--outfile',binary],{cwd:root,stdio:'inherit'});
if(process.platform==='darwin')execFileSync('codesign',['--force','--sign','-',binary],{stdio:'inherit'});
execFileSync('bun',['build',join(root,'cli.mjs'),'--target=bun','--define','ZESIA_COMPILED=true','--define','ZESIA_RUNTIME_VERSION='+JSON.stringify(pkg.version),'--outfile',join(directory,'zesia-cli.bundle.mjs')],{cwd:root,stdio:'inherit'});
const cli=await installA2A({root:directory});
await copyFile(join(root,'LICENSE'),join(directory,'licenses/ZESIA-LICENSE'));
await copyFile(join(root,'third_party/bun/LICENSE.md'),join(directory,'licenses/BUN-LICENSE.md'));
await copyFile(join(root,'NATIVE-NOTICES.md'),join(directory,'NATIVE-NOTICES.md'));
async function inventory(path,prefix=''){
 const rows=[];for(const name of (await readdir(path)).sort()){
  const file=join(path,name),s=await stat(file),key=prefix+name;
  if(s.isDirectory())rows.push(...await inventory(file,key+'/'));
  else{const bytes=await readFile(file);rows.push({path:key,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
 }return rows;
}
const metadata={format:'zesia.native-runtime.v1',version:pkg.version,platform:target,sourceSha,dirty,bunVersion,a2a:cli,files:await inventory(directory)};
await writeFile(join(directory,'runtime.json'),JSON.stringify(metadata,null,2)+'\n');
const name='zesia-runtime-'+pkg.version+'-'+target+'.zip';const archive=join(root,'dist',name);
await rm(archive,{force:true});
if(process.platform==='win32'){
 const quote=s=>"'"+s.replaceAll("'","''")+"'";
 execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Compress-Archive -Path '+quote(join(directory,'*'))+' -DestinationPath '+quote(archive)],{stdio:'inherit'});
}else execFileSync('zip',['-qr',archive,'.'],{cwd:directory,stdio:'inherit'});
const bytes=await readFile(archive);const sha256=createHash('sha256').update(bytes).digest('hex');
await writeFile(archive+'.sha256',sha256+'  '+name+'\n');
await writeFile(archive+'.json',JSON.stringify({...metadata,archive:name,bytes:bytes.length,sha256},null,2)+'\n');
console.log(JSON.stringify({archive:relative(root,archive),platform:target,dirty,bytes:bytes.length,sha256}));
