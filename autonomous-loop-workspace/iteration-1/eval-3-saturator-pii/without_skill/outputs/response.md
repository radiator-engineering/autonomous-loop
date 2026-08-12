# Design: Autonomous PII-in-Logs Detection

## What you actually asked for, restated precisely

Two hard requirements are hiding in one sentence:

1. **Saturation / recall.** Find *every* place PII (emails, tokens, names, addresses, and their neighbors) can reach a log sink — and produce a defensible reason to believe the list is complete, not just "here are the ones grep found."
2. **Autonomy.** Stand up a system that keeps doing this on its own as the codebase changes, without a human re-kicking it.

The first is the interesting engineering problem, so I'll spend most of the design on it. Up front, a piece of honesty that shapes everything below:

> **You cannot *prove* a program never logs PII.** In a Turing-complete language, "does this value ever reach a log sink" is undecidable in general, and PII almost never appears as a literal — it flows in through variables, whole-object dumps, string interpolation, serialized DTOs, and exception context. So "confidence you've found all of them" cannot mean a proof. It has to mean: **converging evidence from several independent detectors with different blind spots, measured against ground truth (seeded canaries), over a *finite, fully-enumerated* set of log call sites.** The finiteness of the sink surface is the lever that turns "find everything" from hopeless into measurable. That reframing is the core of this design.

---

## Part 1 — The detection strategy (how we reach "all of them")

The mistake most PII scans make is to search for PII (grep `email`, regex `\b[\w.]+@[\w.]+\b`). That finds test fixtures and misses `logger.info(user)`. We invert it.

### The key move: enumerate the *sinks*, not the PII

The set of ways this codebase writes to a log is **finite and enumerable**. If we can (a) list every log call site and (b) triage every one of them as *safe / carries-PII / needs-review*, then we have a **completeness claim over the sink surface**: "100% of the places that write logs have been classified." That is the only kind of "we found all of them" that survives scrutiny, so it anchors the whole system.

So we build the sink inventory first, then attack it with layered detectors, then measure recall with runtime ground truth.

### Layer 0 — PII taxonomy registry (config, versioned in-repo)

Before scanning, define what PII *means here*, as a checked-in artifact (e.g. `pii-taxonomy.yml`). Don't invent it from the top of our heads — derive it from where the schema already lives:

- **ORM models / entities** — field names on User, Account, Customer, etc.
- **DB DDL / migrations** — column names and types.
- **API schemas** — OpenAPI/Swagger, GraphQL SDL, protobuf `.proto`.
- **Existing classifications** — anything already tagged (data-classification annotations, Snowflake tags, dbt meta).

Output: a registry mapping each PII class to concrete signals.

| PII class | Detection signals | Difficulty |
|---|---|---|
| Email | field names (`email`, `emailAddress`), literal regex, schema type | Easy |
| Tokens / secrets / keys | field names (`token`, `apiKey`, `authorization`, `password`, `secret`, `sessionId`), high-entropy strings, `Bearer` prefixes | Easy–Med |
| Phone / SSN / DOB / payment | field names + strong regex/Luhn | Med |
| **Names** | schema fields (`firstName`, `fullName`, `contactName`); **no reliable regex** — needs schema tagging + NER | **Hard** |
| **Addresses** | schema fields (`street`, `city`, `postalCode`, `line1`); free-text needs NER | **Hard** |
| IP / geo / device id | field names, IPv4/6 regex | Med |

The registry is the single source of truth every detector reads, and it is versioned so changes to "what counts as PII" are reviewable. Names and addresses are called out as hard on purpose: they have no lexical signature, so we lean on **schema-tagged field names** and **dataflow from typed model fields** rather than pattern-matching log text.

### Layer 1 — Sink inventory (the denominator)

AST-based (not grep) enumeration of every log call site, across every language in the repo. "Log sink" is broad on purpose:

