# Plan: An Autonomous Loop for Landing‑Page Conversion

## Verdict first

Do **not** build the loop you described — a single agent that autonomously redesigns the page and judges itself against the live conversion number until it "wins." That loop will not converge. It will chase noise, reward‑hack its own metric, and quietly ship dark patterns. Conversion rate is the wrong signal to put *inside* a fast loop: it moves slowly, it's noisy, and it's confounded by traffic mix, seasonality, and campaigns.

Build this instead: a **fast inner loop** that iterates autonomously against an *objective proxy rubric* to produce a few strong candidates, feeding a **slow outer loop** where real conversion is decided by a proper A/B test with a human gate. The agent optimizes design quality autonomously; the *market* decides the winner, under guardrails you control.

## Why the literal version fails

| Problem | What happens if you ignore it |
|---|---|
| **Slow signal** | A real conversion delta needs thousands of visitors and 1–2+ weeks per variant to reach significance. A loop that "iterates until conversion goes up" iterates roughly once a fortnight — and most iterations are inconclusive. |
| **Noise** | Day‑to‑day conversion swings ±10–30% from traffic source, campaigns, weekday. An agent reading the raw number will "learn" from randomness and thrash. |
| **Self‑judging = reward hacking** | If the agent both changes the page *and* decides whether it won, it will declare victory. Left alone it converges on urgency timers, fake scarcity, pre‑checked opt‑ins, and buried costs — things that lift signups this week and destroy trust/refunds/activation next quarter. |
| **Wrong target** | "Signups" is a proxy. Optimizing it in isolation can tank the metrics that actually matter (paid conversion, activation, retention). |

## The structure that works: two loops

**Inner loop — autonomous, minutes to hours, self‑contained.** This is a gauntlet loop (use the `gauntlet-loop` skill to scaffold it): `build → critique → verify → measure against a rubric → iterate` until the bar is met or the budget runs out. It never touches production and never reads live conversion. It optimizes against things that *are* fast and objective:

- **Hard checks (pass/fail):** Lighthouse performance/LCP/CLS budget, accessibility (WCAG AA, keyboard, contrast), mobile + breakpoint layout integrity, no console errors, form works end‑to‑end. Run these headless with the browser tools.
- **Heuristic rubric (scored):** message clarity above the fold, single obvious primary CTA, value‑prop specificity, trust signals present, load‑to‑CTA visibility, copy quality (Orwell/plain‑language pass). Score against an explicit reference bar — e.g. 2–3 landing pages you consider best‑in‑class.
- **Adversarial critique:** a separate critique pass (distinct prompt/agent) attacks each variant against the rubric so the builder isn't grading its own homework.
- **Constraint file (non‑negotiable):** brand voice, legal claims, pricing that must stay visible, and an explicit **anti–dark‑pattern list**. Any variant that violates it is killed regardless of score.

Output of the inner loop is **not** one page — it's **2–4 genuinely different, rubric‑passing candidates** (different hypotheses: hero framing, social proof, CTA, form length).

**Outer loop — human‑gated, days to weeks, decides the real winner.** You (or a PM) review the candidates, approve which go live, and they run as a real experiment against the current control in your A/B tool (Optimizely / VWO / GrowthBook / PostHog experiments — whatever you already have). The experiment platform, not the agent, calls the winner using:

- A pre‑registered **primary metric** (signup conversion) and a **minimum sample size + fixed horizon** computed up front — no peeking, no stopping early on a lucky day.
- **Guardrail metrics** that must *not* regress: bounce, downstream activation, paid conversion, refund/chargeback rate, support tickets. A signup win that moves these the wrong way is a loss.
- A significance/decision rule set in advance (e.g. 95% frequentist or a Bayesian "P(better) > 0.95 and expected loss < X").

Winner gets promoted to control; its learnings feed back into the inner loop's reference bar and rubric. That feedback — real experiment results reshaping the proxy rubric — is what makes the *whole system* actually learn, safely.

