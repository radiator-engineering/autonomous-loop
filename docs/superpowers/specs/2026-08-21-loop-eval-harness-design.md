# Loop Eval Harness
### Deterministic testing for generated loop drivers — spoof the substrate, lint the design, replay the corpus
*JJ Martin · 2026-08-21 · design spec, approved in conversation before writing*

---

## The bottom line, up front

Two real loops failed this week and **no gate we ship could have caught either one**. The kernel's self-checks prove the *template* is sound; nothing tests the *filled driver* a generation session actually produces, and nothing reads a design brief and says "this item will kill its worker." This spec adds three pieces:

| Piece | Where | What it catches | Verdict style |
|---|---|---|---|
| `scripts/eval_driver.mjs` | this repo (public) | a filled driver that misbehaves under scripted adversity | hard gate |
| `scripts/lint_design.mjs` | this repo (public) | a loop design that will fail for predictable reasons | hard fail + warnings |
| `autonomous-loop-bench` | separate **private** repo | regressions against real recorded runs | truth-verdict diff |

The split is deliberate: **the harness is public, the corpus is private.** The recorded runs contain internal paths, hostnames, and project material that cannot ship in this repo.

**Not in v1** (recorded as fast-follows, not forgotten): the jam-rule retune and the tree-reset-between-retries kernel fix. The private bench is seeded so that the jam rule's defect shows up as a **born-red** case on day one — the bench exists precisely to hold that red until the retune lands.

---

## The problem — what the two failed runs proved

Both failures happened in drivers that **passed every existing gate**. The gates test the template; these runs failed in the fill and in the design.

| Failure (measured, from the postmortems) | Layer | Existing coverage |
|---|---|---|
| Worker died at context limit, retry replayed from token zero → livelock, 5 deaths + 1 manual kill | substrate behavior of the filled driver | none |
| One item implied ~480 emitted lines; no output budget anywhere in the design | design | none |
| Verifier ran with `images: 0` against image evidence → structurally blind, still returned verdicts | design | none |
| Ceremony overhead ~$3–5/item, never costed against doing the work by hand | design | none |
| Retry reused a dirty tree → a wrong-but-green pass was possible | kernel (deferred fix) | none |
| Jam rule (`distinctCaptures < captures`) fires on both real ledgers; truth is one healthy run, one merely stuck | kernel rule vs reality | 108 synthetic scenarios — **all green** |

That last row is the argument for the whole third piece: **synthetics said the jam rule was fine; two real ledgers said it is wrong.** Replay against recorded truth finds what invented cases miss.

---

## Piece 1 — `eval_driver.mjs`: run the filled driver against a scripted world

**The mechanism already exists.** `selfcheck_loops.mjs` runs the template inside `AsyncFunction` with spoofed `agent` / `parallel` / `pipeline` / `phase` / `log` / `budget`. This piece generalizes it from *the template we ship* to *any filled driver a session generated*, so a driver can be exercised in milliseconds, for zero tokens, before it burns a real budget.

**Interface:**

```
node scripts/eval_driver.mjs <path/to/driver.js>     # run the battery, exit non-zero on any failure
node scripts/eval_driver.mjs                          # no-arg: self-test against the shipped template + mutants
```

**Spoofing is label-keyed.** The spoofed `agent()` decides what to return by matching the call's `label`/`phase`/prompt shape against the roles the template defines (worker, verifier, ledger, audit, finalize). If a call matches no known role, the run's verdict is **`unspoofable` — a hard failure, not a skip.** A driver the harness cannot simulate is a driver nothing can test before launch; fail closed.

**The battery.** Each scenario scripts the world one way and asserts the terminal status and key ledger writes:

| Scenario | The world it scripts | Must hold |
|---|---|---|
| `happyPath` | everything succeeds | terminal `success`, hero + handoff written |
| `contextDeathWorker` | one worker's agent() resolves `null` every time | item goes `blocked` within patience; **no livelock**, no infinite retry |
| `contextDeathEveryone` | every agent() resolves `null` | run reaches a terminal status on its own; bounded rounds |
| `lyingVerifier` | verifier always says pass, evidence contradicts | the count only moves on the verifier's verdict — and the audit rungs still gate the *status* (this is the honest limit: a lying verifier inflates the count; the scenario pins that the damage stops there) |
| `budgetCliff` | `budget.remaining()` hits 0 mid-round | clean terminal write, `hitBackstop` set, no half-written ledger |
| `runawayUnbounded` | frontier returns new items forever | backstop fires; run cannot outlive its round cap |
| `deadAuditor` | terminal audit agent dies | status fails closed to `unwitnessed`/`undocumented`, never to success |
| witness rungs | audit returns each of the verdict table's rows | driver's status matches the documented six-row table |

