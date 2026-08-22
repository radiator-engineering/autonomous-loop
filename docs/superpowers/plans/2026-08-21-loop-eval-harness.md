# Loop Eval Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deterministic, zero-token testing of *filled* loop drivers: a behavioral battery that runs any generated driver against a scripted world (`eval_driver.mjs`), a design linter that reads a driver + its BRIEF and names predictable deaths (`lint_design.mjs`), and a regression corpus of real recorded runs, with human-written truth verdicts, kept private outside this repo.

**Architecture:** Both new public tools reuse the mocked-Workflow-harness mechanism already proven in `autonomous-loop/scripts/selfcheck_loops.mjs` — the driver source is wrapped in an `AsyncFunction` and run with spoofed `agent/parallel/pipeline/log/phase/budget`, where the spoofed `agent()` routes on the call's `label`. That routing logic is extracted into a shared module (`scripts/lib/spoof_world.mjs`) so `eval_driver` (battery) and `lint_design` (L2 needs measured prompt bytes from one spoofed run) both consume it. The private bench is a separate repo that clones this one in CI and diffs tool verdicts against `EXPECTED.json` truth files.

**Tech Stack:** Node ≥ 20, ESM `.mjs`, zero npm dependencies (the skill ships no `package.json` — everything is `node:` builtins). Bash for `install.sh`. GitHub Actions for bench CI.

**Spec:** `docs/superpowers/specs/2026-08-21-loop-eval-harness-design.md` — read it first; every task below implements a named section of it.

## Global Constraints

