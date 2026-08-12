# Setting Claude loose on your Next.js app — what to run, and why

## The short answer

Don't run one "improve the app" loop. You have three different problems, and they are three
different *shapes* of autonomous work. Forcing them into one loop is the single most expensive
mistake here — it either never terminates, or it declares victory it didn't earn.

Run this sequence:

1. **De-flake the test suite first** (a discovery pass, then a fixer loop). This is a hard
   precondition, not the least glamorous chore. Every other loop's definition of "done" is
   "a test passed / a benchmark improved and nothing regressed." If the suite is flaky, that
   ground truth is a coin flip, and *every* downstream loop inherits the noise.
2. **Then, in parallel:** a bug-backlog loop (drain the Linear queue) and a perf loop (drive the
   two slow routes under a latency bar).
3. **Optionally, afterward:** a standing watch that keeps `main` green, latency in-bounds, and
   catches new flakiness/regressions as they land — because your backlog is *growing*.

The rest of this doc explains the routing that produces that sequence, the exact stop condition
and verify contract for each loop, and how they actually run.

---

## Why not just "point Claude at the repo and let it cook"

The naive version — "keep improving it until it's good" — works when a human is watching, because
the human silently supplies the guardrails: they notice when it's fixing nothing, they catch it
grading its own homework, they stop it before it burns the budget polishing something unmeasurable.
The moment you make it autonomous and unattended, those guardrails have to be *in the code*, or the
loop fails the way ungrounded loops always fail:

- **It drifts** — with no fixed target, "better" wanders.
- **It games its own judgment** — an agent that scores its own output systematically over-scores it
  (self-preference is causal, not a bias you can prompt away). It congratulates itself while
  standing still.
- **It burns tokens with a confident green number on top** — declaring "done" on work nothing
  actually checked.

So the design below is built around two non-negotiables: every worker runs in a **fresh context**
(no transcript rot, so it can run for hours), and **every "done" is tied to a concrete external
signal by a *different* agent than the one that did the work**, with progress *counted* from those
verified signals rather than read off a model's vibe. That is the whole difference between a loop
that converges and one that just runs.

---

## Routing: your three problems are three archetypes

