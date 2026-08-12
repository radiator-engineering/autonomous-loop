#!/usr/bin/env node
// Deterministic self-check for the LAUNCH GATE (scripts/preflight_launch.mjs).
//
// preflight_launch.mjs is the thing that stands between a person and a run: nothing launches until
// it exits 0. It was proven by hand, once, and then nothing watched it. A gate nobody tests is a
// gate that can be edited into a rubber stamp without anything going red — which is the precise
// failure mode it was built to stop, one level up. So this file does to the gate what
// selfcheck_loops.mjs does to the kernel: builds real fixtures on disk and on the wire, runs the
// ACTUAL gate against them, and asserts each of the five gates fires — and does not fire — when it
// should. No tokens, no model, no network beyond 127.0.0.1:
//     node scripts/selfcheck_preflight.mjs      # exits non-zero if any case misbehaves
//
// Every case asserts BOTH halves, because either alone is satisfiable by accident:
//   - the EXIT CODE, and
//   - the exact SET of gate names on the FAIL lines.
// Asserting the set (not just "the name appears") is what stops a case passing for an unrelated
// reason: `unfilledMarker` is only a real test of FILLED if DESCENT, BRIEF and LIVE all stayed green
// while it fired. A fixture that drifts into breaking two gates at once now fails loudly instead of
// quietly certifying the wrong one.
//
// The cases (each comment says what DEFECT the case exists to catch, not what it does):
//   green              THE LOAD-BEARING ONE. Without a case that must go GREEN, every gate here
//                      could be failing unconditionally — a `fail()` at the top of the file, a
//                      hard-coded exit 1 — and all nine negative cases would still pass. It is the
//                      only case that proves the gate is discriminating rather than merely angry.
//   handRolled         the recorded failure that motivated the whole gate: an operator writes their
//                      own driver, it satisfies nothing, and prose could not stop it. If DESCENT
//                      ever stops noticing that the kernel markers are simply absent, the gate is
//                      decorative.
//   tamperedKernel     the harder half of the same thing: a driver that DID descend from the
//   tamperedTerminal   template and then had ONE line edited fail-open. A marker-presence check
//   tamperedHelpers    passes this; only hashing the region's body catches it, and these cases are
//                      what keep the check from being weakened back to marker-presence.
//                      THREE cases, one per entry in REGIONS, and that is the point: with a single
//                      tamper case (it used to edit a line in `terminal-status`) the LARGEST hashed
//                      region could be deleted from REGIONS outright and all ten cases stayed green
//                      — MEASURED. `strippedComments` does not cover the hole either, because it
//                      breaks all three regions at once, so any one surviving entry still fires
//                      DESCENT. Each case below tampers with exactly one region, so deleting any
//                      single REGIONS entry turns exactly the matching case red.
//   strippedComments   the invariants are written in the kernel's COMMENTS. A normaliser that
//                      dismissed comments as cosmetic would let a driver ship the code without the
//                      reasoning that makes it reviewable, and hash green. Deleting comment lines
//                      must count as divergence.
//   handoffElsewhere   the pickup document's path is Config, ABOVE every hashed region, so no hash
//                      covers it: a filled driver could point HANDOFF at any file it liked and the
//                      gate still exited GREEN, while the handoff gate downstream latched on a
//                      document nobody would ever find. DESCENT checks the derivation itself.
//   unfilledMarker     an unfilled `<<KNOB>>` either crashes at startup or, worse, reads as a value
//                      and disarms a predicate. Catches FILLED being narrowed to "the driver parses".
//   noBrief            the intake is the record that a human was ASKED what done means. Catches
//                      BRIEF degrading into "a file exists somewhere" or being skipped entirely.
//   stubBrief          the same gate one level down: BRIEF.md present, headings all correct, one
//                      answer a placeholder. A heading-presence check passes this, and a run
//                      configured from a stub converges confidently on the wrong thing.
//   noWorkbench        the observability promise. A dead server must not read as live — catches the
//                      fetch being made optional, or its failure being swallowed into a warning.
//   wrongDirWorkbench  THE ONE THAT MATTERS MOST, and a MEASURED past failure. An earlier LIVE gate
//                      compared served content against on-disk content; the workbench seeds every
//                      ledger with byte-identical starting content, so two fresh dirs are
//                      indistinguishable at exactly the moment preflight runs, and the gate returned
//                      GREEN against a deliberately wrong directory. The fixture reproduces that
//                      setup exactly — two dirs, each freshly seeded by its OWN server, preflight
//                      pointed at the wrong one — so the identity-by-nonce check can never be
//                      regressed back into a content comparison.
//   brokenKernel       the gate delegates the kernel's own proof to selfcheck_loops.mjs. If that
//                      delegation is dropped, or its non-zero exit is caught and ignored, a run can
//                      launch on a kernel whose safety invariants are broken. Runs a COPY of the
//                      whole skill whose template is edited fail-open, so the copy's
//                      selfcheck_loops.mjs genuinely exits 1 and only SELFCHECK may fire.
//
// Hermetic and self-cleaning: one fresh mkdtemp under the OS temp root, ports obtained by binding 0
// and reading back what the kernel assigned, and EVERY workbench killed in a finally — including on
// failure. A leaked server holding a port would make a later run of this suite pass or fail for a
// reason that has nothing to do with the gate.

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL = dirname(HERE)
const PREFLIGHT = join(HERE, 'preflight_launch.mjs')
const SERVER = join(HERE, 'workbench_server.py')
const TEMPLATE = join(SKILL, 'assets', 'loop-template.js')
const TEMPLATE_SRC = readFileSync(TEMPLATE, 'utf8')

