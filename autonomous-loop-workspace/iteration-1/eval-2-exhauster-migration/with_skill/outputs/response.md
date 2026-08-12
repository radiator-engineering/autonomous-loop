# Migrating ~200 `logInfo()` call sites to `log.info({...})` — autonomous loop design

You want Claude to grind through the whole thing unattended and hand you a result you can trust.
The trustworthy version of this is not "one agent editing 200 sites in a long session" — that
context rots, self-certifies, and reports a confident green number over work it never checked. It's
an **exhauster loop**: a fixed queue drained to *verified*-empty, where a separate agent grounds
every "done" against real signals, and any site that can't be verified surfaces as a **named blocked
item** instead of a silent break.

Everything below maps onto the bundled driver
(`/path/to/autonomous-loop/autonomous-loop/assets/loop-template.js`, `MODE =
'exhauster'`) and the shared kernel. The pieces that carry the trust are the *atom's verify
contract* and the *enumeration*; I spend most of the design there.

---

## 1. Routing brief (confirm this before building)

- **Archetype: Exhauster.** The work is a *known, enumerable* list — every `logInfo(` call site is
  discoverable with a grep up front and the set only shrinks. It is explicitly **not** a saturator
  (we can write the list; finding members isn't the work) and not a converger (there's no single
  artifact chasing a taste bar).
- **Frontier:** pop the next batch of unresolved **files** from a queue seeded by a deterministic
  enumeration of all call sites (see §3). One file = one work unit so parallel workers never collide
  on the same source.
- **Stop predicate:** every queued file is *resolved* — each is either **verified migrated** or
  **declared blocked** — and no blocker is open. The run ends `drained` only if all files verified
  and the global backstop (§8) passes; otherwise `blocked` with a list.
- **Atom + verify contract (the make-or-break, §2):** the atom is a file's migration. A *separate*
  verifier passes it only when: zero `logInfo(` remain in the file, type-check + lint + covering
  tests pass (real tool output as evidence), and the structured-field mapping is semantically
  faithful to the original per the mapping spec. A worker never certifies its own file.
