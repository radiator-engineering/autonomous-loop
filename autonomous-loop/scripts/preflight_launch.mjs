#!/usr/bin/env node
// Preflight — the launch gate. NOTHING launches until this exits 0.
//
// Why this exists, stated plainly so nobody deletes it as ceremony: every guarantee in this skill
// lived in prose, and prose is advice. A run can satisfy the whole kernel — worker≠verifier,
// counted atoms, fail-closed verdicts, the witness gate — and still show a human nothing, because
// the operator wrote their own driver script and never touched the template at all. That is not a
// hypothetical: it is the recorded failure that motivated this file. The loops were hand-rolled
// Workflow scripts. They wrote no progress.json, launched no workbench, filled no hero slot, and
// the skill's Step 5 ("stand up observability, give the user the URL") could not stop them,
// because a step is something you can skip and a gate is not.
//
// So the six things the skill PROMISES are checked here as facts on disk, in the source, and on
// the wire:
//
//   BRIEF     the run was elicited from a human, not assumed — the intake questions are answered
//   DESCENT   the driver IS the kernel, byte-for-byte, not a script that resembles it — and the two
//             paths the kernel writes through (LEDGER, HANDOFF) are still derived from LEDGER_DIR,
//             which no region hash can cover because Config sits above every region
//   FILLED    no <<PLACEHOLDER>> survived into a runnable driver
//   PARSES    the driver compiles, and every name it reads is a name something defines
//   DRYRUN    the driver RUNS — against a mocked runtime, so the names PARSES cannot scope-check
//             are resolved by V8 instead, for no tokens and no side effects
//   LIVE      a workbench is serving THIS ledger dir right now, proven by fetching from it
//
// Usage:
//   node scripts/preflight_launch.mjs <driver.js> <ledger-dir> [--workbench http://127.0.0.1:8787]
//
// Exits 0 and writes <ledger-dir>/PREFLIGHT.json on success; exits 1 naming every failure. It
// fails closed, like every other verdict in this skill: an unreadable file, an unreachable server
// or an unparseable region is a FAIL, never a skip.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

const SKILL = dirname(dirname(fileURLToPath(import.meta.url)))
const TEMPLATE = join(SKILL, 'assets', 'loop-template.js')
const SELFCHECK = join(SKILL, 'scripts', 'selfcheck_loops.mjs')

// The regions that ARE the kernel. Everything archetype-specific lives outside them, so a filled
// driver may freely edit Config and delete the four MODES blocks it did not pick — and these four
// regions must still hash identically to the template's. Marker lines are matched by prefix.
//
// `schemas` covers the knob check and every schema between it and MODES, and it is here because the
// kernel's guarantees are not all written in the kernel. The closed enums the counters are BUILT from
// live there — SEVERITIES, FINDINGS and the criterion statuses are read out of those schemas, and
// `fromVerdict` narrows a verdict to exactly the keys they declare. A filled driver that widened
// VERDICT_SCHEMA, or deleted `additionalProperties: false`, or dropped the knob check that refuses
// DRY_ROUNDS = 0, would have passed a three-region DESCENT with the kernel byte-identical and every
// guarantee that kernel makes disarmed one screen above it. Nothing in this span is a knob: TIER, the
// one thing a run is meant to tune, was moved up into Config so this region could close.
const REGIONS = [
  ['schemas', '// ---- Knob check', '// ---- MODES'],
  ['kernel', '// ---- Kernel', '// ---- Terminal status'],
  ['terminal-status', '// ---- Terminal status', '// ---- shared helpers'],
  ['shared-helpers', '// ---- shared helpers', null], // null ⇒ to end of file
]

// The intake. Each heading is a question the skill must have ASKED, not guessed. The gate is
// presence of the heading plus a non-empty answer under it — it cannot judge whether the answer is
// good, only that a human was given the chance to give one.
const BRIEF_SECTIONS = [
  'Destination',        // what reaching the end looks like, in the user's own words
  'Archetype',          // which of the five, and why the two knobs point there
  'Atom',               // the unit counted, and how a SEPARATE agent passes it
  'Stop',               // the terminal predicate, as a predicate — not a round count
  'Evidence',           // what the user will SEE each round: the hero slot's contract
  'Autonomy',           // checkpointed | autonomous, and the budget ceiling
]

