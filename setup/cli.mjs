import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { access } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { startGuide, hosts, paths } from './guide.mjs';
import { installHost } from './install.mjs';
import { installPluginRuntime } from './standalone-runtime.mjs';

const entry = fileURLToPath(import.meta.url);
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  locale: { type: 'string' }, profile: { type: 'string' }, dsh: { type: 'string' },
  project: { type: 'string' }, upgrade: { type: 'boolean' }, help: { type: 'boolean' }, 'no-open': { type: 'boolean' },
} });
const [host, directory] = positionals;
const locale = /^zh(?:[-_]|$)/i.test(values.locale || Intl.DateTimeFormat().resolvedOptions().locale) ? 'zh' : 'en';

function openAfterInstall(guideHost) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, 'serve-guide', guideHost, '--locale', locale, ...(values['no-open'] ? ['--no-open'] : [])], {
      detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => finish(Error('The local guide did not start.')), 15000);
    let done = false;
    function finish(error, result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      lines.close(); child.stdout.destroy();
      if (error) { child.kill(); reject(error); }
      else { child.unref(); resolve(result); }
    }
    child.once('error', finish);
    child.once('exit', () => finish(Error('The local guide closed before startup.')));
    lines.once('line', line => {
      try {
        const message = JSON.parse(line);
        finish(message.error ? Error(message.error) : null, message);
      } catch (error) { finish(error); }
    });
  });
}
try {
  if (values.help) console.log('zesia-setup <host> <verified-package-directory> [--locale zh|en] [--profile desktop|web --dsh <cli>] [--project <dir>] [--upgrade]\nzesia-setup agent-plugin <skill-directory> [--locale zh|en]');
  else if (host === 'serve-guide') {
    const guide = await startGuide({ host: directory, locale,
      ...(values['no-open'] ? { openBrowser: async () => false } : {}) });
    if (guide.close) {
      process.once('SIGTERM', guide.close); process.once('SIGINT', guide.close);
    }
    console.log(JSON.stringify({ state: guide.state, ...(guide.url ? { url: guide.url } : {}) }));
  } else {
    const marketInstall = host === 'agent-plugin';
    if (positionals.length !== 2 || (!marketInstall && !Object.hasOwn(hosts, host))) {
      throw Error('Provide an installation type and its verified package directory.');
    }
    if (marketInstall && (values.profile || values.dsh || values.project || values.upgrade)) {
      throw Error('Agent Plugin setup initializes the shared user Runtime.');
    }
    const guideHost = marketInstall ? 'portable' : host;
    const result = marketInstall ? await installPluginRuntime({ skillDirectory: directory })
      : await installHost({ host, directory, ...values });
    try {
      const guide = await openAfterInstall(guideHost);
      if (guide.state === 'opened' || guide.state === 'pending') {
        const { marker } = paths(guideHost);
        const until = Date.now() + 5000;
        while (Date.now() < until) {
          try { await access(marker); guide.state = 'displayed'; delete guide.url; break; }
          catch (e) { if (e.code !== 'ENOENT') throw e; }
          await pause(200);
        }
        if (guide.state !== 'displayed') guide.state = 'awaiting_browser';
      }
      console.log(JSON.stringify({ ...result, onboarding: guide }));
    } catch (error) {
      console.log(JSON.stringify({ ...result, onboarding: { state: 'unavailable', message: error.message } }));
      process.exitCode = 2;
    }
  }
} catch (error) { console.log(JSON.stringify({ error: error.message })); process.exitCode = 1; }
