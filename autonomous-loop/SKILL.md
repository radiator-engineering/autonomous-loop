---
name: autonomous-loop
description: >-
  Designs and runs an autonomous loop for a large or open-ended task, spanning all five loop shapes:
  converge one artifact to a bar; exhaust a known queue (a backlog, a migration, every
  file/endpoint/ticket); saturate an unknown-size set (find every bug/instance); explore an open
  question (hypothesize-test-ground research); or stand watch over a live system (detect drift,
  repair, hold invariants). Use this whenever the user wants Claude to work autonomously at scale or
  in the background until done: 'churn through this backlog', 'migrate all N files', 'find every
  place that does X', 'audit the codebase for Y', 'research this question end to end', 'keep this
  healthy / watch for regressions', 'fan out over these tickets and route each to its own loop' - or
  when they are unsure which loop fits and want the highest-leverage one chosen. It routes to the
  right shape, then builds a counted, fail-closed, self-checkable driver. Covers pure
  quality-convergence against a concrete reference as well as open-ended search.
---

# Autonomous Loop

An autonomous loop is how you point Claude at a task too big for one context and trust the result:
it spends many fresh-context agents against a task, and a thin deterministic driver decides what to
work on next and when to stop. This skill is the generic method: it covers all five loop shapes and
picks the right one for you.

The power is not "an agent trying harder for longer." It is two things, and every loop here keeps
both or it fails the way ungrounded loops always fail — drifting, gaming its own judgment, and
declaring success it didn't earn:

1. **Context isolation.** The driver holds one small file of counted state — the **ledger** — and
   nothing else. Every worker and verifier runs in a *fresh* context. No single transcript
   accumulates, so instruction-following never rots and the loop can run indefinitely.
2. **Counted progress under fail-closed verification.** A worker never certifies its own output; a
   separate verifier must tie a "done" to a concrete, checkable signal. Progress is *counted in code
   from verified atoms*, never read off a model's gestalt. An **atom** is the one unit a loop
   counts, and each shape counts a different thing: a rubric criterion, a queue item, a confirmed
   finding, a grounded claim, an invariant held. A crashed verifier leaves its atom **unverified** —
   work handed out and never checked back in — which is not a pass. This is what makes "done" mean
   done.

Three words carry the rest of this document: **atom** (above), **frontier** and **stop predicate**
(next section). Everything else is ordinary English.

## The universe: two knobs, five shapes

Every autonomous loop is the same machinery with two parts swapped out:

- **The frontier** — where the next unit of work comes from.
- **The stop predicate** — how you know you're done.

Set those two and you have named the loop. There are five useful settings, and this document calls
each one an **archetype** — a loop shape, nothing more:

| Archetype | Frontier (next work) | Stop predicate | Canonical ask |
|---|---|---|---|
| **Converger** | rubric failures on *one artifact* | counted score ≥ bar | "make X as good as Y" |
| **Exhauster** | pop from a *known, enumerable queue* | queue empty, every item verified | "work through this whole backlog / migrate all N files" |
| **Saturator** | finders over an *unknown-size set* | K consecutive dry rounds | "find every place that does X" |
| **Explorer** | hypotheses generated from *prior grounded results* | question answered, or surprise saturates | "research this end to end" |
| **Sentinel** | events from a *live stream* | never — success is invariants held over a window | "watch this and keep it healthy" |

Two facts about this table drive everything downstream:

- **Only the frontier and the stop predicate change.** Isolation, counted progress, fail-closed
  verification, the blocker gate, budget, and observability are identical across all five. That
  shared part — the code every archetype runs unchanged — is the **kernel**
  (`references/kernel.md`), and it is where the correctness lives.
- **The archetypes compose.** A real engagement is often explore (find what matters) → converge
  (hit the bar) → sentinel (hold it), and an exhauster frequently runs a mini-converger per item.
  The router's job is to name the *first* loop and the sequence.

## Step 0 — Intake: ask the user, don't assume them

A loop runs for hours against a target you chose, a bar you invented, and evidence you decided was
interesting. Every one of those is the user's to set, and none of them is recoverable afterwards —
a run that converges on the wrong thing converges confidently, and the counted number on top makes
it look earned. So the first move is not surveying, and it is certainly not building. **Ask.**

Ask with `AskUserQuestion`, in one batch, offering a recommended default for each so the user can
wave it through. The six questions are the six sections of `BRIEF.md`, and they are what the launch
gate checks (Step 4):

