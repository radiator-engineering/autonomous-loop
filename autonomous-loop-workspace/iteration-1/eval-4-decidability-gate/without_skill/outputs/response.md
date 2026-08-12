# Design: Making the Landing Page Feel Premium — and an Autonomous Loop That Iterates Until It's Actually Great

## The real problem hiding in this request

The request has two halves that pull against each other:

1. **"Feel more premium and high-end"** — a subjective, aesthetic target.
2. **"Keep iterating automatically until it's great"** — an open-ended autonomous process.

The hard part is not writing CSS. The hard part is that **an autonomous loop only converges if it has a *decidable* stopping condition.** "Until it's great" is not a condition a machine — or a model judging its own work — can evaluate reliably. If we hand Claude "make it great and stop when it's great," one of three failure modes happens every time:

- It stops arbitrarily early ("Looks premium now!") because self-assessment is cheap.
- It runs forever, or until the token budget dies, churning sideways without converging.
- It **games its own judge** — it learns that certain phrasings or flourishes make its self-critique say "great," and optimizes for the judge rather than the page.

So the central design decision is: **operationalize "great" into a gate that is (a) objective where it can be, (b) stabilized where it can't be, and (c) always terminates.** Everything else follows from that. I'll cover three pillars:

1. Turn "premium" into a concrete, measurable target (reference bar + rubric).
2. Build the loop (build → evaluate → critique → improve, with elitism and budgets).
3. Make the stopping gate decidable and un-gameable (the crux).

---

## Pillar 1 — Operationalize "premium" before writing any code

"Premium" is not one thing; it's a bundle of concrete, mostly measurable properties. We pin it down two ways before the loop starts.

### 1a. A frozen reference bar

Pick **2–3 exemplar landing pages** that everyone agrees are "premium/high-end" in our category (e.g., Linear, Stripe, Vercel, Arc, a luxury brand site). Capture full-page screenshots at desktop / tablet / mobile widths and store them as immutable reference assets. These are the **comparison anchor** — the judge will always score the candidate *relative to these*, not against its own imagination of quality. A fixed anchor is what stops the target from drifting mid-run.

### 1b. A weighted rubric

Decompose "premium" into scored dimensions. This doubles as the critic's checklist and the judge's scorecard:

| Dimension | What "premium" means concretely | Weight |
|---|---|---|
| Typography | Deliberate type scale (e.g., 1.25 modular), tasteful font pairing, line-height 1.4–1.6, measure 45–75 chars, tracking tuned on large headings | 0.15 |
| Spacing & rhythm | Consistent spacing scale (4/8px base), generous whitespace, aligned to a grid, no cramped or arbitrary gaps | 0.15 |
| Color & contrast | Restrained palette (1 accent + neutrals), intentional use, dark mode, all text ≥ WCAG AA | 0.10 |
| Layout & hierarchy | Clear focal path, grid discipline, alignment, one obvious primary CTA above the fold | 0.15 |
| Motion & micro-interaction | Subtle, purposeful, 60fps, easing not linear, hover/focus/press states, honors `prefers-reduced-motion` | 0.10 |
| Imagery & art direction | High-res, consistent treatment, no stock-photo cliché, correct aspect ratios, no CLS on load | 0.10 |
| Performance-as-feel | Fast is part of "premium": LCP, INP, CLS within budget | 0.10 |
| Detail & states | Focus rings, loading/empty/error states, responsive at every breakpoint, no overflow/jank | 0.10 |
| Copy | Concise, confident, benefit-led, scannable | 0.05 |

Weights are agreed with the human at kickoff (they encode taste and are the one place subjectivity is allowed to live explicitly).

### 1c. Brand invariants (hard constraints, never optimized away)

A list of things the loop must **never** break: logo, legal text, working CTAs and links, tracking/analytics, form submission, required sections, tone-of-voice guardrails. These are asserted every iteration; violating one is an automatic reject regardless of how pretty the result is.

---

## Pillar 2 — The iteration loop

A single iteration is a pipeline, not a vibe. State lives in a `manifest.json` (iteration number, per-dimension scores, gate results, diffs, accept/reject decision, "best-so-far" pointer). Work happens on a branch/worktree per iteration so nothing touches `main` until a human approves.

