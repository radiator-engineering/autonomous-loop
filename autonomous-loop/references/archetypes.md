# The five archetypes

Each archetype is one setting of the two knobs — **frontier** (where the next work comes from) and
**stop predicate** (how you know you're done) — over the shared kernel in `kernel.md`. This file
gives, for each: the frontier, the stop, the *atom* (the unit that gets counted) and its verify
contract, a worked example, what to surface for observability, and the one self-check invariant that
proves the mode is safe. The bundled `assets/loop-template.js` implements all five as a `MODES`
table; you fill the one you routed to.

A note that applies to all five: the atom's verify contract is the make-or-break design decision,
the way the rubric is for a converger. If you can't state how a *separate* agent passes an atom
against a *checkable* signal, you have not finished routing — go back to `router.md`.

A second note that applies to all five: every **Surface** line below names the *hero* first, because
a board leads with the current artifact and puts the counters under it. Counters tell you the loop is
alive; only the artifact tells you it is working. The rules that make those captures comparable — one
framing spec written to disk and read back rather than re-derived, four azimuths for anything with a
body or a place in it, large enough that the defect resolves, motion when motion is the subject,
commits read from the running code, renders never committed — are in
`observability.md`. A loop that cannot produce a picture says so in the hero
slot and names what would be needed, rather than leaving it empty.

---

## Converger — one artifact to a bar

- **Frontier:** the current round's rubric failures on a single artifact, grouped into edit regions.
- **Stop:** the counted composite (passing criteria / total) meets the bar, with no open blocker.
- **Atom:** a rubric criterion. **Verify:** re-measure the criterion against its grounded signal
  (a test, a benchmark number, a pixel/threshold, a diff against the frozen reference).
- **Worked example:** "make this parser pass all tests and hit p95 < 50ms." Each round: measure,
  a critic panel reports per-criterion PASS/FAIL with evidence, builders fix disjoint regions, a
  synthesis pass reconciles them, stop when the composite clears the bar.
- **Surface:** the artifact itself first — this round's render/page/frame at full width beside round
  1's as the permanent BEFORE, each side captioned with the commit it actually ran — then the score
  trajectory, the per-round findings, and before/after evidence per region.
- **Self-check invariant:** a blocker open at composite 0.95 still reports `blocked`, never
  `converged` — a critical failure can't be averaged away by passing minors.

This mode is deliberately thin here. For real convergence work use the **`gauntlet-loop`** skill: it
adds the frozen Bar, the rubric-design guide, the partition generator, the coherence/synthesis
passes, and the live workbench. Route to convergence here; execute it there.

---

## Exhauster — a known queue to verified-empty

- **Frontier:** pop the next N items from a fixed, enumerable queue (a backlog, a file list, a set
  of endpoints, a batch of tickets). The queue is known up front and only shrinks.
- **Stop:** every item is *resolved* — each is either verified done or declared blocked — and no
  blocker is open. Not "we processed them all," but "each terminal state is earned."
- **Atom:** a queue item. **Verify:** a separate agent checks the item's done-criterion (the test
  the migration must still pass, the endpoint's contract, the ticket's acceptance check).
- **Worked example:** "migrate all 240 call sites off the old API." Enumerate the 240 sites into the
  queue; each round a batch is migrated by workers and independently checked; a site that fails its
  check returns to the queue; after `MAX_RETRIES` it becomes a *blocked* item, not a silent skip.
  The run ends `drained` only if all 240 verified and nothing is blocked; otherwise `blocked`.
- **Surface:** in the hero slot, the newest verified item *as evidence* — its before/after diff, or
  its rendered result when the item is visual — then items done / total, the in-flight batch, and
  the *blocked list* prominently; the blocked list is the whole point of running this instead of a
  for-loop.
- **Self-check invariant:** an item whose verifier keeps crashing becomes `blocked` after its
  retries and forces the run to `blocked` — it never advances to done, and 239/240 done with one
  blocked is `blocked`, not 99.6%.

The exhauster's discipline over a hand-rolled batch script is entirely in fail-closed verification.
A naive migration loop trusts the worker's "done"; this one doesn't, so a partial failure surfaces
as a blocked item instead of a latent bug shipped to production.

---

## Saturator — an unknown-size set until dry

- **Frontier:** heterogeneous finders, each searching a *different way* (by file, by pattern, by
  dataflow, by entity, by time), returning candidates *not already seen*. There is no queue; the
  set's size is unknown and discovered as you go.
- **Stop:** `DRY_ROUNDS` consecutive rounds that surface no new confirmed finding — and no open
  blocker. A simple "we looked once" misses the tail; diverse finders looping until dry does not.
- **Atom:** a finding. **Verify:** an *adversarial* check that tries to refute the finding; it
  passes only if the finding survives, and marks whether it is genuinely novel.
- **Worked example:** "find every place we log PII." Finders sweep by grep pattern, by dataflow into
  loggers, and by known sink APIs; each candidate is adversarially confirmed (is this really PII,
  really reaching a log?); dedup is against everything *seen*, not just confirmed, so a
  judge-rejected candidate doesn't reappear forever; stop after two dry rounds.
- **Surface:** the newest confirmed finding in the hero slot, shown *in situ* — the excerpt, frame
  or trace it was found in, not its title — then the rest of the confirmed findings with evidence,
  which lens found each, and the dry-round counter so the user sees convergence approaching.
- **Self-check invariant:** dedup against `seen` (not `confirmed`), or the loop never goes dry; and
  a confirmed blocker keeps the run out of `saturated` — a flat/dry series can't fake completion
  while a blocker is open. Dedup must not strand the blocker either: a blocked candidate is
  re-offered to the frontier each round rather than dropped with the rest of `seen`, so it can still
  clear, and dry rounds are counted over *new* findings, not over that re-offer.

