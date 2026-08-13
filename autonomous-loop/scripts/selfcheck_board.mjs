#!/usr/bin/env node
// selfcheck_board.mjs — the board must stay a DIFF, not a re-render.
//
// Why this harness exists. `assets/workbench.html` used to rebuild eight containers with innerHTML
// on a 3-second timer against a file that `writeLedger` writes once per ROUND. The cost was not
// theoretical: an expanded round collapsed three seconds after it was expanded, a looping <video>
// hero restarted before it had played a second of the motion it was in the slot to show, and a
// horizontally scrolled filmstrip snapped back to round 1 mid-look. None of that shows up in a
// screenshot, none of it fails a docs gate, and all of it makes a live board unusable for the exact
// task it exists for — watching a run that is still going.
//
// A comment asking the next editor not to re-render is what failed the first time (the badge-map
// parity check in selfcheck_loops.mjs was born the same way). So the properties are checked:
//
//   RECONCILE  the keyed list algorithm is run against a fake DOM. A list that did not change must
//              perform ZERO DOM mutations, and a row that is still on screen must be the SAME node
//              object it was — that identity is what preserves scroll, selection and <details>.
//   RENDER     no innerHTML assignment outside the guarded helper and the node factories.
//   OPENSTATE  `open` is decided at creation only, never on an update pass.
//   SELECTORS  every $('#id') in the script resolves to an id in the markup. A typo here throws
//              inside render() and freezes the whole board, silently, on the next tick.
//   EMPTYSTATE the placeholder is a SIBLING of each reconciled list, never a child — a placeholder
//              inside the container becomes the node the first real row is inserted before.
//   FEED       the server routes the two endpoints the page depends on, and reports its source.
//
// Every check below is also run against a deliberately broken copy (the RED half). A harness that
// cannot fail is not a harness, and each of these was watched to fail before it was trusted.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BOARD = join(SKILL, 'assets', 'workbench.html')
const SERVER = join(SKILL, 'scripts', 'workbench_server.py')

