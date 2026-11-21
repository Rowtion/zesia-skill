import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packArchive } from './archive.mjs';
import { runtimePlatforms } from './native-platforms.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fence = String.fromCharCode(96).repeat(3);
const code = value => String.fromCharCode(96) + value + String.fromCharCode(96);
const json = value => JSON.stringify(value, null, 2) + '\n';

export async function packageAgentPlugin({ dist, version, sourceSha }) {
  const assets = {};
  for (const platform of runtimePlatforms) {
    const file = 'zesia-runtime-' + version + '-' + platform + '.zip';
    const { archive, bytes, sha256, ...metadata } = JSON.parse(await readFile(join(dist, file + '.json'), 'utf8'));
    if (archive !== file || metadata.version !== version || metadata.platform !== platform ||
        metadata.sourceSha !== sourceSha || metadata.dirty !== false || !Number.isSafeInteger(bytes) ||
        bytes < 1 || !/^[0-9a-f]{64}$/.test(sha256)) throw Error('Unexpected native asset: ' + file);
    assets[platform] = { sha256, bytes, manifestSha256: hash(json(metadata)) };
  }
  const root = join(dist, 'agent-plugin');
  const skill = join(root, 'skills', 'zesia-consult');
  await rm(root, { recursive: true, force: true });
  await mkdir(join(skill, 'assets'), { recursive: true });
  await mkdir(join(skill, 'references'));
  await mkdir(join(root, 'assets'));
  await copyFile('assets/zesia.svg', join(root, 'assets', 'zesia.svg'));
  await copyFile('LICENSE', join(root, 'LICENSE'));
  await copyFile('THIRD_PARTY_NOTICES.md', join(root, 'THIRD_PARTY_NOTICES.md'));
  await copyFile('references/packet.md', join(skill, 'references', 'packet.md'));
  await writeFile(join(root, 'plugin.json'), json({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'zesia-consult',
    version,
    description: 'Independent expert review for the current task, with local preparation and explicit approval.',
    author: { name: 'ZESIA', url: 'https://zesia.dev' },
    homepage: 'https://zesia.dev',
    repository: 'https://github.com/Rowtion/zesia-skill',
    extensions: {
      'com.openai': {
        requires_local_executor: true,
        interface: {
          displayName: 'ZESIA Consult',
          shortDescription: 'Get an independent second opinion',
          developerName: 'ZESIA',
          websiteURL: 'https://zesia.dev',
          composerIcon: './assets/zesia.svg',
          logo: './assets/zesia.svg',
        },
      },
    },
  }));
  await writeFile(join(skill, 'assets', 'runtime-lock.json'), json({
    format: 'zesia.agent-plugin.runtime.v1', version, sourceSha, assets,
  }));

  const runtime = '~/.local/share/zesia/runtime/' + version + '/<os>-<cpu>/scripts/zesia';
  const source = await readFile('SKILL.md', 'utf8');
  const from = source.indexOf('Respond in the user');
  const to = source.indexOf('## Prepare locally');
  if (from < 0 || to < from) throw Error('The shared Skill is missing its Runtime instructions.');
  const instructions = [
    'Respond in the user’s language. Use the ZESIA Runtime at ' + code(runtime) + ' (append ' + code('.exe') + ' on Windows).',
    'Resolve the full user path and platform, quote the path, and substitute it for ' + code('<zesia-runtime>') + ' below.',
    'If the pinned executable is missing, read references/setup.md for the shared Setup procedure.',
    'Ask the user to authorize Runtime setup if they have only requested a consultation. Setup runs locally and opens the first-use guide.',
    '',
    '',
  ].join('\n');
  const portable = source.slice(0, from) + instructions + source.slice(to).replaceAll('<skill-directory>/scripts/zesia', '<zesia-runtime>');
  await writeFile(join(skill, 'SKILL.md'), portable);
  const README = [
    '# ZESIA Consult',
    '',
    'Request an independent review in a local Agent session. ZESIA prepares materials locally and opens the shared browser review. You choose whether to send the displayed materials.',
    '',
    '## Set up the local Runtime',
    '',
    'This package pins Runtime ' + code(version) + ' for macOS (arm64, x64), Linux (arm64, x64) and Windows (x64).',
    'Install the Skill through your client. Then download [official Setup 1.1.0](https://github.com/Rowtion/zesia-skill/releases/tag/setup-v1.1.0).',
    'Choose the package for your local OS/CPU or the small Node script package if you already have Node 20+.',
    'Verify the asset’s SHA-256 against the checksum on the official release, inspect and extract the ZIP.',
    'Run Setup with the installed path of ' + code('skills/zesia-consult') + ' (the directory containing ' + code('SKILL.md') + ').',
    '',
    fence + 'text',
    '<setup-node> <path-to-zesia-setup.mjs> agent-plugin "<installed-skill-directory>" --locale <zh-or-en>',
    fence,
    '',
    'The platform Setup ZIP includes its private Node executable. Use the verified executable beside the Setup script.',
    'Setup validates the pinned Runtime, installs or reuses it in your user directory, and opens https://zesia.dev/consult for first use.',
    'The Agent and browser must be on the same computer and the Agent must be able to run local commands.',
    '',
    'The browser displays exactly what would be sent. The Runtime sends only after your approval and returns the opinion to your agent.',
    '',
  ].join('\n');
  await writeFile(join(root, 'README.md'), README);
  await writeFile(join(skill, 'references', 'setup.md'), README);
  const archive = join(dist, 'zesia-agent-plugin-' + version + '.zip');
  await packArchive(root, archive);
  const sha256 = hash(await readFile(archive));
  await writeFile(archive + '.sha256', sha256 + '  ' + archive.split('/').at(-1) + '\n');
  return { root, archive, sha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  console.log(JSON.stringify(await packageAgentPlugin({ dist: resolve('dist'), sourceSha, version })));
}
