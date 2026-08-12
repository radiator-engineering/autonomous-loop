# Design: an autonomous loop to find every place we log PII

This is a plan/design, not an execution. It follows the `autonomous-loop` skill: route to the
right loop shape, design the counted atom and its verify contract, wire the driver, prove the stop
logic, stand up observability, dry-run one round, then run autonomously.

---

## 1. Route — the one-paragraph brief

**Archetype: Saturator.** You want *every* place PII (emails, tokens, names, addresses, and their
kin) reaches a log sink, and the count is unknown up front — finding the members *is* the work, so
this is a search over an unknown-size set, not a known queue. The two knobs:

- **Frontier:** heterogeneous *finders*, each searching a different way (by log-sink API, by grep
  pattern, by dataflow from PII sources, by PII field/schema, by whole-object serialization, by
  logging middleware/config, and — if staging logs are available — by scanning real log output).
  Each returns candidate sites *not already seen*.
- **Stop predicate:** `DRY_ROUNDS = 3` consecutive rounds in which no lens surfaces a new confirmed
  finding, **and** no coverage blocker is open. Bounded by `MAX_ROUNDS = 12` and a budget ceiling.
- **Atom:** a *confirmed PII-into-sink finding*. **Verify:** a separate, adversarial agent tries to
  **refute** it — is the logged value actually PII, does it actually reach a log sink, is it
  unredacted at that sink — and passes only if the finding survives, tagging whether it is novel.
- **Deferred / sequence:** this loop only *finds*. The natural chain is **saturate → exhaust →
  sentinel**: (1) find them all now (this loop); (2) optionally an exhauster that redacts/fixes each
  confirmed finding to a per-item bar (deferred — you asked to find, not fix); (3) a standing
  sentinel wired into CI + a schedule so newly-introduced PII logging is caught on every commit —
  this is what "set this up to run on its own" earns long-term. I recommend committing loop 3.

The rest of this document makes each of these concrete.

### Decidability gate (the make-or-break check) — and an honest caveat

The atom is decidable on the **confirm** side: refuting a single candidate is far cheaper than the
search that produced it. A verifier confirms a finding by three grounded checks, each tied to a
checkable signal in code, not taste:

1. **Is the sink real?** The receiving symbol resolves to a known log sink (see the sink inventory
   in §2), not an arbitrary function that happens to be named `log`.
2. **Is the value PII?** The argument is (or transitively contains) PII — traced to a PII source or
   a PII-typed field, not merely a variable *named* `email` that carries something else.
3. **Is it unredacted at the sink?** No `mask()`/`redact()`/hash/tokenizer sits between the value
   and the sink; a serializer redaction config (e.g. pino `redact`, a `toJSON` scrubber) does not
   already strip it.

A finding passes only if all three hold. That is a cheap, mechanical adjudication over one site.

**The honest caveat, stated up front per the router's decidability rule:** "find *all*" is a
saturation-confidence claim, not a proof. Static analysis has a residual false-negative class —
purely dynamic leaks (an object logged that *sometimes* contains PII depending on request shape,
reflection, `%o`/`{}` format expansion at runtime). No static lens can *prove* zero remain. The
loop earns *justified confidence* two ways, and I call out both so nobody reads `saturated` as a
proof:

- **Lens diversity + dry rounds.** Independent finders that each miss different things, looping
  until *none* of them find anything new for 3 rounds, is a far stronger signal than one pass.
- **A runtime lens (§2, lens 8).** Scanning real (scrubbed) staging log output for PII patterns and
  back-mapping hits to emitting call sites catches exactly the dynamic leaks static analysis can't.
  If staging logs are obtainable, this is the single highest-signal lens for your "confident I found
  all" bar, and the sentinel in loop 3 keeps that guarantee live.

If neither staging logs nor a reliable set of PII field/type definitions exist, that is the "build
the measurement first" case: the pre-work is a PII taxonomy (field names, types, source tables) for
the dataflow/schema lenses to key on. That is cheap here and I assume we can assemble it in round 0.

---

## 2. Design the atom, the lenses, and the verify contract

### The finding (the counted atom)

```json
{
  "id": "src/api/auth/login.ts:212:logger.info",   // normalized path:line:sink — the dedup key
  "where": "src/api/auth/login.ts:212",
  "sink": "winston.logger.info",                    // resolved sink symbol
  "pii_kind": ["email", "access_token"],            // what leaks
  "how": "whole-object: logger.info(req.body)",      // pattern class
  "lens": "by-dataflow",                            // which finder surfaced it (for observability)
  "severity": "critical",                           // triage priority — see note below
  "evidence": "req.body flows unredacted to winston.info; body carries email+access_token; no mask() on path",
  "novel": true
}
```