- Standard loggers: Python `logging`/`structlog`/`loguru`, Go `slog`/`zap`/`logrus`, JS `winston`/`pino`/`console.*`, Java `slf4j`/`log4j`.
- Raw output: `print`, `println`, `fmt.Print*`, `System.out`, `process.stdout.write`.
- Error/observability sinks: Sentry `capture*`, Datadog, New Relic, OpenTelemetry span attributes/events, `span.setAttribute`, metric tags/labels.
- Framework edges: HTTP access-log middleware, ORM query logging (`echo=True`, SQL logging), unhandled-exception handlers, request/response interceptors.
- Analytics that double as logs: segment/amplitude `track`, message-queue debug dumps.

Output: `sinks.json` — every call site with file, line, sink family, and the argument expressions. **This list is the denominator for the coverage metric.** We also record the transitive "logging wrappers" the codebase defines itself (`func logRequest(...)`, `class AuditLogger`) so wrappers are treated as sinks too — missing custom wrappers is the #1 way sink inventories under-count.

### Layer 2 — Static taint / dataflow analysis (the highest-signal detector)

Connect **sources** (PII) to **sinks** (Layer 1). Use existing SAST engines rather than hand-rolling dataflow:

- **Semgrep taint mode** — cross-language, fast, custom rules. Primary engine.
- **CodeQL** — deeper interprocedural dataflow for supported languages; GitHub-native; run as the deep/nightly pass.

Sources are drawn from the taxonomy: request bodies/params/headers (`req.body`, `request.headers`, `ctx.Request`), ORM model reads, decoded JWTs, config secrets, env holding credentials. Sinks are Layer 1's families. Sanitizers matter as much as sources — register the codebase's redaction/masking helpers as taint sanitizers so a value that passes through `redact()` before logging is *not* flagged. This is what keeps precision usable.

Illustrative Semgrep rule (the exact shape is load-bearing — taint from request body to any logger, minus the sanitizer):

```yaml
rules:
  - id: pii-request-body-to-log
    mode: taint
    languages: [python]
    severity: ERROR
    pattern-sources:
      - pattern: request.$ANY          # request.json, request.form, request.data...
      - patterns:
          - pattern: $USER.$FIELD
          - metavariable-regex:
              metavariable: $FIELD
              regex: (?i)(email|phone|ssn|address|first_?name|last_?name|full_?name|dob|token|password|secret|api_?key)
    pattern-sanitizers:
      - pattern: redact(...)
      - pattern: mask_pii(...)
      - pattern: "...hash(...)"
    pattern-sinks:
      - pattern: logging.$METHOD(...)
      - pattern: logger.$METHOD(...)
      - pattern: print(...)
```

### Layer 3 — Structural / heuristic detectors (catch what taint misses)

Taint analysis under-approximates across dynamic dispatch, reflection, serialization, and language boundaries. A second, cheaper family of AST detectors catches the common structural smells directly, even without a traced source:

- **Whole-object logging**: `logger.info(user)`, `log.debug("%v", account)`, `console.log(req)`, `logger.info(JSON.stringify(req.body))` — logging an object whose *type* is a PII-bearing model per the taxonomy.
- **Interpolation of PII-named variables**: f-strings/format strings/template literals embedding a variable whose name matches taxonomy fields.
- **Exception context leakage**: logging exceptions that carry request payloads, or `logger.error(f"failed for {email}: {e}")`.
- **Structured-log fields with PII keys**: `logger.info("...", user_email=..., address=...)`.
- **Literal PII** (regex/entropy) as a backstop — this is where email/token regex and gitleaks/trufflehog live, aimed at accidental hardcoded values and token leaks.

Each detector has a *different* false-negative profile; their **union** is what pushes recall up. We deliberately keep them independent so we can measure their overlap (see saturation, Part 3).

### Layer 4 — Runtime / dynamic detection (ground truth)

Static analysis reasons about code; this observes behavior. Two mechanisms:

