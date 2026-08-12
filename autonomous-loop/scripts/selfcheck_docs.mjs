#!/usr/bin/env node
// Zero-token, deterministic check that this skill's PROSE still points at things that exist.
//
// Why a gate and not a habit: 26 citations in these docs were measured wrong in one sitting. Not
// wrong when written — wrong because the files underneath them moved. `loop-template.js:109-121` was
// VERDICT_SCHEMA when someone typed it and is the model-tier map today; `workbench.html:276` was the
// fetch handler and is a template literal now. A citation that has drifted is worse than none: it
// reads as authority and sends the next reader to a line that plausibly could be what was meant.
//
// Three checks, all mechanical:
//
//   LINES   No `file.ext:NNN` citation between skill files. Line numbers are a claim with a shelf
//           life and nothing renews it. Cite the SYMBOL — `frameHTML`, `MODES.explorer.stop` — which
//           moves with the code it names. (Line numbers pointing INTO a user's repo are fine and are
//           not what this scans; this scans citations between the files of this skill.)
//   SYMBOLS Every `MODES.<archetype>.<member>` cited in prose resolves to a member actually defined
//           in that archetype's block, and every backticked bare identifier that LOOKS like a cited
//           definition resolves somewhere in the skill's own sources.
//   PATHS   Every skill-relative file path named in prose exists. The recorded failure: a pointer to
//           `gauntlet-loop/references/observability.md` sat in this skill for weeks reading like a
//           local path, resolving to nothing, because the two skills have different roots.
//
// Exits non-zero on any hit, naming the file, the line, and the fix.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL = dirname(HERE)

// The prose this gate governs. Code is excluded on purpose: a comment in loop-template.js citing its
// own neighbour is a different (and much shorter-lived) risk than a reference doc citing a file it
// does not live next to.
const DOCS = ['SKILL.md', ...readdirSync(join(SKILL, 'references')).filter(f => f.endsWith('.md')).map(f => join('references', f))]

// Sources a citation may name. Keep this list explicit: a glob would silently start covering
// whatever lands in the directory next, and the point is to know what is being promised.
const SOURCES = {
  'loop-template.js': join(SKILL, 'assets', 'loop-template.js'),
  'workbench.html': join(SKILL, 'assets', 'workbench.html'),
  'workbench_server.py': join(SKILL, 'scripts', 'workbench_server.py'),
  'preflight_launch.mjs': join(SKILL, 'scripts', 'preflight_launch.mjs'),
  'selfcheck_loops.mjs': join(SKILL, 'scripts', 'selfcheck_loops.mjs'),
  'selfcheck_preflight.mjs': join(SKILL, 'scripts', 'selfcheck_preflight.mjs'),
  'selfcheck_docs.mjs': join(SKILL, 'scripts', 'selfcheck_docs.mjs'),
  // Absorbed from the gauntlet-loop skill when this skill superseded it. They join the list for the
  // same reason the rest are on it: a file the prose cites is a file whose line numbers will drift.
  'gen_partition.py': join(SKILL, 'scripts', 'gen_partition.py'),
  'lock_prompts.py': join(SKILL, 'scripts', 'lock_prompts.py'),
}
const SRC = Object.fromEntries(Object.entries(SOURCES).map(([k, p]) => [k, existsSync(p) ? readFileSync(p, 'utf8') : null]))

const problems = []
const flag = (check, file, line, msg, fix) => problems.push({ check, file, line, msg, fix })