// Ports this suite may never bind, per the operating rules for this machine. Reserved for live
// services; a self-check that stole one would take something else down to test itself.
const FORBIDDEN_PORTS = new Set([5280, 5407, 7811, 7911, 8791, 9550])

// ---- tiny assert helper: a fixture that silently does nothing is a vacuous case ------------
// Every mutation below (tamper a line, strip comments, break the template) must be PROVEN to have
// landed. A `.replace()` whose pattern stopped matching after an edit upstream would otherwise turn
// its case into a second copy of `green` that passes forever.
function must(cond, msg) { if (!cond) throw new Error(`fixture invariant violated: ${msg}`) }

// ---- fill the template ---------------------------------------------------------------------
// The full marker list comes from the template's own Config block. Values are chosen to satisfy the
// template's KNOB CHECK (DRY_ROUNDS >= 1, MAX_RETRIES >= 0, BATCH >= 1, PASS_THRESHOLD in (0,1],
// MAX_ROUNDS null or >= 1) so the filled driver is a driver that would actually start, not merely
// one that has no angle brackets left in it.
function fillTemplate(ledgerDir, src = TEMPLATE_SRC) {
  const subs = {
    '<<ARCHETYPE>>': 'exhauster',
    '<<MAX_ROUNDS>>': '6',
    '<<PASS_THRESHOLD>>': '0.9',
    '<<DRY_ROUNDS>>': '2',
    '<<MAX_RETRIES>>': '2',
    '<<BATCH>>': '8',
    '<<LEDGER_DIR>>': ledgerDir,
    '<<RUNS_JSONL_PATH>>': join(ledgerDir, 'runs.jsonl'),
    '<<SOURCE>>': 'selfcheck-fixture-queue',
    '<<TARGET>>': 'selfcheck-fixture',
    '<<RUN_ID>>': 'selfcheck-preflight-run',
    '<<LENSES>>': "['a','b']",
    '<<INVARIANTS>>': "['inv1','inv2']",
    '<<MANDATES>>': "['correctness','performance']",
  }
  let out = src
  for (const [k, v] of Object.entries(subs)) out = out.split(k).join(v)
  must(!/<<[A-Z_]+>>/.test(out), 'the substitution list is missing a marker the template still has')
  return out
}

