# The router: choosing the loop before you build it

Before you build an autonomous loop you have to choose *which* loop. This is the highest-leverage
decision in the whole method and the one most often gotten wrong. The wrong archetype doesn't run
worse — it runs *forever* (an exhauster over an unknown-size set), or it burns a large budget
polishing taste (a converger over an undecidable atom), or it declares a false finish (any loop over
an atom that can't be verified). Getting this right is worth more than any amount of tuning
downstream.

Use this whenever the user hands you a task and a scale but not a loop shape: "churn through this,"
"work through the whole thing," "find all of them," "figure out why," "keep it healthy." Run the
full procedure for the open-ended case; for a task that already names its shape, do the quick
version (confirm the shape and the decidability gate, then move on).

## 1. Survey the target

Spend cheap effort understanding the task before naming a loop. You are looking for two things: the
shape of the work, and whether its atom can be verified.

- **What is the work?** A single artifact being improved? A list you could enumerate? A search whose
  results you can't predict? An open question? A system to watch?
- **What already exists to verify against?** Tests, CI, type checks, benchmarks, a reference, an
  issue tracker, dashboards, logs. Existing ground truth is what makes a loop cheap and honest —
  find it first.
- **How big, and is the size known?** "The 240 call sites" (known → exhauster) vs "everywhere we
  might leak PII" (unknown → saturator) is the single most decisive distinction.

Keep it to scoped reads (Explore/Grep, CI config, the issue tracker) — not a full audit.

## 2. Classify by the two knobs

Walk the decision tree. It is mechanical:

```
Is the work a SINGLE artifact being improved toward a quality target?
  └─ yes → CONVERGER   (and if it's pure quality-vs-reference, hand to the gauntlet-loop skill)
Is there a KNOWN, enumerable list of work items?
  └─ yes → EXHAUSTER
Are you SEARCHING for all instances of something whose count is unknown?
  └─ yes → SATURATOR
Is the goal to ANSWER an open question, where each step is decided by the last result?
  └─ yes → EXPLORER
Is it a STANDING duty — watch a live system and keep invariants holding?
  └─ yes → SENTINEL
```

Classify by *shape* here; decidability is a separate gate (§3) applied to whichever shape you land
on — do not fold it into the tree. **If no box fits cleanly** — most often a single artifact whose
only "bar" is taste, or nothing measurable anywhere — do not force a shape onto it. Go straight to
§3's decidability gate; its taste-stop is the intended terminal for that case, and it usually
resolves to "build the measurement first" or a bounded best-effort pass that will not truly converge.

Two disambiguations catch most mistakes:

- **Exhauster vs saturator** turns entirely on whether the set is enumerable *up front*. If you can
  write the list, it's an exhauster. If finding the members *is* the work, it's a saturator. When a
  task is "find them all, then fix them all," it's a saturator feeding an exhauster — name both.
- **Explorer vs everything else** turns on whether the next work depends on the last result. If you
  could plan all the work in advance, it isn't an explorer; it's an exhauster with a known plan. An
  explorer's frontier genuinely doesn't exist until earlier rounds create it.

## 3. Gate on decidability — the make-or-break check

Every archetype counts a specific atom, and the atom must be **cheaper to verify than to produce**.
Name the atom and its verify contract explicitly:

| Archetype | Atom | A separate verifier passes it by… |
|---|---|---|
| Converger | a rubric criterion | re-measuring against a tool/benchmark/diff |
| Exhauster | a queue item | checking the item's done-criterion (its test/contract/acceptance) |
| Saturator | a finding | adversarially trying to refute it |
| Explorer | a claim | grounding it against evidence; refuting load-bearing ones |
| Sentinel | an invariant | independently confirming it holds after repair |

If, after trying, the atom can only be judged by taste — "does this read better," "is this the right
architecture," with no test, measurement, reference, or reproducible check — **stop and say so.**
This honesty is the router's most valuable move. The honest options are:

1. **Build the missing measurement first** — write the tests, define the metric, obtain the
   reference. Often this is the real project, and the loop is trivial once it exists.
2. **Run a bounded best-effort pass** instead of an autonomous loop, and set the expectation that it
   will *polish*, not *converge* — a round cap is the honest stop here precisely because no terminal
   state can be earned. This is the one case where a number belongs in the brief.

Do not dress an undecidable atom up as a loop. A loop whose atom can't be verified is the canonical
way to burn a large budget and ship unverified work with a confident green number on top.

## 4. Write the brief and confirm

Output one short paragraph and confirm it before building:

- **Chosen archetype** and, in one line, why the two knobs point there.
- **Frontier** — where the next batch comes from.
- **Stop predicate** — the exact terminal condition as a *predicate*, not a round count: the
  archetype's own terminal state, plus the kernel stops that bound it (`DRY_ROUNDS`, `MAX_RETRIES`,
  `BLOCKER_PATIENCE`, the invariant set, the budget). A converger against a real bar is normally
  **unbounded** — `MAX_ROUNDS = null`, with those stops named. Put a round cap in the brief only
  when the user asked for a bounded sample or a costed probe, or for the undecidable-atom pass in §3.
- **Atom + verify contract** — the unit counted and how a separate agent passes it. If this line is
  weak, you are not done routing.
- **Deferred / sequence** — what you're *not* doing first and why, and the chain if several loops are
  needed (e.g. explore → converge → sentinel). Naming the deferred work shows the user the map and
  is where they'll correct your read of what matters.

The brief is the first draft of the run's configuration: the atom becomes the verify contract, the
stop predicate becomes the terminal parameters, and the archetype selects the `MODE` in
`assets/loop-template.js`.

## When the user already named the shape

Don't belabor it. Confirm the atom is decidable (step 3 — this is the part users skip and it's the
part that sinks runs), sanity-check that a higher-leverage shape isn't hiding (a "work through the
backlog" that's really "first find everything that belongs in the backlog" is a saturator, not an
exhauster), and proceed.
