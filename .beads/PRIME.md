# Beads workflow context

Work here is tracked in Beads. `bd prime` prints this at session start, resume, clear and compaction; run it again when it is gone from context. Full routine: the `beads` skill. `B` = `node .agents/skills/beads/scripts/bead.mjs` (repo root): every write goes through it; reads use `bd` directly. No markdown TODO files; agent-local task tools only for the current turn.

## Session close

Before saying done or stopping: every bead this session claimed is closed or handed off (none left `in_progress` unless mid-task); work found outside it is filed as a follow-up; the reply names each bead claimed, created, closed or handed off.

## Reads (bd)

- `bd ready` — unblocked work · `bd list --status in_progress` — work in flight · `bd show <id>` — acceptance, notes, deps, lease
- `bd blocked` · `bd dep list <id>` · `bd human list` — open questions for the user · `bd memories <keyword>` · `bd search <query>`
- `--json` when parsing

## Writes (B)

| Need | Command |
| --- | --- |
| Start work: before the first edit, a branch or worktree; again when resuming | `B claim <id>` · `B heartbeat <id>` between steps of long work |
| Record a finding, decision or blocker | `B note <id> "<text>"` |
| New work the user asked for, no open bead covers it (first step) | `B request "<title>" --quote "<user's words, verbatim>" --grade <easy\|moderate\|hard\|complex>` |
| Work found outside the claimed bead | `B followup <from-id> "<title>" --description "<why, what>" --grade <g>` |
| Done and verified, leftovers filed | `B close <id> --reason "<what was done, how verified>"` |
| Stop unfinished | `B handoff <id> "<where it stopped>"` |
| A choice only the user can make, outliving the session | `B question <blocked-id> "<question>" --options "<a> \| <b>"`, then `B handoff <blocked-id> …` |
| The user's answer to a human bead | `B respond <id> "<their verbatim words>"` |
| Durable project knowledge, after the user accepts it | `B remember "<insight>"` |
| A gate's condition is met | `B gate-check [--type <t>]` |
| Dependencies, defer, supersede, anything else | `B apply <plan.json>` (`--dry-run` first) |

Priority `0`–`4` (0 critical, 4 backlog), never words. Every write in this table takes `--dry-run`.

## Rules

- An `in_progress` bead this session did not claim is another session's, even under the same actor name: never work it.
- Never widen a bead's scope silently; never close unverified work.
- No git commit, push, `bd sync` or Dolt push unless the user or repo grants it; never `bd init`, `bd edit`, `bd delete`, or a raw `bd create`/`update`/`close`.
- A factory section in `AGENTS.md` governs routed items.
- skill-fix-handoff installed → `node .agents/skills/skill-fix-handoff/scripts/handoff.mjs check` after the current chain; a fixed one → `skill-installer handoff`.
