# session-handoff – a compact hand-over between Claude Code sessions

When a session ends (or is compacted), this plugin saves a short "where we left off" note for the current Git branch. The next session on that branch receives it automatically – about 300 tokens instead of re-exploring the repo or re-explaining the task.

No model call, no dependencies (Node ≥ 18), nothing leaves your machine.

## What the note contains

Built from the session transcript and Git, never from a summary request:

| Section | Source |
|---|---|
| Goal | first real user prompt in the transcript tail |
| Last requests | last 3 real user prompts (system reminders and background notifications are filtered out) |
| Where it stopped | the last assistant message |
| Open todos | last `TodoWrite` list, completed items dropped |
| Files touched | `Edit` / `Write` / `MultiEdit` / `NotebookEdit` |
| Commits this session | `git log --since=<session start>` (covers work done through Bash) |
| Last failing command | only if recent **and** the same command did not succeed afterwards |
| Uncommitted | `git status --short` |
| Notes | your own notes, kept until cleared |

Real example (this repo's own session, 700 transcript entries): 1.1 KB ≈ 280 tokens.

## When it runs

| Event | Action |
|---|---|
| `Stop` (after each turn) | save, debounced to once per 15 s per session |
| `PreCompact`, `SessionEnd` | save |
| `SessionStart` (`startup`, `clear`) | inject the note for the current branch if it is ≤ 3 days old |

Sessions without real work (no goal, or nothing touched/committed/failed/open) do not create or overwrite a note. The injected header says how old the note is and how many commits landed since, and tells Claude to verify before relying on it.

## Commands

- `/session-handoff:note <text>` – add a manual note (kept until cleared), e.g. *"staging deploy needs the VPN"*
- `/session-handoff:show` – print the note for this branch
- `/session-handoff:clear` – delete it

CLI: `node scripts/handoff.mjs show | note "<text>" | clear | path`

## Verified

- 6 unit tests (synthetic transcripts, branches, staleness, debounce, notes, no-git, corrupt transcript).
- Real Claude Code, headless: session 1 created two files; the hooks wrote `.claude/handoff/main.md`; a fresh session 2 received `[handoff] …` and answered *what was done and what is open* with **zero tool calls**.
- The parser was run against a real 700-entry transcript and fixed twice because of it (stale errors, work done via Bash).

**Not measured:** token savings. The note costs ≈ 300 tokens per session start; whether that is cheaper than re-orienting depends on the task. I have not run a with/without benchmark for this plugin.

## Storage and privacy

`<project>/.claude/handoff/<branch>.md`, with a `.gitignore` (`*`) created next to it so it is never committed. It contains excerpts of your prompts and the assistant's last message – keep that in mind for shared machines. Override the location with `HANDOFF_DIR`.

## Settings (env)

| Variable | Default | Meaning |
|---|---|---|
| `HANDOFF_TTL_DAYS` | 3 | maximum age of a note that is injected |
| `HANDOFF_MAX_TOKENS` | 500 | cap for the injected text |
| `HANDOFF_DIR` | `.claude/handoff` | storage location |
| `HANDOFF_DISABLE` | off | `1` disables saving and injecting |

## Limits

- **Local only.** Cloud sessions run in ephemeral containers; the note is lost when the container is reclaimed, unless the next session reuses it.
- **Heuristics, not understanding.** "Goal" is the first prompt inside the last 3 MB of the transcript, which can be a later prompt in very long sessions. "Where it stopped" is simply the last assistant message.
- `Stop` runs after every turn (tens of milliseconds: it reads the transcript tail and calls `git` three times).
- One note per branch; the next session that does real work overwrites it.

## Install

```
/plugin marketplace add theslasher5g/session-handoff
/plugin install session-handoff@session-handoff
```

## Tests

`node --test`