const args = process.argv.slice(2)
const flagIx = args.indexOf('--workbench')
const workbench = flagIx >= 0 ? args[flagIx + 1] : 'http://127.0.0.1:8787'
const positional = flagIx < 0 ? args : args.filter((a, i) => i !== flagIx && i !== flagIx + 1)
if (positional.length < 2) {
  console.error('usage: preflight_launch.mjs <driver.js> <ledger-dir> [--workbench URL]')
  process.exit(2)
}
const driverPath = resolve(positional[0])
const ledgerDir = resolve(positional[1])

const fails = []
const notes = []
const fail = (gate, msg) => fails.push(`${gate}: ${msg}`)

// ---- normalise + hash a marker-delimited region ------------------------------------------
// Trailing whitespace and blank lines are noise; comment TEXT is not — the invariants are written
// in the comments, so a driver that strips them has stripped the reasoning that makes the code
// reviewable, and that counts as divergence.
function region(src, startPrefix, endPrefix, label, where) {
  const lines = src.split('\n')
  const a = lines.findIndex(l => l.startsWith(startPrefix))
  if (a < 0) return { err: `region '${label}' not found in ${where} (missing marker '${startPrefix}')` }
  const rest = lines.slice(a + 1)
  const rel = endPrefix === null ? rest.length : rest.findIndex(l => l.startsWith(endPrefix))
  if (rel < 0) return { err: `region '${label}' unterminated in ${where} (missing marker '${endPrefix}')` }
  const body = rest.slice(0, rel).map(l => l.replace(/\s+$/, '')).filter(l => l.length > 0)
  if (body.length === 0) return { err: `region '${label}' is empty in ${where}` }
  return { hash: createHash('sha256').update(body.join('\n')).digest('hex').slice(0, 16), lines: body.length }
}

// ---- free names: identifiers the driver reads that nothing in it binds ---------------------
// Everything a driver may legitimately reach for without declaring it: the Workflow runtime's own
// surface, and the language's. A name outside this set and bound nowhere in the file is a
// ReferenceError waiting for its line to run. Keep this list conservative — a missing entry here
// reads as a defect in the driver, which is the wrong direction for a gate to be wrong in.
const AMBIENT = new Set([
  // the Workflow runtime hands these to every script; see the Workflow tool's script contract
  'agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow',
  // language + host builtins
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON', 'Date',
  'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Proxy', 'Reflect', 'Error', 'TypeError',
  'RangeError', 'SyntaxError', 'ReferenceError', 'Infinity', 'NaN', 'undefined', 'globalThis',
  'console', 'structuredClone', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'Intl',
  'encodeURIComponent', 'decodeURIComponent', 'AbortSignal', 'fetch', 'URL',
  // keywords and contextual keywords, which the identifier pattern below cannot tell from names
  'null', 'true', 'false', 'this', 'arguments', 'new', 'typeof', 'void', 'delete', 'in', 'of',
  'instanceof', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break',
  'continue', 'throw', 'try', 'catch', 'finally', 'function', 'class', 'const', 'let', 'var',
  'await', 'async', 'yield', 'export', 'import', 'extends', 'super', 'get', 'set', 'static',
  'from', 'as', 'with', 'debugger',
])

const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*'

// Reduce source to the parts that are CODE. Comments go; the text of string literals goes; but the
// interior of every `${...}` stays and is reduced the same way, because this driver is mostly prompt
// templates and a name that only ever appears inside one is still a name the run will read.
function codeOnly(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue }
    if (c === '/') {
      // Regex literal, or division? Decide by what came before: after a value `/` divides, after an
      // operator or a keyword it opens a regex. Getting this wrong turns a flag letter into a bare
      // identifier — `/\s+/g` reported `g` as an unbound name until this branch existed.
      const prev = out.replace(/\s+$/, '').slice(-1)
      const prevWord = (out.match(new RegExp(`(${IDENT})\\s*$`)) || [])[1]
      const opens = prev === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prev) ||
        ['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await'].includes(prevWord)
      if (opens) {
        i++
        let inClass = false
        while (i < n) {
          if (src[i] === '\\') { i += 2; continue }
          if (src[i] === '[') inClass = true
          else if (src[i] === ']') inClass = false
          else if (src[i] === '/' && !inClass) { i++; break }
          else if (src[i] === '\n') break
          i++
        }
        while (i < n && /[a-z]/.test(src[i])) i++      // flags
        out += ' "" '; continue
      }
    }
    if (c === "'" || c === '"') {
      const q = c; i++
      while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++ }
      i++; out += ' "" '; continue
    }
    if (c === '`') {
      i++
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '`') { i++; break }
        if (src[i] === '$' && src[i + 1] === '{') {
          i += 2
          const start = i
          let depth = 1
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++
            else if (src[i] === '}') depth--
            else if (src[i] === '`') { i++; while (i < n && src[i] !== '`') { if (src[i] === '\\') i++; i++ } }
            i++
          }
          out += ' ( ' + codeOnly(src.slice(start, i - 1)) + ' ) '
          continue
        }
        i++
      }
      out += ' "" '; continue
    }
    out += c; i++
  }
  return out
}