**Self-test with mutants.** No-arg mode runs the battery against the shipped template (must be all green) and against a small set of deliberately broken fills — a disarmed backstop, a stripped witness gate — each of which must go red. A battery with no red half can be edited into a rubber stamp silently; this repo's rule is every gate carries a case built to trip it.

**Wiring:** a `run_gate` line in `install.sh` (CONTRIBUTING already mandates this for any new `selfcheck_*`/gate script), and the bundle repacked since scripts ship in it.

---

## Piece 2 — `lint_design.mjs`: read the design, name the predictable death

`eval_driver` tests the code; this tests the *plan*. Input is the filled driver plus its `BRIEF.md`. Five lints, two severities — **hard-fail** for things that structurally cannot work, **warn** for things that historically go wrong:

| Lint | Checks | Severity | The failure it comes from |
|---|---|---|---|
| **L1 output budget** | per-item expected output volume; flags any single item implying > ~250 emitted lines; hard-fails the test-iterate-on-a-large-file shape | warn / hard | the ~480-line item that killed five workers |
| **L2 ceremony economics** | measured prompt bytes × rounds × tier pricing vs. the brief's budget; surfaces $/item | warn | ~$3–5/item overhead nobody had costed |
| **L3 evidence contract** | a verifier configured with `images: 0` while the design demands visual captures | **hard** | the structurally blind verifier |
| **L4 decidability** | atoms whose done-criterion is taste ("looks polished") rather than checkable | warn | undecidable atoms ground through rounds |
| **L5 dual source of truth** | two files both claiming to be the count/queue | warn | design-system run's drift hazard |

Warnings print and exit 0; hard fails exit non-zero. The severity split is honest about confidence: L3's failure is structural (blind is blind), while L1/L2/L4/L5 are strong priors, not proofs.

> L2's dollar figures are **estimates from measured prompt bytes and current tier pricing** — good enough to force the "is this worth it" conversation, not billing-grade.

Same wiring as Piece 1: `run_gate` line, red-half self-test, bundle repack.

---

## Piece 3 — `autonomous-loop-bench`: the private corpus that keeps both honest

A separate private repo. Layout:

```
corpus/<run-name>/
  driver.js          # the filled driver, verbatim
  ledger/            # progress.json, HANDOFF.md, claims.jsonl, artifacts/ (as recorded)
  EXPECTED.json      # truth verdicts, written by a human who knows what actually happened
run.mjs              # replays replay_gates + eval_driver + lint_design over every corpus entry
.github/workflows/   # CI runs run.mjs on every push, and against harness main on a schedule
```

`EXPECTED.json` is the point: **a human writes down what was actually true** — "this run was healthy," "this jam verdict is wrong" — and `run.mjs` diffs the tools' verdicts against it. Synthetic scenarios test what we imagined; the corpus tests what happened.

**Seeded with the two colleague runs, and born red on purpose:** the jam rule mis-verdicts both. That red is the bench doing its job — it is the standing, mechanical statement of the open defect, and it goes green only when the retune (fast-follow #1) actually fixes it against reality. New failed runs get added as they occur; the corpus only grows.

---

## What this buys

- **Zero-token, sub-second verification of a generated driver** before it spends a real budget — the exact gap the postmortem called "verification left dangling."
- **A design review that fires before launch**, keyed to the five measured ways real designs failed this week.
- **A regression bench grounded in reality**, which already found a defect 108 green synthetics missed — on its first two entries.

## Honesty flags

- **`eval_driver` tests behavior under spoofed adversity, not correctness of the work.** A driver can pass the battery and still do bad work; that is the verifier's job at runtime, not this tool's.
- **Label-keyed spoofing couples the harness to the template's role conventions.** A heavily hand-modified driver will come back `unspoofable`. That is fail-closed by design, but it means the tool serves template-descended drivers, not arbitrary Workflow scripts.
- **The lints encode this week's failures.** They will not predict next month's novel one; the bench is the channel by which new failures become new lints.
- **Two known kernel defects ship unfixed in v1** — the jam rule and the dirty-tree retry. Both are named, both have a standing red or a written hazard, neither is silently dropped.

---
**The one-liner for the room:** *The gates prove the template; nothing proved the driver — now a generated loop gets tested in milliseconds against a scripted world before it spends a dollar against the real one.*
