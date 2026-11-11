#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import { destinationOf, defaultConfigPath, normalizeServiceUrl, readConfig, saveConfig } from '../runtime/config.mjs';
import { readSecret } from './read-secret-shared.mjs';

function usage() {
  return `zesia configure

usage:
  node scripts/configure.mjs --token-file <json-or-text>
  node scripts/configure.mjs --token <token>
  node scripts/configure.mjs --url <https-url> --project <name>
  node scripts/configure.mjs --show

The token is written to ${defaultConfigPath()} with mode 0600.
Prefer --token-file or the interactive prompt so the token does not enter shell history.
This plugin always requires confirmation; automatic sending is not supported.
Environment overrides: ZESIA_URL, ZESIA_TOKEN, ZESIA_PROJECT, ZESIA_CONFIG.`;
}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (!['show', 'help', 'token', 'token-file', 'url', 'project', 'confirm'].includes(name)) {
      throw new Error(`Unknown option: --${name}. Run with --help.`);
    }
    if (name === 'show' || name === 'help') {
      flags[name] = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined) throw new Error(`--${name} requires a value.`);
    flags[name] = value;
  }
  return flags;
}

async function tokenFromFile(path) {
  const content = (await readFile(path, 'utf8')).trim();
  let token = content;
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed?.token === 'string') token = parsed.token;
  } catch {
    // Plain text token files are accepted too.
  }
  return token.trim();
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return 0;
  }
  if (flags.show) {
    const config = await readConfig(process.env, { requireToken: false });
    console.log(JSON.stringify({
      path: config.path,
      url: normalizeServiceUrl(config.url),
      project: config.project || null,
      confirmBeforeSend: config.confirmBeforeSend,
      tokenConfigured: Boolean(config.token),
    }, null, 2));
    return 0;
  }

  if (flags.confirm !== undefined) {
    throw new Error('This plugin always requires confirmation; automatic sending is not supported.');
  }
  let token = flags.token;
  if (flags['token-file']) token = await tokenFromFile(flags['token-file']);
  const settingsOnly = flags.project !== undefined || flags.url !== undefined;
  if (!token && !settingsOnly) {
    token = await readSecret(stdin, stdout);
  }

  const values = {};
  if (token !== undefined) {
    if (typeof token !== 'string' || !token.trim() || /\s/u.test(token)) throw new Error('A valid trial token is required.');
    values.token = token.trim();
  }
  if (flags.url !== undefined) values.url = destinationOf(flags.url);
  if (flags.project !== undefined) values.project = flags.project;
  const path = await saveConfig(values);
  console.log(`Saved private configuration: ${path}`);
  if (values.url) console.log(`Service: ${values.url}`);
  return 0;
}

main().then(code => {
  process.exitCode = code;
}).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
