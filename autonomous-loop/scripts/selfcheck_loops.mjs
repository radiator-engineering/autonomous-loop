#!/usr/bin/env node
// Deterministic self-check for the autonomous-loop driver (assets/loop-template.js).
//
// It executes the ACTUAL template — once per archetype × scenario — with a mocked Workflow
// harness, and asserts the kernel's safety invariants hold for EVERY archetype. No tokens, no
// network: pure logic, milliseconds. Run after editing the template, or wire into CI:
//     node scripts/selfcheck_loops.mjs        # exits non-zero if any invariant is broken
//
// The invariants (each maps to a kernel property; several scenarios exist per archetype):
//   happy          — a clean run reaches its POSITIVE terminal status (converged===true). For the
//                    counted archetypes it must confirm at least one atom (not converge on air).
//   panelLies      — (converger) a panel that self-reports all-pass CANNOT converge unless a
//                    separate verifier agrees: convergence is a DRIVER count, not the panel's word.
//   crashedVerify  — a verifier that returns nothing is an UNVERIFIED mandate: the item never
//                    advances to done and the run never reports its positive status.
//   heroAbsent/heroNone/handoffAbsent/bothMissing/deadLedger — the two REPORTING gates, and their
//                    ranking. A run that verified every atom may still not call itself a success if it
//                    showed a human nothing (`unwitnessed`) or left the next agent nothing to read
//                    (`undocumented`); both are DEMOTE-ONLY and both keep reporting the confirmed
//                    count truthfully. `bothMissing` is where the order is observable — the louder
//                    failure wins — and `deadLedger` is the fail-closed half: a writer that never
//                    answered latches neither.
//   staleHandoff   — the documentation gate is about the CURRENT round, not about history: a run that
//                    wrote HANDOFF.md in round 1 and skipped it in round 2 is undocumented, because a
//                    fresh agent picking up a run that died at round 40 must not be handed round 3's
//                    picture of the world. `witnessed` is monotone and correctly so; `documented` is
//                    assigned every round, and this is the case that holds the two apart.
//   deadAuditor/staleAudit/lyingLedger — the reporting gates are decided by a terminal AUDIT: one
//                    cheap agent that READS the ledger dir after the last round. Before it, the agent
//                    that skipped HANDOFF.md was the one asked whether it wrote HANDOFF.md — guardrail
//                    #1 broken inside the kernel. A dead auditor demotes (never promotes), an auditor
//                    reporting a round that is not the run's last demotes, and where the writer's
//                    self-report and the audit disagree the AUDIT wins while the self-report survives
//                    as board state. The rung cases also run under a second archetype: the ladder is
//                    shared kernel code, so a mode-specific regression must have nowhere to hide.
//   heroNoneWithGallery/heroNoneNoGallery/auditNoCaptures — the witness gate's own `lyingLedger`, and
//                    the last place a gate took an agent's word for something a file could answer.
//                    `hero.type="none"` used to converge on its own say-so, so a run could declare a
//                    picture impossible while artifacts/ held a dozen frames — measured, on a run whose
//                    whole purpose was that board. The audit now counts the directory. The middle case
//                    is what stops the fix collapsing into "distrust `none`", which would punish a
//                    genuinely non-visual loop into permanent failure.
//   deadFinalize   — the terminal step writes the final board (status → progress.json, one line →
//                    runs.jsonl, the finished HANDOFF.md) and had no schema and no reader: a dead one
//                    left progress.json reading "running" forever. It cannot change the outcome — the
//                    status is fixed before it runs — but the caller must be able to see that the run
//                    ended and the board never found out. `happy` asserts the green half.
//   terminalCrash  — (explorer) a planner-declared "answer" whose verifier crashes does NOT finish;
//                    the terminal latches only on a GROUNDED terminal claim.
//   malformedVerdict/nonBooleanPass/unknownSeverity/nonBooleanNovel/evidenceFreePass — the VERDICT
//                    half of the dead-agent family. A crashed verifier is caught by a null check; one
//                    that answers in a shape the kernel cannot read is not, and every such shape is
//                    truthy: `{}` reads as a REFUTATION, `pass:'no'` reads as a PASS. Each asserts the
//                    same negative as the frontier family — no positive status, nothing confirmed on
//                    an unreadable verdict, and the gap on the record.
//   refutedNoEvidence  — the boundary those stop at: evidence is demanded of a PASS, which advances a
//                    count, not of a refutation, which advances nothing. Held to the same bar, every
//                    judged-and-rejected atom would become a gap and no run could ever dry.
//   malformedFinder/unnamedCandidate/malformedCriterion/malformedQueue/unnamedExperiment — the same
//                    class one level down: the poll answered, but with an ITEM the counters cannot key
//                    on (no id) or a payload that is not the list it claimed. Admitted, each becomes a
//                    phantom atom that is worked, verified and COUNTED — a criterion nobody wrote
//                    lifting the composite over the bar.
//   phantomTerminal    — (explorer) `terminal` latches the positive status, so it is read as a real
//                    boolean: `terminal:"no"` must not end the run `answered`.
//   blockerOpen    — an open blocker pins the run to status==='blocked', and the reported blocked
//                    count is not inflated by re-pushes (exactly 1 for one blocked item). Where the
//                    frontier re-queues by id (exhauster), the blocker escalates to the strong tier.
//   recovered      — a blocked item is RE-OFFERED to the frontier on its next round and a passing
//                    re-verify clears it: the run returns to its positive status instead of being
//                    pinned to `blocked` forever. (sentinel: the clearing signal is a later poll.)
//   noRework       — (saturator) a judge-refuted candidate is deduped via `seen` and worked exactly
//                    once, not re-worked every round.
//   stuck          — an item failing STUCK_AFTER rounds running gets the change-approach directive and
//                    the strong tier; below the threshold its prompt is byte-identical every round.
//   unbounded      — MAX_ROUNDS === null ends on the archetype's own predicate, not on a cap: a clean
//                    run reaches its positive status well below the rail and reports hitBackstop=false.
//                    The sentinel is the exception — it has no positive stop, so it DOES ride the rail,
//                    and hitBackstop is the only thing that says so: `held` at the rail is not healthy.
//   unboundedBlock — an unbounded run stuck on an open blocker with no new progress ends within
//                    BLOCKER_PATIENCE rounds, as `blocked`. It does not spin, and never reports `capped`.
//   productiveGap  — (saturator) an unverified gap makes the round unproductive even when other atoms
//                    landed: patience still runs out. The counterpart to productiveBlocked, and the
//                    rule both skills read identically — a partial pass cannot certify what crashed.
//   productiveBlocked  — (saturator) the counterpart: a run still confirming NEW atoms every round is
//                    not truncated by one immovable blocker. It reaches its own dry predicate —
//                    strictly before patience could fire — and the blocker pins the status to `blocked`.
//   driftingCriterion  — (converger) a panel that re-words the same blocker into a new criterion id
//                    every round cannot reset the counter — it keys on nothing a model writes — and
//                    cannot inflate the blocked count: one defect stays exactly one blocked entry.
//   flappingCriterion  — (converger) progress is MONOTONE: a criterion alternating pass/fail beside an
//                    open blocker is confirmed once ever, so it cannot reset patience forever.
//   permanentGap   — (converger) a verifier that crashes every round is an unresolved mandate: it feeds
//                    the same counter as a blocker and terminates as `blocked`, not at the rail.
//   convergerPlateau   — (converger) a composite that never reaches the bar, with nothing blocked and
//                    nothing unverified, still terminates: the plateau stop, not the rail, ends it. And
//                    the ending is NEGATIVE — a plateau below the bar is a stop, never a convergence.
//   explorerRefuted    — (explorer) a terminal claim the verifier refutes leaves the question open, so
//                    the run ends `inconclusive` with converged===false: only a GROUNDED terminal claim
//                    earns the positive status, and a dry frontier on its own never does.
//   deadPoller     — (sentinel) a poll returning null is an UNVERIFIED GAP, not "all invariants hold":
//                    it never reports `held`/converged and it does not clear an open violation.
//   alternatingBlocker — (sentinel) a violation that clears and reopens on alternating polls, with no
//                    repair ever verified, still trips patience: a clean round holds the count, it
//                    does not reset it, so a flapping invariant cannot keep the watch alive forever.
//   deadFinders/deadEnumerate/deadPanel/deadPlanner — the whole frontier-poll family, one per
//                    archetype that has one: a poll that returns null is an UNVERIFIED GAP, never an
//                    empty result. Empty reads as "nothing left to find/do/criticise/test", which is
//                    exactly what every stop predicate treats as success — so each asserts the NEGATIVE:
//                    never the positive status, never converged, and the gap is on the record.
//   emptyEnumerate — a WELL-FORMED empty queue is not a success either: zero rounds verified nothing,
//                    so `reachedGoal` comparing 0 === 0 must not report `drained`.
//   plateauWithBlocker — (converger) the plateau ends the run BEFORE patience runs out, and the open
//                    blocker still pins the terminal status: `blocked`, never the benign `stopped`.
//   dryRoundsZero  — a numeric knob that is filled but INERT is refused at startup, by name: DRY_ROUNDS=0
//                    makes the plateau true at round 0 and the run would exit green having verified nothing.
//   runaway        — (explorer) an unbounded run that reaches the rail with nothing positive, nothing
//                    blocked and nothing unverified reports `runaway_backstop` — a defect signal, not
//                    `capped`. (A crashing verifier no longer reaches the rail; that is permanentGap.)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = process.argv[2] || resolve(HERE, '../assets/loop-template.js')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// Read the kernel's own constants out of the template so the assertions can never drift from it.
const SOURCE = readFileSync(TEMPLATE, 'utf8')
const RUNAWAY_BACKSTOP = Number(SOURCE.match(/const RUNAWAY_BACKSTOP = (\d+)/)[1])
const BLOCKER_PATIENCE = Number(SOURCE.match(/const BLOCKER_PATIENCE = (\d+)/)[1])
const STUCK_AFTER = Number(SOURCE.match(/const STUCK_AFTER = (\d+)/)[1])

