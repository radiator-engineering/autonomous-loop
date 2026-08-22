#!/usr/bin/env node
// selfcheck_refnames.mjs — run REAL git against the branch names the kernel mints from item ids.
//
// WHY THIS EXISTS. Attempt isolation (issue #8 subtask 3) shipped `branch: \`attempt/${id}\`` and
// passed 123 mocked scenarios, an adversarial per-PR review, and every other gate in this repo — all
// of which are text assertions over prompt strings. Not one of them executes git. But the kernel does
// not choose item ids: a saturator's id IS its locator (`src/a.rs:12`), a sentinel's is
// `${round}:${id}`, an exhauster's comes from an enumerate agent. `git worktree add … -B
// attempt/src/a.rs:12` exits 128 — "not a valid branch name" — so on a git target every sentinel item
// and the typical saturator item handed its worker a first command that could not run. A run that
// cannot start is not a subtle defect, and a mocked suite could never see it, because the mock never
// ran the command.
//
// So this gate runs the real thing. It extracts refSlug/attemptWorktree FROM THE TEMPLATE (never a
// copy — same discipline as replay_gates.mjs: check the derivation, not a resemblance), builds a
// throwaway repo in a temp dir, and asks git itself whether each derived name is legal, by running
// the exact commands worktreeDirective tells a worker to run.
//
//   node scripts/selfcheck_refnames.mjs        # exits non-zero if any id shape cannot start
//
// Adding an archetype, or a new id source, means adding its id shape to IDS below.

import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = resolve(HERE, '..', 'assets', 'loop-template.js')

function extract(name, src) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`no 'function ${name}(' in ${TEMPLATE} — the template changed shape`)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`unterminated function ${name}`)
}
const src = readFileSync(TEMPLATE, 'utf8')
// attemptWorktree closes over LEDGER_DIR (a fill marker in the template, a const in a filled driver),
// so bind it to the scratch dir this gate owns rather than requiring a filled driver to exist.
const ROOT = mkdtempSync(join(tmpdir(), 'al-refnames-'))
const LEDGER_DIR = join(ROOT, 'ledger')
const attemptWorktree = new Function('LEDGER_DIR',
  `${extract('refSlug', src)}; ${extract('attemptWorktree', src)}; return attemptWorktree`)(LEDGER_DIR)

// The id shapes every archetype actually mints, and the pathological ones a real target will produce
// sooner or later. Each is a REAL id the kernel can be handed — none of these is hypothetical:
const IDS = [
  ['converger  ', 'r1'],                                  // rubric criterion id
  ['exhauster  ', 't8-3-attempt-isolation'],              // enumerate-supplied task id
  ['saturator  ', 'src/a.rs:12'],                         // THE LOCATOR — file:line, the common case
  ['saturator  ', 'src/app/components/Button.tsx:1044'],  // deeper path, still ordinary
  ['saturator  ', 'GET /api/users/{id}'],                 // endpoint locator: spaces and braces
  ['saturator  ', 'pkg.mod.Class#method'],                // symbol locator
  ['sentinel   ', '3:inv1'],                              // `${round}:${id}` — EVERY sentinel item
  ['explorer   ', 'q1|supports'],                         // cell key: chartered sub-question × finding
  ['adversarial', 'a b~c^d?e*f[g\\h'],                    // every character git forbids, at once
  ['adversarial', '../../etc/passwd'],                    // traversal: must not escape the ledger dir
  ['adversarial', '-leading-dash'],                       // git rejects a leading dash
  ['adversarial', 'trailing.lock'],                       // git rejects a .lock suffix
  ['adversarial', 'feature/.hidden'],                     // git rejects a path component starting '.'
  ['adversarial', '@{upstream}'],                         // git rejects '@{'
  ['adversarial', 'ünïcödé-ідентифікатор'],               // non-ASCII: legal in git, must survive
  // COLLISION PAIRS: ids that slug to the SAME string and must still derive different attempts. A
  // collision is not cosmetic — worktreeDirective REMOVES an existing path and branch before
  // recreating them, so the second item would delete the first's attempt and Merge would then
  // attribute one item's work to the other.
  ['collision  ', 'a/b'],
  ['collision  ', 'a:b'],
  ['collision  ', 'a b'],
  ['collision  ', 'src/a.rs:12:'],                        // vs the saturator locator above
]

const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()

let failures = 0
try {
  git(['init', '-q', '--initial-branch=main', ROOT])
  git(['-c', 'user.email=gate@example.com', '-c', 'user.name=gate', 'commit', '-q', '--allow-empty', '-m', 'base'])

  console.log('REF SAFETY — every id shape the kernel mints, checked by git itself\n')
  console.log('  archetype     id                                    branch')
  console.log('  ' + '-'.repeat(96))

  const seen = new Map()
  for (const [who, id] of IDS) {
    const { path, branch } = attemptWorktree(id)
    let note = ''

    // 1. git's own opinion — the authority, not a regex of ours.
    try {
      git(['check-ref-format', '--branch', branch])
    } catch {
      note = `REJECTED BY git check-ref-format`
    }

    // 2. the actual command worktreeDirective tells the worker to run, first thing, before any edit.
    if (!note) {
      try {
        git(['worktree', 'add', '-q', path, '-B', branch, 'HEAD'])
        git(['worktree', 'remove', '--force', path])
        git(['branch', '-D', branch])
      } catch (e) {
        note = `worktree add FAILED: ${String(e.stderr || e.message).split('\n').filter(Boolean).pop()}`
      }
    }

    // 3. collision: two different ids must never derive one branch, or two items share an attempt
    //    and overwrite each other's work.
    if (!note && seen.has(branch)) note = `COLLIDES with id ${JSON.stringify(seen.get(branch))}`
    if (!note) seen.set(branch, id)

    // 4. containment: the worktree must stay inside the ledger dir, whatever the id contains.
    if (!note && !resolve(path).startsWith(resolve(LEDGER_DIR) + '/')) note = `ESCAPES ${LEDGER_DIR}`

    const ok = note === ''
    if (!ok) failures++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${who}  ${JSON.stringify(id).padEnd(38).slice(0, 38)}  ${branch}${ok ? '' : '\n        → ' + note}`)
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

console.log('')
if (failures) {
  console.error(`${failures} id shape(s) cannot start an attempt. A worker handed one of these gets a`)
  console.error(`\`git worktree add\` that exits non-zero as its FIRST action — the run cannot begin.`)
  process.exit(1)
}
console.log('Every id shape the kernel mints derives a branch git accepts, uniquely, inside the ledger.')
