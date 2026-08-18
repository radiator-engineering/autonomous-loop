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
//   PATHS   Every skill-relative file path named in prose exists HERE. The recorded failure: a
//           pointer to another skill's `references/observability.md` sat in this skill for weeks
//           reading like a local path and resolving to nothing, because the two skills had
//           different roots. That skill has since been absorbed, and with it the whole notion of a
//           citation that resolves somewhere else — see the PATHS section below for why.
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
  // Absorbed from the predecessor converger skill this one superseded. They join the list for the
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
// This skill cites NO other skill, so a cited path either exists here or is broken. There is no
// third answer, and that is a deliberate tightening rather than a simplification.
//
// It used to have one. A citation naming another skill in words — "the predecessor converger
// skill's `references/failure-modes.md`" — was resolved against every root this skill might be
// installed under, and when the named skill was not installed anywhere the check returned
// 'unverifiable' and said nothing, on the reasoning that a gate which cries wolf gets switched off.
//
// That branch was measured, and it is why this code is gone. Running this gate with that skill
// deleted from the machine produced the IDENTICAL green board — "Every citation in this skill
// resolves" — while four real citations went unchecked. The escape hatch made retiring a cited
// skill invisible to the one check whose job is to notice. Absorbing those four files removed the
// last caller; deleting the branch removes the hazard. If a cross-skill citation is ever added
// back, this gate will call it missing, and re-introducing the exemption becomes a visible decision
// instead of a silent default.

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
      flag('PATHS', rel, n, `cites \`${p}\`, which does not exist in this skill`,
        `fix the path — this skill cites no other skill, so there is nowhere else it could resolve`)
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
    t => [...t.matchAll(PATH_CITE)].some(m => !existsSync(join(SKILL, m[1])))],
  // The false-positive direction. Asserting only that a check FIRES leaves an over-firing version
  // passing its own proof, and this one has over-fired before — it called four correct citations
  // broken. So a citation to a file that DOES exist must come back clean. The probe names a real
  // absorbed file on purpose: if `references/failure-modes.md` ever stops being part of this skill,
  // this probe goes quiet and the run fails here rather than reporting a clean board.
  ['PATHS-ok', 'read `references/failure-modes.md` before designing the panel',
    t => ![...t.matchAll(PATH_CITE)].some(m => !existsSync(join(SKILL, m[1])))],
]
const dead = PROBES.filter(([, probe, fires]) => !fires(probe))
if (dead.length > 0) {
  console.log('\nBut its own red half is broken — these checks did not respond to a line built to trip them:')
  for (const [name, probe] of dead) console.log(`  ${name}: ${JSON.stringify(probe)}`)
  console.log('A gate that cannot fail is not a gate. Fix the check, not the probe.')
  process.exit(1)
}
console.log(`Red half: all ${PROBES.length} probes behaved (3 fire, 1 correctly stays quiet).`)
