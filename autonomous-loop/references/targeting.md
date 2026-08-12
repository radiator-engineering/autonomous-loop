# Targeting: choosing what to point a loop at

Someone hands you a codebase, a product, or "make this better." Before you can route a shape you have
to name the **objective** — the one change in the world this run is for. A target is not a shape:
"every call site off the old API" is an objective; exhauster is the shape it takes. Targeting picks
WHAT; `router.md` picks HOW (frontier + stop) and owns the decision tree and the decidability gate.
Do not restate either here — link.

The order is: cheap survey → enumerate objectives → score → pick ONE → hand the router its brief →
ask the user (SKILL.md Step 0) → route (`router.md`) → design the atom (`atom-design.md`).

Targeting is the least enforced step in this skill. `preflight_launch.mjs` checks only that
`BRIEF.md` exists with its six sections filled (SKILL.md, "The launch gate" — the BRIEF gate); nothing checks that the objective is
single, is the highest-leverage one, or is worth a loop at all. That judgment is yours, and a loop
pointed at the wrong objective converges confidently with a counted number on top. §7 is what to do
when you find out mid-run.

## 1. Survey — cheap, and stop when you can answer five questions

`router.md` §1 owns three of them: what the work is, what already exists to verify against, and how
big it is and whether the size is known up front. Answer those first — the size question is the most
decisive fact you will collect. Targeting adds two:

- **Where is the pain?** Failing/flaky tests, slow endpoints, bug clusters, open issues, a reference
  the user keeps comparing themselves to, the thing they complained about first. Pain points are the
  candidate objectives; you rarely have to invent one.
- **Can this objective produce a picture?** See §4 — the witness gate makes this a targeting-time
  question, not a reporting-time one.

Scoped reads only (Explore/Grep, CI config, the tracker, dashboards, README). Not an audit.

**The survey produces defaults, never answers.** SKILL.md Step 0 ("Intake") says the first move is to ask, and its
question table requires a recommended default for each of the six; this survey is what
makes those defaults non-empty. A default is a proposal you put in front of the user in
`AskUserQuestion`. A filled `BRIEF.md` section is not: nothing is written there until the user has
answered (SKILL.md Step 0, the rule under the table). That holds for all six, not just the two you feel least entitled to.

## 2. Enumerate candidate objectives

List the distinct objectives you *could* aim at. For each, sketch enough to judge it: what it
changes, what already measures it, what one atom would be. What counts as a good objective differs
by archetype, and this is where the converger-only form of the advice has to be generalized:

| Archetype | A good target is… | …and a bad one looks like |
|---|---|---|
| **Converger** | one artifact, one quality, a bar something outside the loop can measure | several qualities at once; a bar that is a model's opinion |
| **Exhauster** | a queue worth draining, enumerable now, each item carrying its own done-criterion | a queue you would have to discover first (that is a saturator); items whose "done" nobody can state |
| **Saturator** | one class of defect worth finding *every* instance of, with a per-finding refutation test | "find bugs"; two unrelated classes sharing one run (§3) |
| **Explorer** | a question whose answer changes a decision someone is about to make | a question nobody will act on; a question already answered in the tracker |
| **Sentinel** | an invariant set worth standing watch over, sharing one repair contract and one owner | a watch with no repair path — that is a dashboard, not a loop |

Write the list down even when one candidate is obviously ahead. The rejected list is what the user
corrects.

## 3. Score, and pick ONE

Rank on five axes. Score each 1-3 and take the leader.

| Axis | The question | How to read it |
|---|---|---|
| **Value** | does closing this gap matter to the user, in their words? | if you cannot say who is unblocked by it, score 1 |
| **Measurability** | can a separate agent pass the atom against a checkable signal? | **veto, not a weight** — a candidate judged only by taste is not the first loop however valuable it sounds (`router.md` §3) |
| **Iteration yield** | does looping beat one good pass? | see the test below |
| **Tractability** | can a round make safe progress, or is it one coupled rewrite? | archetype-dependent — see below |
| **Witnessability** | can a round produce something a human can look at? | §4 — scoring input, never a veto |

