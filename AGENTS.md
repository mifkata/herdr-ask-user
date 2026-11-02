# herdr-ask-user

Agent skill for Prime Agent, Codex and Cursor inside herdr: asks the user numbered multiple-choice questions in a herdr pane or tab, depending on the calling environment, and returns the answers as JSON.

Maintained with the `agentsmd-writer` skill and audited by `agentsmd-auditor`: change this file only through them. Sections owned by other skills and marked blocks are theirs.

## Skills

- AGENTS.md changes → `agentsmd-writer`; audits → `agentsmd-auditor`
- Task tracking → `beads`; owns the Beads pointer block
- README writing → `readme-writer`
- Installed skill defect or missing capability → `skill-fix-handoff`
- Install, restore or update skills; apply a fixed handoff → `skill-installer`

## Workflows

- Bead work: `beads` claim → work → close
- AGENTS.md change: `agentsmd-writer` → `agentsmd-auditor`

## Authority

- Never without the user: push, delete anything outside the repo.
- Commit freely while working a bead; keep mechanical changes (installs, removals, generated or tool-written changes) uncommitted until approved.
- Ambiguity (unclear or conflicting requirements, several reasonable interpretations, trade-offs, scope, naming and public-interface choices, anything destructive or hard to reverse) or more than one viable path → stop and ask the user; never decide silently or pick a default.

## Subagents

- Every subagent spawn, any skill or runner, follows this section; skills read the model per role and grade here.
- Pick: `node .agents/skills/agentsmd-auditor/scripts/models.mjs pick <the role's models for the grade that this runner can spawn, in listed order>` → its `top` (the `model-pick` rubric: recorded success rate and runs; a tie → the first listed); `top` null → reported to the user; none it can spawn → its session model.
- Record each run: `node .agents/skills/agentsmd-auditor/scripts/models.mjs record <provider/model> <role> <grade> success|failure|escalated` (failure: error, timeout, refusal, or work sent back; escalated: handed to the next grade).
- Never pick a model `models.mjs stats` lists as excluded or `below` (under 60% after 15 runs; a model the registry keeps is never below).
- Vendors: design and the workers' and reviewers' `escalation` entries from Anthropic only; a runner spawning several vendors takes easy and moderate workers from xAI and OpenAI only; a model id names its maker, not the tool that runs it (a Cursor runner spawns `xai/grok-*`).
- Anthropic pacing (subscription limits, shared with every Claude session): at most 5 Anthropic subagents running at once, each start ≥5 s after the previous; "usage limit reached" or a rate-limit error → no new Anthropic subagent, the running ones finish, the rest go to xAI or OpenAI when the role allows, else reported.
- Vendor failure (a started run stops on a vendor's auth, session or quota error; unstarted Anthropic work: the pacing line): that vendor named to the user at once as needing a relogin, never silently rerouted; the user picks wait for the relogin | fail over; only the failed work stops, the rest goes on; after a relogin the same session continues; on a failover the new model resumes from the previous model's worktree and working record, never a fresh start.
- Grade (`easy` | `moderate` | `hard` | `complex`): the bead's `grade`; none → the `band` of `node .agents/skills/agentsmd-auditor/scripts/rubric.mjs score grade <scores.json>` (scope, files, risk, contracts, migrations scored 0–5 against the `grade` rubric's anchors), recorded on the bead with its score. The grade sets model and effort below; effort never above `medium` except complex's `high` (higher levels are for chat sessions).
- Escalation: a failed easy or moderate run or review → one grade up, picked again; a failed hard or complex run or review → one retry on the `escalation` entry (its effort); a failure there → reported to the user.
- Workers: easy low `openai-codex/gpt-6-luna`, `xai/grok-4.3`, `xai/grok-build-0.1`, `anthropic/claude-haiku-5-5`; moderate medium `xai/grok-4.3`, `openai-codex/gpt-6-luna`, `openai-codex/gpt-6-sol`, `xai/grok-4.5`, `anthropic/claude-haiku-5-5`; hard medium `xai/grok-4.7`, `xai/grok-4.6`, `openai-codex/gpt-6.1-sol`, `openai-codex/gpt-6-sol`, `anthropic/claude-sonnet-5-5`; complex high `openai-codex/gpt-6.1-sol`, `xai/grok-4.7`, `openai-codex/gpt-6-astra`, `anthropic/claude-sonnet-5-5`; escalation medium `anthropic/claude-opus-5-5`.
- Reviewers: easy low `anthropic/claude-haiku-5-5`; moderate medium `anthropic/claude-haiku-5-5`; hard medium `anthropic/claude-sonnet-5-5`; complex high `anthropic/claude-sonnet-5-5`; escalation medium `anthropic/claude-opus-5-5`.
- Design (`job: design`): medium `anthropic/claude-opus-5-5` only; no scored pick.

## Rules

- Commits: conventional commits; terse imperative subject, a body only when the why isn't obvious; one well-scoped logical change each.
- No attribution trailers: no `Co-Authored-By`, "Generated with" or similar.
- Code comments: none unless essential (a config value, or a constraint whose violation breaks functionality or business logic); never decisions, Beads issue IDs or spec references → those belong in the issue, the commit or the spec.
- A question stands alone, so the user never opens a file, runs a command or looks anything up: Context (what you are doing, what you found with the relevant code, output or issue text quoted, why a decision is needed), Options (every viable option: what it does and changes, benefits, costs, risks, effort), Recommendation (your pick and why, marked as a suggestion, not a decision).
- Until the user answers, skip the affected work and continue what does not depend on it.
- A defect in an installed skill (its text contradicts a tool, a script fails, a case is missing) or a capability it lacks that a workaround covered (a raw shell command its script has no subcommand for) → `skill-fix-handoff` (files a GitHub issue on agent-foundry; its URL to the user at once and in the final reply), never a local edit of the installed copy under `.agents/skills/` or a runtime skill dir.
- Open skill handoffs: after a long chain of work and on request → `node .agents/skills/skill-fix-handoff/scripts/handoff.mjs check`; a fixed one → `skill-installer` reinstalls the skill and records the migration.

## Docs

- `docs/agents-md/`: Subagents models, rule provenance, audit findings and model outcomes; written through `agentsmd-writer` and `agentsmd-auditor` only.
- `herdr-ask-user/SKILL.md`: the skill's agent-side contract (questions JSON, result, exit codes); read before changing `scripts/ask-user.mjs`.

<!-- beads:skill -->
## Task tracking (Beads)

Work is tracked with Beads (`bd`). Load the `beads` skill before any `bd` command or task-tracking step and follow it; it holds the whole workflow. No markdown TODO lists; agent-local task tools only for the current turn.
<!-- /beads:skill -->

<!-- rtk-instructions v2 -->
# Command output

Command output here is condensed to save tokens, keeping every signal and
dropping costly noise. Treat it as the complete result: run commands
normally, and batch related commands into one call to avoid extra turns.
Truncated results state their recovery path in their own output. Re-run a
command as `rtk bypass <cmd>` only when its result is unusable: empty when
output was clearly expected, contradicting its exit code, or garbled.
<!-- /rtk-instructions -->