- **Deferred / sequence:** this is a near-pure exhauster with a small **codemod pre-pass** in front
  (build the mechanical transform first — router's "build the measurement/tooling first" move) and a
  single terminal item at the end (delete the old `logInfo` helper, gated on all call sites
  migrated). No separate loop is needed; the composition is *exhaust with a deterministic pre-pass +
  a final global gate.*

The decidability gate passes cleanly: a call-site migration is far **cheaper to verify than to
produce** — the bulk of the check is `grep` + `tsc` + `lint` + the test runner, and only the
message/field mapping needs judgment, which we ground against a diff and an explicit rule sheet, not
taste.

---

## 2. The atom and its verify contract (spend your design budget here)

The unit of work is **one file** (owning all `logInfo` calls in it). A file is `verified` only when a
verifier that is a *different agent than the worker* can tie every clause below to a concrete signal
and return it in the `evidence` field of the `VERDICT_SCHEMA`:

| # | Done-criterion | Grounded signal (must appear in `evidence`) | Kind |
|---|---|---|---|
| a | No old calls remain | `grep -c 'logInfo(' <file>` returns `0` | mechanical |
| b | New API used correctly | each migrated line calls `log.info({...})` with an object arg | mechanical + judgment |
| c | Compiles | `tsc --noEmit` (scoped to the file/module) exits 0 | tool |
| d | Lint clean | linter passes; old `logInfo` import removed, `log` imported, no unused imports | tool |
| e | Tests pass | the tests covering this file (or the batch's suite) pass | tool |
| f | **Semantic fidelity** | the diff preserves the original message text and captures the *same* interpolated values as named structured fields, per the mapping spec (§3) | judgment, grounded on the diff |

Clause **(f)** is the only real judgment, and it is where a naive "replace-all" script silently
loses information (e.g. `logInfo("user " + id + " logged in")` must become
`log.info({ msg: "user logged in", userId: id })`, not `log.info({ msg: "user " + id + " logged
in" })`). The verifier reads the *diff* against the mapping rules and either passes with the mapping
cited or fails with `severity`:

- `blocker` — the original intent can't be mapped faithfully (dynamically-built message, an arg
  shape the spec doesn't cover, a call whose fields are ambiguous). These are exactly the sites you
  want a human to see.
- `major` / `minor` — a fixable slip (wrong field name, missed a value); returns to the queue for
  rework.

**Fail-closed is literal here:** the verifier must run the tools and paste their output. A verdict of
`pass` with no `tsc`/test output is not grounded and is treated as a crash → unverified → the file
returns to the frontier. A test runner that times out is *unverified*, never a pass.

---

## 3. Enumeration + the codemod pre-pass (the trust anchor)

**An exhauster is only as honest as its enumeration.** If the seed queue misses sites, the loop
happily drains a wrong list and reports `drained` over calls it never touched. So the seed is done in
code, not by a model's estimate, and it is alias-aware:

1. **Enumerate deterministically.** `rg -n 'logInfo\s*\(' --type-add ...` across *all* relevant
   extensions, plus a pass for indirect references (`import { logInfo as X }`, re-exports,
   `logInfo` passed as a callback). Emit `queue.json` as `{items:[{id:<file>, sites:[lines],
   task}]}` and **pin `total` from this count in code** — this is the denominator the progress
   number divides, and it must be a real count, never "~200".
2. **Write the mapping spec once.** A short rule sheet: how positional/string args map to named
   fields, the canonical field names (`msg`, `userId`, `requestId`, …), how to handle interpolation,
   objects, and error args. This is the reference clause (f) is graded against — it makes the
   judgment reproducible instead of per-agent taste.
3. **Run a deterministic codemod as a pre-pass** (ts-morph / jscodeshift / AST transform) that
   applies the mechanical 80% and *flags* the residue it can't safely transform (dynamic messages,
   odd arg shapes) as `manual`. Crucially, **codemod output is not trusted** — every file it touches
   still flows through the same VERIFY step, so a bad codemod rule surfaces as blocked files, not a
   silent break shipped to prod. Workers only hand-migrate the flagged residue and rework verify
   failures. This is the single biggest budget and variance lever: agents spend their tokens on the
   hard sites, not the boilerplate.

---

## 4. How the kernel guarantees show up in *this* run

These are not add-ons; the template implements them once and the self-check proves they hold. What
each means concretely here:

- **Worker ≠ verifier.** The agent that edits a file never grades it. A different agent (ideally a
  different model family) runs the tools and judges fidelity. Self-preference is causal — a
  self-graded migration congratulates itself over a broken logger.
- **Count, don't vibe.** Progress = `confirmed_files / total_files`, computed in the driver from
  verified verdicts. No model emits a "we're ~90% done" gestalt.
- **Fail closed.** A crashed worker, a crashed verifier, or a verdict without tool evidence is an
  *unverified mandate*: the file does **not** advance to done, it returns to the queue under
  `MAX_RETRIES`, and it **stays in the denominator** so the count can't inflate. The run cannot
  report `drained` while any mandate this round went unverified.
- **Blockers gate hard.** A file with an unmappable call, or one whose tests keep failing after
  `MAX_RETRIES`, becomes a *named* blocked item. `199/200` verified with one blocked reports
  **`blocked`**, not `99.5%`. Blockers route to the escalation tier (Opus) from the round they
  appear. This blocked list — a short, precise set of "human, decide this" sites — is the entire
  reason to run this instead of a for-loop.
- **Isolation / anti-rot.** Every file gets a fresh worker and a fresh verifier; the queue, diffs,
  and ledger pass by **path**, never accumulated in the driver's context. The loop can run for hours
  without instruction-following decaying.
- **Budget ceiling + tiering.** Hard token cap with a reserve so finalize runs; cheap model for
  enumerate/ledger, mid for worker/verify, strong only for stuck/blocked files.

---

## 5. Substrate and template fill

Default to a **dynamic Workflow** (`references/substrates.md` #1) — per-agent isolation, a hard
`budget`, `parallel()` fan-out, per-agent model tiering, and `resumeFromRunId` for resume all come
free. Fill the exhauster block and placeholders in
`/path/to/autonomous-loop/autonomous-loop/assets/loop-template.js`:

```js
const MODE        = 'exhauster'
const MAX_ROUNDS  = 12          // ceil(total/BATCH) + retry headroom; queue-size bounded, not vibe
const MAX_RETRIES = 2           // rework attempts before a file is declared blocked
const BATCH       = 10          // files migrated + verified per round, in parallel (non-overlapping files)
const LEDGER_DIR  = '<run dir served by the workbench>'
const SOURCE      = '<abs path>/queue.json'   // the deterministic enumeration from §3
```

Exhauster specifics to adapt (the template already wires the loop; you localize the prompts):

- `init` — load `queue.json`; `state.total` = the pinned count; each file → `state.open`.
- `workerPrompt(file)` — "Migrate every `logInfo` call in `<file>` to `log.info({...})` per the
  mapping spec at `<path>`. Codemod already handled non-`manual` sites; hand-migrate the flagged
  ones and preserve message + all interpolated values as named fields. Remove the `logInfo` import;
  add `log`. Edit only this file."
- `verifyPrompt(file)` — "Independently verify `<file>`: run `grep -c 'logInfo('` (must be 0),
  `tsc --noEmit`, the linter, and the covering tests; paste their output. Then read the diff against
  the mapping spec and confirm semantic fidelity (clause f). Pass only on concrete evidence; an
  unmappable call is `severity=blocker`."
- `stop` / `reachedGoal` — unchanged: `open.size === 0`, and `drained` iff no open blocker **and**
  `confirmed.length === total`.

**Parallel-safety:** atoms are whole files and a batch is chosen non-overlapping, so workers don't
collide. If your build step needs isolation (shared module resolution, a codegen step), run each
worker in a git worktree (`isolation:"worktree"`) and merge per round.

**Terminal helper item:** add a final queue item "delete the `logInfo` helper definition + its
export," dependent on `confirmed === total`. Deleting it earlier would break every unmigrated file;
gating it on full drain makes its own verify (repo compiles with the helper gone) the last brick.

---

## 6. Prove the driver before spending a token

Stop logic is code, so test it as code. Run:

```
node /path/to/autonomous-loop/autonomous-loop/scripts/selfcheck_loops.mjs
```

It exercises the exhauster mode against a mocked harness and asserts the invariants that make this
trustworthy: a clean run reaches `drained`; a **crashed verifier can never produce a positive
finish** (`converged=false`); an open blocker forces `status='blocked'` and can't be averaged or
retried into silence (239/240 with one blocked ⇒ `blocked`). If you touch the template, run this
first — it catches the false-`drained` bug in milliseconds instead of after a long run.

---

## 7. Observability + the dry-run gate

- **Live dashboard.** Launch
  `python /path/to/autonomous-loop/autonomous-loop/scripts/workbench_server.py
  <LEDGER_DIR>` and I give you the URL *before* the run. Every round writes `progress.json`:
  `files done / total`, the in-flight batch, the trajectory, and — most prominently — the **blocked
  list**. Per-round artifacts drop the diff and the tool output per file under `artifacts/`.
- **Dry-run one file first.** Before committing to the full run, migrate one representative file
  (ideally one with a tricky interpolated message), and show you the diff, the `tsc`/test output,
  and the verifier's verdict. This catches a broken atom or a wrong mapping rule before it burns
  budget across 200 sites. This is the checkpoint where you correct my read of the mapping.

---

## 8. What "trust the result at the end" concretely means

The run reports exactly one terminal status, and each is *earned*:

- **`drained`** — every file verified (old calls gone, `tsc`/lint/tests green, fidelity confirmed by
  an independent agent) **and** two global backstops pass: (1) a fresh repo-wide `rg 'logInfo\('`
  returns **zero** — the catch for any call site the enumeration missed (aliases, an extension the
  seed grep skipped); (2) the **full** test suite and a full type-check pass, catching cross-file
  breakage a per-file check can't. Only then is the helper-deletion item closed. This global grep is
  what turns "we processed the list" into "the codebase truly has none left."
- **`blocked`** — one or more files couldn't be verified (unmappable call, persistent test failure).
  You get a short, precise list of sites needing a human decision, each with its evidence — never
  buried under a 97% number.
- **`budget_exhausted` / `capped`** — the loop stopped on a resource bound with work outstanding;
  the ledger says exactly what's left, and the run is resumable via `resumeFromRunId`.

That is the difference from a hand-rolled batch script: a partial failure becomes a *visible blocked
item*, not a latent broken logger shipped to prod.

---

## 9. Knobs (defaults; change at launch if you want)

- **Cost posture — `balanced`:** Haiku for enumerate/ledger bookkeeping, Sonnet for
  worker + verifier, Opus (high effort) reserved for stuck files and blockers. The codemod pre-pass
  removes the mechanical majority from the agent budget entirely.
- **Autonomy — `checkpointed` for round 1, then `autonomous`:** pause after the dry-run and first
  full round so you can eyeball the diffs and the blocked list, then let it run to `drained` or the
  budget.
- **Terminal parameters:** `MAX_ROUNDS ≈ 12`, `MAX_RETRIES = 2`, `BATCH = 10`, budget ceiling with
  a 50k-token reserve for finalize.

---

## Build order

1. Confirm the routing brief (§1) and the mapping spec (§3.2).
2. Enumerate deterministically → `queue.json`, pin `total` (§3.1).
3. Write + smoke-test the codemod pre-pass (§3.3).
4. Fill `MODE='exhauster'` in the template (§5).
5. `node scripts/selfcheck_loops.mjs` (§6).
6. Launch the workbench; hand you the URL.
7. Dry-run one file; you inspect (§7).
8. Run checkpointed → autonomous; report at round boundaries.
9. Global backstop + helper deletion → `drained`, or hand you the blocked list (§8).
