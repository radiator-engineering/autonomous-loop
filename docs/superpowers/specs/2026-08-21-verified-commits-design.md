# Verified Commits
### The tree advances only through verified changes — subtask 2 of issue #8
*JJ Martin · 2026-08-21 · design spec*

---

## The bottom line, up front

Subtask 1 (`footprint.jsonl`, PR #10) made "this item's leftovers" *computable* but not
*discardable-without-judgment*: a retry worker still had to read a diff and decide what to keep. This
spec closes that gap by making the working tree commit-per-verified-pass: the **Ledger step**, already
the one place per round where a single agent runs after all of that round's verifiers have answered,
reads `footprint.jsonl` for every item that just passed and commits that item's claimed files, one
commit per item, before doing anything else. The canonical artifact becomes literally what its name
implies — the last commit on the branch — and a retry worker's leftover diff on its own claimed files
stops being a judgment call: nothing verified is ever left uncommitted, so anything sitting there is
safe to discard unconditionally.

| Piece | Where | What it buys |
|---|---|---|
| Commit-per-pass | the Ledger step, extended (`writeLedger`) | HEAD is always the last green commit; a passed item's work survives being someone else's retry |
| `VERIFIED_COMMITS` config knob | Config, beside `ACTIVITY_LOG` | on for a git-backed target, off (no-op) for a substrate with no working tree to commit |
| Retry directive, simplified | `retryDirective` | "read the diff and judge" becomes "reset unconditionally" — the judgment subtask 1 asked the retry worker to make is no longer necessary for its OWN claimed files |

---

## Who commits — and why not the verifier

The ticket names two candidates: the verify step commits directly, or the coherence/ledger step
batches it. **This spec picks the ledger step, and rejects the verify step, for a concrete reason: the
driver runs verifiers for one round's batch in parallel (`parallel(worked.map(...))`, bounded by
`BATCH`), and `git commit` is not a concurrency-safe operation against one shared working tree.** Two
verify agents each running `git add && git commit` against the same `.git/index` at the same wall-clock
time do not corrupt anything — git's lockfile discipline prevents that — but the second one to reach
the lock gets `fatal: Unable to create '.git/index.lock': File exists.` and its commit is simply lost.
A verifier that legitimately passed an item would have nothing on the tree to show for it, which is
exactly the un-recorded-pass failure mode this subtask exists to eliminate, reintroduced by the fix
meant to close it.

The Ledger step does not have this problem, because it already **is** the single point of
serialization the round funnels through: one agent, dispatched once per round, after every verifier in
the batch has returned (`phase('Ledger')`, after the `verdicts` loop). Extending its one prompt with
"commit these items' claimed files, in order, before you touch progress.json" costs no new agent and no
new round — the same reasoning that already justifies appending `newClaims` to its existing prompt
rather than dispatching a second writer.

**Batching means one agent, sequential commands — not one squashed commit.** The instruction is
explicit: one `git add -A -- <files>` / `git commit` pair per passed item, in the order the driver
lists them, never a single commit covering the round. `BATCH>1` collapsing into one commit would lose
per-item revertibility — exactly the property "the canonical artifact is the last green commit"
depends on to mean anything (bisecting to the item that broke something requires that each commit
*be* one item).

## What gets committed, and the honesty gap it inherits

The driver computes, in code, which items passed this round (`v.pass`, the same predicate the LEDGER
loop already branches on) and their ids and evidence text — nothing new to compute, since `roundAccepted`
already tracks a version of this. It hands the ledger agent the list of ids; the agent itself reads
`footprint.jsonl` (the driver still has no filesystem access) and takes the union of `"files"` across
every claim line for that id, then stages **only those paths** — `git add -A -- <files>`, never a bare
`git add -A`. A bare add would sweep in a *different*, still in-flight item's uncommitted edits from the
same `BATCH>1` round and attribute them to the wrong commit — the collision hazard subtask 1 already
named, now with a commit-shaped consequence if ignored.

This inherits subtask 1's own honesty flag rather than closing it: **a worker that under-claims its
footprint gets a commit that is narrower than its real diff.** The excess sits uncommitted past the
round it was made in, indistinguishable from another item's leftover, and a later retry's unconditional
reset (below) can erase it if the paths collide. This was already possible before this subtask — an
under-claimed footprint already broke the retry directive's attribution — and this spec does not
strengthen the claim/close protocol to close it; it only makes the failure mode's *consequence* sharper
(erased, not just misattributed). Named here rather than silently inherited.

## The retry worker's instruction, before and after

