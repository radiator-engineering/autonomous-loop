# Designing the atom: the unit a loop counts

The driver's progress number is a deterministic function of *verified atoms* (`kernel.md` §3), so it
is worth exactly what the atom is worth. This file is how you design one. `router.md` §3 has the
five-row table of what each archetype counts; `gauntlet-loop/references/rubric-design.md` is the
converger-only ancestor. Everything here covers all five archetypes except where it says otherwise.

## 1. Cheaper to verify than to produce — measure the ratio, don't assert it

`router.md` §3 makes this the gate but not how to check it. Do this by hand, on ONE real atom:

1. **Produce it.** One worker does the work for one atom. Record tokens and wall time — call it P.
2. **Verify it.** A second, fresh agent passes or fails it against the contract you will ship — V.
3. **Require V < P.** At V ≈ P the loop pays twice per atom and the verifier is your budget; at
   V > P, invert the design and make the thing you produce the check. *Recommendation, not a measured
   threshold:* aim for V ≤ P/3 — nothing here has measured where the knee is.
4. **Write the verify as a command if you can** — `bazel test //x:y`, a pixel diff, `grep -c`, an
   HTTP probe. Then V is near zero and rung 1 (§2) comes free.

The disqualifying shape is **verify requires redoing the work**: "check this migration is correct,"
answerable only by migrating again and diffing, is V = P — measurable-sounding and undecidable.
Caught by hand it costs two agent calls; caught in the Step 6 dry run it costs a round.

## 2. Grounding rungs: what counts as a verified pass

Rank every atom by how *external* its ground truth is, not by how confident the verifier sounds. Rungs
1–3 are checkable; 4–5 are judgment wearing a number.

| Rung | What it is | Exhauster | Saturator | Explorer | Sentinel |
|---|---|---|---|---|---|
| 1 | deterministic tool output | the item's own test/typecheck passes | the finding is *reproduced* by running it | the experiment's raw result | the probe re-run returns healthy |
| 2 | computed metric over the artifact | a measured contract (status code, schema) | a counted property at the locator | a measurement over collected data | the invariant's numeric threshold |
| 3 | diff against a fixed reference | before/after diff vs the migration spec | matches a known-true instance | matches a recorded baseline | matches the last known-good state |
| 4 | reference-guided LLM judgment | the acceptance text, given first | refutation with the spec in hand | grounding a claim against cited evidence | judging a repair against the invariant text |
| 5 | reference-free LLM judgment | "looks migrated" | "seems like a bug" | "this feels like the cause" | "seems healthy" |

Rung 5 is not a pass. If most atoms land there, `router.md` §3's taste-stop applies. The explorer is
the one licensed exception — a claim is often grounded at rung 4, which is why it verifies per claim
(`archetypes.md`, Explorer). An exhauster or sentinel at rung 4 is a design defect.

## 3. Binary and atomic — a partly-true atom cannot be counted

There is nowhere to put a grade: a verdict is `pass: boolean` plus evidence plus severity
(`VERDICT_SCHEMA` in `assets/loop-template.js`) and progress is a set of confirmed ids. Every atom resolves to
exactly PASS or FAIL and asserts exactly one thing. A "0–5, we're at 3" atom cannot be expressed —
split it into the levels you want counted.

- **Compound atom → split it.** "The page is accessible" is a dozen checks with one verdict; a
  verifier finding four failures still returns one FAIL, and fixing three moves the count by zero.
- **The evidence field is not the verdict.** Return PASS/FAIL *plus* the measured value against the
  target; adjectives ("mostly", "largely") where a number belongs mean it is still compound.
- **Test:** name the one input change that flips this atom, and only this atom. If you can't, split.

## 4. The shape the atom takes, per archetype

| Archetype | Atom fields (the driver ignores the rest) | Read at `assets/loop-template.js` |
|---|---|---|
| Converger | `{id, region, fix, status}` (`status` ∈ the criterion enum) | `:186-196` |
| Exhauster | `{id, task}` | `:249, :268` |
| Saturator | `{where, claim}` — you do **not** supply `id` | `:317-320` |
| Explorer | `{id, hypothesis, method, terminal}` | `:363-375` |
| Sentinel | `{id, invariant, detail, severity}` | `:415-447` |

- **`terminal: true` is the explorer's whole positive status.** Only a *verified* terminal atom
  latches `answered` (`:392`), and only `answered` reaches `reachedGoal` (`:398`), so exactly one
  atom should carry it — the answer, not an experiment. `"yes"` will not latch (`:375`).
- **The verify must be repeatable and side-effect-free.** A failed atom returns to the frontier and
  is verified again later, bounded by `MAX_RETRIES` (`:539, :557, :267-269`). A check that consumes a
  queue message, rotates a token or edits the artifact passes once and fails forever after — then
  exhausts its retries and becomes a named blocker that pins the run.

## 5. Stable ids come from outside the model's prose

