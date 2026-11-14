import test from 'node:test';import assert from 'node:assert/strict';import{mkdtemp,writeFile,readFile,rm}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';import{execFile}from'node:child_process';import{promisify}from'node:util';
const execute=promisify(execFile);
test('prepare CLI does not repeat the local materials in the agent tool result',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'zesia-compact-'));try{
  const packet={requester:'Codex',project:'private-project',brief:'Review synthetic evidence.',context:{materials:[{id:'source',content:'DO-NOT-DUPLICATE-MATERIALS-IN-CHAT'}]}};
  const file=join(directory,'packet.json');await writeFile(file,JSON.stringify(packet));
  const config=join(directory,'config.json');await writeFile(config,JSON.stringify({url:'https://api.zesia.dev'}));
  const result=await execute(process.execPath,[new URL('../cli.mjs',import.meta.url).pathname,'prepare',file],{env:{...process.env,ZESIA_STATE_DIR:directory,ZESIA_CONFIG:config}});
  assert.ok(!result.stdout.includes('DO-NOT-DUPLICATE-MATERIALS-IN-CHAT'));const value=JSON.parse(result.stdout);assert.ok(!value.packet);assert.match(value.requestId,/^zrq-\d{13}-/);
  const stored=JSON.parse(await readFile(join(directory,value.draftId+'.json'),'utf8'));assert.deepEqual(stored.packet,packet);
 }finally{await rm(directory,{recursive:true,force:true});}
});