**Dedup identity (`key`):** normalized `repo-relative-path:line:sink-symbol`. The same site found by
two different lenses collapses to one finding; a candidate the verifier *refutes* is still written
to `seen` so no finder can re-surface it every round (the saturator's #1 correctness rule — dedup
against `seen`, never against `confirmed`).

**Severity is triage priority, not the kernel blocker gate.** This is the one deliberate divergence
from a naive "every bad finding is a blocker" reading, and here is why: in a saturator, findings are
the *harvest* — `saturated` means "we stopped finding new ones," not "there are none." If the mere
existence of a confirmed leak set `severity=blocker`, the run could never reach `saturated` the
instant it found its first leak. So:

- **Finding `severity`** (`critical` = plaintext secrets/tokens/passwords/SSN/full PAN at a retained
  sink; `high` = names/emails/addresses/phone; `medium` = quasi-identifiers, IDs) rides on the
  finding for reporting and for routing the later fix-exhauster. It does **not** gate the run.
- **The kernel blocker gate is reserved for coverage-integrity failures** (below): a search
  dimension we could not honestly execute. That is the one thing that *should* keep us out of
  `saturated`, because we can't claim "found all" if a whole way of looking never ran.

### The lenses (the frontier) — diversity is the whole game

A saturator is only as good as the independence of its finders. Eight lenses, each catching what the
others miss:

1. **by-sink** — First *inventory the sinks* (round 0): every logging API in the stack. Enumerate
   across languages/frameworks actually present — e.g. `winston/pino/bunyan/roarr`, `console.*`,
   Python `logging`/`loguru`/`print`, Go `slog/zap/logrus`, Java `slf4j/log4j`, Rails `Rails.logger`,
   plus observability sinks: **Sentry** (`captureException`, `setContext`, `setUser`, breadcrumbs),
   Datadog/OTel span attributes, LogRocket/FullStory, analytics `track()`/`identify()` payloads,
   crash reporters. Then find every call into those sinks and inspect the arguments.
2. **by-pattern (grep)** — sink calls whose arguments name PII: `\b(email|e_mail|token|access_token|
   refresh_token|password|passwd|secret|ssn|social|dob|birth|address|street|zip|postal|phone|
   first_?name|last_?name|full_?name|card|pan|cvv|authorization|api_?key|cookie|session)\b` appearing
   inside a logging call. Fast, high-recall, noisy — the verifier prunes the noise.
3. **by-dataflow (taint)** — start at PII *sources* (request bodies/headers/query, user/account/
   customer DB rows, auth token issuance, form input) and trace forward to *any* sink. This is the
   lens that catches leaks grep can't see because the variable isn't named for its content. Run this
   lens at the strong model tier — it is the hard, high-value one.
4. **by-schema/entity** — enumerate PII field names from data models, DB schema, DTOs, GraphQL types
   (`email`, `first_name`, `ssn`, `access_token`, `card_number`, …), then find each field referenced
   in a logging context anywhere.
5. **by-serialization (whole-object)** — the big silent leaker: `logger.info(user)`,
   `JSON.stringify(req.body)`, template literals interpolating objects, format specifiers `%o %j {}
   {:?}`, custom `toString`/`toJSON` that include PII, and **error objects** that carry request
   context into an exception logger.
6. **by-config/middleware (indirect sinks)** — request loggers (morgan, express/koa loggers that log
   headers/cookies/query/body), global exception handlers that dump context, **ORM query logging**
   (`echo=True`, statement logging that prints bound params), HTTP-client logging that dumps
   `Authorization`/`Cookie` headers, message-queue/event payloads.
7. **by-diff/history** — logging lines added in recent git history touching PII-adjacent code. Cheap
   incremental lens; also the seed for the sentinel in loop 3.
8. **by-runtime (if staging logs available)** — run PII detectors (regex for emails/PAN/SSN, entropy
   heuristics for tokens/keys, NER for names/addresses) over a scrubbed sample of real log output,
   then back-map hits to the emitting call site. Highest signal for "did we *actually* miss any."

### Verify contract (a *different* agent, adversarial)

The verifier never sees the finder's reasoning. Its prompt:

> Adversarially verify candidate `{id}` at `{where}`. Try to **refute** the claim "`{claim}`".
> Confirm only if all three hold with concrete evidence: (a) `{sink}` resolves to a real log sink;
> (b) the logged value is or transitively contains PII (cite the source/field, not just a name);
> (c) no redaction (`mask/redact/hash/tokenize`, serializer `redact` config, scrubbing `toJSON`)
> sits between the value and the sink. Record `pii_kind`, assign a triage `severity`
> (critical/high/medium per the rubric), and set `novel=true` iff this site's normalized key is not
> already confirmed. If you cannot adjudicate statically (genuinely dynamic path), return
> `pass=false` with `severity=none` and `needs_runtime=true` — do **not** guess a pass.
> **Reserve `severity=blocker` only for a coverage-integrity failure** (a declared lens/tool that
> could not run), never for the existence of a leak.

