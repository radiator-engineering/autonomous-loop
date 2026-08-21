# Ownership Footprints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every work attempt appends a claim line to `footprint.jsonl` before its first edit and a close line as its last act, so a dead attempt's leftovers become computable; the retry worker and the finalize agent read the record.

**Architecture:** One new prompt directive (`footprintDirective`) in the work dispatch, one sentence added to `retryDirective`, one instruction added to the finalize prompt. All three follow the template's existing cache discipline: the driver interpolates nothing that varies per attempt.

**Tech Stack:** Node ≥ 18, plain ESM scripts, no dependencies. Repo: `/Users/jjmartin/Development/autonomous-loop`, branch `ownership-footprint`.

**Spec:** `docs/superpowers/specs/2026-08-21-ownership-footprint-design.md` — the binding authority; conflicts in this plan resolve against it.

## Global Constraints

- Directive text must be CONSTANT for a given item: no round numbers, no attempt counters, no clocks. The `stuck` scenario's byte-identity assertions (attempts 2..STUCK_AFTER identical to each other) must stay green unmodified.
- Both-halves discipline: every new selfcheck assertion is shown red (by running before the implementation lands) before it goes green. Never weaken an existing assertion; never edit an expected value to match output.
- `footprint.jsonl` is a NEW file, distinct from `claims.jsonl` (verified assertions — untouched).
- No status-ladder, witness-gate, `AUDIT_SCHEMA`, or dispatch-gating changes. Surface, don't gate.
- All gates green after each task: `node autonomous-loop/scripts/selfcheck_loops.mjs`, `selfcheck_board.mjs`, `selfcheck_docs.mjs`, `selfcheck_preflight.mjs`, `eval_driver.mjs`, `lint_design.mjs`, `replay_gates.mjs` (all no-arg, from repo root).
- Commit messages in the repo's plain-sentence style; no Co-Authored-By/Claude attribution. Do not push.

---

### Task 1: `footprintDirective` in the work dispatch

**Files:**
- Modify: `autonomous-loop/assets/loop-template.js` (work dispatch ~line 987; new function beside `activityDirective` ~line 1524)
- Test: `autonomous-loop/scripts/selfcheck_loops.mjs` (new scenario beside `retryGetsTreeWarning`, ~line 1075)

**Interfaces:**
- Produces: `footprintDirective(item)` — returns a constant-per-item string; wired as `mode.workerPrompt(item, state) + footprintDirective(item) + retryDirective(item.id) + stuckDirective(item.id) + activityDirective('Work', \`work:${item.id}\`)`.
- Consumes: `LEDGER_DIR` (existing const), `item.id`.

