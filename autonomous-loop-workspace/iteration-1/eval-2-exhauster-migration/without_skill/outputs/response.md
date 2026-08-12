# Design: Autonomous migration of ~200 `logInfo()` call sites to `log.info({...})`

## The real requirement

"Grind through it autonomously" and "trust the result at the end" are two goals that pull in
opposite directions unless you engineer for both. Autonomy fails when the task carries hidden
judgment that the model resolves inconsistently across 200 sites and quietly drops data. Trust
fails when the only evidence of correctness is "the diff looks fine" across a 200-file PR that no
human will actually read line by line.

So the design is built around one idea: **make correctness objectively checkable, and make the
judgment calls happen once (up front, with your sign-off) instead of 200 times (silently, mid-grind).**
The model should be grinding against a fixed, machine-verifiable target, not improvising a policy
per call site.

A pure regex/codemod won't finish this job, because the transformation is only *partly* mechanical.
`logInfo("payment failed", err)` → `log.error({ msg: "payment failed", err })` requires deciding
level, field names, and how to unpack interpolated strings. But a pure "let the LLM read each file
and rewrite" approach won't earn trust either. The design splits the work along exactly that seam:
codemod the deterministic part, reserve the model for the judgment part, and gate everything behind
checks that don't rely on anyone eyeballing the whole diff.

---

## Phase 0 — Pin down the transformation before touching code

Do not start migrating until the target is unambiguous. This is the highest-leverage hour in the
whole project; every ambiguity you leave open here becomes 200 inconsistent guesses later.

### 0.1 Inventory the call sites

Produce a machine-readable census so we know the shape of the problem and can measure progress
against a fixed denominator.

```
rg -n --json 'logInfo|logWarn|logError|logDebug' > inventory.raw.json
```

Then classify every hit into buckets by *call shape*, because the migration difficulty is a function
of shape, not of file:

| Bucket | Example old call | Mechanizable? |
|---|---|---|
| A. String literal only | `logInfo("cache warmed")` | Fully (codemod) |
| B. String literal + object meta | `logInfo("saved", { id })` | Fully (codemod) |
| C. Template literal, no meta | `logInfo(\`user ${uid} in\`)` | Needs judgment (extract `uid` → field) |
| D. String + positional args | `logInfo("retry", attempt, max)` | Needs judgment (name the fields) |
| E. Message is a variable/expr | `logInfo(buildMsg(x))` | Needs judgment (opaque) |
| F. Error paths | `logInfo("failed", err)` | Needs judgment (level + `err` field) |
| G. In-loop / hot path / conditional | any of the above | Needs judgment (side-effect + perf review) |

The bucket counts (e.g. "130 A/B, 55 C/D, 15 E/F/G") tell you and me immediately how much is
free and how much is real work. Save this as `inventory.json` — it becomes the worklist.

### 0.2 Write the conventions doc (`MIGRATION.md`)

This is the spec the whole grind executes against. It must answer, with a concrete before/after
example for each rule, at minimum:

- **Level mapping.** `logInfo`→`log.info`, `logWarn`→`log.warn`, `logError`→`log.error`. And the
  non-obvious one: does `logInfo("... failed", err)` get *promoted* to `log.error`? Decide the rule
  ("if an Error is passed, use `log.error`") and write it down.
- **Message field.** Is the human string kept as `msg`? `message`? Is it kept at all, or replaced by
  a stable `event` code? (Recommendation: keep `msg` for the human string *and* leave `event` codes
  out of scope for this migration — one change at a time. Structured fields, not renamed semantics.)
- **Key naming.** `camelCase` vs `snake_case`. Pick one. State it once.
- **Interpolation extraction.** The core judgment rule. e.g. `` `user ${userId} logged in from ${ip}` ``
  → `log.info({ msg: "user logged in", userId, ip })`. Rule of thumb to encode: *strip interpolated
  values out of the message and add them as fields named after the variable; the residual message is
  the static template with values removed.* Give three worked examples including an ugly one.
- **Positional args → field names.** `logInfo("retry", attempt, max)` — what are the field names?
  If the old signature has documented positional meaning, map it; otherwise this is a bucket-D
  judgment case and needs a naming rule (or escalation — see below).
- **Data-loss rule (the invariant that earns trust).** *Every value referenced in the old call must
  appear in the new call.* No silently dropped args, ever.
- **No-behavior-change rule.** No expression may be evaluated a different number of times; no new
  I/O; guards/conditions around the log stay identical. `log.info` calls must be side-effect-equivalent
  to the `logInfo` they replace.
- **Import handling.** How `log` is imported per module, and how the old `logInfo` import is removed
  when the file has zero remaining uses.