Subtask 1 left the retry worker with a genuine judgment call: *"for each leftover change, either revert
it or re-derive it and deliberately adopt it — never let an inherited edit satisfy the done-criterion
unexamined."* That sentence exists because, at the time, a leftover diff on the item's claimed files
*could* legitimately hold a prior pass with nothing recorded elsewhere.

With commit-per-pass in place, that possibility no longer exists by construction: a pass is committed
the round it happens, so the working tree can never hold a verified pass that isn't already at HEAD.
**The retry worker's instruction becomes unconditional rather than evaluative:** read
`footprint.jsonl` for this item's claimed files (unchanged from subtask 1 — this is still the only
record of *which* files, since the dead attempt is often the one that crashed before reporting
anything else), then `git checkout -- <tracked file>` / `git clean -f -- <path>` on every one of them,
with no inspection step in between. There is nothing left to evaluate — a genuine pass would already be
a commit, so anything still sitting in the diff is, by construction, either this same item's own dead
attempt or (see the honesty gap above) another item's under-claimed excess. The instruction still names
only the item's *own* claimed files, so it does not reach into a neighbor's territory on its own say-so.

**What this does not solve, and is not new:** two concurrently-dispatched items whose footprint claims
genuinely collide on a file (subtask 1's "claim collision," surfaced at finalize, never gated) remain
equally possible after this change. If item A is mid-edit on a file B also claims, and B's retry fires
in the same round, B's unconditional reset can still erase A's in-flight, uncommitted work — exactly as
a judgment-based revert could before. Commit-per-pass does not touch this because A's edit, being
in-flight, is by definition not yet a commit either. This spec does not attempt to fix cross-item
collision; subtask 1 already declared that "surface, don't gate" and this spec inherits the same
boundary.

## `VERIFIED_COMMITS` — a config knob, not a kernel branch on `MODE`

Not every target this template drives is a git working tree — `substrates.md` lists a design canvas, a
live system under a sentinel's watch, a rubric artifact that may not be version-controlled at all.
Forcing `git commit` unconditionally into the Ledger step's prompt would make a run against a non-git
target either fail a step that has no business failing (the Ledger step also owns `progress.json` and
`HANDOFF.md` — both REQUIRED, gated by the witness/documented rungs) or silently no-op in a way nothing
records.

`VERIFIED_COMMITS` (default `true`, beside `ACTIVITY_LOG` in Config) resolves this the same way
`ACTIVITY_LOG` resolves observability cost: a boolean a run sets once, read by the kernel functions
that care (`writeLedger`, `retryDirective`), never branched on by `MODE`. When it is `true`, the
commit instructions are still qualified defensively — *"if this working tree is not inside a git
repository, skip commits entirely and say so in your report; do not fail the round over it"* — so a
misconfigured knob demotes to a no-op rather than a stuck Ledger step. `retryDirective` reads the same
constant to choose which of its two instruction texts to emit (unconditional reset vs. subtask 1's
judgment-based text), so a run with commits turned off keeps the exact safety net it had before this
change, and does not silently start discarding diffs it has no record of ever having committed.

## Parallel workers on one tree (`BATCH>1`) — the full interaction, stated once

Three things happen to a shared working tree across one round, and the ordering is what makes all three
safe together:

1. **Work** (parallel, up to `BATCH` items) — workers edit disjoint files by convention, footprint
   claims make the intended disjointness *checkable* (subtask 1), but nothing enforces it during the
   round itself. Concurrent edits to genuinely disjoint files are safe at the filesystem level; a claim
   collision is a live hazard, surfaced only at finalize.
2. **Verify** (parallel, one per worked item) — read-only with respect to the tree in every case this
   spec changes; verifiers do not commit (see above).
3. **Ledger** (one agent, sequential) — the only step in the round that writes to `.git`. It commits
   passed items one at a time, in the driver's own listed order, so two commits are never racing for
   the index lock and each one lands on top of the one before it. This is what "canonical artifact =
   last green commit" is allowed to mean under `BATCH>1`: not that every pass lands in commit order
   relative to when its *worker* finished (workers finish in whatever order `parallel()` resolves them),
   but that every pass that reaches Ledger commits in the deterministic order the driver hands the
   agent, and HEAD after the round reflects the round's full pass set with one commit per item.

## What deliberately does NOT change

- **The status ladder, the witness gate, `AUDIT_SCHEMA`.** Commits are not evidence in the witness
  gate's sense (a hero capture) and are not consulted by `witnessVerdict`. Nothing about `blocked` →
  `evidence_regressed` → … changes.
- **`VERDICT_SCHEMA` / `LEDGER_SCHEMA`.** No new field. The ledger agent's report about what it wrote
  into `progress.json`/`HANDOFF.md` is unchanged; commit success or failure is not fed back into any
  gate, consistent with "surface, don't gate" — a run whose Ledger step could not commit (no git repo,
  a merge conflict it cannot resolve, a detached HEAD) still writes the required observability files
  and still advances the state machine on the verdicts, exactly as before.
- **`footprintDirective` and the finalize reconciliation instruction.** Both are untouched. Finalize
  still compares claimed files against `git status --porcelain`; the only change is that, in practice,
  fewer files show up in that diff once passes stop lingering there — which is the reconciliation
  becoming *more* accurate at its existing job, not a new job for it. Subtask 1's honest limit ("work a
  run committed along the way escapes this comparison") is superseded, not contradicted: escaping is
  now correct, because committed work is accounted for at HEAD rather than being residue.
- **Worker ≠ verifier, fail-closed verdicts, directive byte-identity.** `retryDirective` and
  `writeLedger`'s new instructions are both constant for a given `(item, round-of-attempts)` /
  `(round, passed-ids)` respectively — no clock, no attempt counter interpolated beyond what the
  kernel already interpolates elsewhere (`newClaims`, `blockers`) — so the `stuck` scenario's
  byte-identity invariant (a failing item's attempts 2..STUCK_AFTER share one prompt) is unaffected:
  `VERIFIED_COMMITS` is fixed for the run, so which of `retryDirective`'s two branches fires does not
  vary attempt to attempt.
- **No coherence-step involvement.** Coherence runs *before* verify and is optional per archetype;
  commits are keyed off verify's *output*, so Ledger — which already runs after every verify in the
  round — is the only phase in the right causal position.

## Testing

Red-first, extending `selfcheck_loops.mjs`'s existing exhauster scenarios (`retryGetsTreeWarning`,
`workClaimsFootprint`, `finalizeReconcilesFootprint` are the pattern):

- **`ledgerCommitsPassedItems`** — an item passes; the `ledger` prompt for that round names the id,
  instructs reading `footprint.jsonl`, and instructs `git add -A -- ` / `git commit` scoped to that
  item, never a bare `git add -A`.
- **`ledgerSkipsFailedItems`** — an item fails verify this round; the same round's `ledger` prompt does
  not name it among the items to commit. (Paired with the pass case so the list is proven to be exactly
  the passed set, not "every item touched this round.")
- **`retryResetIsUnconditional`** — an item fails once then passes on retry; its second `work:` prompt
  carries the unconditional-reset text (`git checkout`, `git clean`, "nothing to evaluate") and NOT
  subtask 1's judgment language ("either revert it or re-derive it"), while the first prompt is
  unaffected — extends `retryGetsTreeWarning`'s byte-identity assertion rather than replacing it.
- `VERIFIED_COMMITS` itself follows `ACTIVITY_LOG`'s existing precedent: a Config boolean read directly
  by the kernel, not a per-scenario fill marker, and (like `ACTIVITY_LOG`) not separately exercised
  in its off-state by `selfcheck_loops.mjs` — the off-branch is a one-line `if` proven correct by
  inspection, same as `activityDirective`'s own early return.
- Every existing scenario must stay green unchanged: this is a kernel change, so a mode-specific
  regression (converger, saturator, explorer, sentinel all dispatch through the same `retryDirective`/
  `writeLedger`) has nowhere to hide.

## Honesty flags

- **Under-claimed footprints produce under-committed passes** — inherited from subtask 1, sharpened
  here: the excess is now erasable by a colliding retry's unconditional reset, not merely
  misattributed. Not fixed by this spec; named so it is not rediscovered as a surprise.
- **A Ledger step that cannot commit (dirty submodule, detached HEAD, a merge in progress) degrades to
  a no-op for that round's commits, silently from the driver's point of view** — the agent's own report
  is the only trace, and nothing gates on it, per "surface, don't gate." A run with a broken git state
  for several rounds accumulates several rounds' worth of passes as one eventual uncommitted pile,
  which is the pre-subtask-2 failure mode returning under a specific fault rather than by default.
- **Cross-item claim collision, unresolved.** Stated above under "what this does not solve" — repeated
  here because it is the one hazard subtask 3 (attempt isolation, separate worktrees per attempt) is the
  actual structural cure for, and this spec should not be read as having quietly absorbed that job.

---
**The one-liner for the room:** *A pass that isn't a commit is a rumor; this spec turns every verified
pass into one, in the one place per round that can do it without racing another agent for the same
lock.*
