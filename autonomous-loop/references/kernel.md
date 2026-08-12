# The kernel: what every autonomous loop shares

The frontier and the stop predicate change per archetype (`archetypes.md`). Everything else is the
same, and *this* is where correctness lives. The kernel is seven properties. Each maps to a
documented way self-improvement loops fail; this file states the general form and stands on its own.
`references/failure-modes.md` has the research citations and the converger-specific mechanism.
Treat these as non-negotiable — a loop missing any one of them fails the way ungrounded loops
always fail.

The bundled `assets/loop-template.js` implements all seven once, in the kernel body, for every
archetype. You should not be re-deriving them per run; you should be checking they're intact
(`scripts/selfcheck_loops.mjs`).

## 1. Worker ≠ verifier

The agent that produces an atom never certifies it. There is a *causal* link between a model
recognizing its own output and preferring it — self-preference isn't a bias you can prompt away, and
a self-graded loop systematically over-scores itself and stands still while congratulating itself.
Use a separate verifier, ideally a different model family. The worker never sees the exact
pass threshold; the verifier never sees the worker's reasoning.

## 2. Ground every "done" externally

A verifier may only pass an atom it can tie to a concrete, checkable signal — a failing/passing
test, a measured value against a target, a diff against a reference, a reproduction. Never "looks
done," and never an unconditional "are you sure? try again" (challenging a model reliably flips
correct work to incorrect). When a model critiques its own reasoning with no external signal telling
it *when* it's wrong, it changes right answers to wrong more often than the reverse — most of those
flips are the critic inventing a defect in something already correct. External grounding is the
thing that makes iteration help instead of hurt.

## 3. Count, don't vibe

The progress number the loop watches is a **deterministic function of verified atoms, computed in
the driver** — items closed, findings confirmed, claims grounded, invariants holding. Never a
holistic `0..1` score a model emits. Two reasons:

- **Stability.** The stop predicate compares progress across rounds. A model-emitted gestalt jitters
  (±0.05 for the identical state), so a counted metric is the only way a stop fires on real signal
  instead of noise.
- **Gaming.** A free-form score is exactly what verbosity and self-preference inflate. A count of
  grounded, evidence-tied atoms has nothing to inflate.

So a verifier's job is to decide each atom's pass/fail *with evidence*; the driver does the
arithmetic. This is the single most important thing that separates a loop that converges from one
that drifts.

## 4. Fail closed

A worker or verifier that crashes, times out, or returns nothing is an **unverified mandate — not a
pass.** This is the subtle, high-consequence rule:

- The item does **not** advance to "done." It returns to the frontier under a bounded retry budget,
  and after the budget is spent it becomes a *blocked* item.
- The unverified atom must **not vanish from the denominator.** If you silently drop a crashed
  verifier (the tempting `.filter(Boolean)`), its atoms disappear from the count and the progress
  number *inflates* — a dead verifier can let the loop declare victory over work it never checked.
- The run cannot report a **positive terminal status** while any mandate this round went unverified.
  A missing verdict is a verification gap, and a gap blocks a positive finish the same way a blocker
  does.

The failure this prevents is concrete and easy to ship by accident: an exhauster whose verifier
crashes on 10 of 500 items reporting "done, 98%" — with those 10 shipped unverified. Fail-closed
makes that a `blocked` run with 10 named blocked items instead.

## 5. Blockers gate hard

A blocker is an atom whose failure is disqualifying — a critical safety criterion, a data-loss
migration step, a refuted load-bearing claim, an unrepairable invariant. An open blocker **pins the
terminal status to `blocked`**, full stop. It can never be:

- **averaged away** — 19/20 passing (0.95) with one blocker open is `blocked`, not a 95% pass;
- **dried away** — a saturator can't reach `saturated` while a blocker is open, even after quiet
  rounds; a flat progress series with a blocker underneath is not a plateau, it's a failure to
  escalate;
- **retried into silence** — an item that exhausts its retries becomes a *named* blocker, not a
  skip.

Route a blocker to the escalation tier (a stronger model, sole owner) from the first round it
appears — a blocker is what stands between the loop and a clean finish, so spend on it up front.