- **Out of scope.** Explicitly list what NOT to touch (reordering logs, changing levels beyond the
  error-promotion rule, editing surrounding code, "improving" messages). Scope creep is the #1 way
  an autonomous run produces an untrustworthy diff.

### 0.3 Calibrate on a pilot before scaling

Hand-pick ~12 call sites spanning every bucket. Migrate *those* first, by hand or with the model,
and get your explicit sign-off on the results. This converts `MIGRATION.md` from theory into a
"golden set" of before/after pairs. Only after the conventions survive contact with real code do we
authorize the full grind. This is the single biggest trust multiplier: you approve the *policy* on
12 examples instead of approving 200 diffs.

---

## Phase 1 — Build the safety net (do this before the grind, not after)

Trust comes from checks that run without you. Stand these up first so every batch is graded the
instant it's produced.

1. **Completion metric = a lint rule / grep guard.** Add an ESLint rule (or a CI `rg` check) that
   *bans* `logInfo`/`logWarn`/`logError` entirely. While migrating, the count of violations is your
   burn-down chart; at the end, zero violations is the objective, un-gameable definition of "done."
   This is far more reliable than the model reporting "I did all 200."

2. **Type check + build.** `tsc --noEmit` (or the project's typecheck) must pass. Structured
   `log.info({...})` has a typed payload; a wrong field type or a dropped variable often surfaces here
   for free.

3. **The equivalence harness — the key trust mechanism.** The strongest automated check exploits
   that logging is observable. Temporarily instrument both loggers to emit a normalized record and
   assert *no data is lost* per call site:
   - Add a characterization test that exercises the code paths and captures every emitted log
     payload (level + fields) into a snapshot.
   - Because we *want* structure to improve, don't assert byte-equality of messages. Instead assert
     the **information-preservation invariant**: the set of dynamic values present in the old call's
     output is a subset of the values present in the new call's output, and the level matches (modulo
     the documented error-promotion rule). A tiny AST-diff checker enforces this statically too:
     for each migrated site, collect the set of identifiers/expressions in the old args and confirm
     each appears in the new args. Any site that drops a value fails the gate automatically.
   This is what lets you trust 200 sites without reading 200 diffs: a machine confirms the one thing
   that actually matters — nothing got thrown away and no level silently changed.

4. **Existing test suite green.** Baseline it *before* starting so you can attribute any new failure
   to the migration.

5. **Formatter.** Run Prettier/the repo formatter as the last step of every file so diffs are
   minimal and reviewable, and the model never wastes turns on whitespace.

---

## Phase 2 — Mechanize the deterministic subset (buckets A & B)

Roughly two-thirds of the sites are pure structure with no judgment. Do these with a **codemod**
(jscodeshift / ts-morph), not with per-file model reasoning:

- `logInfo("x")` → `log.info({ msg: "x" })`
- `logInfo("x", { a, b })` → `log.info({ msg: "x", a, b })` (spread the meta object's keys up)
- Rewrite/remove imports.

Why a codemod for this part: it's deterministic, instantly re-runnable, reviewable *once* (you read
the ~40-line transform, not 130 diffs), and it can't get bored and start improvising on site 90.
The model's job here is to *write and test the codemod*, then run it — not to hand-edit.

After the codemod, buckets A/B are done and verified by Phase 1's gates. The grind now only faces
the ~55–70 genuinely hard sites, which is a tractable amount of judgment to supervise.

---

## Phase 3 — Autonomous grind on the judgment cases (buckets C–G)

This is where "grind through it autonomously" actually lives. Structure it as a resumable,
batched worklist with a fixed per-item protocol.

### 3.1 Worklist + resumable state

Drive from `inventory.json`, tracking one record per call site:

```json
{ "id": "src/pay/charge.ts:142", "bucket": "F", "status": "pending",
  "old": "logInfo(\"charge failed\", err)", "new": null,
  "attempts": 0, "notes": null }
```

`status ∈ {pending, done, escalated, failed}`. The model reads the first `pending`, transforms it,
runs the gates on that file, and writes back `done` (or `escalated`). Because state lives in a file,
the run is **crash-safe and resumable** — you can stop and restart the model, or run it across
multiple sessions, and it never redoes finished work or loses its place. This matters a lot for a
long autonomous grind.

### 3.2 Per-item protocol (the loop the model repeats)

For each site:
1. Read the surrounding function so extraction is correct (what is `err`? is this in a loop?).
2. Apply `MIGRATION.md` rules to produce the new call.
3. Self-check against the invariants: level correct? every old value present? no double-evaluation?
   scope untouched?
4. Run `tsc` + lint + the file's tests.
5. If green → mark `done`, commit. If it can't be made green in **N=2** attempts → mark `escalated`
   with a one-line reason, leave a `// TODO(log-migration): <reason>` marker, and **move on**.

