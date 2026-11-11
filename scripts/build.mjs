import{installA2A}from'./install-a2a.mjs';await installA2A();
import{rm,mkdir,copyFile}from'node:fs/promises';import{build}from'esbuild';
await rm('dist/package',{recursive:true,force:true});await mkdir('dist/package/zesia-consult/scripts',{recursive:true});await mkdir('dist/package/zesia-consult/references',{recursive:true});for(const file of ['SKILL.md','references/packet.md','LICENSE','THIRD_PARTY_NOTICES.md'])await copyFile(file,'dist/package/zesia-consult/'+file);for(const [entry,name]of[['cli.mjs','zesia.mjs'],['configure.mjs','configure.mjs']])await build({entryPoints:[entry],outfile:'dist/package/zesia-consult/scripts/'+name,bundle:true,platform:'node',format:'esm',target:'node20'});

await copyFile('scripts/install-a2a.mjs','dist/package/zesia-consult/scripts/install-a2a.mjs');