// Every name the file BINDS anywhere, by any means. Generous on purpose: this set is subtracted from
// the used names, so over-collecting here costs coverage while under-collecting invents failures.
function boundNames(code) {
  const bound = new Set()
  const addAll = (s) => { for (const m of s.matchAll(new RegExp(IDENT, 'g'))) bound.add(m[0]) }

  // const/let/var: everything up to the initialiser or the end of the statement, so destructuring
  // patterns (`const { a, b } = x`, `const [x] = y`) are collected whole.
  for (const m of code.matchAll(/\b(?:const|let|var)\s+/g)) {
    let i = m.index + m[0].length, depth = 0, buf = ''
    while (i < code.length) {
      const c = code[i]
      if ('([{'.includes(c)) depth++
      else if (')]}'.includes(c)) { if (depth === 0) break; depth-- }
      else if (depth === 0 && ((c === '=' && code[i + 1] !== '=') || c === ';' || c === '\n')) break
      buf += c; i++
    }
    addAll(buf)
  }
  for (const m of code.matchAll(new RegExp(`\\bfunction\\s*\\*?\\s*(${IDENT})?\\s*\\(([^)]*)\\)`, 'g'))) {
    if (m[1]) bound.add(m[1]); addAll(m[2] || '')
  }
  for (const m of code.matchAll(new RegExp(`\\bclass\\s+(${IDENT})`, 'g'))) bound.add(m[1])
  for (const m of code.matchAll(new RegExp(`\\bcatch\\s*\\(\\s*(${IDENT})`, 'g'))) bound.add(m[1])
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) addAll(m[1])            // (a, b) =>
  for (const m of code.matchAll(new RegExp(`(${IDENT})\\s*=>`, 'g'))) bound.add(m[1])   // x =>
  for (const m of code.matchAll(new RegExp(`(${IDENT})\\s*\\(([^()]*)\\)\\s*\\{`, 'g'))) {
    bound.add(m[1]); addAll(m[2])                                             // method shorthand
  }
  return bound
}

function freeNames(src) {
  const code = codeOnly(src)
  const bound = boundNames(code)
  const free = new Set()
  for (const m of code.matchAll(new RegExp(`(\\.\\s*)?\\b(${IDENT})\\b(\\s*:)?`, 'g'))) {
    if (m[1]) continue                                   // property access: obj.name
    if (m[3]) continue                                   // object key, or a label
    const name = m[2]
    if (!bound.has(name) && !AMBIENT.has(name)) free.add(name)
  }
  return [...free].sort()
}