1. **Log-stream PII classifier.** In staging (and sampled in prod), tap the log pipeline before it lands in the sink and run each line through a PII detector — **Microsoft Presidio** (NER for names/addresses/emails/phones, exactly the classes static analysis is weakest on) plus the taxonomy regexes and an entropy check for tokens. Every hit is a *confirmed* leak with a real stack/logger name, and it maps back to a Layer-1 call site.
2. **Seeded PII canaries (known-answer test).** This is the single most important recall instrument. Drive real code paths in staging with **unique, improbable sentinel values** — e.g. register a user as `canary+7f3a9@pii-probe.example`, address `1 Canary Way #ZZQX`, token `CANARY-<uuid>` — then grep the entire log/observability estate for those sentinels. Anything that surfaces is a leak the static layers *should* have found. **This measures recall directly**, because we know exactly which values were planted.

Static ∪ heuristic gives code-level coverage; runtime gives observed ground truth. **The disagreement between them is the saturation signal** (Part 3).

---

## Part 2 — Architecture of the autonomous system

```
                      ┌─────────────────────────┐
                      │  pii-taxonomy.yml (repo) │  ← Layer 0, versioned
                      └────────────┬────────────┘
                                   │ read by all detectors
   ┌──────────────┬───────────────┼───────────────┬──────────────────┐
   ▼              ▼               ▼                ▼                  ▼
Sink Inventory  Semgrep taint   CodeQL (deep)   Heuristic AST     Runtime tap +
(Layer 1)       (Layer 2)       (Layer 2)       detectors (L3)    canaries (L4)
   │              │               │                │                  │
   └──────────────┴───────────────┴────────────────┴──────────────────┘
                                   ▼
                     ┌───────────────────────────┐
                     │  Findings store + dedup    │
                     │  fingerprint = (file, sink,│
                     │   pii-class, detector)     │
                     └────────────┬──────────────┘
                                  ▼
                     ┌───────────────────────────┐
                     │  Baseline / allowlist      │  ← ratchet: known-safe & triaged
                     └────────────┬──────────────┘
                                  ▼
        ┌─────────────────┬───────┴────────┬─────────────────────┐
        ▼                 ▼                ▼                     ▼
   PR gate (diff)    Dashboard/coverage  Ticket + owner       Feedback loop:
   comments+status   report              routing (CODEOWNERS) runtime hits →
                                                              new static rules
```

**Components**

1. **Sink Inventory Builder** — the denominator; also discovers custom log wrappers.
2. **Static runners** — Semgrep (every PR) + CodeQL (nightly deep pass).
3. **Heuristic detectors** — AST scripts for the structural smells.
4. **Runtime monitor + canary harness** — the always-on staging/prod component; the truest expression of "runs on its own."
5. **Findings store + dedup** — stable fingerprints so the same site isn't re-reported; tracks *which* detector(s) found each finding (needed for overlap analysis).
6. **Baseline / allowlist** — checked-in file of triaged findings (safe, or accepted-with-reason). New findings must clear the bar; the baseline only shrinks. This is the **ratchet** that makes autonomy safe: the gate blocks *new* leaks without drowning in the existing backlog.
7. **Triage & routing** — PR comments, CODEOWNERS-based ticketing, dashboards.
8. **Orchestrator** — the three cadences below.
9. **Feedback loop** — every runtime-confirmed leak that static analysis missed becomes a new Semgrep/heuristic rule automatically-proposed via PR. This is how the system *gets better at finding* over time, i.e. how it self-saturates.

**Three cadences (this is what "on its own" means concretely):**

- **Per-PR, diff-scoped** — Semgrep + heuristics on changed files; fast (< a few min); posts inline comments; **fails the check on any new high-confidence finding not in the baseline.** Prevents new leaks from ever merging.
- **Nightly/weekly full-repo sweep** — all detectors including CodeQL over the entire tree; catches drift, taxonomy changes, and rules added since last run; regenerates the coverage report.
- **Continuous runtime monitor** — the log-stream classifier and periodic canary injections run forever in staging (sampled in prod), alerting to on-call/Slack on any confirmed leak. This is the component that keeps working with zero human involvement.

