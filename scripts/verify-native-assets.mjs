import{readFile,readdir}from'node:fs/promises';import{createHash}from'node:crypto';import assert from'node:assert/strict';
const pkg=JSON.parse(await readFile('package.json','utf8'));
const manifests=(await readdir('dist')).filter(p=>p.startsWith('zesia-runtime-')&&p.endsWith('.zip.json'));
assert.equal(manifests.length,5,'All five standalone platforms are required before publication.');
const platforms=new Set();
for(const name of manifests){
 const m=JSON.parse(await readFile('dist/'+name,'utf8'));assert.equal(m.version,pkg.version);assert.equal(m.sourceSha,process.env.GITHUB_SHA);assert.equal(m.dirty,false);assert.ok(!platforms.has(m.platform));platforms.add(m.platform);
 assert.equal(m.archive,'zesia-runtime-'+pkg.version+'-'+m.platform+'.zip');
 const bytes=await readFile('dist/'+m.archive);assert.equal(bytes.length,m.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),m.sha256);
 assert.equal(await readFile('dist/'+m.archive+'.sha256','utf8'),m.sha256+'  '+m.archive+'\n');
}
assert.deepEqual([...platforms].sort(),['darwin-arm64','darwin-x64','linux-arm64','linux-x64','win32-x64']);
console.log('Five platform assets verified against source, version, byte count and checksum.');
