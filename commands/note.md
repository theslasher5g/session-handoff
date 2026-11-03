---
description: Add a manual note to the hand-over for the next session (kept until cleared)
argument-hint: <what the next session should know>
allowed-tools: Bash(node:*)
---
Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/handoff.mjs" note $ARGUMENTS` (pass the text as ONE quoted argument) and reply only with its output.
