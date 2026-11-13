import {dirname,resolve} from 'node:path';
export const standalone=typeof ZESIA_COMPILED!=='undefined'&&ZESIA_COMPILED;
export function executableA2A(){return standalone?resolve(dirname(process.execPath),'../bin/a2a'+(process.platform==='win32'?'.exe':'')):null;}

export const runtimeVersion=typeof ZESIA_RUNTIME_VERSION!=='undefined'?ZESIA_RUNTIME_VERSION:null;