The escalation valve is what keeps the run *autonomous*: a hard site never stalls the whole grind or
tempts the model into a risky guess. It gets parked for you, and the grind continues. You end up with
a small, explicitly-flagged pile to review instead of a silent landmine buried in 200 files.

### 3.3 Batching & git hygiene

- Work on a dedicated branch. **Never** touch unrelated code.
- Commit in small, coherent batches (e.g. one commit per directory or per ~15 sites) with a
  consistent message. This makes the eventual review navigable and lets you `git bisect` if a
  behavioral regression shows up later.
- One PR for the codemod (buckets A/B), separate PR(s) for the judgment batches. Reviewing "here's
  the deterministic transform + its output" and "here are the 60 sites that needed thought" as
  distinct artifacts is dramatically easier than one 200-file blob.

### 3.4 Stop conditions (bound the autonomy)

The run halts and hands back to you when any of these trip, rather than grinding on:
- A gate fails in a way the model can't fix within N attempts on the *same* file twice running.
- The typecheck/test baseline goes red in a way that suggests a systemic mistake (e.g. the same
  error class on many files) — stop and reassess the convention, don't paper over 30 files.
- Escalation count exceeds a threshold (say >15% of a bucket) — the convention is probably wrong;
  better to fix `MIGRATION.md` once than to escalate 40 sites.
- Worklist empty → done.

---

## Phase 4 — Earning trust at the end

At completion you should be able to justify trust from evidence, not vibes:

1. **Objective completion:** the ban-lint reports **zero** `logInfo` references. Denominator matched.
2. **No data loss:** the AST-diff invariant checker passes on every site (nothing dropped, levels
   preserved modulo the documented promotion rule). This is the load-bearing guarantee.
3. **Build + full test suite green**, compared against the pre-migration baseline.
4. **The equivalence snapshot** shows the same events firing with the same values, restructured.
5. **Statistical review sample, not full review.** You don't read 200 diffs; you read a random
   sample sized for confidence. If you review ~30 randomly-sampled sites and all are correct, you
   have roughly 90%+ confidence the true defect rate is under ~7% — and because the invariant checker
   already rules out the *dangerous* class of error (dropped data / wrong level), any residual defects
   in the sample are cosmetic (a suboptimal field name), not data-integrity bugs. Review the **entire**
   escalated pile (it's small and pre-flagged), plus the random sample of the auto-done set.
6. **A decision log** appended to `MIGRATION.md`: every non-obvious call the model made, so you're
   reviewing *policies* ("interpolated values named after their variable") a handful of times, not
   individual instances 200 times.

The asymmetry is the whole point: machines prove the invariants that are tedious and critical
(completeness, no data loss, level correctness, compilation); you spend your judgment on a small
calibrated sample plus the explicitly-escalated hard cases.

---

## Artifacts this produces

- `MIGRATION.md` — conventions, worked examples, scope, decision log.
- `inventory.json` — census + worklist + per-site status (resumable state).
- `codemod.ts` — the deterministic transform for buckets A/B, with its own unit tests.
- `check-log-invariants.ts` — the AST-diff / data-loss gate.
- ESLint rule (or CI grep) banning the old helpers — the completion metric.
- `review-sample.md` — the sampled sites for your sign-off.
- A branch with small, bucketed commits and 2–3 focused PRs.

---

## Why this earns the trust the mechanical approaches don't

- **A blind LLM sweep** ("open each file, rewrite the calls") produces a 200-file diff whose only
  QA is human eyeballing — exactly the thing that doesn't scale and where dropped args hide.
- **A pure codemod** can't handle interpolation extraction, level promotion, or positional-arg
  naming — it either mangles those or skips them, and either way you can't trust the result without
  reading everything.
- **This design** does the mechanical bulk deterministically, isolates the ~60 judgment sites for
  supervised autonomous work with an escalation valve, and gates *everything* on invariants a machine
  can check (zero old calls remain; no value dropped; levels preserved; it compiles; tests pass).
  Your review shrinks from "read 200 diffs" to "approve 12 pilot examples + a 30-site sample + a
  small escalation pile" — which is a review you'll actually do, which is why the result is one you
  can actually trust.

## Suggested sequence

1. Inventory + bucket (Phase 0.1) → know the shape.
2. Draft `MIGRATION.md` + pilot 12 sites → get your sign-off on the policy (0.2–0.3).
3. Stand up gates: ban-lint, typecheck, invariant checker, equivalence snapshot (Phase 1).
4. Codemod buckets A/B; verify green (Phase 2).
5. Autonomous worklist grind on C–G with escalation (Phase 3).
6. Final gates + sampled review + decision log; ship in focused PRs (Phase 4).
