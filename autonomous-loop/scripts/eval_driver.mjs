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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { loadFilledDriver, spoofWorld, fixturesFor } from './lib/spoof_world.mjs'

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
  // patience; the run must not livelock (the recorded impeccable-radix failure: 5 deaths + 1 kill)
  contextDeathWorker: {
    skip: m => m === 'sentinel',                             // sentinel workers are repairs; poll drives it
    overlay: s => ({ ...s, work: (id, n) => (id.endsWith('1') ? null : 'done'),
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
      if (meta.mode === 'saturator') o.find = () => ({ candidates: [{ where: `c${++k}`, claim: 'x' }] })
      if (meta.mode === 'explorer') o.hypothesize = () => ({ experiments: [{ id: `e${++k}`, subq: 'q1', hypothesis: 'h', method: 'm' }] })
      if (meta.mode === 'converger') o.critique = () => ({ total: 2, criteria: [
        { id: `r${++k}`, region: `r${k}`, status: 'fail', fix: 'f' }, { id: `r${++k}`, region: `r${k}`, status: 'fail', fix: 'f' }] })
      if (meta.mode === 'sentinel') o.poll = () => ({ violations: [{ id: `v${++k}`, invariant: 'inv', detail: 'd', severity: 'minor' }] })
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
      ledger: () => ({ hero: 'absent', handoff: 'written' }),
      want: r => r.status === 'unwitnessed', fixHandoffRound: true },
    { audit: () => ({ hero: 'absent', handoff: 'complete', handoffRound: 1, captures: 3, distinctCaptures: 3 }),
      ledger: () => ({ hero: 'absent', handoff: 'written' }),
      want: r => r.status === 'unpointed', fixHandoffRound: true },
    { audit: () => ({ hero: 'none', handoff: 'complete', handoffRound: 1, captures: 4, distinctCaptures: 4 }),
      ledger: () => ({ hero: 'none', handoff: 'written' }),
      want: r => r.status === 'unpointed', fixHandoffRound: true },
    { audit: () => ({ hero: 'artifact', handoff: 'complete', handoffRound: 1, captures: 6, distinctCaptures: 2 }),
      want: r => r.status === 'evidence_regressed', fixHandoffRound: true },
    { audit: () => ({ hero: 'artifact', handoff: 'absent', handoffRound: 0, captures: 2, distinctCaptures: 2 }),
      want: r => r.status === 'undocumented' },
  ] },
}

// ---- shared postcondition: no scenario may spin, and a mutant cannot move the ceiling ---------
function withinBounds(r, meta) {
  return r && typeof r === 'object' && Number.isFinite(r.rounds) &&
    r.rounds <= HARD_ROUND_CEILING &&
    r.rounds < Math.min(meta.backstop, HARD_ROUND_CEILING) + 1
}

// Runs one scenario's world through the driver. Never throws: a driver crash is a FAIL for this
// scenario, with the error printed, never a crash of the tool.
async function runOne(name, driver, meta, scn) {
  const w = spoofWorld(scn)
  let r, error = null
  try {
    r = await driver(w.agent, w.parallel, w.pipeline, w.log, w.phase, w.budget, w.args)
  } catch (e) {
    error = e
  }
  let ok = false
  if (!error) {
    try { ok = withinBounds(r, meta) && !!scn.__expect(r, w, meta) }
    catch (e) { error = e }
  }
  return { ok, error, unknownLabels: w.unknownLabels }
}