// ---- BRIEF.md -------------------------------------------------------------------------------
// The six headings the gate requires, each with a body comfortably over its 20-char floor. `stub`
// names the ONE section to answer with a placeholder — that is the stubBrief fixture, and it is a
// separate parameter rather than a separate string so the two briefs cannot drift apart and make
// stubBrief accidentally test something else.
function briefMd(stub = null) {
  const answers = {
    Destination: 'Every fixture case in this suite behaves exactly as its comment asserts.',
    Archetype: 'exhauster — the queue of cases is known and finite, so it is drained, not searched.',
    Atom: 'One preflight case: a separate assertion pass reads its exit code and its gate set.',
    Stop: 'Every case in the table has been run and matched its asserted exit code and gate set.',
    Evidence: 'One PASS/FAIL line per case, plus the failing preflight output when green breaks.',
    Autonomy: 'autonomous — zero model tokens, so the only ceiling is wall-clock seconds.',
  }
  return Object.entries(answers)
    .map(([h, a]) => `## ${h}\n\n${h === stub ? 'TBD' : a}\n`)
    .join('\n')
}

// ---- ports + workbench ----------------------------------------------------------------------
// Bind 0, read back what the kernel assigned, release. Never a hard-coded port: two runs of this
// suite in parallel, or a leftover server from an aborted run, would otherwise collide and the
// resulting pass/fail would be about port luck rather than about the gate.
async function freePort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise((res, rej) => {
      const s = createServer()
      s.once('error', rej)
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
    })
    if (!FORBIDDEN_PORTS.has(port)) return port
  }
  throw new Error('could not obtain a non-reserved free port')
}

const running = []   // every server this process started, so the finally can kill all of them

