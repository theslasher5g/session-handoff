import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = (name) => path.join(root, 'scripts', name);

function repo() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
  const g = (...a) => spawnSync('git', a, { cwd: r, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(r, 'a.txt'), 'a'); g('add', '.'); g('commit', '-q', '-m', 'init');
  return { r, g };
}
const env = (extra = {}) => ({ ...process.env, CLAUDE_PROJECT_DIR: '', HANDOFF_DIR: '', ...extra });
const run = (name, cwd, input, extra) => spawnSync('node', [script(name)], { cwd, input: JSON.stringify(input), encoding: 'utf8', env: env(extra) });

function transcript(cwd, { withWork = true } = {}) {
  const L = [];
  const user = (content, extra = {}) => L.push({ type: 'user', message: { role: 'user', content }, origin: { kind: 'human' }, ...extra });
  const asst = (content) => L.push({ type: 'assistant', message: { role: 'assistant', content } });
  user('Add retry logic to the uploader and keep the tests green');
  asst([{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: path.join(cwd, 'src/upload.rs') } }]);
  L.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
  user('<system-reminder>ignore me</system-reminder>', { isMeta: true });
  user('<task-notification>bg done</task-notification>', { origin: { kind: 'task-notification' } });
  asst([{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'cargo test upload::retry' } }]);
  L.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'error[E0599]: no method named `backoff` found' }] } });
  asst([{ type: 'tool_use', id: 't3', name: 'TodoWrite', input: { todos: [{ content: 'Implement backoff()', status: 'in_progress' }, { content: 'Write test', status: 'completed' }] } }]);
  user('now also handle HTTP 429');
  asst([{ type: 'text', text: 'Next I will add the Retry-After parsing in src/upload.rs and fix the failing backoff() call.' }]);
  const f = path.join(cwd, '..', 'transcript-' + Math.random().toString(36).slice(2) + '.jsonl');
  fs.writeFileSync(f, (withWork ? L : L.slice(0, 1)).map((x) => JSON.stringify(x)).join('\n') + '\n');
  return f;
}

