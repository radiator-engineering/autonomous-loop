# Failure Modes → Guardrails

Every guardrail in `SKILL.md` maps to a documented way self-improvement loops fail. This file is the
evidence and the mechanism, so you understand *why* each guardrail is non-negotiable rather than
treating them as ritual. When you generate a loop, confirm each guardrail is present and know what
it's defending against.

## 1. Intrinsic self-correction degrades reasoning

**Mechanism.** When a model critiques and "fixes" its own reasoning with no external signal telling
it *when* it's actually wrong, it changes correct answers to incorrect more often than the reverse.
~70% of correct→wrong flips come from *false problem identification* — the critic invents a defect
in something that was already right. Challenging a model ("are you sure?") reliably flips correct to
incorrect (the FlipFlop effect).

**Guardrail.** A critic may only demand a revision it can tie to a concrete, externally-checkable
defect — a failing test, a metric below threshold, a diff against the reference. **Never** an
unconditional "improve this" or "are you sure? try again." Neutral framing: "list defects with
evidence, or output APPROVED." Reserve un-grounded self-critique for genuinely subjective/stylistic
work (where Self-Refine does help); never use it for reasoning/correctness.

_Sources: Huang et al. 2023 (LLMs Cannot Self-Correct Reasoning Yet); Kamoi et al. 2024 (When Can
LLMs Actually Correct Their Own Mistakes); Laban et al. 2023 (FlipFlop); CRITIC (Gou et al. 2023) —
removing external tools eliminates the gains._

## 2. Builder grading itself (self-preference)

**Mechanism.** There is a *causal* link between a model recognizing its own output and preferring it
— tune self-recognition up or down and self-preference moves ~1:1. A builder that judges its own
work systematically over-scores it. Add sycophancy (RLHF models favor the user's/own stated
position over truth) and the loop congratulates itself while standing still.

**Guardrail.** Separate the builder and critic roles absolutely; prefer a *different model family*
for the critic. The builder never sees the rubric weights; the critic never sees the builder's
reasoning.

_Sources: Panickssery, Bowman, Feng 2024 (self-recognition → self-preference); Sharma et al. 2023
(sycophancy)._

## 3. Judge biases: position, verbosity, self-enhancement