// maxRounds is per-scenario: a number for a capped run, the literal 'null' for an unbounded one.
// dryRounds is per-scenario too, because the plateau stop and the stuck directive share a run: a
// scenario that has to watch an item fail STUCK_AFTER times must give the plateau room to not fire
// first (the converger's stuckEscalation buys the same room with a climbing composite).
function loadDriver(mode, maxRounds = '6', dryRounds = '2', mandates = "['correctness','performance']") {
  let src = SOURCE
  const subs = {
    '<<ARCHETYPE>>': mode, '<<MAX_ROUNDS>>': maxRounds, '<<PASS_THRESHOLD>>': '0.9',
    '<<DRY_ROUNDS>>': dryRounds, '<<MAX_RETRIES>>': '2', '<<BATCH>>': '8',
    '<<LENSES>>': "['a','b']", '<<INVARIANTS>>': "['inv1','inv2']",
    '<<MANDATES>>': mandates,
  }
  for (const [k, v] of Object.entries(subs)) src = src.split(k).join(v)
  // Every remaining placeholder becomes a bare `x`, which is only valid because the rest live inside
  // quotes ('<<SOURCE>>' → 'x'). That was a comment asserting itself until a new UNQUOTED knob was
  // added above and 86 scenarios failed with `x is not defined` — a true statement about the file that
  // stopped being true, which is the whole class this harness exists to catch. Now it is checked: an
  // unquoted leftover names itself here instead of surfacing as a ReferenceError 86 times.
  // Match the defect exactly: a Config knob whose VALUE is a bare placeholder. Anything else — a
  // placeholder inside a string, a path in a comment — substitutes to a harmless `x`. An earlier
  // version of this check tested for quotes on either side and called `'loop-<<TARGET>>'` broken,
  // which is the over-firing direction and just as useless as not checking.
  const unquoted = [...src.matchAll(/^const ([A-Z_]+) = <<([A-Z_]+)>>/gm)].map(m => m[2])
  if (unquoted.length > 0) {
    console.log(`FAIL  harness    placeholder(s) not quoted in the template and not in this fill map: ` +
      `${[...new Set(unquoted)].join(', ')}`)
    console.log(`        add each to \`subs\` above with a literal value — left alone it becomes a bare`)
    console.log(`        \`x\` and every scenario for that archetype dies with "x is not defined".`)
    process.exit(1)
  }
  src = src.replace(/<<[^>]+>>/g, 'x')            // safe now: everything left is inside quotes
  src = src.replace('export const meta', 'const meta')
  return new AsyncFunction('agent', 'parallel', 'pipeline', 'log', 'phase', 'budget', 'args', src)
}

// ---- verdict helpers ----------------------------------------------------------------------
const pass = (id, novel = true) => ({ id, pass: true, evidence: 'ok', severity: 'none', novel })
const fail = (id, severity) => ({ id, pass: false, evidence: 'no', severity, novel: false })
// blocks `target` the first time it is judged, then passes it — the rework-lands-and-clears case.
const blockerFixedOnRework = (target) => {
  let hit = false
  return id => (id === target && !hit ? (hit = true, fail(id, 'blocker')) : pass(id))
}
// A verifier that judges the right item but writes the id back in its own spelling.
const drifted = (verify) => id => ({ ...verify(id), id: `judge:${id}` })
// EXPLORER verdicts. The verifier — never the planner — attributes the result to a chartered
// sub-question and picks a finding from the closed enum, and those two fields ARE the counted atom.
// A verdict without them is unreadable attribution: a gap, a retained mandate, and no progress.
const epass = (id, bears = 'q1', finding = 'supports') => ({ ...pass(id), bears_on: bears, finding })
const efail = (id, severity, bears = 'q1', finding = 'refutes') => ({ ...fail(id, severity), bears_on: bears, finding })
// blockerFixedOnRework's explorer twin, carrying the attribution both halves need.
const eBlockerFixedOnRework = (target) => {
  let hit = false
  return id => (id === target && !hit ? (hit = true, efail(id, 'blocker')) : epass(id))
}
// The default explorer verifier: EXPS' two experiments land on the two DIFFERENT chartered
// sub-questions they name, so a fixture that means to confirm two atoms confirms two cells.
const eSpread = id => epass(id, id === 'e2' ? 'q2' : 'q1')

// ---- mocked harness. A scenario supplies the frontier responses + a verify(id) function. ----
//      Records call counts and the model each label was dispatched with, for routing assertions.
function harness(scn) {
  const counts = {}
  const models = {}
  const prompts = {}   // label -> every prompt string it was dispatched with, in order
  // A SIMULATED DISK, so the terminal audit is not simply a second copy of the ledger writer's answer.
  // The ledger agent reports what it did; this records what that leaves ON DISK, and the audit reads
  // THAT. The asymmetry between the two slots is the behaviour under test:
  //   hero     — progress.json's hero slot PERSISTS. A capture written in round 1 is still named there
  //              in round 40, so a later 'absent' report does not unwrite it. Monotone, and correctly.
  //   handoff  — HANDOFF.md is REWRITTEN in place, so a round that skipped it leaves the PREVIOUS
  //              round's file sitting there: still present, describing a round that has passed. That
  //              is why the disk keeps the round NUMBER rather than a boolean, and why a run can be
  //              simultaneously "has a handoff" and undocumented.
  //   captures — files in artifacts/, which ACCUMULATE independently of the hero slot. A round that
  //              captured something leaves a frame behind whatever the hero slot ends up saying, and
  //              that independence is the whole point: it is the second reader the witness gate needs
  //              to tell "no picture was possible" from "a picture exists and the board ignored it".
  // A scenario may override `audit` outright — that is how a dead auditor, a lying ledger writer and a
  // stale claim are expressed, since none of the three is derivable from an honest writer.
  const disk = { hero: null, handoffRound: null, captures: 0 }
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || ''
    counts[label] = (counts[label] || 0) + 1
    ;(prompts[label] = prompts[label] || []).push(prompt)
    if (opts.model) models[label] = opts.model
    const n = counts[label]
    if (label === 'enumerate')       return scn.enumerate ? scn.enumerate() : { items: [] }
    // The explorer's CHARTER agent — one call, before round 1, whose answer is the run's frozen atom
    // space. Defaulted to a well-formed two-sub-question charter so every pre-existing explorer
    // scenario keeps testing what it was written to test; `deadCharter` overrides it.
    if (label === 'charter')         return scn.charter ? scn.charter() : CHARTER()
    // One call per MANDATE now, so `n` counts per-critic — which still equals the round, because each
    // mandate is dispatched exactly once per round. Round number stays the first argument so every
    // scenario written against the single-critic panel keeps working unchanged: they exercise the
    // kernel, not panel diversity, and two critics returning the same rubric merge back to that rubric.
    // The mandate is second, for the scenarios below that DO care which critic said what.
    if (label.startsWith('critique:')) return scn.critique(n, label.slice(9))
    if (label.startsWith('find:'))   return scn.find(label.slice(5), n)
    if (label === 'hypothesize')     return scn.hypothesize(n)
    if (label === 'poll')            return scn.poll(n)
    if (label.startsWith('work:'))   return scn.work ? scn.work(label.slice(5)) : 'done'
    if (label.startsWith('verify:')) return scn.verify(label.slice(7))
    // The LEDGER writer reports what it put in the hero slot AND whether it left a HANDOFF.md on
    // disk. Defaults 'artifact'/'written': the ordinary case is a loop that captures something and
    // documents itself as it goes, and every pre-existing scenario asserts a status that now depends
    // on BOTH. A scenario overrides `ledger` to withhold the picture (`heroAbsent`), the document
    // (`handoffAbsent`), or both (`bothMissing`).
    if (label === 'ledger') {
      const r = scn.ledger ? scn.ledger(n) : { hero: 'artifact', handoff: 'written' }
      if (r && (r.hero === 'artifact' || r.hero === 'none')) disk.hero = r.hero
      if (r && r.hero === 'artifact') disk.captures++           // a round that captured left a frame
      if (r && r.handoff === 'written') disk.handoffRound = n   // one ledger call per round ⇒ n IS the round
      return r
    }
    // THE TERMINAL AUDIT — a different agent, reading the files. `n` is not consulted: it runs once.
    if (label === 'audit') {
      return scn.audit ? scn.audit(disk, counts['ledger'] || 0)
        : { hero: disk.hero || 'absent',
            handoff: disk.handoffRound === null ? 'absent' : 'complete',
            handoffRound: disk.handoffRound === null ? 0 : disk.handoffRound,
            captures: disk.captures }
    }
    if (label === 'coherence') return scn.coherence ? scn.coherence() : 'reconciled nothing'
    if (label === 'finalize') return scn.finalize ? scn.finalize() : { finalized: true }
    return 'ok'
  }
  const parallel = async (thunks) =>
    Promise.all(thunks.map(t => Promise.resolve().then(t).catch(() => null)))
  const pipeline = async () => { throw new Error('pipeline not used by template') }
  const budget = { total: null, spent: () => 0, remaining: () => Infinity }
  return { agent, parallel, pipeline, log: () => {}, phase: () => {}, budget, args: undefined, counts, models, prompts }
}

// ---- scenario fixtures --------------------------------------------------------------------
const Q3 = () => ({ items: [{ id: 'i1', task: 't' }, { id: 'i2', task: 't' }, { id: 'i3', task: 't' }] })
// `where` IS the id now (the template keys on the locator, not on anything the finder names), so
// each fixture's locator is its old id and every expectation below reads unchanged.
const CANDS = (lens) => (lens === 'a' ? [{ where: 'c1', claim: 'x' }, { where: 'c2', claim: 'x' }]
                                       : [{ where: 'c3', claim: 'x' }])
// The explorer's frozen charter, and the experiments that name it. `subq` is now mandatory on every
// experiment: an experiment that names no chartered sub-question is dropped, so a fixture without one
// would be testing the drop path rather than whatever it was written for.
const CHARTER = (n = 2) => ({ subquestions: Array.from({ length: n }, (_, i) => ({ id: `q${i + 1}`, question: `sub-question ${i + 1}` })) })
const EXPS = [{ id: 'e1', subq: 'q1', hypothesis: 'h', method: 'm' }, { id: 'e2', subq: 'q2', hypothesis: 'h', method: 'm' }]
const TERM = { id: 'ans', subq: 'q1', hypothesis: 'the answer', method: 'm', terminal: true }
const VIO = { id: 'v1', invariant: 'inv', detail: 'd', severity: 'major' }
// converger critic panel: full rubric with a per-criterion PROPOSED status (never the score itself).
const CRIT = (statuses) => ({ total: statuses.length, criteria: statuses.map((s, i) => ({ id: `r${i + 1}`, region: `r${i + 1}`, status: s, fix: 'f' })) })

// ---- scenarios: each carries its own expectation over (result, harness) -------------------
// An unbounded scenario sets maxRounds:'null'. `unb` is the one property they all share: `capped` is a
// planned stop and cannot fire without a numeric cap. `ends` and `blocks` assert the CONTRACT on top —
// a stop the archetype reached itself, not a number the rail imposed. Never assert equality with the
// rail: that certifies the spin instead of catching it. `blocks` bounds a STUCK run — blocker open and
// nothing new landing — within BLOCKER_PATIENCE + 1; a run that is still landing atoms is bounded by its
// own predicate instead, and says so in its own expectation.
const NULLCAP = { maxRounds: 'null' }
const SPIN_GUARD = RUNAWAY_BACKSTOP / 10
const last = (r) => r.history[r.history.length - 1] || {}   // the round the run ended on
const unb = (expect) => (r, h) => r.status !== 'capped' && expect(r, h)
const ends = (expect) => unb((r, h) =>
  r.hitBackstop === false && r.rounds < SPIN_GUARD && expect(r, h))
