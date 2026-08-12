Short version: don't build the loop you're describing. "Let it redesign freely and optimize against the live conversion number until it wins" is the single most seductive and most broken shape of autonomous loop, and it fails for a specific, non-negotiable reason. Here's the honest routing and the loop you should build instead.

## Why the naive version can't work

The unit this loop would have to certify is "this design converts better." That atom is **undecidable inside the loop**:

- Conversion is a slow, noisy, statistical signal. Reading a real lift takes weeks of live traffic and a significance test — no agent round can observe it. So the loop has nothing external to verify a "win" against.
- The only alternative left to it is to grade its own designs on *predicted* conversion — i.e. taste. A worker scoring its own output is exactly the failure mode these loops are built to prevent: it drifts, games its own judgment, and hands you a confident green number over unverified redesigns.
- Freely rewriting a live page also has no guardrail. Nothing stops it from breaking the funnel, tanking mobile, or regressing a segment while its self-graded score climbs.

So "just let it run against the number" would burn budget producing plausible-looking redesigns that no one has shown convert better. The metric owner has to be a statistically-gated experiment, and that lives *outside* the agent loop and runs on calendar time.

## The loop you actually build (a composed sequence, not one loop)

The trick is to move the agents off the undecidable atom ("does it convert?") and onto decidable ones ("is this hypothesis grounded in data?" / "is this variant shippable and correctly instrumented?"), and hand the actual win/lose verdict to your A/B platform.

**Phase 1 — Explorer (short, ~1–2 rounds): find where conversion actually leaks.**
- Frontier: hypotheses generated from real funnel data, not vibes — analytics drop-off by step, segment/device splits, session recordings, plus grounded heuristic audits (a 7-field form, CTA below the fold on mobile, unclear value prop).
- Atom: one grounded hypothesis. Verifier (a different agent) passes it only if it's backed by a concrete data pull it can re-run, not asserted. Ungrounded hypotheses go back to the frontier.
- Output: a ranked, evidence-backed hypothesis queue.

**Phase 2 — Exhauster over that queue: turn each hypothesis into a test-ready variant.**
- Frontier: pop the hypothesis queue.
- Atom (this is the decidable one that makes the whole thing honest): a **shippable, instrumented variant**. A worker builds the variant; a *separate* verifier passes it only when it can tie "done" to checkable signals:
  - no regressions vs. control — axe/Lighthouse (a11y + perf/LCP), Playwright functional pass, renders across breakpoints;
  - conversion/funnel events actually fire (verified in the analytics debug stream, not "looks wired");
  - registered as an experiment arm in your A/B platform behind a flag, never pushed direct-to-prod.
- "Done" for an item means **live-test-ready and correctly measured** — explicitly *not* "wins." That's the line that keeps the loop verifiable.

**Phase 3 — the real optimization, which is NOT agent-paced.**
- Ship the arms as a controlled A/B/n test. Your experiment platform + real traffic decide winners at statistical significance. This is the *only* verifier of conversion, and it takes weeks.
- The outer loop (new Explorer round seeded by what won/lost) is therefore **checkpointed and calendar-paced**, gated on each experiment reaching significance — not an unattended run. This is where I'll push back if you insist on "just let it run": the cadence is set by your traffic and significance math, not by tokens.

**Phase 4 — Sentinel (optional, after a winner is promoted):** watch that the promoted conversion rate and the guardrails hold; alert and roll back on regression.

## Kernel guarantees baked in
- Worker ≠ verifier at every phase (the builder never certifies its own variant; the hypothesizer never certifies its own grounding).
- Every "done" tied to an external signal (data pull, axe/Lighthouse/Playwright run, analytics event, or — for conversion itself — the significance test). Never "looks better."
- Fail closed: a variant whose events don't fire or that regresses a guardrail is `blocked`, returns to the frontier, and can't be averaged into a green number.
- Nothing autonomous ever touches prod directly — everything ships behind the experiment framework with a kill switch.

## Terminal parameters (defaults; adjust to your traffic)
- Explorer: stop after 2 dry rounds (no new grounded hypothesis).
- Exhauster: queue empty, every variant verified test-ready.
- **Experiment concurrency capped by your power math** — this matters. If signup traffic is modest, you can only run a handful of arms per quarter at significance; don't let the loop fan out 50 variants you can't power. Give me your monthly unique visitors and current signup rate and I'll compute how many arms/how long per test.
- Budget ceiling on the agent phases; cheap models for the mechanical build/instrument steps, strong model only for stuck variants and hypothesis generation.
- Autonomy: **checkpointed** — you review the hypothesis queue before builds, and review experiment readouts before the next round.

## What I need from you to stand this up
1. The stack: framework/repo for the landing page, and which A/B platform (GrowthBook / Optimizely / VWO / homegrown flags).
2. Analytics access (where funnel + conversion events live) so Phase 1 can ground on real drop-off and Phase 2 can verify event firing.
3. Traffic + current signup rate, for the power math that sets how many variants are worth generating.

Give me those and I'll route the exact archetype config, write the atom's verify contract for each phase, fill the driver, self-check its stop logic, and dry-run one round on a single hypothesis before we commit to anything longer. The thing that ends up genuinely autonomous is the variant-factory-and-instrumentation loop; the "until it wins" part stays gated by significance and stays on your calendar.