// ---- the dry run's mocked harness ----------------------------------------------------------
// Enough of a fake Workflow runtime to make a driver of ANY archetype execute its own code, with
// every `agent()` answered from a table instead of a model. Shapes are the ones the template's own
// schemas declare, so the happy path of each MODES block runs rather than bailing at the first read.
//
// This is deliberately NOT selfcheck_loops.mjs's harness. That one proves the kernel's INVARIANTS and
// needs the fixtures, expectations and 100-odd scenarios to do it; this one asks a single much smaller
// question — does this file, as filled, execute — and answering it must not drag a second suite into
// the launch path. The two are allowed to differ because they are checking different things: that one
// is about what the kernel decides, this one is about whether this driver can run at all.
function dryHarness(cap) {
  let calls = 0
  let rounds = 0
  const agent = async (prompt, opts = {}) => {
    if (++calls > cap) throw new DryRunCap()
    const label = opts.label || ''
    if (label === 'enumerate')          return { items: [{ id: 'dry1', task: 't' }, { id: 'dry2', task: 't' }] }
    if (label === 'charter')            return { subquestions: [{ id: 'q1', question: 'q' }, { id: 'q2', question: 'q' }] }
    if (label.startsWith('critique:'))  return { total: 2, criteria: [{ id: 'r1', region: 'r1', status: 'pass', fix: 'f' },
                                                                     { id: 'r2', region: 'r2', status: 'pass', fix: 'f' }] }
    if (label.startsWith('find:'))      return { candidates: [{ where: 'dry.js:1', claim: 'c' }] }
    if (label === 'hypothesize')        return { experiments: [{ id: 'e1', subq: 'q1', hypothesis: 'h', method: 'm' }] }
    if (label === 'poll')               return { violations: [] }
    if (label.startsWith('work:'))      return 'done'
    if (label.startsWith('verify:'))    return { id: label.slice(7), pass: true, evidence: 'dry run' }
    if (label === 'ledger')             { rounds++; return { hero: 'artifact', handoff: 'written' } }
    if (label === 'audit')              return { hero: 'artifact', handoff: 'complete', handoffRound: rounds, captures: 1 }
    if (label === 'finalize')           return { finalized: true }
    return 'ok'
  }
  return {
    rt: {
      agent,
      parallel: async (thunks) => Promise.all(thunks.map(t => Promise.resolve().then(t).catch(() => null))),
      pipeline: async () => { throw new Error('pipeline not used by the template') },
      log: () => {}, phase: () => {},
      budget: { total: null, spent: () => 0, remaining: () => Infinity },
      args: undefined,
    },
    stats: () => ({ calls, rounds }),
  }
}
class DryRunCap extends Error {}

// ---- SELFCHECK: the stop logic is code, so it is tested as code ---------------------------
try {
  execFileSync(process.execPath, [SELFCHECK], { stdio: 'pipe' })
  notes.push('selfcheck: GREEN')
} catch (e) {
  fail('SELFCHECK', `scripts/selfcheck_loops.mjs exited ${e.status ?? '?'} — the kernel's own invariants do not hold; fix that before any run`)
}