**Tractability is not the same question in every shape.** Parallel partition applies to convergers,
exhausters and saturators; the strict form — "a target that serializes to one worker is a task, not
a loop" — is converger-only (the **Tractability** row above). An explorer's frontier
does not exist until the previous round creates it (`router.md`, the explorer row of the decision tree), so it is serial by design,
and a sentinel's rounds are spread over time rather than across workers (`archetypes.md`, Sentinel).
For those two, score the axis on whether one round's work fits one worker's context and finishes
without a human in the middle.

**The iteration-yield test, per archetype.** Ask what the second round buys that the first did not:

- Converger — a re-measured score that can move. If the bar is met or missed in one pass, it is a fix.
- Exhauster — yield is in *verification and retry*, not repetition: a batch that fails its check
  returns to the frontier. If every item passes first time by construction, run a script.
- Saturator — a different lens finding what the first missed. If one grep enumerates the set, it was
  an exhauster all along.
- Explorer — an experiment whose design depends on the last result. If you can plan all the probes
  now, that is an exhauster with a known plan (`router.md` §2).
- Sentinel — yield is over *time*: a violation that has not happened yet.

### One objective per loop

Run one objective per loop, and sequence the rest. The reason is mechanical in each shape, not
stylistic:

- **Converger** — mixed qualities make critics pull in different directions and nothing converges
  (the reason this section exists at all).
