#!/usr/bin/env node
// check_harness.mjs — hold the EVIDENCE HARNESS still, the way DESCENT holds the kernel still.
//
// WHY. DESCENT hashes four regions of the driver so a hand-edit cannot quietly disarm the kernel.
// The evidence harness — the script that boots the app and takes the picture — had no such
// protection, and the whole witness gate stands on it. Measured, on one real run: the harness was
// edited twice mid-flight to stop it hijacking a browser tab, the second edit introduced a race, and
// evidence capture failed for five rounds while the board went on reporting a healthy run. Four
// "captures" landed in artifacts/ during that window and all four were byte-identical to round 1's.
//
// WHY NOT JUST HASH IT AT PREFLIGHT. Because the harness frequently does not exist yet. On the run
// this was written for, BUILDING the capture harness was queue item #1 — preflight would have pinned
// an empty set and held it perfectly. So: TRUST ON FIRST SIGHT, then hold. A script the pin file has
// never seen is recorded and allowed; a script it has seen must still hash the same. That catches the
// edit-during-the-run case, which is the one that actually happened, and it costs the run nothing on
// the round where the harness is legitimately created.
//
// A CHANGED HARNESS IS NOT AUTOMATICALLY WRONG — it is automatically UNGATED. Every round after an
// unreviewed edit produced evidence nobody checked, so the honest move is to stop and say so rather
// than to keep counting. Re-pin deliberately with --accept once a human has looked.
//
//   node scripts/check_harness.mjs <ledger-dir>            # verify; exit 1 on drift
//   node scripts/check_harness.mjs <ledger-dir> --accept   # re-pin current contents, and say what moved

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const accept = args.includes('--accept')
const dir = resolve(args.find(a => !a.startsWith('--')) || '.')
const PIN = join(dir, 'harness.pin.json')

// What counts as harness: anything in the ledger dir that can RUN. driver.js is excluded because
// DESCENT already owns it, and a second opinion here would just be a second place to keep in sync.
// Backup copies are excluded too — `capture-dock.sh.bak` is the fossil of an edit, not a harness, and
// counting it would make every rescue look like tampering.
const RUNNABLE = /\.(sh|mjs|cjs|js|py|rb|ts)$/i
const EXCLUDE = /^(driver\.js)$|\.(bak\d*|orig|rej|tmp)$/i
if (!existsSync(dir)) { console.error(`check_harness: no such directory ${dir}`); process.exit(2) }

const current = {}
for (const f of readdirSync(dir).sort()) {
  const full = join(dir, f)
  let st; try { st = statSync(full) } catch { continue }
  if (!st.isFile() || EXCLUDE.test(f)) continue
  // Read under the same fail-soft rule as statSync: a file that cannot be read (permissions, or a
  // concurrent delete between readdir and here) is SKIPPED, not a crash — it simply is not a harness
  // this check can pin. Read once, then decide, because the shebang test needs the bytes too.
  let body; try { body = readFileSync(full) } catch { continue }
  // A harness is anything that can RUN: marked executable, a known script extension, OR a shebang.
  // The shebang catch matters because a `capture.bash` invoked as `bash capture.bash` is neither
  // executable nor matched by RUNNABLE, and would otherwise slip the pin entirely.
  const executable = (st.mode & 0o111) !== 0
  const hasShebang = body.length >= 2 && body[0] === 0x23 && body[1] === 0x21  // "#!"
  if (!executable && !RUNNABLE.test(f) && !hasShebang) continue
  current[f] = createHash('sha256').update(body).digest('hex').slice(0, 16)
}

// A pin that exists but will not parse is not "no pin" — treating it as empty during verification
// would let a truncated or clobbered pin read as first sight and pass. So: fail closed on verify, and
// let ONLY `--accept` repair it (that is the deliberate re-pin path a human has just looked at).
let pinned = {}
if (existsSync(PIN)) {
  try {
    pinned = JSON.parse(readFileSync(PIN, 'utf8')).files || {}
  } catch {
    if (!accept) {
      console.error(`HARNESS PIN UNREADABLE — ${PIN} exists but is not valid JSON.`)
      console.error('A corrupt pin cannot certify the harness, so this fails closed. If the harness is')
      console.error(`known-good, re-pin it deliberately:\n  node ${process.argv[1]} ${dir} --accept`)
      process.exit(1)
    }
    // --accept: fall through with an empty baseline so the re-pin can rebuild it from current contents.
  }
}
const added = Object.keys(current).filter(f => !(f in pinned))
const changed = Object.keys(current).filter(f => f in pinned && pinned[f] !== current[f])
const gone = Object.keys(pinned).filter(f => !(f in current))

if (accept) {
  writeFileSync(PIN, JSON.stringify({ pinnedAt: new Date().toISOString(), files: current }, null, 2) + '\n')
  console.log(`harness re-pinned: ${Object.keys(current).length} file(s)` +
    (changed.length ? `; accepted changes to ${changed.join(', ')}` : '') +
    (gone.length ? `; dropped ${gone.join(', ')}` : ''))
  process.exit(0)
}

// First sight of a new script is not drift. Record it and carry on — this is the round where the
// harness gets built, and failing it would make the loop unable to create its own evidence path.
if (added.length && !changed.length && !gone.length) {
  writeFileSync(PIN, JSON.stringify({ pinnedAt: new Date().toISOString(), files: { ...pinned, ...current } }, null, 2) + '\n')
  console.log(`harness pinned (first sight): ${added.join(', ')}`)
  process.exit(0)
}

if (!changed.length && !gone.length) {
  console.log(`harness intact: ${Object.keys(current).length} file(s) match the pin`)
  process.exit(0)
}

console.error('HARNESS DRIFT — the evidence path changed after it was pinned.')
for (const f of changed) console.error(`  changed: ${f}  (pinned ${pinned[f]}, now ${current[f]})`)
for (const f of gone) console.error(`  missing: ${f}  (pinned ${pinned[f]})`)
console.error('')
console.error('Every capture taken since that edit is evidence nobody gated, so this is a BLOCKER and')
console.error('not a note: record it in the ledger, stop counting captures as witnessed, and have a')
console.error('human look. If the change was deliberate and correct, re-pin it on purpose:')
console.error(`  node ${process.argv[1]} ${dir} --accept`)
process.exit(1)
