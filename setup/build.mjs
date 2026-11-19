import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const version = '1.0.0';
const native = process.argv.includes('--native');
const platform = process.platform + '-' + process.arch;
const name = 'zesia-setup-' + version + '-' + (native ? platform : 'node');
const out = resolve('dist/setup'), dir = join(out, name);
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
const entry = join(dir, 'zesia-setup.mjs');
await build({ entryPoints: ['setup/cli.mjs'], outfile: entry, bundle: true, format: 'esm', platform: 'node', target: 'node20' });
await copyFile('LICENSE', join(dir, 'LICENSE'));
if (native) {
  const upstream = '24.22.3';
  const hashes = {
    'darwin-arm64': 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd',
    'darwin-x64': '977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7',
    'linux-arm64': '261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8',
    'linux-x64': '061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2',
    'win32-x64': 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f',
  };
  const windows = process.platform === 'win32';
  const top = 'node-v' + upstream + '-' + platform.replace('win32', 'win');
  const asset = top + (windows ? '.zip' : '.tar.gz');
  const input = join(out, asset);
  execFileSync(windows ? 'curl.exe' : 'curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https',
    '--proto-redir', '=https', '--max-time', '180', '--retry', '2', '--output', input,
    'https://nodejs.org/dist/v' + upstream + '/' + asset]);
  if (createHash('sha256').update(await readFile(input)).digest('hex') !== hashes[platform]) throw Error('Node archive checksum mismatch.');
  const interpreter = windows ? 'node.exe' : 'bin/node';
  execFileSync(windows ? 'tar.exe' : 'tar', ['-xf', input, '-C', out, top + '/' + interpreter, top + '/LICENSE']);
  await rename(join(out, top, interpreter), join(dir, windows ? 'node.exe' : 'node'));
  await rename(join(out, top, 'LICENSE'), join(dir, 'NODE-LICENSE'));
  await rm(join(out, top), { recursive: true });
  await rm(input);
}
const archive = join(out, name + '.zip');
await rm(archive, { force: true });
if (process.platform === 'win32') {
  const ps = value => "'" + value.replaceAll("'", "''") + "'";
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -LiteralPath ' + ps(dir) + ' -DestinationPath ' + ps(archive) + ' -Force']);
} else execFileSync('zip', ['-q', '-r', archive, name], { cwd: out });
const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(archive + '.sha256', digest + '  ' + name + '.zip\n');