// ---- DESCENT + FILLED ---------------------------------------------------------------------
let driverSrc = null
try {
  driverSrc = readFileSync(driverPath, 'utf8')
} catch {
  fail('DESCENT', `cannot read driver ${driverPath}`)
}
if (driverSrc !== null) {
  let templateSrc = null
  try { templateSrc = readFileSync(TEMPLATE, 'utf8') } catch { fail('DESCENT', `cannot read template ${TEMPLATE}`) }

  if (templateSrc !== null) {
    for (const [label, start, end] of REGIONS) {
      const want = region(templateSrc, start, end, label, 'the template')
      const got = region(driverSrc, start, end, label, 'the driver')
      if (want.err) { fail('DESCENT', want.err + ' — the template itself is damaged'); continue }
      if (got.err) {
        fail('DESCENT', got.err + '. A driver that does not carry the kernel carries none of its ' +
          'guarantees: no counted atoms, no fail-closed verdicts, no witness gate. Start from ' +
          'assets/loop-template.js and fill it — do not write your own driver.')
        continue
      }
      if (want.hash !== got.hash) {
        fail('DESCENT', `region '${label}' diverges from the template (template ${want.hash}/${want.lines} lines, ` +
          `driver ${got.hash}/${got.lines} lines). The kernel is identical for every archetype; only Config and ` +
          `the MODES block you picked are yours to edit. If the kernel genuinely needs a change, change it in ` +
          `the template, re-run selfcheck, and re-run this.`)
      }
    }
  }

  // ---- the pickup document's PATH ---------------------------------------------------------
  // `const HANDOFF` lives in Config, ABOVE every hashed region, so no region hash covers it and a
  // filled driver could point the pickup document anywhere it liked — /tmp, another run's ledger, a
  // file the workbench does not serve — and this gate still exited GREEN. Downstream that is not a
  // cosmetic defect: the documentation rung latches on a HANDOFF.md that the terminal audit reads out
  // of LEDGER_DIR, so a driver pointing HANDOFF elsewhere satisfies the gate against one file while
  // the run's own directory keeps none. It must be DERIVED from LEDGER_DIR, exactly as LEDGER is —
  // which is also why neither carries a fill marker.
  //
  // Compared against the template's own line rather than a pattern typed here, so the two cannot
  // drift: whatever the template says the derivation is, the driver must say the same. Trailing
  // comments and whitespace are stripped; quotes are respected, so a `//` inside the path is not
  // mistaken for the start of a comment.
  const codeOf = (line) => {
    let q = null
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (q) { if (c === '\\') i++; else if (c === q) q = null }
      else if (c === "'" || c === '"' || c === '`') q = c
      else if (c === '/' && line[i + 1] === '/') return line.slice(0, i).replace(/\s+$/, '')
    }
    return line.replace(/\s+$/, '')
  }
  const handoffLine = (src) => {
    const l = src.split('\n').find(x => x.startsWith('const HANDOFF ='))
    return l === undefined ? null : codeOf(l)
  }
  if (templateSrc !== null) {
    const wantH = handoffLine(templateSrc)
    const gotH = handoffLine(driverSrc)
    if (wantH === null) fail('DESCENT', `no 'const HANDOFF =' line in the template — the template itself is damaged`)
    else if (gotH === null) {
      fail('DESCENT', `the driver has no 'const HANDOFF =' line. The pickup document is what a fresh ` +
        `agent reads when this run dies mid-flight; without it the run has no handoff to fail to write.`)
    } else if (gotH !== wantH) {
      fail('DESCENT', `the driver defines HANDOFF as \`${gotH}\`, not \`${wantH}\`. It must be DERIVED from ` +
        `LEDGER_DIR exactly as LEDGER is: a handoff written outside the ledger dir is not served by the ` +
        `workbench, is not where the next agent looks, and is not what the terminal audit reads — the ` +
        `run would pass its documentation gate against a file nobody will ever find.`)
    }
  }

  const placeholders = [...new Set((driverSrc.match(/<<[A-Z_]+>>/g) || []))]
  if (placeholders.length > 0) {
    fail('FILLED', `unfilled placeholders remain: ${placeholders.join(', ')}. Each is a knob the run ` +
      `divides on; an unfilled one either crashes at startup or, worse, reads as a number and disarms a predicate.`)
  }

  // ---- PARSES: the driver runs for a second before it runs for a day ------------------------
  // MEASURED: a driver passed all five gates above and then died 24 ms into round 1 on
  // `question is not defined`. Every gate here had been honest — the kernel was byte-identical, the
  // brief was answered, the workbench was live — and none of them had opened the file as CODE. The
  // operator got a green launch gate, a workbench URL, and a run that was over before they finished
  // reading the URL. Four hours of budget were reserved for a script that could never execute one line.
  //
  // NOT `node --check`, which is the obvious thing and does not work: the driver opens with
  // `export const meta`, and given module syntax Node's checker takes a path that returned exit 0 on
  // a driver with a deliberate unbalanced paren in Config. Measured, which is why this compiles the
  // source itself instead. Compiling is not running — the AsyncFunction constructor parses the body
  // and hands back a function nobody calls, so no agent is spawned and no token is spent.
  const stripExport = (s) => s.replace(/^export\s+(?=(?:const|let|var|function|class|async|\{))/gm, '')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  let compiles = false
  try {
    new AsyncFunction(stripExport(driverSrc))
    compiles = true
  } catch (e) {
    fail('PARSES', `the driver does not compile: ${e.message}. It would die in the first milliseconds ` +
      `of round 1, after this gate had already told the operator the run was good to launch.`)
  }

  // The other half, and the one that catches the recorded failure: a name the driver READS that
  // nothing in the driver DEFINES. Compiling cannot see it — an unbound identifier is legal source
  // and a ReferenceError at the moment of use — and "the moment of use" is routinely inside a prompt
  // template, which means round 1, which means the whole run. The commonest way to produce one is a
  // fill marker replaced with a bare word instead of a quoted string: `<<TARGET>>` filled as
  // `question` rather than `'question'` reads as an identifier and passes FILLED cleanly.
  //
  // The claim is deliberately narrow, so it can be made without a JS parser and still be trusted: a
  // name is reported only if it is used somewhere and bound NOWHERE in the whole file. That misses a
  // name bound in one scope and read in another — a real defect this gate does not catch, stated
  // plainly rather than implied away — and in exchange it does not invent failures, which matters
  // more: a launch gate that cries wolf gets deleted. Measured at zero reports against the filled
  // template, against a driver with the export stripped, against a hand-rolled script, and against
  // this project's own board driver; and at one report for the bare-word fill in Config, the same
  // name inside a `${...}` prompt interpolation, and a call to an undefined helper.
  if (compiles) {
    const unknown = freeNames(driverSrc)
    if (unknown.length > 0) {
      fail('PARSES', `the driver reads ${unknown.length === 1 ? 'a name' : 'names'} nothing defines: ` +
        `${unknown.join(', ')}. Either it is a typo, or a fill marker was replaced with a bare word ` +
        `where a quoted string was meant (\`const TARGET = question\`, not \`const TARGET = 'question'\`). ` +
        `Reading it throws ReferenceError at the moment the line runs — usually inside a round-1 prompt.`)
    }
  }

  // ---- DRYRUN: execute the driver, with every agent answered from a table --------------------
  // PARSES's scan reads the file and is blind to SCOPE: a name bound in one function and read in
  // another is bound *somewhere*, so the scan clears it and the run still throws. Closing that
  // statically needs a real JS parser, and this skill ships no dependencies. So close it dynamically
  // instead — V8 resolves names for real, and it does it for free: the driver runs here against a
  // mocked runtime, spending no tokens and touching no filesystem, exactly as selfcheck_loops.mjs
  // runs the template. Anything that would throw on an executed path throws HERE, before launch.
  //
  // ONLY a ReferenceError fails this gate, and the narrowness is the point. Mock data cannot
  // manufacture "x is not defined" — a bad shape produces a TypeError, and TypeErrors here may well
  // be this harness failing to match a MODES block the operator wrote rather than a defect in it.
  // Failing on those would make the gate fire on its own limitations, and a launch gate that cries
  // wolf gets deleted. TDZ errors ("cannot access before initialization") are ReferenceErrors too,
  // and they are real defects, so they fail correctly.
  //
  // KNOWN LIMIT, stated rather than implied: this covers the paths the mock REACHES. A name read only
  // inside, say, a blocker-escalation branch is not exercised, and the scan above does not see scope,
  // so between them there is a small hole neither closes. It is smaller than either alone.
  if (compiles) {
    const CAP = 400   // a driver that has not finished by here has executed plenty; see below
    const { rt, stats } = dryHarness(CAP)
    const run = new AsyncFunction('agent', 'parallel', 'pipeline', 'log', 'phase', 'budget', 'args',
      stripExport(driverSrc))
    try {
      await run(rt.agent, rt.parallel, rt.pipeline, rt.log, rt.phase, rt.budget, rt.args)
      notes.push(`dry run: completed, ${stats().calls} mocked agent call(s) over ${stats().rounds} round(s)`)
    } catch (e) {
      if (e instanceof ReferenceError) {
        fail('DRYRUN', `the driver threw ReferenceError while running: ${e.message}. This is a name the ` +
          `file does define somewhere but cannot see from where it is read — PARSES's scan is not ` +
          `scope-aware, which is exactly why the driver is also RUN here. It would throw the same way ` +
          `on the real run, at whatever hour that line was first reached.`)
      } else if (e instanceof DryRunCap) {
        // Not a failure. The cap exists so an unbounded driver cannot spin this gate forever, and by
        // the time it fires the driver has executed hundreds of calls — which is the coverage this
        // gate was after. Say what was and was not established rather than reporting a clean pass.
        notes.push(`dry run: no ReferenceError in ${CAP} mocked agent calls (stopped at the cap, not at ` +
          `the driver's own terminal predicate — that predicate is proven separately by SELFCHECK)`)
      } else {
        notes.push(`dry run: reached ${stats().calls} mocked agent call(s), then ${e.constructor.name}: ` +
          `${e.message}. NOT counted as a failure — the mock cannot know your MODES block's contract, ` +
          `so this is as likely to be the mock's shape as your driver's defect. Worth a look.`)
      }
    }
  }
}