`kernel.md` §3 states the rule and `SKILL.md` kernel invariant 3 records the saturator's locator
trade and the explorer's frozen charter; the incident behind both is in the gauntlet-loop skill's
`references/rubric-design.md` (the re-worded-finding incident).
What this file adds is where each id actually comes from in the shipped driver.

| Archetype | Id source | What you must do |
|---|---|---|
| Converger | the rubric, frozen on the first panel; an unrecognised id is dropped as a gap (`MODES.converger.frontier`) | nothing — the freeze is automatic |
| Exhauster | an `enumerate` **agent**, but minted ONCE at `init` and frozen for the run — a finite space the loop cannot grow, which is why re-wording buys it nothing | if the ids must be external, paste a fixed queue into `SOURCE` rather than asking for one; an item with no string `id` is dropped and raises a blocker (`MODES.exhauster.init`) |
| Saturator | the **locator**; a volunteered `id` is ignored (`MODES.saturator.frontier`) | write a `where` fine enough to separate two real findings — `file:line:symbol` |
| Explorer | a **cell of the frozen charter** — (chartered sub-question × finding), filled by the VERIFIER, never the planner (`MODES.explorer.countsAsProgress`) | nothing for identity — the charter is minted once at `init` and bounded at 8 sub-questions, so at most 36 cells exist. Spend the effort on the DECOMPOSITION: the charter is the atom space, and a run needing a sub-question it does not hold must stop and be re-chartered by a human |
| Sentinel | re-minted each round as `${round}:${id}` (`MODES.sentinel.key`), deliberately not stable | the stable key is the **invariant string** you author; the poll copies it back verbatim and clear/dedup match on it (`MODES.sentinel.frontier` / `resolve`) |

## 6. Severity: decide at design time which atoms are disqualifying

`kernel.md` §5 says what a blocker does — pins the terminal status (`:637`), never averaged or dried
away, routed to the escalation tier on rework (`:531, :588`) — not which of *your* atoms is one. That
choice is asymmetric: over-mark and one stubborn atom pins a healthy run at `blocked`; under-mark and
a data-loss step is averaged into a 98%. Mark `blocker` when a failure is disqualifying alone — data
loss, a safety contract, a refuted load-bearing claim, an unrepairable invariant. Everything else is
`major`, `minor` or `none`.

The driver mints blockers itself in three places only: a dead or partial `enumerate` (`:243, :251`),
an item out of retries (`:267-269`), an unrepaired invariant (`:459`). Every other blocker comes from
the verifier's `severity` field — and **the shipped verify prompt names severity in only three
modes**: converger (`:221`), explorer (`:396-397`), sentinel (`:459`). The exhauster's (`:269`) and
saturator's (`:340`) say nothing, so a verifier assigns it at its own discretion. If those runs have
disqualifying atoms, write the rule into the prompt: name which failures are `severity=blocker` and
say every other failure is `major` or below.

## 7. Every atom owes a red half

**A count never watched go red is not evidence.** Break the real artifact in exactly the way the atom
exists to catch, run the verifier, record the FAIL, restore. Recorded here: a zero-blank-facade test
passed while the ground storey had 0 glass pixels of 1,344,000 — it described the *record*, not the
frame (measured; project memory `guarantee-describes-record-not-frame`). It is usually cheap: deleting ONE triangle
reproduced a whole identity-loss defect (measured; project memory `identity-by-triangle-count`). Five ways a pass is
vacuous, in the order they were found here — walk the ladder:

1. **No assertion.** The check runs and never compares anything.
2. **Zero iterations.** The loop body never executed; an empty set passes every predicate.
3. **Results never collected.** The measurements were taken and then not read.
4. **The declared set IS the discovery.** The check enumerates the list it was handed, so it cannot
   miss what was never listed. A "we checked all N" where N came from the thing being checked.
5. **The enforcer is a side channel.** The thing that certifies is fed by the thing it certifies.
   This is the one that keeps recurring here: a hardcoded set in the caller declined silently and
   uncounted, and then the fix's own counter certified itself against the rule it had read.

## 8. An atom must not be invariant to what it claims to measure

Recorded: **12 of 13 criteria returned identical scores on temporally shuffled frames** across five
critic rounds (measured; project memory `permutation-invariant-rubrics-are-blind`). The test: apply the
transformation that destroys the claimed property and leaves everything else alone; the verdict must
move.

- **Time-domain criterion → shuffle proof.** Permute the frames/samples and re-run. Every
  time-domain atom owes one, plus a red/green pair.
- **Saturator "reaches a sink" → cut the edge.** Sever the dataflow; the finding must stop confirming.
- **Exhauster "the site still passes" → revert one site.** Its check must fail.
- **Spatial/view criterion → move the camera.** A number identical from every azimuth measures the
  framing, not the subject.

## 9. Gate magnitude as well as frequency