| Ask | Why it can't be inferred |
|---|---|
| **Destination** — what does reaching the end look like, in your words? | The survey shows what *is*; only the user knows what *should be*. |
| **Archetype** — recommend one from Step 1, ask them to confirm | The user often knows the set is bigger than it looks (exhauster → saturator). |
| **Atom + verify contract** — this is what I'll count; is it the right unit? | A counted number is only worth what its atom is worth, and the atom is a judgment about their domain. |
| **Stop** — the terminal predicate; unbounded, or a bounded probe? | Unbounded-vs-capped is a spending decision. |
| **Evidence** — what do you want to SEE each round? | The whole reason the board's **hero slot** — the one picture it leads with — exists. Ask what a good round *looks* like, not just what it scores. |
| **Autonomy + budget** — checkpointed or autonomous, and the ceiling | Theirs to spend. |

Write the answers to `<LEDGER_DIR>/BRIEF.md` under those six `##` headings *before* building
anything. That file is the run's contract and the thing a later session reads to know what this loop
was for. If the user declines a question, record what they said and why it doesn't apply — an
explicit "no evidence is possible here, it's a headless data migration" is an answer; silence isn't.

**Do not skip this because the user's request was detailed.** A detailed request answers Destination
and maybe Archetype. It almost never answers Evidence, and Evidence is the one that decides whether
they can see the loop working — which is the failure this whole section exists to prevent.

## Step 1 — Route to the right loop (do this first)

Given any task, pick the archetype before designing anything. Getting this wrong is the dominant
failure: an exhauster pointed at an unknown-size set never terminates; a converger pointed at an
unmeasurable target burns budget on taste. Read `references/router.md` for the full procedure; the
short version:

1. **Survey the target** cheaply (scoped reads, existing tests/CI/issues). What is the artifact,
   and what can be run or measured locally?
2. **Classify by the two knobs.** Is the work a *known list* (exhauster), an *unknown-size search*
   (saturator), a *single artifact chasing a bar* (converger), an *open question* (explorer), or a
   *standing duty* (sentinel)? The decision tree in `references/router.md` makes this mechanical.
3. **Gate on decidability — the make-or-break check.** Each archetype needs its atom to be
   *cheaper to verify than to produce*: an exhauster needs a per-item done-criterion, a saturator a
   per-finding confirmation, a converger a rubric grounded in tools, an explorer a way to ground a
   claim. If the atom can only be judged by taste, **stop and say so** — build the missing
   measurement first, or run a bounded best-effort pass and set the expectation that it won't
   truly "converge." A loop over an undecidable atom is the canonical way to burn a large budget.
4. **Produce a one-paragraph brief** — chosen archetype, its frontier and stop predicate, the atom
   and how it's verified, what you're deferring, and the sequence if several loops are needed.
   Confirm it, then build.

Pure quality-convergence against a concrete reference ("make this match that") is the **converger**,
and it is handled here: the frozen bar, the rubric-design guide (`references/rubric-design.md`), the
partition model and its generator, and the live workbench. Read `references/archetypes.md` for the
current state of the driver's converger before relying on a specific mechanism.

## Step 2 — The shared kernel (non-negotiable in every loop)

These are not polish; each maps to a documented failure mode (`references/kernel.md` has the
mechanism and the evidence). When you generate a loop, verify all of them are present:

1. **Worker ≠ verifier.** The agent that does the work never certifies it. Self-preference is
   causal, and a self-graded loop congratulates itself while standing still.
2. **Ground every "done" externally.** A verifier may only pass an atom it can tie to a checkable
   signal (a test, a measurement, a diff, a reproduction). Never "looks done."
3. **Count, don't vibe.** The progress number is a deterministic function of verified atoms,
   computed in the driver — items closed, findings confirmed, claims grounded. A model-emitted
   score jitters and gets gamed; a count of grounded atoms has nothing to inflate. It keys on the
   atom's **id**, so give the atom one derived from something stable — file:line, ticket number,
   symbol — never from the worker's prose. The converger takes its ids from the frozen rubric. The
   **saturator takes them from the LOCATOR** (`where`: file:line, symbol, endpoint, ticket), and an
   `id` a finder volunteers is ignored rather than trusted — so a re-worded claim at the same place
   collides with the first find instead of buying the run another round. It counts *places*, not
   claims about places; two real findings at one locator collapse into one atom, and the fix for that
   is a finer locator, never handing identity back to the model.
   The **explorer** has no locator — a hypothesis is not a place — so it borrows the converger's
   mechanism instead: a **frozen charter** of at most 8 sub-questions, minted once at init and
   re-injected verbatim every round. Its atom is a *cell* of (chartered sub-question × finding), at
   most 36 of them, and the **verifier** fills both coordinates, never the planner. So a planner that
   re-words the same experiment forever lands on the same cell forever: it counts once and the run
   plateaus. An experiment naming an unchartered sub-question is dropped and the run escalates
   `blocked`, carrying the proposed text into `HANDOFF.md` so a human can re-charter and resume.
   The common shape across all three: **identity comes from a finite space the loop cannot mint.**
   KNOWN LIMIT, narrowed: a run needing a genuinely new line of enquiry must stop and be re-chartered
   by a human. That is the price of the bound, and explorers therefore get `DRY_ROUNDS = 3`, since
   their plateau now means "coverage saturated", not "the planner ran out of ideas".