// The server BUMPS to the next port when the one it was given is taken, so the port it prints is
// the only trustworthy one — trusting the port we asked for would silently point half these cases
// at a server serving somebody else's directory, which is the exact confusion wrongDirWorkbench
// exists to detect. Parse the URL it prints, then prove it answers before returning.
async function startWorkbench(dir) {
  const port = await freePort()
  // PYTHONUNBUFFERED because the port we must read back is on a PIPE: python block-buffers stdout
  // when it is not a tty, so the banner sits in the buffer and the wait below times out against a
  // server that is in fact already serving.
  const proc = spawn('python3', [SERVER, dir, '--port', String(port), '--no-open'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } })
  running.push(proc)
  let out = ''
  proc.stdout.on('data', d => { out += d })
  let stderr = ''
  proc.stderr.on('data', d => { stderr += d })

  const deadline = Date.now() + 15000
  let url = null
  while (Date.now() < deadline) {
    const m = out.match(/(http:\/\/127\.0\.0\.1:(\d+)\/)/)
    if (m) {
      must(!FORBIDDEN_PORTS.has(Number(m[2])), `workbench bumped onto reserved port ${m[2]}`)
      url = m[1].replace(/\/$/, '')
      break
    }
    if (proc.exitCode !== null) throw new Error(`workbench exited ${proc.exitCode}: ${stderr.slice(0, 200)}`)
    await new Promise(r => setTimeout(r, 50))
  }
  if (!url) throw new Error(`workbench on ${dir} never printed a URL`)
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/index.html`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) { await r.text(); return { url, proc, port: Number(url.split(':').pop()) } }
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`workbench on ${dir} never answered at ${url}`)
}

async function stopWorkbench(wb) {
  if (!wb || wb.proc.exitCode !== null) return
  const ended = new Promise(r => wb.proc.once('exit', r))
  wb.proc.kill('SIGTERM')
  await Promise.race([ended, new Promise(r => setTimeout(() => { wb.proc.kill('SIGKILL'); r() }, 3000))])
}

// ---- run the gate ----------------------------------------------------------------------------
// Captured, never inherited: the assertion is over the OUTPUT, and a case that only read the exit
// code could not tell WHICH gate fired. stdout+stderr are merged because a crash in the gate should
// show up in the case's transcript rather than vanishing.
function runPreflight({ preflight = PREFLIGHT, driver, ledgerDir, workbench }) {
  let code = 0, out = ''
  try {
    out = execFileSync(process.execPath, [preflight, driver, ledgerDir, '--workbench', workbench],
      { encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    code = e.status ?? -1
    out = `${e.stdout || ''}${e.stderr || ''}`
  }
  const gates = out.split('\n')
    .map(l => l.match(/^\s*FAIL\s+([A-Z]+):/))
    .filter(Boolean).map(m => m[1])
  return { code, out, gates: [...new Set(gates)].sort() }
}

// ---- fixture builders -------------------------------------------------------------------------
const ROOT = mkdtempSync(join(tmpdir(), 'selfcheck-preflight-'))

// A ledger dir that a REAL workbench has seeded and is still serving, with a complete brief unless
// told otherwise. This is the baseline every negative case perturbs exactly one thing away from.
async function makeLedger(name, { brief = briefMd(), serve = true } = {}) {
  const dir = join(ROOT, name)
  mkdirSync(dir, { recursive: true })
  const wb = await startWorkbench(dir)              // seeds progress.json + index.html
  must(existsSync(join(dir, 'progress.json')), `${name}: the workbench did not seed progress.json`)
  if (brief !== null) writeFileSync(join(dir, 'BRIEF.md'), brief)
  if (!serve) { await stopWorkbench(wb); return { dir, url: wb.url, wb: null } }
  return { dir, url: wb.url, wb }
}

function writeDriver(name, src) {
  const p = join(ROOT, `${name}.js`)
  writeFileSync(p, src)
  return p
}

// A hand-rolled driver: syntactically fine, semantically a loop, and descended from nothing. It has
// no kernel markers at all, which is the shape of the failure that motivated the gate.
const HAND_ROLLED = `// A loop somebody wrote themselves. It looks reasonable and carries no guarantees.
const MAX_ROUNDS = 6
for (let round = 1; round <= MAX_ROUNDS; round++) {
  const work = await agent('do the next thing', { label: 'work' })
  const ok = await agent('did it work? ' + work, { label: 'work' })   // same agent judges itself
  if (ok) break
}
return { status: 'done', converged: true }
`

// ONE line per hashed region, each altered fail-open, each the smallest possible edit that guts a
// guarantee while leaving the file looking correct — exactly what a body hash exists to catch and a
// marker check never would. One function per REGIONS entry, so a deleted entry has a case that can
// only go red: the tampered line is INSIDE that region and outside every other.
function tamperOneLine(src, from, to, what) {
  must(src.includes(from), `${what}: the line has moved; pick a new line inside that region`)
  must(src.split(from).length === 2, `${what}: the line is not unique, so the tamper is ambiguous`)
  return src.replace(from, to)
}
// REGION 'schemas' — `additionalProperties: false` on VERDICT_SCHEMA. Deleting it is the most
// innocuous-looking edit in this file and it re-opens a false-`answered`: the kernel spreads a verdict
// over its work item, so an undeclared key the schema now permits is a field the VERIFIER sets on the
// ITEM, and `terminal: true` is the field that means "this is the answer". This is why the region
// exists at all — the kernel below can be byte-perfect while the schema that feeds it is not.
const tamperSchemas = (src) => tamperOneLine(src,
  "  additionalProperties: false,\n  required: ['id', 'pass', 'evidence'],",
  "  required: ['id', 'pass', 'evidence'],",
  'schemas region (verdict additionalProperties)')
// REGION 'kernel' — the dry counter. `!state.gap` is what stops a round whose producer went blind
// from counting as a round that searched and found nothing; without it a run of dead agents plateaus
// into a positive terminal status.
const tamperKernel = (src) => tamperOneLine(src,
  'if (grew === 0 && !state.gap) state.dry++; else if (grew > 0) state.dry = 0',
  'if (grew === 0) state.dry++; else if (grew > 0) state.dry = 0',
  'kernel region (dry counter)')
// REGION 'terminal-status' — the witness latch: the only thing standing between "the run verified
// atoms" and "a human saw any of it". Hard-coding it true reopens the whole unwitnessed rung.
const tamperTerminal = (src) => tamperOneLine(src,
  "const witnessed = audit !== null && (audit.hero === 'artifact' || audit.hero === 'none')",
  "const witnessed = true",
  'terminal-status region (witness latch)')
// REGION 'shared-helpers' — the patience predicate. Returning false means a run that is stuck on a
// blocker with nothing landing never ends: BLOCKER_PATIENCE stops bounding anything.
const tamperHelpers = (src) => tamperOneLine(src,
  'function stalled(state) { return state.stall >= BLOCKER_PATIENCE }',
  'function stalled(state) { return false }',
  'shared-helpers region (patience predicate)')

// Delete comment-only lines INSIDE the three hashed regions, leaving the `// ---- ` region markers
// intact — the point is a driver that still has every region, in the right place, with the
// reasoning removed. Stripping the markers too would collapse this into `handRolled`.
function stripKernelComments(src) {
  const lines = src.split('\n')
  const start = lines.findIndex(l => l.startsWith('// ---- Kernel'))
  must(start >= 0, 'the kernel region marker has moved')
  let removed = 0
  const kept = lines.filter((l, i) => {
    const drop = i > start && /^\s*\/\//.test(l) && !l.startsWith('// ----')
    if (drop) removed++
    return !drop
  })
  must(removed > 0, 'no comment lines were removed, so this case would be a duplicate of green')
  return kept.join('\n')
}