A gate on *how often* is not a gate on *how bad*. Recorded: a "fewer than 5% of frames" criterion
passed while the worst case grew **3.2x**, frequency inside the band throughout (memory:
project memory `fraction-gates-miss-taller-defects`). So every frequency atom ships with a magnitude atom over
the same data — `p100` (or `p99`) against its own target, counted separately: two atoms, two binary
verdicts. Then check the ratchet can fail — tighten the threshold past the current value and confirm
the atom goes red before you trust it.

## 10. A reference the loop generated for itself must prove itself first

This applies to any **rung 3** atom whose reference was synthesized rather than given — a converger's
computed bar, a sentinel's "last known-good" baseline, an exhauster's recorded golden. The reference
is then an artifact, and an unproven artifact cannot grade anything. Recorded (both incidents from
converger runs): an *infeasible* reference path was tracked to 2.6 cm while the same run's foot skate
ran 13x, because nothing had asked whether the bar was reachable (memory:
project memory `a-generated-bar-must-prove-itself`). So a generated reference gets its own atom and its own red
half (§7) before its first grading round.

Then lock it. Recorded: **scaling one column of a generated bar by 12 flipped 12 red results to 12
green with the artifact untouched** (measured; project memory `perturb-the-bar-not-the-artifact`). Perturb the artifact,
never the reference: write the reference to a file, hash it at round 0, and have the driver refuse
any round where the hash moved. Writing the rule into a prompt does not enforce it — that run had the
rule and gamed itself anyway.

## 11. Anti-gaming

Any optimized proxy is hackable, and pushing past a point degrades the true objective while the proxy
climbs — so the stop predicate is a Goodhart defense, not only a cost control.
`gauntlet-loop/references/failure-modes.md` §3–§5 has the mechanisms, numbers and citations.

- **Keep the worker blind to thresholds** (`kernel.md` §1): fix text names the defect and the change,
  never the number it must clear.
- **Hold out or paraphrase — CONVERGER ONLY.** Both need criterion *text*, which only a rubric has,
  and holding atoms back contradicts an exhauster's terminal predicate — every item resolved
  (`archetypes.md`, the exhauster's **Frontier**) — so an exhauster that holds atoms out can never reach `drained`.
- **Position and verbosity bias** (the gauntlet-loop skill's `references/failure-modes.md` §3) need judging machinery this driver lacks
  (§13); design around them, since a rung 1–3 atom has no slot order and no length to inflate.
  **Self-enhancement** is the one the template's `TIER` map can express today: a different model
  family for the verifier (`kernel.md` §1).
- **Diversity collapse** (the gauntlet-loop skill's `references/failure-modes.md` §5) needs *distinct mandates* — correctness / safety /
  performance / spec. **Not implemented — §13**, and the ledger has no group field, so keep the
  mandate split in your design notes and check its coverage yourself before launch.
- **Red-team the verifier before the run.** Feed it a master-key token (a lone "Solution:", a
  flattering preamble) and a prompt injection inside the candidate; if either moves the verdict,
  harden it first.

## 12. Worked atoms — bad vs good

| Run | Bad atom | Good atom |
|---|---|---|
| Exhauster: migrate 240 call sites | *"the call site is migrated"* — rung 5, V = P | `{id:"<path>:<line>", task:"…"}` passing when *that line no longer references `oldApi`* and the site's own test target passes — two commands, rung 1. Red half: revert one site. Blocker rule in the verify prompt (§6): a site with no test target is `blocker` |
| Saturator: find every place we log PII | *"auth logs a user email"* — verified by reading | `{where:"src/auth/session.rs:412", claim:"…"}`, verified by running the path and showing the email in captured log output (rung 1) |
| Explorer: why did p99 regress after the June deploy? | *"the cache change caused it"* — one compound atom grounded by argument | *"p99 on `<endpoint>` rose 180→610ms between `<sha1>` and `<sha2>`"* + *"reverting `<sha>` on a canary returns p99 to ≤200ms"*, both rung 1 and `terminal:false`; the causal claim is the single atom carrying `terminal:true` (§4) |
| Sentinel: keep main green and p95 < 200ms | *"the service is healthy"* — compound, so the repair has nothing to aim at | one atom per named invariant, each with its own probe and numeric target, plus a p100 companion for latency (§9). Red half: inject latency in a canary |

## 13. Stated here, not implemented in the driver

Write these into your design; never describe them as things the tooling does.

- **Order-swap and length-neutral judging** (§11) appear nowhere in this skill, and a **heterogeneous
  critic panel** is doctrine only: the converger's "panel" is one agent (`MODES.converger.frontier` in `assets/loop-template.js`).
- **RE-ANCHOR** — re-injecting the frozen spec each round — is stated in `references/kernel.md` (invariant 3's converger note) and implemented
  nowhere; there is no spec path constant, so §10's hash-lock is yours to add too.
- **Whole-artifact coherence** — workers edit in parallel with no reconciling pass. Make coherence
  its own counted atom so incoherence shows up as a FAIL instead of as nothing.