- [ ] **Step 1: Write the failing scenario.** In `selfcheck_loops.mjs`, directly after the `retryGetsTreeWarning` scenario, add (matching its neighbors' style exactly — same `critique`/`verify` helpers used by `retryGetsTreeWarning`, which is the model):

```js
    // EVERY ATTEMPT WRITES DOWN WHAT IT WILL TOUCH BEFORE TOUCHING IT (spec: ownership footprints,
    // issue #8 subtask 1). The claim line survives a crash because appending it is the worker's FIRST
    // act; the close line is its last. The driver interpolates nothing that varies per attempt, so a
    // failing item's later prompts stay byte-identical to each other — the stuck scenario holds.
    workClaimsFootprint:
                   { critique: () => CRIT(['fail', 'pass', 'pass']), verify: id => pass(id),
                     expect: (r, h) => (h.prompts['work:r1'] || []).length > 0 &&
                       (h.prompts['work:r1'] || []).every(p =>
                         p.includes('footprint.jsonl') && p.includes('"event":"claim"') && p.includes('"event":"close"')) },
```

- [ ] **Step 2: Run to verify it fails.** `node autonomous-loop/scripts/selfcheck_loops.mjs` → expect exactly one FAIL: `workClaimsFootprint`. Capture the output.
- [ ] **Step 3: Implement.** In `loop-template.js`, add directly BEFORE `function activityDirective`:

```js
function footprintDirective(item) {
  // Constant for a given item — no round number, no attempt counter, no clock — for the same reason
  // activityDirective is constant per (phase, label): a resumed run replays byte-identical prompts
  // from cache, and a failing item's later attempts stay byte-identical to each other. The worker
  // stamps ts itself, exactly as the activity log works. The claim is the FIRST act so that an
  // attempt that dies mid-work still leaves behind which files it meant to touch; a trailing claim
  // with no close is how the retry learns its predecessor died and where to look.
  return `\n\nFOOTPRINT (bookkeeping, first and last actions; not part of the task, never let it ` +
    `change your answer): BEFORE your first edit, append one line to ${LEDGER_DIR}/footprint.jsonl ` +
    `(create it if missing): {"ts":"<ISO-8601 now>","item":"${item.id}","event":"claim",` +
    `"files":[<the file paths you intend to edit>]}. If your scope grows mid-work, append another ` +
    `claim line. As your LAST action, append {"ts":"<ISO-8601 now>","item":"${item.id}",` +
    `"event":"close","status":"done"|"noop"|"blocked","note":"<one line: where this attempt ended>"}. ` +
    `Append only; never rewrite or truncate the file — other agents are appending to it at the same time.`
}
```

Then wire it into the work dispatch (~line 987), changing the concat to:

```js
    agent(mode.workerPrompt(item, state) + footprintDirective(item) + retryDirective(item.id) + stuckDirective(item.id) + activityDirective('Work', `work:${item.id}`),
```

And extend the `// 2. WORK:` comment block above the dispatch with one line: `//    Every worker also claims its footprint (files it will touch) before editing — see footprintDirective.`

- [ ] **Step 4: Run to verify it passes.** `node autonomous-loop/scripts/selfcheck_loops.mjs` → all green, including `stuck` (byte-identity must survive; if `stuck` fails, the directive text varies per attempt — fix the directive, never the assertion).
- [ ] **Step 5: Run the other gates.** `selfcheck_board.mjs`, `selfcheck_docs.mjs`, `selfcheck_preflight.mjs`, `eval_driver.mjs`, `lint_design.mjs`, `replay_gates.mjs` — all green.
- [ ] **Step 6: Commit.**

```bash
git add autonomous-loop/assets/loop-template.js autonomous-loop/scripts/selfcheck_loops.mjs
git commit -m "Make every worker claim its footprint before the first edit"
```

---

### Task 2: retry reads the footprint; finalize reconciles it

**Files:**
- Modify: `autonomous-loop/assets/loop-template.js` (`retryDirective` ~line 1503; finalize prompt ~line 1308, the `Carry "Traps" forward` line)
- Test: `autonomous-loop/scripts/selfcheck_loops.mjs` (extend `retryGetsTreeWarning`; new scenario for finalize)

**Interfaces:**
- Consumes: Task 1's `footprint.jsonl` line shapes (`"event":"claim"` / `"event":"close"`), `LEDGER_DIR`.
- Produces: no new functions; two prompt texts gain instructions.

- [ ] **Step 1: Write the failing assertions.** (a) Extend `retryGetsTreeWarning`'s `expect` so the retried prompt must also name the footprint — replace its `expect` with:

```js
                     expect: (r, h) => (h.prompts['work:r1'] || []).slice(1).some(p => p.includes('RETRY:') && p.includes('no close line')) &&
                       !((h.prompts['work:r1'] || [])[0] || '').includes('RETRY:') },
```

(b) Directly after `workClaimsFootprint`, add:

```js
    // The finalize agent reconciles claimed footprints against what actually changed, and surfaces
    // unclaimed edits and cross-item collisions under HANDOFF's "Traps" — surface, don't gate.
    finalizeReconcilesFootprint:
                   { critique: () => CRIT(['fail', 'pass', 'pass']), verify: id => pass(id),
                     expect: (r, h) => (h.prompts['finalize'] || []).some(p =>
                       p.includes('footprint.jsonl') && p.includes('git status --porcelain')) },
```

- [ ] **Step 2: Run to verify both fail.** `node autonomous-loop/scripts/selfcheck_loops.mjs` → expect FAILs on exactly `retryGetsTreeWarning` and `finalizeReconcilesFootprint`. Capture the output.
- [ ] **Step 3: Implement both texts.** (a) In `retryDirective`, insert one sentence after `half-finished edits. ` and before `Before you work, run git status`:

```
Read ${LEDGER_DIR}/footprint.jsonl and find this item's lines first: a trailing claim line with no close line after it is the attempt that died mid-work, and its "files" list is where to look; a closed attempt the verifier failed names its files the same way.
```

(as a template-literal continuation matching the surrounding string style — the directive must remain constant per item id.)

(b) In the finalize prompt, insert BEFORE the `Carry "Traps" forward unchanged` sentence:

```
Reconcile ${LEDGER_DIR}/footprint.jsonl (skip this if the file is absent, and say so in one "Traps" line) against the working tree's changed files (`git status --porcelain`): under "Traps", add one line per changed file no claim covers, and one line per file claimed by two different items. Cite file paths only; do not paste diffs.
```

- [ ] **Step 4: Run to verify both pass.** `node autonomous-loop/scripts/selfcheck_loops.mjs` → all green (`stuck` included).
- [ ] **Step 5: Run the other gates.** Same list as Task 1 — all green.
- [ ] **Step 6: Commit.**

```bash
git add autonomous-loop/assets/loop-template.js autonomous-loop/scripts/selfcheck_loops.mjs
git commit -m "Point the retry at the dead attempt's footprint and reconcile it at finalize"
```

---

### Task 3: docs and bundle

**Files:**
- Modify: `autonomous-loop/references/observability.md` (file table ~line 19; the retryDirective paragraph ~line 270)
- Modify: `autonomous-loop/dist/autonomous-loop.skill` (repack)

- [ ] **Step 1: Document the file.** In `observability.md`'s ledger-file table (the one whose rows read `| \`<LEDGER_DIR>/claims.jsonl\` | ledger agent, every round (\`writeLedger\`) | *which* atoms, with what evidence |`), add a row directly after the `claims.jsonl` row:

```
| `<LEDGER_DIR>/footprint.jsonl` | every worker, claim-first then close-last (`footprintDirective`) | which files each attempt *meant* to touch, and how it ended — a trailing claim with no close is an attempt that died mid-work |
```

Then extend the paragraph added by PR #9 (the one beginning `The same discipline covers \`retryDirective\``) with one sentence:

```
The retry also reads `footprint.jsonl` — the dead attempt's claim line names the files to inspect — and the finalize agent reconciles claimed footprints against `git status --porcelain`, surfacing unclaimed edits and cross-item collisions under HANDOFF's "Traps".
```

- [ ] **Step 2: Run the docs gate.** `node autonomous-loop/scripts/selfcheck_docs.mjs` → green.
- [ ] **Step 3: Repack the bundle.** `./install.sh --pack` from the repo root; confirm it re-verifies green. The template genuinely changed, so the bundle diff is real — stage it.
- [ ] **Step 4: Run ALL gates one final time.** Full list from Global Constraints — all green.
- [ ] **Step 5: Commit.**

```bash
git add autonomous-loop/references/observability.md autonomous-loop/dist/autonomous-loop.skill
git commit -m "Teach the docs the footprint file and repack the bundle"
```