// A COPY of the whole skill whose template is edited so the copy's own selfcheck_loops.mjs fails.
// The edit must be fail-open AND outside every hashed region, or the case passes on DESCENT's
// coattails and proves nothing about SELFCHECK. That leaves Config and MODES, so it lands in MODES:
// the explorer's `stop` drops its plateau clause, leaving a run that can only end by grounding a
// terminal claim — no coverage plateau ever fires and it rides the backstop instead.
//
// It used to edit the DRY_ROUNDS knob check, which was outside the regions until the `schemas` region
// was extended up to the Knob-check marker to cover the enums the counters are built from. The two
// `must`s below are what caught that, and then caught the first replacement: dropping the blocker and
// gap clauses from the explorer's `reachedGoal` leaves selfcheck_loops.mjs GREEN, because the terminal
// ladder demotes a blocked or gapped run on its own — those clauses are defence in depth with no
// independent test. If this line moves into a hashed region too, pick another MODES edit and prove it
// reds the suite; do not widen the expected gate set, which would delete the only proof SELFCHECK is
// wired at all.
function makeBrokenSkillCopy() {
  const copy = join(ROOT, 'skill-copy')
  execFileSync('cp', ['-R', SKILL, copy])
  const tpl = join(copy, 'assets', 'loop-template.js')
  const src = readFileSync(tpl, 'utf8')
  const from = 'stop(state) { return state.answered || state.dry >= DRY_ROUNDS }'
  const to = 'stop(state) { return state.answered }'
  must(src.includes(from), 'the explorer stop line has moved; pick another fail-open MODES edit')
  writeFileSync(tpl, src.replace(from, to))
  // Prove the break took: if the copy's selfcheck still exits 0, brokenKernel is testing nothing.
  let selfcheckCode = 0
  try { execFileSync(process.execPath, [join(copy, 'scripts', 'selfcheck_loops.mjs')], { stdio: 'pipe' }) }
  catch (e) { selfcheckCode = e.status ?? -1 }
  must(selfcheckCode !== 0, 'the broken template still passes selfcheck_loops.mjs')
  return join(copy, 'scripts', 'preflight_launch.mjs')
}

