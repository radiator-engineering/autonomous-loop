#!/usr/bin/env node
// lint_design.mjs — read a FILLED loop driver + its BRIEF.md and name the predictable death before
// launch, not after five workers have already died on it. Five lints, each a heuristic over the
// TEXT a generation session produced (the driver's Config literals + the BRIEF's prose), plus one
// (L2) that measures actual prompt bytes off a single spoofed happy run of the driver.
//
//   node scripts/lint_design.mjs <path/to/driver.js> <path/to/BRIEF.md> [--json]
//   node scripts/lint_design.mjs                                          # self-test, exit != 0 on any miss
//
// Severity contract: only L3 (a structurally blind verifier facing a visual evidence contract) and
// L1's compound shape (a whole-file directive PAIRED with an iterate-until-pass loop against a file
// over the line budget — the recorded shape that killed five workers) are HARD fails. L2 never
// fails — its numbers are estimates, printed, not gates. L4 and L5 are warnings: a taste bar with
// no mechanical check, or two files both claiming to be the one count that matters.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadFilledDriver, spoofWorld, fixturesFor } from './lib/spoof_world.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// ---- heuristic tables. Named constants, not inline regexes, so the self-test fixtures and the
// lints agree on one definition and a future failure mode becomes one new row. --------------------
const L1_LINE_BUDGET = 250          // emitted lines one item may plausibly demand before a worker dies
const L1_WHOLE_FILE = /\b(rewrite|regenerate|output|emit|produce) (the )?(entire|whole|full|complete)\b/i
const L1_ITERATE = /\b(run (the )?tests?|iterate|repeat|until (it|they) pass)\b/i
const L3_VISUAL = /\b(screenshot|capture|image|png|render|visual|pixel|browser)\b/i
const L4_TASTE = /\b(polished|beautiful|elegant|feels right|looks good|clean|delightful|high[- ]quality)\b/i
const L4_GROUNDED = /(`[^`]+`|\bnpm |\bnode |\bpytest|\bexit 0|\bdiff\b|\.mjs\b|\.py\b|\bpx\b|[<>]=? ?\d)/
const L5_ROLE = /\b(queue|backlog|count|source of truth|status file)\b/i
const PRICE_PER_MTOK_IN = { opus: 15, sonnet: 3, haiku: 0.8 }   // USD, input, 2026-08 — an ESTIMATE knob, update freely
const L2_DEFAULT_THRESHOLD = 2      // $ per confirmed atom, default warn line
const PATH_TOKEN = /[\w./-]+\.\w{1,4}/g

// ---- shared text collection ------------------------------------------------------------------
// A section body: everything between a "## <prefix>..." header line and the next "## " header (or
// EOF), trimmed. `startsWith` so "## Atom" matches "## Atom + verify contract" etc.
function extractSection(brief, headerPrefix) {
  const lines = brief.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(headerPrefix)) { start = i; break }
  }
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { end = i; break }
  }
  return lines.slice(start + 1, end).join('\n').trim()
}

// Quoted string elements out of `const NAME = [...]` array literals in the driver — the driver's
// half of "atom-defining strings". Named consts (MANDATES/LENSES/INVARIANTS) plus anything that
// looks like a queue seed by name, so a future archetype's frontier literal is covered for free.
function configLiterals(driverSrc) {
  const out = []
  const grab = (m) => { for (const mm of m[1].matchAll(/'([^']*)'|"([^"]*)"/g)) out.push(mm[1] ?? mm[2]) }
  for (const name of ['MANDATES', 'LENSES', 'INVARIANTS']) {
    const m = driverSrc.match(new RegExp(`const ${name}\\s*=\\s*(\\[[^\\]]*\\])`))
    if (m) grab(m)
  }
  for (const m of driverSrc.matchAll(/const \w*(?:QUEUE|SEED)\w*\s*=\s*(\[[^\]]*\])/gi)) grab(m)
  return out
}

// The full atom-defining collection for L1/L4: driver Config array elements + the BRIEF's
// "## Atom + verify contract" and "## Destination" section bodies, each as one item string.
function collectAtomItems(driverSrc, brief) {
  const items = [...configLiterals(driverSrc)]
  const atomBody = extractSection(brief, '## Atom')
  const destBody = extractSection(brief, '## Destination')
  if (atomBody) items.push(atomBody)
  if (destBody) items.push(destBody)
  return items
}

function normalizePath(p) { return p.replace(/^\.\//, '').toLowerCase() }

// ---- L1: output budget --------------------------------------------------------------------------
function lintL1(driverSrc, brief, measured, opts = {}) {
  const items = collectAtomItems(driverSrc, brief)
  const briefDir = opts.briefDir || process.cwd()
  let anyWholeFile = false, anyIterate = false
  for (const text of items) {
    if (L1_WHOLE_FILE.test(text)) {
      anyWholeFile = true
      if (L1_ITERATE.test(text)) anyIterate = true
    }
  }
  if (!anyWholeFile) return { level: 'pass', reason: 'no whole-file directive found in atom-defining text' }

  let anyFileFound = false, largestLines = 0, largestFile = null
  for (const text of items) {
    const tokens = text.match(PATH_TOKEN) || []
    for (const tok of tokens) {
      let p
      try { p = resolve(briefDir, tok) } catch { continue }
      if (!existsSync(p)) continue
      try {
        if (!statSync(p).isFile()) continue
        const lines = readFileSync(p, 'utf8').split('\n').length
        anyFileFound = true
        if (lines > largestLines) { largestLines = lines; largestFile = tok }
      } catch { /* unreadable path-looking token; not a file for our purposes */ }
    }
  }

  if (!anyFileFound) return { level: 'warn', reason: 'output volume unverifiable — whole-file directive names no file found on disk' }
  if (largestLines <= L1_LINE_BUDGET) return { level: 'pass', reason: `whole-file directive found but largest referenced file (${largestFile}) is only ${largestLines} lines` }
  if (anyIterate) return { level: 'fail', reason: `whole-file directive + iterate-until-pass loop against ${largestFile} (${largestLines} lines > ${L1_LINE_BUDGET}) — the shape that kills workers` }
  return { level: 'warn', reason: `whole-file directive against ${largestFile} (${largestLines} lines > ${L1_LINE_BUDGET})` }
}

// ---- L2: ceremony economics (never hard-fails; the numbers are estimates) ------------------------
function pickPrice(modelNames) {
  const matched = []
  for (const name of modelNames) {
    if (!name) continue
    const lower = String(name).toLowerCase()
    for (const key of Object.keys(PRICE_PER_MTOK_IN)) {
      if (lower.includes(key)) { matched.push(PRICE_PER_MTOK_IN[key]); break }
    }
  }
  if (!matched.length) return PRICE_PER_MTOK_IN.sonnet
  return matched.reduce((a, b) => a + b, 0) / matched.length
}

function lintL2(driverSrc, brief, measured, opts = {}) {
  if (!measured) return { level: 'warn', reason: 'unspoofable driver, L2 skipped' }
  const threshold = opts.l2Threshold ?? L2_DEFAULT_THRESHOLD

  let ceremonyBytes = 0
  for (const [label, bytes] of Object.entries(measured.promptBytes || {})) {
    if (label.startsWith('work:') || label.startsWith('verify:')) continue
    ceremonyBytes += bytes
  }

  const measuredRounds = Math.max(1, measured.rounds || 1)
  let scaledBytes = ceremonyBytes
  const maxRoundsMatch = driverSrc.match(/const MAX_ROUNDS = (\d+|null)/)
  if (maxRoundsMatch && maxRoundsMatch[1] !== 'null') {
    const maxRounds = Number(maxRoundsMatch[1])
    scaledBytes = (ceremonyBytes / measuredRounds) * maxRounds
  }

  const tokens = scaledBytes / 4
  const price = pickPrice(Object.values(measured.models || {}))
  const cost = (tokens / 1_000_000) * price
  const confirmed = Math.max(1, measured.confirmed || 0)
  const perAtom = cost / confirmed

  let level = 'pass'
  let budgetNote = ''
  const autonomyBody = extractSection(brief, '## Autonomy') || ''
  const budgetMatch = autonomyBody.match(/\$\s*([\d,.]+)/)
  if (budgetMatch) {
    const budgetDollars = Number(budgetMatch[1].replace(/,/g, ''))
    if (Number.isFinite(budgetDollars) && cost > budgetDollars) {
      level = 'warn'
      budgetNote = `; projected \$${cost.toFixed(2)} exceeds BRIEF's \$${budgetDollars} budget`
    }
  }
  if (perAtom > threshold) level = 'warn'

  const reason = `~\$${perAtom.toFixed(4)}/confirmed atom (ceremony ${Math.round(scaledBytes)}B ≈ ${Math.round(tokens)} tok, \$${price}/Mtok, ${confirmed} confirmed) — an ESTIMATE${budgetNote}`
  return { level, reason }
}