```
[Rubric + constraints + reference bar]
             │
   ┌─────────▼──────────┐        autonomous, fast, no prod, no live metric
   │   INNER GAUNTLET    │  build → critique → verify → measure → iterate
   │   (Claude, headless)│──────────────► 2–4 candidate variants
   └─────────▲──────────┘
             │ update bar/rubric from results
   ┌─────────┴──────────┐        human-gated, slow, real traffic
   │   OUTER EXPERIMENT  │  approve → A/B/n test → guardrails → significance
   │  (A/B platform + PM)│──────────────► promoted winner
   └────────────────────┘
```

## Concrete setup

1. **Write the spec files** (this is the real work; do it before any automation):
   - `rubric.md` — the scored heuristics with weights and the reference‑bar URLs.
   - `constraints.md` — brand, legal, pricing‑visibility, and the anti–dark‑pattern blocklist.
   - `hard-checks.sh` — Lighthouse + a11y + link/form smoke test, exits non‑zero on failure.
   - `experiment-policy.md` — primary metric, guardrails, sample size, horizon, decision rule, kill‑switch criteria.

2. **Scaffold the inner loop** with the `gauntlet-loop` skill, pointed at a **staging/preview branch only**. Wire `hard-checks.sh` as the verify gate and the browser tools for rendered screenshots + Lighthouse. Give it a hard budget (token/iteration cap) and require it to emit N distinct candidates with a short rationale each.

3. **Keep it off production.** Inner‑loop output is a PR/preview deploy behind a feature flag, defaulted off. No auto‑promotion to 100% traffic — ever. The agent's write scope ends at "open a PR + preview link."

4. **Schedule and observe, don't unleash.** If you want it running unattended, use a scheduled run (`CronCreate` / the schedule skill) that produces a *batch of candidates on a cadence* (e.g. weekly) and pings you — not a tight self‑judging loop. Pair with a `PushNotification`/Slack summary when candidates are ready or when hard checks fail.

5. **Human gate + experiment.** You approve candidates into the A/B tool. The tool runs the test to its pre‑set horizon. Result (win/lose/inconclusive + guardrail deltas) gets written back into `rubric.md`'s reference bar.

## Guardrails and stop conditions (make these explicit, not vibes)

- **No self‑declared wins.** The agent may report rubric scores; it may never claim a conversion win. Only the experiment platform does.
- **Anti–dark‑pattern blocklist is a hard fail**, checked in critique. Include: fake urgency/scarcity, pre‑checked consents, hidden pricing, confirmshaming, forced continuity.
- **Guardrail metrics gate every promotion.** A signup lift that regresses activation/paid/refunds is rejected.
- **Budget + kill switch.** Cap iterations/tokens per run; a single command (or flag flip) halts everything and reverts to control.
- **One experiment at a time per surface** (or a proper multi‑armed setup) so tests don't contaminate each other.
- **Stop condition for the program, not just a run:** if 3 consecutive experiments are inconclusive, the bottleneck isn't the page — it's traffic quality, offer, or targeting. Escalate to a human strategy review rather than redesigning again.

## Do this week

1. Draft `rubric.md`, `constraints.md`, and `experiment-policy.md` — pick your reference‑bar pages and compute the sample size for a realistic minimum detectable effect (be honest: at your traffic, how big a lift can you even detect, and how long will it take?).
2. Stand up `hard-checks.sh` and confirm it runs headless against a preview URL.
3. Scaffold the inner gauntlet against staging, budgeted, emitting 3 candidates — run it once, review the output quality, tune the rubric.
4. Launch exactly **one** A/B test with the best candidate vs. control. Let it run to its pre‑set horizon untouched. That single disciplined experiment will teach you more than a month of an unsupervised redesign loop.

The reframe in one line: **let Claude iterate autonomously on design quality against a rubric it can't game; let a properly‑powered experiment — with a human gate and guardrails — decide what actually converts.**