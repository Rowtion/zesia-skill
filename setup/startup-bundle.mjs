import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const bundlePrefix = '.zesia-first-use-';

export async function missing(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function fileDigest(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1) throw Error('Expected a regular file in the first-use guide bundle.');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function stageBundle(directory, files) {
  const name = bundlePrefix + createHash('sha256')
    .update(JSON.stringify(files.map(({ name, digest }) => [name, digest]))).digest('hex');
  const destination = join(directory, name);
  async function verify(target) {
    if (!(await lstat(target)).isDirectory()) throw Error('Unsafe first-use guide bundle directory.');
    for (const file of files) {
      if (await fileDigest(join(target, file.name)) !== file.digest)
        throw Error('An installed guide file was changed.');
    }
  }

  if (await missing(destination)) {
    await verify(destination);
    return name;
  }
  const staged = await mkdtemp(join(directory, '.zesia-guide-'));
  try {
    for (const file of files) {
      const target = join(staged, file.name);
      if (file.path) await copyFile(file.path, target);
      else await writeFile(target, file.content, { flag: 'wx', mode: 0o600 });
      if (file.executable) await chmod(target, 0o700);
    }
    await verify(staged);
    try { await rename(staged, destination); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) || !await missing(destination)) throw error;
      await verify(destination);
    }
    return name;
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}

export async function stageGuideBundle({ directory, entry, interpreter, privateInterpreter, module }) {
  const files = [{ name: 'zesia-setup.mjs', path: entry }];
  if (privateInterpreter) {
    files.push({ name: 'node.exe', path: interpreter, executable: true });
    files.push({ name: 'NODE-LICENSE', path: join(dirname(entry), 'NODE-LICENSE') });
  }
  if (module) files.push({ name: 'tui.mjs', content: module });
  const verified = await Promise.all(files.map(async file => ({
    ...file,
    digest: file.path ? await fileDigest(file.path) : createHash('sha256').update(file.content).digest('hex'),
  })));
  return stageBundle(directory, verified);
}