A blocker also **ends** the run, but not on sight: the loop's job is to fix things, so it keeps
fixing. `BLOCKER_PATIENCE = 3` counts only the rounds in which a blocker — or an unresolved
verification gap, which fails closed the same way — is open **and nothing new was confirmed**; only a
newly confirmed atom resets the counter to 0. So a run still producing verified atoms carries an
immovable blocker forward and reports `blocked` when its own terminal predicate fires, while a run
that has stopped producing them terminates `blocked` on its `BLOCKER_PATIENCE`th standstill round.
Those rounds need not be consecutive: a clean round in between HOLDS the count, or a violation that
clears and reopens on alternate polls would hold patience open forever with nothing ever verified
fixed. Patience counts standstill, not calendar — the earlier rule counted calendar and killed a
saturator that was confirming four new findings a round. An open blocker disables the positive gate
and pins the terminal status: a plateau reached while a blocker — or an unresolved verification gap —
is open still ENDS the run, but it ends it `blocked`, never `stopped`. The plateau decides when a
standing-still run stops; the blocker decides what that ending is called. Patience bounds the gated
run that never gets to a plateau — an exhauster or a sentinel has none, and a converger whose
`DRY_ROUNDS` exceeds its patience runs out of patience first.

## 6. Isolation and anti-rot

Every worker and verifier runs in a fresh context — this *is* the mechanism that lets the loop run
indefinitely without instruction-following decaying. Two rules keep it that way:

- **Pass by path.** The artifact, the queue, the ledger — hand them as file paths. Anything pasted
  into the driver's own context stays resident and re-read every round, which reintroduces rot in
  the one place that's supposed to stay thin.
- **Re-anchor, don't accumulate.** Where a loop has a frozen goal (a converger's bar, a sentinel's
  invariant set), re-inject it verbatim each round rather than letting it smear across accumulated
  critique. Summarize prior results into a stable ledger, not a growing transcript.

The ledger is per **run**, and the vocabulary is load-bearing: a *run* is one invocation of the
driver; a *round* — a *wave* — is one cycle inside it. A run resumed with `resumeFromRunId` is the
**same run** and keeps its `run_id`; resuming never starts a new one. So `progress.json` holds the
rounds of exactly one run, and `runs.jsonl` gets one line per run, written at terminal status —
rewrite the line whose `run_id` matches, append only when there is none. Blur the two and the ledger
collides: rounds from two runs under two different rubrics were written into one `rounds[]` array
and overwrote each other.

Both records carry `hitBackstop` alongside the terminal status. Four statuses outrank a backstop hit
in the ladder — `blocked`, `budget_exhausted`, the archetype's own positive status (a sentinel's
`held` is always positive), and `inconclusive`, the archetype's own non-positive ending — and that
order is deliberate: a blocker or a spent budget is the more actionable fact, and an explorer that
dried out says so more usefully than the rail does. The cost is that a run which rode to
`RUNAWAY_BACKSTOP` finishes under a softer label, so the rail hit is visible only because it sits on
its own field. To ask "did the stop predicate work," read the boolean, not the status.

## 7. Budget ceiling + tiering

Each round costs LLM calls; panels and retries multiply them, and gains concentrate in the early
rounds. So: a hard token ceiling (`budget.total` in a Workflow, with a reserve so the finalize step
can still run), cheap models for mechanical steps (frontier bookkeeping, ledger writes), mid models
for workers and verifiers, and strong models only for stuck items and escalation. The stop predicate
is itself a cost control — the biggest single token lever is not running rounds that have already
stopped producing verified progress.

## Why these are *in the loop*, not left to a human

The pure-prompt version of every loop ("just keep improving it until I say stop") works in practice
only because a human silently supplies guardrails 1, 2, 4, and 5 by watching. The moment you
automate the loop to run for hours unattended, those guardrails have to be *in the code* — that is
the entire reason this skill generates a driver with a self-check rather than handing you a clever
prompt. The self-check (`scripts/selfcheck_loops.mjs`) exists precisely because guardrails 3, 4, and
5 are the ones a plausible-looking driver gets subtly wrong, and a subtle stop-logic bug is
invisible until it has already wasted a long run or shipped unverified work.
