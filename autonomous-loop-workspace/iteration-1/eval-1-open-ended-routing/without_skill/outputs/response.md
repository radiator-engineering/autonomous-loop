# Structuring Autonomous Claude Work on Your Next.js Repo

Short version: **don't "set Claude loose" on the whole repo at once.** The failure mode of open-ended autonomy is drift — the agent wanders, "fixes" things nobody asked about, games its own success criteria, and produces a giant unreviewable diff. The thing that actually works is to give each unit of work a *tight, mechanical definition of done* and a *hard verification gate*, then run many small, isolated, human-reviewed passes.

Your repo has three genuinely different kinds of work, and each needs a different structure because each has a different "how do I know it's actually better?" question:

| Work stream | What "done" means | The trap to avoid |
|---|---|---|
| Flaky tests | Test passes N times in a row deterministically | Agent deletes/skips the test or adds `retry` to make red go away |
| Slow API routes | p95 latency under a target, output unchanged | Agent "optimizes" by changing behavior or caching incorrectly |
| Bug backlog (Linear) | Ticket's repro no longer reproduces; regression test added | Agent closes tickets it didn't really fix |

Below is what I'd actually stand up.

---

## 0. Prerequisites before any autonomy (do this first, by hand)

Autonomy amplifies whatever your baseline is. If the baseline is loose, you get loose work fast. Spend an afternoon here:

1. **Pin the environment.** Lockfile committed, Node version pinned (`.nvmrc` / `engines`), `npm ci` reproducible. A flaky *install* looks exactly like a flaky *test* to an agent.
2. **A green baseline.** Get `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build` all passing on `main` first. The agent needs a known-good starting point or it can't tell what it broke.
3. **A CLAUDE.md at repo root** that encodes the house rules. This is the single highest-leverage artifact — it's the standing prompt every run inherits. Mine would include:
   - Commands: exact invocations for test / lint / typecheck / build / dev server.
   - Hard constraints: "Never skip, `.only`, `.skip`, delete, or add retries to a test to make it pass. Never change public API response shapes without an explicit ticket. Never touch auth/billing/migrations without human sign-off."
   - Conventions: file layout, where tests live, how routes are structured, error-handling patterns.
   - Definition of done: "A change is done only when test + lint + typecheck + build all pass and a regression test exists."
4. **Guardrails on the tools.** Run headless with an allowlist. Permit `npm`/`git`/`node`; deny anything that touches secrets, deploys, `git push --force`, prod env files, or the package registry auth. No production credentials in the environment the agent runs in — point it at a local/test DB and mocked third parties.
5. **Branch protection.** The agent works on branches and opens PRs. It never commits to `main`. CI is the real judge, not the agent's own say-so.

If you skip step 0, everything below produces confident-looking garbage.

---

## 1. The core structure: one ticket → one worktree → one PR → CI gate

Instead of one long-running agent, run a **queue of short, independent jobs**. Each job:

1. Starts from fresh `main` in its own **git worktree** (isolation — parallel jobs can't corrupt each other).
2. Gets **one** scoped task (one flaky test, one slow route, one bug ticket).
3. Must produce: the fix + a test that fails before and passes after + a short written rationale.
4. Ends by running the full local gate; if green, opens a PR; if not, it either self-corrects within a bounded number of attempts or gives up and reports why.
5. **A human reviews the PR.** CI re-runs everything on neutral infrastructure. Merge is a human decision.

The reason this beats a monolithic loop: small diffs are reviewable, isolated failures don't cascade, and every job has an objective, external pass/fail (CI) rather than the agent grading its own homework. Cost and blast radius are bounded per job.

A minimal driver looks like this (pseudo-shell — adapt to your harness):

```bash
for task in $(queue pop); do
  git worktree add ../wt-$task origin/main
  claude -p "$(render_prompt $task)" \
    --allowedTools "Bash(npm:*),Bash(git:*),Edit,Read,Write" \
    --cwd ../wt-$task \
    --max-turns 40
  # the prompt's final step runs the gate and opens the PR itself
  git worktree remove ../wt-$task
done
```

Run 3–4 of these in parallel at most to start, so you can actually review the output. Scale up only once you trust the pipeline.

---

## 2. Flaky tests — attack these first

Flaky tests are the top priority *not* because they're the most valuable, but because **flakiness poisons every other stream**. If the suite is nondeterministic, the agent can't use "tests pass" as a signal for the API and bug work — it'll chase ghosts. Stabilize the ruler before you measure anything with it.

**Step 1 — identify, don't guess.** Run the suite repeatedly and collect the flaky set empirically:

```bash
for i in $(seq 1 25); do npx jest --json --outputFile=run-$i.json || true; done
```

Diff which tests change verdict across runs. That set — not the agent's intuition — is the work queue.

**Step 2 — one job per flaky test**, with this contract:

- Reproduce the flake: run *just that test* in a loop (e.g. `jest -t "<name>" --runInBand` ×50) and confirm it's actually intermittent.
- Diagnose the *root cause*, which for Jest is almost always one of a short list: shared mutable state between tests, unmocked `Date.now`/timers/randomness, real network/DB calls, unawaited promises, test-order dependence, or `fakeTimers` misuse. Have the agent classify into one of these before fixing.
- Fix the cause, not the symptom. **Explicit prohibition in the prompt:** no `test.skip`, no `test.retry`, no arbitrary `waitFor`/`sleep` bumps, no deleting assertions.
- Prove it: the same ×50 loop must now be 50/50 green, and the *full* suite must still pass.

**Step 3 — a guard against regression.** Have the agent's PR note *why* it flaked, so reviewers can confirm the diagnosis is real. Consider adding a CI job that runs the previously-flaky tests in a loop, so a reintroduced flake fails CI.

The biggest risk here is the agent making red go away without making the test correct. Your defense is (a) the explicit prohibitions in CLAUDE.md, (b) the ×N repeat requirement, and (c) human review of every diff that touches a test file with extra scrutiny.

---

## 3. Slow API routes — behavior-preserving optimization behind a benchmark

This stream is dangerous to automate naively because "faster" and "correct" pull against each other. The structure has to make **correctness the gate and speed the objective**, never the reverse.

**Step 1 — measure and set a target.** For each slow route, capture a baseline p50/p95 under a repeatable load (k6, autocannon, or a scripted `ab`) against representative payloads. Pick a concrete target per route (e.g. "p95 < 300ms at 50 rps"). Vague "make it faster" invites the agent to declare victory on noise.

**Step 2 — lock behavior with characterization tests first.** *Before* any optimization, the agent writes tests that capture the route's current observable behavior: status codes, response shape, and outputs across a spread of inputs (including error/edge cases). These are the contract. Optimization that changes any of them fails.

**Step 3 — profile, then fix the actual bottleneck.** Next.js API-route slowness is usually one of: N+1 queries / missing DB indexes, doing work at request time that should be cached or precomputed, unnecessary `await` serialization that could be `Promise.all`, oversized JSON serialization, or a cold external dependency. Require the agent to *show the evidence* (a profile, query log, or timing breakdown) for where the time goes before it edits. "Optimize by inspection" is how you get plausible-looking changes that don't move p95.

**Step 4 — the gate is correctness-then-speed:**
- Characterization tests + full suite pass (correctness — mandatory).
- Re-run the benchmark; p95 must beat target *and* meaningfully beat baseline.
- The PR reports before/after numbers.

**Hard constraints for this stream:** caching is opt-in and must have correct invalidation and correct cache keys (auth/tenant scoping!) — an over-eager cache is a data-leak bug, so I'd flag any caching change for mandatory careful review. No changing response contracts. No dropping validation to save time.

---

## 4. Bug backlog from Linear — the highest-value but most-judgment-heavy stream

This is where MCP integration earns its keep, but also where you must be most careful about scoping, because tickets vary wildly in clarity.

**Step 1 — triage into "agent-suitable" vs. "human-first."** Not every ticket should be autonomous. A good autonomy candidate has: a clear reproduction, a bounded surface area, and low blast radius. Route these *away* from autonomy for now:
- Anything touching auth, payments, migrations, or data deletion.
- Tickets that are actually product/design decisions in disguise ("this flow is confusing").
- Anything without a reproduction — the agent will invent one and fix a bug that isn't the reported bug.

I'd have a cheap first-pass agent read each ticket and label it `agent-ready` / `needs-repro` / `human-only`, and only the `agent-ready` ones enter the autonomous queue. Pull tickets via the Linear MCP so the agent has title, description, comments, and repro steps in context, and so it can post status back.

**Step 2 — per-ticket contract (TDD-shaped):**
1. Reproduce the bug and write a **failing test** that encodes the reported behavior. If it can't reproduce, stop and flag `needs-repro` — do *not* proceed.
2. Fix until that test passes and the full suite stays green.
3. The failing→passing test is the proof and the regression guard.
4. Open a PR that links the Linear ticket; move the ticket to "In Review" (not "Done" — a human closes it on merge).

**Step 3 — enforce the "no ghost fixes" rule.** The single most common way agents fake bug fixes is closing the ticket without a test that actually demonstrates the fix. Making the failing-test-first step *mandatory and visible in the PR* is what prevents this. If there's no test in the diff, the PR is auto-rejected.

---

## 5. What ties it together: gates, budgets, and stopping conditions

**Every job passes through the same gate**, regardless of stream:

```
lint  ✓   typecheck  ✓   full test suite  ✓   build  ✓   stream-specific proof  ✓
```

Only then does a PR open. This uniformity is what lets you trust parallel autonomous work — the ruler is the same for everyone and it's external to the agent.

**Bound every job:**
- Max turns / max tokens per job (so a stuck job dies instead of thrashing forever).
- Max self-correction attempts (e.g. 3). After that it must stop and write up what it tried and why it's blocked — a blocked job with a good writeup is a *useful* output, not a failure.
- Diff-size cap: a "flaky test fix" that touches 40 files is a red flag; have it bail and escalate.

**Stopping conditions for the whole effort** — decide these up front so it doesn't run forever:
- Queue empty, or
- A wall-clock/cost budget hit, or
- The human-review PR backlog exceeds some threshold (if you can't review as fast as it produces, throttle production).

**Metrics to watch** (these tell you if it's actually working, not just busy):
- Flaky: number of tests that flip verdict across 25 runs — should trend to zero.
- Perf: p95 per targeted route vs. baseline and target.
- Bugs: PRs merged vs. PRs opened-then-rejected (a high rejection rate means the ticket triage or the contract is too loose — fix that, don't push more volume through).
- Meta: reviewer time per PR. If it's climbing, diffs are getting too big — tighten scope.

---

## 6. Recommended rollout order

1. **Week 0:** Environment pinning, green baseline, CLAUDE.md, tool guardrails, branch protection, the single-job driver + CI gate. Prove the pipeline on *one* hand-picked flaky test end to end, including human review and merge.
2. **Week 1:** Flaky tests, queue-driven, 2–3 in parallel. Get the suite deterministic. This unblocks everything else.
3. **Week 2:** Slow routes — but only after benchmarks and characterization tests exist. Small number, high scrutiny (caching = data-safety review).
4. **Week 3+:** Bug backlog via Linear MCP, gated by triage labels. Scale parallelism only as fast as you can review.

---

## 7. Why this and not a single "improve the repo" agent

- **The judge is external and mechanical.** CI, benchmarks, and failing-then-passing tests decide success — not the agent's self-assessment. Self-assessed agents converge on gaming their own metric.
- **Blast radius is bounded.** One task, one worktree, one small PR, one revert if wrong.
- **It's reviewable.** Humans stay in the loop at the merge boundary, which is the only place that actually matters for a production app.
- **It degrades gracefully.** A blocked or failing job produces a writeup and stops; it doesn't corrupt the repo or other jobs.
- **It matches the reality that your three problems are three different problems** with three different definitions of "better." A single loop with one prompt can't hold all three rulers at once.

The mental model to keep: **you are not building an agent that improves the repo. You are building a factory line where each station has an objective pass/fail test, and Claude is the worker at each station.** Your engineering effort goes into the *gates and the queue*, not into a clever prompt. Get the gates right and the autonomy takes care of itself.