// ---- battery: takes driver SOURCE TEXT, returns {verdict, scenarios} --------------------------
export async function runBattery(src) {
  const { driver, meta } = loadFilledDriver(src)
  const base = fixturesFor(meta.mode)
  const scenarios = {}
  const unknownLabels = new Set()
  let anyFail = false

  for (const [name, def] of Object.entries(SCENARIOS)) {
    if (def.rungs) {
      let idx = 0
      for (const rung of def.rungs) {
        idx++
        const rungName = `witnessRungs[${idx}]`
        // Sentinel has no positive stop of its own to be demoted off of; the ladder position makes
        // rungs 2-5 (the demote-from-positive rows) unreachable for it — mirror
        // scripts/selfcheck_loops.mjs, which never exercises those rungs under sentinel either.
        if (meta.mode === 'sentinel' && idx >= 2 && idx <= 5) continue
        const scn = { ...base,
          ...(rung.ledger ? { ledger: rung.ledger } : {}),
          audit: (disk, ledgerCalls) => {
            const row = rung.audit(disk)
            return rung.fixHandoffRound ? { ...row, handoffRound: disk.handoffRound } : row
          },
          __expect: (r) => rung.want(r) }
        const { ok, error, unknownLabels: u } = await runOne(rungName, driver, meta, scn)
        for (const l of u) unknownLabels.add(l)
        scenarios[rungName] = ok
        if (!ok) anyFail = true
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${rungName.padEnd(20)}${error ? ` → threw: ${error.message}` : ''}`)
      }
      continue
    }
    if (def.skip && def.skip(meta.mode)) continue
    const overlaid = def.overlay(base, meta)
    const scn = { ...overlaid, __expect: def.expect }
    const { ok, error, unknownLabels: u } = await runOne(name, driver, meta, scn)
    for (const l of u) unknownLabels.add(l)
    scenarios[name] = ok
    if (!ok) anyFail = true
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(20)}${error ? ` → threw: ${error.message}` : ''}`)
  }

  if (unknownLabels.size > 0) {
    for (const l of unknownLabels) console.log(`  unknown label: ${l}`)
    return { verdict: 'unspoofable', scenarios }
  }
  return { verdict: anyFail ? 'fail' : 'pass', scenarios }
}

// ---- fillTemplate: fill the shipped template with test values ---------------------
function fillTemplate(mode) {
  const TEMPLATE = resolve(HERE, '../assets/loop-template.js')
  let src = readFileSync(TEMPLATE, 'utf8')
  const subs = {
    '<<ARCHETYPE>>': mode,
    '<<MAX_ROUNDS>>': '6',
    '<<PASS_THRESHOLD>>': '0.9',
    '<<DRY_ROUNDS>>': '2',
    '<<MAX_RETRIES>>': '2',
    '<<BATCH>>': '8',
    '<<LENSES>>': "['a','b']",
    '<<INVARIANTS>>': "['inv1','inv2']",
    '<<MANDATES>>': "['correctness','performance']",
    '<<EFFORT>>': 'balanced',
    '<<EVIDENCE_EVERY>>': '1',
  }
  for (const [k, v] of Object.entries(subs)) src = src.split(k).join(v)
  src = src.replace(/<<[^>]+>>/g, 'x')
  src = src.replace('export const meta', 'const meta')
  return src
}

// ---- selfTest: verify the battery passes on all archetypes and fails on mutants ----
async function selfTest() {
  let failures = 0
  const check = (ok, name, detail = '') => {
    if (!ok) failures++
    console.log(`${ok ? 'PASS' : 'FAIL'}  selftest   ${name.padEnd(24)} ${detail}`)
  }

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
      from: "positive && !witnessed                ? 'unwitnessed'", to: "false ? 'unwitnessed'",
      redScenario: 'lyingVerifier' },
    { name: 'alienLabel', mode: 'exhauster',
      from: "{ ...TIER.mechanical, phase: 'Ledger', label: 'audit', schema: AUDIT_SCHEMA }", to: "{ ...TIER.mechanical, phase: 'Ledger', label: 'audit2', schema: AUDIT_SCHEMA }",
      redVerdict: 'unspoofable' },
  ]
  for (const m of MUTANTS) {
    const src = fillTemplate(m.mode)
    if (!src.includes(m.from)) {
      check(false, m.name, `mutation site not found — template changed shape`)
      continue
    }
    const r = await runBattery(src.replace(m.from, m.to))
    const red = m.redVerdict ? r.verdict === m.redVerdict : r.scenarios[m.redScenario] === false
    check(red, m.name, `verdict=${r.verdict}`)
  }
  process.exit(failures ? 1 : 0)
}

// ---- CLI ---------------------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2)
  const jsonFlag = args.includes('--json')
  const pathArg = args.find(a => a !== '--json')

  if (pathArg) {
    let result
    try {
      const src = readFileSync(pathArg, 'utf8')
      result = await runBattery(src)
    } catch (e) {
      console.log(`FAIL  load → ${e.message}`)
      result = { verdict: 'fail', scenarios: {} }
    }
    console.log(`\nverdict: ${result.verdict}`)
    if (jsonFlag) console.log(JSON.stringify(result))
    process.exit(result.verdict === 'pass' ? 0 : 1)
  }

  // Self-test mode (shipped template x5 archetypes) is Task 3's job.
  await selfTest()
}

main()