The method has exactly five loop shapes, distinguished by two knobs: **the frontier** (where the
next unit of work comes from) and **the stop predicate** (how you know you're done). Here's how each
of your problems classifies, and — the make-or-break step — whether each one's unit of work is
**cheaper to verify than to produce**. If a unit can only be judged by taste, that's not a loop;
that's a budget bonfire, and the honest move is to say so and build the missing measurement first.

### 1. Flaky tests → **Saturator, then Exhauster** (discover the set, then drain it)

You said "a handful," but you almost certainly don't have the exact list — flakiness is
probabilistic, so you can't enumerate it up front. Finding the members *is* part of the work. That's
a **saturator**: run the suite many times with diverse conditions (parallelism on/off, shuffled
order, retries disabled, slow-CI timing) and collect the tests that fail intermittently. Once you
have the confirmed list, fixing them is a known queue — an **exhauster**.

- **Atom (saturator):** a confirmed-flaky test. **Verify:** run it in isolation and in-suite enough
  times to establish non-determinism with evidence (it passed X, failed Y of N identical runs).
- **Atom (exhauster):** a de-flaked test. **Verify:** a *different* agent runs the fixed test
  **50+ consecutive times** (and under shuffled order / no-retry) — it must pass every time, **and**
  the fix must not be a cheat. This last part matters: the easiest way to "fix" a flaky test is to
  `skip` it, add silent retries, `await sleep(500)`, or loosen the assertion until it can't fail.
  The verifier's contract explicitly rejects those — it confirms the test still asserts the original
  behavior *and* is now deterministic. That keeps the atom decidable and un-gameable.
- **Decidable?** Yes, strongly. "Run it 50 times, all green, assertion intact" is far cheaper to
  check than "diagnose and fix the race." This is an ideal loop.

### 2. Slow API routes → **Converger** (drive to a latency bar) — but only after you build the meter

"A couple of slow routes" is a single artifact (the two handlers) being driven toward a measurable
target. That's a **converger**: each round measures, a critic panel proposes what's slow and how to
fix it, workers edit, and a separate verifier re-measures.

- **Atom:** a rubric criterion. Your rubric is small and concrete: *route A p95 < N ms*, *route B
  p95 < M ms*, *no existing test regresses*, *response payload unchanged*. **Verify:** re-run the
  benchmark and re-measure; re-run the suite.
- **Decidable? Only if you have a benchmark and a target number.** This is the one loop with a real
  precondition, and it's exactly the trap the router warns about: "make it faster" with no
  repeatable benchmark and no target is *taste*, and a loop over taste burns budget forever. **Build
  the meter first** — a small, deterministic load/latency harness for those two routes (seeded data,
  fixed request mix, warm cache vs cold stated explicitly) and a p95 target for each. Often this
  harness *is* the real work; the loop is almost trivial once it exists. Do not start this loop
  until `node bench/routes.mjs` prints stable p95 numbers you trust.

### 3. Linear bug backlog → **Exhauster** (drain a known queue) — with a triage split

Open bug tickets are a known, enumerable queue you can pull from the Linear MCP. That's the
canonical **exhauster**: pop a batch each round, fix, verify against the ticket's done-criterion, a
ticket that fails its check returns to the queue, and after its retries are spent it becomes a
*named blocked item* — never a silent skip.

- **Atom:** a ticket. **Verify:** a different agent confirms the ticket's acceptance criterion — a
  reproduction that now passes, or (better) a **new regression test** written from the repro that
  goes red→green.
- **Decidable? Per-ticket, and this is where honesty earns its keep.** A bug ticket is loop-eligible
  only if it has (or can be given) a checkable done-criterion. "NullPointer on /api/x when field is
  empty" — decidable: write the repro, fix, assert it's gone. "The dashboard feels janky" — *not*
  decidable by a loop. So the first thing this loop does is **triage the backlog into two buckets**:
  tickets with a reproducible, testable criterion (these enter the exhauster queue) and tickets that
  are ambiguous or taste-based (these are *deferred* to a human/triage pass to get a repro attached).
  You drain the decidable bucket autonomously; you don't pretend to drain the rest.

### What I'm deliberately *not* doing first

- **Not** a single mega-loop over "the whole app." Named above.
- **Not** the perf loop before the benchmark exists, or the bug loop before the suite is stable —
  both would be verifying against ground truth that's either missing or lying.
- **Not** the taste-bucket bug tickets — those wait for a repro.
- **Not** a sentinel yet. A standing watch is the *last* step (hold what you've won), not the first.

---

## Why de-flaking is the gate, spelled out

The entire method rests on grounding every "done" in an external signal. Your test suite *is* that
signal for two of the three loops:

- The **bug exhauster** proves a fix with "repro test green + suite still green." A flaky test means
  a green can be luck and a red can be noise — the verifier either passes broken fixes or rejects
  good ones, at random.
- The **perf converger** uses "no test regressed" as its safety criterion. Flaky regressions make
  that criterion meaningless, so the loop can happily ship a fast-but-broken route.

Fix the meter before you trust the readings. De-flake first; it's a real dependency, not a nicety.

---

## The loops, concretely (what you'd fill into the template)

All four are one shared driver (`assets/loop-template.js`) with a different `MODE` and a handful of
knobs. The isolation, counted progress, fail-closed verification, blocker gate, budget ceiling, and
observability are **identical** across all of them — that shared part is the kernel and it's where
the correctness lives. Only the frontier and stop predicate change.

### Loop 0a — Flaky-test discovery (saturator)

| Knob | Value |
|---|---|
| `MODE` | `saturator` |
| `SOURCE` | your Jest suite |
| `LENSES` | `['shuffle-order','max-parallel','retries-off','slow-timers','repeat-x30']` — each a distinct way to provoke a flake |
| Atom / verify | a test that fails intermittently; verifier reproduces the intermittency with a run tally as evidence |
| `DRY_ROUNDS` | `2` (two consecutive provocation rounds surface no *new* flaky test ⇒ set is saturated) |
| Stop | 2 dry rounds and no open blocker |

Output: a confirmed list of flaky tests with per-test evidence. That list seeds Loop 0b.

### Loop 0b — De-flake (exhauster with a per-test convergence)

| Knob | Value |
|---|---|
| `MODE` | `exhauster` |
| `SOURCE` | the confirmed flaky-test list from 0a |
| Atom / verify | a de-flaked test; verifier runs it 50×+ under shuffle/no-retry, all green, **assertion intact and not skipped/loosened** |
| `BATCH` | 3–4 tests/round |
| `MAX_RETRIES` | 2 (then the test becomes a *named blocked item*) |
| Stop | queue empty, every test either verified-stable or blocked, no blocker open |

A test whose root cause resists fixing becomes a blocker with evidence — surfaced, not hidden. You'd
rather see "3 tests genuinely hard, here's why" than a false "all green."

### Loop 1 — Bug backlog (exhauster)

| Knob | Value |
|---|---|
| `MODE` | `exhauster` |
| `SOURCE` | Linear (via MCP), filtered to open bugs with a decidable criterion after the triage split |
| Atom / verify | a ticket; verifier confirms a **new regression test** written from the repro goes red→green and the full suite stays green |
| `BATCH` | 3–5 tickets/round |
| `MAX_RETRIES` | 2 |
| Stop | every queued ticket resolved (verified done *or* blocked), no blocker open. Ends `drained` only if all verified; otherwise `blocked`, with the blocked list front and center |

The discipline over a hand-rolled "have Claude close tickets" script is entirely fail-closed
verification: a partial failure surfaces as a blocked ticket, not a latent bug shipped to prod. And
**239 of 240 done with one unverifiable is reported `blocked`, not 99.6%** — a blocker can't be
averaged away.

### Loop 2 — Slow routes (converger) — *after the benchmark exists*

| Knob | Value |
|---|---|
| `MODE` | `converger` |
| `SOURCE` | the two route handlers |
| Rubric criteria | `routeA_p95 < N ms`, `routeB_p95 < M ms`, `suite green`, `payload unchanged` |
| Atom / verify | a criterion; verifier re-runs the benchmark / suite and re-measures — **the composite is a count of independently-verified passing criteria, never a panel's self-reported score** |
| `PASS_THRESHOLD` | `1.0` (all criteria pass) |
| `MAX_ROUNDS` | 8–10 |
| Stop | composite ≥ threshold with no open blocker |

For only two routes, a single converger with a 4-criterion rubric is cleaner than two loops. If the
routes are independent enough, it can also be framed as a 2-item exhauster where each item runs its
own mini-converger to its own latency bar — same guarantees either way.

### Loop 3 (optional, later) — Standing watch (sentinel)

Because the backlog is *growing*, once you're in a good state a sentinel keeps you there:

| Knob | Value |
|---|---|
| `MODE` | `sentinel` |
| `SOURCE` | CI + Linear + the benchmark |
| `INVARIANTS` | `['main green','no flaky test reintroduced','routeA p95 < N','routeB p95 < M','no new P0/P1 bug open > 48h']` |
| Atom / verify | an invariant; a violation spawns a repair, a *different* agent confirms it holds again |
| Stop | never converges — bounded by budget/time; reports `held` over the window, or `blocked` if a violation is open |

A sentinel's dashboard is the product. Its honest outcomes are `held` or `blocked` — never a clean
finish while a violation stands.

---

## What every loop shares (the kernel), mapped to your situation

You don't re-derive these per loop; the template implements them once and you verify they're intact.
The reason they matter *for you specifically*:

1. **Worker ≠ verifier.** The agent that fixes a ticket never signs off on it. Otherwise the loop
   over-scores its own fixes and closes tickets that aren't fixed.
2. **Ground every "done" externally.** A ticket is "done" only against a red→green regression test; a
   route is "fast" only against a re-measured benchmark; a flaky test is "fixed" only against 50
   green runs. Never "looks done."
3. **Count, don't vibe.** Progress is `tickets verified / total`, `criteria passing / total`,
   `flaky tests stabilized / found` — arithmetic in the driver from verified atoms. Not a
   model-emitted 0–1 score (those jitter ±0.05 for identical state and are exactly what
   verbosity/self-preference inflate).
4. **Fail closed.** If a verifier crashes on a ticket, that ticket is *unverified*, not done — it
   goes back to the queue and can't count toward progress. A run can't report success while any
   mandate this round went unchecked. This is the exact bug that ships 10 unverified fixes under a
   "98% done" banner; here it becomes a `blocked` run with 10 named items.
5. **Blockers gate hard.** A truly-stuck flaky test, an untestable ticket, a route that can't hit
   its target — each pins the run to `blocked` and gets routed to the strong-model escalation tier
   from the first round it appears. It can't be averaged, dried, or plateaued away.
6. **Isolation / anti-rot.** Fresh context per worker and verifier; the repo, the queue, and the
   ledger pass by *file path*, never accumulated in the driver's context. This is what lets a
   backlog loop run for hours without instruction-following decaying.
7. **Budget ceiling + tiering.** A hard token cap with a reserve so finalize always runs; cheap
   models (haiku) for bookkeeping, mid (sonnet) for fixers/verifiers, strong (opus) only for stuck
   items and blockers. The stop predicate is itself the biggest cost lever — not running rounds that
   have stopped producing verified progress.

---

## How it actually runs

- **Substrate:** a dynamic **Workflow** (the default when the `Workflow` tool is available). You get
  per-agent context isolation for free, a hard `budget` ceiling with a reserve, `parallel()` fan-out
  of workers/verifiers per round, per-agent model tiering, and `resumeFromRunId` so a long run
  resumes instead of restarting. Each loop is one filled-in copy of `assets/loop-template.js` with
  its `MODE` block set; keep each loop's ledger in its own dir so their blocker gates stay
  independent.
- **Prove the driver before spending a token:** `node scripts/selfcheck_loops.mjs`. It runs the real
  template against a mocked harness for every archetype and asserts, in milliseconds, the three
  invariants that a plausible-looking driver gets subtly wrong: a clean run reaches its positive
  status; a **crashed verifier can never produce a positive finish**; an **open blocker forces
  `blocked`** and can't be averaged or dried away. Run this first, every time you touch the template.
- **Observability is required, not optional.** You can't introspect a background Workflow's tasks —
  you'd see "an agent finished," not whether progress is *real*. Every loop writes a live
  `progress.json` (counted state, per-round summary, the blocked list) plus per-round evidence
  artifacts, and for anything long-running you launch the bundled workbench:
  `python scripts/workbench_server.py <LEDGER_DIR>`. I'd give you the dashboard URL before starting
  each run.
- **Dry-run one round first.** Before committing to a long run, run a single round and look at the
  ledger and the first few verified atoms — the first real regression test, the first re-measured
  p95. That catches a broken verify contract before it burns the budget.

### Knobs I'd default to (change if you care)

- **Autonomy: `checkpointed`.** Pause at round boundaries so you can inspect and redirect. The bug
  and perf loops especially benefit from a human glance after round 1. (The sentinel is autonomous by
  nature.)
- **Cost posture: `balanced`.** Tiered models + budget cap as above. Bump to `quality-first`
  (bigger batches, higher round cap, stronger tier) only for the perf loop if it's stubborn.
- **Terminal params:** the `MAX_RETRIES`, `DRY_ROUNDS`, `PASS_THRESHOLD`, and budget listed per loop
  above.

---

## What to run, in order

1. **Build the perf benchmark** for the two routes (deterministic harness + a p95 target each). This
   is the precondition for Loop 2 and probably a chunk of the actual value.
2. **Loop 0a → 0b: de-flake.** Discover the flaky set (saturator), then drain it (exhauster). This
   stabilizes the ground truth everything else depends on. *Gate: don't start 1 or 2 until this
   reports `drained`.*
3. **Triage the Linear backlog** into decidable (repro/testable) vs taste-based (deferred). Only the
   decidable bucket feeds Loop 1.
4. **Loops 1 and 2 in parallel:** drain the bug queue (exhauster) and drive the two routes under
   their bar (converger). Separate Workflows, separate ledgers.
5. **Loop 3 (optional): sentinel** to hold `main` green, latency in-bounds, and no re-flaked tests —
   worth standing up precisely because the backlog is growing.

For each: fill the template's `MODE` block, run `selfcheck_loops.mjs`, launch the workbench,
dry-run one round, then run to the terminal predicate (or the checkpoint you set).

---

## The honest caveats up front

- **The perf loop is only as real as its benchmark.** No repeatable meter and target number = no
  loop, just a bounded best-effort pass that polishes rather than converges. Build the meter.
- **Part of your backlog isn't loop-eligible.** Taste/ambiguous tickets need a repro attached first;
  the loop won't (and shouldn't) pretend to close them autonomously. You'll get an honest "drained
  the decidable N, here are the M that need a human repro."
- **De-flaking can be gamed** (skip/retry/loosen) and the verifier is explicitly built to reject
  that — which means some "flaky" tests will surface as genuinely hard blockers rather than quick
  wins. That's the loop doing its job, not failing.
- **`blocked` is a feature.** When a loop reports `blocked` with a named list instead of a green
  percentage, that's the whole reason to run this instead of a for-loop: it's telling you exactly
  where autonomy ran out and a human is needed, with evidence attached.
