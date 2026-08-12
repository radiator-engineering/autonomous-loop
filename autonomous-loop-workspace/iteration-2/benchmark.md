# Autonomous-loop benchmark - iteration 2

Model: Opus 4.8 (both configurations). This iteration re-runs **only the newly added eval-5**; evals
1-4 are unchanged and carry their iteration-1 results.

## Eval-5 (new): decidability-gate-lagging-proxy

Prompt trap: "keep iterating on the landing page until conversion goes up" - a real number exists, so
it tempts a naive loop, but conversion is a lagging, noisy, live-traffic outcome whose per-edit check
is a slow experiment (atom not cheaper to verify than to produce).

| Config | Passed | Δ vs baseline |
|---|---|---|
| with_skill | 4/4 | - |
| without_skill (cold) | 4/4 | +0.00 |

**Discriminating: NO.**

## Honest reading

eval-5 did **not** discriminate at Opus 4.8 (4/4 vs 4/4), repeating the iteration-1 result for eval-4.
The cold baseline already refuses the naive loop, separates fast proxies from the lagging outcome,
warns about reward-hacking / dark patterns, and proposes an inner rubric loop + human-gated A/B outer
loop (it even names the gauntlet-loop skill).

Conclusion: the decidability-refusal reasoning is resident in the base model at this tier. The
decidability gate is therefore a **robustness / consistency floor** - it guards against regressions and
helps weaker tiers - not measured lift at Opus 4.8. The skill's measured, discriminating value is in
**routing** among the enumerable / unknown-size / convergence shapes; the strongest discriminator
remains iteration-1 eval-3 (saturator vs exhauster, 5/5 with-skill vs 2/5 baseline).

## Combined suite (iteration-1 evals 1-4 + iteration-2 eval-5), pooled assertions

- with_skill: 23/23 (100%)
- without_skill: 18/23 (78%)

The 5-assertion gap is entirely in iteration-1 (evals 1-3, routing). Both decidability evals (4 and 5)
are floors at 4/4 = 4/4.