- **Zero dependencies.** Only `node:` builtin imports. No `package.json`, no npm.
- **Every gate is a self-testing script**, not a test-framework suite. "Tests" for a gate = its no-arg self-test mode, which must include at least one **red half** (a case built to trip each check, asserted to actually trip it). This is the repo's contract (`CONTRIBUTING.md`).
- **`run_gate` wiring:** every new gate script gets a `run_gate autonomous-loop <script>` line in `install.sh` in the same change (CONTRIBUTING rule 1; the enforcement loop only auto-checks `selfcheck_*.mjs` names, so for `eval_driver.mjs`/`lint_design.mjs` the line must be added manually and deliberately).
- **Repack after touching anything under `autonomous-loop/` except `evals/` and `dist/`:** run `./install.sh --pack` from the repo root (CONTRIBUTING rule 2). If `git status` shows only timestamp churn in the `.skill` when you didn't touch bundle-carried files, restore it with `git checkout -- autonomous-loop/dist/autonomous-loop.skill`.
- **Commits:** no Claude attribution / `Co-Authored-By` lines (user's global rule). Message style in this repo is a plain-English sentence, e.g. `Name the witness gate's reason, price the run with one knob`.
- **Verification command for every task:** `./install.sh --check` from repo root must exit 0 (the out-of-repo corpus is verified on its own).
- **The corpus is private.** Nothing from the recorded runs, the postmortems, or the extracted ledgers may be committed to this repo — paths, hostnames, prompts, artifacts, all of it. Neither the corpus nor its location is named here.
- **Never edit `assets/loop-template.js` in this plan.** Both known kernel defects (jam rule, dirty-tree retry) are explicitly deferred; the spec's bench is *supposed* to be red on the jam rule.

### Facts about the codebase you must not rediscover wrong

- A driver (template or filled) is executed as: `new AsyncFunction('agent','parallel','pipeline','log','phase','budget','args', src)` after replacing `export const meta` with `const meta`. See `scripts/selfcheck_loops.mjs:144-178`.
- The driver returns `{ mode, rounds, status, hitBackstop, converged, confirmed, blocked, finalized, history, ... }` (`assets/loop-template.js:1319`). `converged === true` only when the archetype's positive stop fired.
- The status ladder (template, search `const status =`): `blocked` → `evidence_regressed` → `budget_exhausted` → `unpointed` → `unwitnessed` → `undocumented` → positive `doneStatus` → `inconclusive` → `runaway_backstop`/`capped` → `stopped`.
- Agent labels the template dispatches (exact set — this is the routing contract): exact labels `enumerate, charter, hypothesize, poll, ledger, audit, coherence, finalize`; prefixed labels `critique:*, find:*, work:*, verify:*`.
- Budget: the round loop continues only `withinBudget()` = `!budget.total || budget.remaining() > RESERVE`, with `const RESERVE = 50_000` (`assets/loop-template.js:80,962,1471`).
- Kernel constants readable from any driver source by regex: `RUNAWAY_BACKSTOP` (200), `BLOCKER_PATIENCE`, `STUCK_AFTER`, `const MODE = '<archetype>'`.
- Audit scalar shape (`AUDIT_SCHEMA`): `{ hero: 'artifact'|'none'|'absent', handoff: 'complete'|'incomplete'|'absent', handoffRound: int, captures: int ≥ 0, distinctCaptures: int, 0 ≤ distinctCaptures ≤ captures }`. Malformed audits fail closed.
- The ledger agent returns `{ hero: 'artifact'|'none'|'absent', handoff: 'written'|... }` each round; the spoofed disk in `selfcheck_loops.mjs:229-263` shows exactly how hero persistence / handoff rewrite / capture accumulation must be modeled. Copy that model's semantics.
- Explorer verdicts additionally require `bears_on` and `finding`; converger's critique returns a rubric `{ total, criteria: [{id, region, status, fix}] }`; exhauster queue items need `{id, task}` (both strings, task non-empty); saturator candidates are `[{where, claim}]`; sentinel poll returns violations `[{id, invariant, detail, severity}]`. All fixture shapes are at `scripts/selfcheck_loops.mjs:288-301` — reuse them verbatim.

---

### Task 1: `scripts/lib/spoof_world.mjs` — load a filled driver, run it against a scripted world

**Files:**
- Create: `autonomous-loop/scripts/lib/spoof_world.mjs`
- (No `run_gate` line: this is a library, not a gate. It is exercised by Tasks 2–4's self-tests.)

**Interfaces:**
- Produces: `loadFilledDriver(src) → { driver, meta: {mode, backstop, patience, stuckAfter, effort} }` — throws with a named reason on unfilled `<<MARKERS>>`.
- Produces: `spoofWorld(scn) → { agent, parallel, pipeline, log, phase, budget, args, counts, prompts, promptBytes, models, disk, unknownLabels }` — same contract as `harness()` in `selfcheck_loops.mjs`, plus `promptBytes` (per-label byte totals) and `unknownLabels` (Set of non-empty labels that matched no known role).
- Produces: `fixturesFor(mode) → scn` — default responders per archetype (happy world).
- Consumed by: Task 2 (`eval_driver.mjs`), Task 4 (`lint_design.mjs` L2).

- [ ] **Step 1: Write the module**

The spoofing logic is adapted from `harness()` at `scripts/selfcheck_loops.mjs:206-285` and the fixtures at `:288-301`. Read both before writing. The module:

```js
#!/usr/bin/env node
// spoof_world.mjs — run a FILLED loop driver against a scripted world. Library, not a gate.
//
// The mechanism is selfcheck_loops.mjs's harness(), generalized from "the template we ship" to
// "any filled driver a generation session produced". Same rules: label-keyed routing, a simulated
// disk so the terminal audit is a second reader rather than an echo, verbatim scenario audits.
// One addition each way: promptBytes (lint_design L2 prices ceremony from measured bytes) and
// unknownLabels (eval_driver fails closed on a driver it cannot simulate).
import { readFileSync } from 'node:fs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const EXACT = new Set(['enumerate', 'charter', 'hypothesize', 'poll', 'ledger', 'audit', 'coherence', 'finalize'])
const PREFIX = ['critique:', 'find:', 'work:', 'verify:']

export function loadFilledDriver(src) {
  const leftover = [...new Set([...src.matchAll(/<<([A-Z_]+)>>/g)].map(m => m[1]))]
  if (leftover.length) throw new Error(`driver is not filled: ${leftover.join(', ')} — run the FILLED preflight gate`)
  const mode = src.match(/^const MODE = '(\w+)'/m)?.[1]
  if (!mode) throw new Error(`no "const MODE = '<archetype>'" line — not a template-descended driver`)
  const num = (name, fallback) => { const m = src.match(new RegExp(`const ${name} = (\\d+)`)); return m ? Number(m[1]) : fallback }
  const meta = { mode, backstop: num('RUNAWAY_BACKSTOP', 200), patience: num('BLOCKER_PATIENCE', 3), stuckAfter: num('STUCK_AFTER', 2) }
  const body = src.replace('export const meta', 'const meta')
  return { driver: new AsyncFunction('agent', 'parallel', 'pipeline', 'log', 'phase', 'budget', 'args', body), meta }
}

export function loadFilledDriverFile(path) { return loadFilledDriver(readFileSync(path, 'utf8')) }

// ---- default happy-world responders per archetype (shapes from selfcheck_loops.mjs fixtures) ----
const pass = (id, extra = {}) => ({ id, pass: true, evidence: 'ok', severity: 'none', novel: true, ...extra })
export function fixturesFor(mode) {
  const scn = { verify: id => (mode === 'explorer' ? pass(id, { bears_on: 'q1', finding: 'supports' }) : pass(id)) }
  if (mode === 'exhauster') scn.enumerate = () => ({ items: [{ id: 'i1', task: 't' }, { id: 'i2', task: 't' }, { id: 'i3', task: 't' }] })
  if (mode === 'saturator') scn.find = (lens) => (lens === 'a' || !scn._seen ? (scn._seen = true, [{ where: 'c1', claim: 'x' }]) : [])
  if (mode === 'converger') scn.critique = (n) => ({ total: 2, criteria: [
    { id: 'r1', region: 'r1', status: n === 1 ? 'fail' : 'pass', fix: 'f' },
    { id: 'r2', region: 'r2', status: 'pass', fix: 'f' }] })
  if (mode === 'explorer') {
    scn.charter = () => ({ subquestions: [{ id: 'q1', question: 's1' }, { id: 'q2', question: 's2' }] })
    scn.hypothesize = (n) => (n === 1
      ? [{ id: 'e1', subq: 'q1', hypothesis: 'h', method: 'm' }]
      : [{ id: 'ans', subq: 'q1', hypothesis: 'the answer', method: 'm', terminal: true }])
  }
  if (mode === 'sentinel') scn.poll = (n) => (n === 1 ? [{ id: 'v1', invariant: 'inv', detail: 'd', severity: 'major' }] : [])
  return scn
}

// ---- the scripted world; scn overrides individual responders exactly as in selfcheck_loops -----
export function spoofWorld(scn) {
  const counts = {}, models = {}, prompts = {}, promptBytes = {}
  const unknownLabels = new Set()
  const disk = { hero: null, handoffRound: null, captures: 0, distinctCaptures: 0 }
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || ''
    counts[label] = (counts[label] || 0) + 1
    ;(prompts[label] = prompts[label] || []).push(String(prompt))
    promptBytes[label] = (promptBytes[label] || 0) + Buffer.byteLength(String(prompt))
    if (opts.model) models[label] = opts.model
    const n = counts[label]
    if (label && !EXACT.has(label) && !PREFIX.some(p => label.startsWith(p))) { unknownLabels.add(label); return null }
    if (scn.allDead) return null
    if (label === 'enumerate')         return scn.enumerate ? scn.enumerate() : { items: [] }
    if (label === 'charter')           return scn.charter ? scn.charter() : { subquestions: [] }
    if (label.startsWith('critique:')) return scn.critique ? scn.critique(n, label.slice(9)) : null
    if (label.startsWith('find:'))     return scn.find ? scn.find(label.slice(5), n) : []
    if (label === 'hypothesize')       return scn.hypothesize ? scn.hypothesize(n) : []
    if (label === 'poll')              return scn.poll ? scn.poll(n) : []
    if (label.startsWith('work:'))     return scn.work ? scn.work(label.slice(5), n) : 'done'
    if (label.startsWith('verify:'))   return scn.verify ? scn.verify(label.slice(7)) : null
    if (label === 'ledger') {
      const r = scn.ledger ? scn.ledger(n) : { hero: 'artifact', handoff: 'written' }
      if (r && (r.hero === 'artifact' || r.hero === 'none')) disk.hero = r.hero
      if (r && r.hero === 'artifact') { disk.captures++; disk.distinctCaptures++ }
      if (r && r.handoff === 'written') disk.handoffRound = n
      return r
    }
    if (label === 'audit') {
      return scn.audit ? scn.audit(disk, counts['ledger'] || 0)
        : { hero: disk.hero || 'absent',
            handoff: disk.handoffRound === null ? 'absent' : 'complete',
            handoffRound: disk.handoffRound === null ? 0 : disk.handoffRound,
            captures: disk.captures, distinctCaptures: disk.distinctCaptures }
    }
    if (label === 'coherence') return scn.coherence ? scn.coherence() : 'reconciled nothing'
    if (label === 'finalize')  return scn.finalize ? scn.finalize() : { finalized: true }
    return 'ok'   // unlabeled call: the template never relies on an unlabeled call's structure
  }
  const parallel = async (thunks) => Promise.all(thunks.map(t => Promise.resolve().then(t).catch(() => null)))
  const pipeline = async () => { throw new Error('pipeline not used by template-descended drivers') }
  const budget = scn.budget || { total: null, spent: () => 0, remaining: () => Infinity }
  return { agent, parallel, pipeline, log: () => {}, phase: () => {}, budget, args: undefined,
           counts, models, prompts, promptBytes, disk, unknownLabels }
}
```

Note the one deliberate divergence from `harness()`: an **unknown non-empty label returns `null` and is recorded** (fail-closed data for `eval_driver`'s `unspoofable` verdict), where `harness()` returned `'ok'`. Empty labels still get `'ok'`.

- [ ] **Step 2: Smoke-verify against the shipped template (this is the interim test; the red halves land in Task 2)**

Run from `autonomous-loop/`:

```bash
node -e "
import('./scripts/lib/spoof_world.mjs').then(async (m) => {
  const src = require('fs').readFileSync('assets/loop-template.js', 'utf8')
    .split('<<ARCHETYPE>>').join('exhauster').split('<<MAX_ROUNDS>>').join('6')
    .split('<<PASS_THRESHOLD>>').join('0.9').split('<<DRY_ROUNDS>>').join('2')
    .split('<<MAX_RETRIES>>').join('2').split('<<BATCH>>').join('8')
    .split(\"<<LENSES>>\").join(\"['a','b']\").split(\"<<INVARIANTS>>\").join(\"['inv1','inv2']\")
    .split('<<MANDATES>>').join(\"['correctness','performance']\")
    .split('<<EFFORT>>').join('balanced').split('<<EVIDENCE_EVERY>>').join('1')
    .replace(/<<[^>]+>>/g, 'x')
  const { driver, meta } = m.loadFilledDriver(src)
  if (meta.mode !== 'exhauster') throw new Error('mode detection broken')
  const w = m.spoofWorld(m.fixturesFor(meta.mode))
  const r = await driver(w.agent, w.parallel, w.pipeline, w.log, w.phase, w.budget, w.args)
  if (r.converged !== true || r.confirmed < 1) throw new Error('happy world did not converge: ' + JSON.stringify({status: r.status, confirmed: r.confirmed}))
  if (w.unknownLabels.size) throw new Error('template produced unknown labels: ' + [...w.unknownLabels])
  console.log('spoof_world OK:', r.status, r.confirmed, 'confirmed')
})"
```

Expected: `spoof_world OK: drained 3 confirmed`. If `unknownLabels` is non-empty, the EXACT/PREFIX routing table has drifted from the template — fix the table, don't silence the check.

- [ ] **Step 3: Commit**

```bash
git add autonomous-loop/scripts/lib/spoof_world.mjs
git commit -m "Extract the spoofed Workflow world into a library any gate can point at a filled driver"
```

(No repack yet — Task 3 repacks once after all public scripts land, so the bundle changes once.)

---

### Task 2: `scripts/eval_driver.mjs` — the behavioral battery (arg mode)

**Files:**
- Create: `autonomous-loop/scripts/eval_driver.mjs`
- Test: its own no-arg mode is written in Task 3; this task verifies arg mode against filled template drivers written to a temp dir.

**Interfaces:**
- Consumes: `loadFilledDriverFile`, `loadFilledDriver`, `spoofWorld`, `fixturesFor` from `./lib/spoof_world.mjs` (Task 1 signatures).
- Produces: CLI `node scripts/eval_driver.mjs <driver.js>` → prints one `PASS`/`FAIL` line per scenario plus a final verdict line; exit 0 iff every scenario passed. Special verdict `unspoofable` (exit 1) when any scenario surfaced unknown labels.
- Produces (for Task 5): with `--json`, last stdout line is `{"verdict": "pass"|"fail"|"unspoofable", "scenarios": {name: bool}}`.

- [ ] **Step 1: Write the battery**

Each scenario is `{ overlay, expect }`: `overlay(scn, meta)` mutates the happy fixtures; `expect(r, w, meta)` is the assertion. The battery is archetype-generic — `fixturesFor(meta.mode)` supplies the frontier, overlays only touch the roles the scenario scripts. Bound every run: a scenario that spins is itself a failure, so wrap execution with a hard absolute round guard — assert `r.rounds < Math.min(meta.backstop, 500) + 1` in a shared postcondition, **using 500 as an absolute ceiling so a mutant that inflates `RUNAWAY_BACKSTOP` cannot move the goalposts**.

```js
#!/usr/bin/env node
// eval_driver.mjs — run a FILLED loop driver against scripted adversity, before it burns a budget.
//
//   node scripts/eval_driver.mjs <path/to/driver.js> [--json]   # the battery; exit != 0 on any failure
//   node scripts/eval_driver.mjs                                # self-test: shipped template x5 archetypes
//                                                               # must pass, and each mutant must go RED
//
// What this tests and what it cannot: BEHAVIOR under adversity (dead agents, lying verifiers, a
// budget cliff, an unbounded frontier), never the QUALITY of the work — that is the runtime
// verifier's job. A driver the world cannot simulate (labels outside the template's routing
// contract) is UNSPOOFABLE, which is a hard failure: a driver nothing can test must not launch on
// the strength of nothing.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadFilledDriver, loadFilledDriverFile, spoofWorld, fixturesFor } from './lib/spoof_world.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const HARD_ROUND_CEILING = 500   // absolute; NOT derived from the driver, so a mutant cannot move it

const SCENARIOS = {
  // a clean world must reach the archetype's own positive stop and finalize the board
  happyPath: {
    overlay: s => s,
    expect: (r, w, meta) => meta.mode === 'sentinel'
      ? r.status !== 'blocked' && r.finalized === true       // the sentinel has no positive stop
      : r.converged === true && r.confirmed > 0 && r.finalized === true,
  },
  // ONE worker dies every time it is dispatched → its item must go blocked/unverified within
  // patience; the run must not livelock (one recorded failure: 5 deaths + 1 kill)
  contextDeathWorker: {
    skip: m => m === 'sentinel',                             // sentinel workers are repairs; poll drives it
    overlay: s => ({ ...s, work: (id, n) => (id.endsWith('1') ? null : 'done') ,
                     verify: id => (id.endsWith('1') ? null : s.verify(id)) }),
    expect: (r, w, meta) => r.converged === false && r.status === 'blocked' &&
                            r.rounds <= meta.patience + 1,
  },
  // EVERY agent dies → the run must still reach a terminal status on its own, quickly, and must
  // fail closed (never a positive status out of a world that answered nothing)
  contextDeathEveryone: {
    overlay: s => ({ ...s, allDead: true }),
    expect: (r) => r.converged === false && r.rounds <= HARD_ROUND_CEILING,
  },
  // a verifier that passes everything CAN move the count (that is its office and the honest limit
  // of this tool) — but the witness gate still demotes a run that showed a human nothing
  lyingVerifier: {
    skip: m => m === 'sentinel',
    overlay: s => ({ ...s, ledger: () => ({ hero: 'absent', handoff: 'written' }) }),
    expect: (r) => r.converged === false && r.status === 'unwitnessed',
  },
  // the budget floor arrives mid-run → clean 'budget_exhausted' terminal, never a spin
  budgetCliff: {
    overlay: (s) => {
      let calls = 0
      return { ...s, budget: { total: 1_000_000, spent: () => calls * 200_000,
               remaining() { calls++; return Math.max(0, 1_000_000 - calls * 200_000) } } }
    },
    expect: (r) => r.status === 'budget_exhausted' || r.converged === true, // tiny archetypes may finish first
  },
  // a frontier that yields NEW work forever must be stopped by the cap or the backstop — bounded
  runawayUnbounded: {
    overlay: (s, meta) => {
      let k = 0
      const o = { ...s }
      if (meta.mode === 'exhauster') o.enumerate = () => ({ items: Array.from({ length: 3 }, () => ({ id: `i${++k}`, task: 't' })) })
      if (meta.mode === 'saturator') o.find = () => [{ where: `c${++k}`, claim: 'x' }]
      if (meta.mode === 'explorer') o.hypothesize = () => [{ id: `e${++k}`, subq: 'q1', hypothesis: 'h', method: 'm' }]
      if (meta.mode === 'converger') o.critique = () => ({ total: 2, criteria: [
        { id: `r${++k}`, region: `r${k}`, status: 'fail', fix: 'f' }, { id: `r${++k}`, region: `r${k}`, status: 'fail', fix: 'f' }] })
      if (meta.mode === 'sentinel') o.poll = () => [{ id: `v${++k}`, invariant: 'inv', detail: 'd', severity: 'minor' }]
      return o
    },
    expect: (r, w, meta) => r.rounds <= Math.min(meta.backstop, HARD_ROUND_CEILING),
  },
  // the terminal audit dies → status fails closed to a demotion, never to the positive status
  deadAuditor: {
    overlay: s => ({ ...s, audit: () => null }),
    expect: (r) => r.converged === false,
  },
  // the witness verdict rungs: force each audit shape, assert the documented status. Six rows.
  witnessRungs: { rungs: [
    { audit: d => ({ hero: 'artifact', handoff: 'complete', handoffRound: d.handoffRound ?? 1, captures: 2, distinctCaptures: 2 }),
      want: r => r.converged === true || r.status !== 'unwitnessed' },
    { audit: () => ({ hero: 'absent', handoff: 'complete', handoffRound: 1, captures: 0, distinctCaptures: 0 }),
      want: r => r.status === 'unwitnessed', fixHandoffRound: true },
    { audit: () => ({ hero: 'absent', handoff: 'complete', handoffRound: 1, captures: 3, distinctCaptures: 3 }),
      want: r => r.status === 'unpointed', fixHandoffRound: true },
    { audit: () => ({ hero: 'none', handoff: 'complete', handoffRound: 1, captures: 4, distinctCaptures: 4 }),
      want: r => r.status === 'unpointed', fixHandoffRound: true },
    { audit: () => ({ hero: 'artifact', handoff: 'complete', handoffRound: 1, captures: 3, distinctCaptures: 1 }),
      want: r => r.status === 'evidence_regressed', fixHandoffRound: true },
    { audit: () => ({ hero: 'artifact', handoff: 'absent', handoffRound: 0, captures: 2, distinctCaptures: 2 }),
      want: r => r.status === 'undocumented' },
  ] },
}
```

Implementation notes the code above doesn't show (write them as real code, no TODOs):

1. **`witnessRungs`** runs the happy world once per rung with `scn.audit` overridden; where `fixHandoffRound: true`, the audit closure must report `handoffRound` equal to the actual last round (capture it from the disk sim: `scn.audit = (disk) => ({...row, handoffRound: disk.handoffRound})`) so only the rung's own field is off-nominal. Skip rungs 2–5 for `sentinel` if the sentinel's ladder position makes `positive` unreachable — mirror how `scripts/selfcheck_loops.mjs` handles the shared-rung cases (search `The rung cases also run under a second archetype`) and copy its sentinel expectations exactly.
2. **`unspoofable`:** after every scenario, union `w.unknownLabels`; if non-empty, print each unknown label, force overall verdict `unspoofable`, exit 1.
3. **Postcondition on every scenario:** `r` is an object and `r.rounds <= HARD_ROUND_CEILING` — a driver that throws mid-battery is a FAIL for that scenario with the error message printed, not a crash of the tool.
4. **`--json`:** last line `JSON.stringify({verdict, scenarios})`.
5. `main()`: `process.argv[2]` present and not `--json`-only → arg mode; otherwise self-test mode (Task 3, stub it as `console.log('self-test not yet wired'); process.exit(1)` for now so a bare invocation cannot silently pass).

- [ ] **Step 2: Verify arg mode red-then-green by hand**

Green: fill the shipped template for `exhauster` exactly as in Task 1 Step 2, write it to `$(mktemp -d)/driver.js`, run `node scripts/eval_driver.mjs <that path>`. Expected: every scenario line `PASS`, exit 0.

Red (proves the battery can fail): copy that filled driver, break it fail-open with `sed -i '' "s/hasOpenBlocker(state) || state.gap || stalled(state) ? 'blocked'/false ? 'blocked'/" driver-broken.js`, run the battery on it. Expected: `contextDeathWorker` line `FAIL`, exit 1. If it stays green, the scenario is not testing what it claims — stop and fix before committing.

Unspoofable: `sed -i '' "s/label: 'audit'/label: 'audit2'/" driver-alien.js` → expected verdict `unspoofable`, exit 1.

- [ ] **Step 3: Commit**

```bash
git add autonomous-loop/scripts/eval_driver.mjs
git commit -m "Run a filled driver against scripted adversity before it spends a real budget"
```

---

### Task 3: `eval_driver.mjs` self-test with mutants + gate wiring + repack

**Files:**
- Modify: `autonomous-loop/scripts/eval_driver.mjs` (replace the self-test stub)
- Modify: `install.sh` (add `run_gate autonomous-loop eval_driver.mjs` beside the existing `run_gate` block at `install.sh:111-118`)
- Modify (generated): `autonomous-loop/dist/autonomous-loop.skill` via `./install.sh --pack`

**Interfaces:**
- Consumes: Task 2's battery internals (`runBattery(src) → {verdict, scenarios}` — refactor so arg mode and self-test share one entry point taking driver source text).
- Produces: no-arg `node scripts/eval_driver.mjs` exit 0 iff (a) all five archetype fills of the shipped template pass the battery AND (b) every mutant goes red.

- [ ] **Step 1: Write the self-test**

Move the Task 1 Step 2 fill map into a `fillTemplate(mode)` helper inside `eval_driver.mjs` (source: `assets/loop-template.js` resolved relative to the script, exactly like `scripts/selfcheck_loops.mjs:130-131`). Self-test:

```js
async function selfTest() {
  let failures = 0
  const check = (ok, name, detail = '') => { if (!ok) failures++
    console.log(`${ok ? 'PASS' : 'FAIL'}  selftest   ${name.padEnd(24)} ${detail}`) }

  for (const mode of ['converger', 'exhauster', 'saturator', 'explorer', 'sentinel']) {
    const r = await runBattery(fillTemplate(mode))
    check(r.verdict === 'pass', `template:${mode}`, `verdict=${r.verdict}`)
  }

  // Every mutant is a driver DELIBERATELY broken one way; the battery must go red on each, and the
  // mutation must be proven to have LANDED (a silent no-op replace certifies nothing).
  const MUTANTS = [
    { name: 'disarmedBlockerGate', mode: 'exhauster',
      from: "hasOpenBlocker(state) || state.gap || stalled(state) ? 'blocked'", to: "false ? 'blocked'",
      redScenario: 'contextDeathWorker' },
    { name: 'disarmedWitnessGate', mode: 'exhauster',
      from: "positive && !witnessed               ? 'unwitnessed'", to: "false ? 'unwitnessed'",
      redScenario: 'lyingVerifier' },
    { name: 'alienLabel', mode: 'exhauster',
      from: "label: 'audit'", to: "label: 'audit2'", redVerdict: 'unspoofable' },
  ]
  for (const m of MUTANTS) {
    const src = fillTemplate(m.mode)
    if (!src.includes(m.from)) { check(false, m.name, `mutation site not found — template changed shape`); continue }
    const r = await runBattery(src.replace(m.from, m.to))
    const red = m.redVerdict ? r.verdict === m.redVerdict : r.scenarios[m.redScenario] === false
    check(red, m.name, `verdict=${r.verdict}`)
  }
  process.exit(failures ? 1 : 0)
}
```

**Copy the `from` strings from the actual template text, whitespace-exact** (the `disarmedWitnessGate` line's spacing above is illustrative — open `assets/loop-template.js`, search `'unwitnessed'` in the status ladder, and paste the byte-exact line). The `src.includes` guard is the check that keeps this honest when the template moves.

- [ ] **Step 2: Run the self-test**

```bash
cd autonomous-loop && node scripts/eval_driver.mjs
```

Expected: 5 template lines + 3 mutant lines all `PASS`, exit 0.

- [ ] **Step 3: Wire the gate and repack**

In `install.sh`, after the `run_gate autonomous-loop selfcheck_board.mjs` line, add:

```sh
# Not selfcheck_* by name, so the completeness scan below does not cover them: these two lines are
# load-bearing, remove one and its gate silently stops running.
run_gate autonomous-loop eval_driver.mjs
```

Then from repo root: `./install.sh --check` (all gates green) and `./install.sh --pack` (bundle carries the new scripts; the bundle gate must stay green).

- [ ] **Step 4: Commit**

```bash
git add autonomous-loop/scripts/eval_driver.mjs install.sh autonomous-loop/dist/autonomous-loop.skill
git commit -m "Prove the battery can go red, and make the publisher run it"
```

---

### Task 4: `scripts/lint_design.mjs` — five lints over a driver + BRIEF

**Files:**
- Create: `autonomous-loop/scripts/lint_design.mjs`
- Modify: `install.sh` (add `run_gate autonomous-loop lint_design.mjs` under the Task 3 line)
- Modify (generated): `autonomous-loop/dist/autonomous-loop.skill` via `./install.sh --pack`

**Interfaces:**
- Consumes: `loadFilledDriver`, `spoofWorld`, `fixturesFor` from `./lib/spoof_world.mjs` (L2 measures prompt bytes by running one spoofed happy round-trip).
- Produces: CLI `node scripts/lint_design.mjs <driver.js> <BRIEF.md> [--json]` → one line per lint (`PASS`/`WARN`/`FAIL` + reason); exit non-zero iff any **hard** lint failed. `--json` last line: `{"hard_failures": n, "warnings": n, "lints": {L1: "pass"|"warn"|"fail", ...}}`.
- Produces: no-arg mode = self-test over inline fixtures; exit non-zero on any self-test miss.

- [ ] **Step 1: Write the linter**

Each lint is a pure function `(driverSrc, brief, measured) → {level: 'pass'|'warn'|'fail', reason}` where `measured` is `{promptBytes, confirmed, models}` from one spoofed happy run (null if the driver is unspoofable — then every lint that needs `measured` reports `warn` with reason `unspoofable driver, L2 skipped`, and L2 alone cannot hard-fail anyway). Severity per the spec: **L3 is the only hard fail by default; L1 hard-fails only on its compound shape** (test-iterate × large file).

```js
// The heuristic tables. Named constants, not inline regexes, so the self-test fixtures and the
// lints agree on one definition and a future failure mode becomes one new row.
const L1_LINE_BUDGET = 250          // emitted lines one item may plausibly demand before a worker dies
const L1_WHOLE_FILE = /\b(rewrite|regenerate|output|emit|produce) (the )?(entire|whole|full|complete)\b/i
const L1_ITERATE = /\b(run (the )?tests?|iterate|repeat|until (it|they) pass)\b/i
const L3_VISUAL = /\b(screenshot|capture|image|png|render|visual|pixel|browser)\b/i
const L4_TASTE = /\b(polished|beautiful|elegant|feels right|looks good|clean|delightful|high[- ]quality)\b/i
const L4_GROUNDED = /(`[^`]+`|\bnpm |\bnode |\bpytest|\bexit 0|\bdiff\b|\.mjs\b|\.py\b|\bpx\b|[<>]=? ?\d)/
const L5_ROLE = /\b(queue|backlog|count|source of truth|status file)\b/i
const PRICE_PER_MTOK_IN = { opus: 15, sonnet: 3, haiku: 0.8 }   // USD, input, 2026-08 — an ESTIMATE knob, update freely
```

The five lints (write each fully; summaries here state the algorithm, not a license to stub):

- **L1 output budget.** Collect item text: inline queue/mandate/lens array literals in the driver + the BRIEF's `## Atom` and `## Destination` sections. For each item string, find file paths that exist on disk relative to the BRIEF's directory; `lines = wc -l` of the largest. `warn` when the item pairs a whole-file directive (`L1_WHOLE_FILE`) with any file > `L1_LINE_BUDGET` lines; **`fail`** when it also matches `L1_ITERATE` (the test-iterate-on-a-large-file shape — the recorded ~480-line item that killed five workers). No file on disk → the whole-file directive alone is a `warn` with reason `output volume unverifiable`.
- **L2 ceremony economics.** From `measured.promptBytes`: ceremony bytes = every label except `work:*` and `verify:*`. `tokens ≈ bytes / 4`; price with `PRICE_PER_MTOK_IN` keyed by the models the driver dispatched (`measured.models`, default `sonnet`). `$ per confirmed atom = cost / max(1, measured.confirmed)`; scale by `MAX_ROUNDS` when bounded. Always print the figure; `warn` above $2/atom, or when the BRIEF's `## Autonomy` section names a dollar budget the projection exceeds. Never `fail` — the figures are estimates and say so in the printed reason.
- **L3 evidence contract (hard).** `fail` when the driver source sets a verifier/audit tier with `images: 0` (regex `images:\s*0`) while the BRIEF's `## Evidence` section matches `L3_VISUAL` — a structurally blind verifier facing a visual evidence contract. Also `fail` when `## Evidence` matches `L3_VISUAL` but the driver's `EVIDENCE_EVERY` is `0` (the design demands pictures the loop will never take). `pass` when either side is non-visual.
- **L4 decidability.** For each atom-defining string (same collection as L1), `warn` when it matches `L4_TASTE` and nothing within the same string matches `L4_GROUNDED` — a taste bar with no mechanical check attached.
- **L5 dual source of truth.** Collect file paths mentioned within 80 characters of an `L5_ROLE` word across driver + BRIEF; normalize; `warn` when two *distinct* paths both claim a counting role.

- [ ] **Step 2: Write the self-test (fixtures inline, one green + one red per lint)**

The no-arg mode builds fixture pairs as string literals inside the script — a clean BRIEF/driver that must produce zero warnings and zero failures, then per-lint red fixtures:

```js
const GREEN_BRIEF = `## Destination\nMigrate the parsers.\n## Archetype\nexhauster\n## Atom + verify contract\nEach file compiles: \`node --check\` exits 0.\n## Stop\nqueue empty\n## Evidence\nheadless data migration — no visual evidence is possible; claims.jsonl is the record\n## Autonomy + budget\nautonomous, 2M tokens`
const RED_FIXTURES = [
  { lint: 'L1', level: 'fail', brief: b => b.replace('Each file compiles', 'Rewrite the entire file and run the tests until they pass. Each file compiles'),
    setup: dir => writeFileSync(join(dir, 'big.js'), 'x\n'.repeat(1000)),
    briefExtra: '\nTarget: big.js' },
  { lint: 'L3', level: 'fail', brief: b => b.replace(/## Evidence\n[^\n]+/, '## Evidence\nA screenshot of the rendered page every round'),
    driver: d => d.replace(/images:\s*\d+/, 'images: 0') },   // if the template has no images: knob, inject `const TIER_X = { images: 0 }` into the fixture driver instead
  { lint: 'L4', level: 'warn', brief: b => b.replace('Each file compiles: `node --check` exits 0.', 'The page looks polished and feels right.') },
  { lint: 'L5', level: 'warn', briefExtra: '\nThe queue lives in queue.json. The backlog count is tracked in state/progress.md.' },
  { lint: 'L2', level: 'warn' },   // priced with a 1-atom spoofed run and a $0.01 warn threshold override for the fixture
]
```

For each red fixture assert **exactly** the named lint reports the named level and every *other* lint stayed at `pass` — the same both-halves discipline `selfcheck_preflight.mjs` documents (a fixture that trips two lints at once is a broken fixture, not a passing test). The fixture driver = the Task 3 `fillTemplate('exhauster')` fill. `L2`'s red half runs with an injected threshold (export the threshold as a parameter of the lint function; the CLI uses the default) rather than fabricating giant prompts.

- [ ] **Step 3: Run it**

```bash
cd autonomous-loop && node scripts/lint_design.mjs                    # self-test: expect all PASS, exit 0
node scripts/lint_design.mjs /tmp/does-not-exist.js /tmp/nope.md      # expect a named error, exit != 0
```

- [ ] **Step 4: Wire, repack, full check, commit**

Add `run_gate autonomous-loop lint_design.mjs` under Task 3's line in `install.sh`, then from repo root `./install.sh --check && ./install.sh --pack`.

```bash
git add autonomous-loop/scripts/lint_design.mjs install.sh autonomous-loop/dist/autonomous-loop.skill
git commit -m "Read a loop design and name the predictable death before launch"
```

---

### Task 5: Public-repo docs + PR

**Files:**
- Modify: `CONTRIBUTING.md` (extend the `run_gate` rule's wording so it covers non-`selfcheck_*` gates: the automated scan only covers `selfcheck_*`, so `eval_driver.mjs`/`lint_design.mjs` lines are guarded by review, and say so)
- Modify: `autonomous-loop/SKILL.md` — **only if** a natural anchor exists (a "verify before launch" or preflight section); add at most 3 lines pointing at the two tools. If no anchor exists, skip the SKILL.md edit entirely rather than inventing a section — `selfcheck_docs.mjs` grades doc claims, and a wrong claim fails the gate.

- [ ] **Step 1: Make the doc edits, run `./install.sh --check`** (this is what catches a doc claim the gates contradict — if `selfcheck_docs.mjs` goes red, fix the wording, not the gate). If `SKILL.md` was touched: `./install.sh --pack`.

- [ ] **Step 2: Commit, push, open the PR**

```bash
git add -A && git commit -m "Say where the new gates sit and which rule guards their wiring"
git push -u origin loop-eval-harness
gh pr create --title "Test generated drivers against a scripted world before they spend real budget" \
  --body "Implements docs/superpowers/specs/2026-08-21-loop-eval-harness-design.md: eval_driver.mjs (behavioral battery over any filled driver, unspoofable fails closed, mutant-proven red halves), lint_design.mjs (L1 output budget, L2 ceremony economics, L3 evidence contract [hard], L4 decidability, L5 dual source of truth), both wired as gates and bundled. The out-of-repo regression corpus lands separately.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 6: out-of-repo regression corpus (tracked outside this repo)

The third piece of the spec — the regression corpus of real recorded runs, with
human-written truth verdicts — is deliberately **not** built in this repo and is not
planned here. The recorded runs carry internal paths, hostnames, and project material,
so neither the corpus nor its location belongs in a public plan.

What this repo owes it is an interface, and that interface is fixed by Tasks 2 and 4:
`scripts/replay_gates.mjs <ledger-dir>` (per-run verdict lines on stdout),
`scripts/eval_driver.mjs <driver> --json`, and `scripts/lint_design.mjs <driver> <brief> --json`.
Any out-of-repo replayer consumes those three and diffs their verdicts against truth
written by hand. Keep those contracts stable; that is the whole public obligation.

## Self-Review (performed while writing)

- **Spec coverage:** eval_driver battery + scenario table → Tasks 2–3 (all 8 spec scenarios present: happyPath, contextDeathWorker, contextDeathEveryone, lyingVerifier, budgetCliff, runawayUnbounded, deadAuditor, witnessRungs). Label-keyed spoofing + `unspoofable` fail-closed → Tasks 1–2. Self-test + mutants + red halves → Task 3. `run_gate` + repack → Tasks 3–4. lint L1–L5 with the spec's severities → Task 4. Private bench: layout, `EXPECTED.json` truth schema, `run.mjs`, CI, seeded born-red → Task 6. Deferred items (jam retune, dirty-tree reset): correctly absent, guarded by the "never edit the template" global constraint.
- **Type consistency:** `spoofWorld` return fields consumed by Tasks 2/4 (`unknownLabels`, `promptBytes`, `disk`, `counts`, `models`) all defined in Task 1. `--json` contracts produced in Tasks 2/4 match what Task 6's `run.mjs` parses (`verdict`, `hard_failures`, `warnings`).
- **Known soft spots, flagged not hidden:** two strings must be copied byte-exact from live files rather than from this plan (the mutant `from` lines in Task 3; the `replay_gates` verdict-line format in Task 6 Step 3) — both are marked at the point of use with an existence guard so a drifted string fails loudly.