const blocks = (expect) => unb((r, h) =>
  r.status === 'blocked' && r.hitBackstop === false &&
  r.rounds <= BLOCKER_PATIENCE + 1 && r.rounds < SPIN_GUARD && expect(r, h))
const SCENARIOS = {
  exhauster: {
    // `finalized` is asserted here as the GREEN half of `deadFinalize` below: a headline boolean that
    // has only ever been watched succeeding says nothing about what it would do on failure.
    happy:         { enumerate: Q3, verify: id => pass(id),
                     expect: r => r.converged === true && r.confirmed > 0 && r.finalized === true },
    // The terminal step writes the FINAL board — the status into progress.json, the run's line into
    // runs.jsonl, the finished HANDOFF.md — and it had no schema and no reader, so a dead one left
    // progress.json reading "running" forever: a finished run that every surface still describes as in
    // flight. It must not change the outcome (the status is computed before it runs, and `drained`
    // here proves a dead finalize promotes and demotes nothing) and it must be VISIBLE to the caller.
    deadFinalize:  { enumerate: Q3, verify: id => pass(id), finalize: () => null,
                     expect: r => r.status === 'drained' && r.converged === true &&
                       r.confirmed === 3 && r.finalized === false },
    // THE WITNESS GATE, both halves. Identical to `happy` in every respect except that the ledger
    // writer never fills the hero slot: same items, same verdicts, same 3 confirmed atoms. A run that
    // verified everything and showed a human nothing is `unwitnessed`, never `converged` — and the
    // atoms it did confirm are still reported, because the gate demotes the STATUS, not the count.
    heroAbsent:    { enumerate: Q3, verify: id => pass(id), ledger: () => ({ hero: 'absent', handoff: 'written' }),
                     expect: r => r.status === 'unwitnessed' && r.converged === false && r.confirmed === 3 },
    // …and "I cannot produce a picture" IS a witness, as long as it is said out loud. This is what
    // keeps the gate from punishing a genuinely non-visual loop into permanent failure.
    heroNone:      { enumerate: Q3, verify: id => pass(id), ledger: () => ({ hero: 'none', handoff: 'written' }),
                     expect: r => r.converged === true && r.confirmed === 3 },
    // …but only when it is TRUE. This is the witness gate's `lyingLedger`, and it closes the asymmetry
    // that stood as a KNOWN LIMIT for as long as the gate read one place: `none` was accepted on its
    // own word, so a run could declare "no capture was possible", finish `converged`, and leave four
    // frames sitting in artifacts/ that the board pointed at none of. Every visible signal here says
    // success — 3 confirmed atoms, a complete current handoff, a hero slot filled with a legitimate
    // value — and the ONLY thing that contradicts it is the auditor counting the directory. If
    // `witnessed` is ever narrowed back to reading the hero slot alone, this is the case that reds.
    heroNoneWithGallery:
                   { enumerate: Q3, verify: id => pass(id), ledger: () => ({ hero: 'none', handoff: 'written' }),
                     audit: (disk, rounds) => ({ hero: 'none', handoff: 'complete', handoffRound: rounds, captures: 4 }),
                     expect: r => r.status === 'unwitnessed' && r.converged === false && r.confirmed === 3 },
    // The other half, and it is what keeps the case above from being satisfiable by a gate that simply
    // stopped believing `none`: the same run with an EMPTY directory converges. A loop that genuinely
    // cannot produce a picture is still allowed to say so and finish.
    heroNoneNoGallery:
                   { enumerate: Q3, verify: id => pass(id), ledger: () => ({ hero: 'none', handoff: 'written' }),
                     audit: (disk, rounds) => ({ hero: 'none', handoff: 'complete', handoffRound: rounds, captures: 0 }),
                     expect: r => r.converged === true && r.confirmed === 3 },
    // An auditor whose answer the kernel cannot READ is an auditor that did not answer, and `captures`
    // is load-bearing now, so its absence has to make the whole verdict unusable exactly as a missing
    // handoffRound does. The fixture is deliberately the OTHERWISE-PERFECT audit — a real capture, a
    // complete handoff, the right round — because that is the only shape where the shape check is
    // observable at all: written the obvious way round (hero 'none', no captures) the case passes
    // whether the check exists or not, since `undefined === 0` is false and the run demotes anyway.
    // MEASURED as vacuous in exactly that form before it was written this way. Here, dropping the
    // `captures` clause from usableAudit converges this run.
    auditNoCaptures:
                   { enumerate: Q3, verify: id => pass(id), ledger: () => ({ hero: 'artifact', handoff: 'written' }),
                     audit: (disk, rounds) => ({ hero: 'artifact', handoff: 'complete', handoffRound: rounds }),
                     expect: r => r.status === 'unwitnessed' && r.converged === false && r.confirmed === 3 },
    // THE HANDOFF GATE. Identical to `happy` in every respect — same items, same verdicts, same 3
    // confirmed atoms, and a hero slot that IS filled — except that HANDOFF.md was never written. The
    // defect it catches: a run that verified every atom, showed a human a picture, and left the next
    // agent nothing to read still reported `drained`/converged, so the only pickup document this
    // project ever had had to be written by hand after a workflow died mid-run. Demote-only, so the
    // 3 confirmed atoms are still reported truthfully — the gate moves the STATUS, not the count.
    handoffAbsent: { enumerate: Q3, verify: id => pass(id), ledger: () => ({ hero: 'artifact', handoff: 'absent' }),
                     expect: r => r.status === 'undocumented' && r.converged === false && r.confirmed === 3 },
    // Both gates open at once, which is the ONLY place their ranking is observable. Showing a human
    // nothing is the louder failure, so `unwitnessed` must win — get the ladder backwards and a run
    // with no picture AND no handoff reports the quieter of its two failures, which is the exact
    // laundering both rungs exist to stop. Neither may ever invent a positive status.
    bothMissing:   { enumerate: Q3, verify: id => pass(id), ledger: () => ({ hero: 'absent', handoff: 'absent' }),
                     expect: r => r.status === 'unwitnessed' && r.converged === false && r.confirmed === 3 },
    // A dead ledger agent returns null. Fails CLOSED on BOTH latches, like every other verdict in the
    // kernel: neither `witnessed` nor `documented` may latch off a writer that never answered, so a
    // crashed writer cannot launder a positive finish. Only the louder rung is visible in `status`
    // (that is `bothMissing`'s ranking, arrived at via a crash instead of an honest "absent"); the
    // documentation half is asserted by `handoffAbsent`, where the witness rung is satisfied.
    deadLedger:    { enumerate: Q3, verify: id => pass(id), ledger: () => null,
                     expect: r => r.status === 'unwitnessed' && r.converged === false },
    // THE STALE HANDOFF. The gate's whole point is that a run dying at round 40 leaves a document
    // describing ROUND 40 — so "a handoff was written at some point" is not the property, and a
    // monotone latch measured exactly that: round 1 writes it, round 2 does not, and the run finished
    // `drained`/converged over a pickup document one round out of date. Everything else here is the
    // `happy` run (i2 needs one rework, so there are two rounds to differ across): 3 confirmed atoms,
    // a filled hero slot, no blocker. Only the second round's handoff is missing, and that alone must
    // demote it. Assign, never OR.
    staleHandoff:  { enumerate: Q3,
                     verify: (() => { let hit = false
                       return id => (id === 'i2' && !hit ? (hit = true, fail(id, 'major')) : pass(id)) })(),
                     ledger: n => ({ hero: 'artifact', handoff: n === 1 ? 'written' : 'absent' }),
                     expect: r => r.status === 'undocumented' && r.converged === false &&
                       r.rounds === 2 && r.confirmed === 3 && r.blocked === 0 },
    // THE AUDITOR IS DEAD. Both reporting gates are decided by it now, so a null return is the one
    // failure that could hand them both back to nobody. Fail closed: neither gate may be satisfied by
    // an auditor that never answered, and the louder rung is what shows — exactly as `deadLedger`
    // behaves one layer down. The atoms are still counted truthfully; only the status demotes.
    deadAuditor:   { enumerate: Q3, verify: id => pass(id), audit: () => null,
                     expect: r => r.status === 'unwitnessed' && r.converged === false && r.confirmed === 3 },
    // THE WRITER LIES AND THE AUDIT WINS. The ledger writer reports 'written' every round — the
    // default, i.e. the very self-report the gate used to latch on — while the auditor, reading the
    // directory, finds no handoff. If the self-report still gated anything this run reports `drained`.
    // The second assertion is the other half of the fix: the writer's claim is not discarded, it is
    // demoted to BOARD STATE and reaches progress.json (round 2's head merge carries round 1's report),
    // so the divergence between claim and finding is visible rather than silently resolved.
    lyingLedger:   { enumerate: Q3,
                     verify: (() => { let hit = false
                       return id => (id === 'i2' && !hit ? (hit = true, fail(id, 'major')) : pass(id)) })(),
                     audit: () => ({ hero: 'artifact', handoff: 'absent', handoffRound: 0, captures: 1 }),
                     expect: (r, h) => r.status === 'undocumented' && r.converged === false &&
                       r.confirmed === 3 && h.prompts['ledger'][1].includes('"handoff":"written"') },
    crashedVerify: { enumerate: Q3, verify: id => (id === 'i2' ? null : pass(id)), expect: r => r.converged === false },
    blockerOpen:   { enumerate: Q3, verify: id => (id === 'i2' ? fail(id, 'blocker') : pass(id)),
                     expect: (r, h) => r.converged === false && r.status === 'blocked' && r.blocked === 1 && h.models['work:i2'] === 'opus' },
    unbounded:     { ...NULLCAP, enumerate: Q3, verify: id => pass(id), expect: ends(r => r.converged === true && r.confirmed > 0) },
    unboundedBlock:{ ...NULLCAP, enumerate: Q3, verify: id => (id === 'i2' ? fail(id, 'blocker') : pass(id)),
                     expect: blocks(r => r.blocked === 1) },
    // The worst instance of the dead-poll class, because it fires before round 1: a null enumerate
    // read as an empty queue makes stop() true immediately and reachedGoal compare 0 === 0, so the
    // run reported `drained`, converged, in ZERO rounds, having enumerated nothing. The gap has no
    // round to live in, so it must survive as a blocker.
    deadEnumerate: { enumerate: () => null, verify: id => pass(id),
                     expect: r => r.status === 'blocked' && r.status !== 'drained' &&
                       r.converged === false && r.rounds === 0 && r.blocked === 1 },
    // Its well-formed twin, and the reason `Array.isArray` alone is not the fix: a genuinely empty
    // queue verifies nothing either, so a zero-round run may not claim the positive status.
    emptyEnumerate:{ enumerate: () => ({ items: [] }), verify: id => pass(id),
                     expect: r => r.rounds === 0 && r.converged === false && r.status !== 'drained' },
    // A well-formed list carrying an item with no id. It keys nothing — `open`, `seen` and the blocked
    // set all index on it — yet it counted toward `total` and was "drained" like any other, so the run
    // reported a queue it never read as fully worked. The unnamed item is recorded the same way a dead
    // enumerate is: a blocker, so the real items still get worked and `drained` stays unreachable.
    malformedQueue:{ enumerate: () => ({ items: [{ id: 'i1', task: 't' }, { task: 't' }] }), verify: id => pass(id),
                     expect: r => r.status === 'blocked' && r.converged === false &&
                       r.blocked === 1 && r.confirmed === 1 },
    // A verifier that REFUSES in a shape the kernel cannot read. `{pass:'no'}` is truthy and `v.pass`
    // was never type-checked, so the refusal read as a PASS — and the blocker branch lives in the else,
    // so `severity:'blocker'` was never even looked at: measured `drained`, converged, in one round.
    // Unreadable is unverified, and here the retry ladder is what records it — MAX_RETRIES rounds later
    // the item is blocked, which is where a refusal was always going to land.
    nonBooleanPass:{ enumerate: Q3, verify: id => ({ id, pass: 'no', severity: 'blocker', evidence: 'x' }),
                     expect: r => r.converged === false && r.status === 'blocked' && r.blocked === 3 },
    // `recovered`, with a verifier that echoes the id in its own spelling. The verdict spread used to
    // put THAT name on the blocked entry, and the blocked set is matched by id — so the entry named
    // something no later verdict could ever match, and the run stayed `blocked` after the item had
    // been independently verified fixed. Identity belongs to the item, not to the judge.
    // The grounded-claims log gets the same treatment for the same reason: a claim filed under a name
    // that is in no queue, rubric or blocked set cannot be looked up by the next round or by a person.
    verdictIdDrift:{ enumerate: Q3, verify: drifted(blockerFixedOnRework('i2')),
                     expect: (r, h) => r.status === 'drained' && r.converged === true && r.blocked === 0 &&
                       h.prompts['ledger'].some(p => p.includes('"id":"i1"')) &&
                       !h.prompts['ledger'].some(p => p.includes('judge:')) },
  },
  saturator: {
    happy:         { find: (lens, n) => ({ candidates: n === 1 ? CANDS(lens) : [] }), verify: id => pass(id), expect: r => r.converged === true && r.confirmed > 0 },
    crashedVerify: { find: lens => ({ candidates: CANDS(lens) }), verify: () => null, expect: r => r.converged === false },
    blockerOpen:   { find: lens => ({ candidates: CANDS(lens) }), verify: id => (id === 'c3' ? fail(id, 'blocker') : pass(id)),
                     expect: r => r.converged === false && r.status === 'blocked' && r.blocked === 1 },
    noRework:      { find: (lens) => ({ candidates: lens === 'a' ? [{ where: 'cRej', claim: 'x' }] : [] }), verify: id => fail(id, 'major'),
                     expect: (r, h) => r.status === 'saturated' && h.counts['work:cRej'] === 1 },
    unbounded:     { ...NULLCAP, find: (lens, n) => ({ candidates: n === 1 ? CANDS(lens) : [] }), verify: id => pass(id),
                     expect: ends(r => r.converged === true && r.confirmed > 0) },
    unboundedBlock:{ ...NULLCAP, find: lens => ({ candidates: CANDS(lens) }), verify: id => (id === 'c3' ? fail(id, 'blocker') : pass(id)),
                     expect: blocks(r => r.blocked === 1) },
    // `seen` drops a judged candidate from the finders' output forever, so a blocked one only gets its
    // rework if the frontier re-offers it — and only the re-verify can clear it. Both halves or the
    // blocker is stranded and every saturator run with one ends `blocked` whatever the rework did.
    recovered:     { find: (lens, n) => ({ candidates: n === 1 ? CANDS(lens) : [] }), verify: blockerFixedOnRework('c3'),
                     expect: r => r.status === 'saturated' && r.converged === true && r.blocked === 0 },
    // One unclearable blocker plus a genuinely new candidate for five rounds, then a dry frontier.
    // The productive rounds must not be truncated: it ends at 5 + DRY_ROUNDS on its own predicate,
    // BEFORE patience could fire (asserted on the last round's stall), and reports `blocked`.
    productiveBlocked:
                   { ...NULLCAP, find: (lens, n) => ({ candidates: lens === 'a'
                       ? [{ where: 'cBad', claim: 'x' }, ...(n <= 5 ? [{ where: `n${n}`, claim: 'x' }] : [])]
                       : [] }),
                     verify: id => (id === 'cBad' ? fail(id, 'blocker') : pass(id)),
                     expect: unb(r => r.status === 'blocked' && r.hitBackstop === false && r.blocked === 1 &&
                       r.confirmed === 5 && r.rounds > BLOCKER_PATIENCE + 1 && r.rounds < SPIN_GUARD &&
                       last(r).stall < BLOCKER_PATIENCE) },
    // Its mirror, and the boundary the two skills must read the SAME way: a genuinely new candidate
    // every round beside one whose verifier never answers. A gapped round is unproductive whatever
    // else landed in it, so patience still runs out; let the new atom reset it and the run never ends.
    productiveGap: { ...NULLCAP, find: (lens, n) => ({ candidates: lens === 'a'
                       ? [{ where: `n${n}`, claim: 'x' }, { where: 'cDead', claim: 'x' }] : [] }),
                     verify: id => (id === 'cDead' ? null : pass(id)),
                     expect: blocks(r => r.converged === false && r.confirmed >= 2 && r.blocked === 0) },
    // THE FROZEN LOCATOR. A finder that re-words the SAME finding every round, under a new id it
    // made up, at one unchanging place. While identity came from the finder this was indistinguishable
    // from real work: `seen` never matched, `dry` never accumulated, and an unbounded run had no
    // terminal predicate left that could fire — it stood on the budget ceiling alone. Keying on the
    // locator collides every re-wording with the first find, so round 2 is dry, round 3 is dry, and
    // the run saturates on its own predicate having correctly counted exactly ONE instance.
    rewordedFinding:
                   { ...NULLCAP, find: (lens, n) => ({ candidates: lens === 'a'
                       ? [{ id: `finding-${n}`, where: 'src/a.rs:12', claim: `phrasing number ${n}` }] : [] }),
                     verify: id => pass(id),
                     expect: unb(r => r.status === 'saturated' && r.converged === true &&
                       r.confirmed === 1 && r.rounds <= 4 && r.hitBackstop === false) },
    // THE RAIL, still reachable. A finder that turns up a genuinely NEW locator every round: nothing
    // is blocked, nothing is unverified, and `dry` never accumulates, so no terminal predicate this
    // archetype owns can ever fire and only RUNAWAY_BACKSTOP ends it. It must report that as its own
    // status — `runaway_backstop`, hitBackstop true — never the benign-looking `capped`, and never a
    // positive one. (The explorer used to carry this case; its charter now bounds it at the size of
    // the frozen space, so the rail needs a home that can still reach it.)
    unboundedStream:
                   { ...NULLCAP, find: (lens, n) => ({ candidates: lens === 'a' ? [{ where: `s${n}`, claim: 'x' }] : [] }),
                     verify: id => pass(id),
                     expect: unb(r => r.status === 'runaway_backstop' && r.hitBackstop === true &&
                       r.converged === false && r.confirmed === RUNAWAY_BACKSTOP) },
    // Every lens crashes, every round. Dropped with `.filter(Boolean)` the frontier is empty, the
    // round looks dry, and DRY_ROUNDS of that reported `saturated` with converged=true and confirmed=0
    // — every instance found because every searcher died. A round whose finders died is not a dry
    // round, so the plateau (DRY_ROUNDS=2) must NOT end this: patience does, at BLOCKER_PATIENCE.
    deadFinders:   { ...NULLCAP, find: () => null, verify: id => pass(id),
                     expect: blocks(r => r.converged === false && r.status !== 'saturated' &&
                       r.confirmed === 0 && r.rounds >= BLOCKER_PATIENCE && last(r).gap === true) },
    // The gap that outlives its round — and the one every earlier round's detection work could not
    // catch, because it is not a detection failure. A verifier dies on c1 in round 1, so the mandate
    // is correctly raised; the frontier then dries, and a per-round `gap` boolean has forgotten it by
    // the time the stop predicate runs. The run reports `saturated`, converged, over a candidate
    // nothing ever judged. c1 is never re-offered (saturator.retry is a no-op by design), so the
    // mandate stays open for the rest of the run and the honest ending is `blocked`.
    // Note `confirmed > 0`: this is a PRODUCTIVE run that still may not claim saturation, which is
    // what separates it from deadFinders. Retention, not detection.
    strandedGap:   { ...NULLCAP, find: (lens, n) => ({ candidates: n === 1 ? CANDS(lens) : [] }),
                     verify: id => (id === 'c1' ? null : pass(id)),
                     expect: blocks(r => r.converged === false && r.status !== 'saturated' &&
                       r.confirmed > 0 && last(r).gap === true) },
    // deadFinders' sibling, and the reason the guard reads `Array.isArray(r?.candidates)` rather than
    // `Boolean`: a lens that answers with ONE candidate instead of a list of them. It is truthy, the
    // panel looks complete so no gap is raised, and flatMap hands the object straight through as a
    // find. Every lens dying is caught by the count; one lens answering in the wrong SHAPE is not.
    malformedFinder:
                   { ...NULLCAP, find: (lens, n) => ({ candidates: lens === 'a' ? (n === 1 ? CANDS('a') : [])
                                                                                : { where: 'c9', claim: 'x' } }),
                     verify: id => pass(id),
                     expect: blocks(r => r.converged === false && r.status !== 'saturated' &&
                       r.confirmed === 2 && last(r).gap === true) },
    // The same gap one level further down: a well-formed list carrying a candidate with no LOCATOR.
    // `seen` and `everConfirmed` key on it, so an unlocated one enters as `undefined`, gets worked,
    // and is COUNTED as an instance found — one phantom per round, all colliding on the same key.
    unlocatedCandidate:
                   { ...NULLCAP, find: (lens, n) => ({ candidates: lens === 'a' ? (n === 1 ? CANDS('a') : [])
                                                                                : [{ claim: 'x' }] }),
                     verify: id => pass(id),
                     expect: blocks(r => r.converged === false && r.status !== 'saturated' &&
                       r.confirmed === 2 && last(r).gap === true) },
    // Every verifier answers `{}`. Truthy, so a null check passes it through; `v.pass` is undefined, so
    // the else branch records each candidate as GENUINELY REFUTED — `seen` swallows it, the frontier
    // dries, and DRY_ROUNDS of that reported `saturated / converged / confirmed=0`. A crashed verifier
    // read as an adjudication is the verdict half of deadFinders.
    malformedVerdict:
                   { ...NULLCAP, find: lens => ({ candidates: CANDS(lens) }), verify: () => ({}),
                     expect: blocks(r => r.converged === false && r.status !== 'saturated' &&
                       r.confirmed === 0 && last(r).gap === true) },
    // `novel` decides whether a passing verdict ADVANCES the count, so it is read as a real boolean:
    // `!== false` lets `novel:'no'` — a verifier saying "already known" — count as a fresh find, and a
    // run that mints a new atom every round from an unreadable flag never dries and rides the rail.
    nonBooleanNovel:
                   { ...NULLCAP, find: (lens, n) => ({ candidates: lens === 'a' ? [{ where: `n${n}`, claim: 'x' }] : [] }),
                     verify: id => ({ id, pass: true, evidence: 'ok', severity: 'none', novel: 'no' }),
                     expect: blocks(r => r.converged === false && r.confirmed === 0) },
    // The boundary the evidence rule stops at, asserted so nobody tightens past it: a REFUTATION
    // advances no count, so it is a refutation with or without an evidence string. Hold failures to the
    // same bar and every judged-and-rejected candidate becomes a gap, and no run could ever dry.
    refutedNoEvidence:
                   { find: lens => ({ candidates: lens === 'a' ? [{ where: 'cRej', claim: 'x' }] : [] }),
                     verify: id => ({ id, pass: false, severity: 'major', novel: false }),
                     expect: (r, h) => r.status === 'saturated' && h.counts['work:cRej'] === 1 },
  },
  explorer: {
    happy:         { hypothesize: n => (n === 1 ? { experiments: EXPS } : { experiments: [TERM] }), verify: eSpread, expect: r => r.converged === true && r.confirmed > 0 },
    crashedVerify: { hypothesize: () => ({ experiments: EXPS }), verify: () => null, expect: r => r.converged === false },
    // The stranded gap again, one archetype over, and the sharper case: the unreadable verdict is on a
    // SIDE experiment in round 1, and round 2's terminal claim then verifies cleanly. Everything the
    // explorer finally reports is true — and it still must not say `answered`, because e1's mandate was
    // never read and explorer.retry never brings it back to be read.
    strandedGap:   { hypothesize: n => (n === 1 ? { experiments: EXPS } : { experiments: [TERM] }),
                     verify: id => (id === 'e1' ? null : eSpread(id)),
                     expect: r => r.converged === false && r.status !== 'answered' },
    terminalCrash: { hypothesize: () => ({ experiments: [TERM] }), verify: () => null, expect: r => r.converged === false },
    blockerOpen:   { hypothesize: n => (n === 1 ? { experiments: EXPS } : { experiments: [TERM] }), verify: id => (id === 'e2' ? efail(id, 'blocker', 'q2') : eSpread(id)),
                     expect: r => r.converged === false && r.status === 'blocked' },
    unbounded:     { ...NULLCAP, hypothesize: n => (n === 1 ? { experiments: EXPS } : { experiments: [TERM] }), verify: eSpread,
                     expect: ends(r => r.converged === true && r.confirmed > 0) },
    unboundedBlock:{ ...NULLCAP, hypothesize: n => (n === 1 ? { experiments: EXPS } : { experiments: [TERM] }),
                     verify: id => (id === 'e2' ? efail(id, 'blocker', 'q2') : eSpread(id)),
                     expect: blocks(r => r.blocked === 1) },
    // Same as the saturator's: a refuted load-bearing claim is re-offered by the frontier, and the
    // re-grounding clears it — otherwise the answer can never be reported clean.
    recovered:     { hypothesize: n => (n === 1 ? { experiments: EXPS } : { experiments: [TERM] }), verify: eBlockerFixedOnRework('e2'),
                     expect: r => r.status === 'answered' && r.converged === true && r.blocked === 0 },
    // A planner that always has one more experiment and never proposes its terminal claim. This
    // fixture used to REACH THE RAIL — everything verified, nothing blocked, nothing unverified, and
    // the frontier never dried — and it is the reason `runaway_backstop` exists as a status instead of
    // a benign-looking `capped`. The charter makes that unreachable for this archetype: progress is
    // counted in cells of a FROZEN space, so a planner with infinite experiments exhausts the space
    // (4 findings × 2 chartered sub-questions = 8 cells) and then plateaus, ~10 rounds in. So the
    // assertion tightens rather than relaxes: the run must end on its OWN predicate, off the rail,
    // having counted exactly the space and no more. Rail coverage did not go away with it — see
    // saturator.unboundedStream, where the finder mints a genuinely new locator every round and the
    // rail is still the only thing that ends the run.
    runaway:       { ...NULLCAP, hypothesize: n => ({ experiments: [{ id: `e${n}`, subq: 'q1', hypothesis: 'h', method: 'm' }] }),
                     verify: (() => { let n = -1
                       const F = ['supports', 'refutes', 'no-effect', 'inconclusive']
                       return id => { n++; return epass(id, n % 2 ? 'q2' : 'q1', F[Math.floor(n / 2) % 4]) } })(),
                     expect: unb(r => r.status === 'inconclusive' && r.hitBackstop === false &&
                       r.converged === false && r.confirmed === 8 && r.rounds < SPIN_GUARD) },
    // The planner proposes its terminal claim and the verifier REFUTES it. The refutation arrives as
    // an ordinary failure, not a blocker — the verify prompt asks for `blocker`, and a loop that only
    // survives a verifier honouring that convention is the instrument-that-cannot-disagree again. So
    // the frontier dries with the question open: the run stops, but it has not answered anything, and
    // `dry` alone used to hand it `answered` with converged=true and zero grounded claims.
    explorerRefuted:
                   { ...NULLCAP, hypothesize: () => ({ experiments: [TERM] }), verify: id => efail(id, 'major'),
                     expect: unb(r => r.status === 'inconclusive' && r.converged === false &&
                       r.hitBackstop === false && r.confirmed === 0 && r.blocked === 0 &&
                       r.rounds < SPIN_GUARD) },
    // Its adversary: the planner itself dies. An empty experiment list dries the frontier, and
    // `inconclusive` then reports a legitimate "the question stayed open" for a run whose instrument
    // never answered — the softest possible cover for a dead agent. The gap must outrank it.
    deadPlanner:   { ...NULLCAP, hypothesize: () => null, verify: eSpread,
                     expect: blocks(r => r.converged === false && r.status !== 'inconclusive' &&
                       r.confirmed === 0 && last(r).gap === true &&
                       last(r).stall < BLOCKER_PATIENCE) },
    // deadPlanner one level down: the planner answers, but with an experiment that has no id. It keys
    // nothing the ledger can track, and it was worked, verified and counted as a grounded claim all the
    // same — an extra atom per round out of a field the planner never filled in.
    unnamedExperiment:
                   { ...NULLCAP, hypothesize: () => ({ experiments: [{ subq: 'q1', hypothesis: 'h', method: 'm' }, ...EXPS] }),
                     verify: eSpread,
                     expect: blocks(r => r.converged === false && r.status !== 'inconclusive' &&
                       r.confirmed === 2 && last(r).gap === true) },
    // `terminal` is the one frontier field that latches the POSITIVE status, so it is read as a real
    // boolean and not for truthiness: `terminal:"no"` used to end the run `answered` on an experiment
    // the planner explicitly did not designate as the answer. Normalized, it is an ordinary experiment
    // and the question stays open — a stop, never a conclusion.
    phantomTerminal:
                   { ...NULLCAP, hypothesize: () => ({ experiments: [{ id: 'ans', subq: 'q1', hypothesis: 'h', method: 'm', terminal: 'no' }] }),
                     verify: id => epass(id),
                     expect: unb(r => r.status === 'inconclusive' && r.converged === false &&
                       r.hitBackstop === false && r.rounds < SPIN_GUARD) },
    // A verifier that refutes with a severity outside the rubric's enum. The blocker gate matches on
    // the string, so `'critical'` silently DOWNGRADES a disqualifying failure to an ordinary one: the
    // atom is deduped into `seen`, the frontier dries, and the run ends `inconclusive` with the
    // blocker never recorded. The kernel cannot tell what that verdict meant, so it is a gap.
    unknownSeverity:
                   { ...NULLCAP, hypothesize: () => ({ experiments: [TERM] }),
                     verify: id => ({ id, pass: false, evidence: 'no', severity: 'critical', novel: false }),
                     expect: blocks(r => r.converged === false && r.status !== 'inconclusive' && r.confirmed === 0) },
    // ---- THE FROZEN CHARTER, five ways ------------------------------------------------------
    // THE RE-WORDED HYPOTHESIS — the defect the charter exists to close, and the last KNOWN LIMIT in
    // the kernel's third invariant. The planner re-words ONE experiment every round under a fresh id,
    // all on one chartered sub-question, and the verifier passes it citing FRESH EVIDENCE every time
    // — a different measurement, so nothing about the round repeats. While identity came from the
    // planner this was indistinguishable from real work: `seen` never matched, `dry` never
    // accumulated, and the plateau could not fire by construction. The identical defect ran the
    // saturator for 200 rounds and counted 200 confirmed atoms out of ONE re-worded finding.
    // The evidence VARYING while the question does not is the point of this fixture: it defeats an
    // evidence-keyed design exactly as it defeats a text-keyed one. Only the frozen cell survives it
    // — round 1 establishes q1|supports, and every re-wording after that lands on the same cell.
    rewordedHypothesis:
                   { ...NULLCAP,
                     hypothesize: n => ({ experiments: [{ id: `hyp-${n}`, subq: 'q1',
                       hypothesis: `the same idea, phrasing ${n}`, method: 'm' }] }),
                     verify: (() => { let n = 0
                       return id => ({ ...epass(id), evidence: `fresh measurement ${++n}` }) })(),
                     expect: unb(r => r.status === 'inconclusive' && r.converged === false &&
                       r.confirmed === 1 && r.rounds <= 4 && r.hitBackstop === false) },
    // THE SAME RE-WORDING, PLUS ONE UNASKED-FOR VERDICT FIELD — and the field is enough on its own.
    // The kernel builds each accepted atom by spreading the verdict over the work item, so before
    // `fromVerdict` narrowed it to VERDICT_SCHEMA's declared keys, any key the verifier invented won
    // that spread. `terminal` is the item field meaning "this is the answer", and the two readers
    // disagree about where it comes from: `countsAsProgress` reads it off the PENDING ITEM (cell
    // `q1|supports`) while `tally` reads it off the merged ATOM (cell `answer|supports`). One injected
    // key made every round test a cell that was never the cell recorded, so `covered` never held it and
    // the plateau could not fire — the charter's own defect, re-opened one layer beneath the charter.
    // The control is rewordedHypothesis directly above: identical run, no extra key. Measured on the
    // unfixed template: runaway_backstop, 200 rounds, 200 confirmed.
    verdictInjectsTerminal:
                   { ...NULLCAP,
                     hypothesize: n => ({ experiments: [{ id: `hyp-${n}`, subq: 'q1',
                       hypothesis: `the same idea, phrasing ${n}`, method: 'm' }] }),
                     verify: (() => { let n = 0
                       return id => ({ ...epass(id), evidence: `fresh measurement ${++n}`, terminal: true }) })(),
                     expect: unb(r => r.status === 'inconclusive' && r.converged === false &&
                       r.confirmed === 1 && r.rounds <= 4 && r.hitBackstop === false) },
    // THE SAME INJECTION LAUNDERED THROUGH A BLOCKER, which is the direction that must never be wrong:
    // a FALSE `answered`. A blocked entry is re-offered to the frontier next round, so a control field
    // that reaches `state.blocked` comes back as a live work item — and the re-offer passes `terminal`
    // through rather than normalizing it the way a fresh experiment is. Round 1 refutes an ORDINARY
    // experiment with `{severity:'blocker', terminal:true}`; round 2 gets it back carrying terminal,
    // passes it, and `resolve` latches `answered` on a run whose planner never proposed an answer at
    // all. Asserting `status !== 'answered'` is the whole point; the blocked ending is incidental.
    blockerLaundersTerminal:
                   { ...NULLCAP,
                     hypothesize: () => ({ experiments: [{ id: 'e1', subq: 'q1', hypothesis: 'h', method: 'm' }] }),
                     verify: (() => { let seen = false
                       return id => (seen ? epass(id) : (seen = true, { ...efail(id, 'blocker'), terminal: true })) })(),
                     expect: unb(r => r.status !== 'answered' && r.converged === false &&
                       r.hitBackstop === false && r.rounds < SPIN_GUARD) },
    // OFF-CHARTER, and the legible-escalation graft with it. An experiment naming a sub-question the
    // charter does not hold is dropped (admitting it hands the atom space back to the model, which is
    // the whole defect), the round is gapped, and the run ends `blocked`. The second assertion is the
    // part that makes it more than stuck: the PROPOSED sub-question text must reach the ledger
    // writer's "Open blockers" payload, so the human reading HANDOFF.md sees what the run wanted to
    // add, re-charters, and resumes. Without it the run is merely stuck; with it, it is an escalation.
    offCharter:    { ...NULLCAP,
                     hypothesize: n => ({ experiments: [{ id: `x${n}`, subq: 'q9-late-discovery',
                       hypothesis: 'a line of enquiry nobody chartered', method: 'm' }] }),
                     verify: id => epass(id),
                     expect: blocks((r, h) => r.confirmed === 0 && r.blocked === 1 &&
                       last(r).gap === true &&
                       h.prompts['ledger'].some(p => p.includes('the run wants to add'))) },
    // THE UNATTRIBUTED TERMINAL CLAIM — the sharpest case, because `resolve` latches `answered` on any
    // passing terminal verdict and only RETENTION keeps that from being reported. The verifier passes
    // the answer but attributes it to a sub-question nobody chartered, so the kernel cannot read what
    // the result established: the item is retained as an unverified mandate, the gap stays open, and
    // the run reports `blocked` with nothing confirmed. Return false without retaining and this
    // finishes `answered` on an attribution nothing could read.
    unattributedTerminal:
                   { ...NULLCAP, hypothesize: () => ({ experiments: [TERM] }),
                     verify: id => ({ ...pass(id), bears_on: 'q9', finding: 'supports' }),
                     expect: blocks(r => r.status !== 'answered' && r.converged === false &&
                       r.confirmed === 0) },
    // THE GREEN HALF, one experiment per round so BOTH axes of the cell are discriminated. Within a
    // single round `covered` has not been updated yet, so two experiments sharing a cell both count —
    // the dedup is between rounds, and a fixture that crowds them into one round would pass whether
    // the cell key read both fields or neither. So: round 1 establishes q1|supports; round 2 is a
    // DIFFERENT sub-question with the SAME finding (a bears_on-blind key rejects it); round 3 is the
    // SAME sub-question with a DIFFERENT finding (a finding-blind key rejects it); round 4 re-runs
    // q1|supports under a fresh id and must count for nothing — rewordedHypothesis's rule holding
    // inside a healthy run; round 5 grounds the answer, which gets its own bucket rather than
    // whichever sub-question it happened to cite. Four cells, four confirmed atoms, positive ending.
    charteredSpread:
                   { ...NULLCAP,
                     hypothesize: n => ({ experiments:
                       n === 1 ? [{ id: 'a1', subq: 'q1', hypothesis: 'h', method: 'm' }]
                     : n === 2 ? [{ id: 'a2', subq: 'q2', hypothesis: 'h', method: 'm' }]
                     : n === 3 ? [{ id: 'a3', subq: 'q1', hypothesis: 'h', method: 'm' }]
                     : n === 4 ? [{ id: 'a4', subq: 'q1', hypothesis: 'same ground, new words', method: 'm' }]
                     :           [TERM] }),
                     verify: id => (id === 'a2' ? epass(id, 'q2', 'supports')
                                  : id === 'a3' ? epass(id, 'q1', 'refutes')
                                  :               epass(id, 'q1', 'supports')),
                     expect: unb(r => r.status === 'answered' && r.converged === true &&
                       r.confirmed === 4 && r.rounds === 5 && r.hitBackstop === false) },
    // THE DEAD CHARTER. It fires before round 1, so it is the exhauster's dead-enumerate case one
    // archetype over and it takes the same treatment: a per-round gap has NOWHERE to live yet, so the
    // failure is recorded as a blocker that survives to the terminal ladder. An empty charter drops
    // every experiment forever, so the frontier is dry by construction and the unchanged stop()
    // predicate ends the run at ZERO rounds rather than spending patience asking a planner for
    // experiments no verdict could ever be counted against.
    deadCharter:   { charter: () => null, hypothesize: () => ({ experiments: EXPS }), verify: eSpread,
                     expect: r => r.rounds === 0 && r.blocked === 1 && r.status === 'blocked' &&
                       r.converged === false && r.confirmed === 0 },
  },
  sentinel: {
    happy:         { poll: () => ({ violations: [] }), verify: id => pass(id), expect: r => r.converged === true },
    crashedVerify: { poll: () => ({ violations: [VIO] }), verify: () => null, expect: r => r.converged === false && r.status === 'blocked' },
    blockerOpen:   { poll: () => ({ violations: [VIO] }), verify: id => fail(id, 'blocker'), expect: r => r.converged === false && r.status === 'blocked' && r.blocked === 1 },
    recovered:     { poll: n => ({ violations: n === 1 ? [VIO] : [] }), verify: () => null, expect: r => r.converged === true && r.blocked === 0 },
    // A sentinel never stops on its own, so unbounded means it rides the rail — and still reports
    // `held`, because the positive predicate outranks the cap in the status ladder. hitBackstop is
    // the ONLY signal that separates a rail-length spin from a healthy watch, so assert it: without it
    // this scenario passes no matter what the loop does.
    unbounded:     { ...NULLCAP, poll: () => ({ violations: [] }), verify: id => pass(id),
                     expect: unb(r => r.converged === true && r.status === 'held' && r.hitBackstop === true) },
    unboundedBlock:{ ...NULLCAP, poll: () => ({ violations: [VIO] }), verify: id => fail(id, 'blocker'),
                     expect: blocks(r => r.blocked === 1) },
    // A violation on every odd poll, gone again on every even one, with no repair ever verified. The
    // clean polls are not stuck rounds, but they do not reset patience either — only a confirmed atom
    // does, and nothing here is ever confirmed. Otherwise an invariant that flaps forever holds
    // patience open forever: the same starvation the monotone set closes, arriving via the poller
    // instead of the panel. So the stuck rounds accumulate across the clean ones and the watch ends
    // `blocked` with the violation open, well short of the rail.
    alternatingBlocker:
                   { ...NULLCAP, poll: n => ({ violations: n % 2 === 1 ? [VIO] : [] }), verify: id => fail(id, 'blocker'),
                     expect: unb(r => r.status === 'blocked' && r.hitBackstop === false && r.blocked === 1 &&
                       r.rounds > BLOCKER_PATIENCE && r.rounds <= 2 * BLOCKER_PATIENCE && r.rounds < SPIN_GUARD) },
    // The poller dies after raising one violation. Silence is not health: the null polls must NOT
    // clear the open entry and must NOT let the watch finish `held`. Without the guard the reconcile
    // reads them as an empty violation list, drops the blocker, and rides the rail reporting a system
    // it stopped watching as clean — so `blocked === 1` is the assertion that catches it.
    deadPoller:    { ...NULLCAP, poll: n => (n === 1 ? { violations: [VIO] } : null), verify: id => fail(id, 'blocker'),
                     expect: blocks(r => r.converged === false && r.status !== 'held' && r.blocked === 1) },
  },
  converger: {
    happy:         { critique: () => CRIT(['pass', 'pass', 'pass']), verify: id => pass(id), expect: r => r.converged === true && r.confirmed > 0 },
    // THE RUNGS, UNDER A SECOND ARCHETYPE. The reporting gates are shared KERNEL code — one ladder,
    // one audit, no mode-specific branch anywhere in them — but every scenario for them lived under
    // the exhauster, so a regression that only showed up on another archetype's path (a mode whose
    // last round writes no ledger, a doneStatus that outranks the rung) had nowhere to be caught.
    // These three are the exhauster's rung cases replayed on the converger, and they must agree.
    handoffAbsent: { critique: () => CRIT(['pass', 'pass', 'pass']), verify: id => pass(id),
                     ledger: () => ({ hero: 'artifact', handoff: 'absent' }),
                     expect: r => r.status === 'undocumented' && r.converged === false && r.confirmed === 3 },
    deadLedger:    { critique: () => CRIT(['pass', 'pass', 'pass']), verify: id => pass(id), ledger: () => null,
                     expect: r => r.status === 'unwitnessed' && r.converged === false },
    // THE STALE CLAIM, which is the rung that only the audit can reach: a complete five-section
    // HANDOFF.md, on disk, filled — describing the round BEFORE the one the run ended on. Nothing that
    // asks "does the file exist?" can tell it from a fresh one; the round number is the whole check.
    // Off by exactly one, because that is the shape a real stale handoff has — the last round's writer
    // skipped it and the previous round's file stayed behind.
    staleAudit:    { critique: () => CRIT(['pass', 'pass', 'pass']), verify: id => pass(id),
                     audit: (disk, rounds) => ({ hero: 'artifact', handoff: 'complete', handoffRound: Math.max(0, rounds - 1), captures: rounds }),
                     expect: r => r.status === 'undocumented' && r.converged === false && r.confirmed === 3 },
    panelLies:     { critique: () => CRIT(['pass', 'pass', 'pass']), verify: id => fail(id, 'major'), expect: r => r.converged === false },
    crashedVerify: { critique: () => CRIT(['pass', 'pass', 'pass']), verify: () => null, expect: r => r.converged === false },
    // `status` is compared against one exact string, so leaving the field unconstrained let a panel
    // mark a criterion broken in the wrong case and have it read as not-failing. Identical verifiers,
    // three spellings: 'fail' works the criterion; 'FAIL' and 'failed' skipped it and converged on a
    // rubric one criterion short. Unreadable now means dropped, and the round carries the gap for it.
    criterionStatusCase:
                   { critique: () => CRIT(['FAIL', 'pass', 'pass']), verify: id => pass(id),
                     expect: r => r.converged === false },
    blockerOpen:   { critique: () => CRIT(['fail', 'pass', 'pass']), verify: id => (id === 'r1' ? fail(id, 'blocker') : pass(id)),
                     expect: r => r.converged === false && r.status === 'blocked' && r.blocked === 1 },
    // DRY_ROUNDS is raised past STUCK_AFTER here for one reason: the plateau stop would end the run
    // before the streak matures and the directive could never be observed. Nothing else moves.
    stuck:         { dryRounds: String(STUCK_AFTER + 1),
                     critique: () => CRIT(['fail', 'pass', 'pass']), verify: id => (id === 'r1' ? fail(id, 'major') : pass(id)),
                     expect: (r, h) => {
                       const p = h.prompts['work:r1']
                       // The directive fires after STUCK_AFTER VERIFIED failures — so attempts 1..N are
                       // byte-identical and a resumed run replays them from cache; attempt N+1 differs.
                       return p.length > STUCK_AFTER && p.slice(0, STUCK_AFTER).every(s => s === p[0]) &&
                         !p[0].includes('STUCK:') && p[STUCK_AFTER].includes('STUCK:') && h.models['work:r1'] === 'opus'
                     } },
    unbounded:     { ...NULLCAP, critique: () => CRIT(['pass', 'pass', 'pass']), verify: id => pass(id),
                     expect: ends(r => r.converged === true && r.confirmed > 0) },
    unboundedBlock:{ ...NULLCAP, critique: () => CRIT(['fail', 'pass', 'pass']), verify: id => (id === 'r1' ? fail(id, 'blocker') : pass(id)),
                     expect: blocks(r => r.blocked === 1) },
    // Every verifier crashes forever: no verdict, so nothing is confirmed and nothing is even blocked.
    // The gap feeds the patience counter on its own and the run ends `blocked` — never a pass, and
    // never a 200-round spin against a panel that cannot answer.
    permanentGap:  { ...NULLCAP, critique: () => CRIT(['pass', 'pass', 'pass']), verify: () => null,
                     expect: blocks(r => r.converged === false && r.confirmed === 0) },
    // One blocker, re-worded into a fresh criterion id every round, over a stable passing pair. The
    // drift must not buy the run a single round: the counter keys on nothing a model writes, so it
    // advances on every unproductive round and the run still ends `blocked`.
    driftingCriterion:
                   { ...NULLCAP, critique: n => ({ total: 3, criteria: [
                       { id: `xss-${n}`, region: 'r1', status: 'fail', fix: 'f' },
                       { id: 'r2', region: 'r2', status: 'pass', fix: 'f' },
                       { id: 'r3', region: 'r3', status: 'pass', fix: 'f' }] }),
                     verify: id => (id.startsWith('xss-') ? fail(id, 'blocker') : pass(id)),
                     // One defect ⇒ exactly one blocked entry. Admitting each reworded id opened a
                     // fresh entry per round and reported blocked=4 for a single finding.
                     expect: blocks(r => r.confirmed === 2 && r.blocked === 1) },
    // One immovable blocker beside a criterion that passes, regresses and passes again forever. Under a
    // per-round definition of progress that alternation resets patience every other round and the run
    // never ends; `everConfirmed` counts r2 once ever, so patience runs out on schedule.
    flappingCriterion:
                   { ...NULLCAP, critique: () => CRIT(['fail', 'fail', 'pass']),
                     verify: (() => { let n = 0
                       return id => id === 'r1' ? fail(id, 'blocker')
                                  : id === 'r2' ? (++n % 2 === 1 ? pass(id) : fail(id, 'major'))
                                  : pass(id) })(),
                     expect: blocks(r => r.confirmed === 2 && r.blocked === 1) },
    // One criterion that never passes, at `major` — so nothing blocks, nothing is unverified, and the
    // composite sits below the bar forever. The bar alone cannot end this: uncapped it rode the rail
    // for 200 rounds. The plateau ends it, and a plateau below the bar is NOT convergence — the run
    // stops with the negative status, which is the half that must not be traded for a green badge.
    convergerPlateau:
                   { ...NULLCAP, critique: () => CRIT(['fail', 'pass', 'pass']),
                     verify: id => (id === 'r1' ? fail(id, 'major') : pass(id)),
                     expect: unb(r => r.status === 'stopped' && r.converged === false &&
                       r.hitBackstop === false && r.blocked === 0 && r.confirmed === 2 &&
                       r.rounds < SPIN_GUARD) },
    // convergerPlateau's counter-case, at DRY_ROUNDS < BLOCKER_PATIENCE so the plateau reaches the
    // end FIRST: the run legitimately ends there (stall is still short of patience), but a blocker is
    // open, and a blocker pins the terminal status. `stopped` is benign amber; this run is red.
    plateauWithBlocker:
                   { ...NULLCAP, dryRounds: '1', critique: () => CRIT(['fail', 'pass', 'pass']),
                     verify: id => (id === 'r1' ? fail(id, 'blocker') : pass(id)),
                     expect: unb(r => r.status === 'blocked' && r.converged === false &&
                       r.hitBackstop === false && r.blocked === 1 && r.confirmed === 2 &&
                       last(r).stall < BLOCKER_PATIENCE && r.rounds < SPIN_GUARD) },
    // The panel itself dies, every round: no criteria, so nothing fails, nothing is blocked and the
    // rubric freezes empty — the frontier is dry from round 1 and the plateau used to finish it
    // `stopped`, a benign reading of a critic panel that never ran.
    deadPanel:     { ...NULLCAP, critique: () => null, verify: id => pass(id),
                     expect: blocks(r => r.converged === false && r.status !== 'converged' &&
                       r.confirmed === 0 && last(r).gap === true &&
                       last(r).stall < BLOCKER_PATIENCE) },
    // deadPanel one level down: the panel answers, but one criterion has no id. It freezes into the
    // rubric as `undefined`, counts toward `total`, and a verdict on it is confirmed like any other —
    // a criterion nobody wrote carrying the composite over the bar. Dropped, the rubric is short of the
    // panel's own list, which is exactly the drift the length check already calls a gap.
    malformedCriterion:
                   { ...NULLCAP, critique: () => ({ total: 3, criteria: [
                       { region: 'r1', status: 'fail', fix: 'f' },
                       { id: 'r2', region: 'r2', status: 'pass', fix: 'f' },
                       { id: 'r3', region: 'r3', status: 'pass', fix: 'f' }] }),
                     verify: id => pass(id),
                     expect: blocks(r => r.converged === false && r.confirmed === 2 && last(r).gap === true) },
    // Schema-valid, correctly typed, and grounded in nothing: a PASS carrying `evidence:''` (or none at
    // all). Every verify prompt in the template demands a concrete checkable signal and nothing enforced
    // it, so this converged in ONE round on three verdicts that cited nothing. Presence is the kernel's
    // job — whether the evidence is any GOOD is the critic's — and an absent one is an unverified gap.
    evidenceFreePass:
                   { ...NULLCAP, critique: () => CRIT(['pass', 'pass', 'pass']),
                     verify: id => (id === 'r1' ? { id, pass: true, severity: 'none', novel: true }
                                                : { id, pass: true, evidence: '   ', severity: 'none', novel: true }),
                     expect: blocks(r => r.converged === false && r.confirmed === 0) },
    // Not a run at all: DRY_ROUNDS=0 makes the plateau true before round 1, so the loop exits green
    // having verified nothing. A knob that is filled but inert is refused at startup, by name.
    dryRoundsZero: { dryRounds: '0', critique: () => CRIT(['fail', 'pass', 'pass']), verify: id => pass(id),
                     throws: e => /DRY_ROUNDS/.test(e.message) },

    // ---- the panel -------------------------------------------------------------------------
    // DRY_ROUNDS=0 above is a NUMBER that is filled but inert. These are the same defect in a
    // COLLECTION, which is the shape that looks filled hardest: `[]` is a perfectly good array.
    // With no mandate no critic runs, so no criterion can fail, so every criterion "passes" and the
    // run reports `converged` against an artifact nothing read — the vacuous pass reached through a
    // knob. Refused at startup and named, like the numeric ones.
    emptyPanel:    { mandates: '[]', critique: () => CRIT(['pass', 'pass', 'pass']), verify: id => pass(id),
                     throws: e => /MANDATES/.test(e.message) },
    // Distinctness is the point of a panel, so two identical mandates are refused too. This is
    // diversity collapse by construction rather than by drift (references/failure-modes.md §5) — the
    // run would pay for two critics and buy one opinion twice.
    duplicatePanel: { mandates: "['correctness','correctness']", critique: () => CRIT(['pass', 'pass']),
                     verify: id => pass(id), throws: e => /MANDATES/.test(e.message) },
    // deadPanel (above) kills EVERY critic. This kills one of two, which is the harder case: the
    // survivor returns a clean all-pass rubric, so the round looks complete and would converge on the
    // strength of half a panel. The dead critic is an unverified gap, so it cannot.
    oneCriticDies: { critique: (n, m) => (m === 'performance' ? null : CRIT(['pass', 'pass', 'pass'])),
                     verify: id => pass(id),
                     expect: r => r.converged === false && r.status !== 'converged' },
    // FAIL WINS across mandates. Correctness fails r1; performance reports the same id passing. If a
    // pass could overwrite a fail, the loop would launder a real defect through whichever critic
    // happened to answer second.
    //
    // The assertion is the WORKER'S PROMPT, and it has to be. The first version of this scenario
    // checked `converged === false` and that r1 reached a worker at all — and it passed with the
    // fail-wins rule deleted, because a criterion merged to `pass` is still dispatched (as a no-op,
    // for its first independent check) and still fails the verifier. Both readings produced an
    // identical board. What actually differs is what the worker is TOLD: "Fix criterion r1" when the
    // fail survived the merge, "Make NO edit" when a pass buried it. Assert on the difference itself,
    // not on a downstream number that both paths reach.
    failWins:      { critique: (n, m) => (m === 'correctness' ? CRIT(['fail', 'pass', 'pass'])
                                                              : CRIT(['pass', 'pass', 'pass'])),
                     verify: id => (id === 'r1' ? fail(id, 'major') : pass(id)),
                     expect: (r, h) => r.converged === false &&
                       /^Fix criterion r1/.test((h.prompts['work:r1'] || [])[0] || '') },

    // ---- re-anchor, coherence, keep-best -----------------------------------------------------
    // RE-ANCHOR: every agent that judges or edits is pointed at the spec PATH, not at the driver's
    // memory of it. A driver that paraphrases the bar once and re-injects its own paraphrase cannot
    // notice it has drifted, because the paraphrase always matches the spec — itself. Checked on the
    // critic AND the verifier: two judges anchored differently is two bars, and the run converges on
    // whichever is looser.
    reAnchored:    { critique: () => CRIT(['fail', 'pass', 'pass']), verify: id => pass(id),
                     expect: (r, h) => /RE-READ THE FROZEN SPEC AT /.test((h.prompts['critique:correctness'] || [])[0] || '') &&
                       /frozen spec at /.test((h.prompts['verify:r1'] || [])[0] || '') },
    // COHERENCE runs once per round, at the escalate tier, when more than one region was edited.
    // Parallel workers each edit blind to the others, so only a whole-artifact owner can see a break
    // that exists BETWEEN regions — per-item verifiers are scoped to their region by construction.
    coherenceRuns: { critique: () => CRIT(['fail', 'fail', 'pass']), verify: id => pass(id),
                     expect: (r, h) => (h.counts['coherence'] || 0) >= 1 && h.models['coherence'] === 'opus' },
    // ...and NOT when there is nothing to reconcile. One edited region cannot break another one, so
    // paying an opus agent to look is pure cost. The guard is `worked.length < 2`.
    coherenceSkipped: { critique: () => CRIT(['fail']), verify: id => pass(id),
                     expect: (r, h) => (h.counts['coherence'] || 0) === 0 && r.converged === true },
    // A coherence crash is deliberately NOT a gap. The pass is a repair, not a mandate: it claims no
    // criterion is met, so a failed reconciliation leaves the round exactly as unreconciled as never
    // running it, and the per-item verdicts still decide. If this raised a gap, a flaky reconciler
    // could pin an otherwise-clean run to `blocked` — a repair step vetoing verified work.
    coherenceCrash: { critique: () => CRIT(['fail', 'fail', 'pass']), verify: id => pass(id),
                     coherence: () => null,
                     expect: r => r.converged === true && r.status === 'converged' },
    // KEEP-BEST + REGRESSION FEED-FORWARD. r1 passes in round 1, then fails its re-measure: it loses
    // credit (correct — a regressed criterion is not still passing), so the composite FALLS. The run
    // must remember its peak rather than report its last number, name the criterion that fell, and
    // put it in front of the panel next round. `regressed` holds only ids that WERE passing, so an
    // ordinary first-time failure never lands there.
    // r3 fails throughout, which is what keeps the run alive past round 1 — an all-pass round converges
    // immediately and a criterion that is never re-measured can never be seen to regress. The first
    // version of this scenario had exactly that hole and passed round 1 with nothing to observe.
    keepBest:      { critique: n => (n === 1 ? CRIT(['pass', 'pass', 'fail']) : CRIT(['fail', 'pass', 'fail'])),
                     verify: (() => { let r1 = 0
                       return id => (id === 'r3' ? fail(id, 'major')
                                   : id === 'r1' ? (++r1 > 1 ? fail(id, 'major') : pass(id))
                                   : pass(id)) })(),
                     expect: (r, h) => r.best > r.composite && r.bestRound >= 1 && r.regressed.includes('r1') &&
                       (h.prompts['critique:correctness'] || []).some(p => /REGRESSIONS FIRST/.test(p) && /r1/.test(p)) },
    // A DEAD PANEL MUST NOT LAUNDER A STUCK CRITERION. Ported from the retired converger skill's
    // harness, which is the only invariant of its 18 that no scenario here already covered under
    // another name. r1 fails its re-measure every round, so its streak should reach STUCK_AFTER and
    // change its prompt. On one middle round the whole panel dies, so r1 is not dispatched at all —
    // and the question is whether the round it spent missing RESETS the streak. It must not: `fails`
    // is cleared by a passing verdict, and a round with no verdict is not a passing one. If absence
    // reset it, an intermittently-crashing critic would hold an item permanently below the threshold
    // and it would never escalate — a stuck item hidden by the thing that failed to look at it.
    // The round budget is what makes this discriminating rather than decorative. r1 fails every round
    // it is dispatched, and the panel dies on round 3 so it is not dispatched then. Holding the streak:
    // failures land on rounds 1, 2, 4 and the directive fires on round 5. Resetting on the missing
    // round: the count restarts and the directive could not fire before round 7. The cap sits at 6, so
    // the two readings give different answers instead of the same one a round apart.
    gapHoldsStreak: { dryRounds: '9', maxRounds: String(STUCK_AFTER + 3),
                     critique: n => (n === 3 ? null : CRIT(['fail', 'pass', 'pass'])),
                     verify: id => (id === 'r1' ? fail(id, 'major') : pass(id)),
                     expect: (r, h) => (h.prompts['work:r1'] || []).some(p => p.includes('STUCK:')) },
  },
}