**Precision controls** (so the gate stays credible and doesn't get muted): confidence tiers (high = taint source→sink with no sanitizer, or runtime-confirmed; medium = heuristic; low = literal regex); sanitizer-awareness so redacted paths aren't flagged; allowlist with mandatory justification; per-rule FP-rate tracking so noisy rules get demoted, not deleted.

---

## Part 3 — How we defend "we found all of them"

This is the crux of the request, so it gets explicit instrumentation rather than a vibe. Five convergent lines of evidence:

1. **Sink-surface coverage.** From Layer 1 we know the total number of log call sites, `N`. The definition of done for a first pass is: **every one of the `N` sites is triaged** (safe / carries-PII / accepted). Reported as `triaged / N = 100%`. This is the concrete, checkable meaning of "all of them" — not "we searched hard" but "the finite set of places that log has been fully classified."

2. **Canary recall (direct measurement).** Plant `K` distinct sentinel PII values across real flows; measure how many the static+heuristic layers predicted vs. how many actually appeared in logs. **Recall = caught / actually-leaked.** A number, tracked over time, with a target (e.g. ≥ 99% on the canary suite before we claim confidence).

3. **Detector-overlap saturation curve.** Because the detectors are independent, track *marginal new findings* as each is added and as rules are expanded. When adding a detector or a rule batch stops surfacing anything the others missed — and canaries stay green — the union has **empirically saturated**. Flatlining marginal yield is the closest honest analog to "we've found them all."

4. **Backtest against known incidents.** Reintroduce (in a test branch) every past real PII-in-logs incident and any public CWE-532 patterns; confirm current rules catch each. A regression suite for the detectors themselves — prevents the system from silently losing recall as it's refactored.

5. **Cross-check static ↔ runtime.** Every runtime-confirmed leak must correspond to a static finding. A runtime hit with **no** matching static finding is a proven blind spot → it auto-files a rule-gap ticket and (via the feedback loop) a proposed new rule. Driving this "runtime-only" set to zero is the strongest possible evidence the static layer has caught up to reality.

**Definition of done for "confident we found all of them":** sink-surface coverage = 100%; canary recall ≥ target; marginal detector yield flat over the last N sweeps; backtest suite green; runtime-only findings = 0. Any single metric is gameable; the conjunction is not. And because the runtime monitor and canaries never stop, this confidence is *maintained*, not just achieved once.

---

## Part 4 — Rollout plan

- **Phase 0 — Foundations (define the truth).** Build `pii-taxonomy.yml` from schemas/models; build the sink inventory; register the codebase's existing redaction helpers as sanitizers. Deliverable: the denominator and the vocabulary.
- **Phase 1 — Baseline sweep.** Run all static + heuristic detectors over the whole repo. Triage every finding, seed the baseline/allowlist. Deliverable: first coverage report + backlog with owners.
- **Phase 2 — Autonomous gate.** Turn on the per-PR check (blocks *new* findings only) and the nightly full sweep + dashboard. Now nothing new merges silently.
- **Phase 3 — Runtime ground truth.** Deploy the log-stream classifier and canary harness in staging; wire alerts; begin static↔runtime cross-check. Now recall is measured, not assumed.
- **Phase 4 — Self-improvement + prod.** Enable the feedback loop (runtime miss → proposed rule), extend sampling to prod, and start remediation.

**Remediation (finding is half the job).** The durable fix is architectural, and the system should nudge toward it: centralized structured logging with **field-level redaction policy**, typed `Sensitive[T]` wrappers whose `String()`/`repr` redact by default, log formatters that drop taxonomy-tagged fields, and lint that forbids passing raw model types to loggers. As redaction coverage rises, static findings should fall — a second, independent signal that things are actually getting safer rather than just quieter.

---

## Summary

- **Invert the search**: enumerate the finite set of log sinks and triage every one — that's what makes "all of them" a checkable claim instead of a hope.
- **Layer independent detectors** (taint, heuristics, literals, runtime NER) so their union maximizes recall and their overlap measures saturation.
- **Measure recall directly** with seeded canaries; **prove blind spots closed** by driving runtime-only findings to zero.
- **Autonomy = three cadences** (PR gate, nightly sweep, always-on runtime monitor) plus a **baseline ratchet** so it blocks new leaks without noise, and a **feedback loop** so it keeps getting better at finding on its own.
- Be honest that absolute completeness isn't provable; deliver *maintained, instrumented confidence* via a conjunction of metrics that no single trick can game.
