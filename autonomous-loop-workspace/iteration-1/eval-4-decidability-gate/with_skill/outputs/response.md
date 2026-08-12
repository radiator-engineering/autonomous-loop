# Design: an autonomous loop to make the landing page premium — and the one honest caveat that decides everything

Short version up front, because it changes the whole shape of the work:

**"Make it feel premium and keep iterating until it's great" is a converger by shape, but its atom — "premium / great" — is undecidable as written.** There is no test, measurement, reference, or reproducible check a *separate* agent can use to pass "this feels premium," so an autonomous loop pointed straight at it would do exactly what ungrounded loops always do: drift, congratulate itself, and burn a large budget polishing taste before declaring a green "great" it never earned. The skill's router calls this out as the single most expensive routing mistake — a converger over an undecidable atom — and its instruction is explicit: *stop and say so; do not dress an undecidable atom up as a loop.*

So the plan is not "here is a loop that runs until it feels premium." The plan is: **make "premium" decidable first, then the loop is easy and safe.** Concretely, I split "premium" into three buckets, ground the first two, and hard-gate the third on a human. That is the make-or-break move, and the rest of this doc builds on it.

---

## Step 1 — Route: survey, classify, gate on decidability, write the brief

### Survey
- **The artifact:** one landing page (markup + styles + assets, plus a built/deployed URL).
- **What exists to verify against today:** unknown until I look, but the candidates are the ones that matter — a build, a way to render it headless, Lighthouse, axe-core, a token/design system if one exists, and any brand/exemplar references. Cheap scoped reads (repo, existing CI, any design tokens, any perf/a11y budgets already in place) come first; not a full audit.
- **Size / known-ness:** it's a single artifact chased toward a quality target — not a queue, not a search.