// ---- L3: evidence contract (the only default hard fail) -----------------------------------------
function lintL3(driverSrc, brief) {
  const evidenceBody = extractSection(brief, '## Evidence') || ''
  const negatedVisual = /\b(no|not|without|non-)\s*(visual|screenshot|capture|image|png|render|pixel|browser)\b/i.test(evidenceBody)
  if (negatedVisual) return { level: 'pass', reason: 'evidence contract is non-visual' }
  const visual = L3_VISUAL.test(evidenceBody)
  if (!visual) return { level: 'pass', reason: 'evidence contract is non-visual' }

  const imagesZero = /\bimages\s*:\s*0\b/.test(driverSrc)
  const evidenceEveryZero = /const EVIDENCE_EVERY\s*=\s*0\b/.test(driverSrc)
  if (imagesZero) return { level: 'fail', reason: 'a verifier/audit tier sets images:0 while the BRIEF\'s Evidence contract is visual — structurally blind verifier, visual claim' }
  if (evidenceEveryZero) return { level: 'fail', reason: 'EVIDENCE_EVERY is 0 while the BRIEF\'s Evidence contract is visual — the design demands pictures the loop will never take' }
  return { level: 'pass', reason: 'evidence contract is visual and the driver is equipped to capture it' }
}

// ---- L4: decidability ------------------------------------------------------------------------
function lintL4(driverSrc, brief) {
  const items = collectAtomItems(driverSrc, brief)
  for (const text of items) {
    if (L4_TASTE.test(text) && !L4_GROUNDED.test(text)) {
      const snippet = text.length > 80 ? text.slice(0, 80) + '…' : text
      return { level: 'warn', reason: `taste bar with no mechanical check attached: "${snippet}"` }
    }
  }
  return { level: 'pass', reason: 'no ungrounded taste bar found' }
}