let failures = 0
const report = (ok, group, name, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${group.padEnd(11)} ${name.padEnd(20)} → ${detail}`)
}

// ---- a fake DOM, just wide enough to run keyed() ------------------------------------------------
// Counting insertBefore/remove is the point: "this list did not change" has to mean "the DOM was not
// touched", and only a counter can tell those apart.
let moves = 0, removes = 0
function node(tag = 'div') {
  return {
    tag, dataset: {}, _kids: [], parent: null,
    get firstChild() { return this._kids[0] || null },
    get nextSibling() {
      if (!this.parent) return null
      const i = this.parent._kids.indexOf(this)
      return this.parent._kids[i + 1] || null
    },
    insertBefore(n, ref) {
      if (n.parent) n.parent._kids.splice(n.parent._kids.indexOf(n), 1)
      n.parent = this
      const i = ref ? this._kids.indexOf(ref) : this._kids.length
      this._kids.splice(i < 0 ? this._kids.length : i, 0, n)
      moves++
      return n
    },
    remove() {
      if (!this.parent) return
      this.parent._kids.splice(this.parent._kids.indexOf(this), 1)
      this.parent = null
      removes++
    },
  }
}

// Pull the real keyed() out of the real file. Testing a copy pasted into this harness would prove
// only that the copy works — the bundle gate exists for the same reason one level up.
function extract(src, name) {
  const at = src.indexOf(`function ${name}(`)
  if (at < 0) return null
  let i = src.indexOf('{', at), depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1)
  }
  return null
}

function runReconcile(keyedSrc) {
  const keyed = new Function(`${keyedSrc}; return keyed`)()
  const create = () => node()
  const update = (n, item) => { n.value = item.v }
  const c = node()
  const first = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'c', v: 3 }]

  moves = 0; removes = 0
  keyed(c, first, x => x.id, create, update)
  const built = c._kids.length === 3 && moves === 3
  const identity = c._kids.map(k => k)   // hold the node objects

  // Pass 2: identical input. This is the case that ran ~60 times per real change.
  moves = 0; removes = 0
  keyed(c, first, x => x.id, create, update)
  const idle = moves === 0 && removes === 0
  const same = c._kids.every((k, i) => k === identity[i])

  // Pass 3: a value changed but the set did not — still no structural churn.
  moves = 0; removes = 0
  keyed(c, [{ id: 'a', v: 9 }, { id: 'b', v: 2 }, { id: 'c', v: 3 }], x => x.id, create, update)
  const inPlace = moves === 0 && c._kids[0].value === 9 && c._kids[0] === identity[0]

  // Pass 4: prepend + remove. Order must be right and survivors must be the same objects.
  moves = 0; removes = 0
  keyed(c, [{ id: 'z', v: 0 }, { id: 'a', v: 9 }, { id: 'c', v: 3 }], x => x.id, create, update)
  const order = c._kids.map(k => k.dataset.key).join(',') === 'z,a,c'
  const survived = c._kids[1] === identity[0] && c._kids[2] === identity[2] && removes === 1

  return { built, idle, same, inPlace, order, survived }
}

// ---- the checks, as pure functions of source text -----------------------------------------------
const CHECKS = {
  RENDER(board) {
    // innerHTML is allowed in exactly two places: the guarded helper (which compares first) and the
    // factories that build a row once. Anywhere else is a rebuild on a live container.
    // Match the ASSIGNMENT, not the receiver. The first version of this anchored on a `\w+` before
    // the dot and so was blind to `$('#rounds').innerHTML = ''` — the single most likely way for the
    // defect to come back, and the mutant below caught the hole on the first run.
    const allowed = ['setHTMLIfChanged', 'roundRow', 'agentRow']
    const bad = []
    for (const m of board.matchAll(/\.innerHTML\s*=(?!=)/g)) {
      const before = board.slice(0, m.index)
      const fn = [...before.matchAll(/function\s+(\w+)\s*\(/g)].pop()
      if (!fn || !allowed.includes(fn[1])) bad.push(`${fn ? fn[1] : '<top level>'} assigns .innerHTML`)
    }
    return [bad.length === 0, bad.length ? bad.join('; ') : 'innerHTML only inside the guarded helper and the row factories']
  },
  OPENSTATE(board) {
    const upd = extract(board, 'updateRound') || ''
    const rnd = extract(board, 'render') || ''
    const bad = /\.open\s*=/.test(upd) || /\.open\s*=/.test(rnd)
    const setAtCreate = /\.open\s*=/.test(extract(board, 'roundRow') || '')
    return [!bad && setAtCreate,
      bad ? 'an update pass assigns .open — the reader\'s expanded round will slam shut'
          : setAtCreate ? 'open decided at creation only' : 'roundRow never sets .open']
  },
  ROUNDMETRIC(board) {
    // A round row must be scored on the number ITS archetype is scored on. `composite` is computed by
    // writeLedger for the converger only; every other archetype writes a flat 0, and rendering that
    // anyway drew "0.000" beside an empty bar on five consecutive rounds of a run that had confirmed
    // eighteen atoms. The failure mode is the dangerous one: a real field, correctly read, that means
    // nothing for this run — so it looks like data rather than like a bug.
    //
    // Checked as three separate properties because each fails on its own. The row must branch on the
    // archetype at all; the non-converger branch must read `confirmed`; and the scale must ride in
    // from the run (`_maxAtoms`), since a round cannot know the high-water mark from itself and a bar
    // drawn against a guess is worse than no bar.
    const fn = extract(board, 'roundMetric') || ''
    const branches = /_mode\s*===\s*'converger'/.test(fn)
    const atoms = /r\.confirmed/.test(fn) && /_maxAtoms/.test(fn)
    const wired = /_mode:\s*d\.mode/.test(board) && /_maxAtoms:\s*maxAtoms/.test(board)
    const used = /const m = roundMetric\(r\)/.test(board) && !/\(r\.composite\?\?0\)\.toFixed\(3\)/.test(extract(board, 'updateRound') || '')
    // Same rule one panel over. The threshold GUIDE was gated on the archetype and the composite
    // SERIES was not, which left a dead-flat blue line along zero on every non-converger run — a
    // measurement-shaped nothing, which is worse than the "no data" it replaced.
    const chart = extract(board, 'chart') || ''
    const seriesGated = /const showComposite = mode==='converger'/.test(chart)
      && /if\(showComposite\) g\+=line\('#58a6ff'/.test(chart)
    const bad = [!fn && 'no roundMetric()',
                 !seriesGated && 'the trajectory draws a composite series for archetypes that never compute one',
                 fn && !branches && 'roundMetric does not branch on the archetype',
                 fn && !atoms && 'the non-converger branch does not score on confirmed atoms',
                 !wired && 'the run-level mode/scale never reaches the round row',
                 !used && 'updateRound still renders composite directly'].filter(Boolean)
    return [bad.length === 0, bad.length ? bad.join('; ') : 'a round is scored on the number its own archetype is scored on']
  },
  RUNSTATS(board) {
    // The DESIGN-CONTRACT blueprint names confirmed/blocked as a required At-a-glance answer, right
    // beside status and live agent count. Both of those already render; confirmed/blocked did not —
    // a watcher could see the loop was alive but not how many atoms it had actually confirmed, or how
    // many were blocked, without opening progress.json by hand.
    const rnd = extract(board, 'render') || ''
    const ok = /row\(\s*'Confirmed'\s*,\s*d\.confirmed/.test(rnd) && /row\(\s*'Blocked'\s*,\s*d\.blocked/.test(rnd)
    return [ok, ok ? 'runstats renders confirmed/blocked from the ledger head' : 'runstats does not render top-level confirmed/blocked']
  },
  RUNSTATSDELTA(board) {
    // DESIGN-CONTRACT.md §2: each KPI card needs its change against the prior round, not just its
    // current value — "Confirmed 4" alone cannot tell a watcher progress from a standstill. Checked
    // by running the real row()/deltaHTML() against representative deltas (not a text scan), so a
    // mutant that keeps a "delta" identifier nearby but drops the sign/color is still caught.
    const rowSrc = extract(board, 'row'), deltaSrc = extract(board, 'deltaHTML'), fmtSrc = extract(board, 'fmt')
    if (!rowSrc || !deltaSrc || !fmtSrc) return [false, 'row(), deltaHTML() or fmt() not found']
    let up, down, flat, none
    try {
      const fn = new Function(`${fmtSrc}\n${deltaSrc}\n${rowSrc}\nreturn row;`)()
      up = fn('Confirmed', 4, 2); down = fn('Blocked', 0, -1)
      flat = fn('Best composite', '0.500', 0, 3); none = fn('Latest pass', '2/4', null)
    } catch (e) { return [false, `row()/deltaHTML() did not run: ${e.message}`] }
    const rendered = /\(\+2\)/.test(up) && /delta ok/.test(up) &&
      /\(–1\)/.test(down) && /delta bad/.test(down) && /\(±0\)/.test(flat) && !/delta/.test(none)
    // Also require render() to actually feed a prior-round comparison into these four stats, not
    // just that row() knows how to draw one if handed it.
    const rnd = extract(board, 'render') || ''
    const wired = /row\('Confirmed',[^\n]*confirmedDelta/.test(rnd) && /row\('Blocked',[^\n]*blockedDelta/.test(rnd) &&
      /row\('Best composite',[^\n]*bestDelta/.test(rnd) && /row\('Latest pass',[^\n]*passDelta/.test(rnd)
    const ok = rendered && wired
    return [ok, ok ? 'runstats renders a signed, colored delta against the prior round for confirmed/blocked/best-composite/latest-pass'
      : `runstats delta broken: row/deltaHTML output=${rendered}, wired into render()=${wired}`]
  },
  DIAGNOSTICS(board) {
    // DESIGN-CONTRACT.md §1 Trends tier requires "dry-round streak" and Breakdowns requires "open
    // blockers" as answers a reader can get from the board. rounds[].dry and rounds[].hasBlocker
    // (references/observability.md) carry exactly those and were never read anywhere in the file — a
    // flat composite chart could not tell a plateaued run from one stuck on a blocker from one merely
    // between rounds. Checked as a run of the real updateRound against a fake node, not a text scan,
    // so a mutant that keeps the word "dry" nearby but drops the write is still caught.
    const upd = extract(board, 'updateRound')
    if (!upd) return [false, 'updateRound not found']
    const helpers = ['setText', 'setHTMLIfChanged', 'setClass', 'esc', 'backstopHTML', 'findingHTML', 'passText', 'roundMetric']
      .map(n => extract(board, n)).filter(Boolean).join('\n')
    const q = (sel) => ({ dataset: {}, className: '', title: '', innerHTML: '', style: {},
      _sel: sel, textContent: '' })
    const cells = {}
    const fakeNode = {
      querySelector(sel) { return cells[sel] || (cells[sel] = q(sel)) },
    }
    try {
      const fn = new Function(`${helpers}\n${upd}\nreturn updateRound;`)()
      fn(fakeNode, { round: 3, composite: 0.5, pass_count: 2, total: 4, dry: 2, hasBlocker: true, stall: 5 })
    } catch (e) {
      return [false, `updateRound did not run against a fake node: ${e.message}`]
    }
    const dryHTML = (cells['.dry'] || {}).innerHTML || ''
    const blkHTML = (cells['.blk'] || {}).innerHTML || ''
    const ok = /\bdry\b/.test(dryHTML) && dryHTML.includes('2') && /\bblocker\b/.test(blkHTML)
    return [ok, ok ? `dry-round streak (${dryHTML.match(/\d+/)?.[0]}) and blocker status render per round`
                    : `per-round dry/hasBlocker did not render: .dry="${dryHTML}" .blk="${blkHTML}"`]
  },
  ATOMTREND(board) {
    // DESIGN-CONTRACT.md §1 Trends tier requires "score/atom trajectory across rounds" — two
    // quantities, not one. chart() used to draw only r.composite; a watcher asking "am I converging
    // in atoms, not just in a blended score" had to open every round's accordion and do the
    // arithmetic by hand. Run the real chart() against a fake svg node, not a text scan, so a
    // mutant that keeps a comment mentioning atoms but drops the second path is still caught.
    const chartSrc = extract(board, 'chart')
    const setH = extract(board, 'setHTMLIfChanged')
    if (!chartSrc || !setH) return [false, 'chart() or setHTMLIfChanged() not found']
    // Run it ONCE PER ARCHETYPE, because "draws two lines" is the right answer for exactly one of
    // them. The first version of this check called chart() with no mode at all and asserted two
    // lines unconditionally — so it would have gone red on the correct saturator behaviour and
    // green on a build that drew a dead-flat composite line on every run. A check that only knows
    // one archetype quietly enforces that archetype everywhere.
    const draw = (mode) => {
      const svg = { dataset: {}, innerHTML: '', setAttribute() {} }
      const fn = new Function('$', `${setH}\n${chartSrc}\nreturn chart;`)(sel => sel === '#chart' ? svg : null)
      fn([{ round: 1, composite: 0.2, confirmed: 2, open: 8 },
          { round: 2, composite: 0.5, confirmed: 6, open: 4 },
          { round: 3, composite: 0.9, confirmed: 10, open: 0 }], 0.9, mode)
      // Exact 6-hex stroke colors only — the threshold guide line's `#3fb95055` (8 hex, alpha
      // suffix) must not count as the atom line.
      return [...svg.innerHTML.matchAll(/stroke="(#[0-9a-fA-F]{6})"/g)].map(m => m[1])
    }
    let conv, sat
    try { conv = draw('converger'); sat = draw('saturator') }
    catch (e) { return [false, `chart() did not run: ${e.message}`] }
    const bad = [
      !conv.includes('#58a6ff') && 'a converger is missing its composite line',
      conv.filter(c => c === '#3fb950').length < 1 && 'a converger is missing its confirmed-atoms line',
      sat.filter(c => c === '#3fb950').length < 1 && 'a saturator is missing its confirmed-atoms line',
      sat.includes('#58a6ff') && 'a saturator still draws a composite line it never computes',
    ].filter(Boolean)
    return [bad.length === 0, bad.length ? bad.join('; ')
      : 'a converger charts composite and atoms; every other archetype charts atoms alone']
  },
  SELECTORS(board) {
    const ids = new Set([...board.matchAll(/\bid="([\w-]+)"/g)].map(m => m[1]))
    const used = new Set([...board.matchAll(/\$\('#([\w-]+)'\)/g)].map(m => m[1]))
    const missing = [...used].filter(u => !ids.has(u))
    return [missing.length === 0,
      missing.length ? `selector(s) with no element: ${missing.join(', ')}` : `all ${used.size} id selectors resolve`]
  },
  EMPTYSTATE(board) {
    // Each reconciled list needs its placeholder outside itself. Checked structurally: the empty
    // div must not appear between the list's own opening and closing tag.
    const pairs = [['rounds', 'roundsempty'], ['agents', 'agentsempty']]
    const bad = pairs.filter(([list, empty]) => {
      const open = board.indexOf(`id="${list}"`)
      const ph = board.indexOf(`id="${empty}"`)
      if (open < 0 || ph < 0) return true
      const close = board.indexOf('</div>', open)
      return ph < close     // placeholder sits inside the reconciled container
    })
    return [bad.length === 0,
      bad.length ? `placeholder inside (or missing for) ${bad.map(b => b[0]).join(', ')}` : 'placeholders are siblings of their lists']
  },
  SYNTAX(board) {
    // The whole board is one inline <script>. A syntax error there does not degrade it — it stops
    // the page dead, with the markup rendered and every value stuck on its placeholder, which reads
    // as "the run is not writing" rather than "the board is broken". Nothing else here would catch
    // it: the other checks are text scans, and text scans parse anything.
    const m = board.match(/<script>([\s\S]*?)<\/script>/)
    if (!m) return [false, 'no inline <script> found']
    try { new Function(m[1]); return [true, 'the board script parses'] }
    catch (e) { return [false, `board script does not parse: ${e.message}`] }
  },
  FEED(_board, server) {
    const wants = ['/activity.json', '/artifacts.json', '/events',
                   'def collect_activity', 'def collect_artifacts', 'def watch_digest', '"source"']
    const missing = wants.filter(w => !server.includes(w))
    return [missing.length === 0,
      missing.length ? `workbench_server.py is missing ${missing.join(', ')}` : 'server routes all three endpoints and names its source']
  },
  ARTIFACTS(board, server) {
    // Two properties, both learned from the gap they closed.
    // 1. The gallery reads the DIRECTORY. Nothing in the driver writes `rounds[].artifacts[]`, so a
    //    board that renders only what the ledger declared shows an empty gallery beside a full
    //    artifacts/ dir — evidence that exists and cannot be seen.
    // 2. The artifacts dir is in the change digest. A capture landing mid-round is the strongest
    //    sign the loop is working, and it used to wait for the next ledger write to appear.
    const reads = /for p in sorted\(art\.iterdir\(\)\)/.test(server)
    const watched = server.includes('"artifacts"') && /art:\{/.test(server.replace(/\s/g, ''))
    const separated = board.includes('id="artgroups"') && !/class="arts"/.test(board)
    const bad = [!reads && 'gallery is not read from the directory',
                 !watched && 'artifacts/ is not in the change digest',
                 !separated && 'artifacts are still inline in the round rows'].filter(Boolean)
    return [bad.length === 0, bad.length ? bad.join('; ') : 'gallery reads the dir, is pushed on change, and has its own view']
  },
  STATFALLBACK(board) {
    // "Best composite" must fall back to '–' like its sibling stats (Latest pass, Threshold) when a
    // run has zero rounds. `Math.max(-1, ...[].map(...))` is a sentinel invented to dodge
    // `Math.max()` on an empty array, but it leaks straight into the frame as '-1.000' — a
    // precision-formatted number that reads as a real composite score. Design Contract §1 Rule 5:
    // compute what's asked, or defer with '–'; never substitute a fabricated quantity.
    const sentinel = /Math\.max\(-1,/.test(board)
    const guarded = /row\('Best composite',\s*rounds\.length\s*\?/.test(board)
    return [!sentinel && guarded,
      sentinel ? "Best composite still computes Math.max(-1,...), which prints '-1.000' on a 0-round run"
                : guarded ? "Best composite falls back to '–' when rounds.length===0"
                          : "Best composite has no empty-round guard"]
  },
  HISTFALLBACK(board) {
    // The History tab's per-run best-composite number must use the same '–' fallback as its sibling
    // stat (Best composite in the Run panel, see STATFALLBACK) instead of `??0`. finalize never
    // writes `best_composite` to runs.jsonl (references/observability.md Known Gaps), so `??0` fires
    // on every row and prints a fabricated, precision-formatted '0.000' next to every run's
    // sparkline — the literal substitution Design Contract §1 Rule 5 forbids. `fmt()` already returns
    // '–' for undefined/null, so loadHistory should route through it rather than reinvent a fallback.
    const zero = /run\.best_composite\s*\?\?\s*0/.test(board)
    const routed = /\$\{fmt\(run\.best_composite\)\}/.test(board)
    return [!zero && routed,
      zero ? "loadHistory still does (run.best_composite??0), which prints '0.000' for every run since finalize never writes best_composite"
           : routed ? "loadHistory's per-run stat falls back to '–' via fmt() when best_composite is absent"
                     : "loadHistory's per-run stat has no recognizable fallback"]
  },
  SPENDFALLBACK(board) {
    // The Model spend panel must name its blocker when d.model_spend is absent/empty, the same way
    // its siblings do (Budget: 'no budget cap'; Workflow: the needsfeed block). A bare '–' is
    // indistinguishable from "genuinely zero spend this round" — Design Contract §1 Rule 5: if a
    // panel cannot be computed, replace it with a note naming the blocker, never a silent dash.
    const bareDash = /Object\.entries\(spend\)\.map\(\(\[k,v\]\)=>row\(k, fmt\(v\)\)\)\.join\(''\)\s*:\s*'<div class="muted">–<\/div>'/.test(board)
    const named = /<div class="muted">not tracked — nothing in progress\.json writes model_spend for this run\.<\/div>/.test(board)
    return [!bareDash && named,
      bareDash ? "Model spend panel still falls back to a bare '–' with no note of why"
               : named ? "Model spend panel names the blocker (not tracked) when model_spend is absent"
                       : "Model spend panel's empty state text was not found"]
  },
  AGENTNAME(_board, server) {
    // A pure-hash agent id (no non-hex prefix to recover) must not fall back to the SESSION slug:
    // every un-prefixed agent in one session shares that slug, so the fallback collapses every such
    // row in the Workflow Activity panel to one indistinguishable label — the exact failure the
    // panel exists to prevent (references/observability.md: "which agent is doing what"). Run the
    // real function, not a text scan of it, so a red mutant that keeps the word "slug" nearby but
    // restores the old return value is still caught.
    // Import as a MODULE, not run as a script — `if __name__=="__main__"` below `_agent_name` parses
    // argv for `run_dir` and would exit before the function under test is ever called.
    const dir = mkdtempSync(join(tmpdir(), 'agentname-'))
    const modFile = join(dir, 'server_under_test.py')
    writeFileSync(modFile, server)
    const driver = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("server_under_test", ${JSON.stringify(modFile)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
same_slug = "shimmying-jumping-comet"
ids = ["86d13ad12bc4f0912a34b5c6d7e8f90a", "f0912a34b5c6d7e8f90a86d13ad12bc4"]
names = [mod._agent_name(i, same_slug) for i in ids]
print(json.dumps({"names": names, "distinct": len(set(names)) == len(names),
                   "no_bare_slug": all(n != same_slug for n in names)}))
`
    const driverFile = join(dir, 'driver.py')
    writeFileSync(driverFile, driver)
    const res = spawnSync('python3', [driverFile], { encoding: 'utf8' })
    if (res.status !== 0) return [false, `_agent_name did not run: ${res.stderr.trim().split('\n').pop()}`]
    let out
    try { out = JSON.parse(res.stdout.trim()) } catch { return [false, `_agent_name produced no parseable output: ${res.stdout}`] }
    const ok = out.distinct && out.no_bare_slug
    return [ok, ok ? `pure-hash ids under one slug get distinct names (${out.names.join(', ')})`
                    : `pure-hash ids under one slug collapse to one label: ${out.names.join(', ')}`]
  },
  CAPTURE(board, server) {
    // The board is the one artifact a loop-watcher judges by eye, so a run's evidence is a still of
    // it. That still is only obtainable because `?static=1` connects to nothing: the SSE stream is a
    // response that never ends, and a screenshotter waits for the page to finish loading. Measured —
    // the first capture attempt hung headless Chrome until it was killed, and the board that exists
    // to prove a loop is working was the only thing that could not be photographed.
    //
    // Four properties, because three of them fail silently. A page that still opens the stream hangs
    // the capture; one that still runs a repeating timer never lets a headless clock go idle; one
    // that cannot select a tab can only ever photograph the first view; and one that still prints
    // "polling" puts a false claim about its own feed into the frame that gets KEPT as evidence.
    const flag = /const STATIC = PARAMS\.has\('static'\)/.test(board)
    const noStream = /function connect\(\)\{\s*\n\s*if\(STATIC\) return;/.test(board)
    const noTimer = board.includes('if(!STATIC) setInterval(') && /const want = !STATIC &&/.test(board)
    const tabbable = board.includes("PARAMS.get('tab')") && /function showTab\(/.test(board)
    const honest = /setText\(\$\('#refresh'\), STATIC \? 'static capture'/.test(board)
    // And the server must re-serve the board on every request. Copying it once at startup made the
    // board unable to show a change to itself: a run improving workbench.html photographed the
    // version from before its own edit, which is evidence describing the wrong artifact.
    const fresh = /path in \("\/", "\/index\.html"\)/.test(server)
    const bad = [!flag && 'no ?static=1 capture flag',
                 !noStream && 'capture mode still opens the SSE stream (the capture will hang)',
                 !noTimer && 'capture mode still runs a repeating timer',
                 !tabbable && 'no ?tab= selection, so only one view can be captured',
                 !honest && 'the feed label still claims a live feed in capture mode',
                 !fresh && 'index.html is copied only at startup, so the board cannot show a change to itself'].filter(Boolean)
    return [bad.length === 0, bad.length ? bad.join('; ') : 'the board can be photographed, tells the truth in the frame, and re-serves itself']
  },
  TRUNCATED(board, server) {
    // workbench_server.py caps the agent list at ACTIVITY_MAX and reports how many it dropped as
    // act.truncated (collect_activity). renderActivity never read it, so a round with more than
    // ACTIVITY_MAX recorded agents showed the newest cap-worth with no sign anything was cut — a
    // capped list reading as a complete one, the same false-negative DESIGN-CONTRACT.md §1 Rule 5
    // forbids for a missing panel, just for a dropped tail of a list instead. Run the real function
    // against a fake DOM, not a text scan, so a mutant that reads act.truncated but drops the write
    // is still caught.
    const servesField = /"truncated":\s*max\(0,\s*len\(agents\)\s*-\s*ACTIVITY_MAX\)/.test(server)
    const fn = extract(board, 'renderActivity')
    if (!fn) return [false, 'renderActivity not found']
    const helpers = ['setText', 'setHTMLIfChanged', 'setClass', 'esc', 'keyed', 'agentRow', 'updateAgent']
      .map(n => extract(board, n)).filter(Boolean).join('\n')
    const cells = {}
    const q = (sel) => (cells[sel] = cells[sel] || { classList: { toggle(){}, add(){}, remove(){} },
      textContent: '', innerHTML: '', hidden: false, dataset: {}, style: {}, _kids: [],
      get firstChild() { return null }, appendChild(){}, insertBefore(){}, remove(){} })
    const fakeDoc = { querySelector: q }
    let out
    try {
      const fn2 = new Function('document', `const $=s=>document.querySelector(s);\n${helpers}\n${fn}\nreturn renderActivity;`)
      const renderActivity = fn2(fakeDoc)
      renderActivity({ running: 3, total: 63, agents: [], truncated: 3, source: 'ledger' })
      out = cells['#acttrunc'] ? cells['#acttrunc'].textContent : undefined
    } catch (e) {
      return [false, `renderActivity did not run against a fake DOM: ${e.message}`]
    }
    const rendered = out !== undefined && /\+3\b/.test(out) && /more not shown/.test(out)
    return [servesField && rendered,
      !servesField ? 'workbench_server.py no longer serves act.truncated from collect_activity'
        : rendered ? `act.truncated renders as a note ("${out}") when nonzero`
                   : `act.truncated is served but renderActivity does not write it anywhere (#acttrunc="${out}")`]
  },
  IDLEFROMLOG(_board, server) {
    // references/observability.md's own priority table puts activity.jsonl before transcripts, so
    // _from_activity_log is the PRIMARY source, not the fallback. _read_shard (the transcripts path)
    // computes idle_s from file mtime; _from_activity_log built every other field a done agent needs
    // (id/name/phase/last_at/status/state) but never idle_s. workbench.html's updateAgent renders age
    // as `state==='running' ? 'now' : ago(a.idle_s)`, so a finished agent whose record came off the
    // preferred feed rendered a blank age cell — a silent, source-dependent hole. Run the real
    // function, not a text scan, so a mutant that keeps the key name but drops the computation is
    // still caught.
    const dir = mkdtempSync(join(tmpdir(), 'idlefromlog-'))
    const modFile = join(dir, 'server_under_test.py')
    writeFileSync(modFile, server)
    const logFile = join(dir, 'activity.jsonl')
    const oldTs = new Date(Date.now() - 90_000).toISOString()
    writeFileSync(logFile, JSON.stringify({ ts: oldTs, agent: 'a1', phase: 'Work', event: 'start' }) + '\n' +
                            JSON.stringify({ ts: oldTs, agent: 'a1', phase: 'Work', event: 'end', status: 'ok' }) + '\n')
    const driver = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("server_under_test", ${JSON.stringify(modFile)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
from pathlib import Path
recs = mod._from_activity_log(Path(${JSON.stringify(logFile)}))
rec = recs[0]
print(json.dumps({"state": rec.get("state"), "idle_s": rec.get("idle_s")}))
`
    const driverFile = join(dir, 'driver.py')
    writeFileSync(driverFile, driver)
    const res = spawnSync('python3', [driverFile], { encoding: 'utf8' })
    if (res.status !== 0) return [false, `_from_activity_log did not run: ${res.stderr.trim().split('\n').pop()}`]
    let out
    try { out = JSON.parse(res.stdout.trim()) } catch { return [false, `_from_activity_log produced no parseable output: ${res.stdout}`] }
    const ok = out.state === 'done' && typeof out.idle_s === 'number' && out.idle_s >= 89 && out.idle_s < 200
    return [ok, ok ? `a done agent from activity.jsonl carries idle_s (${out.idle_s}s)`
                    : `a done agent from activity.jsonl has no usable idle_s: ${JSON.stringify(out)}`]
  },
  EVIDENCE(board) {
    // DESIGN-CONTRACT.md §1's blueprint names the Evidence tier as "the Artifacts tab, claims, the
    // handoff" — three things. Until this locator, only the Artifacts tab rendered anything;
    // HANDOFF.md and claims.jsonl were fetched by nothing (references/observability.md's own triage
    // table admitted it). Checked two ways: the markup wires the two new panels into loadArtifacts,
    // and the pure claims.jsonl parser is RUN, not text-scanned, so a mutant that keeps the shape but
    // silently drops parsed lines is still caught.
    const wired = board.includes('id="handoffbody"') && board.includes('id="claimsbody"')
      && /await loadHandoff\(\);/.test(board) && /await loadClaims\(\);/.test(board)
    const fn = extract(board, 'claimsHTML')
    if (!fn) return [false, 'claimsHTML not found']
    let html
    try {
      const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
      const f = new Function('esc', `${fn}\nreturn claimsHTML;`)(esc)
      html = f('{"id":"atom-1","evidence":"screenshot shows the fix"}\n\nnot json\n{"id":"atom-2","evidence":"log line 42"}\n')
    } catch (e) { return [false, `claimsHTML did not run: ${e.message}`] }
    const parsed = (html.match(/<li>/g) || []).length === 2 && html.includes('atom-1') && html.includes('atom-2')
    return [wired && parsed,
      wired && parsed ? 'loadArtifacts fetches HANDOFF.md and claims.jsonl, and claimsHTML parses valid lines while skipping a malformed one'
        : !wired ? 'the board no longer wires the handoff/claims panels into loadArtifacts'
                 : `claimsHTML mis-parsed a 2-line claims.jsonl fixture: ${html}`]
  },
  SPACING(board) {
    // DESIGN-CONTRACT.md §3 names four ad-hoc container paddings by exact value — 16px 22px header
    // padding (and its 22px gap), 12px 22px 0 on .tabs, 7px 14px on .tab, and 18px 22px on main — as
    // "a real, checkable gap, not a matter of taste" against the 8pt baseline grid. These are
    // container paddings, not control interiors, so the 4px exception does not cover them: every
    // number must be a clean multiple of 8. Checked by exact rule text, not a broad regex, so a
    // mutant that reintroduces just one of the four is still caught.
    const rules = [
      [/header \{ padding:16px 24px;.*?gap:24px;/, 'header padding/gap back on the 8pt grid'],
      [/\.tabs \{ display:flex; gap:8px; padding:16px 24px 0; \}/, '.tabs padding on the 8pt grid'],
      [/\.tab \{ padding:8px 16px;/, '.tab padding on the 8pt grid'],
      [/main \{ padding:16px 24px; \}/, 'main padding on the 8pt grid'],
    ]
    const bad = rules.filter(([re]) => !re.test(board)).map(([, label]) => label)
    return [bad.length === 0,
      bad.length ? `off-grid container padding remains: ${bad.join('; ')}` : 'header/tabs/tab/main padding are all on the 8pt grid']
  },
  BADGESPACING(board) {
    // DESIGN-CONTRACT.md §3: badge/pill paddings were off-grid and satisfied neither the 8px-multiple
    // rule nor the 4px control exception — `.badge{padding:3px 10px}`, `.backstop{padding:2px 8px}`,
    // `.drybadge,.blockerbadge{padding:2px 8px}`, `.phasetag{padding:3px 9px}`,
    // `.ftype{padding:1px 7px}`. SPACING() above is scoped to header/.tabs/.tab/main and explicitly
    // does not cover control interiors, so this gap went unchecked. Every pill now uses 4px 8px
    // (4px vertical, the control exception; 8px horizontal, on the grid). Checked by exact rule
    // text so a mutant that reintroduces any single off-grid value is still caught. Only the
    // `padding` declaration is pinned: `.ftype` happens to declare `font-size` first, and spelling
    // that value into this pattern would make a type-scale change report itself here as off-grid
    // padding. TYPESCALE below wildcards `padding` for exactly the same reason — one check, one
    // property, so the two never answer for each other.
    const rules = [
      [/\.badge \{ padding:4px 8px;/, '.badge padding on the grid'],
      [/\.backstop \{ padding:4px 8px;/, '.backstop padding on the grid'],
      [/\.drybadge, \.blockerbadge \{ padding:4px 8px;/, '.drybadge/.blockerbadge padding on the grid'],
      [/\.phasetag \{ padding:4px 8px;/, '.phasetag padding on the grid'],
      [/\.ftype \{ font-size:[^;]+; padding:4px 8px;/, '.ftype padding on the grid'],
    ]
    const bad = rules.filter(([re]) => !re.test(board)).map(([, label]) => label)
    return [bad.length === 0,
      bad.length ? `off-grid badge/pill padding remains: ${bad.join('; ')}` : 'badge/backstop/drybadge/blockerbadge/phasetag/ftype padding are all 4px 8px']
  },
  TYPESCALE(board) {
    // DESIGN-CONTRACT.md §3 names seven rules off the 12/14/16/20/24/32 scale: `.panel h2` (13px),
    // `.finding .m` (12.5px), `.strip figcaption`, `.backstop`, `.drybadge,.blockerbadge`,
    // `.ftype` (11px each), and `.needsfeed` (13px) — the class every "source is absent" honesty
    // panel on the board uses (rule 5's empty states: no workflow feed, no artifacts/, no
    // HANDOFF.md, no claims.jsonl, and the two "cannot read" variants). Checked by exact rule text,
    // like SPACING above, so a mutant that reintroduces just one of the seven is still caught and an
    // unrelated off-scale rule elsewhere in the sheet (out of this locator's scope) doesn't make
    // this check cry wolf.
    const rules = [
      [/\.panel h2 \{ font-size:12px;/, '.panel h2 back on the type scale'],
      [/\.finding \.m\{ color:var\(--muted\); font-size:12px; \}/, '.finding .m back on the type scale'],
      [/\.strip figcaption \{ margin-top:3px; font-size:12px;/, '.strip figcaption back on the type scale'],
      [/\.backstop \{ padding:[^;]+; border-radius:999px; border:1px solid #f8514966; background:#f8514922;\s*\n\s*color:var\(--bad\); font-size:12px;/, '.backstop back on the type scale'],
      [/\.drybadge, \.blockerbadge \{ padding:[^;]+; border-radius:999px; border:1px solid; font-size:12px;/, '.drybadge,.blockerbadge back on the type scale'],
      [/\.ftype \{ font-size:12px;/, '.ftype back on the type scale'],
      [/\.needsfeed \{ padding:16px; border:1px dashed var\(--line\); border-radius:10px; color:var\(--muted\); font-size:12px; \}/, '.needsfeed back on the type scale'],
    ]
    const bad = rules.filter(([re]) => !re.test(board)).map(([, label]) => label)
    return [bad.length === 0,
      bad.length ? `off-scale font-size remains: ${bad.join('; ')}` : '.panel h2/.finding .m/.strip figcaption/.backstop/.drybadge/.blockerbadge/.ftype/.needsfeed are all on the 12/14/16/20/24/32 scale']
  },
  AGENTROWSPACING(board) {
    // DESIGN-CONTRACT.md §3: `.agent` (the row template for every agent in the Workflow activity
    // panel, re-rendered on every activity poll and the highest-traffic element on the board) used
    // `padding:7px 8px; border-radius:7px` — 7px matches neither the 8pt grid nor the 4px control
    // exception, and 7px border-radius matches neither of the two radius tokens (4px small / 8px
    // medium). SPACING() above is scoped to header/.tabs/.tab/main and BADGESPACING() to the pill
    // badges, so this locator went unchecked. Closed by moving both onto the grid/token system:
    // padding:8px 8px and border-radius:8px (the medium token). Checked by exact rule text so a
    // mutant that reintroduces either off-grid value alone is still caught.
    const ok = /\.agent \{ display:flex; gap:10px; align-items:center; padding:8px 8px; border-radius:8px; \}/.test(board)
    return [ok, ok ? '.agent padding is 8px 8px and border-radius is 8px (the medium token)'
      : 'gap reopened: .agent padding/border-radius is off the 8pt grid / radius tokens again']
  },
  THRESHOLDMODE(board) {
    // pass_threshold is written into progress.json unconditionally by every archetype (loop-template.js
    // writeLedger), but it only gates the converger's stop()/reachedGoal() (composite >= PASS_THRESHOLD).
    // exhauster/saturator/explorer/sentinel stop on open.size===0, a dry-round streak, `answered`, or a
    // blocker — never on this number — yet chart() used to draw a dashed "bar {threshold}" guide and
    // render() a "Threshold: 0.900" stat for every mode. A saturator run plateaued by a dry streak
    // (composite pinned at 0) read as "needs to reach 0.9 to finish", which is false. Run the real
    // chart() against a fake svg node for both a converger and a non-converger mode, not a text scan,
    // so a mutant that keeps the mode param nearby but always draws the guide is still caught.
    const chartSrc = extract(board, 'chart')
    const setH = extract(board, 'setHTMLIfChanged')
    if (!chartSrc || !setH) return [false, 'chart() or setHTMLIfChanged() not found']
    const runChart = (mode) => {
      const svg = { dataset: {}, innerHTML: '', setAttribute() {} }
      const fn = new Function('$', `${setH}\n${chartSrc}\nreturn chart;`)(sel => sel === '#chart' ? svg : null)
      fn([{ round: 1, composite: 0, confirmed: 4, open: 6 }, { round: 2, composite: 0, confirmed: 10, open: 0 }], 0.9, mode)
      return svg.innerHTML
    }
    let conv, sat
    try { conv = runChart('converger'); sat = runChart('saturator') }
    catch (e) { return [false, `chart() did not run: ${e.message}`] }
    const convHasGuide = /bar 0\.9/.test(conv)
    const satHasGuide = /bar 0\.9/.test(sat)
    // render()'s Threshold stat must be gated on d.mode==='converger' the same way.
    const rnd = extract(board, 'render') || ''
    const statGated = /d\.mode\s*===\s*'converger'\s*\?\s*row\('Threshold'/.test(rnd)
    const ok = convHasGuide && !satHasGuide && statGated
    return [ok, ok ? 'the threshold guide/stat render only for mode==="converger"'
      : `converger draws guide=${convHasGuide}, saturator draws guide=${satHasGuide} (should be false), Threshold stat gated=${statGated}`]
  },
  BESTCOMPOSITEMODE(board) {
    // loop-template.js's writeLedger sets rounds[].composite to a literal 0 every round for every
    // non-converger archetype (mode.progress ? mode.progress(state) : 0 — only the converger defines
    // progress()). Before this check existed, render()'s "Best composite" stat had no mode guard and
    // printed "0.000 (±0)" round after round for exhauster/saturator/explorer/sentinel runs, as if it
    // were real, unmoving telemetry — the same failure already fixed for the neighboring Threshold
    // stat. Checked by exact rule text so a mutant that keeps the row('Best composite'...) call but
    // drops the mode guard around it is still caught.
    const rnd = extract(board, 'render') || ''
    const statGated = /d\.mode\s*===\s*'converger'\s*\n\s*\?\s*row\('Best composite'/.test(rnd)
    const naFallback = /n\/a for this archetype/.test(rnd)
    const ok = statGated && naFallback
    return [ok, ok ? 'the Best composite stat renders only for mode==="converger", with an n/a note otherwise'
      : `Best composite stat gated=${statGated}, n/a fallback present=${naFallback}`]
  },
  GATETOKEN(board) {
    // DESIGN-CONTRACT.md §3: "every status color comes from success/warning/danger rather than
    // being invented per badge... The board today...invents colors per badge." .b-ungated (the
    // REPORTING-gate badge for `unwitnessed`/`undocumented`) used to be the proof of that gap: a
    // bare `#d2a8ff` violet with no `--` variable behind it, defined nowhere in :root's token list.
    // Closed by adding a `--gate` token to :root and having .b-ungated reference it via var(),
    // instead of a hex literal invented at the point of use. Checked by exact rule text so a mutant
    // that keeps the token defined but reverts the badge to a bare hex is still caught.
    const styleBlock = (board.match(/:root \{([\s\S]*?)\}/) || [, ''])[1]
    const tokenDefined = /--gate\s*:\s*#[0-9a-fA-F]{3,8}\s*;/.test(styleBlock)
    const badgeBlock = (board.match(/\.b-ungated\{[\s\S]*?\}\n/) || [''])[0]
    const usesToken = /var\(--gate\)/.test(badgeBlock)
    const noRawHex = !/#[0-9a-fA-F]{6}(?!\w)/.test(badgeBlock.replace(/var\([^)]*\)/g, ''))
    const ok = tokenDefined && usesToken && noRawHex
    return [ok, ok ? '--gate is defined in :root and .b-ungated references var(--gate), no invented hex literal'
      : `gap reopened: tokenDefined=${tokenDefined} usesToken=${usesToken} noRawHex=${noRawHex}`]
  },
  STRIPFILMSTRIP(board) {
    // The exact regression this locator was closing: the filmstrip's comment already claimed it was
    // "Reconciled by round so the strip keeps its scroll position" but stripHTML() was plain string
    // concatenation folded into the SAME write as heroHTML — one setHTMLIfChanged($('#herobody'),
    // heroHTML(d) + stripHTML(rounds)) call. heroHTML changes on essentially every round (new
    // hero.path/commit/label), so the combined signature changed every round too, and the
    // horizontally-scrolled filmstrip (a reader scrolls it to compare rounds by eye) was torn down
    // and rebuilt via innerHTML each time — snapping the reader back to round 1 mid-look, silently.
    // Closed by giving the strip its own container (#stripbody, a sibling of #herobody, not folded
    // into its signature) and reconciling it through keyed(), so a shot already on screen is the same
    // node next render. Checked two ways, so a mutant that fixes only one half is still caught:
    // (1) render() writes herobody from heroHTML(d) ALONE, never concatenated with a strip string;
    // (2) the real renderStrip()/stripFigure()/keyed() run against a fake DOM across two renders with
    // an unchanged round list — the second render must move nothing and reuse the same <figure> node
    // objects, or the reader's scroll position (and any playing <video>) would not survive.
    const rnd = extract(board, 'render') || ''
    const notFolded = /setHTMLIfChanged\(\s*\$\('#herobody'\)\s*,\s*heroHTML\(d\)\s*\)\s*;/.test(rnd) &&
      !/heroHTML\(d\)\s*\+/.test(rnd)
    const stripSrc = extract(board, 'renderStrip'), figSrc = extract(board, 'stripFigure')
    const keyedSrc = extract(board, 'keyed'), setClassSrc = extract(board, 'setClass')
    const setHSrc = extract(board, 'setHTMLIfChanged')
    if (!stripSrc || !figSrc || !keyedSrc || !setClassSrc || !setHSrc)
      return [false, `renderStrip=${!!stripSrc} stripFigure=${!!figSrc} keyed=${!!keyedSrc}`]
    moves = 0; removes = 0
    const wrap = node('div')
    const fakeDoc = { createElement: (t) => {
      const n = node(t); n.appendChild = (c) => { c.parent = n; n._kids.push(c); return c }; return n
    } }
    let idle = false, sameNodes = false
    try {
      const fn = new Function('$', 'document',
        `${setHSrc}\n${setClassSrc}\n${keyedSrc}\n${figSrc}\n${stripSrc}\nreturn renderStrip;`)
        (sel => sel === '#stripbody' ? wrap : null, fakeDoc)
      const rounds = [{ round: 1, hero: { path: 'a.png', commit: 'aaa' } }, { round: 2, hero: { path: 'b.png', commit: 'bbb' } }]
      fn(rounds)
      const firstFigs = wrap._kids.slice()
      moves = 0; removes = 0
      fn(rounds)   // an unrelated hero-only re-render calls this again with the SAME rounds
      idle = moves === 0 && removes === 0
      sameNodes = wrap._kids.length === 2 && wrap._kids.every((k, i) => k === firstFigs[i])
    } catch (e) { return [false, `renderStrip did not run: ${e.message}`] }
    const ok = notFolded && idle && sameNodes
    return [ok, ok ? 'strip is written separately from the hero and reconciled by round: an unchanged strip performs zero DOM mutations and keeps the same <figure> nodes'
      : `filmstrip reconcile broken: heroBodyAlone=${notFolded} idle=${idle} sameNodes=${sameNodes}`]
  },
  ROWSPACING(board) {
    // DESIGN-CONTRACT.md §3: SPACING() above is scoped to header/.tabs/.tab/main, BADGESPACING() to
    // the pill badges, and AGENTROWSPACING() to .agent — none of them cover .round summary (the
    // collapsible round-row header), .finding (a per-round finding card), .hero .frames (the hero
    // capture's flex row), .strip (the filmstrip beneath it), or .gal figcaption (the artifact
    // gallery captions), so `gap:14px` / `padding:8px 10px` / `margin:6px 0` / `margin-top:14px` /
    // `margin-top:5px` went unchecked and stayed off the 8pt grid. Closed by moving each to an
    // 8-multiple: .round summary gap 14->16, .finding padding 10->8 and margin 6->8, .hero .frames
    // gap 14->16, .strip margin-top 14->16, .gal figcaption margin-top 5->8. Checked by exact rule
    // text, like SPACING/BADGESPACING/AGENTROWSPACING, so a mutant that reintroduces any single
    // off-grid value alone is still caught.
    const rules = [
      [/\.round summary \{ cursor:pointer; padding:12px 16px; display:flex; gap:16px;/, '.round summary gap on the grid'],
      [/\.finding \{ padding:8px 8px; border-radius:8px; margin:8px 0;/, '.finding padding/margin on the grid'],
      [/\.hero \.frames \{ display:flex; gap:16px;/, '.hero .frames gap on the grid'],
      [/\.strip \{ display:flex; gap:8px; overflow-x:auto; margin-top:16px;/, '.strip margin-top on the grid'],
      [/\.gal figcaption \{ margin-top:8px;/, '.gal figcaption margin-top on the grid'],
    ]
    const bad = rules.filter(([re]) => !re.test(board)).map(([, label]) => label)
    // The seven inline `<div class="grid"|"panel" style="margin-top:...">` spacers (the top grid
    // plus the score trajectory/rounds/budget/spend/handoff/claims panels) used 18px, matching
    // neither the 8pt grid nor the 4px control exception. Counted, not matched by a single global
    // regex, so a mutant that fixes six of seven and leaves one 18px behind is still caught.
    const inlineOk = (board.match(/style="margin-top:16px"/g) || []).length === 7
    const inlineBad = (board.match(/style="margin-top:18px"/g) || []).length
    if (!inlineOk || inlineBad > 0) bad.push(`inline margin-top spacers off-grid (16px count=${(board.match(/style="margin-top:16px"/g) || []).length}, 18px count=${inlineBad})`)
    return [bad.length === 0,
      bad.length ? `off-grid spacing remains: ${bad.join('; ')}` : '.round summary/.finding/.hero .frames/.strip/.gal figcaption spacing and the seven inline panel/grid margin-top spacers are all on the 8pt grid']
  },
  PASSFRAC(board) {
    // loop-template.js:roundEntry sets rounds[].total to null for saturator/explorer/sentinel — they
    // have no "total to be worked" concept — instead of falling back to state.confirmed.length, which
    // used to make pass_count and total IDENTICAL by construction every round: `${pass}/${total}`
    // read a tautological 100% for the run's whole life (visible in r6-board.png: "4/4", "7/7",
    // "10/10", "14/14", "18/18" pass, round after round). That is the exact substitution
    // DESIGN-CONTRACT.md §1 rule 5 forbids: "compute what's asked, or defer... never substitute a
    // different quantity, even disclosed." Closed by having the board render a null total as a plain
    // count with a note, never a re-invented fraction, while still drawing a real fraction for the
    // two archetypes (converger, exhauster) that do have one. Run the real updateRound()/passText()
    // against a fake node twice, not a text scan, so a mutant that keeps the word "confirmed" nearby
    // but still divides pass_count by something (or drops the fraction case) is still caught.
    const upd = extract(board, 'updateRound')
    const pt = extract(board, 'passText')
    if (!upd || !pt) return [false, 'updateRound() or passText() not found']
    const helpers = ['setText', 'setHTMLIfChanged', 'setClass', 'esc', 'backstopHTML', 'findingHTML', 'roundMetric']
      .map(n => extract(board, n)).filter(Boolean).join('\n')
    const q = (sel) => ({ dataset: {}, className: '', title: '', innerHTML: '', style: {},
      _sel: sel, textContent: '' })
    const run = (round) => {
      const cells = {}
      const fakeNode = { querySelector(sel) { return cells[sel] || (cells[sel] = q(sel)) } }
      const fn = new Function(`${pt}\n${helpers}\n${upd}\nreturn updateRound;`)()
      fn(fakeNode, round)
      return (cells['.pass'] || {}).textContent || ''
    }
    let withTotal, withoutTotal
    try {
      withTotal = run({ round: 1, composite: 0.5, pass_count: 2, total: 4, dry: 0, hasBlocker: false })
      withoutTotal = run({ round: 2, composite: 0.5, pass_count: 3, total: null, dry: 0, hasBlocker: false })
    } catch (e) { return [false, `updateRound did not run against a fake node: ${e.message}`] }
    const fractionOk = /2\/4/.test(withTotal)
    const naOk = !/\//.test(withoutTotal) && /3/.test(withoutTotal) && /no total for this archetype/.test(withoutTotal)
    const ok = fractionOk && naOk
    return [ok, ok ? `a real total renders a fraction ("${withTotal.trim()}") and a null total renders a plain count with a note ("${withoutTotal.trim()}")`
                    : `pass ratio broken: with total="${withTotal}" (want a "2/4"-style fraction), without total="${withoutTotal}" (want no '/' and "no total for this archetype")`]
  },
}

const board = readFileSync(BOARD, 'utf8')
const server = readFileSync(SERVER, 'utf8')

// ---- GREEN: the real files ----------------------------------------------------------------------
const r = runReconcile(extract(board, 'keyed'))
report(r.built, 'reconcile', 'firstRender', `3 rows inserted with ${3} mutations`)
report(r.idle, 'reconcile', 'unchangedIsFree', 'a re-render of identical data performs 0 DOM mutations')
report(r.same, 'reconcile', 'nodeIdentity', 'rows that stayed on screen are the same node objects')
report(r.inPlace, 'reconcile', 'updateInPlace', 'a changed value updates the existing node, no churn')
report(r.order && r.survived, 'reconcile', 'reorderAndRemove', 'prepend+remove keeps order and reuses survivors')

for (const [name, fn] of Object.entries(CHECKS)) {
  const [ok, detail] = fn(board, server)
  report(ok, 'board', name.toLowerCase(), detail)
}

// ---- RED: each check must fail on a copy built to trip it ----------------------------------------
// A green board proves nothing unless the same code says FAIL when handed a defect. These are the
// exact regressions this file exists to stop, reintroduced on purpose.
const RED = [
  ['RENDER', b => b.replace('function render(d){', 'function render(d){\n  $(\'#rounds\').innerHTML = "";')],
  ['OPENSTATE', b => b.replace('function updateRound(node, r){', 'function updateRound(node, r){\n  node.open = !!r._latest;')],
  ['SELECTORS', b => b.replace("setText($('#target')", "setText($('#targett')")],
  ['RUNSTATS', b => b.replace(
    "row('Confirmed', d.confirmed ?? '–', confirmedDelta) + row('Blocked', d.blocked ?? '–', blockedDelta) +\n    ", '')],
  // The exact regression this locator was closing: row() still accepts a delta arg but deltaHTML()
  // formats it uncolored and unsigned, so "Confirmed 4 (2)" is indistinguishable from a fabricated
  // number — a watcher can no longer tell growth from loss at a glance.
  ['RUNSTATSDELTA', b => b.replace(
    "const cls = n>0?'ok':(n<0?'bad':'muted');\n  const sign = n>0?'+':(n<0?'–':'±');",
    "const cls = 'muted';\n  const sign = '';")],
  // The exact regression this locator was closing: dry/hasBlocker read off the round object but the
  // write to the DOM silently dropped, leaving the round row looking identical to one with neither.
  ['DIAGNOSTICS', b => b.replace(
    "setHTMLIfChanged(node.querySelector('.dry'), dry > 0",
    "setHTMLIfChanged(node.querySelector('.dry'), false && dry > 0")],
  ['SYNTAX', b => b.replace('function render(d){', 'function render(d){ const x = ;')],
  // The exact regression this locator was closing: claimsHTML still parses each line but the parsed
  // object is silently dropped instead of pushed, so the panel renders an empty list from valid input.
  ['EVIDENCE', b => b.replace(
    'try{ items.push(JSON.parse(s)); }catch(e){',
    'try{ JSON.parse(s); }catch(e){')],
  // The exact regression this locator was closing: the atoms line is dropped and chart() is back to
  // plotting composite alone.
  ['ATOMTREND', b => b.replace(
    "g+=line('#3fb950', r=>r.confirmed==null?null:r.confirmed/maxAtoms);\n  ", '')],
  ['EMPTYSTATE', b => b.replace('<div id="rounds"></div><div id="roundsempty"></div>',
                                '<div id="rounds"><div id="roundsempty"></div></div>')],
  // replaceAll, not replace: the endpoint is named in the module docstring before it is routed, so
  // mutating only the first occurrence left the route intact and the check passed a broken server.
  ['FEED', b => b, s => s.replaceAll('/activity.json', '/disabled.json')],
  ['ARTIFACTS', b => b, s => s.replace('for p in sorted(art.iterdir()):', 'for p in []:')],
  // The exact regression this locator was closing: idle_s is computed but never assigned onto the
  // record, so a done agent off the primary feed still carries no idle_s.
  ['IDLEFROMLOG', b => b, s => s.replace(
    'rec["idle_s"] = round(now - ep, 1) if ep is not None else None',
    'pass  # idle_s not assigned')],
  ['STATFALLBACK', b => b.replace(
    "const bestNow = rounds.length ? Math.max(...rounds.map(r=>r.composite??0)) : null;",
    "const bestNow = Math.max(-1, ...rounds.map(r=>r.composite??0));")],
  ['HISTFALLBACK', b => b.replace(
    "<b>${fmt(run.best_composite)}</b></div>",
    "<b>${(run.best_composite??0).toFixed(3)}</b></div>")],
  // The exact regression this locator was closing: the empty state degrades back to a bare dash
  // with no note of why, indistinguishable from "genuinely zero spend this round".
  ['SPENDFALLBACK', b => b.replace(
    '<div class="muted">not tracked — nothing in progress.json writes model_spend for this run.</div>',
    '<div class="muted">–</div>')],
  // The mutant that matters: capture mode that still opens the stream. It looks harmless in a diff
  // and it is the exact defect that hung the first capture, so it is the one worth reintroducing.
  ['CAPTURE', b => b.replace('  if(STATIC) return;   // an endless stream', '  // if(STATIC) return; // an endless stream')],
  // The exact regression this locator was closing: a pure-hash id with an empty non-hex stem falls
  // back to the SESSION slug, so every un-prefixed agent in the run prints the same word.
  ['AGENTNAME', b => b, s => s.replace('return f"agent-{tail}" if tail else (slug or agent_id)', 'return slug or agent_id')],
  // The exact regression this locator was closing: .tab reverts to the ad-hoc 7px 14px named in
  // DESIGN-CONTRACT.md §3 while the other three stay fixed.
  ['SPACING', b => b.replace('.tab { padding:8px 16px;', '.tab { padding:7px 14px;')],
  // The exact regression this locator was closing: .badge reverts to the ad-hoc 3px 10px named in
  // the gap report while the other four pills stay fixed.
  ['BADGESPACING', b => b.replace('.badge { padding:4px 8px;', '.badge { padding:3px 10px;')],
  // The exact regression this locator was closing: .agent (the Workflow activity row template)
  // reverts to the ad-hoc padding:7px 8px; border-radius:7px named in DESIGN-CONTRACT.md §3.
  ['AGENTROWSPACING', b => b.replace(
    '.agent { display:flex; gap:10px; align-items:center; padding:8px 8px; border-radius:8px; }',
    '.agent { display:flex; gap:10px; align-items:center; padding:7px 8px; border-radius:7px; }')],
  // The exact regression this locator was closing: act.truncated is read off the payload but the
  // write to the DOM is silently dropped, so a capped agent list still reads as complete.
  ['TRUNCATED', b => b.replace(
    "setText($('#acttrunc'), act.truncated ? `+${act.truncated} more not shown` : '');",
    "setText($('#acttrunc'), '');")],
  // The exact regression this locator was closing: .panel h2 reverts to the ad-hoc 13px named in
  // DESIGN-CONTRACT.md §3, off the 12/14/16/20/24/32 scale.
  ['TYPESCALE', b => b.replace('.panel h2 { font-size:12px;', '.panel h2 { font-size:13px;')],
  // The exact regression this locator was closing: .needsfeed — the class carrying every
  // "source is absent" honesty panel on the board — reverts to the ad-hoc 13px named in
  // DESIGN-CONTRACT.md §3, off the 12/14/16/20/24/32 scale.
  ['TYPESCALE', b => b.replace('.needsfeed { padding:16px; border:1px dashed var(--line); border-radius:10px; color:var(--muted); font-size:12px;', '.needsfeed { padding:16px; border:1px dashed var(--line); border-radius:10px; color:var(--muted); font-size:13px;')],
  // The exact regression this locator was closing: .b-ungated reverts to an invented bare hex
  // (`#d2a8ff`) with the --gate token left defined but unused — the gap DESIGN-CONTRACT.md §3
  // calls out by name comes back even though the token still exists in :root.
  // The exact regression this locator was closing: chart() draws the threshold guide for every
  // mode again, so a saturator's flat composite=0 line is shown pinned under "bar 0.9" as if that
  // were the run's actual finish line.
  ['THRESHOLDMODE', b => b.replace(
    "if(mode==='converger'){\n    g+=`<line x1=\"${pad}\" y1=\"${y(threshold)}\"",
    "if(true){\n    g+=`<line x1=\"${pad}\" y1=\"${y(threshold)}\"")],
  // The exact regression this locator was closing: the Best composite stat loses its mode guard and
  // prints a fabricated "0.000 (±0)" for every non-converger archetype again.
  ['BESTCOMPOSITEMODE', b => b.replace(
    "(d.mode==='converger'\n      ? row('Best composite', rounds.length ? bestNow.toFixed(3) : '–', bestDelta, 3)\n      : '<div class=\"stat\"><span class=\"muted\">Best composite</span><span class=\"sub\">n/a for this archetype</span></div>') +",
    "row('Best composite', rounds.length ? bestNow.toFixed(3) : '–', bestDelta, 3) +")],
  ['GATETOKEN', b => b.replace(
    '.b-ungated{ color:var(--gate); border:1px solid color-mix(in srgb, var(--gate) 53%, transparent); background:\n    repeating-linear-gradient(135deg,color-mix(in srgb, var(--gate) 13%, transparent) 0 6px,color-mix(in srgb, var(--gate) 5%, transparent) 6px 12px); }',
    '.b-ungated{ color:#d2a8ff; border:1px solid #d2a8ff88; background:\n    repeating-linear-gradient(135deg,#d2a8ff22 0 6px,#d2a8ff0d 6px 12px); }')],
  // The exact regression this locator was closing: herobody's write is folded back into one string
  // with the strip, so heroHTML's per-round signature change tears the filmstrip down too.
  ['STRIPFILMSTRIP', b => b.replace(
    "setHTMLIfChanged($('#herobody'), heroHTML(d));\n  renderStrip(rounds);",
    "renderStrip(rounds);\n  setHTMLIfChanged($('#herobody'), heroHTML(d) + '');")],
  // The exact regression this locator was closing: .finding reverts to the ad-hoc padding:8px 10px;
  // margin:6px 0 named in the gap report while .round summary/.hero .frames/.strip/.gal figcaption
  // stay fixed.
  ['ROWSPACING', b => b.replace(
    '.finding { padding:8px 8px; border-radius:8px; margin:8px 0;',
    '.finding { padding:8px 10px; border-radius:8px; margin:6px 0;')],
  // The exact regression this locator was closing: passText() falls back to a fraction with the
  // pass_count on both sides when total is null, reintroducing the tautological "N/N".
  ['PASSFRAC', b => b.replace(
    "function passText(pc, total){\n  return total==null ? `${pc??'?'} confirmed · no total for this archetype` : `${pc??'?'}/${total}`;\n}",
    "function passText(pc, total){\n  return `${pc??'?'}/${total==null?pc:total}`;\n}")],
  // The mutant is the regression itself: score every archetype on the converger's composite. It reads
  // as a simplification in a diff, which is exactly how it got there the first time.
  ['ROUNDMETRIC', b => b.replace("  if(r._mode === 'converger') return", "  if(true) return")],
]
let redOk = 0
for (const [name, mutBoard, mutServer] of RED) {
  const [ok] = CHECKS[name](mutBoard(board), mutServer ? mutServer(server) : server)
  if (!ok) redOk++
  else { failures++; console.log(`FAIL  red         ${name.toLowerCase().padEnd(20)} → mutant passed; this check cannot fail`) }
}
report(redOk === RED.length, 'red', 'mutants', `${redOk}/${RED.length} deliberate defects were caught`)

// The reconcile half needs its own mutant: a keyed() that recreates every row still renders the
// right list, and destroys exactly what this harness is here to protect.
{
  const naive = `function keyed(container, items, keyOf, create, update){
    for(const [,n] of (container._byKey||new Map())) n.remove()
    const next=new Map()
    for(const item of items){ const k=String(keyOf(item)); const n=create(item); n.dataset.key=k
      update(n,item); next.set(k,n); container.insertBefore(n,null) }
    container._byKey=next }`
  const bad = runReconcile(naive)
  const caught = !bad.idle && !bad.same
  if (!caught) failures++
  report(caught, 'red', 'naiveReconcile',
    caught ? 'a rebuild-everything keyed() is rejected by unchangedIsFree and nodeIdentity'
           : 'a rebuild-everything keyed() passed — the reconcile checks are comparing nothing')
}

console.log(failures === 0
  ? '\nThe board updates by diff: unchanged data costs nothing, and nothing a reader touched is rebuilt.'
  : `\n${failures} board invariant(s) broken.`)
process.exit(failures === 0 ? 0 : 1)
