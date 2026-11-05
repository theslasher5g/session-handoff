// session-handoff core: transcript digest -> small markdown note, per branch. Zero dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const MAX_TAIL_BYTES = 3 * 1024 * 1024;
export const estTokens = (s) => Math.ceil(s.length / 4);

export function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 3000 });
  return r.status === 0 ? r.stdout.trim() : '';
}
/** Hooks may run with another cwd (subagents, worktrees, scratch dirs): always resolve git state from the project root. */
export const rootOf = (cwd) => process.env.CLAUDE_PROJECT_DIR || git(cwd, ['rev-parse', '--show-toplevel']) || cwd;
export const branchOf = (cwd) => git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'no-git';
export const slug = (s) => String(s).replace(/[^\w.-]+/g, '_').slice(0, 80) || 'default';

export function handoffDir(cwd) {
  if (process.env.HANDOFF_DIR) return process.env.HANDOFF_DIR;
  const root = process.env.CLAUDE_PROJECT_DIR || git(cwd, ['rev-parse', '--show-toplevel']) || cwd;
  return path.join(root, '.claude', 'handoff');
}
export const fileFor = (cwd, branch) => path.join(handoffDir(cwd), slug(branch) + '.md');

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) { try { fs.writeFileSync(gi, '*\n'); } catch { /* best effort */ } }
}

/** Read the tail of a (possibly huge) JSONL transcript and parse it. */
export function readTranscript(file) {
  if (!file) return [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let lines = buf.toString('utf8').split('\n');
    if (start > 0) lines = lines.slice(1); // first line is probably cut in half
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

const clip = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '');

/** Extract what matters for a hand-over from transcript entries. */
export function digest(entries, cwd) {
  const prompts = [], files = [], toolById = new Map();
  let lastAssistant = '', todos = null, firstTs = '';
  const bashResults = []; // {key, error, cmd, msg} in order
  for (const e of entries) {
    if (!firstTs && e.timestamp) firstTs = e.timestamp;
    if (e.isSidechain) continue;
    const c = e.message?.content;
    if (e.type === 'user') {
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'tool_result' && b.is_error) {
            const tu = toolById.get(b.tool_use_id);
            if (tu && tu.name === 'Bash') bashResults.push({ key: String(tu.input?.command || '').slice(0, 30), error: true, cmd: clip(tu.input?.command || '', 110), msg: clip(textOf(b.content) || String(b.content || ''), 170) });
          } else if (b.type === 'tool_result') {
            const tu = toolById.get(b.tool_use_id);
            if (tu && tu.name === 'Bash') bashResults.push({ key: String(tu.input?.command || '').slice(0, 30), error: false });
          }
        }
      }
      const human = !e.isMeta && (e.origin == null || e.origin.kind === 'human');
      const isResult = Array.isArray(c) && c.some((b) => b.type === 'tool_result');
      const t = textOf(c).trim();
      if (human && !isResult && t && !t.startsWith('<') && !t.startsWith('[Image')) prompts.push(t);
    } else if (e.type === 'assistant' && Array.isArray(c)) {
      const txt = c.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
      if (txt) lastAssistant = txt;
      for (const b of c) {
        if (b.type !== 'tool_use') continue;
        toolById.set(b.id, b);
        if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(b.name)) {
          const f = b.input?.file_path || b.input?.notebook_path;
          if (f) { const rel = path.relative(cwd, f); files.push(rel.startsWith('..') ? f : rel); }
        }
        if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) todos = b.input.todos;
      }
    }
  }
  // the last error only counts if it is recent and the same command did not succeed afterwards
  let lastError = null;
  const recent = bashResults.slice(-10);
  for (let i = recent.length - 1; i >= 0; i--) {
    if (!recent[i].error) continue;
    if (!recent.slice(i + 1).some((r) => !r.error && r.key === recent[i].key)) lastError = recent[i];
    break;
  }
  const uniqueFiles = [...new Set(files.reverse())].reverse().slice(-10);
  const openTodos = (todos || []).filter((t) => t.status !== 'completed').slice(0, 6).map((t) => ({ status: t.status, content: clip(t.content || t.subject || '', 100) }));
  return { prompts, files: uniqueFiles, lastAssistant, openTodos, lastError, firstTs };
}

export function parseMeta(md) {
  const m = /^<!-- handoff (\{.*\}) -->/.exec(md);
  try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
}
export const notesOf = (md) => { const m = /\n## Notes\n([\s\S]*?)(\n## |\s*$)/.exec(md || ''); return m ? m[1].trim() : ''; };

export function render({ d, cwd, sessionId, notes }) {
  const branch = branchOf(cwd), head = git(cwd, ['rev-parse', '--short', 'HEAD']);
  const status = git(cwd, ['status', '--short']).split('\n').filter(Boolean);
  const commits = d.firstTs ? git(cwd, ['log', `--since=${d.firstTs}`, '--format=%h %s', '-n', '6']).split('\n').filter(Boolean) : [];
  const meta = { ts: new Date().toISOString(), branch, head, session: sessionId || '' };
  const L = [`<!-- handoff ${JSON.stringify(meta)} -->`];
  const first = d.prompts[0], recent = d.prompts.slice(-3);
  if (first) L.push(`## Goal\n${clip(first, 220)}`);
  if (recent.length) L.push(`## Last requests\n${recent.map((p, i) => `${i + 1}. ${clip(p, 200)}`).join('\n')}`);
  if (d.lastAssistant) L.push(`## Where it stopped\n${clip(d.lastAssistant, 450)}`);
  if (d.openTodos.length) L.push(`## Open todos\n${d.openTodos.map((t) => `- [${t.status}] ${t.content}`).join('\n')}`);
  if (d.files.length) L.push(`## Files touched\n${d.files.join(', ')}`);
  if (commits.length) L.push(`## Commits this session\n${commits.map((c) => clip(c, 110)).join('\n')}`);
  if (d.lastError) L.push(`## Last failing command\n\`${d.lastError.cmd}\` → ${d.lastError.msg}`);
  if (status.length) L.push(`## Uncommitted (${status.length})\n${status.slice(0, 8).join('\n')}${status.length > 8 ? `\n… +${status.length - 8} more` : ''}`);
  if (notes) L.push(`## Notes\n${notes}`);
  return { md: L.join('\n\n') + '\n', meta, worthSaving: !!(first && (commits.length || d.files.length || d.openTodos.length || d.lastError || status.length || notes)) };
}

export function readHandoff(cwd, branch = branchOf(cwd)) {
  try { return fs.readFileSync(fileFor(cwd, branch), 'utf8'); } catch { return ''; }
}
export function writeHandoff(cwd, branch, md) {
  ensureDir(handoffDir(cwd));
  const f = fileFor(cwd, branch), tmp = f + `.${process.pid}.tmp`;
  fs.writeFileSync(tmp, md); fs.renameSync(tmp, f);
}

export async function readStdinJson() {
  try { return JSON.parse(await new Promise((r) => { let s = ''; process.stdin.on('data', (c) => (s += c)); process.stdin.on('end', () => r(s || '{}')); })); } catch { return {}; }
}
