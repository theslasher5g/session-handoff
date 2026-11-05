#!/usr/bin/env node
// SessionStart hook: give the new session the note saved by the previous one (same branch, fresh enough).
import { readStdinJson, readHandoff, parseMeta, branchOf, rootOf, git, estTokens } from './lib.mjs';

const TTL_DAYS = Number(process.env.HANDOFF_TTL_DAYS) || 3;
const MAX_TOKENS = Number(process.env.HANDOFF_MAX_TOKENS) || 500;

const ev = await readStdinJson();
if (process.env.HANDOFF_DISABLE === '1') process.exit(0);
const cwd = rootOf(ev.cwd || process.cwd());
const md = readHandoff(cwd, branchOf(cwd));
const meta = parseMeta(md);
if (!md || !meta) process.exit(0);
const ageH = (Date.now() - Date.parse(meta.ts)) / 36e5;
if (!(ageH >= 0) || ageH > TTL_DAYS * 24) process.exit(0);

let body = md.replace(/^<!-- handoff .*? -->\n+/, '');
if (estTokens(body) > MAX_TOKENS) body = body.slice(0, MAX_TOKENS * 4 - 1) + '…';
const since = meta.head ? Number(git(cwd, ['rev-list', '--count', `${meta.head}..HEAD`])) : 0;
const age = ageH < 1 ? `${Math.max(1, Math.round(ageH * 60))} min` : ageH < 48 ? `${Math.round(ageH)} h` : `${Math.round(ageH / 24)} d`;
const head = `[handoff] Notes from the previous session on branch ${meta.branch}, ${age} ago${since > 0 ? `, ${since} new commit(s) since` : ''}. Orientation only – verify against the code before relying on it.`;
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `${head}\n${body}` } }));
