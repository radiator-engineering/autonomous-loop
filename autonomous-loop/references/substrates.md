# Substrates: what drives the loop

The kernel (`kernel.md`) is the same no matter what runs it. The *substrate* is the machinery that
spawns the fresh-context workers and verifiers, holds the budget, and keeps the ledger. Three exist,
in preference order. The archetype and the atom don't change when you switch substrates — only the
wiring does.

## 1. Dynamic Workflow (default)

If the `Workflow` tool is available, generate a Workflow script from `assets/loop-template.js`. This
is the strongest substrate and the one the template is written for:

- **Per-agent context isolation is free.** Every `agent()` call is a fresh context — the anti-rot
  mechanism (kernel #6) is structural, not something you maintain.
- **`budget{total, spent(), remaining()}`** is the hard cost ceiling (kernel #7). The template's
  `withinBudget()` reserves `RESERVE` tokens so the finalize step can still run.
- **`parallel()` / `pipeline()`** give the per-round fan-out of workers and verifiers.
- **Per-agent `model` / `effort`** give tiering — the template's `TIER` map wires mechanical steps
  to a cheap model, workers/verifiers to a mid model, and blockers/escalation to a strong model.
- **`resumeFromRunId`** makes a long run resumable: an unchanged prefix of `agent()` calls replays
  from cache, so an interrupted loop continues instead of restarting. A resumed run is the *same*
  run — it keeps its `run_id` and appends to the same ledger, rather than opening a second one.

Wiring: fill the `<<PLACEHOLDER>>`s and the one `MODE` block you routed to, run
`node scripts/selfcheck_loops.mjs` (zero-token proof the stop logic is safe), launch
`python scripts/workbench_server.py <LEDGER_DIR>`, then invoke the script with the `Workflow` tool.
The driver runs in the background and writes `progress.json` every round.

## 2. In-session Agent fan-out (fallback)

No `Workflow` tool: drive the loop from the main session by dispatching `Agent` subagents each round.
You own the loop control flow (the `while` in the template becomes your turn-by-turn dispatch), and
the ledger lives in a scratch file you read and rewrite each round rather than in a Workflow's state.

Keep every kernel property intact — they do not come for free here:

- **Isolation:** one `Agent` per work item and one per verify item; never reuse a subagent across
  rounds, and never let the artifact accumulate in *your* context — pass it by path.
- **Worker ≠ verifier:** dispatch the verifier as a separate `Agent` (ideally a different model
  family via the `model` alias); it never sees the worker's reasoning.
- **Tiering:** the `model` alias per `Agent` call replaces the Workflow `TIER` map. Use
  `isolation:"worktree"` for parallel builders that would otherwise collide on files.
- **Counted / fail-closed / blocker gate:** you compute the count in the driver turn from the
  verdicts exactly as the template's LEDGER step does — a crashed/absent subagent is an unverified
  mandate, not a pass. Re-implement `openBlockers`/`hasOpenBlocker` in your bookkeeping.

This substrate is more visible and interruptible (you see each round in the session) at the cost of
consuming your main context — so it suits shorter runs and checkpointed autonomy.

## 3. Standalone committed harness (graduation / CI)

When the user wants the loop re-runnable in CI or fully inspectable, emit repo-committed scripts:
the driver, the rubric/queue/invariant set, and the atom's verify contract as real files, invoked by
a plain runner (a shell script or a small program) rather than an agent tool. Heaviest to set up and
most portable. This is the "graduate to files" path — only when asked; default to ephemeral.

The kernel properties become explicit code and CI assertions: the verify step shells out to the real
signal (tests, type-check, benchmark, a diff), the count is computed by the runner, and the
self-check ships as a CI job so a stop-logic regression fails the build.

## Choosing

Default to #1 whenever `Workflow` is available — the isolation, budget, and resume are worth it and
the template is built for it. Drop to #2 only when the tool is absent. Reach for #3 only when the
user explicitly wants a committed, re-runnable artifact. Whichever you pick, the observability
requirement is unchanged: a live `progress.json` plus per-round artifacts (`observability` in the
gauntlet-loop skill, or the archetype-specific "surface" note in `archetypes.md`).