```
                 ┌─────────────────────────────────────────────┐
                 │  frozen reference bar + rubric + invariants   │
                 └─────────────────────────────────────────────┘
                                     │
   ┌───────► (1) RENDER current page headless @ 3 viewports (Playwright)
   │              → screenshots + DOM + perf traces
   │                     │
   │         (2) AUTOMATED GATES (Tier A) — objective pass/fail
   │              Lighthouse, axe, CLS/LCP/INP, contrast, overflow,
   │              visual-regression diff, token/lint checks, link check
   │                     │
   │         (3) CRITIC agent — reads screenshots + rubric + reference,
   │              emits a RANKED list of specific, located defects
   │              ("hero H1 tracking too loose vs reference; CTA
   │               contrast 3.9:1; card grid misaligned by 6px…")
   │                     │
   │         (4) BUILDER agent — implements the top-K fixes only
   │                     │
   │         (5) RE-RENDER + re-run gates
   │                     │
   │         (6) ELITISM: accept iteration ONLY if weighted score
   │              improved AND no Tier-A regression; else discard,
   │              keep previous best
   │                     │
   └─────────── (7) STOP-GATE evaluation (Pillar 3) ──► stop or loop
```

Key mechanics:

- **Separation of roles.** The **Builder** and the **Critic/Judge** are different agents with different prompts and fresh context. A model grading its own just-written code is the single biggest source of inflated scores; splitting the roles removes the "of course it's great, I made it" bias.
- **Elitism / best-so-far.** We keep the highest-scoring accepted version and never regress from it. A bad iteration is thrown away, not built upon. This guarantees monotonic non-decreasing quality and prevents the classic "wandered off and made it worse" drift.
- **Top-K fixes per iteration.** Small, reviewable diffs. Big rewrites are unreviewable and hard to attribute score changes to.
- **Golden screenshots + visual regression.** Prevents silent breakage of already-good sections while polishing another.

### Automation substrate (how it "keeps going by itself")

- A **background job** (a driver script; scheduled via cron or a watch loop) runs iterations unattended.
- Each **accepted** iteration is pushed as its own commit/PR with before/after screenshots and the score delta in the description, so a human has an audit trail.
- The loop pauses for the human at defined checkpoints (below) rather than auto-merging to production.

---

## Pillar 3 — The decidability gate (the crux)

This is where most "just keep improving it" setups fail. We split the stopping condition into what a machine *can* decide and what it *can't*, and we make the whole thing terminate no matter what.

### Tier A — Hard gates (fully machine-decidable, binary)

These are non-negotiable thresholds. Every one is a deterministic pass/fail from a tool, no judgment involved:

- Lighthouse: Performance ≥ 95, Accessibility = 100, Best-Practices ≥ 95.
- Core Web Vitals: LCP ≤ 2.0s, CLS ≤ 0.05, INP ≤ 200ms (lab).
- axe-core: **0** violations.
- Contrast: all text ≥ WCAG AA (large text AA large).
- Responsive: no horizontal overflow / clipped content at 360, 768, 1280, 1920px.
- Design-token lint: no hard-coded colors/spacing outside the scale (enforces the "restrained system" that reads as premium).
- Brand invariants: all present; all links/CTAs resolve; form submits.
- No visual-regression diff on locked-good regions beyond threshold.

Tier A is genuinely decidable. If any hard gate fails, the loop **cannot** stop, full stop.

### Tier B — Rubric score (approximately decidable, stabilized)

Aesthetics can't be reduced to a number cleanly, so we don't pretend otherwise — we *bound* the subjectivity and make it stable:

- A **fresh judge** agent scores each rubric dimension 1–5 using **anchored descriptions** ("5 = indistinguishable from reference bar; 3 = competent but generic; 1 = amateurish"), doing **pairwise comparison against the frozen reference screenshots**, not free-floating scoring.
- **Self-consistency:** score with an ensemble (e.g., 3 independent judge passes) and take the median per dimension to damp variance.
- The judge **never sees its own prior scores or the target threshold** — this is what stops the loop from reverse-engineering the judge.

### The stopping condition (put together)

