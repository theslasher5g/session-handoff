#!/usr/bin/env node
// CLI:  handoff.mjs show | note "<text>" | clear | path
import fs from 'node:fs';
import { branchOf, rootOf, readHandoff, writeHandoff, fileFor, notesOf, digest, render, parseMeta } from './lib.mjs';

const cwd = rootOf(process.cwd()), branch = branchOf(cwd);
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'show') {
  const md = readHandoff(cwd, branch);
  console.log(md ? md.replace(/^<!-- handoff .*? -->\n+/, '') : `no handoff for branch ${branch}`);
} else if (cmd === 'note') {
  const text = rest.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) { console.error('usage: note "<text>"'); process.exit(1); }
  const prev = readHandoff(cwd, branch);
  const old = notesOf(prev);
  const notes = [old, `- ${text}`].filter(Boolean).join('\n');
  const { md } = render({ d: digest([], cwd), cwd, sessionId: parseMeta(prev)?.session, notes });
  // keep the automatically captured sections of an existing note, only replace the notes block
  const merged = prev ? (/\n## Notes\n/.test(prev) ? prev.replace(/\n## Notes\n[\s\S]*$/, `\n## Notes\n${notes}\n`) : prev.trimEnd() + `\n\n## Notes\n${notes}\n`) : md;
  writeHandoff(cwd, branch, merged);
  console.log(`noted on branch ${branch}`);
} else if (cmd === 'clear') {
  try { fs.unlinkSync(fileFor(cwd, branch)); console.log(`cleared handoff for ${branch}`); } catch { console.log('nothing to clear'); }
} else if (cmd === 'path') {
  console.log(fileFor(cwd, branch));
} else {
  console.log('usage: show | note "<text>" | clear | path');
}