// ---- the run -----------------------------------------------------------------------------------
let failures = 0
const line = (ok, name, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(18)} → ${detail}`)
}

// Assert exit code AND the exact set of gates that failed. `wantGates` is a set, not a substring:
// a case that starts breaking a second gate is a fixture that drifted, and it goes red here rather
// than quietly certifying the wrong gate.
function check(name, r, wantCode, wantGates) {
  const got = r.gates.join(',')
  const want = [...wantGates].sort().join(',')
  const ok = r.code === wantCode && got === want
  line(ok, name, `exit=${r.code} (want ${wantCode})  gates=[${got}] (want [${want}])`)
  return ok
}

try {
  const green = await makeLedger('green')
  const greenDriver = writeDriver('driver-green', fillTemplate(green.dir))

  // -- green ------------------------------------------------------------------------------------
  // Removed first so its presence is evidence from THIS run: a stale receipt from an earlier run
  // would let a gate that never writes one look like it did.
  const receiptPath = join(green.dir, 'PREFLIGHT.json')
  if (existsSync(receiptPath)) unlinkSync(receiptPath)
  const g = runPreflight({ driver: greenDriver, ledgerDir: green.dir, workbench: green.url })
  const receiptOk = existsSync(receiptPath) &&
    ['SELFCHECK', 'DESCENT', 'FILLED', 'BRIEF', 'LIVE']
      .every(x => (JSON.parse(readFileSync(receiptPath, 'utf8')).gates || []).includes(x))
  const greenOk = g.code === 0 && g.gates.length === 0 && /preflight: GREEN/.test(g.out) && receiptOk
  line(greenOk, 'green', `exit=${g.code} (want 0)  gates=[${g.gates.join(',')}] (want [])  receipt=${receiptOk}`)
  if (!greenOk) {
    // LOUD on purpose. Every negative case below is satisfied by a gate that fails always, so a
    // broken green is not one failure among ten — it invalidates the whole suite, and the reader
    // needs the gate's own words to see why.
    console.log('\n  !! GREEN IS THE LOAD-BEARING CASE. With no case that must pass, a preflight')
    console.log('  !! that failed unconditionally would satisfy every other case in this file.')
    console.log('  !! The gate said:\n' + g.out.split('\n').map(l => '  |  ' + l).join('\n'))
  }

  // -- DESCENT family: same ledger, same brief, same live server; only the driver differs --------
  check('handRolled',
    runPreflight({ driver: writeDriver('driver-hand', HAND_ROLLED), ledgerDir: green.dir, workbench: green.url }),
    1, ['DESCENT'])

  // ONE CASE PER HASHED REGION. Not decoration: with only the `terminal-status` tamper below, the
  // 'kernel' entry — the largest region in the file — could be deleted from REGIONS and every case
  // here still passed. Each of the four edits lands inside exactly one region, so REGIONS has no
  // entry whose deletion goes unnoticed. Proven by mutation, not by inspection: delete any single
  // entry and exactly the matching case flips to exit 0.
  check('tamperedSchemas',
    runPreflight({ driver: writeDriver('driver-tampered-s', tamperSchemas(fillTemplate(green.dir))), ledgerDir: green.dir, workbench: green.url }),
    1, ['DESCENT'])

  check('tamperedKernel',
    runPreflight({ driver: writeDriver('driver-tampered-k', tamperKernel(fillTemplate(green.dir))), ledgerDir: green.dir, workbench: green.url }),
    1, ['DESCENT'])

  check('tamperedTerminal',
    runPreflight({ driver: writeDriver('driver-tampered-t', tamperTerminal(fillTemplate(green.dir))), ledgerDir: green.dir, workbench: green.url }),
    1, ['DESCENT'])

  check('tamperedHelpers',
    runPreflight({ driver: writeDriver('driver-tampered-h', tamperHelpers(fillTemplate(green.dir))), ledgerDir: green.dir, workbench: green.url }),
    1, ['DESCENT'])

  // The pickup document, pointed somewhere else. Config sits ABOVE every hashed region, so all three
  // hashes still match — this driver is byte-identical to `green` in every region — and the gate
  // exited 0 on it. The edit is deliberately plausible: an absolute path that exists, is writable, and
  // is not the ledger dir the workbench serves or the audit reads.
  check('handoffElsewhere',
    runPreflight({
      driver: writeDriver('driver-handoff', tamperOneLine(fillTemplate(green.dir),
        "const HANDOFF = LEDGER_DIR + '/HANDOFF.md'",
        `const HANDOFF = '${join(ROOT, 'somewhere-else')}/HANDOFF.md'`,
        'Config (HANDOFF derivation)')),
      ledgerDir: green.dir, workbench: green.url }),
    1, ['DESCENT'])

  check('strippedComments',
    runPreflight({ driver: writeDriver('driver-stripped', stripKernelComments(fillTemplate(green.dir))), ledgerDir: green.dir, workbench: green.url }),
    1, ['DESCENT'])

  // -- FILLED: one marker left behind, and deliberately one that lives ABOVE the kernel, so the
  //    driver still hashes clean and FILLED is the only gate with anything to say.
  const unfilled = fillTemplate(green.dir).replace(
    "const RUN_ID = 'selfcheck-preflight-run'", "const RUN_ID = '<<RUN_ID>>'")
  must(/<<RUN_ID>>/.test(unfilled), 'RUN_ID was not re-emptied; the unfilledMarker case would be vacuous')
  check('unfilledMarker',
    runPreflight({ driver: writeDriver('driver-unfilled', unfilled), ledgerDir: green.dir, workbench: green.url }),
    1, ['FILLED'])

  // -- BRIEF family: their own live ledgers, so LIVE stays green and BRIEF fires alone -----------
  const noBriefLedger = await makeLedger('no-brief', { brief: null })
  must(!existsSync(join(noBriefLedger.dir, 'BRIEF.md')), 'noBrief fixture accidentally has a brief')
  check('noBrief',
    runPreflight({ driver: greenDriver, ledgerDir: noBriefLedger.dir, workbench: noBriefLedger.url }),
    1, ['BRIEF'])

  const stubLedger = await makeLedger('stub-brief', { brief: briefMd('Stop') })
  check('stubBrief',
    runPreflight({ driver: greenDriver, ledgerDir: stubLedger.dir, workbench: stubLedger.url }),
    1, ['BRIEF'])

  // -- LIVE, absent: seeded by a workbench that has since been stopped. Seeding it for real matters
  //    — a dir with no progress.json fails LIVE too, but for the wrong reason, and the case would
  //    stop covering the fetch at all.
  const deadLedger = await makeLedger('no-workbench', { serve: false })
  check('noWorkbench',
    runPreflight({ driver: greenDriver, ledgerDir: deadLedger.dir, workbench: deadLedger.url }),
    1, ['LIVE'])

  // -- LIVE, wrong dir: the measured regression. TWO ledger dirs, each freshly seeded by its OWN
  //    server, so their contents are byte-identical at this instant. Preflight is pointed at dir A
  //    and handed dir B's URL. Both servers are genuinely up, so "something answered" is true, the
  //    content matches, and only the nonce can tell them apart.
  const wrongA = await makeLedger('wrong-a')
  const wrongB = await makeLedger('wrong-b')
  must(wrongA.url !== wrongB.url, 'the two workbenches landed on one URL')
  must(readFileSync(join(wrongA.dir, 'progress.json'), 'utf8') ===
       readFileSync(join(wrongB.dir, 'progress.json'), 'utf8'),
    'the two seeded ledgers are NOT byte-identical, so this case no longer reproduces the regression')
  check('wrongDirWorkbench',
    runPreflight({ driver: greenDriver, ledgerDir: wrongA.dir, workbench: wrongB.url }),
    1, ['LIVE'])

  // -- SELFCHECK: the green fixture in every respect, run through a skill copy whose kernel proof
  //    fails. Everything else about this invocation is the green case, so any other gate firing
  //    means the fixture broke something it did not mean to.
  check('brokenKernel',
    runPreflight({ preflight: makeBrokenSkillCopy(), driver: greenDriver, ledgerDir: green.dir, workbench: green.url }),
    1, ['SELFCHECK'])
} finally {
  // ALWAYS, including on a thrown fixture error. A leaked python server would hold a port and a
  // temp dir for the rest of the session, and the next run of this suite would pass or fail for a
  // reason that has nothing to do with the launch gate.
  for (const proc of running) {
    if (proc.exitCode === null) { try { proc.kill('SIGKILL') } catch { /* already gone */ } }
  }
  rmSync(ROOT, { recursive: true, force: true })
}

console.log(failures === 0
  ? '\nThe launch gate discriminates: every gate fires when it must, and a clean run still passes.'
  : `\n${failures} preflight case(s) MISBEHAVED.`)
process.exit(failures === 0 ? 0 : 1)
