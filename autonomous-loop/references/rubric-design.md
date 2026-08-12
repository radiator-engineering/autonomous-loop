# Rubric Design

The rubric is the ingredient that decides whether a converger works. A good rubric is a
compass; a bad one is a random-walk generator that burns budget and gets gamed. Read this whenever
you define or review a rubric.

## The one rule: an objective rubric measures, it does not opine

Every criterion must resolve to a value a machine (or a critic reading a machine's output) can check
against a threshold — not a taste judgment. This is the difference between the two lineages of the
method: the pure-prompt version drifts because "does it look good?" has no fixed answer; the
engineered version converges because every criterion is a number with a target.

**Invalid criterion:** "The lighting looks good." / "The code is clean." / "Performance is
acceptable."

**Valid criterion:** "Ambient occlusion: luminance drops monotonically by ΔL\* ≥ 8 over the final
~15cm before an edge." / "No function exceeds cyclomatic complexity 15 (`radon cc`)." / "p95
latency ≤ 200ms over the benchmark suite."

If you cannot state the target as a number, a pass/fail predicate, or a diff against a reference,
it is not a rubric criterion — it is a preference, and it belongs in the frozen Bar as context, not
in the scoring.

## Structure

- **Decompose into atomic criteria.** One criterion, one thing. Alignment with human judgment
  *degrades* as a single criterion tries to measure several things at once. Prefer many small
  binary checks over few holistic scores.
- **Prefer binary (PASS/FAIL) over graded.** Binary criteria are the most reliable for an LLM
  judge. Use a 0-N scale only when partial credit genuinely matters, and then anchor each level
  with a concrete description.
- **Label and group.** The FPS bar used A1–D4: axis letter + index. Two orthogonal axes worked well
  ("looks like a modern FPS" vs "looks like real Brazil"). Group your criteria by the independent
  qualities the artifact must satisfy so a critic panel can be split along them (see failure mode:
  diversity collapse).
- **The id is the key, not the wording.** That label is also each criterion's stable id, fixed when
  the rubric is frozen and never re-issued. The ids go into `CRITERION_IDS` in
  `workflow-template.js`, the critic returns one per finding, and every cross-round counter —
  blocker patience, stuck streaks, regression — keys on it. A critic may re-word its prose freely;
  an id outside the list is an unverified verdict, never a new criterion. Keying a counter on
  model-authored prose is the bug this prevents: one blocker whose wording drifted every round read
  as a fresh finding each time, reset its own streak forever, and rode the run to the 200-round
  backstop. Freezing the ids in the rubric is what makes the converger immune to that, and it is the
  reason the converger was the one archetype that never had this hole. The other frontiers reached the
  same place by their own route rather than inheriting this one: the saturator mints ids from the
  LOCATOR and ignores any a finder volunteers, and the explorer — whose hypotheses are not places —
  borrows this mechanism directly, as a frozen charter of at most 8 sub-questions. The rule underneath
  all three: identity must come from a space the model cannot mint into.
- **Report contract.** The critic's output is not prose. It is: total PASS count (`18/25`), and for
  each FAIL, the *measured value vs the target*. No verdict adjectives. This makes rounds
  comparable and the ledger machine-aggregatable.

## The convergence metric must be counted, not vibed

The number the loop watches for convergence — the composite — must be a **deterministic function of
the per-criterion PASS/FAIL**, computed in code (e.g. `passed / total` across the panel), never a
holistic `0..1` score a critic emits. This matters for two reasons:

- **Stability.** Plateau detection and the APPROVE gate compare the composite round-to-round. A
  model-emitted gestalt jitters (±0.05 for the same artifact state), so a counted metric is the
  only way plateau/APPROVE fire on real signal instead of noise.
- **Gaming.** A free-form score is exactly what verbosity/self-preference bias inflates. A count of
  grounded, evidence-tied criteria has nothing to inflate.

So the critic's job is to decide each criterion's PASS/FAIL *with evidence* and report the counts;
the driver does the arithmetic. Let unresolved **blockers gate hard** — pin the composite below the
pass threshold whenever any blocker is open, so a critical failure can't be averaged away by many
passing minor criteria.

Three subtleties the bundled `workflow-template.js` gets right, and any hand-rolled driver must too:

- **Keep two composites, not one.** The *raw* composite (`passed / total`) is the true progress
  signal — plateau detection, keep-best, and the trajectory all read it. The *effective* composite
  is what the APPROVE gate reads: it's the raw value pinned below threshold whenever a blocker is
  open. If you clamp the raw signal instead, a blocker that stays open while quality genuinely
  climbs produces a clamped-*flat* series that trips plateau detection and stops the run **with the
  blocker still open** — a false finish dressed as convergence. So the clamp is for the gate and the
  dashboard only.
- **A missing verdict is an unverified mandate, not a pass.** If a critic crashes and you silently
  drop it (`.filter(Boolean)`), its criteria vanish from the denominator and the composite
  *inflates* — a dead safety critic can let the loop APPROVE having never evaluated safety. Treat an
  incomplete panel as a verification gap that, like a blocker, pins the effective composite below
  threshold until the panel is whole again — and that ages like one too: a gap that never clears
  advances the same blocker-patience counter, so a panel crashing every round ends the run `blocked`
  instead of spinning to the backstop.
- **`converged` means APPROVE actually fired**, never "bestComposite ≥ threshold." A high raw score
  with a blocker open is exactly the state that must report `blocked`, not `converged`.

Never report a **plateau as an outcome while a blocker is open** — that's a failure to escalate, not
a convergence. Route the blocker to the escalation tier (strong model, sole owner of its region)
from the first round; a critical blocker is a hard region by definition.

## Grounding: where the number comes from

Rank criteria by how external the ground truth is. Prefer the top of this list; every rung down is
more gameable.

1. **Deterministic tool output** — test pass/fail, typecheck, lint rule, coverage %, benchmark
   number, compiler error count. Free ground truth, ungameable by wording. **For code, almost every
   criterion should live here.**
2. **Computed metric over the artifact** — pixel thresholds in a defined color space, bundle size,
   AST-derived complexity, dependency count. Objective but you must define the computation exactly.
3. **Diff against a reference** — "matches reference output within tolerance ε." Objective when the
   reference is fixed and the tolerance is stated.
4. **Reference-guided LLM judgment** — the judge is given the reference/solution first, then grades.
   Sharply better than reference-free on reasoning/correctness. Use for qualities 1–3 genuinely
   can't capture.
5. **Reference-free LLM judgment** — last resort. Gets hacked toward *persuasive* rather than
   *correct*. If you must use it, use a panel and order-swap.

## Preamble / normalization

Before grading, normalize the artifact so the criteria measure the thing you mean, not noise. The
FPS rubric converted each frame to CIE L\*a\*b\*, stripped HUD/crosshair/viewmodel, and removed the
sky region — so "world contrast" measured the world, not the UI. For code: define what's in scope
(exclude generated files, vendored deps, test fixtures) so a criterion about "the code" is stable.
State the preamble once; apply it to every measurement identically.

## Anti-gaming hygiene (Goodhart is guaranteed)

A sufficiently optimized proxy is *always* hackable. Bake these in:

- **Keep the builder blind to exact weights/thresholds.** Give builders the concrete defect and the
  fix, not the full scoring function to optimize against.
- **Hold out or paraphrase.** Grade against a held-out subset or a paraphrased rubric so the loop
  can't overfit the literal wording.
- **Length-neutral.** Add an explicit "do not reward length; penalize padding" criterion. Test your
  judge with the "repetitive list attack" (does a padded answer score higher? if so, the judge is
  verbosity-biased).
- **Cap optimization pressure.** More rounds / larger N eventually degrades *true* quality even as
  the proxy climbs. The convergence stop is a Goodhart defense, not just a cost control.
- **Red-team the judge.** Try a "master-key" token (a lone "Solution:" or flattering preamble) and
  a prompt-injection in the candidate. If either moves the score, harden the judge before running.

## Calibration traps (from the FPS harness)

- **Calibrate by central tendency, never the extreme.** The "Piscinão incident": calibrating a
  brightness threshold on the single darkest frame inverted the brightness ordering across all five
  maps. Use means/medians, not min/max, to set thresholds.
- **Constrain visual/structural tweaks with numbers or they break function.** A gun rotated to
  "look better" broke crosshair/bullet alignment; the fix was a hard cap (yaw ≤ 0.09 rad). Any
  criterion that can trade off against a functional invariant needs the invariant stated as a bound.

## When measurability is weak

If, after trying, most criteria land in rung 5 (reference-free judgment), stop and tell the user.
The honest options are: (a) build the missing ground truth first (write tests, define the metric,
obtain a reference), or (b) run a bounded 2-3 pass refine instead of a full converger run and set the
expectation that it won't "converge" — it'll just polish. Do not dress up an unmeasurable target as
a converger; that's the canonical token bonfire.
