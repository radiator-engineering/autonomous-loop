# Benchmark — autonomous-loop (iteration 1)

| Eval | with_skill | without_skill | Δ |
|---|---|---|---|
| 1-open-ended-routing | 5/5 | 4/5 | +1 |
| 2-exhauster-migration | 5/5 | 4/5 | +1 |
| 3-saturator-pii | 5/5 | 2/5 | +3 |
| 4-decidability-gate | 4/4 | 4/4 | +0 |

**Pooled:** with_skill 19/19 (100%) · without_skill 14/19 (74%) · Δ +5
**Pass-rate (eval-averaged):** with 1.00 ± 0.00 · without 0.75 ± 0.22 · Δ +0.2500
**Wall-clock:** with 205s · without 131s · Δ +73.4s
**Tokens:** with 68920 · without 35572 · Δ +33349

## Analyst notes

1. Assertion-pooled pass rate: with_skill 19/19 (100%), without_skill 14/19 (74%). No assertion regressed under the skill.
2. eval-3 (saturator/PII) is the strongest discriminator: +3 of the +5 assertion gap. The baseline mis-routed the archetype — it treated an unknown-size search as an enumerable set — which is exactly the exhauster-vs-saturator distinction router.md calls the single most decisive one. It also missed adversarial-refute verification and dedup-against-SEEN.
3. eval-4 (decidability gate) is non-discriminating at Opus 4.8: both configs 4/4. A capable baseline already refuses the undecidable 'make it premium until great' loop and operationalizes it first. Keep it as a no-regression floor; it does not demonstrate lift. Harden it in a future iteration (require the structured brief, or run a weaker tier where the gate is likelier skipped).
4. The baseline's misses cluster in two dimensions: shared taxonomy/vocabulary (eval-1 idx1: never names archetypes) and kernel completeness a from-scratch design forgets (eval-2 idx4: no budget ceiling/tiering; eval-3 idx2/3). Opus 4.8 already reasons well about worker!=verifier, counted progress, decidability, and fail-closed from first principles, so the skill's marginal value concentrates in routing correctness + naming + the specific guardrails, not in teaching the basics.
5. Cost of the skill on this design task: +73s wall-clock and +33349 tokens per invocation (reads SKILL.md + reference files, writes a longer structured design). Reasonable for planning. Unmeasured here is the skill's real budget win at RUN time: preventing mis-routed multi-hour autonomous loops.