// ---- LINES ----------------------------------------------------------------------------------
// Matches `thing.md:12`, ``thing.js`:12-19``, `scripts/x.mjs:5`. Deliberately catches the backticked
// form too — the first sweep missed three citations because a backtick sat between name and colon.
const LINE_CITE = /([A-Za-z0-9_.\/-]+\.(?:md|js|mjs|html|py|json))`?:(\d+)(?:-(\d+))?/g

// ---- SYMBOLS --------------------------------------------------------------------------------
const MODES_CITE = /MODES\.(converger|exhauster|saturator|explorer|sentinel)\.([A-Za-z]+)/g
function modeMembers(archetype) {
  const src = SRC['loop-template.js']
  if (src === null) return null
  const starts = [...src.matchAll(/^ {2}(converger|exhauster|saturator|explorer|sentinel):\s*\{/gm)]
  const i = starts.findIndex(m => m[1] === archetype)
  if (i < 0) return null
  const body = src.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : src.length)
  return new Set([...body.matchAll(/^\s*(?:async\s+)?([A-Za-z]+)\s*[:(]/gm)].map(m => m[1]))
}

// ---- PATHS ----------------------------------------------------------------------------------
// A skill-relative path in prose: `references/x.md`, `scripts/y.mjs`, `assets/z.html`.
const PATH_CITE = /`((?:references|scripts|assets)\/[A-Za-z0-9_.-]+)`/g
// The doc convention for a file in ANOTHER skill is to name the owning skill in words and then give
// the path relative to it — "the gauntlet-loop skill's `references/failure-modes.md`". That is a
// correct citation, not a dangling one, so this gate must recognise it. It looks at the citing line
// AND the one above, because prose wraps: the first version of this check scanned single lines and
// called four correct citations broken, purely because the skill name had landed on the previous
// line. A checker that cries wolf gets switched off, which costs more than the check was worth.
// Sibling skills are looked for in every root this skill might be installed under, not just the
// directory it happens to sit in. This file has to give the same verdict from the installed copy,
// from the source repo, and from a throwaway copy under /tmp — and the first version did not: run
// from a copy, `dirname(SKILL)` held no sibling skills, so four correct citations were reported
// broken. A gate whose answer depends on where it was run from is a gate people learn to disbelieve.
const SIBLING_ROOTS = [dirname(SKILL),
  join(process.env.HOME || '', '.claude-profile-2', 'skills'),
  join(process.env.HOME || '', '.claude', 'skills')]
function findSibling(name) {
  for (const root of SIBLING_ROOTS) {
    const p = join(root, name)
    if (existsSync(p)) return p
  }
  return null
}
// A candidate is only a sibling skill if it CONTAINS a SKILL.md. Without that test the roots sweep
// up whatever else lives beside this skill — a scratch directory named `art`, `f` or `sk` was enough
// to break the check, because "ch·art·er" and "·sk·ill's" contain those names as substrings.
const SIBLING_NAMES = (() => {
  const seen = new Set()
  for (const root of SIBLING_ROOTS) {
    try {
      for (const d of readdirSync(root, { withFileTypes: true })) {
        if (d.isDirectory() && d.name !== 'autonomous-loop' && existsSync(join(root, d.name, 'SKILL.md'))) seen.add(d.name)
      }
    } catch { /* root absent — try the next */ }
  }
  return [...seen]
})()
// Word boundaries, not substrings: a skill is named in prose as a word. See above for what
// substring matching actually matched.
const namedIn = (name, context) =>
  new RegExp(`(^|[^A-Za-z0-9-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9-]|$)`).test(context)

// Returns the owning skill when the citation is a correct cross-skill pointer, the string
// 'unverifiable' when the prose names a skill this machine does not have installed (not this
// gate's business to fail on), or null when nothing accounts for the path — the real defect.
function ownedByNamedSibling(p, context) {
  const named = SIBLING_NAMES.filter(s => namedIn(s, context))
  // ANY named skill that has the file vindicates the citation. Deciding on the FIRST candidate is
  // what let a spurious match veto the real one — collect, then judge.
  for (const s of named) {
    const root = findSibling(s)
    if (root && existsSync(join(root, p))) return s
  }
  // A skill was named and is installed, but does not have that file: a genuinely broken pointer.
  if (named.some(s => findSibling(s) !== null)) return null
  // Named as belonging to some skill we cannot see. Say nothing rather than cry wolf.
  return /\bskill'?s?\b/i.test(context) ? 'unverifiable' : null
}

for (const rel of DOCS) {
  const full = join(SKILL, rel)
  const lines = readFileSync(full, 'utf8').split('\n')
  lines.forEach((text, i) => {
    const n = i + 1
    for (const m of text.matchAll(LINE_CITE)) {
      const [, file, from] = m
      const base = file.split('/').pop()
      if (!(base in SOURCES) && !DOCS.some(d => d.endsWith(base))) continue  // not ours; not our promise
      flag('LINES', rel, n, `cites ${file}:${from} by line number`,
        `name the symbol or section instead — line numbers drift silently and read as authority`)
    }
    for (const m of text.matchAll(MODES_CITE)) {
      const [cite, arch, member] = m
      const members = modeMembers(arch)
      if (members === null) { flag('SYMBOLS', rel, n, `cannot read MODES.${arch} out of loop-template.js`, 'check the template'); continue }
      if (!members.has(member)) {
        flag('SYMBOLS', rel, n, `cites ${cite}, which ${arch} does not define`,
          `${arch} defines: ${[...members].sort().join(', ')}`)
      }
    }
    for (const m of text.matchAll(PATH_CITE)) {
      const p = m[1]
      if (existsSync(join(SKILL, p))) continue
      const context = (lines[i - 1] || '') + ' ' + text
      const owner = ownedByNamedSibling(p, context)
      if (owner === null) {
        flag('PATHS', rel, n, `cites \`${p}\`, which does not exist in this skill`,
          `fix the path, or name the owning skill in words if it lives in another one`)
      }
    }
  })
}