**Mechanism.** Even strong LLM judges show: **position bias** (favor a slot regardless of content —
GPT-4 order-consistency ~65%), **verbosity bias** (prefer longer answers; the "repetitive list
attack" inflates scores with padding), and **self-enhancement** (favor own-family outputs).

**Guardrail.** Score both orders and average (order-swap / balanced position calibration). Add an
explicit length-neutral criterion and normalize candidate length before pairwise comparison. Use a
mixed-family panel. Prefer rubric-anchored pointwise scoring — pairwise aligns better with humans
but is ~4× more manipulable under distractors.

_Sources: Zheng et al. 2023 (MT-Bench, four biases, >80% human agreement when controlled); Wang et
al. 2023 (position calibration); Dubois et al. 2024 (Length-Controlled AlpacaEval)._

## 4. Rubric gaming / Goodhart

**Mechanism.** A non-trivial proxy is essentially always hackable, and optimizing a proxy too hard
*degrades the true objective* even as the proxy score climbs — predictably, as a function of
optimization pressure. Judges specifically get hacked by adversarial suffixes and "master-key"
tokens.

**Guardrail.** Keep builders blind to exact weights; ground scoring in tool output wherever
possible; hold out / paraphrase the rubric; cap optimization pressure (the convergence stop is a
Goodhart defense); red-team the judge with suffix/injection/master-key probes before running. See
`rubric-design.md` for the hygiene checklist.

_Sources: Skalse et al. 2022 (reward-hacking formalism); Gao et al. 2022 (RM overoptimization);
Raina et al. 2024 & One-Token-to-Fool (judge adversarial attacks)._

## 5. Diversity collapse (critics all find the same defect class)

**Mechanism.** RLHF is mode-seeking and cuts output diversity; homogeneous critics converge on one
class of issue and miss the rest. A panel of near-identical critics gives false confidence — wide
agreement, narrow coverage.

**Guardrail.** Heterogeneous critics with *distinct mandates* (correctness / security / perf /
spec-compliance as separate axes), diverse-family panel, independent sampling before aggregation,
and argument-quality-weighted aggregation rather than plain majority vote. Track which rubric
dimensions have been exercised and force under-covered ones.

_Sources: Kirk et al. 2024 (RLHF diversity loss); PoLL (Verga et al. 2024 — panel of small diverse
judges beats one big judge, >7× cheaper); correlated-error caveats on panels._

## 6. Spec drift / goal rot over many rounds

**Mechanism.** As critique history accumulates, the working goal quietly erodes — the loop optimizes
against the last critique rather than the original target. Iterative loops also homogenize toward a
narrow style.

**Guardrail.** Freeze the acceptance spec + Bar as an immutable artifact; re-inject it *verbatim*
every round (round-0 RE-ANCHOR); diff each revision against the frozen spec, not just the prior
draft; summarize prior critiques into a stable checklist rather than appending raw transcript. This
also makes mid-flight goal changes safe: edit the frozen spec entry, and re-anchor picks it up
cleanly instead of the goal smearing across rounds.

## 7. Local optima / global incoherence from disjoint decomposition

**Mechanism.** Components each see only part of the problem; composition then violates
whole-artifact coherence on a large fraction of cases (33–94% in one study of ensemble cliques).
Naive fixes often regress.

**Guardrail.** Keep a whole-artifact coherence critic (reads everything, not slices) plus a
single-owner synthesis pass that reconciles parallel edits against the frozen spec. Decompose only
when sub-tasks are genuinely independent; declare cross-region coupling constraints. See
`partition.md`.

## 8. Non-convergence / infinite loop

**Mechanism.** Gains concentrate in the first 2–4 rounds; after ~3 attempts revisions "recycle prior
sequences with minor syntactic changes." Excess iterations degrade the output and exhaust context —
pure cost, negative value.

**Guardrail.** Layered stop: (a) APPROVE gate — stop when the rubric PASS threshold is met; (b)
plateau — stop when score delta < ε for two consecutive rounds; (c) novelty — stop when successive
revisions stop introducing material change; (d) keep-best regression guard — never accept a round
that scored worse overall; (e) a max-round cap. Where you set one, (e) is the biggest single token
lever — but it is a cap, not a stop predicate. An unbounded run (`MAX_ROUNDS = null`) keeps the
lever and moves it: the budget ceiling becomes the hard stop, (b) plateau ends the run that has
stopped moving, and a blocker — or an unverified panel — that survives `BLOCKER_PATIENCE` rounds in
which nothing new was confirmed ends it `blocked`. The stuck rule ends nothing — after 3 consecutive failures on the same criterion it
appends a change-approach directive to that region's builder prompt, so plateau measures a new
approach instead of the twentieth re-tune of one number. The terminal statuses that tell a planned
cap from a backstop hit are in the round-cap knob in `SKILL.md`.

## 9. Cost blowup

**Mechanism.** Each round adds LLM calls; panels, debate (N×R), and best-of-N multiply them. Naive
loops scale cost linearly with rounds that have already plateaued.

**Guardrail.** Tiered models (cheap for capture/measure/mechanical, mid for build/critique, strong
only for stuck-region escalation + final synthesis); a small-model panel instead of one large
judge; early-stop (guardrail 8); complexity routing (only spend more on hard instances); caching;
and a hard budget ceiling (`budget.total` in a Workflow). Default posture `balanced`; `quality-first`
relaxes these deliberately.

## Note on the two lineages

The pure-prompt loop ("the prompt is the method, human is the brake") works in practice largely
because a human supplies guardrails 1, 2, and 8 by watching. The moment you automate the loop, those
guardrails must be *in the loop* — that's the whole reason this skill exists rather than a one-line
"keep improving it until I say stop."