- **Saturator** — `DRY_ROUNDS` counts rounds that surfaced no new confirmed finding, across the whole
  run (`archetypes.md`, the saturator's **Stop**). Two defect classes in one loop means class A going quiet increments
  `dry` while class B is barely searched, and the run can report `saturated` over ground it never
  covered. (Reasoning from the counting rule, not a measured incident.)
- **Explorer** — two questions share one `dry` counter the same way, and the explorer's ids already
  come from a FROZEN CHARTER minted once at init, so its plateau means coverage saturated
  (SKILL.md kernel invariant 3).
- **Exhauster** — the honest constraint is looser: heterogeneous *items* are fine as long as each
  carries its own done-criterion in one schema the verifier can read. One objective still means one
  reason the queue exists, so "drained" means something.
- **Sentinel** — the real exception. Its unit is an invariant *set* by design (`archetypes.md`,
  Sentinel). Keep one watched system and one repair contract; several unrelated systems in one watch
  make an open blocker on one pin the status of all.

For chaining the rest — saturate → exhaust, explore → converge → sentinel, and nesting a loop inside
an exhauster's item — see `archetypes.md` §Composition. Name the chain in the brief; run the first
link only.

## 4. Witnessability: target something that can be seen

A run whose atoms all verified but which filled no hero slot finishes `unwitnessed`, not converged.
The gate and the code that latches it are in `observability.md` §The witness gate; the two incidents
that produced it are in SKILL.md Step 5, under "Observability" and "Knobs". Read them there.

The targeting-time consequence is one instruction: for each candidate, name what the hero slot would
hold — a frame, a diff, the finding in situ, the plot that moved the answer, the live view. If the
honest answer is "nothing visual — it is a headless data migration," that is a valid target; it
declares `hero.type="none"` with a note, and it scores 1 on this axis rather than being disqualified.
Prefer a candidate that can be seen when two candidates otherwise tie.

## 5. What targeting hands to the router

There is one brief and it is `router.md` §4's. Do not write a second — the router's is the document
that survives into the run and becomes the driver's configuration. Targeting contributes three lines
to it:

- **Objective** — the one change, stated concretely. This is the brief's subject.
- **Why** — the score rationale in a sentence, including the measurability veto check.
- **What the hero slot would hold** — or `none` plus what would be needed.

Archetype, frontier, stop, atom and deferred are the router's fields (`router.md` §4). Carry your
recommended archetype and candidate atom in as *proposals*; the router confirms or overrides them.

Then ask (SKILL.md Step 0). The brief supplies the defaults; the user's answers overwrite them and
get written to `BRIEF.md`. If the user redirects the objective, redo §3 against their objective
before routing — do not carry a score computed for the target they just rejected.

## 6. When a target is not worth a loop

Say so, and say what to do instead:

| You find | Do this instead |
|---|---|
| The atom is judged only by taste | §3's veto already refused it; take one of `router.md` §3's two honest options |
| The whole queue fits in one agent's context and verifies in one pass | Do it directly. Measure it rather than guessing: run `atom-design.md` §1's one-atom pass, and if one worker plus one verifier drains the queue, per-round machinery buys nothing |
| The fix is known and one-shot | Fix it. Iteration yield is 1 (§3) |
| The bottleneck is a decision, not production | A loop cannot make a ruling. Return the decision as a question |
| The proposed bar is a proxy someone will optimize instead of the thing | Retarget onto the thing, or gate the proxy — `atom-design.md` §9 |
| Nobody owns the result | Find the owner before spending. An unowned green run changes nothing |
| The verification exists but is red for unrelated reasons | Fix the ground truth first; a loop over a broken signal counts noise |

## 7. When the target turns out to be wrong mid-run

Targeting is not a one-time step. `checkpointed` is the default autonomy mode precisely so a human
can inspect and redirect at a round boundary (SKILL.md Step 5, the *Autonomy* knob); the board and `progress.json` are
what you read at that boundary. These signals each name a targeting mistake rather than a tuning
problem:

| On the board / in `progress.json` | The mistake | Move |
|---|---|---|
| `confirmed` climbing while the hero slot shows nothing moving | the atom counts something the objective is not about | retarget the atom against the thing in the picture (`atom-design.md` §6) |
| `dry` climbing in a saturator's first rounds | the defect class was drawn too narrow, or the set was enumerable all along | widen the class, or stop and re-route to an exhauster (`router.md`, the saturator/exhauster branch of the decision tree) |
| every open blocker traces back to one shared assumption | the objective sits downstream of an unmade decision (§6 row 4) | stop. Return the decision as a question; a loop cannot make a ruling |
| an explorer whose `dry` never accumulates | a charter that is too coarse — its cells are (sub-question × finding), so one broad sub-question absorbs every result | re-charter with finer sub-questions; `dry` is a real plateau now (kernel invariant 3), so a run that will not accumulate it is telling you the decomposition is wrong |
| an exhauster where no item ever returns to the frontier | iteration yield was 1 (§3); this was a script | finish the queue as a batch instead of paying per-round machinery for the rest |

**Retargeting is a new run, not a redirect.** Change the objective and every cross-round counter —
`dry`, `stall`, blocker patience, dedup — is still counting against the old one. Stop the run,
rewrite `BRIEF.md`, re-score from §3, and launch a fresh run with its own `run_id` and ledger.
`resumeFromRunId` continues the *same* run and is the wrong tool here (`archetypes.md` §Composition;
`kernel.md` §6).

## Worked example

*"Here's the repo, make it better."* Survey (scoped reads only): a Vite web client plus Rust crates;
CI runs tests and a lint job; 40 open issues, 9 of them tagged perf; the user's first sentence was
about the app feeling slow; there is a benchmark harness but no benchmark in CI.

Candidates and scores (value / measurability / yield / tractability / witnessability):

| Candidate | Shape | Score | Verdict |
|---|---|---|---|
| p95 interaction latency under a bar | converger | 3 / 3 (bench exists) / 3 / 2 / 3 | **picked** |
| Close the 9 perf issues | exhauster | 2 / 2 (no per-issue criterion) / 2 / 3 / 2 | deferred — most are symptoms of the above |
| Find every unbounded render loop | saturator | 2 / 3 / 3 / 3 / 2 | sequenced second |
| "Improve code quality" | converger | 2 / **1 — vetoed** / 2 / 2 / 1 | refused: taste atom |
| Keep p95 under the bar after landing | sentinel | 3 / 3 / 3 / 3 / 2 | sequenced third |

Into the router's brief: objective *"p95 interaction latency under 100 ms on the recorded trace"*;
why = the only pain point with existing ground truth; hero = the flame graph and the trace's frame
each round. Proposed converger, atom = one bench case re-measured by a separate agent; deferred = the
perf issues and the render-loop sweep, chained converge → saturate → sentinel. Then ask the six
questions with those as defaults, and route.
