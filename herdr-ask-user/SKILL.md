---
name: herdr-ask-user
description: Ask the user one or more multiple-choice questions in a herdr pane or tab (numbered options, free-text "Other" answers, a question queue); answers come back as JSON. Use whenever you need a decision, a choice between options or a clarification from the user while running inside herdr. Not for Claude Code, which has its own AskUserQuestion tool.
compatibility: Requires herdr (HERDR_PANE_ID set) and Node.js. Not for Claude Code.
---

# herdr ask-user

In Claude Code, use the built-in AskUserQuestion tool instead; this skill refuses to run there.

## Ask

Write the questions as JSON and run the script; it opens below your pane (a full-screen tab when the user is attached over SSH), waits for the user, closes it and prints the answers:

```bash
node <skill-dir>/scripts/ask-user.mjs questions.json   # or pipe JSON and pass -
```

```json
[
  {"question": "Which database?", "context": "Optional text shown above the options.",
   "options": [{"label": "Postgres", "description": "Shown below the title."}, "SQLite"], "recommended": 1}
]
```

- `question` and `options` are required; `context` and `recommended` (option number) are optional.
- `recommended` adds the "(recommended)" marker to that option's title; do not write it in the label. A bracketed `recommend` or `recommended` left in that label is removed, in the title and in `answer`. With `recommended` unset, a single option holding that marker counts as recommended; several stay as typed.
- An option is a string, or an object with `label` and an optional `description`, shown on its own line under the title. The result's `answer` is the label.
- Put everything the user needs to decide into `context` and the option texts: the user sees only the question screen.
- Any number of questions; the user can move between them and submits all answers on a final review page (skipped for a single question).

The call blocks until the user answers. In Prime Agent, run it with `bash(..., yield_after=300)`; if it is still running, end the turn and read the result from the `[bash-done]` notification.

## Result

```json
{"cancelled": false, "answers": [
  {"question": "Which database?", "choice": 1, "answer": "Postgres"},
  {"question": "...", "choice": 2, "answer": "SQLite", "notes": "text after \"2 +\""},
  {"question": "...", "choice": null, "answer": "free text", "other": true}
]}
```

- `cancelled: true`: the user pressed Esc or Ctrl+C, or closed the question; `answers` holds what was answered before. Do not re-ask unprompted.
- `notes`: the user picked option N through Other as `N + notes`; treat the notes as part of the answer.

## Exit codes

- `0`: answered or cancelled (see `cancelled`).
- `2`: invalid questions JSON; fix it and retry.
- `3`: not inside herdr, or running in Claude Code; ask the user in chat instead.
- `4`: herdr could not open the question; ask in chat and report the error.