// ---- BRIEF: proof the run was elicited, not assumed ---------------------------------------
const briefPath = join(ledgerDir, 'BRIEF.md')
if (!existsSync(briefPath)) {
  fail('BRIEF', `${briefPath} does not exist. The brief is the record that a human was asked what ` +
    `this run is for, what counts as done, and what they want to SEE — see SKILL.md Step 0 "Intake". ` +
    `A loop configured from assumptions is a loop that converges on the wrong thing, confidently.`)
} else {
  const brief = readFileSync(briefPath, 'utf8')
  // Sections are '## <name>' possibly with trailing words ('## Atom + verify contract').
  const heads = [...brief.matchAll(/^##\s+(.+)$/gm)].map(m => [m[1].trim(), m.index])
  for (const want of BRIEF_SECTIONS) {
    const hit = heads.find(([h]) => h.toLowerCase().startsWith(want.toLowerCase()))
    if (!hit) { fail('BRIEF', `no '## ${want}' section in BRIEF.md`); continue }
    const after = brief.slice(hit[1]).split('\n').slice(1)
    const nextHead = after.findIndex(l => /^##\s/.test(l))
    const body = (nextHead < 0 ? after : after.slice(0, nextHead)).join('\n').trim()
    if (body.length < 20) fail('BRIEF', `'## ${want}' is empty or a stub — answer it or say explicitly why it does not apply`)
  }
}

// ---- LIVE: a workbench is serving THIS dir, right now --------------------------------------
// Identity by NONCE, not by comparison. The obvious check — fetch progress.json and diff it against
// the one on disk — passes against any other run's server, because the workbench SEEDS every ledger
// with byte-identical starting content. Two directories therefore look the same at exactly the
// moment preflight runs, and a server pointed at last week's run reads as live. Measured: that
// version of this check returned GREEN against a deliberately wrong directory. So write a fresh
// value here and require the server to hand it back; only the server on THIS directory can.
const localProgress = join(ledgerDir, 'progress.json')
if (!existsSync(localProgress)) {
  fail('LIVE', `${localProgress} does not exist. Start the workbench first — it seeds the ledger and ` +
    `the hero slot: python3 scripts/workbench_server.py ${ledgerDir}`)
} else {
  const nonce = randomUUID()
  const noncePath = join(ledgerDir, 'preflight-nonce.txt')
  writeFileSync(noncePath, nonce)
  try {
    const res = await fetch(new URL('/preflight-nonce.txt', workbench), { signal: AbortSignal.timeout(4000) })
    // A 404 is the wrong-directory case, not the unreachable one: something answered, it just does
    // not have the file this preflight wrote a moment ago. Say which, or the operator restarts a
    // server that was never down.
    if (res.status === 404) {
      fail('LIVE', `the workbench at ${workbench} answers, but is serving a DIFFERENT directory than ` +
        `${ledgerDir} — it is pointed at another run. Restart it on this ledger dir.`)
    } else if (!res.ok) throw new Error(`HTTP ${res.status} for /preflight-nonce.txt`)
    else if ((await res.text()).trim() !== nonce) {
      fail('LIVE', `the workbench at ${workbench} is serving a DIFFERENT directory than ${ledgerDir} — ` +
        `it is pointed at another run. The user would watch a board that never moves.`)
    } else {
      const idx = await fetch(new URL('/index.html', workbench), { signal: AbortSignal.timeout(4000) })
      if (!idx.ok) fail('LIVE', `${workbench}/index.html returned HTTP ${idx.status} — the dashboard is not being served`)
      else notes.push(`workbench: LIVE at ${workbench} on ${ledgerDir} (nonce confirmed)`)
    }
  } catch (e) {
    fail('LIVE', `no workbench answering at ${workbench} (${e.message}). Start it and pass its URL: ` +
      `python3 scripts/workbench_server.py ${ledgerDir} --port <PORT>. The URL goes to the user BEFORE the run.`)
  }
}

// ---- verdict -------------------------------------------------------------------------------
const ok = fails.length === 0
for (const n of notes) console.log(`  ok    ${n}`)
for (const f of fails) console.log(`  FAIL  ${f}`)
if (ok) {
  const receipt = {
    ok: true,
    driver: driverPath,
    ledgerDir,
    workbench,
    gates: ['SELFCHECK', 'DESCENT', 'FILLED', 'PARSES', 'DRYRUN', 'BRIEF', 'LIVE'],
    // No timestamp: this file is a record of WHAT passed, and the run's own ledger carries when.
  }
  writeFileSync(join(ledgerDir, 'PREFLIGHT.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(`\npreflight: GREEN — receipt at ${join(ledgerDir, 'PREFLIGHT.json')}`)
  process.exit(0)
}
console.log(`\npreflight: ${fails.length} gate failure(s). Nothing launches until these are green.`)
process.exit(1)