// ---- L5: dual source of truth ------------------------------------------------------------------
function lintL5(driverSrc, brief) {
  const scanText = configLiterals(driverSrc).join(' ') + '\n' + brief
  const role = new RegExp(L5_ROLE.source, 'gi')
  const paths = new Set()
  for (const m of scanText.matchAll(role)) {
    const start = Math.max(0, m.index - 80)
    const end = Math.min(scanText.length, m.index + m[0].length + 80)
    const window = scanText.slice(start, end)
    for (const tok of window.match(PATH_TOKEN) || []) paths.add(normalizePath(tok))
  }
  if (paths.size >= 2) {
    return { level: 'warn', reason: `two distinct paths both claim a counting role: ${[...paths].slice(0, 4).join(', ')}` }
  }
  return { level: 'pass', reason: 'no dual source-of-truth found' }
}

// ---- aggregator -----------------------------------------------------------------------------
export function runLints(driverSrc, brief, measured, opts = {}) {
  return {
    L1: lintL1(driverSrc, brief, measured, opts),
    L2: lintL2(driverSrc, brief, measured, opts),
    L3: lintL3(driverSrc, brief),
    L4: lintL4(driverSrc, brief),
    L5: lintL5(driverSrc, brief),
  }
}

// One spoofed happy round-trip, measured. Anything that makes the driver unsimulable (unfilled
// markers, no MODE line, an alien label) → null, and every lint that needs it degrades to a warn
// (L2 alone; the others don't consume `measured` at all) rather than pretending to a number.
export async function measureDriver(src) {
  try {
    const { driver, meta } = loadFilledDriver(src)
    const w = spoofWorld(fixturesFor(meta.mode))
    const r = await driver(w.agent, w.parallel, w.pipeline, w.log, w.phase, w.budget, w.args)
    if (w.unknownLabels.size > 0) return null
    return { promptBytes: w.promptBytes, confirmed: r && r.confirmed, models: w.models, rounds: r && r.rounds }
  } catch {
    return null
  }
}

// ---- fillTemplate: same substitution values as eval_driver.mjs's fillTemplate, so the self-test
// fixture driver is exactly what Task 3's harness already proved spoofable. -----------------------
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

// ---- self-test fixtures ------------------------------------------------------------------------
const GREEN_BRIEF = `## Destination
Migrate the parsers.
## Archetype
exhauster
## Atom + verify contract
Each file compiles: \`node --check\` exits 0.
## Stop
queue empty
## Evidence
headless data migration — no visual evidence is possible; claims.jsonl is the record
## Autonomy + budget
autonomous, 2M tokens
`