There is no builder in a saturator — the finder *is* the worker and the verifier is the adversarial
confirmer. This is the gauntlet's critic panel with the build step removed, which is why most of the
kernel transfers unchanged.

---

## Explorer — an open question to an answer

- **Frontier:** the next experiments or reads, *generated from the results grounded so far* — the
  frontier is created by the work itself. This is the one archetype where you can't enumerate the
  work in advance even in principle.
- **Stop:** the question is answered (a designated terminal claim is grounded), or surprise
  saturates (`DRY_ROUNDS` rounds add no claim that changes the answer), or the budget runs out.
- **Atom:** a claim. **Verify:** ground it — try to refute it against evidence; a refuted
  *load-bearing* claim is a blocker, because the conclusion rests on it.
- **Worked example:** "why did p99 latency regress after the June deploy?" Each round proposes the
  experiments most likely to change the answer (bisect commits, profile the hot path, diff configs),
  runs them, and grounds each resulting claim adversarially; the loop stops when a well-grounded
  causal claim answers the question or further probes stop moving it.
- **Surface:** in the hero slot, the one plot, frame or measurement that most recently *moved* the
  answer — then the grounded claims and their evidence, the current best answer, and the open
  questions still driving the frontier.
- **Self-check invariant:** even when the explorer declares the question "answered," an open blocker
  (a refuted load-bearing claim) forces `status='blocked'`, not `answered` — one bad foundation
  can't be averaged away by many sound observations.

Explorer tolerates weaker per-atom measurability than the others (a claim is often grounded by
reference-guided judgment, not a tool), which is exactly why it verifies *per claim* rather than
against a single scalar. It trades threshold-convergence for per-claim grounding. This is the shape
of auto-research.

---

## Sentinel — a standing duty, invariants held

- **Frontier:** poll a live source (CI, dashboards, an event stream, a repo) for invariants violated
  *right now*. The frontier is driven by external events, not by a plan.
- **Stop:** never, by convergence. The loop is bounded by budget, time, or an external signal;
  success is "every invariant held across the observation window with no violation left open."
- **Atom:** an invariant. **Verify:** independently confirm the invariant holds after a repair; an
  unrepaired violation is a blocker.
- **Worked example:** "keep main green and p95 < 200ms." Each cycle polls for violations; a
  violation spawns a repair worker; a separate agent confirms the invariant is restored; a violation
  that can't be repaired (or can't be confirmed repaired) stays a blocker and the cycle reports
  `blocked` rather than pretending health.
- **Surface:** a live view of the watched thing itself in the hero slot — the current frame, graph
  or page, shot to the same framing every cycle — then invariant status (holding / violated), the
  incident log, and time-since-last violation. A sentinel's dashboard is the product, not an
  afterthought, and an uptime counter is not a view of the system.
- **Self-check invariant:** a violation whose repair can't be confirmed (crashed verifier) is
  treated as unrepaired — the cycle reports `blocked`, never a false `held`.

Because a sentinel never terminates positively on its own, its honest outcomes are `held` (bounded
window elapsed clean) or `blocked` (a violation is open). Give it that bound explicitly — the budget,
a wall-clock window, or the external signal that ends the watch. `RUNAWAY_BACKSTOP` is not a watch
length: it is the rail under every archetype, so a sentinel that reaches it was launched without a
bound, and since `held` is its designed positive status only `hitBackstop` says so. Never let it
report a clean finish while a violation stands — that is the sentinel form of the false-APPROVE bug.

---

## Composition

The archetypes chain, and the router should name the chain, not just the first loop.

**Sequence — run loops back to back.** One loop's output seeds the next loop's frontier; each is a
separate run with its own `run_id` and its own ledger — as opposed to a run continued with
`resumeFromRunId`, which is the same run and keeps both (`kernel.md` §6).

- **explore → converge → sentinel** — diagnose what matters, drive it to a bar, then hold it. The
  most common full-lifecycle shape.
- **saturate → exhaust** — find every instance of a problem (unknown size), then drive the resulting
  known list of fixes to verified-empty.

**Nest — a loop whose per-item work is itself a loop.** The outer loop is usually an exhauster over
a known board of tickets. A ticket's work need not be one edit; it can be its own *routed* sub-loop,
so the router runs **per ticket**:

- "fix this bug" → a leaf task (one worker, one verifier);
- "make this page hit p95 < X" → an inner **converger** (a gauntlet);
- "find every place we leak PII" → an inner **saturator**;
- "why did latency regress?" → an inner **explorer**.

On a Workflow substrate the exhauster's worker calls `workflow(innerLoop, {ticket})` — one level of
nesting is supported. Off Workflow, the worker dispatches the inner loop's driver.

**The rule that makes nesting safe:** the outer loop's done-criterion for a ticket is *"the inner
loop reached its positive terminal (converged / saturated / answered), confirmed by a separate
verifier"* — not "the inner loop returned." That is worker ≠ verifier, one level up. An inner loop
that finishes `capped` or `blocked` fails the outer verifier and becomes a named blocked ticket.

**The blocker gate composes upward.** A blocked inner loop makes its outer ticket blocked, which
keeps the outer loop out of a positive finish. An unverified atom anywhere — a crashed verifier
several levels down — surfaces as a blocked item at the top instead of being absorbed into a green
number. So "the board is done" means every ticket earned its terminal, and any ticket that could not
is a *named* blocked item, never a silent skip. This upward propagation is the whole reason
composition is trustworthy — keep each loop's ledger separate and let the gate carry.

**The mechanism, stated honestly:** the bundled `assets/loop-template.js` is a single-mode driver —
one archetype per invocation. You compose by *composing drivers* (sequence the runs, or have an
outer worker invoke an inner loop), not by running mixed modes inside one driver instance.