4. **Fail closed.** A worker or verifier that crashes or returns nothing is an *unverified mandate*.
   Its item returns to the frontier (bounded retries) and never advances to "done." The run cannot
   report a positive terminal status while any mandate is unverified — a missing verdict must not
   shrink the denominator and inflate the count.
5. **Blockers gate hard.** An open blocker pins the terminal status to `blocked`. It can never be
   averaged away by other successes (490/500 closed with 10 silently failed is `blocked`, not 98%)
   nor allowed to fake a plateau or a dry round.
6. **Isolation and anti-rot.** Workers get fresh contexts; the artifact and large state pass by
   *file path*, never accumulated in the driver's own variables.
7. **Budget ceiling + tiering.** A hard token ceiling, cheap models for mechanical steps, strong
   models only for stuck items and escalation.
8. **A run that showed a human nothing may not call itself a success.** Every positive terminal
   status is gated on the ledger's `hero` slot having been filled at least once — with a real
   capture, or with `hero.type="none"` **plus a note naming what would be needed**. Otherwise the
   status is `unwitnessed`: the confirmed count is still reported, but `converged` is false. The
   gate can only ever demote a would-be success — a `blocked` run is blocked first — and it fails
   closed, so a crashed ledger writer cannot launder a positive finish. This exists because "the
   board leads with the picture" was for a long time an *instruction in a prompt* and therefore
   changed nothing: loops finished green having never once produced an artifact, and the board
   rendered its "an absent picture must never read as nothing to show" placeholder underneath a
   success. Counting verified atoms and never checking that any of it became visible is the same
   defect as counting unverified ones. Note what the gate does **not** ask: not that the picture be
   good, not that it improved — only that it exists and that its absence was said out loud. The
   escape hatch is checked rather than trusted: the audit counts the image files in `artifacts/`,
   **and how many of them are distinct pictures**. Measured: an agent wrote "headless screenshot
   capability is required" while twelve captures from that same script sat in that same directory. A
   `none` nobody can falsify is the unverified-atom defect wearing the gate's own uniform.

   **The gate names its reason, because one word for three facts is a status nobody can act on.**
   Replayed across five real ledgers in three repos, the hero slot had been filled *zero* times —
   every run took the `type:"none"` hatch — and the old single `unwitnessed` fired on two of them for
   opposite reasons. So the rung splits, and each ending is now an instruction:
   - `unwitnessed` — nothing to show and no capture path. **Build one.** (Three of the five: genuinely
     text-based work. This is the case the hatch exists for and it still finishes green.)
   - `unpointed` — frames exist, the board points at none. **Promote one.** One measured run had 20
     rounds, 19 confirmed atoms, no blockers, and a proper before/after pair on disk; telling it "you
     showed a human nothing" was simply false, and the fix was one line of bookkeeping.
   - `evidence_regressed` — the harness **worked and stopped**. This ranks with the blockers rather
     than with the two above, because a capture path that used to succeed and now doesn't makes every
     later round's evidence untrustworthy, including rounds already counted green. It is detected
     without trusting anyone's report: *N ≥ 2 frames with only one distinct digest is a jammed
     camera.* Measured — a harness broke at round 3 and each later "capture" re-emitted round 1's
     frame byte-for-byte, four files deep, while the board read 7 of 9 confirmed and no blocker. A
     directory that keeps growing looks like a working camera, which is why counting frames without
     looking at them was the same defect as counting unverified atoms.

   The whole rung is replayable against finished runs — `scripts/replay_gates.mjs` extracts the
   decision function from the template and runs it over synthetic cases plus any ledger directories
   you pass it. A gate you can only exercise by running a loop for an hour is a gate that drifts.
9. **A run that left no pickup document may not call itself a success.** Every positive terminal
   status is also gated on `HANDOFF.md` — what a fresh agent reads to continue this run — being
   present *and describing the round the run actually ended on*. It is rewritten every round, never
   appended to, so a run that dies at round 40 leaves one describing round 40. Otherwise the status
   is `undocumented`: same demote-only, fail-closed shape as the witness gate. Two things make this
   more than a file check. The gate reads a **terminal audit** — one cheap agent that opens the
   ledger dir after the last round — because asking the ledger writer whether it wrote the file is
   guardrail #1 broken inside the kernel; the writer's own answer survives only as board state, so a
   watcher can see the round where claim and finding diverge. And `documented` is deliberately **not
   monotone** while `witnessed` is: a capture taken in round 3 is still a real capture, but a handoff
   from round 3 is stale. Do not "fix" that asymmetry.