function buildL1Fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lint-design-l1-'))
  writeFileSync(join(dir, 'big.js'), 'x\n'.repeat(1000))
  const brief = GREEN_BRIEF
    .replace('Each file compiles', 'Rewrite the entire file and run the tests until they pass. Each file compiles')
    .replace('Migrate the parsers.', 'Migrate the parsers.\nTarget: big.js')
  return { driverSrc: fillTemplate('exhauster'), brief, opts: { briefDir: dir }, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function buildL3Fixture() {
  // The template has no `images:` knob, so inject a tier literal that carries one — the same shape
  // a real generation session would produce if it hand-rolled a mechanical-only verifier tier.
  const driverSrc = fillTemplate('exhauster').replace(
    'const EFFORT_PLAN = {',
    'const TIER_X = { images: 0 }\nconst EFFORT_PLAN = {'
  )
  const brief = GREEN_BRIEF.replace(
    /## Evidence\n[^\n]+/,
    '## Evidence\nA screenshot of the rendered page every round'
  )
  return { driverSrc, brief, opts: {} }
}

function buildL4Fixture() {
  const brief = GREEN_BRIEF.replace(
    'Each file compiles: `node --check` exits 0.',
    'The page looks polished and feels right.'
  )
  return { driverSrc: fillTemplate('exhauster'), brief, opts: {} }
}

function buildL5Fixture() {
  const brief = GREEN_BRIEF.replace(
    'Migrate the parsers.',
    'Migrate the parsers. The queue lives in queue.json. The backlog count is tracked in state/progress.md.'
  )
  return { driverSrc: fillTemplate('exhauster'), brief, opts: {} }
}

function buildL2Fixture() {
  // Priced with the real spoofed happy run's bytes; the threshold is dropped to a fraction of a
  // cent so the (small, honest) figure trips the warn without fabricating a giant prompt.
  return { driverSrc: fillTemplate('exhauster'), brief: GREEN_BRIEF, opts: { l2Threshold: 0.0000001 } }
}

async function selfTest() {
  let failures = 0
  const check = (ok, name, detail = '') => {
    if (!ok) failures++
    console.log(`${ok ? 'PASS' : 'FAIL'}  selftest   ${name.padEnd(28)} ${detail}`)
  }

  const greenDriver = fillTemplate('exhauster')
  const greenMeasured = await measureDriver(greenDriver)
  check(greenMeasured !== null, 'green:spoofable', 'the shipped template must be spoofable')
  const greenResults = runLints(greenDriver, GREEN_BRIEF, greenMeasured, {})
  for (const [lint, r] of Object.entries(greenResults)) {
    check(r.level === 'pass', `green:${lint}`, `level=${r.level} reason=${r.reason}`)
  }

  const REDS = [
    { lint: 'L1', level: 'fail', build: buildL1Fixture },
    { lint: 'L3', level: 'fail', build: buildL3Fixture },
    { lint: 'L4', level: 'warn', build: buildL4Fixture },
    { lint: 'L5', level: 'warn', build: buildL5Fixture },
    { lint: 'L2', level: 'warn', build: buildL2Fixture },
  ]
  for (const red of REDS) {
    const built = red.build()
    try {
      const measured = await measureDriver(built.driverSrc)
      const results = runLints(built.driverSrc, built.brief, measured, built.opts || {})
      check(results[red.lint].level === red.level, `red:${red.lint}`,
        `expected ${red.level}, got ${results[red.lint].level} (${results[red.lint].reason})`)
      for (const [lint, r] of Object.entries(results)) {
        if (lint === red.lint) continue
        check(r.level === 'pass', `red:${red.lint}:other:${lint}`,
          `expected pass, got ${r.level} (${r.reason}) — a fixture that trips two lints is broken`)
      }
    } finally {
      if (built.cleanup) built.cleanup()
    }
  }

  console.log(failures ? `\n${failures} self-test failure(s)` : '\nall self-tests passed')
  process.exit(failures ? 1 : 0)
}

// ---- CLI ----------------------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2)
  const jsonFlag = args.includes('--json')
  const positional = args.filter(a => a !== '--json')

  if (positional.length === 0) {
    await selfTest()
    return
  }

  const [driverPath, briefPath] = positional
  if (!driverPath || !briefPath) {
    console.error('ERROR: usage: lint_design.mjs <driver.js> <BRIEF.md> [--json]')
    process.exit(2)
  }

  let driverSrc, brief
  try { driverSrc = readFileSync(driverPath, 'utf8') }
  catch (e) { console.error(`ERROR: cannot read driver at ${driverPath}: ${e.message}`); process.exit(2) }
  try { brief = readFileSync(briefPath, 'utf8') }
  catch (e) { console.error(`ERROR: cannot read BRIEF at ${briefPath}: ${e.message}`); process.exit(2) }

  const measured = await measureDriver(driverSrc)
  const opts = { briefDir: dirname(resolve(briefPath)) }
  const results = runLints(driverSrc, brief, measured, opts)

  let hard = 0, warn = 0
  for (const [name, r] of Object.entries(results)) {
    console.log(`${name}  ${r.level.toUpperCase()}  ${r.reason}`)
    if (r.level === 'fail') hard++
    if (r.level === 'warn') warn++
  }
  if (jsonFlag) {
    const lints = {}
    for (const [name, r] of Object.entries(results)) lints[name] = r.level
    console.log(JSON.stringify({ hard_failures: hard, warnings: warn, lints }))
  }
  process.exit(hard > 0 ? 1 : 0)
}

main()
