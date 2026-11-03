#!/usr/bin/env node
// Stop / PreCompact / SessionEnd hook: write the hand-over note for the current branch. No model call, never blocks.
import { readStdinJson, readTranscript, digest, render, readHandoff, writeHandoff, notesOf, parseMeta, branchOf } from './lib.mjs';

const ev = await readStdinJson();
try {
  const cwd = ev.cwd || process.cwd();
  if (process.env.HANDOFF_DISABLE === '1') process.exit(0);
  const branch = branchOf(cwd);
  const prev = readHandoff(cwd, branch);
  // debounce the per-turn Stop hook
  const pm = parseMeta(prev);
  if (ev.hook_event_name === 'Stop' && pm && pm.session === ev.session_id && Date.now() - Date.parse(pm.ts) < 15000) process.exit(0);
  const d = digest(readTranscript(ev.transcript_path), cwd);
  const { md, worthSaving } = render({ d, cwd, sessionId: ev.session_id, notes: notesOf(prev) });
  if (worthSaving) writeHandoff(cwd, branch, md);
} catch { /* a hand-over note must never break a session */ }
process.exit(0);
