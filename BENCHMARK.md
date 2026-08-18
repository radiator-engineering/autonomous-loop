# autonomous-loop — benchmark (honest)

Both configurations run on Opus 4.8. "with-skill" = a subagent handed the skill path and told to
apply it; "baseline" = the same prompt, no skill. Each assertion is graded PASS/FAIL by a separate
strict grader. Single sample per configuration.

## Iteration 1 — four evals

| Eval | What it tests | with-skill | baseline | Δ |
|---|---|---|---|---|
| open-ended-routing | enumerate shapes, gate, pick one, sequence the rest | 5/5 | 4/5 | +1 |
| exhauster-migration | known queue, per-item verify, fail-closed, counted | 5/5 | 4/5 | +1 |
| saturator-pii | unknown-size set, diverse finders, adversarial verify, dry rounds | 5/5 | 2/5 | **+3** |
| decidability-gate (taste) | refuse a loop against "feels premium" | 4/4 | 4/4 | +0 |

Pooled: **with-skill 19/19 (100%)**, **baseline 14/19 (74%)**. No assertion regressed.

## Iteration 2 — added a harder decidability eval

| Eval | What it tests | with-skill | baseline | Δ |
|---|---|---|---|---|
| decidability-gate (lagging/gameable metric) | refuse a loop against a live conversion number | 4/4 | 4/4 | +0 |

## What the numbers mean

- **The measured lift is in routing.** The whole 5-assertion gap sits in iteration-1 evals 1–3.
  The strongest single discriminator is the saturator eval: the baseline mis-routed an unknown-size
  search as an enumerable queue (5/5 vs 2/5) — exactly the exhauster-vs-saturator call the router
  names as most decisive.
- **The decidability gate does not discriminate at Opus 4.8.** Both decidability evals scored 4/4 =
  4/4. A capable base model already refuses an autonomous loop against an unmeasurable or lagging,
  gameable target on its own. So the gate is a **robustness floor** (it guards regressions and helps
  weaker tiers), not measured lift at this tier. This is reported as-is, not spun as a win.
- **Cost.** The skill adds tokens and wall-clock per design response (it reads the reference files
  and writes a fuller plan). The eval cannot measure the skill's real budget win — preventing a
  mis-routed multi-hour loop at run time.

Combined across both iterations, pooled: **with-skill 23/23**, **baseline 18/23** — the gap is
entirely routing.
