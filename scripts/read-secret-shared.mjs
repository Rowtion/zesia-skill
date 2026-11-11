import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

/** Keep credentials out of terminal output and readline history. */
export async function readSecret(input, output) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error('Interactive token entry requires a terminal. Run this command in your terminal, or use --token-file <path>. Do not paste your token into chat.');
  }
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const prompt = createInterface({ input, output: muted, terminal: true, historySize: 0 });
  output.write('Zesia trial token (hidden; stored only on this computer): ');
  try {
    return await new Promise((resolve, reject) => {
      prompt.once('close', () => reject(new Error('Token entry cancelled. No configuration was saved.')));
      prompt.question('', value => resolve(value.trim()));
    });
  } finally {
    prompt.close();
    muted.end();
    output.write('\n');
  }
}