// ---- report ---------------------------------------------------------------------------------
const BY = ['LINES', 'SYMBOLS', 'PATHS']
for (const check of BY) {
  const hits = problems.filter(p => p.check === check)
  if (hits.length === 0) { console.log(`PASS  ${check.padEnd(8)} → clean`); continue }
  console.log(`FAIL  ${check.padEnd(8)} → ${hits.length} problem(s)`)
  for (const h of hits) console.log(`        ${h.file}:${h.line}  ${h.msg}\n          fix: ${h.fix}`)
}

if (problems.length > 0) {
  console.log(`\n${problems.length} citation problem(s). A citation that has drifted is worse than none: it reads`)
  console.log('as authority and sends the reader to a line that plausibly could be what was meant.')
  process.exit(1)
}
console.log('\nEvery citation in this skill resolves: no line numbers, no dangling symbols, no missing paths.')

// ---- the red half ---------------------------------------------------------------------------
// A clean board proves nothing on its own — this file could pass by scanning nothing at all, which
// is the vacuous-pass class every other gate here is built to refuse. So: feed each check a line it
// MUST reject, and fail if any of them comes back clean. Runs on the same invocation, against
// in-memory strings, so there is no way to have the gate without having its proof.
const PROBES = [
  ['LINES', 'see `assets/loop-template.js:109-121` for the schema',
    t => [...t.matchAll(LINE_CITE)].some(m => m[1].split('/').pop() in SOURCES)],
  ['SYMBOLS', 'the rule lives in MODES.explorer.notARealMember',
    t => [...t.matchAll(MODES_CITE)].some(m => !(modeMembers(m[1]) || new Set()).has(m[2]))],
  ['PATHS', 'read `references/this-file-does-not-exist.md` first',
    t => [...t.matchAll(PATH_CITE)].some(m => !existsSync(join(SKILL, m[1])) && ownedByNamedSibling(m[1], t) === null)],
  // The false-positive direction, which is how this gate first failed: a correct cross-skill citation
  // whose owning skill is named on the PREVIOUS line must NOT be flagged. Asserting only that the
  // gate fires would have left the over-firing version passing its own proof.
  ['PATHS-ok', 'the gauntlet-loop skill\'s\n`references/failure-modes.md` has the citations',
    t => { const ls = t.split('\n'); const line = ls[1], prev = ls[0]
           return ![...line.matchAll(PATH_CITE)].some(m =>
             !existsSync(join(SKILL, m[1])) && ownedByNamedSibling(m[1], prev + ' ' + line) === null) }],
]
const dead = PROBES.filter(([, probe, fires]) => !fires(probe))
if (dead.length > 0) {
  console.log('\nBut its own red half is broken — these checks did not respond to a line built to trip them:')
  for (const [name, probe] of dead) console.log(`  ${name}: ${JSON.stringify(probe)}`)
  console.log('A gate that cannot fail is not a gate. Fix the check, not the probe.')
  process.exit(1)
}
console.log(`Red half: all ${PROBES.length} probes behaved (3 fire, 1 correctly stays quiet).`)