Concrete cases the verifier must get right (these are what a dry-run checks):
- **Reject** `notify(user.email)` where `notify` is not a sink; `logger.info(mask(email))`; a value
  already stripped by a pino `redact` path.
- **Confirm** `logger.info(req.body)` where the body carries `email`+`token`; `catch(e){ log.error(e)
  }` where `e` wraps the request; morgan logging `Authorization`.

---

## 3. Substrate + fill `assets/loop-template.js` (saturator mode)

**Substrate: dynamic Workflow (substrate #1)** for the initial exhaustive pass — per-agent context
isolation, `budget` ceiling, `parallel()` fan-out over lenses, per-agent model tiering, and
`resumeFromRunId` are all free. If the `Workflow` tool is not available in your environment, fall
back to in-session `Agent` fan-out (substrate #2) — the kernel is identical, you just own the
`while` loop turn-by-turn. Because you want this to "run on its own" recurrently, I additionally
recommend **graduating the finder+verifier to a committed harness (substrate #3)** for loop 3 (the
sentinel) so it is re-runnable in CI. Same atom, same verify contract — only the wiring changes.

Fill the saturator block and placeholders in
`/path/to/autonomous-loop/autonomous-loop/assets/loop-template.js`:

```js
const MODE        = 'saturator'
const MAX_ROUNDS  = 12                 // generous but bounded (quality-first posture)
const DRY_ROUNDS  = 3                  // 3 dry rounds ⇒ saturated — conservative, per "confident I found all"
const MAX_RETRIES = 2                  // for gap recovery (crashed worker/verifier), not for findings
const BATCH       = 24                 // candidates worked per round (quality-first scales this up)
const LENSES      = ['by-sink','by-pattern','by-dataflow','by-schema','by-serialization',
                     'by-config','by-diff','by-runtime']   // drop by-runtime if no staging logs
const SOURCE      = '<repo-root>'      // pass by PATH — never paste the tree into the driver
const LEDGER_DIR  = '<run-dir>'        // ephemeral; served by the workbench
const RUNS_LOG    = '<stable>/pii-audit-runs.jsonl'
```

**Tiering (quality-first — shift each tier up one, per the skill's knobs):**

```js
const TIER = {
  mechanical: { model: 'haiku',  effort: 'low'  },  // sink inventory bookkeeping, ledger writes
  work:       { model: 'sonnet'                 },  // most finders + evidence gathering
  verify:     { model: 'sonnet'                 },  // adversarial confirmer — different agent from finder
  escalate:   { model: 'opus',   effort: 'high' },  // the by-dataflow lens + any needs-runtime item
}
```

Ideally the verifier is a **different model family** from the finders (kernel #1: self-preference is
causal — a finder must not confirm its own candidate). Run `by-dataflow` at `escalate` (it is the
lens that earns its cost).

**Saturator-specific customization vs the stock block.** The template's stock saturator maps
`severity==='blocker'` from a verdict straight into `state.blocked`. I am *narrowing* what a blocker
means (coverage-integrity only, per §2), and *adding* per-lens liveness so a search dimension that
can't run becomes a real blocker rather than a silent coverage hole:

- The verify prompt never emits `severity=blocker` for a finding (findings carry triage severity on
  the atom instead). So a confirmed leak never pins the run to `blocked` — correct saturator
  behavior.
- Track per-lens execution in `frontier`: if a declared lens throws / returns nothing for
  `MAX_RETRIES` consecutive rounds, push a **coverage blocker** (`{id:'coverage:<lens>',
  severity:'blocker'}`). This is the honest gate — you cannot claim `saturated` while a whole way of
  looking never ran. It rides the existing `openBlockers`/`hasOpenBlocker` machinery unchanged, so
  the self-check's blocker invariant still covers it.

Everything else in the saturator block (frontier over `LENSES`, dedup against `seen`,
`countsAsProgress = novel && !seen`, `stop = dry ≥ DRY_ROUNDS && !hasOpenBlocker`) is used as-is.

---

## 4. Prove the driver before running it (zero-token)

```
node /path/to/autonomous-loop/autonomous-loop/scripts/selfcheck_loops.mjs
```

This runs the actual template against a mocked harness and asserts the saturator's invariants in
milliseconds, no tokens:

- **happy** — a clean run reaches `saturated` with `converged===true` and at least one confirmed atom
  (it can't converge on air).
- **noRework** — a judge-refuted candidate is deduped via `seen` and worked exactly once, not
  re-surfaced every round. This is *the* saturator failure mode; if dedup regresses, the loop never
  goes dry and burns budget forever.
- **crashedVerify** — a crashed verifier is an unverified mandate: its item never advances to done
  and the run never reports `saturated` while a gap is open (fail-closed).
- **blockerOpen** — an open (coverage) blocker pins status to `blocked` and the blocked count isn't
  inflated by re-pushes.

If I edit the saturator block (the per-lens-liveness change above), I re-run this first. A green
self-check is the precondition for spending a single token.

---

## 5. Observability (required, not optional)

Launch the bundled workbench on the ledger dir and hand you the URL **before** the run starts:

```
python /path/to/autonomous-loop/autonomous-loop/scripts/workbench_server.py <run-dir>
```

Every round the agents write `progress.json` + `artifacts/`. What this saturator surfaces:

- **Confirmed findings** with `file:line`, `pii_kind`, `sink`, and **which lens found each** —
  lens attribution is how you audit coverage and spot a lens that's contributing nothing.
- **Evidence per finding** (the dataflow trace / sink resolution / redaction check) dropped under
  `artifacts/rN-*` so a human can spot-check the verifier isn't rubber-stamping.
- **The dry-round counter** (`dry / DRY_ROUNDS`) as the progress trajectory — you literally watch
  convergence approach.
- **The blocked list** (coverage blockers) and **needs-runtime** items, prominently.

---

## 6. Dry-run one round, then run autonomously

**Dry-run (mandatory before the long run):** run exactly one round and show you the ledger, the
first handful of confirmed findings with their evidence, and which lens produced each. This is where
a broken atom is caught cheaply — e.g. if the verifier is confirming `notify(user.email)` (not a
sink) or missing `mask()`, we fix the verify contract before burning the full budget. I'll ask you
to eyeball 3-5 findings here.

**Autonomy:** you said "set this up to run on its own," so the default is **autonomous** to the
terminal predicate or the budget ceiling — with one checkpoint offered right after the dry-run so
you can redirect (add a sink we missed, tighten a severity rule) before it goes heads-down. Cost
posture is **quality-first** given your "don't stop until confident" — larger batch, higher round
cap, dataflow lens on the strong tier.

**Terminal outcomes you'll see (all honest):**
- `saturated` — 3 dry rounds across all lenses, no coverage blocker. The confident "we found them
  all" state (with the static-vs-dynamic caveat from §1 attached).
- `blocked` — a lens couldn't run; there's a coverage hole and we say so rather than fake a finish.
- `budget_exhausted` / `capped` — stopped on the ceiling with N confirmed findings and the dry
  counter short of target; not a clean finish, and reported as such.

Deliverable at the end: the full confirmed-findings list (a `findings.json` / table) keyed by
`file:line`, ranked by triage severity, each with evidence — directly consumable as the fix backlog.

---

## 7. Sequence the follow-on loops (this is the "run on its own" part)

The find-loop is loop 1 of a three-loop chain. I'll name all three; you decide how far to go:

1. **Saturate (now).** This design — enumerate every current PII-in-log site to justified
   confidence.
2. **Exhaust (deferred — you asked to find, not fix).** Feed the confirmed findings as a *known
   queue* into an exhauster that redacts/masks each to a per-item bar (verify: the value is
   masked/removed at the sink *and* the surrounding test/logging behavior still passes). This is the
   canonical **saturate → exhaust** composition. Say the word and I'll spec it.
3. **Sentinel (recommended — the real "on its own").** Commit the finder+verifier as substrate #3
   and wire it into CI + a schedule. Invariant: *"no unredacted PII reaches a log sink."* Frontier:
   the `by-diff` lens over each PR's changed lines plus the `by-runtime` lens over sampled staging
   logs. A new leak fails the check (or files a ticket) instead of shipping. This is what keeps the
   guarantee alive after the one-time sweep, and it's cheap because the atom and verify contract are
   already built and self-checked here.

---

## Kernel checklist (all seven present, per `references/kernel.md`)

- **Worker ≠ verifier** — finders find, a different-family adversarial agent confirms; it never sees
  the finder's reasoning.
- **Ground every done** — a finding passes only on the three concrete checks (sink resolves, value
  is PII, unredacted), never "looks like a leak."
- **Count, don't vibe** — progress is the driver's count of *confirmed novel* findings and the dry
  counter, not a model score.
- **Fail closed** — a crashed finder/verifier is an unverified mandate; its candidate retries and
  can't inflate the count; a round with a gap can't declare `saturated`.
- **Blockers gate hard** — a coverage-integrity failure (a lens that couldn't run) pins the run to
  `blocked`; it can't be dried away by quiet rounds.
- **Isolation / anti-rot** — repo, ledger, and candidate lists pass by path; the driver context
  stays thin; every worker is fresh.
- **Budget + tiering** — hard ceiling with a 50k reserve for finalize; haiku for bookkeeping, sonnet
  for finders/verify, opus for the dataflow lens and stuck items.
```