test('save writes a compact note with goal, requests, todos, files, last error – and filters system noise', () => {
  const { r } = repo();
  const t = transcript(r);
  assert.equal(run('save.mjs', r, { hook_event_name: 'SessionEnd', session_id: 's1', transcript_path: t, cwd: r }).status, 0);
  const md = fs.readFileSync(path.join(r, '.claude/handoff/main.md'), 'utf8');
  assert.match(md, /## Goal\nAdd retry logic/);
  assert.match(md, /2\. now also handle HTTP 429/);
  assert.match(md, /\[in_progress\] Implement backoff/);
  assert.doesNotMatch(md, /Write test/);                        // completed todo is not carried over
  assert.match(md, /src\/upload\.rs/);
  assert.match(md, /cargo test upload::retry` → error\[E0599\]/);
  assert.match(md, /Where it stopped\nNext I will add the Retry-After/);
  assert.doesNotMatch(md, /ignore me|bg done/);
  assert.ok(md.length < 2400, `note too long: ${md.length}`);
  assert.match(fs.readFileSync(path.join(r, '.claude/handoff/.gitignore'), 'utf8'), /\*/);
});

test('inject hands the note to the next session; stale, other-branch and disabled cases stay silent', () => {
  const { r, g } = repo();
  run('save.mjs', r, { hook_event_name: 'SessionEnd', session_id: 's1', transcript_path: transcript(r), cwd: r });
  const out = run('inject.mjs', r, { cwd: r, source: 'startup' });
  const ctx = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /^\[handoff\] Notes from the previous session on branch main/);
  assert.match(ctx, /Add retry logic/);
  // new commits since the note
  fs.writeFileSync(path.join(r, 'b.txt'), 'b'); g('add', '.'); g('commit', '-q', '-m', 'more');
  assert.match(JSON.parse(run('inject.mjs', r, { cwd: r }).stdout).hookSpecificOutput.additionalContext, /1 new commit\(s\) since/);
  // other branch -> silent
  g('checkout', '-q', '-b', 'feature');
  assert.equal(run('inject.mjs', r, { cwd: r }).stdout, '');
  g('checkout', '-q', 'main');
  // disabled -> silent; stale (note is 10 days old) -> silent, unless the TTL allows it
  assert.equal(run('inject.mjs', r, { cwd: r }, { HANDOFF_DISABLE: '1' }).stdout, '');
  const f = path.join(r, '.claude/handoff/main.md');
  const old = new Date(Date.now() - 10 * 864e5).toISOString();
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/"ts":"[^"]+"/, `"ts":"${old}"`));
  assert.equal(run('inject.mjs', r, { cwd: r }).stdout, '');
  assert.match(run('inject.mjs', r, { cwd: r }, { HANDOFF_TTL_DAYS: '30' }).stdout, /10 d ago/);
});

test('trivial sessions (no work) do not overwrite or create a note; Stop is debounced', () => {
  const { r } = repo();
  run('save.mjs', r, { hook_event_name: 'SessionEnd', session_id: 's1', transcript_path: transcript(r, { withWork: false }), cwd: r });
  assert.ok(!fs.existsSync(path.join(r, '.claude/handoff/main.md')));
  const t = transcript(r);
  run('save.mjs', r, { hook_event_name: 'Stop', session_id: 's2', transcript_path: t, cwd: r });
  const f = path.join(r, '.claude/handoff/main.md');
  const first = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(t, fs.readFileSync(t, 'utf8') + JSON.stringify({ type: 'user', message: { content: 'a brand new request' }, origin: { kind: 'human' } }) + '\n');
  run('save.mjs', r, { hook_event_name: 'Stop', session_id: 's2', transcript_path: t, cwd: r });
  assert.equal(fs.readFileSync(f, 'utf8'), first);                       // within 15 s, same session
  run('save.mjs', r, { hook_event_name: 'SessionEnd', session_id: 's2', transcript_path: t, cwd: r });
  assert.match(fs.readFileSync(f, 'utf8'), /a brand new request/);       // SessionEnd always saves
});

test('manual notes survive automatic saves; clear removes the file', () => {
  const { r } = repo();
  const cli = (...a) => spawnSync('node', [script('handoff.mjs'), ...a], { cwd: r, encoding: 'utf8', env: env() });
  assert.match(cli('note', 'staging deploy needs VPN').stdout, /noted/);
  run('save.mjs', r, { hook_event_name: 'SessionEnd', session_id: 's1', transcript_path: transcript(r), cwd: r });
  assert.match(cli('show').stdout, /staging deploy needs VPN/);
  assert.match(cli('show').stdout, /Add retry logic/);
  cli('note', 'second note');
  assert.match(cli('show').stdout, /staging deploy needs VPN\n- second note/);
  assert.match(cli('clear').stdout, /cleared/);
  assert.match(cli('show').stdout, /no handoff/);
});

test('works outside git and with a missing/corrupt transcript without throwing', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-nogit-'));
  assert.equal(run('save.mjs', d, { hook_event_name: 'Stop', session_id: 'x', transcript_path: '/nonexistent', cwd: d }).status, 0);
  fs.writeFileSync(path.join(d, 'bad.jsonl'), 'not json\n{"type":\n');
  assert.equal(run('save.mjs', d, { hook_event_name: 'Stop', session_id: 'x', transcript_path: path.join(d, 'bad.jsonl'), cwd: d }).status, 0);
  assert.equal(run('inject.mjs', d, { cwd: d }).stdout, '');
});

test('an error that was followed by a success of the same command is not reported; commits of the session are', () => {
  const { r, g } = repo();
  const L = [];
  const ts = new Date(Date.now() - 60000).toISOString();
  const add = (o) => L.push({ timestamp: ts, ...o });
  add({ type: 'user', message: { content: 'fix the build' }, origin: { kind: 'human' } });
  add({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'make build' } }] } });
  add({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'boom' }] } });
  add({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'make build' } }] } });
  add({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b2', content: 'ok' }] } });
  fs.writeFileSync(path.join(r, 'c.txt'), 'c'); g('add', '.'); g('commit', '-q', '-m', 'Fix the build');
  const t = path.join(r, '..', 'tr-' + Math.random().toString(36).slice(2) + '.jsonl');
  fs.writeFileSync(t, L.map((x) => JSON.stringify(x)).join('\n'));
  run('save.mjs', r, { hook_event_name: 'SessionEnd', session_id: 's9', transcript_path: t, cwd: r });
  const md = fs.readFileSync(path.join(r, '.claude/handoff/main.md'), 'utf8');
  assert.doesNotMatch(md, /Last failing command/);
  assert.match(md, /## Commits this session\n[0-9a-f]+ Fix the build/);
});
