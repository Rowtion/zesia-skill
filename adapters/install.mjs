import {realpathSync,existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, readdir, lstat, realpath, cp, rm, rename, writeFile, open, unlink} from 'node:fs/promises';
import {resolve, join, relative, isAbsolute, sep, basename} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {pathToFileURL, fileURLToPath} from 'node:url';

const FORMAT = 'zesia.skill-install.v2';
const VERSION = /^\d+\.\d+\.\d+$/;
const ownedCache = new Set(['a2a', 'a2a.exe', 'installed.json', 'A2A-CLI-LICENSE']);
const excluded = name => name === 'bin' || name === 'zesia-install.json';
const inside = (root, path) => {const part=relative(root,path);return part && part!=='..' && !part.startsWith('..'+sep) && !isAbsolute(part);};

// Reject directory aliases below the explicitly approved project. The root
// itself may be a user-selected filesystem alias and is canonicalized first.
async function directories(root, target, create=false) {
  const part=relative(root,target);
  if(part && !inside(root,target))throw Error('Invalid skill directory.');
  let current=root;
  for(const item of part.split(sep).filter(Boolean)) {
    current=join(current,item);
    if(create) {try{await mkdir(current,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}}
    let stat;try{stat=await lstat(current);}catch(e){if(e.code==='ENOENT'&&!create)return;throw e;}
    if(stat.isSymbolicLink())throw Error('Refusing a symlink in the project skill installation path.');
    if(!stat.isDirectory())throw Error('The skill installation path contains a non-directory.');
  }
}
async function inventory(root, prefix='') {
  const rows=[];
  for(const entry of (await readdir(join(root,prefix),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    if(!prefix && excluded(entry.name))continue;
    const name=prefix+entry.name, path=join(root,name), stat=await lstat(path);
    if(stat.isSymbolicLink())throw Error('Refusing a symlink in skill content.');
    if(stat.isDirectory())rows.push(...await inventory(root,name+'/'));
    else if(stat.isFile() && stat.nlink>1)throw Error('Refusing a hard-linked file in skill content.');
    else if(stat.isFile())rows.push([name,createHash('sha256').update(await readFile(path)).digest('hex')]);
    else throw Error('Skill content contains an unsupported file type.');
  }
  return rows.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
}
const identity = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
async function cache(root) {
  const path=join(root,'bin');let stat;try{stat=await lstat(path);}catch(e){if(e.code==='ENOENT')return false;throw e;}
  if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('Refusing an unsafe CLI cache directory.');
  for(const entry of await readdir(path)) {
    const item=await lstat(join(path,entry));
    if(!ownedCache.has(entry)||!item.isFile()||item.isSymbolicLink()||item.nlink>1)throw Error('The CLI cache contains unrecognized content; preserve and review it before updating.');
  }
  return true;
}
async function provision(root, helper) {
  await cache(root);
  const {installA2A}=await import(pathToFileURL(helper).href);
  await installA2A({root});
}

export async function install({project, source, host, cliSeedDirectory, upgrade=false}) {
  if(!host || !VERSION.test(host.version) || !VERSION.test(host.runtimeVersion) || typeof host.id!=='string' || typeof host.skillDirectory!=='string')throw Error('Invalid adapter version or host metadata.');
  const root=await realpath(resolve(project));
  const destination=resolve(root,host.skillDirectory,'zesia-consult');
  if(isAbsolute(host.skillDirectory)||!inside(root,destination))throw Error('Invalid skill directory.');
  const parent=resolve(destination,'..');
  await directories(root,parent,true);
  await directories(root,destination);
  const origin=await realpath(resolve(source));
  const rows=await inventory(origin);
  const contentSha256=identity(rows);
  const sourceHost=JSON.parse(await readFile(join(origin,'host.json'),'utf8'));
  for(const field of ['id','version','runtimeVersion','skillDirectory'])if(sourceHost[field]!==host[field])throw Error('Source host metadata does not match the requested adapter.');
  if(!rows.some(([name])=>name==='SKILL.md')||!rows.some(([name])=>name==='scripts/install-a2a.mjs'))throw Error('Incomplete Skill package.');
  const lock=join(parent,'.zesia-consult.install.lock');
  let handle;try{handle=await open(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw Error('Another installation may be in progress; review the existing install lock before retrying.');throw e;}
  let staged, backup, previousMarker;
  try {
    await directories(root,destination);
    let existing=false;try{await lstat(destination);existing=true;}catch(e){if(e.code!=='ENOENT')throw e;}
    if(existing) {
      let marker;
      try {
        const markerPath=join(destination,'zesia-install.json');
        if((await lstat(markerPath)).isSymbolicLink())throw Error('Unsafe marker.');
        previousMarker=await readFile(markerPath);
        marker=JSON.parse(previousMarker.toString('utf8'));
      }catch{throw Error('An unmanaged Zesia skill already exists; preserve it and choose another scope.');}
      if(marker.format!==FORMAT || !VERSION.test(marker.adapterVersion) || !/^[a-f0-9]{64}$/.test(marker.contentSha256||''))throw Error('A legacy managed installation has unverifiable version/content. Review and move it aside before installing; nothing was replaced.');
      if(marker.host!==host.id)throw Error('The existing Skill belongs to another host; preserve it.');
      if(identity(await inventory(destination))!==marker.contentSha256)throw Error('The existing managed Skill was modified; preserve and review its changes before updating.');
      await cache(destination);
      if(marker.adapterVersion===host.version) {
        if(marker.runtimeVersion!==host.runtimeVersion || marker.contentSha256!==contentSha256)throw Error('The same version has different immutable content. Publish a new adapter version.');
        await provision(destination,join(origin,'scripts/install-a2a.mjs'));
        return {destination,reused:true,adapterVersion:host.version};
      }
      if(!upgrade)throw Error('A different managed version exists. Review the update, then rerun with --upgrade.');
      const before=marker.adapterVersion.split('.').map(Number),after=host.version.split('.').map(Number);
      const changed=after.findIndex((n,i)=>n!==before[i]);
      if(changed>=0 && after[changed]<before[changed])throw Error('Refusing to downgrade a managed adapter.');
    }
    await directories(root,parent);
    staged=await mkdtemp(join(parent,'.zesia-consult.tmp-'));
    await cp(origin,staged,{recursive:true,filter:path=>path===origin||!excluded(relative(origin,path).split(sep)[0])});
    const seed=cliSeedDirectory || (existing && await cache(destination)?join(destination,'bin'):null);
    if(seed){await cache(resolve(seed,'..'));await cp(seed,join(staged,'bin'),{recursive:true});}
    await provision(staged,join(staged,'scripts/install-a2a.mjs'));
    if(identity(await inventory(staged))!==contentSha256)throw Error('Staged Skill content changed during installation.');
    await writeFile(join(staged,'zesia-install.json'),JSON.stringify({format:FORMAT,host:host.id,requester:host.requester,adapterVersion:host.version,runtimeVersion:host.runtimeVersion,contentSha256},null,2)+'\n');
    await directories(root,destination);
    if(existing) {
      const currentMarker=await readFile(join(destination,'zesia-install.json'));
      if(!currentMarker.equals(previousMarker) || identity(await inventory(destination))!==JSON.parse(previousMarker.toString('utf8')).contentSha256)throw Error('The existing Skill changed during installation; user changes were preserved.');
      await cache(destination);
      const backupParent=join(root,'.zesia','skill-backups');
      await directories(root,backupParent,true);
      const ignore=join(backupParent,'.gitignore');
      const ignoreText='# Local Zesia Skill backups; do not commit.\n*\n';
      try{await writeFile(ignore,ignoreText,{flag:'wx',mode:0o600});}
      catch(error){if(error.code!=='EEXIST')throw error;const stat=await lstat(ignore);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink>1||await readFile(ignore,'utf8')!==ignoreText)throw Error('The backup ignore file is unsafe or unrecognized; preserve it and review before updating.');}
      backup=join(backupParent,host.id+'-'+randomUUID());await rename(destination,backup);
    } else {
      try{await lstat(destination);throw Error('The destination appeared during installation; preserve it and review before retrying.');}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    try {await rename(staged,destination);staged=null;}
    catch(error) {if(backup){try{await rename(backup,destination);backup=null;}catch{throw Error('Publication failed; the original installation is preserved at '+backup);}}throw error;}
    // Keep old inodes: a concurrent editor may still hold an open file descriptor.
    return {destination,reused:false,upgraded:existing,adapterVersion:host.version,...(backup?{backup}:{})};
  } finally {
    if(staged)await rm(staged,{recursive:true,force:true});
    await handle.close();await unlink(lock);
  }
}
if(typeof Bun!=='undefined'?import.meta.main:(process.argv[1] && existsSync(process.argv[1]) && basename(realpathSync(process.argv[1]))==='install.mjs' && realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url)))) {
  const source=fileURLToPath(new URL('./',import.meta.url));
  const host=JSON.parse(await readFile(join(source,'host.json'),'utf8'));
  const args=process.argv.slice(2);if(!args[0]||args.slice(1).some(arg=>arg!=='--upgrade'))throw Error('Provide the target project directory and optionally --upgrade.');
  console.log(JSON.stringify(await install({project:args[0],source,host,upgrade:args.includes('--upgrade')})));
}