> **STOP and declare "candidate ready for human review" when ALL of:**
> 1. Every **Tier-A hard gate passes** (binary), AND
> 2. Weighted **Tier-B score ≥ 4.3 / 5** AND **no single dimension < 3.5** (no lopsided "great except the typography is bad"), AND
> 3. Condition (2) holds **stably across 2 consecutive accepted iterations** (guards against a lucky/noisy single judge pass), AND
> 4. **No regression** vs. best-so-far on any gate.
>
> **ALSO STOP (terminate regardless) when the budget is exhausted:**
> - `max_iterations` reached (e.g., 12), OR
> - token / wall-clock budget spent, OR
> - **diminishing returns**: best weighted score improved < ε (e.g., 0.05) for M consecutive iterations.
>
> In the budget-exhausted case the loop **does NOT claim "great."** It stops, reports the best candidate, and lists the specific rubric gaps that remain, for a human to decide.

This is the decidability gate: the loop **always terminates** — either because it provably cleared an objective bar, or because it hit a hard budget. It can never run forever, and it can never silently declare victory on subjective grounds alone.

### The human backstop (honest about the limits)

Aesthetic "greatness" is not fully machine-decidable, and I won't pretend the gate above closes that gap 100%. What it does is get us ~90% of the way and **refuse to waste human attention on anything that hasn't cleared the objective bar.** So the final decidability authority is a person, at three checkpoints:

1. **Kickoff:** approve the reference bar, rubric weights, and invariants.
2. **First accepted iteration:** a taste-calibration review — does the judge's "4.3" match the human's gut? If not, we recalibrate the rubric anchors before spending more budget.
3. **Final gate:** the loop presents the winning candidate + score card + before/after; a human gives the actual ship/no-ship. The loop **proposes; the human disposes.** Nothing auto-deploys.

---

## Anti-gaming and drift guards (summary)

| Risk | Guard |
|---|---|
| Model grades its own work generously | Separate Builder vs. Judge agents, fresh context |
| Judge reverse-engineers the threshold | Judge never sees target score or its past scores |
| Target drifts mid-run | Frozen reference bar as fixed comparison anchor |
| Polishing A breaks B silently | Golden screenshots + visual regression on locked regions |
| Loop wanders and gets worse | Elitism: keep best-so-far, discard non-improving iterations |
| Score noise triggers a false "done" | Ensemble judge (median of 3) + 2-iteration stability requirement |
| Optimizing prettiness at the cost of function | Brand invariants + link/form/analytics checks as hard gates |
| Runs forever / burns budget | Hard iteration + token + wall-clock caps + diminishing-returns detector |
| Premium look but slow page | Performance folded into Tier-A hard gates (fast *is* premium) |

---

## Concrete tooling (in this stack, not executed here)

- **Rendering & metrics:** Playwright (headless, multi-viewport screenshots + traces), Lighthouse CI, axe-core, a contrast checker, an overflow/responsive assertion script, Stylelint with a design-token rule.
- **Orchestration:** a driver script maintaining `manifest.json`; git worktree per iteration; PR per accepted iteration with score-delta + before/after images; cron or watch loop for unattended runs.
- **Agents:** a Critic prompt (rubric + reference + screenshots → ranked located defects) and a Builder prompt (implement top-K), kept as separate roles; a Judge prompt (anchored pairwise scoring, ensemble).
- **Artifacts per run:** screenshots, Lighthouse/axe reports, the score card, the diff, and the accept/reject decision — a full audit trail.

---

## What I'd do first (if greenlit)

1. Agree the reference bar, rubric weights, and brand invariants with you (30-min kickoff — this is where your taste gets encoded).
2. Stand up the Tier-A harness (Playwright + Lighthouse + axe + token lint) and confirm it runs green/red deterministically on the current page — establish the baseline score card.
3. Wire the Critic → Builder → Judge loop with elitism, budgets, and the stop-gate.
4. Run it to the first accepted iteration and do the taste-calibration checkpoint with you before letting it run the rest of the budget unattended.

The one-line summary: **we make "great" decidable by combining hard, objective gates with a stabilized rubric judged against a frozen reference bar, wrap it in elitism and hard budgets so it always terminates, and keep a human as the final ship authority — so the loop converges instead of drifting or gaming itself.**
