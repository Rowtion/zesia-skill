import { readFile } from 'node:fs/promises';
import { createPortable } from './runtime.mjs';
const [command, id, hash, confirmationFile] = process.argv.slice(2);
const runtime = createPortable();
try {
  let value;
  if (command === 'prepare') value = await runtime.prepare(JSON.parse(await readFile(id, 'utf8')));
  else if (command === 'send') value = await runtime.send(id, hash, await readFile(confirmationFile, 'utf8'));
  else if (command === 'result') value = await runtime.result(id);
  else if (command === 'followup') value = await runtime.followup(id, JSON.parse(await readFile(hash, 'utf8')));
  else if (command === '--help') value = { commands: ['prepare <packet.json>', 'send <draftId> <approvedHash> <confirmation.txt>', 'result <draftId>', 'followup <draftId> <answers.json>'], note: 'Preparation is local. Sending requires the user to review and confirm the exact packet. Node.js >=20; no administrator access.' };
  else throw new Error('Unknown command. Run with --help.');
  console.log(JSON.stringify(value, null, 2));
  if (value.ok === false) process.exitCode = 1;
} catch (error) { console.log(JSON.stringify({ ok: false, message: error.message, retryAllowed: false })); process.exitCode = 1; }