10. **A verdict may only set the fields its schema declares.** The kernel builds each accepted atom
   by spreading the verdict over the work item, so any undeclared key is a field the *verifier* gets
   to write onto the *item* — and item fields are what the counters and terminal predicates read.
   `fromVerdict` narrows every verdict to `VERDICT_SCHEMA`'s keys, and the item keeps its own `id`.
   Measured, on one injected `terminal: true`: an explorer counted the same re-worded finding for 200
   rounds, and — laundered through a blocked item that the frontier re-offers — a run reported
   `answered` with `converged=true` on a question no planner ever proposed an answer for. Pinning
   `id` alone had been a fix for one field of a class.

The bundled driver template (`assets/loop-template.js`) implements all ten once, in the kernel,
for every archetype. Its safety is mechanically checkable — see Step 4.

## Step 3 — The loop the driver runs each round

```
1. FRONTIER   Ask the archetype for the next batch of work items (or [] when the frontier is dry).
              Converger: run the critic panel → findings. Exhauster: pop the queue. Saturator: run
              finders → new candidates. Explorer: generate experiments from grounded results.
              Sentinel: poll for violated invariants.
2. WORK       Fresh-context workers, one per item, in parallel — fix / do / gather / experiment /
              repair. A worker never grades itself.
3. VERIFY     A DIFFERENT agent checks each output against the item's done-criterion and returns a
              structured verdict (pass + evidence + severity). A crashed verifier ⇒ unverified.
4. LEDGER     Advance state IN CODE from the verdicts: confirm passing atoms, return failed/
              unverified ones to the frontier, record blockers. Write progress.json + artifacts.
5. STOP?      Check the archetype's terminal predicate. Blockers and unverified gaps dominate a
              would-be success. Otherwise loop.
```

The ledger (a file, not context) holds the counted state and makes the run resumable and
compaction-durable. Per-archetype detail — exact frontier, stop, atom, and worked examples — is in
`references/archetypes.md`.

## Step 4 — Prove the driver before you run it

A loop that runs for hours is only trustworthy if its stop logic is correct, and stop logic is code,
so test it as code. Before running any Workflow driver:

```
node scripts/selfcheck_loops.mjs      # zero-token, deterministic; exits non-zero on any breakage
```

It executes the actual template against a mocked harness for every archetype and asserts the kernel
invariants per archetype: a clean run reaches its positive terminal status; a run that verified
every atom but never filled the hero slot is `unwitnessed`, not converged, while the same run
declaring `hero.type="none"` converges normally — unless `artifacts/` is full, in which case the
`none` is a lying hero and demotes (`heroNoneWithGallery`, `heroNoneNoGallery`, `auditNoCaptures`) —
and a crashed ledger writer fails closed; a run that
wrote no `HANDOFF.md`, or one describing an earlier round, is `undocumented` (`handoffAbsent`,
`staleHandoff`, `bothMissing`, `deadLedger`), and a ledger agent that claims a file the terminal audit
cannot find is believed *by neither gate* (`lyingLedger`, `deadAuditor`); a crashed verifier can
never produce a positive finish (`converged=false`); an open blocker forces `status='blocked'`,
can't be averaged or dried away, and ends a run that has stopped confirming new atoms within
`BLOCKER_PATIENCE` standstill rounds rather than spinning to the backstop — while a run still confirming new atoms
keeps going and reports `blocked` at its own predicate; an unbounded run stops on its own predicate
and is never `capped`. If you edit the template, run this first — it catches the false-APPROVE
class of bug in milliseconds instead of after a long expensive run.

Four of its checks are not about the loop at all: they read `assets/workbench.html` and assert every
status the template can emit has a badge, that the two gate statuses are visually distinct from an
ordinary stop, and that every badge class has a CSS rule. A terminal status the board renders as
benign amber is a gate that fires into a room with nobody in it.

### The launch gate — nothing runs until this exits 0

Selfcheck proves the *kernel* is correct. It cannot prove the thing you are about to launch **is**
the kernel, that a human was asked what the run is for, or that anyone will be able to watch it.
Those were prose in this file for months, and prose is advice: the recorded failure is a week of
loops that were hand-rolled Workflow scripts — never touching the template, writing no
`progress.json`, launching no workbench, filling no hero slot — while every word above stayed true
and unenforced. So they are now a gate:

```
python3 scripts/workbench_server.py <LEDGER_DIR> --port <PORT> [--transcripts <session>/subagents]
node scripts/preflight_launch.mjs <driver.js> <LEDGER_DIR> --workbench http://127.0.0.1:<PORT>
```

Seven gates, each fail-closed, each naming its own fix:

- **SELFCHECK** — `selfcheck_loops.mjs` exits 0.
- **DESCENT** — the driver's four kernel regions hash **identical** to the template's. A
  hand-rolled script fails at the first marker; a one-line edit that turns a fail-closed check
  fail-open fails on the hash. Config and your one MODES block are yours; the kernel is not. This
  is why the kernel carries no fill markers — every one lives above it in Config. The fourth region,
  `schemas`, covers the knob check and every schema down to MODES, because the kernel's guarantees
  are not all written in the kernel: the closed enums the counters are built from live there, and so
  does the `additionalProperties: false` that stops a verdict writing the item's control fields. A
  driver could have passed a three-region DESCENT with a byte-perfect kernel and those disarmed one
  screen above it. `TIER` is derived in Config from the `EFFORT` knob so this region can close — the
  tier map is the one thing in that span a run is meant to tune, and deriving it from a named setting
  beats hand-editing it.

  **What DESCENT does *not* cover, and what does instead.** DESCENT holds the *driver* still. It
  cannot hold the **evidence harness** still — the script that boots the app and takes the picture —
  because that script is bespoke per run and often does not exist at preflight time (on one measured
  run, *building* it was queue item #1). Yet the entire witness gate stands on it. Measured: a harness
  was hand-edited twice mid-flight to stop it hijacking a browser tab, the second edit introduced a
  race, and capture failed for five rounds while the board reported a healthy run — and the first
  failure came *before* the first edit, so a preflight hash would not have caught it either.
  Two mechanisms, because the failure had two halves:
  - `scripts/check_harness.mjs <LEDGER_DIR>` — **trust on first sight, then hold.** A script the pin
    file has never seen is recorded and allowed; one it has seen must hash the same. Verifiers run it
    before every capture. A changed harness is not automatically *wrong*, it is automatically
    **ungated**: every round since the edit produced evidence nobody checked, which is a blocker, not
    a note. Re-pin deliberately with `--accept` once a human has looked.
  - **A harness only ever drives a browser it started itself.** Its own `--user-data-dir`, its own
    `--remote-debugging-port`, launched and killed by the script. An operator's already-running
    browser — reached by attaching to its debug port, or by any `Target.createBrowserContext` /
    `Target.disposeBrowserContext` trick for cheap multi-session isolation inside one shared instance
    — is never a CDP target. Measured: a harness reached for the operator's own daily Chrome over its
    remote-debugging port to fake two signed-in profiles side by side, and the browser segfaulted five
    times in twelve minutes (`EXC_BAD_ACCESS`, freed-memory poison in the crash codes — a
    use-after-free) while every CDP call returned normally, nothing timed out, and the board stayed
    green throughout. Two ordinary tabs in two separately-launched instances gets the same isolation
    without a shared browser ever entering the picture, and removes the need for browser contexts
    entirely.
  - **A timeout is a failure.** The reason the breakage was silent is that the harness did not exit
    non-zero — it hung, and the runner answered *"moved to the background"*, which is a
    success-shaped result with no exit code in it. 20 of 31 measured invocations returned in under a
    tenth of a second and the run called every one of them fine. Any capture path must treat a
    timeout, a backgrounded command, a missing sidecar, a frame identical to an existing one, or a
    browser process id that changed since the harness's last call as a **failed capture**, and say so
    in the verdict — a frame taken across a browser restart is not obviously wrong by inspection,
    which is exactly what let the crash above run for twelve minutes before anyone noticed.
- **FILLED** — no unfilled `<<MARKER>>` survives. An unfilled knob either crashes at startup or,
  worse, reads as a number and silently disarms a predicate.
- **PARSES** — the driver **compiles**, and every name it reads is bound somewhere in the file.
  Measured: a driver passed every other gate here and then died 24 ms into round 1 on `question is
  not defined`. Each gate had been honest and none had opened the file as code, so the operator got a
  green launch, a workbench URL, and a run that was over before they read the URL. Not `node --check`,
  which exits 0 on a driver with an unbalanced paren once `export const meta` puts Node's checker on
  another path — also measured, which is why the gate compiles the source itself (compiling is not
  running: no agent is spawned, no token spent). The unbound-name half catches the commonest way to
  make one: a fill marker replaced with a bare word where a quoted string was meant.
- **DRYRUN** — the driver **runs**, against a mocked runtime: every `agent()` answered from a table,
  no tokens, no filesystem. PARSES reads the file and so is blind to scope — a name bound in one
  function and read in another is bound *somewhere*, and the scan clears it while the run still
  throws. Closing that statically needs a real JS parser, which this skill has no dependency for, so
  the driver is executed instead and V8 resolves the names. Only a `ReferenceError` fails the gate:
  mock data cannot manufacture "x is not defined", while a shape mismatch produces a `TypeError` that
  may well be the mock's fault, and a gate that fires on its own limits gets deleted. KNOWN LIMIT: it
  covers the paths the mock reaches, so a name read only inside a rarely-taken branch is still
  uncovered by both checks — a smaller hole than either leaves alone.
- **BRIEF** — `<LEDGER_DIR>/BRIEF.md` exists with all six Step 0 sections answered.
- **LIVE** — a workbench is serving **this** ledger dir, proven by a nonce written and fetched back.
  Comparing served content against disk is *not* enough and was measured returning GREEN against a
  deliberately wrong directory: the workbench seeds every ledger with byte-identical content, so two
  runs look the same at exactly the moment preflight runs.

Green writes `<LEDGER_DIR>/PREFLIGHT.json`. Give the user the workbench URL at this point — the gate
has just proved it works.

A third check governs this skill's own prose rather than any run: `node scripts/selfcheck_docs.mjs`
refuses a line-number citation between skill files, a `MODES.<archetype>.<member>` that the archetype
does not define, and a skill-relative path that does not exist. It exists because 26 citations here
were measured wrong in one sitting — not wrong when written, wrong because the files underneath them
moved. One citation pointed at lines 109-121 of the template, which held `VERDICT_SCHEMA` when
somebody typed it and hold the model-tier map today. Cite the symbol; it moves with the code it names.
(That sentence names the numbers in words on purpose: the checker cannot tell a live citation from an
illustration of a bad one, and an escape hatch for "I meant it this time" is how a gate stops being
one.) The checker carries its own red half in the
same run, including the direction it first got wrong: a correct cross-skill citation, whose owning
skill is named on the previous line, must **not** be flagged.

The launch gate owes its own red half, and has one: `node scripts/selfcheck_preflight.mjs` runs 14 cases
against a real workbench on a temp dir, asserting the exit code **and the exact set** of gates that
fired — a case that starts tripping a second gate is a fixture that drifted, and it goes red rather
than quietly certifying the wrong gate. There is one tampering case per hashed region, which is not
decoration: with a single tamper case, the largest region in the file could be deleted from `REGIONS`
and every case still passed. Deleting any one entry now flips exactly its own case to exit 0.

## Step 5 — Substrate, observability, knobs

- **Substrate.** Default to a **dynamic Workflow** when the `Workflow` tool is available: per-agent
  isolation is free, `budget` gives a hard ceiling, `parallel`/`pipeline` give fan-out, per-agent
  `model`/`effort` give tiering, and `resumeFromRunId` gives resume. Fill `assets/loop-template.js`.
  Fallbacks (in-session Agent fan-out; committed CI harness) are in `references/substrates.md` — the
  wiring is identical since the kernel is shared.
- **Observability is required, not optional, and the board leads with the artifact.** A dynamic
  workflow's tasks can't be introspected from the harness — you'd see "an agent finished," not
  whether progress is real. Counters tell you the loop is alive; only the artifact tells you it is
  working, and lanes here have twice gone green, committed, and reached no frame at all. So the top
  slot of every board is the **newest artifact itself**, beside round 1's as a permanent BEFORE, and
  the counters go underneath. Every loop writes a live `progress.json` and the round's captures, and
  launches the bundled workbench (`scripts/workbench_server.py`) on the ledger dir. A loop that
  genuinely cannot produce a picture must **say so in the hero slot** and name what would be needed;
  an absent picture must never read as "nothing to show."
  The ledger is written once a **round**, so the board also carries a **workflow panel** — which
  agents are running, in which phase, and for how long — fed by `activity.jsonl` or the harness's
  own transcripts (`references/observability.md`). Without it a round in flight looks exactly like a
  hung run, which is the one distinction a person watching a long loop actually needs.
  Alongside the board, every round rewrites **`HANDOFF.md`** — the pickup document, what a fresh agent
  reads to continue this run: where it stands, what is confirmed, what is open, what to do next. It is
  rewritten rather than appended to, so a run that dies at round 40 leaves one describing round 40
  instead of a log to reconstruct. The board is for the human watching; the handoff is for whoever
  arrives after nobody was. Kernel invariant 9 gates the terminal status on it.
  **`references/observability.md` is the full contract** — the `progress.json` and `hero` schemas,
  `runs.jsonl`, `claims.jsonl`, capture and framing discipline, artifact pruning, and a triage table
  for reading a board. `references/archetypes.md` says what each archetype puts in the slot.
- **Knobs (confirm at launch, use the default if the user doesn't care):**
  - *Effort* (`EFFORT`, default `balanced`): the one knob that prices the models. `thrifty` |
    `balanced` | `quality-first`. It resolves the whole model tier map in Config, above every hashed
    region — so detuning a run never touches the kernel and never changes what DESCENT checks.
    Previously this was a hand-edit of the tier map, which meant a detuned run and a thorough one
    produced ledgers that read identically; now the setting is named, recorded in the ledger head and
    the run summary, and on the board. Evidence *cadence* is its own knob (`EVIDENCE_EVERY`, below),
    not derived from effort — how often a run photographs itself is a fact about the work, not about
    how much you are willing to spend.
    **Do not reach for `thrifty` to make a slow loop fast.** Measured across eight runs: 61% of a
    worker's tokens go to orientation before its first edit, but repo reading is 2.5% of wall-clock.
    Effort buys tokens; it buys almost no time. Wall-clock lives in tests, external services and
    polling, and the only reliable way to shorten a round is a smaller atom.
    One floor holds at every setting: **verification never drops below the worker's tier.** A
    verifier weaker than the agent it grades is not a cheaper loop, it is an ungrounded one — and it
    fails in the direction that looks like success.
  - *Evidence cadence* (`EVIDENCE_EVERY`, default `1`): how many rounds between captures. It drives
    both capture paths on one clock — the ledger writer's hero capture and the per-item verifier
    capture — so `0` disables collection everywhere at once rather than in one place. `0` declares up
    front that this loop bears no evidence, which is a legitimate and common shape — three of five
    measured runs were text-only — and saying it once beats discovering it round by round. Priced: a
    real capture cost a mean of 69 seconds and 12.4% of one run's wall clock.
    The sharper control is **per item**: an exhauster's queue items carry `bearsEvidence`, declared at
    enumeration. Set it false for anything that changes nothing a person could see — a pure refactor,
    an internal seam, a rename, a test-only change. This is a correctness knob more than a cost one:
    a capture taken for an item with nothing visible to show does not come back empty, it comes back
    looking exactly like the last one, and a frame indistinguishable from the baseline is worse than
    no frame at all. When genuinely unsure, leave it true — a missing frame is the worse error.
  - *Autonomy* (`checkpointed` by default): pause at round boundaries to inspect/redirect, or run
    `autonomous` to the terminal predicate or budget. A sentinel is autonomous by nature.
  - *Terminal parameters*: the round cap (`MAX_ROUNDS`, default `null` — an **unbounded** run,
    below; a number only for a bounded sample or a costed probe); the queue for an exhauster,
    `MAX_RETRIES` before an item is declared blocked, `BLOCKER_PATIENCE` rounds without new confirmed
    progress before an immovable blocker ends the run, the invariant set for a sentinel, the budget
    ceiling.
  - *Dry rounds* (`DRY_ROUNDS`): how many consecutive rounds may confirm no new atom before the loop
    calls it a plateau and stops. Read by the **converger** as well as the saturator and the
    explorer — a converger below its bar has no other terminal predicate, so this is the knob that
    ends it. The value must be at least 1: at `0` the plateau is already true at round 0, so the run
    would stop before its first round and exit green having done nothing. The driver refuses `0`, a
    negative, a non-number, or an unfilled placeholder at startup and names the knob.
  - *When to choose unbounded* (the canonical statement of the cap; elsewhere, point here): with
    `MAX_ROUNDS = null` the archetype's own terminal predicate is the only authority, and the kernel
    still stops the run — plateau/`DRY_ROUNDS`, the budget, and a blocker (or an unresolved
    verification gap) that survives `BLOCKER_PATIENCE` rounds in which nothing new was confirmed.
    Patience counts standstill, not calendar: ONLY a newly confirmed atom resets it to 0, so a run
    still producing verified atoms carries an immovable blocker to its own predicate and reports
    `blocked` there, and a run that has stopped producing them ends `blocked` on its
    `BLOCKER_PATIENCE`th standstill round. Those rounds need not be consecutive — a clean round in
    between holds the count rather than restarting it, or a blocker that clears and reopens on
    alternate rounds would hold patience open forever without ever confirming anything. The
    A numeric cap that fires is a planned stop (`capped`, unreachable when the cap is null);
    an unbounded run that reaches `RUNAWAY_BACKSTOP` stops `runaway_backstop` — a safety rail, not a
    plan: reaching it is recorded as `hitBackstop` and read as a defect signal, never a finish.
    Choose it when the brief says no round limit, autonomy is `autonomous`, and convergence is
    against a real bar with a live workbench watching. A number is a plan to stop early — pick one
    only when the user asked for a bounded sample or a costed probe. The dangerous
    configuration is the *pairing*: unbounded over a weakly measurable atom, where no predicate can
    fire and the run drifts to the backstop. Unbounded over a decidable atom is not the risk; an atom
    judged by taste is — and that one fails the Step 1 decidability gate long before the cap is set.

## Workflow of using this skill

0. **Intake** — ask the six questions (Step 0) and write `<LEDGER_DIR>/BRIEF.md`. Never inferred,
   never skipped because the request looked detailed.
1. **Target, then route.** *What* to point a loop at comes first and is the decision most often made
   by accident — `references/targeting.md` enumerates candidate objectives, scores them, and says how
   to recognise one not worth a loop at all. Only then classify the archetype and gate on
   decidability (`references/router.md`); targeting picks the objective, the router picks the shape.
2. **Design the atom** — the unit of work and exactly how a verifier passes it. This is the
   make-or-break ingredient, the analogue of the rubric; if it isn't cheaper to check than to
   produce, go back to step 1. **`references/atom-design.md` is the guide**: grounding rungs, atomic
   decomposition, where each archetype's ids come from, the red half every criterion owes, and the
   anti-gaming rules (shuffle proofs, magnitude as well as frequency, and never perturbing the bar
   instead of the artifact).
3. **Select the substrate** and fill `assets/loop-template.js` for the chosen mode. Three markers are
   easy to miss because they are new: `<<EFFORT>>` (`thrifty` | `balanced` | `quality-first` — the
   driver refuses anything else at startup rather than defaulting, so a typo cannot silently price the
   run differently from what the operator was told), `<<EVIDENCE_EVERY>>` (rounds between captures;
   `0` declares the loop evidence-free), and `<<SKILL_DIR>>` (this skill's directory — a workflow
   script has no `__dirname`, so it cannot find its own scripts unless you tell it where they are).
4. **Self-check the kernel and the gate** (`node scripts/selfcheck_loops.mjs`, and
   `node scripts/selfcheck_preflight.mjs` if you touched the gate or the template's region markers).
   If you touched the witness rung, add `node scripts/replay_gates.mjs` — and pass it the ledger
   directories of any finished runs you have, because a gate that only ever meets synthetic fixtures
   is a gate whose real corpus nobody has looked at. That is how the three-state split was found.
   If you edited this skill's own prose, add `node scripts/selfcheck_docs.mjs`; if you touched
   `assets/workbench.html` or the server, add `node scripts/selfcheck_board.mjs`. Before spending a
   real budget, `node scripts/eval_driver.mjs <driver.js>` runs the filled driver against scripted
   adversity for zero tokens, and `node scripts/lint_design.mjs <driver.js> <BRIEF.md>` reads the
   design for predictable failures the gates below cannot see.
5. **Stand up the workbench, then pass the launch gate** (`node scripts/preflight_launch.mjs …`).
   Green is the precondition for launching, and the moment you hand the user the dashboard URL.
6. **Dry-run one round** — show the ledger, the first verified atoms, and the artifacts before
   committing to a long run. This catches a broken atom before it burns budget. The dry run
   validates the rubric and the atom; it is not the plan. When it looks right, relaunch with the real
   terminal parameters — unbounded when the brief said no round limit — passing `resumeFromRunId` so
   the validated round replays from cache instead of being paid for twice.
7. **Run**, honoring the autonomy mode; report at checkpoints.
8. **Sequence** the next loop if the brief called for one (explore → converge → sentinel, etc.).

Keep every loop small enough to reason about: the fewest workers and verifiers that cover the atom.
More agents is not more quality past the point of coverage.

## Reference map

| Read this | When |
|---|---|
| `references/targeting.md` | Choosing *what* to point a loop at; ranking candidate objectives; recognising a target not worth a loop |
| `references/router.md` | Choosing *which* of the five shapes; the decision tree; the decidability gate |
| `references/atom-design.md` | Designing the unit a loop counts, and its verify contract — the make-or-break ingredient |
| `references/kernel.md` | The seven-plus shared guarantees, their mechanisms and their evidence |
| `references/archetypes.md` | Each archetype's frontier, stop predicate and worked example |
| `references/observability.md` | The ledger and board contract: `progress.json`, `hero`, `runs.jsonl`, captures, pruning, triage |
| `references/substrates.md` | Dynamic Workflow vs in-session fan-out vs a committed CI harness |
| `references/rubric-design.md` | Designing the converger's rubric — the make-or-break ingredient |
| `references/partition.md` | Splitting an artifact so parallel workers don't collide |
| `references/failure-modes.md` | The guardrails, with the mechanism and evidence for each |
