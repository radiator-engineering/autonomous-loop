#!/usr/bin/env node
// replay_gates.mjs — run the witness gate against FINISHED runs, without re-running them.
//
// WHY THIS EXISTS. The witness gate decides whether a run that verified every atom is allowed to
// call itself a success, and until now the only way to exercise it was to run a loop for an hour and
// see what came out the end. That is a test you write once and never run again, so the gate drifted:
// it shipped a rule ("hero 'none' beside a non-empty artifacts/ is a lying hero") that, replayed
// against five real ledgers, fired on two runs and was WRONG about both. One had produced a proper
// before/after pair and merely failed to point at it; the other had a capture harness that died
// mid-run. Same word for both, and for the honest third case as well.
//
// A finished ledger directory holds everything the gate reads. So the gate can be replayed over a
// corpus of them in milliseconds, which is what makes it reviewable at all.
//
// THE FUNCTION UNDER TEST IS EXTRACTED FROM THE TEMPLATE, not copied into here. A copy is a second
// source of truth that agrees with the first exactly until someone edits one of them, and this file
// would then be testing code that no run executes. Same reasoning as DESCENT: check the derivation,
// never a resemblance.
//
//   node scripts/replay_gates.mjs                      # synthetic fixtures, every branch
//   node scripts/replay_gates.mjs <ledger-dir> ...     # plus real runs, verdict for each

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = resolve(HERE, '..', 'assets', 'loop-template.js')
const IMG = /\.(png|jpe?g|gif|svg|webp)$/i

// ---- extract witnessVerdict from the template ------------------------------------------------
function extract(name, src) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`no 'function ${name}(' in ${TEMPLATE} — the template changed shape`)
  // brace-match from the first { after the signature
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`unterminated function ${name}`)
}
const templateSrc = readFileSync(TEMPLATE, 'utf8')
const witnessVerdict = new Function(`${extract('witnessVerdict', templateSrc)}; return witnessVerdict`)()

// ---- read a real ledger dir into the shape the gate sees ---------------------------------------
function auditOf(dir) {
  const pj = JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8'))
  const adir = join(dir, 'artifacts')
  const files = existsSync(adir) ? readdirSync(adir).filter(f => IMG.test(f)) : []
  const digests = new Set(files.map(f => createHash('md5').update(readFileSync(join(adir, f))).digest('hex')))
  const hp = join(dir, 'HANDOFF.md')
  const ht = existsSync(hp) ? readFileSync(hp, 'utf8') : ''
  const m = ht.match(/Round\s+(\d+)/)
  const heroType = (pj.hero || {}).type
  return {
    audit: {
      hero: heroType === 'artifact' ? 'artifact' : heroType === 'none' ? 'none' : 'absent',
      handoff: ht ? 'complete' : 'absent',
      handoffRound: m ? Number(m[1]) : -1,
      captures: files.length,
      distinctCaptures: digests.size,
    },
    // Old ledgers predate heroLog. Absent it, the run is assumed never to have reported a capture —
    // which is the conservative reading: it can only make the replay MISS a regression, never invent
    // one, so a corpus verdict of 'regressed' here is always earned by the digests alone.
    everCaptured: Array.isArray(pj.heroLog) && pj.heroLog.some(h => h.hero === 'artifact'),
    rounds: (pj.rounds || []).length,
    status: pj.status,
    confirmed: pj.confirmed,
  }
}

// ---- synthetic fixtures: one per branch, so a deleted branch turns a line red -------------------
const A = (hero, captures, distinctCaptures) => ({ hero, handoff: 'complete', handoffRound: 1, captures, distinctCaptures })
const CASES = [
  ['dead auditor fails closed',                    null,                    false, 'unwitnessed'],
  ['board points at a real frame',                 A('artifact', 3, 3),     false, 'witnessed'],
  ['honest none, empty gallery',                   A('none', 0, 0),         false, 'witnessed'],
  ['frames exist, board points at none',           A('none', 5, 5),         false, 'unpointed'],
  ['no hero slot at all, frames exist',            A('absent', 2, 2),       false, 'unpointed'],
  ['no hero slot, nothing on disk',                A('absent', 0, 0),       false, 'unwitnessed'],
  ['jammed camera: 4 frames, 1 image',             A('none', 4, 1),         false, 'regressed'],
  ['jammed camera outranks a pointed frame',       A('artifact', 4, 1),     false, 'regressed'],
  ['two identical frames is already jammed',       A('none', 2, 1),         false, 'regressed'],
  ['one frame is not yet evidence of a jam',       A('none', 1, 1),         false, 'unpointed'],
  ['reported a capture, now points at none',       A('none', 3, 3),         true,  'regressed'],
  ['reported a capture and still points at one',   A('artifact', 3, 3),     true,  'witnessed'],
]

let failed = 0
console.log('SYNTHETIC — one case per branch')
console.log('-'.repeat(78))
for (const [name, audit, ever, want] of CASES) {
  const got = witnessVerdict(audit, ever)
  const ok = got === want
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(44)} -> ${got}${ok ? '' : `  (want ${want})`}`)
}

const dirs = process.argv.slice(2)
if (dirs.length) {
  console.log('\nCORPUS — real finished runs')
  console.log('-'.repeat(78))
  console.log(`  ${'ledger'.padEnd(14)}${'hero'.padEnd(10)}${'frames'.padEnd(8)}${'distinct'.padEnd(10)}${'rounds'.padEnd(8)}verdict`)
  for (const d of dirs) {
    const dir = resolve(d)
    if (!existsSync(join(dir, 'progress.json'))) { console.log(`  ${basename(dir).padEnd(14)}(no progress.json — skipped)`); continue }
    const { audit, everCaptured, rounds } = auditOf(dir)
    const v = witnessVerdict(audit, everCaptured)
    console.log(`  ${basename(dir).padEnd(14)}${audit.hero.padEnd(10)}${String(audit.captures).padEnd(8)}${String(audit.distinctCaptures).padEnd(10)}${String(rounds).padEnd(8)}${v}`)
  }
}
console.log('')
if (failed) { console.error(`${failed} synthetic case(s) FAILED`); process.exit(1) }
console.log('all synthetic cases pass')