let failures = 0
for (const [mode, scns] of Object.entries(SCENARIOS)) {
  for (const [inv, scn] of Object.entries(scns)) {
    const driver = loadDriver(mode, scn.maxRounds, scn.dryRounds, scn.mandates)
    const h = harness(scn)
    let r
    try {
      r = await driver(h.agent, h.parallel, h.pipeline, h.log, h.phase, h.budget, h.args)
    } catch (e) {
      // A scenario may assert a STARTUP REFUSAL instead of an outcome: a knob that is present but
      // inert has no run to inspect, so the throw itself is the invariant, and its message must name
      // the knob — an unnamed refusal sends the reader back to guessing which number is wrong.
      const ok = scn.throws ? scn.throws(e) : false
      if (!ok) failures++
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${mode.padEnd(10)} ${inv.padEnd(18)} → refused: ${e.message.slice(0, 48)}`)
      continue
    }
    if (scn.throws) {   // it ran: the guard that should have refused it is missing
      failures++
      console.log(`FAIL  ${mode.padEnd(10)} ${inv.padEnd(18)} → expected a startup refusal, ran ` +
        `${r.rounds} round(s) to status=${r.status}`)
      continue
    }
    const ok = scn.expect(r, h)
    if (!ok) failures++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${mode.padEnd(10)} ${inv.padEnd(18)} → ` +
      `status=${r.status} converged=${r.converged} rounds=${r.rounds} confirmed=${r.confirmed} ` +
      `blocked=${r.blocked} backstop=${r.hitBackstop}`)
  }
}
// ---- BOARD PARITY: the workbench must have a badge for every status the template can emit -------
// The map in assets/workbench.html carried a comment saying "every status is mapped explicitly: a
// negative one falling through to the default is how a bad ending renders as a benign one" — and two
// statuses were missing from it, so `unwitnessed` and `undocumented` both rendered in the same amber
// as a benign `stopped`. A run that verified everything and showed a human nothing looked like a
// normal stop, on the board that exists to reveal precisely that. The comment was the control, and a
// comment is advice. This is the same class of fix as the launch gate itself: make it a test.
//
// It reads BOTH artifacts and compares them — never a hand-typed list, which would just be a third
// place to forget. Statuses come out of the template's own ternary ladder plus every archetype's
// `doneStatus`; badges come out of the workbench's own map object. The floors below are the
// anti-vacuity guard: if either extraction silently stops matching, the sets go empty and an empty
// set is a subset of everything, so the check would pass forever having compared nothing.
const WORKBENCH = resolve(dirname(TEMPLATE), 'workbench.html')
const parity = (ok, name, detail) => { if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${'board'.padEnd(10)} ${name.padEnd(18)} → ${detail}`) }
{
  const ladderAt = SOURCE.indexOf('\nconst status =')
  const ladder = ladderAt < 0 ? '' : SOURCE.slice(ladderAt, SOURCE.indexOf('\n\n', ladderAt))
  const emitted = new Set([...ladder.matchAll(/'([a-z_]+)'/g)].map(m => m[1]))
  for (const m of SOURCE.matchAll(/^\s*doneStatus: '([a-z_]+)'/gm)) emitted.add(m[1])
  emitted.add('running')   // written by writeLedger every round; the board renders it too

  let WB = ''
  try { WB = readFileSync(WORKBENCH, 'utf8') } catch { /* reported by the floor below */ }
  const mi = WB.indexOf('const map={')
  const mapSrc = mi < 0 ? '' : WB.slice(mi, WB.indexOf('};', mi))
  const mapped = new Map([...mapSrc.matchAll(/([a-z_]+)\s*:\s*'(b-[a-z]+)'/g)].map(m => [m[1], m[2]]))

  // The floors. 14 statuses and 14 badges today; the numbers only say "the extraction still works".
  const floors = emitted.size >= 12 && mapped.size >= 12 &&
    ['blocked', 'stopped', 'unwitnessed', 'undocumented', 'running'].every(s => emitted.has(s))
  parity(floors, 'extraction', `${emitted.size} status(es) from the template, ${mapped.size} badge(s) ` +
    `from the workbench (both must be >= 12, or these checks are comparing nothing)`)

  const missing = [...emitted].filter(s => !mapped.has(s))
  parity(floors && missing.length === 0, 'statusParity',
    missing.length ? `NOT mapped in ${WORKBENCH}: ${missing.join(', ')}` : 'every emitted status has a badge')

  // A failed reporting gate must not LOOK like a benign stop. Mapping it to the same class as
  // `stopped` satisfies the parity check above while changing nothing a person would see, which is
  // the defect one level down.
  const benign = mapped.get('stopped')
  const distinct = benign && mapped.get('unwitnessed') && mapped.get('undocumented') &&
    mapped.get('unwitnessed') !== benign && mapped.get('undocumented') !== benign
  parity(!!distinct, 'gateBadgeDistinct',
    `stopped=${benign} unwitnessed=${mapped.get('unwitnessed')} undocumented=${mapped.get('undocumented')}`)

  // A badge class with no CSS rule renders as an unstyled span: mapped, and still invisible.
  const unstyled = [...new Set(mapped.values())].filter(c => !WB.includes(`.${c}{`))
  parity(mapped.size > 0 && unstyled.length === 0, 'badgeStyled',
    unstyled.length ? `mapped but never styled: ${unstyled.join(', ')}` : 'every badge class has a CSS rule')
}

console.log(failures === 0
  ? '\nAll loop-safety invariants hold across every archetype.'
  : `\n${failures} invariant(s) BROKEN.`)
process.exit(failures === 0 ? 0 : 1)