### Classify (the decision tree)
Single artifact being improved toward a quality target → **Converger**. (And because it's pure quality-vs-reference, the skill says execute it with the sibling **`gauntlet-loop`** skill, which is the converger with the full treatment — frozen Bar, rubric-design guide, region partition, coherence/synthesis passes, live workbench. This skill routes; that one runs Phase 1. More on the handoff at the end.)

### Decidability gate — the part that actually matters
A converger counts one atom: a **rubric criterion**, and a *separate* verifier must pass it by **re-measuring it against a grounded signal**. Run that test against "premium," and it fails — so I decompose "premium" into three buckets by how (or whether) a criterion can be grounded:

**Bucket A — tool-grounded (objective, cheapest to verify).** A criterion whose pass/fail is a number a headless render produces. Examples:
- *Performance:* Lighthouse Performance ≥ 95; LCP < 2.0s; CLS < 0.05; TBT < 150ms. (Lighthouse CI on the built page → JSON.)
- *Accessibility:* zero axe-core violations; body text ≥ 4.5:1 and large text ≥ 3:1 contrast; a visible focus ring on every interactive element; `prefers-reduced-motion` respected.
- *Responsive integrity:* no horizontal overflow and no element collisions at 360 / 768 / 1024 / 1440 px (Playwright bounding-box checks per breakpoint).
- *Token conformance:* every font-size on the modular scale; every spacing value on the 8px grid; every color drawn from the palette tokens (static scan of computed styles).
- *Asset hygiene:* all images have intrinsic width/height (no CLS), served at 2x, under a byte budget.
- *Motion discipline:* transition durations in a 120–400ms band, easing from the approved set, nothing animating layout-triggering properties.

**Bucket B — reference-grounded (frozen exemplars, structured diff, not free taste).** This is how you make most of "looks premium" checkable without a tool inventing one. Freeze 2–3 exemplar premium pages as the **reference bar** (e.g. Stripe, Linear, Vercel, Apple — you pick the aspiration) as screenshots plus an extracted spec. Then each criterion is a *specific, named, measurable* property the reference has, so a different agent confirms it with evidence rather than opinion:
- *Whitespace / vertical rhythm:* hero and section padding within the reference's ratio band (measured from the DOM).
- *Type hierarchy:* ≤ 4 distinct type sizes above the fold; H1→body size ratio inside the reference band.
- *Restraint:* ≤ N accent colors on the page; exactly one primary CTA above the fold (counted from the DOM).
- *Elevation:* one consistent shadow/elevation token family; shadow softness within the reference spec.

Every Bucket-B criterion reduces to a measurement or a counted DOM property — that is deliberate. If a "premium" criterion can't be rewritten that way, it belongs in Bucket C, not in the loop.

**Bucket C — irreducibly subjective (the residue that stays out of the loop).** "Does this *feel* aspirational to our target buyer?" No tool and no reference-diff grounds this. Per the kernel, a verifier may never pass an atom on "looks done," and self-critique with no external signal flips correct work to wrong more than the reverse. So Bucket C is **not** in the counted composite and the loop is **not** allowed to self-certify it. It routes to a human gate (you, or a 3–5 person quick reaction panel). The loop's honest terminal state for C is `awaiting_human`, never `converged`.

**Gate verdict:** As stated, undecidable — **stop**. The honest resolution the router prescribes is option 1: *build the missing measurement first.* Buckets A+B **are** that measurement; building them is the real project, and once they exist the converger is trivial and safe. If you'd rather trade rigor for speed, option 2 is a **bounded best-effort polish pass** — same builders, but it stops on the round cap, not an earned bar, and I will label the output "polished," not "converged." I recommend option 1; I'll note where option 2 plugs in.

### The one-paragraph brief (confirm before I build)
> **Archetype:** Converger — one landing page driven to a bar (executed via the `gauntlet-loop` skill). **Frontier:** each round, a critic panel runs the frozen A+B rubric against the freshly-rendered page and returns per-criterion pass/fail + the concrete fix + the edit region. **Stop:** counted composite `verified-passing criteria / total ≥ 0.95` **and** no open blocker; then a human sign-off gate on Bucket C before anything is called "great." **Atom + verify contract:** a rubric criterion; a *separate* verifier re-measures it by actually running the signal — Lighthouse / axe / Playwright breakpoint check / computed-style scan / pixel-diff against the frozen reference — and passes only with cited evidence. **Deferred / sequence:** Phase 0 *build the bar* (freeze exemplars + write the grounded rubric + confirm the token system) is prerequisite, not part of the loop; Bucket C taste is deferred to a human gate; and an optional Phase 3 sentinel holds the bar on future PRs. The chain is **build-the-bar → converge → (human gate) → sentinel.**

---

## Step 2 — The atom, stated precisely

- **Atom:** one rubric criterion from Bucket A or B.
- **Counted:** `composite = (# criteria a separate verifier confirmed passing) / (total criteria)`, computed **in the driver**, never a model-emitted "premium score." The critic panel *proposes* which criteria fail; it does not score convergence. A panel that self-reports "all pass" cannot converge the run unless the independent verifier re-measures and agrees.
- **Verified passing when:** the verifier ties the criterion to a grounded signal — a Lighthouse number ≥ target, zero axe violations in the region, a measured contrast ratio, a breakpoint render with no overflow/collision, a computed-style value on the token grid, or a pixel/structure diff against the frozen reference within threshold — and cites it.
- **Cheaper to verify than to produce?** Yes, for A and B: producing a fix is an edit + rebuild; verifying is one tool run with a threshold. That inequality is what makes the loop honest. For C it is *not* cheaper (there is no cheap check at all) — which is exactly why C is excluded.

---

## Step 3 — The kernel guardrails, mapped to this page (non-negotiable)

These are identical for every loop; here's what each means for the landing page:

1. **Worker ≠ verifier.** The builder agent that edits the CSS/markup never grades its own result. A different agent re-renders the page and runs the tools. Ideally a different model family for the verifier.
2. **Ground every "done" externally.** No criterion passes on "looks better." It passes on Lighthouse JSON, an axe report, a Playwright measurement, a computed-style scan, or a diff against the frozen reference frame.
3. **Count, don't vibe.** Composite = verified-passing/total, in code. Never "the page is at 8/10 premium."
4. **Fail closed.** If the render fails, Lighthouse times out, or a verifier crashes, that criterion is **unverified** — it does not advance to passing, the round is flagged as a gap, and no positive finish can fire while a gap is open. A broken tool run is an unverified mandate, not a pass.
5. **Blockers gate hard.** Disqualifying failures — a WCAG contrast failure, a broken layout at any supported breakpoint, LCP past a hard floor (e.g. > 4s), or a visual regression that breaks the reference frame — pin the status to `blocked`. 19 typography criteria passing (0.95) with one contrast blocker open is `blocked`, not "95% premium." Blockers route to the strong-model escalation tier from the first round they appear.
6. **Isolation / anti-rot.** The page and the frozen bar pass **by path/URL**, never pasted into the driver's context. Fresh builder per edit region, fresh verifier per criterion, every round. Re-inject the frozen bar verbatim each round rather than letting it smear across accumulated critique.
7. **Budget ceiling + tiering.** Hard token ceiling with a reserve so finalize runs; `haiku` for bookkeeping/ledger writes, `sonnet` for builders and verifiers, `opus` only for stuck regions and blockers.

One converger-specific addition the skill flags: because builders edit **disjoint regions** in parallel (hero, nav, feature grid, footer), a **coherence/synthesis pass** each round reconciles them — e.g. builder A tightening hero spacing while builder B shifts the type scale must not leave the page internally inconsistent. Token conformance (A) plus a whole-page coherence check catches that.

---

## Step 4 — Substrate and template fill

**Substrate:** dynamic **Workflow** (default when the tool is present) — free per-agent isolation, a hard `budget` ceiling, `parallel()` fan-out for the region builders and per-criterion verifiers, per-agent `model`/`effort` tiering, and `resumeFromRunId` so a long polish run resumes instead of restarting. Fill the converger `MODE` block in `assets/loop-template.js`:

- `MODE = 'converger'`
- `PASS_THRESHOLD = 0.95` (the counted composite that means "bar met")
- `MAX_ROUNDS = 12` (hard cap — also the terminal for the option-2 best-effort pass)
- `BATCH = 6` (disjoint edit regions per round)
- `MAX_RETRIES = 2` (a region that keeps regressing under re-measure → blocked, not silently skipped)
- `SOURCE` = the built page URL + repo path
- `LEDGER_DIR` = the ephemeral run dir the workbench serves
- `TIER` = { mechanical: haiku, work/verify: sonnet, escalate: opus }

**One critical wiring note on the verify contract:** verification requires a *real render*. The verifier agents must drive a headless browser (Playwright / headless Chrome, or a live browser via the `browser` / `claude-in-chrome` / `impeccable` skills) to capture screenshots and run Lighthouse/axe/breakpoint/computed-style/pixel-diff. So even under the Workflow substrate, the verify step *shells out to the real tools* — the "standalone committed harness" discipline applied inside the verify contract. That real tool output is what makes each "done" grounded rather than vibed.

`quality-first` cost posture bumps `BATCH`, `MAX_ROUNDS`, and each model tier up one notch; `balanced` (above) is the default.

---

## Step 5 — Prove the driver before spending a token

Run `node scripts/selfcheck_loops.mjs` first. For the converger it asserts exactly the three failure modes this task is prone to:
- a clean run reaches `converged`;
- a **crashed verifier can never produce a positive finish** (`converged=false`) — the false-"it's-great" bug;
- an **open blocker at composite 0.95 still reports `blocked`**, never `converged` — a contrast/layout failure can't be averaged away by passing typography.

Zero tokens, milliseconds. If I touch the template, this runs before anything else.

---

## Step 6 — Observability, dry-run, then run

- **Stand up the workbench** (`python scripts/workbench_server.py <LEDGER_DIR>`) and give you the dashboard URL *before* the run. It surfaces the score trajectory, per-round findings, the **before/after screenshot per edited region**, and the **blocked list** prominently. A converger's dashboard is how you watch real progress instead of "an agent finished."
- **Dry-run exactly one round** and stop: show you the frozen bar, the first critic-panel findings, and the first few criteria verified with before/after screenshots + cited tool output. This catches a broken atom (e.g. Lighthouse not actually running, or a reference frame that's wrong) before it burns budget.
- **Autonomy:** `checkpointed` by default — pause at round boundaries so you can redirect taste and adjust the reference bar, which is where your judgment is most load-bearing. Switch to `autonomous` to the bar/budget once you trust round 1.

---

## Step 7 — Sequence, and what "great" is allowed to mean

The full chain, because "keep iterating until it stays great" is a lifecycle, not one loop:

1. **Phase 0 — build the bar (mostly you + Claude, not the loop).** Freeze the reference exemplars, write the A+B rubric with each criterion's grounded signal, confirm/establish the design-token system, and set the blocker list. This *is* the "build the measurement first" resolution of the decidability gate. It's the highest-leverage hour in the whole project.
2. **Phase 1 — converge (via `gauntlet-loop`).** Run the loop above to `composite ≥ 0.95` with no open blocker.
3. **Phase 2 — human gate on Bucket C.** A quick reaction panel signs off on the irreducible taste residue. The loop reports `awaiting_human` until this clears; only then is it "great."
4. **Phase 3 — sentinel (optional, recommended).** Re-run the same A+B rubric as **invariants** on every future PR/deploy; a regression (perf, a11y, broken breakpoint, reference drift) blocks the merge. This is how the page *stays* premium rather than decaying — the honest reading of "keeps iterating automatically."

**The commitment I'm making about the word "great":** it will never mean "a model decided it's great." It will mean the page **measurably clears a bar you defined** (A+B), a **human signed off** on the taste residue (C), and a **sentinel keeps it there**. If you want speed over that rigor, I'll run the bounded best-effort polish pass instead and label it honestly as polish that stops on the round cap — not convergence.

**Handoff:** because Phase 1 is pure quality-vs-reference convergence, I'll execute it with the **`gauntlet-loop`** skill (frozen Bar, rubric-design guide, region partition, coherence/synthesis, workbench). This skill did the routing and the decidability gate; that one runs the converger.

---

## What I need from you to start (the knobs)
1. **The aspiration** — which 2–3 pages are the frozen reference bar?
2. **Any existing budgets/tokens** — do we already have perf/a11y budgets or a design-token system, or are we defining them in Phase 0?
3. **Cost posture** — `balanced` (default) or `quality-first`.
4. **Autonomy** — `checkpointed` (default; you redirect taste each round) or `autonomous`.
5. **Rigor vs speed** — full converge-to-a-bar (recommended), or a bounded best-effort polish pass.

Confirm the brief and these five, and I'll build Phase 0's bar, fill the converger template, self-check it, stand up the dashboard, and dry-run round one before spending real budget.
