// Autonomous loop — dynamic Workflow driver (TEMPLATE, all five archetypes).
//
// One kernel, five modes. The kernel below is IDENTICAL for every archetype: fresh-context
// workers, a ledger held as a file (never in script variables — anti-rot), worker≠verifier
// separation, counted progress computed in code, FAIL-CLOSED verification, a hard blocker gate,
// a budget ceiling, and live observability writes. Only three things change per archetype, and
// they are isolated in the MODES table:
//
//   frontier(state)   -> the next batch of work items, or [] when the frontier is dry
//   verify contract   -> how a worker's output is checked (always by a DIFFERENT agent)
//   stop(state)       -> the archetype's terminal predicate (positive vs exhausted vs never)
//
// Pick ONE archetype, set MODE, and fill only that mode's block plus the angle-bracket fill
// markers in Config. The kernel below carries NONE of them — that is what lets the launch gate
// (scripts/preflight_launch.mjs) hash it and prove a filled driver still IS the kernel. The other
// modes are reference implementations — keep them as documentation or delete them.
//
// Design invariants — do NOT remove; each maps to a guardrail in references/kernel.md:
//   - a worker never verifies its own output (self-preference is causal)
//   - progress is COUNTED from verified atoms in the driver, never a model-emitted gestalt score
//     (this includes the converger's composite — it is verified-passing/total, NOT a panel number)
//   - progress is MONOTONE: `everConfirmed` only grows, so an atom counts the first time it is
//     confirmed and never again — nothing a model can re-emit buys the run another round
//   - a crashed/absent verifier, a verdict in a shape the kernel cannot read, or a frontier poll
//     that answers with nothing, is an UNVERIFIED mandate: the item does NOT advance to done, the
//     gap makes the whole round unproductive, and the run cannot report a positive terminal status
//     while any mandate is unverified
//   - an open blocker pins the status to `blocked` — it can never be averaged, dried, or
//     plateaued away by other items succeeding; it does NOT cut short a run that is still landing
//     new atoms, and it ends the run once BLOCKER_PATIENCE rounds pass without the set growing
//   - artifacts and large state pass by FILE PATH; the driver's own context stays thin
//   - every round writes progress.json + artifacts; the driver has no fs, so the AGENTS write them
//   - every round also REWRITES HANDOFF.md — a run that dies mid-flight must still leave a document a
//     fresh agent can pick up from, describing the round it died in. progress.json is counted state,
//     machine-shaped; it is not a handoff
//   - the two REPORTING gates (a capture was shown, a handoff was left) are decided by a separate
//     terminal AUDIT that reads the files — never by the ledger writer's report about its own edit,
//     which is guardrail #1 broken inside the kernel. A dead auditor demotes; it can never promote
//
// Before running:  node scripts/selfcheck_loops.mjs   (zero-token proof the invariants hold)
//                  python scripts/workbench_server.py <<LEDGER_DIR>>   (bundled; live dashboard)

export const meta = {
  name: 'loop-<<TARGET>>',
  description: 'Autonomous <<ARCHETYPE>> loop over <<TARGET>> until its terminal predicate fires or budget runs out',
  phases: [
    { title: 'Frontier' },
    { title: 'Work' },
    { title: 'Verify' },
    { title: 'Ledger' },
  ],
}

// ---- Config (from the run's knobs; see SKILL.md Step 5 "Knobs") ---------------------------
const MODE = '<<ARCHETYPE>>'              // converger | exhauster | saturator | explorer | sentinel
const MAX_ROUNDS = <<MAX_ROUNDS>>         // hard cap on cycles, or `null` for UNBOUNDED — the archetype's own
                                          // predicates (reachedGoal / DRY_ROUNDS / blockers / budget) end the run
const RUNAWAY_BACKSTOP = 200              // bounds an unbounded run. A safety rail, NOT a plan: reaching it means
                                          // the stop predicate is broken, not that the work is done. It sits far
                                          // below the Workflow tool's 1000-agent lifetime cap.
const UNBOUNDED = MAX_ROUNDS === null
const ROUND_LIMIT = UNBOUNDED ? RUNAWAY_BACKSTOP : MAX_ROUNDS
const PASS_THRESHOLD = <<PASS_THRESHOLD>> // converger: composite that means "bar met"
const DRY_ROUNDS = <<DRY_ROUNDS>>         // converger/saturator/explorer: consecutive no-progress rounds ⇒ stop.
                                          // The CONVERGER reads it too — it is that archetype's plateau, and the only
                                          // thing that ends an unbounded run sitting below the bar. Never 0: `dry >= 0`
                                          // holds at round 0, so the run would exit green having verified nothing.
                                          // EXPLORERS DEFAULT TO 3, not 2. Since the charter froze the explorer's atom
                                          // space, its plateau no longer means "the planner ran out of ideas" — it means
                                          // COVERAGE SATURATED: no round added a (sub-question × finding) cell the run did
                                          // not already hold. An honest deep drill that spends two rounds nailing ONE
                                          // sub-question adds no new cell while it does so, and at 2 it would be cut off
                                          // mid-drill. This is a knob, not a branch: nothing in the code reads MODE here.
const MAX_RETRIES = <<MAX_RETRIES>>       // exhauster: retries before an item is blocked, not done
const STUCK_AFTER = 3                     // consecutive VERIFIED failures on ONE item before its prompt changes
const BLOCKER_PATIENCE = 3                // rounds that are BOTH stuck (a blocker or an unverified gap open) and
                                          // unproductive (`everConfirmed` did not grow) ⇒ `blocked`. Same counter,
                                          // same reset rule and same field name it has always had (`stall`).
const BATCH = <<BATCH>>                   // max work items pulled from the frontier per round
const RESERVE = 50_000                    // stop before the budget is fully drained
const LEDGER_DIR = '<<LEDGER_DIR>>'       // ephemeral run dir served by the workbench
const LEDGER = LEDGER_DIR + '/progress.json'
const HANDOFF = LEDGER_DIR + '/HANDOFF.md'   // the PICKUP DOCUMENT: what a fresh agent reads to continue this
                                          // run. Rewritten every round (never appended to) so a run that dies
                                          // at round 40 still leaves one that describes round 40. Derived from
                                          // LEDGER_DIR exactly like LEDGER, so it carries no fill marker.
const ACTIVITY = LEDGER_DIR + '/activity.jsonl'  // append-only; what the board shows BETWEEN ledger writes.
                                          // writeLedger fires once per ROUND, and a round runs for minutes, so
                                          // without this the board is frozen for the whole time work is actually
                                          // happening — and a frozen board is indistinguishable from a hung run,
                                          // which is the one question a person watching a long loop is asking.
                                          // The driver cannot write it (no filesystem access), so the agents that
                                          // ALREADY run each round append to it. No extra agent, no extra round.
const ACTIVITY_LOG = true                 // set false only where prompt budget is tighter than observability
const VERIFIED_COMMITS = true             // "this run's TARGET is a git working tree" (issue #8
                                          // subtask 2, evolved by subtask 3, spec: attempt-isolation-
                                          // design): every worker isolates its attempt in its own git
                                          // worktree/branch, an independent verifier checks that
                                          // isolated attempt, and a single sequential Merge phase lands
                                          // it on the shared tree ONLY on a clean merge — so the
                                          // canonical artifact is always the last green, MERGED commit,
                                          // and a failed or conflicted attempt never touches the tree
                                          // everyone else reads. Set false only when TARGET is not a
                                          // git working tree (a design canvas, a live system, a non-VCS
                                          // artifact). SET IT CORRECTLY — it is not self-disabling:
                                          // the worker and verifier directives gate on this constant
                                          // alone, so a `true` on a non-git TARGET hands every worker
                                          // a `git worktree add` that cannot run. Only the Merge
                                          // phase probes the tree itself (`git rev-parse
                                          // --is-inside-work-tree`), and it never runs when nothing
                                          // verified pass. Read directly by
                                          // worktreeDirective, worktreeVerifyDirective, the Merge phase,
                                          // and retryDirective — never branched on by MODE.
const BRIEF = LEDGER_DIR + '/BRIEF.md'    // the intake, written BEFORE the run and gated by the launch gate
                                          // (scripts/preflight_launch.mjs BRIEF). The handoff carries its
                                          // framing forward so "what this run is for" is the human's answer,
                                          // not a restatement of TARGET. Read defensively — a driver started
                                          // outside the gate has no brief.
const SKILL_DIR = '<<SKILL_DIR>>'         // where this skill lives, so a round can invoke its scripts
                                          // (check_harness.mjs). Passed rather than derived: the driver
                                          // runs as a workflow script with no filesystem and no __dirname,
                                          // so it cannot find its own skill by looking.
const RUNS_LOG = '<<RUNS_JSONL_PATH>>'    // stable longitudinal log; one summary line per run
const SOURCE = '<<SOURCE>>'               // the frontier's source (queue file / repo / question / stream)
const TARGET = '<<TARGET>>'               // what this run is against, in the user's words. Config, not kernel:
const RUN_ID = '<<RUN_ID>>'               // every fill marker lives ABOVE the kernel so the kernel stays byte-
                                          // identical across all five archetypes and every filled driver, which
                                          // is the property the launch gate checks. Never inline one below.
const LENSES = <<LENSES>>                 // saturator: distinct search lenses, e.g. ['by-file','by-pattern']
const INVARIANTS = <<INVARIANTS>>         // sentinel: invariants to hold, e.g. ['tests green','p95<200ms']
const MANDATES = <<MANDATES>>             // converger: the critic panel's DISTINCT mandates, written
                                          // `key: the brief`. The key names the critic in labels and on
                                          // the atom; everything after the first colon is interpolated
                                          // into that critic's prompt, so write a real brief:
                                          //   ['spec: every acceptance criterion, cite the evidence',
                                          //    'perf: measured regressions only, cite the number']
                                          // A bare word is legal and weak — "correctness" tells a critic
                                          // almost nothing, and N vague critics are one critic N times.
                                          // The useful split is artifact-specific, which is why this is a
                                          // knob; that they DIFFER is not optional.
const SPEC = '<<SPEC>>'                   // converger: path to the FROZEN spec — the Bar, in writing.
                                          // Re-read from this path by every critic, every round, rather
                                          // than summarized into the driver once: a bar the driver
                                          // paraphrases is a bar that drifts, and drift is invisible
                                          // because the paraphrase always looks like the spec.

// ---- EFFORT: the one knob that prices the models ---------------------------------------------
// A loop's model cost used to be a hand-edit of the tier map — easy to get wrong and invisible
// afterwards, because nothing recorded that a run had been detuned, so a thrifty run and a thorough
// one produced ledgers that read identically.
//
// One named knob resolves the whole tier map, written into the brief and onto the board (see `head`
// below). The default is `balanced`. Nothing in the KERNEL reads EFFORT: it resolves entirely here in
// Config, so the hashed regions stay byte-identical across every setting and DESCENT is unaffected by
// how a run is priced. Evidence CADENCE is its own knob (`EVIDENCE_EVERY`, below), because how often a
// run photographs itself is a fact about the WORK, not about how much you are willing to spend on it.
const EFFORT = '<<EFFORT>>'               // 'thrifty' | 'balanced' | 'quality-first'

// Measured, and this is why the knob is worth having rather than just telling people to use haiku:
// across 8 real runs, 61% of a WORKER's tokens were spent before its first edit — orientation, not
// work — while repo reading was 2.5% of wall-clock. So thrift and speed are different axes. Dropping
// a tier buys tokens and buys almost no time; the time lives in tests and external waits. Anyone
// reaching for this to make a slow loop fast should read that sentence twice and go tune the atom
// instead — a smaller atom is the only thing that reliably shortens a round.
const EFFORT_PLAN = {
  // Verification never drops BELOW the worker's tier, at any setting. A verifier weaker than the
  // agent it grades is not a cheaper loop, it is an ungrounded one — guardrail #1 with the teeth
  // filed off — and it fails in the direction that looks like success.
  thrifty: {
    tier: { mechanical: { model: 'haiku', effort: 'low' }, work: { model: 'haiku' },
            verify: { model: 'sonnet' }, escalate: { model: 'sonnet', effort: 'high' } },
  },
  balanced: {
    tier: { mechanical: { model: 'haiku', effort: 'low' }, work: { model: 'sonnet' },
            verify: { model: 'sonnet' }, escalate: { model: 'opus', effort: 'high' } },
  },
  'quality-first': {
    tier: { mechanical: { model: 'sonnet', effort: 'low' }, work: { model: 'opus' },
            verify: { model: 'opus', effort: 'high' }, escalate: { model: 'opus', effort: 'max' } },
  },
}
// Fail LOUD, not to a default. A typo'd effort silently running `balanced` is a run whose cost the
// operator has been told is something it is not, and the ledger would agree with them.
if (!EFFORT_PLAN[EFFORT]) throw new Error(`EFFORT must be one of ${Object.keys(EFFORT_PLAN).join(' | ')}, got '${EFFORT}'`)
const TIER = EFFORT_PLAN[EFFORT].tier

// How often the run stops to produce a capture. It governs BOTH capture paths on the same clock: the
// per-item verifier capture (`captureClause`) and the ledger writer's hero capture (`writeLedger`),
// so `0` disables collection everywhere rather than in one place. `n` = capture on rounds where
// `round % n === 0`; `0` = this loop bears no evidence at all and says so once, up front, instead of
// discovering it round by round.
//
// Priced from the corpus: a real capture cost a mean of 69 seconds (11 runs, 19.6s-140.2s) and 12.4%
// of one run's wall clock. That is worth paying for a round that CHANGED something a person can see,
// and pure waste for a round that refactored an internal seam. But cadence alone is the blunt fix —
// the sharp one is per-item (`bearsEvidence` on a queue item), because "which rounds are worth
// photographing" is a fact about the WORK, not about the calendar.
const EVIDENCE_EVERY = <<EVIDENCE_EVERY>>
// True on a round the run should photograph: cadence must be enabled and this round must land on it.
// One helper so the hero capture and the per-item capture cannot drift onto different clocks.
function capturesThisRound(round) { return EVIDENCE_EVERY > 0 && round % EVIDENCE_EVERY === 0 }

// ---- Knob check ---------------------------------------------------------------------------
// Presence is not a value. A filled-in but MEANINGLESS numeric knob reads as a filled template and
// silently disarms a terminal predicate — DRY_ROUNDS = 0 makes the plateau true at round 0, so the
// run exits `stopped`, zero rounds, exit 0, having verified nothing. Check the VALUE of every knob a
// predicate divides on, and name the offender: the person filling this in is picking numbers per
// archetype and has no other signal that one of them is inert.
const BAD_KNOBS = [
  ['DRY_ROUNDS', DRY_ROUNDS, Number.isInteger(DRY_ROUNDS) && DRY_ROUNDS >= 1, 'an integer >= 1'],
  ['MAX_RETRIES', MAX_RETRIES, Number.isInteger(MAX_RETRIES) && MAX_RETRIES >= 0, 'an integer >= 0'],
  ['BATCH', BATCH, Number.isInteger(BATCH) && BATCH >= 1, 'an integer >= 1'],
  ['PASS_THRESHOLD', PASS_THRESHOLD, PASS_THRESHOLD > 0 && PASS_THRESHOLD <= 1, 'a fraction in (0, 1]'],
  ['MAX_ROUNDS', MAX_ROUNDS, UNBOUNDED || (Number.isInteger(MAX_ROUNDS) && MAX_ROUNDS >= 1), 'null, or an integer >= 1'],
  // 0 is a REAL answer here and the only knob in this list where it is: "this loop bears no evidence"
  // is a legitimate, common shape (three of five measured runs were text-only). It must be said on
  // purpose though — the witness gate reads a deliberate 0 very differently from a run that meant to
  // capture and never managed it, and this is where that intent gets recorded.
  ['EVIDENCE_EVERY', EVIDENCE_EVERY, Number.isInteger(EVIDENCE_EVERY) && EVIDENCE_EVERY >= 0, 'an integer >= 0 (0 = this loop bears no evidence)'],
].filter(([, , ok]) => !ok).map(([k, v, , want]) => `${k}=${JSON.stringify(v)} (want ${want})`)
if (BAD_KNOBS.length > 0) {
  throw new Error(
    `Loop knob out of range: ${BAD_KNOBS.join('; ')}. Fix it in the Config block above ` +
    `(see SKILL.md Step 5 "Knobs") before running. Every archetype reads DRY_ROUNDS except the ` +
    `exhauster and the sentinel, so 0 there is not "not applicable" — it is an instant stop.`)
}

// The same defect one TYPE over: a collection knob that is empty. `DRY_ROUNDS = 0` is caught above
// because a number can be out of range; `[]` looks like a filled knob and disarms the predicate it
// feeds just as completely.
//
//   MANDATES = []   no critic runs, so no criterion ever fails, so every criterion "passes" and the
//                   converger reports `converged` against an artifact nothing read.
//   LENSES = []     no finder runs, so every round surfaces nothing, so DRY_ROUNDS of nothing is a
//                   plateau and the saturator reports `saturated` having searched nowhere.
//   INVARIANTS = [] nothing can be violated, so the sentinel holds perfect health forever.
//
// All three are green terminal statuses earned by doing no work — the vacuous pass, arrived at through
// a knob rather than a missing assertion. Checked only for the archetype that READS the knob; the
// other four leave it empty legitimately, and failing them would teach people to fill it with noise.
const FLEET = { converger: ['MANDATES', MANDATES, 'critique with'],
                saturator: ['LENSES', LENSES, 'search with'],
                sentinel:  ['INVARIANTS', INVARIANTS, 'hold'] }[MODE]
if (FLEET) {
  const [name, value, verb] = FLEET
  // Distinct, not merely present: two identical mandates are two identical critics, which is diversity
  // collapse by construction rather than by drift (references/failure-modes.md §5).
  const ok = Array.isArray(value) && value.length >= 1 &&
    value.every(v => typeof v === 'string' && v.trim() !== '') &&
    new Set(value).size === value.length
  if (!ok) {
    throw new Error(
      `Loop knob out of range: ${name}=${JSON.stringify(value)}. The ${MODE} reads it and needs a ` +
      `non-empty array of DISTINCT non-empty strings. Empty does not mean "no preference" — it means ` +
      `this run has nothing to ${verb}, and the terminal predicate then fires green having done nothing.`)
  }
}

// A verifier returns THIS, never prose. The kernel counts from it; it never reads a vibe score.
//
// `additionalProperties: false` is load-bearing, not tidiness. The kernel builds each accepted atom by
// spreading the verdict over the work item, so ANY key this schema does not declare is a field the
// VERIFIER gets to set on the ITEM — and the item's fields are what the counters and the terminal
// predicates read. One unasked-for key (`terminal: true`) was enough to make an ordinary experiment
// latch `answered`. The schema closes it at the tool layer; `fromVerdict` below closes it in code, for
// the mocked and malformed returns a schema never sees. Both, because either alone is a single point.
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'pass', 'evidence'],
  properties: {
    id:       { type: 'string' },   // the work item this verdict is about
    pass:     { type: 'boolean' },  // did the worker's output meet the item's done-criterion?
    evidence: { type: 'string' },   // the concrete checkable signal (test output, diff, measurement)
    severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'none'] }, // failures only
    novel:    { type: 'boolean' },  // saturator/explorer: did this add something NOT already known?
    // EXPLORER ATTRIBUTION. The two fields that make the explorer's atom space finite, and they are
    // the VERIFIER's to fill — never the planner's, which is the whole point: the planner names the
    // experiment, the independent verifier says what the RESULT bears on and which way it went. A
    // planner that could write its own attribution could mint a fresh cell by re-labelling, which is
    // the defect the charter exists to close (see MODES.explorer.countsAsProgress).
    bears_on: { type: 'string' },   // the CHARTERED sub-question id this result bears on
    finding:  { type: 'string', enum: ['supports', 'refutes', 'no-effect', 'inconclusive'] },
  },
}
// Read out of the schema, never re-typed, so the two can't drift apart.
const SEVERITIES = new Set(VERDICT_SCHEMA.properties.severity.enum)
// Same rule, same reason, for the explorer's finding enum: the cell key is built from this string, so
// an unconstrained field would let a re-worded finding ("supported", "SUPPORTS") mint a fresh cell out
// of the same result — the reworded-id defect one layer down from the id it just replaced.
const FINDINGS = new Set(VERDICT_SCHEMA.properties.finding.enum)
// And the same readout once more, for the keys themselves: `fromVerdict` (shared helpers) narrows a
// verdict to exactly these before it is spread over a work item, so a field this schema does not
// declare can never reach the item — which is what stops a verifier setting the item's control fields.
const VERDICT_KEYS = Object.keys(VERDICT_SCHEMA.properties)

// Schemas the frontier agents return (fill fields/mandates per target).
// `status` carries an enum for the same reason `severity` does: the converger's frontier tests it for
// one exact string, so an unconstrained field lets `FAIL` or `failed` read as "not failing" — a criterion
// the panel just marked broken goes into the run as passing, and the composite rises on it.
// What the ledger writer reports back about the HERO SLOT and the HANDOFF DOCUMENT. Two enums,
// because the driver has no fs and would otherwise have to take "the board leads with the picture"
// and "the run is documented as it goes" on trust. Both fields report what is ON DISK after the edit,
// never what the writer intended — and NEITHER gates anything any more: this is the writer's word
// about the writer's own file, which is guardrail #1 (a worker never verifies its own output) broken
// inside the kernel. It is BOARD STATE, carried onto progress.json so a watcher can see the round
// where the writer's claim and the audit's finding diverge. The gates read the AUDIT below.
// `traps` rides back with the report so the DRIVER can carry it forward, which is the one thing in
// the handoff a fresh writer genuinely cannot re-derive. Measured: the ledger writer was the most
// expensive bookkeeping agent in the corpus — worst case 244,870 tokens over 45 turns to apply a
// merge it had already been handed — and most of that was re-reading HANDOFF.md and progress.json to
// reconstruct context the prompt contained. Handing the traps back down costs a few hundred bytes of
// driver state and removes the only honest reason to open the old file.
const LEDGER_SCHEMA      = { type: 'object', additionalProperties: false, required: ['hero', 'handoff'], properties: { hero: { type: 'string', enum: ['artifact', 'none', 'absent'] }, handoff: { type: 'string', enum: ['written', 'absent'] }, traps: { type: 'array', items: { type: 'string' } } } }
// ATTEMPT ISOLATION (issue #8 subtask 3, spec: attempt-isolation-design). A new schema, forced by a
// failure mode subtask 2's commit-per-pass never had: unlike a commit of files the verifier JUST
// examined on the SAME tree (which cannot meaningfully conflict), a `git merge` of an isolated
// attempt's branch CAN genuinely fail to apply cleanly against a mainline that moved since the
// attempt's worktree branched. The kernel needs a structured answer to keep that fail-closed, the
// same way `usable(v)` keeps a malformed verdict fail-closed — free text is not enough to safely
// decide "did this verified pass actually land". `additionalProperties: false` for the same reason
// every other schema in this file has it: nothing an agent invents here should reach driver state.
const MERGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['merged', 'conflicts'],
  properties: {
    merged:    { type: 'array', items: { type: 'string' } },   // ids that landed on the shared tree
    conflicts: { type: 'array', items: {                        // ids verify passed but did not land
      type: 'object', additionalProperties: false, required: ['id', 'evidence'],
      properties: { id: { type: 'string' }, evidence: { type: 'string' } },
    } },
  },
}
// THE AUDIT. One cheap agent, after the last round and before the terminal status is computed, that
// READS the ledger dir and answers about the files. Deliberately TINY — five scalars — because it is
// the only thing between a reporting gate and the agent it grades, and every field it carries is a
// field somebody could be tempted to reason from instead of measure. `handoffRound` is what makes
// staleness detectable at all: a handoff describing round 3 and one describing round 40 are the same
// file to any check that only asks whether it exists.
// `distinctCaptures` is the same idea aimed at the pictures, and it was added for a measured failure:
// a run whose capture harness broke mid-flight kept "capturing" every round, and every frame it wrote
// was byte-identical to round 1's. Four files on disk, one image. `captures` alone says 4 and reads
// as a healthy gallery; `captures` beside `distinctCaptures` says 4-and-1 and reads as what it is — a
// jammed camera. Counting frames without looking at them is the unverified-atom defect once more, in
// the one place the kernel had been counting rather than checking.
const AUDIT_SCHEMA       = { type: 'object', additionalProperties: false, required: ['hero', 'handoff', 'handoffRound', 'captures', 'distinctCaptures'], properties: { hero: { type: 'string', enum: ['artifact', 'none', 'absent'] }, handoff: { type: 'string', enum: ['complete', 'incomplete', 'absent'] }, handoffRound: { type: 'integer' }, captures: { type: 'integer' }, distinctCaptures: { type: 'integer' } } }
// The terminal step is the only writer of the FINAL board: it stamps the terminal status into
// progress.json, appends the run's line to runs.jsonl, and finalizes HANDOFF.md. It had no schema and
// nothing read its return, so a dead finalize left progress.json reading "running" forever — a
// finished run that the board, the history log and the pickup document all still describe as in
// flight. One boolean, surfaced in the driver's return: it can never promote anything (the status is
// already computed above it), it can only tell the caller the run ended and the board did not.
const FINALIZE_SCHEMA    = { type: 'object', additionalProperties: false, required: ['finalized'], properties: { finalized: { type: 'boolean' } } }
const CRITERIA_SCHEMA    = { type: 'object', required: ['total', 'criteria'], properties: { total: { type: 'integer' }, criteria: { type: 'array', items: { type: 'object', required: ['id', 'status'], properties: { id: { type: 'string' }, status: { type: 'string', enum: ['pass', 'fail'] }, region: { type: 'string' }, fix: { type: 'string' } } } } } }
const CRITERION_STATUSES = new Set(CRITERIA_SCHEMA.properties.criteria.items.properties.status.enum)
// `bearsEvidence` is declared but NOT required: a queue written before this field existed still
// enumerates, and `captureClause` treats a missing value as "capture it" — the safe direction, since
// the cost of a redundant frame is 69 seconds and the cost of a missing one is an unwitnessed run.
const QUEUE_SCHEMA       = { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'object', required: ['id', 'task'], properties: { id: { type: 'string' }, task: { type: 'string' }, bearsEvidence: { type: 'boolean' } } } } } }
const CANDIDATES_SCHEMA  = { type: 'object', required: ['candidates'], properties: { candidates: { type: 'array', items: { type: 'object' } } } }
const EXPERIMENTS_SCHEMA = { type: 'object', required: ['experiments'], properties: { experiments: { type: 'array', items: { type: 'object' } } } }
// THE EXPLORER'S CHARTER — the one thing that gives an open question a FINITE atom space.
//
// Every other explorer counter used to key on an id the PLANNER made up, so a planner that re-worded
// the same experiment under a new id read as fresh work forever: `seen` never matched, `dry` never
// accumulated, and the plateau could not fire by construction. The saturator had the identical defect
// and closed it by keying on file:line — a space the loop cannot grow. A hypothesis has no file:line,
// so the explorer borrows the converger's mechanism instead: a space FROZEN at round 1 and re-injected
// verbatim every round thereafter. Everything the run can ever count is a cell of
// (chartered sub-question × finding), so the count is bounded by the decomposition, not by the
// planner's vocabulary. CHARTER_MAX bounds it at 4 × (8 + 1) = 36 cells.
const CHARTER_MAX = 8
const CHARTER_SCHEMA = { type: 'object', required: ['subquestions'], properties: { subquestions: { type: 'array', items: { type: 'object', required: ['id', 'question'], properties: { id: { type: 'string' }, question: { type: 'string' } } } } } }
const VIOLATIONS_SCHEMA  = { type: 'object', required: ['violations'], properties: { violations: { type: 'array', items: { type: 'object' } } } }

// ---- MODES: the ONLY archetype-specific code. Fill the one you picked. --------------------
// Each mode implements:
//   init(state)                    seed the frontier
//   frontier(state) -> [items]     next batch (or [] when dry/empty)
//   workerPrompt(item, state)      instruction for a fresh worker
//   verifyPrompt(item, out, state) instruction for a fresh, independent verifier
//   key(item, v) -> string         dedup identity (saturator/explorer)
//   countsAsProgress(v,state,key)  does a passing verdict advance the count?
//   resolve(state, item)           mark an item done (remove from open / latch a terminal)
//   retry(state, item)             return an item to the frontier, or blocked after MAX_RETRIES
//   tally(state)                   recompute the counted metric IN CODE from verified atoms (optional)
//   progress(state) -> 0..1        a normalized progress fraction for the dashboard trajectory
//   stop(state) -> bool            terminal predicate checked at the top of each round
//   reachedGoal(state) -> bool     did the SUCCESS condition hold (not merely "we stopped")?
//   inconclusive(state) -> bool    optional: this stop was legitimate but NOT positive ⇒ `inconclusive`
//   doneStatus                     the status string for a positive finish
const MODES = {
  // CONVERGER — drive ONE artifact to a bar. The rubric-design guide, the partition model and its
  // generator are this skill's own (references/rubric-design.md, scripts/gen_partition.py); the DRIVER
  // is still thinner than they are — see the KNOWN GAP in references/archetypes.md. The panel PROPOSES the rubric and
  // which criteria fail; it does NOT score convergence. The composite is a DRIVER count of
  // independently-verified passing criteria (kernel #3) — a panel that self-reports all-pass cannot
  // converge the run unless a separate verifier agrees.
  converger: {
    doneStatus: 'converged',
    async init(state) { state.total = 0; state.composite = 0; state.passing = new Set(); state.rubric = null
                        state.best = 0; state.bestRound = 0; state.regressed = new Set() },
    async frontier(state) {
      // A PANEL — one fresh-context critic per mandate, in parallel, exactly like the saturator's
      // lenses and for the same reason. `references/failure-modes.md` §5: N critics with the same brief
      // converge on the same easy findings, so the run goes blind to whole classes of defect while
      // looking busy. Distinct mandates are what make the coverage real, and the driver stamps the
      // mandate from the loop variable so a critic can neither claim another's nor invent a sixth.
      const reports = await parallel(MANDATES.map(mandate => () =>
        agent(
          // RE-ANCHOR. The spec is named by PATH and re-read by the critic every round, never carried
          // in the driver as a summary. A driver that paraphrases the bar once and re-injects its own
          // paraphrase forever cannot detect that it has drifted, because the paraphrase always
          // matches the spec — itself. Reading the file also makes a mid-run edit to the spec take
          // effect at the next round, which is how a checkpointed run changes its goal.
          `RE-READ THE FROZEN SPEC AT ${SPEC} VERBATIM before judging anything; it is the bar, and it ` +
          `outranks anything you remember from earlier rounds. ` +
          // REGRESSIONS FIRST. A criterion that passed and stopped passing is worth more attention than
          // one that never passed: something the loop already did broke it, so it is evidence about the
          // run's own edits rather than about the artifact's backlog. The list is the DRIVER's, built
          // from verdicts, so no critic can quietly drop an inconvenient regression by not mentioning it.
          (state.regressed.size
            ? `REGRESSIONS FIRST — these criteria PASSED an independent re-measure in an earlier round ` +
              `and no longer do: ${[...state.regressed].join(', ')}. Judge them before anything else and ` +
              `say what changed. ` : '') +
          `You are the "${mandateKey(mandate)}" critic on ${SOURCE}. Your mandate: ${mandateBrief(mandate)}. ` +
          `Report ONLY criteria inside that mandate — another critic owns the rest, and duplicating ` +
          `theirs costs the panel the coverage it exists for. Return the rubric for YOUR mandate: ` +
          `{total, criteria:[{id, region, status:"pass"|"fail", fix}]} where total = criteria.length and ` +
          `fix is the concrete change for a failing criterion (omit for a passing one). Reuse the ` +
          `rubric's own criterion ids VERBATIM every round — every counter keys on them, so a re-worded ` +
          `id is discarded as unverified rather than treated as a new criterion.`,
          { ...TIER.verify, phase: 'Frontier', label: `critique:${mandateKey(mandate)}`, schema: CRITERIA_SCHEMA })))
      // A critic that crashed judged nothing — it did not find nothing. Dropped silently (the tempting
      // `.filter(Boolean)`), a round in which every critic died looks like a clean all-pass rubric: no
      // criterion fails, nothing is blocked, nothing is unverified, so the frontier is dry, the plateau
      // fires, and a run whose panel never ran reports `converged`. Each dead critic is an UNVERIFIED
      // GAP that ages patience and pins the status. `parallel` preserves order and puts `null` in place,
      // so reports[i] is MANDATES[i]'s report and the association survives a death.
      let dropped = 0
      const merged = new Map()
      reports.forEach((r, i) => {
        if (!Array.isArray(r?.criteria)) { state.roundGap = true; return }
        for (const c of r.criteria) {
          // A criterion with no string id names nothing the counters can key on — it would freeze into
          // the rubric as `undefined` and a verdict on it would be confirmed like any other, a criterion
          // nobody wrote lifting the composite. A status outside the enum is the same defect one level
          // down: the failing-filter below tests one exact string, so `FAIL` falls through it as "not
          // failing" and enters the run as a criterion nobody has to fix. Both are dropped, and every
          // drop raises the round's gap rather than quietly shrinking the denominator.
          if (!c || typeof c.id !== 'string' || !CRITERION_STATUSES.has(c.status)) { dropped++; continue }
          const prev = merged.get(c.id)
          // FAIL WINS when two mandates disagree about one id. This is not a tie to average: the
          // performance critic passing a criterion the correctness critic failed does not make the
          // defect go away, and letting a pass overwrite a fail would let the loop launder a real
          // failure through whichever critic happened to answer second.
          if (!prev || (prev.status === 'pass' && c.status === 'fail')) {
            merged.set(c.id, { id: c.id, region: c.region, fix: c.fix || prev?.fix || '',
                               status: c.status, mandate: mandateKey(MANDATES[i]) })
          }
        }
      })
      // The rubric FREEZES on the first panel — the UNION across mandates — and its ids are this run's
      // atom vocabulary. A panel that re-words an id later is drifting, not finding a new criterion:
      // admitting the new id would let one reworded blocker open a fresh blocked entry every round,
      // when the count is meant to be per defect. An unrecognised id is fail-closed: dropped, gap raised.
      const named = [...merged.values()]
      if (!state.rubric) state.rubric = new Set(named.map(c => c.id))
      const known = named.filter(c => state.rubric.has(c.id))
      // Count DROPS, not the merged-vs-raw difference. Two mandates legitimately reporting the same id
      // is a merge, not a defect, so comparing sizes would raise a gap on every well-behaved round.
      dropped += named.length - known.length
      if (dropped > 0) state.roundGap = true
      state.total = state.rubric.size
      // Emit every criterion still needing an independent verdict this run: each failing one (fix +
      // re-measure) plus each not-yet-confirmed-passing one (a first independent check). This is why
      // the panel's word alone can't converge the loop — every criterion goes through VERIFY.
      const items = known
        .filter(c => c.status === 'fail' || !state.passing.has(c.id))
        // `mandate` rides the item into the atom and the ledger, so which critic's lane a defect came
        // from survives into the record. It is set here from the merge, never from a verdict:
        // `fromVerdict` narrows a verifier's return to the schema's own keys, so a verifier cannot
        // reassign a finding to a mandate that did not raise it.
        .map(c => ({ id: c.id, region: c.region, fix: c.fix || '', proposed: c.status, mandate: c.mandate }))
      // Re-feed still-open blocked regions so a passing re-verify can clear them. NEVER clear a
      // blocker just because the panel stopped reporting it — clearance requires a real passing
      // verdict from the separate verifier (worker≠verifier).
      for (const b of openBlockers(state)) {
        if (!items.some(it => it.id === b.id)) items.push({ id: b.id, region: b.region, fix: b.fix || '', proposed: 'fail', mandate: b.mandate })
      }
      return items
    },
    workerPrompt: (item) => item.proposed === 'fail'
      ? `Fix criterion ${item.id} in region ${item.region}: ${item.fix}. Edit only this region. ` +
        `The frozen spec at ${SPEC} is the bar — read it; do not infer it from the fix text.`
      : `Criterion ${item.id} (region ${item.region}) is reported passing. Make NO edit; return "noop".`,
    // The verifier re-anchors on the SAME path as the panel. A verifier judging against its own idea
    // of the bar is a second bar, and the run would converge on whichever of the two is looser.
    verifyPrompt: (item) => `Independently re-measure criterion ${item.id} in region ${item.region} ` +
      `against the frozen spec at ${SPEC}, re-read verbatim. Pass ONLY on a concrete grounded signal ` +
      `(a test, measurement, or diff). A disqualifying failure is severity=blocker. Cite evidence.`,
    // Single-owner reconciliation over the whole artifact — see the kernel's step 3c for why it runs
    // AFTER Merge (issue #8 subtask 3: relocated from before Verify). One agent, at the escalate tier,
    // because judging whether an artifact hangs together is the hardest read in the round and the
    // cheapest place to be wrong. It edits only what just-merged regions broke BETWEEN each other; it
    // may not fix criteria, or it becomes a second builder whose work nothing independently verifies.
    async coherence(state, worked) {
      if (worked.length < 2) return   // one region landed, or none: nothing to reconcile
      await agent(
        `Read the ENTIRE artifact at ${SOURCE} and the frozen spec at ${SPEC}, verbatim. These items ` +
        `just MERGED into the shared tree this round, each from its own isolated worktree, without ` +
        `sight of each other while it worked: ${worked.map(w => w.region || w.id).join(', ')}. ` +
        `Reconcile them: fix breaks that exist only BETWEEN regions — a shared helper changed under ` +
        `another region, duplicated logic, an interface renamed on one side, imports or types that no ` +
        `longer line up. Do NOT fix a criterion, and do not touch anything that is not a cross-region ` +
        `break: a separate verifier already re-measured every criterion BEFORE it merged, and work you ` +
        `do inside a region here is work nothing independently checks THIS round. ` +
        (VERIFIED_COMMITS
          ? `You are editing the SHARED tree directly (not a worktree — the attempts already merged). ` +
            `Nothing else in this run commits the shared tree, so COMMIT what you change here or it ` +
            `is lost: \`git add -A && git commit -m "coherence: reconcile round"\` when you are done. ` +
            `If you changed nothing, commit nothing and leave \`git status\` clean — an uncommitted ` +
            `edit left behind does not just vanish from the record, it blocks the NEXT round's merge ` +
            `of any attempt touching the same file. Either way, finish on a clean \`git status\`. `
          : ``) +
        `Return a one-line summary of what you reconciled, or "none".`,
        { ...TIER.escalate, phase: 'Coherence', label: 'coherence' })
    },
    key: (item) => item.id,
    countsAsProgress: (v, state, key) => !state.passing.has(key),   // count each criterion once
    resolve(state, item) { state.passing.add(item.id) },
    // A failed re-measure loses credit. `Set.delete` returns true only if the id WAS passing, which is
    // exactly the definition of a regression — a criterion failing for the first time is not one, and
    // conflating the two would fill the regression list with ordinary open work.
    retry(state, item) { if (state.passing.delete(item.id)) state.regressed.add(item.id) },
    // KEEP-BEST. The composite can fall — a criterion whose re-measure fails loses its credit, which is
    // correct, because a criterion that regressed is not still passing. What must not happen is the
    // fall going unrecorded, leaving the run to report its LAST number as though it were its best. The
    // high-water mark and the round that set it are kept here, in the driver, from counted atoms.
    //
    // Deliberately NOT wired to the stop predicate. The predecessor converger plateaued on
    // `composite <= best + EPS`; this kernel plateaus on `dry` — rounds that confirmed no NEW atom —
    // which is the stronger test, because a run can climb the composite by re-confirming atoms it had
    // already counted and a delta-based plateau would read that as progress. Two mechanisms for one
    // job is how they drift apart, so this one records and the other decides.
    tally(state) {
      state.composite = state.total > 0 ? state.passing.size / state.total : 0
      if (state.composite > state.best) { state.best = state.composite; state.bestRound = state.round }
    },
    progress: (state) => state.composite,
    stop(state) {
      // Two ways to end: the bar, or a PLATEAU — DRY_ROUNDS rounds that confirmed no new criterion.
      // Without the plateau clause an unbounded converger whose composite never reaches the bar has
      // nothing to end it and rides RUNAWAY_BACKSTOP. Stopping is not succeeding: reachedGoal still
      // wants the bar, so a plateau below it finishes `stopped`, never `converged`.
      if (state.dry >= DRY_ROUNDS) return true
      const eff = (hasOpenBlocker(state) || state.gap) ? Math.min(state.composite, PASS_THRESHOLD - 1e-3) : state.composite
      return eff >= PASS_THRESHOLD
    },
    reachedGoal(state) { return !hasOpenBlocker(state) && !state.gap && state.composite >= PASS_THRESHOLD },
  },

  // EXHAUSTER — drive a KNOWN, enumerable queue to verified-empty. Frontier = pop from the queue.
  exhauster: {
    doneStatus: 'drained',
    async init(state) {
      // `bearsEvidence` is asked at ENUMERATION, once, rather than decided per round by whoever
      // happens to be verifying. Two reasons, and the second is the one that matters.
      //
      // Cost: a real capture measured a mean of 69 seconds across 11 runs, and running one for a pure
      // refactor buys nothing — there is no visible change to photograph.
      //
      // Truth: a capture taken for an item that changes nothing a person can SEE does not come back
      // empty, it comes back looking like the last one. Measured on loop-475 — the harness kept
      // photographing the same empty state for an internal-seam item, and the frame it produced was
      // byte-identical to round 1's while the board counted the round as progress. An item that
      // declares itself evidence-free is honest and cheap; an item that captures anyway manufactures
      // a frame indistinguishable from the baseline, which is worse than no frame at all.
      const q = await agent(`Enumerate every work item in ${SOURCE}. Return {items:[{id, task, bearsEvidence}]}. ` +
        `\`bearsEvidence\` is true only if finishing this item changes something a person could SEE — ` +
        `a rendered surface, an output, a measurable number. A pure refactor, an internal seam, a test-only ` +
        `change or a rename bears NO evidence: say false. When you genuinely cannot tell, say true and let ` +
        `the verifier spend the capture; a missing frame is a worse error than a redundant one.`,
        { ...TIER.mechanical, phase: 'Frontier', label: 'enumerate', schema: QUEUE_SCHEMA })
      // An enumerate that died is an UNVERIFIED GAP, never an empty queue — and here that distinction
      // is the whole run: empty makes `open.size === 0` true before round 1, so stop() fires, reachedGoal
      // compares 0 === 0, and the loop reports `drained / converged / rounds:0` having enumerated
      // nothing. The gap has no round to live in, so it is recorded as a blocker instead: it pins the
      // status, it survives to the terminal ladder, and only a real enumeration opens the drained path.
      const raw = Array.isArray(q?.items) ? q.items : null
      if (raw == null) {
        state.blocked.push({ id: 'enumerate', severity: 'blocker', evidence: `could not enumerate ${SOURCE}` })
        return
      }
      // An item with no string id is an unnamed mandate: it keys nothing, yet it would count toward
      // `total` and be "drained" like any other. An item with no non-empty `task` is the same defect
      // one step in: it keys, but the worker is handed `undefined` for what to do and can return a
      // passing verdict for unspecified work. Both are malformed the same way — same treatment as the
      // dead enumerate, a blocker, so the queue can still be worked while the run can never report
      // `drained` over a partial read.
      const items = raw.filter(it => it && typeof it.id === 'string' && typeof it.task === 'string' && it.task.trim() !== '')
      if (items.length !== raw.length) {
        state.blocked.push({ id: 'enumerate', severity: 'blocker',
          evidence: `${raw.length - items.length} malformed item(s) in ${SOURCE} (missing id or task)` })
      }
      state.total = items.length
      for (const it of items) state.open.set(it.id, { ...it, tries: 0 })
    },
    async frontier(state) { return [...state.open.values()].filter(it => it.tries <= MAX_RETRIES) },
    workerPrompt: (item) => `Complete queue item ${item.id}: ${item.task}. Produce the change it asks for.`,
    verifyPrompt: (item, out, state) => `Independently check item ${item.id}'s done-criterion for: ${item.task}. ` +
      `Pass only on concrete evidence.` + captureClause(item, state),
    key: (item) => item.id,
    countsAsProgress: () => true,
    progress: (state) => state.total ? state.confirmed.length / state.total : 0,
    resolve(state, item) { state.open.delete(item.id) },
    retry(state, item) {
      const it = state.open.get(item.id); if (!it) return
      it.tries++
      if (it.tries > MAX_RETRIES) {
        if (!state.blocked.some(b => b.id === item.id))
          state.blocked.push({ id: item.id, severity: 'blocker', evidence: `unverified after ${MAX_RETRIES} retries` })
        state.open.delete(item.id)
      }
    },
    stop(state) { return state.open.size === 0 },   // every item resolved (to done OR to blocked)
    reachedGoal(state) { return state.open.size === 0 && !hasOpenBlocker(state) && state.confirmed.length === state.total },
  },

  // SATURATOR — find EVERY instance of an unknown-size set. No builder; finders + adversarial
  // verify. Frontier = heterogeneous finders returning NEW candidates. Stop = K dry rounds.
  saturator: {
    doneStatus: 'saturated',
    async init() {},
    async frontier(state) {
      const found = await parallel(LENSES.map(lens => () =>
        agent(`Search ${SOURCE} for instances of ${TARGET} using the ${lens} lens. ` +
          `\`where\` MUST be a stable LOCATOR for the place — file:line, symbol, endpoint, ticket id — ` +
          `never a description of it. The locator is the identity; put your prose in \`claim\`. ` +
          `Return {candidates:[{where,claim}]}.`,
          { ...TIER.work, phase: 'Frontier', label: `find:${lens}`, schema: CANDIDATES_SCHEMA })))
      // A finder that crashed searched nothing — it did not find nothing. Dropped silently (the
      // tempting `.filter(Boolean)`), a round in which every lens died looks DRY, and DRY_ROUNDS of
      // those report `saturated`: every instance found because every searcher died. So a lens that
      // answered with no candidate list is an unverified gap for the round.
      const alive = found.filter(r => Array.isArray(r?.candidates))
      if (alive.length !== found.length) state.roundGap = true
      // THE ID IS THE LOCATOR, NEVER THE FINDER'S PROSE. This is the fix for the recorded limit that
      // the saturator's ids used to come from the finder itself: an agent that re-words the same
      // finding under a new id reads as fresh work, `seen` never matches, `dry` never accumulates,
      // and the run stands on the budget ceiling alone with no terminal predicate that can fire.
      // Keying on the PLACE closes it — a re-worded claim at the same file:line collides with the
      // first one and buys the run nothing.
      //
      // The trade, stated rather than hidden: two genuinely different findings at one locator collapse
      // into one atom. That is the correct semantics for the canonical saturator ask ("find every
      // place that does X") — it counts PLACES, not claims about places. If a run truly needs several
      // distinct atoms per site, the locator is too coarse: make it finer (file:line:symbol), never
      // hand identity back to the model.
      // Whitespace only. NOT case: `File.rs` and `file.rs` are different files, `Foo` and `foo` are
      // different symbols, and folding them merges two real atoms into one — a silent undercount,
      // which is the same class of defect this whole change exists to remove.
      const locus = (w) => w.trim().replace(/\s+/g, ' ')
      const cands = alive.flatMap(r => r.candidates)
      // A candidate with no locator is the unverified gap one level down: `seen` and `everConfirmed`
      // key on the id, so an unlocated one enters as `undefined`, gets worked, and is counted as a
      // find — one phantom instance per round, all colliding on the same key. It is a gap, not a
      // candidate. (An `id` the finder volunteers is IGNORED, not trusted.)
      const located = cands.filter(c => c && typeof c.where === 'string' && c.where.trim().length > 0)
      if (located.length !== cands.length) state.roundGap = true
      const byLocus = new Map()   // two lenses finding the same place is ONE atom, not two
      for (const c of located) { const id = locus(c.where); if (!byLocus.has(id)) byLocus.set(id, { ...c, id }) }
      const fresh = [...byLocus.values()].filter(c => !state.seen.has(c.id))
      // Re-offer every still-open blocker FIRST — `seen` drops it from the finders' output forever and
      // only a passing verdict on that id can clear it, so without this it could never be reworked and
      // never clear. First, so a full batch of fresh candidates can't starve it.
      const reoffer = openBlockers(state)
        .filter(b => !fresh.some(it => it.id === b.id))
        .map(b => ({ id: b.id, where: b.where, claim: b.claim, severity: 'blocker' }))
      return [...reoffer, ...fresh]
    },
    workerPrompt: (item) => `Gather the concrete evidence for candidate ${item.id} at ${item.where}: ${item.claim}.`,
    verifyPrompt: (item) => `Adversarially verify candidate ${item.id}. Try to REFUTE "${item.claim}". Pass only if it survives; set novel=true if genuinely new.`,
    key: (item) => item.id,
    countsAsProgress: (v, state, key) => v.novel !== false && !state.seen.has(key),
    progress: (state) => DRY_ROUNDS ? Math.min(1, state.dry / DRY_ROUNDS) : (state.confirmed.length ? 1 : 0),
    resolve() {},
    retry() {},   // re-offered by the frontier above, not from here
    // A dry frontier is the predicate; a blocker only pins the status. But a round whose finders died
    // is not a dry round — dryness is a claim about the SEARCH, not about the searchers — so a gap
    // holds the plateau shut and patience, not the plateau, ends a run of dead lenses.
    stop(state) { return state.dry >= DRY_ROUNDS && !state.gap },
    reachedGoal(state) { return state.dry >= DRY_ROUNDS && !hasOpenBlocker(state) },
  },

  // EXPLORER — answer an open question by iterated hypothesize→test→ground. Frontier = the next
  // experiments generated from prior GROUNDED results, EVERY ONE OF THEM ANCHORED TO A FROZEN
  // CHARTER. Stop = the charter's coverage saturates or the answer is GROUNDED — the terminal
  // "answer" latches ONLY when a designated terminal claim passes an independent verifier, never on
  // the planner's own say-so (kernel #2/#3).
  explorer: {
    doneStatus: 'answered',
    async init(state) {
      state.answered = false
      state.charter = new Set()    // FROZEN sub-question ids: the run's entire atom space
      state.charterQs = []         // the same, verbatim, for re-injection into every planner prompt
      state.covered = new Set()    // MONOTONE set of `<subq>|<finding>` cells already established
      state.pending = new Map()    // id -> the item dispatched this round; rebuilt per frontier call,
                                   // so driver state stays bounded by BATCH (kernel #6). It is what
                                   // lets countsAsProgress — which is handed only (v, state, key) —
                                   // see whether the atom under judgement was the TERMINAL claim.
      // ONE agent, ONCE, before round 1. The decomposition is the frozen space, so it is worth the
      // escalation tier: everything this run can ever count is a cell of it.
      const ch = await agent(
        `Question: ${SOURCE}\n` +
        `Decompose it into AT MOST ${CHARTER_MAX} sub-questions that together cover it — each one ` +
        `separately answerable by experiment or measurement, none a restatement of another. This ` +
        `decomposition is FROZEN for the whole run and is the only vocabulary any later round can ` +
        `use, so prefer fewer, broader, genuinely distinct sub-questions over many narrow ones. ` +
        `Return {subquestions:[{id, question}]} with short stable ids.`,
        { ...TIER.escalate, phase: 'Frontier', label: 'charter', schema: CHARTER_SCHEMA })
      // FAIL-CLOSED, and by the exhauster's dead-enumerate precedent exactly — for the same reason it
      // exists there: no round has happened yet, so a gap has NOWHERE to live. A per-round flag raised
      // before round 1 is forgotten before it is read, and an empty charter would drop every
      // experiment, dry the frontier and report `inconclusive` — "the question stayed open" for a run
      // whose decomposer never answered. So it is recorded as a BLOCKER, which survives to the
      // terminal ladder and pins the status.
      const raw = Array.isArray(ch?.subquestions) ? ch.subquestions : null
      const named = (raw || []).filter(s => s && typeof s.id === 'string' && typeof s.question === 'string')
      if (raw == null || named.length === 0 || raw.length > CHARTER_MAX) {
        state.blocked.push({ id: 'charter', severity: 'blocker',
          evidence: raw == null ? `could not decompose ${SOURCE} into sub-questions`
            : named.length === 0 ? `charter returned ${raw.length} entry(s), none well-formed`
            : `charter returned ${raw.length} sub-questions, over CHARTER_MAX=${CHARTER_MAX}` })
        // With no charter there is no space to explore, so the frontier is dry BY CONSTRUCTION and
        // for the rest of the run. Say so, and the unchanged stop() fires before round 1 — the run
        // ends at zero rounds with the blocker open, exactly as a dead enumerate does, instead of
        // spending BLOCKER_PATIENCE rounds asking a planner for experiments it can never admit.
        state.dry = DRY_ROUNDS
        return
      }
      // A malformed ENTRY inside an otherwise usable charter is the same gap one level down, and the
      // exhauster's unnamed-item rule applies unchanged: keep working the sub-questions that ARE
      // named, and record a blocker so the run can never report `answered` over a decomposition it
      // only half read. The space is frozen — a sub-question dropped here is dropped for the run.
      if (named.length !== raw.length) {
        state.blocked.push({ id: 'charter', severity: 'blocker',
          evidence: `${raw.length - named.length} malformed sub-question(s) dropped from the charter` })
      }
      state.charterQs = named.map(s => ({ id: s.id, question: s.question }))
      for (const s of state.charterQs) state.charter.add(s.id)
    },
    async frontier(state) {
      // Pass grounded state by PATH plus a BOUNDED recent tail — never the whole growing array
      // (kernel #6). The full claims log the ledger step appends lives at claims.jsonl.
      const recent = state.confirmed.slice(-BATCH).map(c => ({ id: c.id, evidence: c.evidence }))
      const plan = await agent(
        `Question: ${SOURCE}\n` +
        // VERBATIM, EVERY ROUND. The charter is re-injected rather than summarized or paraphrased for
        // the same reason the converger re-feeds its rubric ids: the moment the planner is working
        // from its own restatement of the space, the space is no longer frozen.
        `CHARTER (frozen at round 1 — the ONLY sub-questions this run can answer): ` +
        `${JSON.stringify(state.charterQs)}\n` +
        `Coverage so far: ${state.covered.size} of ${4 * (state.charter.size + 1)} ` +
        `(sub-question × finding) cells established.\n` +
        `Grounded claims so far: ${state.confirmed.length} (full log at ${LEDGER_DIR}/claims.jsonl). ` +
        `Most recent: ${JSON.stringify(recent)}\n` +
        `Propose the next experiments/reads that would most change the answer. EVERY experiment MUST ` +
        `carry "subq": the id of the chartered sub-question it bears on, copied VERBATIM from the ` +
        `charter above; one naming anything else is DROPPED and the round is recorded as gapped. ` +
        `Say plainly what this means for you: YOUR "id" IS NOT IDENTITY. Re-wording an experiment ` +
        `under a fresh id buys this run nothing at all — progress is counted in ` +
        `(chartered sub-question × finding) cells, so a second experiment that lands on a cell the ` +
        `run already holds is not progress however it is phrased. Propose something that could land ` +
        `on a cell we do not have, or say the space is covered. When the evidence already answers the ` +
        `question, propose ONE terminal claim ` +
        `{id, subq, hypothesis:"<the answer>", method:"restate + cite the grounding", terminal:true} ` +
        `so a separate verifier can ground it. Return {experiments:[{id,subq,hypothesis,method,terminal}]}.`,
        { ...TIER.escalate, phase: 'Frontier', label: 'hypothesize', schema: EXPERIMENTS_SCHEMA })
      // A planner that crashed proposed nothing — it did not conclude there is nothing left to test.
      // Empty dries the frontier, and `inconclusive` then reports a legitimate "the question stayed
      // open" for a run whose instrument died. That is the same laundering as the rest of this class,
      // so it is a gap: it ages patience and the run ends `blocked`.
      const proposed = Array.isArray(plan?.experiments) ? plan.experiments : (state.roundGap = true, [])
      // Same gap one level down: an experiment with no string id keys nothing, and `terminal` is the
      // field that latches the run's POSITIVE status — so it is normalized to a real boolean here
      // rather than read for truthiness, where `terminal:"no"` would end the run `answered` on an
      // experiment the planner never designated as the answer.
      const named = proposed.filter(e => e && typeof e.id === 'string')
      if (named.length !== proposed.length) state.roundGap = true
      // THE FROZEN SPACE, ENFORCED. An experiment naming a sub-question that is not in the charter is
      // DROPPED — the converger's unrecognised-criterion precedent, and for its reason: admitting it
      // would hand the atom space back to the model, which is the defect the charter closes.
      const chartered = named.filter(e => typeof e.subq === 'string' && state.charter.has(e.subq))
      const offCharter = named.filter(e => !chartered.includes(e))
      if (offCharter.length > 0) {
        state.roundGap = true
        // AND RECORD WHAT IT ASKED FOR. A drop that leaves no trace makes an explorer which found a
        // genuinely new line of enquiry mid-run merely STUCK: it ends `blocked` with nothing on the
        // board but a gap. The proposed sub-question TEXT is the difference between that and a
        // legible escalation — the human reading HANDOFF.md's "Open blockers" sees "the run wants to
        // add: <text>", re-charters, and resumes. Deduped by the proposed id so a planner asking for
        // the same thing every round opens ONE entry, not one per round.
        for (const e of offCharter) {
          const id = `off-charter:${e.subq}`
          if (!state.blocked.some(b => b.id === id)) {
            state.blocked.push({ id, offCharter: true, severity: 'blocker',
              evidence: `the run wants to add: "${String(e.subq).slice(0, 120)}" — ` +
                `${String(e.hypothesis || '').slice(0, 200)}. Re-charter and resume; this run cannot ` +
                `admit it, because the charter is frozen.` })
          }
        }
      }
      const fresh = chartered.filter(e => !state.seen.has(e.id))
        .map(e => ({ id: e.id, ...e, terminal: e.terminal === true }))
      // Re-offer every still-open blocker (a refuted load-bearing claim, or a refuted answer) FIRST:
      // `seen` drops it from the planner's output forever, and only a passing verdict on that id clears it.
      // An off-charter record is NOT re-offered: it is not a claim anybody can re-verify, it is a
      // request for a human to widen the charter. Re-offering it would send a worker to run an
      // experiment the counter is required to drop.
      const reoffer = openBlockers(state)
        .filter(b => b.offCharter !== true && b.id !== 'charter' && !fresh.some(it => it.id === b.id))
        .map(b => ({ id: b.id, subq: b.subq, hypothesis: b.hypothesis, method: b.method, terminal: b.terminal, severity: 'blocker' }))
      const items = [...reoffer, ...fresh]
      state.pending = new Map(items.map(it => [it.id, it]))
      return items
    },
    workerPrompt: (item) => item.terminal
      ? `Assemble the answer and the concrete evidence that supports it: ${item.hypothesis}. Cite the grounded claims.`
      : `Run experiment ${item.id}. Hypothesis: ${item.hypothesis}. Method: ${item.method}. Report the raw result.`,
    // THE VERIFIER OWNS THE ATTRIBUTION. It is asked for `bears_on` and `finding` on every verdict,
    // pass or fail, because those two fields are what the count is made of — and the agent that
    // proposed the experiment must not be the one that says what its result established.
    verifyPrompt: (item, out, state) => (item.terminal
      ? `Adversarially ground the ANSWER "${item.hypothesis}". Try to refute it against the evidence. Pass ONLY if it holds. A refuted answer is severity=blocker. `
      : `Ground the claim from experiment ${item.id}. Try to refute it. Pass only if the evidence holds; a refuted load-bearing claim is severity=blocker; novel=true if it changed the answer. `) +
      `Then ATTRIBUTE the result yourself, from this frozen charter: ${JSON.stringify(state.charterQs)}. ` +
      `Set "bears_on" to the id of the ONE chartered sub-question this result actually bears on — the ` +
      `planner proposed "${item.subq}", which you may confirm or correct, and you may not invent an id ` +
      `that is not in that list — and set "finding" to exactly one of ` +
      `${JSON.stringify([...FINDINGS])}: whether the result supports the hypothesis, refutes it, shows ` +
      `no effect, or is inconclusive. Attribute what the EVIDENCE shows, not what was hoped for.`,
    key: (item) => item.id,
    // THE FIX — the whole reason the charter exists. Progress is a CELL of the frozen space
    // (sub-question × finding), never anything a model names. A planner that re-words the same
    // experiment under a fresh id every round, with a verifier passing it on fresh evidence every
    // time, lands on the SAME cell every round: it counts once and the run plateaus. The identical
    // defect ran the saturator to 200 rounds counting 200 confirmed atoms from ONE re-worded finding.
    countsAsProgress: (v, state, key) => {
      const item = state.pending.get(key)
      // An attribution the kernel cannot read is an UNVERIFIED MANDATE, not a cheap "no progress":
      // the item is RETAINED so `gap` stays open until some later verdict reads for that id. Retention
      // is what stops the worst case — an unattributed TERMINAL claim, where resolve() latches
      // `answered` on the pass and only the open mandate keeps the run from reporting it.
      if (typeof v.bears_on !== 'string' || !state.charter.has(v.bears_on) || !FINDINGS.has(v.finding)) {
        state.roundGap = true
        state.unverified.set(key, item || { id: key })
        return false
      }
      // The terminal claim is the answer, not a finding about a part of the question, so it gets its
      // own bucket — otherwise grounding the answer would be indistinguishable from one more result
      // on whichever sub-question it happened to cite.
      const cell = item && item.terminal ? `answer|${v.finding}` : `${v.bears_on}|${v.finding}`
      return !state.covered.has(cell)
    },
    // MONOTONE, like every other counter in this kernel: cells only ever accumulate, and they are
    // recomputed here from the atoms the kernel actually ACCEPTED this round (each carries the
    // verifier's own bears_on/finding), never from anything countsAsProgress stashed on the way past.
    tally(state) {
      for (const a of state.roundAccepted) {
        state.covered.add(a.terminal ? `answer|${a.finding}` : `${a.bears_on}|${a.finding}`)
      }
    },
    // Coverage of the frozen space: 4 findings × every chartered sub-question, plus the answer bucket.
    // Bounded at 4 × (CHARTER_MAX + 1) = 36 cells, which is what bounds the run: at most 36 productive
    // rounds, so ~111 rounds in the pathological alternation, well under RUNAWAY_BACKSTOP.
    progress: (state) => state.answered ? 1 : state.covered.size / (4 * (state.charter.size + 1)),
    resolve(state, item) { if (item.terminal) state.answered = true },   // latches ONLY on a verified terminal claim
    retry() {},   // re-offered by the frontier above, not from here
    stop(state) { return state.answered || state.dry >= DRY_ROUNDS },   // a blocker pins the status, it doesn't extend the run
    // Only the VERIFIED terminal claim is an answer. Surprise saturating is a legitimate reason to
    // STOP, but not a positive one: a run whose terminal claim was refuted, or that never proposed
    // one, would otherwise report `answered` with converged=true and zero grounded claims.
    reachedGoal(state) { return state.answered && !hasOpenBlocker(state) && !state.gap },
    inconclusive(state) { return !state.answered && state.dry >= DRY_ROUNDS },   // stopped, question open
  },

  // SENTINEL — a standing loop: watch, detect drift, repair, confirm. NEVER converges; success is
  // "invariants held across cycles". Bounded by budget/time/MAX_ROUNDS, not by a positive stop. A
  // blocked violation clears when a later poll independently confirms the invariant holds again.
  // Run unbounded it therefore rides RUNAWAY_BACKSTOP and finishes `held` with hitBackstop=true — for
  // this one archetype that is the design, not a broken predicate, so the status stays `held`. Bound a
  // standing watch with budget or a numeric MAX_ROUNDS; the rail is a rail, never the sentinel's stop.
  sentinel: {
    doneStatus: 'held',   // reported only if every invariant held with no open violation
    async init() {},
    async frontier(state) {
      const drift = await agent(`Poll ${SOURCE}. Which of these invariants are violated right now: ${JSON.stringify(INVARIANTS)}? ` +
        `Copy each violated invariant back VERBATIM from that list — the clear path matches on the string, ` +
        `so a re-worded one neither clears its old entry nor counts as a new violation. ` +
        `Return {violations:[{id,invariant,detail,severity}]} — [] if all hold.`,
        { ...TIER.verify, phase: 'Frontier', label: 'poll', schema: VIOLATIONS_SCHEMA })
      // FAIL-CLOSED. A poll that returns nothing, or anything that is not a violations array, is an
      // UNVERIFIED GAP — never "all invariants hold". A watcher that stopped answering says nothing
      // about the watched system, so it ages patience, it cannot report `held`, and it must not clear
      // an open violation. Silence here used to read as health: the one fail-open path in the kernel.
      const raw = Array.isArray(drift?.violations) ? drift.violations : null
      if (raw == null) { state.roundGap = true; return [] }
      const violations = raw.filter(v => v && typeof v.invariant === 'string')
      const partial = violations.length !== raw.length   // a malformed entry ⇒ the poll answered in part
      if (partial) state.roundGap = true
      // Reconcile: an invariant NO LONGER violated has been repaired (this fresh poll is the
      // independent confirmation), so drop its blocked entry — this is the clear path that lets the
      // cycle return to `held`. Also dedup to one blocked entry per invariant. Only a poll that
      // answered IN FULL may clear: a partial answer cannot certify the invariants it never mentioned.
      if (!partial) {
        const violated = new Set(violations.map(v => v.invariant))
        const kept = new Set()
        state.blocked = state.blocked.filter(b => {
          const inv = b.invariant || b.id
          if (!violated.has(inv) || kept.has(inv)) return false
          kept.add(inv); return true
        })
        // Unverified mandates reconcile the same way, and must: this poll is a fresh independent
        // measurement of every invariant, so it supersedes a verdict the kernel could not read about a
        // repair to one that is no longer violated. The sentinel mints a NEW id each round
        // (`${round}:${v.id}`), so nothing else can ever clear that entry — without this, one unread
        // repair-verdict pins the watch to `blocked` for the rest of the run.
        for (const [id, it] of state.unverified)
          if (!violated.has(it.invariant || it.id)) state.unverified.delete(id)
      }
      return violations.map(v => ({ id: `${state.round}:${v.id}`, invariant: v.invariant, detail: v.detail, severity: v.severity }))
    },
    workerPrompt: (item) => `Invariant "${item.invariant}" is violated: ${item.detail}. Repair it. Do not touch anything else.`,
    verifyPrompt: (item) => `Independently confirm invariant "${item.invariant}" now holds. Cite the check. Unrepaired ⇒ severity=blocker.`,
    key: (item) => item.id,
    countsAsProgress: () => true,
    progress: (state) => {
      const open = new Set(openBlockers(state).map(b => b.invariant || b.id))
      return INVARIANTS.length ? 1 - open.size / INVARIANTS.length : (openBlockers(state).length ? 0 : 1)
    },
    resolve() {},
    retry(state, item) {
      if (!state.blocked.some(b => (b.invariant || b.id) === (item.invariant || item.id)))
        state.blocked.push({ id: item.id, invariant: item.invariant, severity: 'blocker', evidence: 'unrepaired violation' })
    },
    stop() { return false },   // never stops on its own; MAX_ROUNDS / budget / an external signal bounds it
    // Clean iff no violation was left open AND the last cycle actually answered: `held` on a dead
    // poller would be the watcher certifying itself.
    reachedGoal(state) { return !hasOpenBlocker(state) && !state.gap },
  },
}

// ---- Kernel (identical for every archetype) -----------------------------------------------
const mode = MODES[MODE]
const state = {
  round: 0,
  seen: new Set(),         // dedup key store (saturator/explorer): NEVER cleared, or it won't converge
  confirmed: [],           // verified atoms accumulated across the run
  everConfirmed: new Set(),// atom ids EVER confirmed. Monotone and never cleared: it is the run's only
                           // definition of progress, so a re-confirmed or flapping id counts exactly once
  open: new Map(),         // id -> item still needing work (exhauster queue / stuck items)
  dry: 0,                  // consecutive rounds with no NEW verified progress
  history: [],             // per-round summary for the trajectory + plateau logic
  blocked: [],             // items with an OPEN blocker (gates the terminal status); an entry is dropped
                           // the round a passing verdict clears it, so this IS the open set
  escalate: new Set(),     // ids to dispatch at the escalation tier next round (kernel #5)
  fails: new Map(),        // id -> CONSECUTIVE failed/unverified rounds; cleared by a passing verdict
  stall: 0,                // rounds that were both stuck (blocker/gap open) and unproductive; only a
                           // newly confirmed atom resets it, so a clean round in between holds it
  roundAccepted: [],       // atoms confirmed THIS round (persisted to the claims log by the ledger)
  traps: [],               // the handoff's "Traps" lines, carried by the DRIVER between rounds. Bounded
                           // hard below, because this is the one place kernel #6 (large state passes by
                           // path, never in driver variables) is bent on purpose: traps are what a fresh
                           // agent cannot re-derive, and re-reading the file to find them was the single
                           // most expensive habit the ledger writer had
  heroLog: [],             // [{round, hero}] EVERY round's hero report, not just the last. `reported`
                           // below keeps the latest for the board; this keeps the SHAPE OF THE RUN,
                           // and the shape is what tells a harness that never worked apart from one
                           // that worked and stopped. Those two produce an identical terminal ledger
                           // — hero.type="none" beside a non-empty artifacts/ — and until this array
                           // existed the gate could only see the second frame of the film. Append-only
                           // and demote-only in effect: a writer that lies "artifact" into an early
                           // round can only make its own run REPORT WORSE later, never better, which
                           // is why the writer's untrusted word is safe to keep here
  reported: null,          // {round, hero, handoff}: what the LAST ledger writer said about its own
                           // edit. BOARD STATE ONLY — it gates nothing. The two reporting gates used to
                           // latch here, which asked the agent that skipped HANDOFF.md whether it wrote
                           // HANDOFF.md; the terminal audit answers that now, and this survives so the
                           // divergence between claim and finding is visible on the board
  // A gap is an UNVERIFIED MANDATE, and "unverified" is a claim about a specific ITEM, not about a
  // round. Two kinds, because they expire differently:
  //   roundGap   — a PRODUCER went blind this round (panel, enumerate, finders, planner, poll). If the
  //                next round's producer answers, that blind spot is genuinely gone, so this resets.
  //   unverified — a SPECIFIC item whose verdict the kernel could not read. It stays open until some
  //                later round returns a usable verdict for THAT id. A verifier that dies once and is
  //                never retried leaves its mandate open for the whole run, which is the honest
  //                record: the run ends `blocked`, not `saturated`.
  // Held as a single per-round boolean, a gap raised in round 1 is forgotten by round 5 and the run
  // reports `converged` over an item nothing ever verified — detection without retention. Every stop
  // predicate and the status ladder read `gap`, so the two kinds combine here, not at each read site.
  roundGap: false,
  unverified: new Map(),   // id -> the item, so a mode can reconcile by its own stable key (see sentinel)
  get gap() { return this.roundGap || this.unverified.size > 0 },
}
await mode.init(state)     // seed the frontier (load the queue, freeze the question, etc.)

while (state.round < ROUND_LIMIT && !mode.stop(state) && withinBudget() && !stalled(state)) {
  state.round++
  state.roundGap = false          // producer blindness is per-round; `unverified` is NOT reset here
  state.roundAccepted = []
  state.roundPassed = []          // every item verified pass AND landed (merged onto the shared tree)
                                  // this round — evidence text for claims.jsonl, not a git operation
                                  // of its own any more (issue #8 subtask 3 moved landing to Merge).
                                  // Distinct from roundAccepted: that one is filtered by
                                  // countsAsProgress/everConfirmed (the archetype's counted metric),
                                  // this one is the raw verify-AND-merge predicate — a re-verified item
                                  // that no longer counts as NEW progress still did real, passing work
                                  // on the artifact and still belongs at HEAD.
  log(`Round ${state.round} — confirmed ${state.confirmed.length}, open ${state.open.size}, dry ${state.dry}`)

  // 1. FRONTIER: archetype-specific source of the next batch. Returns [{id, ...work}] or [].
  phase('Frontier')
  const batch = (await mode.frontier(state)).slice(0, BATCH)
  if (batch.length === 0) {
    // An empty frontier is meaningful, not an error: it's how exhauster/saturator/explorer end.
    state.dry++
    agePatience(state, 0)
    state.history.push(roundEntry(0))
    await writeLedger(state)
    continue
  }

  // 2. WORK: fresh-context workers, one per item, in parallel. A worker that throws → null.
  //    An item carrying a blocker (from the frontier), flagged for escalation, or STUCK gets the
  //    strong tier; a stuck item also gets the change-approach directive appended to its prompt.
  //    Every worker isolates its attempt in its own git worktree/branch (issue #8 subtask 3, spec:
  //    attempt-isolation-design) — see worktreeDirective — so a dead or refuted attempt never touches
  //    the shared tree at all; there is nothing left for a retry to inherit.
  //    Every worker also claims its footprint (files it will touch) before editing — see footprintDirective.
  phase('Work')
  const worked = await parallel(batch.map(item => () =>
    agent(mode.workerPrompt(item, state) + worktreeDirective(item) + footprintDirective(item) + retryDirective(item.id) + stuckDirective(item.id) + activityDirective('Work', `work:${item.id}`),
      { ...((item.severity === 'blocker' || state.escalate.has(item.id) || isStuck(item.id)) ? TIER.escalate : TIER.work),
        phase: 'Work', label: `work:${item.id}` })
      .then(out => ({ item, out }))
  ))

  // 3. VERIFY: a DIFFERENT agent checks each worker's output against the item's done-criterion,
  //    INSIDE that attempt's isolated worktree — never against the shared tree, which has not
  //    changed yet this round (see worktreeVerifyDirective).
  //    FAIL-CLOSED: a crashed worker, a crashed verifier, and a verdict that came back unreadable
  //    (see `usable`) are all NOT a pass.
  //    Its item returns to the frontier (bounded by MAX_RETRIES) and the round is flagged as an
  //    unverified gap, so no positive terminal status can fire while a mandate is unverified.
  phase('Verify')
  const verdicts = await parallel(worked.map(w => () => {
    if (w == null || w.out == null) return null   // worker crash → unverified
    return agent(mode.verifyPrompt(w.item, w.out, state) + worktreeVerifyDirective(w.item) + activityDirective('Verify', `verify:${w.item.id}`),
      { ...TIER.verify, phase: 'Verify', label: `verify:${w.item.id}`, schema: VERDICT_SCHEMA })
  }))

  // 3b. MERGE (issue #8 subtask 3): ONE sequential agent, after Verify, before anything treats a
  //     verified pass as landed. Same reason subtask 2 put commit-per-pass in the Ledger step and not
  //     the (parallel) Verify step: two attempts merging into the shared tree at the same wall-clock
  //     time race the same .git/index a parallel `git commit` would, and here the stakes are higher —
  //     a raced MERGE can corrupt more than a raced commit can. Only items Verify just passed are
  //     worth trying; skipped entirely when none did (same cost discipline as Coherence's own
  //     `worked.length < 2` guard) and a no-op passthrough when VERIFIED_COMMITS is off (no worktrees
  //     were ever created, so there is nothing to merge).
  phase('Merge')
  const toMerge = batch.filter((item, i) => usable(verdicts[i]) && verdicts[i].pass)
  const mergeResult = (VERIFIED_COMMITS && toMerge.length)
    ? await agent(
        `This round's verifiers passed ${toMerge.length} attempt(s): ${JSON.stringify(toMerge.map(m => m.id))}. ` +
        `Each id's branch and worktree path (ids are not legal git refs, so use these EXACTLY as ` +
        `given — never build a branch name out of the id yourself): ` +
        `${JSON.stringify(toMerge.map(m => ({ id: m.id, ...attemptWorktree(m.id) })))}. ` +
        `First check whether the shared tree is inside a git repository (\`git rev-parse ` +
        `--is-inside-work-tree\`); if it is not, report every id above under "merged" (there is ` +
        `nothing to merge against) and stop. Otherwise, for EACH id above, IN ORDER, from the shared ` +
        `tree: \`git merge --no-ff <that id's branch> -m "<id>: merge verified attempt (run ${RUN_ID})"\`. ` +
        `If the ` +
        `branch does not exist, or the merge reports "Already up to date", that attempt was a ` +
        `legitimate no-op — it changed nothing, there is nothing to land and nothing to retry — so ` +
        `report that id under "merged" and move on. If it merges ` +
        `cleanly, remove that attempt's worktree (\`git worktree remove --force <that id's path>\`) ` +
        `and report the id under "merged". If it conflicts, run ` +
        `\`git merge --abort\`, leave the attempt's worktree in place (its branch still holds the ` +
        `work — a retry rebuilds it fresh; this one is just not landing THIS round), and report the ` +
        `id under "conflicts" with the conflicted file list (\`git diff --name-only --diff-filter=U\` ` +
        `BEFORE the abort) as its evidence. Never leave the repo mid-merge: always resolve to a clean ` +
        `\`git status\` — either a completed merge commit or an aborted one — before you finish.`,
        { ...TIER.mechanical, phase: 'Merge', label: 'merge', schema: MERGE_SCHEMA })
    : { merged: toMerge.map(m => m.id), conflicts: [] }
  // FAIL-CLOSED, same posture as `usable(v)`: a crashed or malformed Merge agent (missing/non-array
  // "merged") is treated as NOTHING landed this round, never as "probably fine" — a verified pass the
  // kernel cannot confirm actually reached the shared tree is not counted, not committed, not resolved.
  const merged = new Set((mergeResult && Array.isArray(mergeResult.merged)) ? mergeResult.merged : [])

  // 3c. COHERENCE (issue #8 subtask 3: relocated): an OPTIONAL single-owner pass over the WHOLE
  //     artifact, reconciling attempts that just MERGED this round rather than a raw parallel edit of
  //     the shared tree. Workers no longer edit the shared tree at all — each works in its own
  //     isolated worktree, so before Merge runs the shared tree has not changed yet this round; there
  //     is nothing to reconcile until AFTER a round's passing attempts have actually landed on the one
  //     tree that could show a cross-region break. Only items that both verified pass AND merged are
  //     worth passing in: a failed or conflicted attempt changed nothing on the shared tree.
  //
  //     Optional by design: only an archetype whose workers EDIT ONE SHARED ARTIFACT needs it. A
  //     saturator's finders write nothing and an exhauster's items are independent by construction, so
  //     for them this is a paid agent that reconciles nothing. `if (mode.coherence)` rather than a
  //     no-op default, so that skipping it is a property of the archetype and not a silent omission.
  //
  //     A crash here is NOT a gap. The pass is a repair, not a mandate: nothing has claimed a criterion
  //     is met, so a failed reconciliation leaves the round exactly as unreconciled as not running it
  //     would have, and the per-item verdicts still decide everything. Raising a gap would let a flaky
  //     reconciler pin an otherwise-clean run to `blocked`.
  if (mode.coherence) {
    const landed = batch.filter((item, i) => usable(verdicts[i]) && verdicts[i].pass && merged.has(item.id))
    phase('Coherence')
    await mode.coherence(state, landed)
  }

  // 4. LEDGER: advance state in CODE from the verdicts. Nothing here trusts a worker's self-report.
  phase('Ledger')
  let grew = 0                        // ids `everConfirmed` GAINED this round — the only progress signal
  for (let i = 0; i < batch.length; i++) {
    const item = batch[i]
    const v = verdicts[i]
    if (!usable(v)) {                // crashed verifier, or a verdict the kernel cannot read
      state.unverified.set(item.id, item)  // open until a LATER round reads a usable verdict for it
      bumpFail(item.id)
      mode.retry(state, item)        // back to the frontier, or → blocked after MAX_RETRIES.
      continue                       // NOT added to `seen`: an unverified mandate must retry.
    }
    const key = mode.key(item, v)
    // Adjudicated. A refutation closes the mandate exactly as a pass does — what an open `unverified`
    // entry means is "nobody could read a verdict", not "the verdict went against us".
    state.unverified.delete(item.id)
    if (v.pass && VERIFIED_COMMITS && !merged.has(item.id)) {
      // VERIFIED, but did not land (issue #8 subtask 3): a real merge conflict, or a Merge agent that
      // crashed/answered unreadably. It retries into a FRESH worktree off the (by then updated)
      // mainline — worktreeDirective's unconditional reset-and-recreate already does that on every
      // dispatch, so no separate instruction is needed.
      //
      // This is an OPEN MANDATE, not a closed one, and it is filed exactly where the crashed-verifier
      // branch above files its own: `unverified`, never `seen`. Treating it as a refutation instead
      // (`state.seen.add(key)`) was fail-OPEN in the archetypes whose `retry` is a deliberate no-op
      // because re-offering is the frontier's job — saturator and explorer both filter the frontier on
      // that same `seen` set, so a conflict DELETED an independently verified atom from the run and
      // the terminal predicate, dry and blocker-free, still reported a positive status over a count
      // that was quietly short. With a Merge agent that crashed every round it was worse: nothing ever
      // landed, every atom went to `seen`, the frontier dried, and the run reported `saturated` with
      // converged=true and confirmed=0 — one dead agent zeroing the count while the board said every
      // instance had been found. `unverified` is the mechanism that already means what this is:
      // work handed out whose result the artifact does not carry, holding `gap` true so no positive
      // terminal status can fire while it is open, and letting patience end a run that can never land.
      state.unverified.set(item.id, item)
      bumpFail(item.id)
      mode.retry(state, item)
      continue
    }
    if (v.pass) {
      // Every pass, whether or not it counts toward the archetype's tally — see the field comment
      // on roundPassed above. Evidence text is best-effort for the commit message the ledger step
      // writes; a verdict that omits it still names the item by id.
      state.roundPassed.push({ id: item.id, evidence: (v.evidence || v.claim || '').slice(0, 200) })
      state.fails.delete(item.id)    // consecutive, not cumulative: one pass resets the stuck count
      clearBlocked(state, item)      // the independent verifier's pass is the ONLY clear path for a blocker
      // saturator/explorer only count an atom if NOVEL; converger counts each criterion once. The
      // `everConfirmed` gate is what makes that monotone: an id that has EVER been confirmed cannot be
      // confirmed again, so a criterion flapping pass→fail→pass contributes exactly once for the
      // whole run and cannot keep resetting patience.
      if (mode.countsAsProgress(v, state, key) && !state.everConfirmed.has(key)) {
        state.everConfirmed.add(key)
        // The ITEM owns its identity and its control fields; the verdict contributes ONLY its own
        // declared answer (`fromVerdict`). Both halves of that are defended failures, not caution:
        //   `id`       — a verifier that echoes the id loosely writes its own spelling into the record:
        //                a blocked entry under a name no later verdict can clear, pinning an item that
        //                has since been verified fixed to `blocked` forever.
        //   everything — this used to be a bare `{ ...item, ...v }`, so any key the verdict carried
        //   else       won the spread. `terminal` is the item field that means "this is the answer";
        //                a verdict carrying `terminal: true` made `tally` bucket an ordinary result as
        //                `answer|...` while `countsAsProgress` had tested `q1|...`, so the covered cell
        //                was never the cell tested and the explorer counted the SAME re-worded finding
        //                every round to the 200-round backstop — the exact defect the charter closes.
        //                Pinning `id` alone was a fix for one field of a class. This is the class.
        const atom = { ...item, ...fromVerdict(v), id: item.id }
        state.confirmed.push(atom); state.roundAccepted.push(atom); grew++
      }
      state.seen.add(key)
      mode.resolve(state, item)
    } else {
      // A genuinely-adjudicated (refuted) atom is SEEN — dedup it so finders don't re-surface it
      // every round (dedup vs `seen`, not vs `confirmed`, or judge-rejected items reappear forever).
      bumpFail(item.id)
      if (v.severity === 'blocker') {
        // Same projection, and this site is the one that MATTERS most: a blocked entry is re-offered to
        // the frontier next round, so a control field injected here is laundered back into a live work
        // item. A verdict of {severity:'blocker', terminal:true} on an ordinary experiment became a
        // re-offered item carrying terminal:true, whose next passing verdict latched `answered` — a run
        // reporting a grounded answer to a question no planner ever proposed one for.
        if (!state.blocked.some(b => sameBlocked(b, item))) state.blocked.push({ ...item, ...fromVerdict(v), id: item.id })
        state.escalate.add(item.id)   // a verify-time blocker escalates on its next rework (kernel #5)
      }
      state.seen.add(key)
      mode.retry(state, item)         // failed check → rework (bounded)
    }
  }
  if (mode.tally) mode.tally(state)   // recompute the counted metric IN CODE from verified atoms
  if (grew === 0 && !state.gap) state.dry++; else if (grew > 0) state.dry = 0

  agePatience(state, grew)
  state.history.push(roundEntry(grew))
  await writeLedger(state)
}

// 5. AUDIT: a SEPARATE agent reads the ledger dir and answers for the files. Runs once, after the
//    last round and before the terminal status is computed.
//
//    Both reporting gates used to latch on the ledger writer's own report about its own edit — the
//    agent that skipped HANDOFF.md was the one asked whether it wrote HANDOFF.md. That is guardrail
//    #1 (a worker never verifies its own output) broken INSIDE the kernel, in the two rungs that
//    exist precisely to catch a run that reports well and shows nothing. Self-preference is causal,
//    and it is not even needed here: the claim is about a file, and a file can be read.
//
//    FAIL CLOSED, like every other verdict: a dead auditor, a null return, a value outside the
//    schema, or a handoff claiming a round that is not this run's final round leaves BOTH gates false
//    and the run demotes. The auditor cannot promote anything — it has no way to say "success", only
//    to fail to certify.
phase('Ledger')
const auditRaw = await agent(
  `Audit the ledger directory ${LEDGER_DIR} for a run that has just finished ${state.round} round(s). ` +
  `READ ONLY — change nothing, repair nothing; this step reports, it does not fix. Answer for the ` +
  `files AS THEY ARE ON DISK, never from what the run intended:\n` +
  `- hero: read the top-level "hero" object in ${LEDGER}. "artifact" only if its "path" names a file ` +
  `that EXISTS; "none" if hero.type === "none" WITH a non-empty note; "absent" otherwise — no hero, ` +
  `an empty one, or a path that is not there. ONE EXCEPTION, and it is the whole reason this reads a ` +
  `file rather than asking an agent: the workbench SEEDS this slot with type:"none" and a note that ` +
  `begins "No capture yet." That seed is the board saying nothing has happened, not the run declining ` +
  `a picture — if the note still starts with those words, answer "absent".\n` +
  `- handoff: read ${HANDOFF}. "complete" only if it exists AND all five sections ` +
  `("What this run is for", "Where it stands", "Open blockers", "What to do next", "Traps") are ` +
  `present with a non-empty body; "incomplete" if it exists with any of them missing or empty; ` +
  `"absent" if there is no such file.\n` +
  `- handoffRound: the integer that "## Where it stands" opens with ("Round N"). Report the number ` +
  `THE FILE CLAIMS — not the round you were told this run reached, and not a guess; 0 if the file is ` +
  `absent or names no round.\n` +
  `- distinctCaptures: of those same image files, how many are DISTINCT BY CONTENT. Hash them ` +
  `(\`md5 -q\` / \`md5sum\` / \`shasum\`) and count the unique digests — do not judge by filename, ` +
  `size or eye. A directory of eight frames that are all the same image is one distinct capture, and ` +
  `that is a broken harness rather than a gallery. 0 if there are none.\n` +
  `- captures: how many image files (.png/.jpg/.gif/.svg/.webp) are in ${LEDGER_DIR}/artifacts/. ` +
  `Count them; 0 if the directory is missing or holds none. This is asked SEPARATELY from hero on ` +
  `purpose — hero is what the board points at, this is what the run actually produced, and the two ` +
  `disagreeing is the finding.\n` +
  `Do NOT paste file contents back.`,
  { ...TIER.mechanical, phase: 'Ledger', label: 'audit', schema: AUDIT_SCHEMA })
const audit = usableAudit(auditRaw) ? auditRaw : null

// ---- Terminal status ----------------------------------------------------------------------
// The positive outcome is archetype-defined and fires ONLY when mode.reachedGoal holds; a high
// count with an open blocker, or a persistent unverified gap, is exactly the false finish we guard
// against. Order matters: a blocker dominates a would-be success, and a run that spent its patience
// on an unresolved verification gap reports `blocked` as well — an unverified mandate is not a pass.
// `inconclusive` is the archetype's own non-positive ending — it stopped for a good reason without
// meeting its success condition — and it ranks below the positive status and above the cap.
// `capped` is the planned stop and is unreachable when MAX_ROUNDS is null; `runaway_backstop` is its
// unbounded counterpart and a defect signal (see RUNAWAY_BACKSTOP above). Riding the rail is recorded
// as its own boolean, because a blocker or an always-positive archetype (sentinel) outranks it in the
// ladder and would otherwise hide it.
// A run that completed ZERO rounds verified nothing, so no archetype may call it a success — every
// reachedGoal is a statement about atoms, and each reads true over an empty set (0 open, 0 unconfirmed,
// dry >= 0). That is how a dead frontier poll used to report a positive terminal status before round 1.
const positive = state.round > 0 && mode.reachedGoal(state)
const hitBackstop = UNBOUNDED && state.round >= ROUND_LIMIT
// A blocker or an unverified gap PINS the status: the plateau decides WHEN a standing-still run stops,
// the blocker decides what that ending is CALLED. Where DRY_ROUNDS < BLOCKER_PATIENCE the plateau gets
// there first, and the run still ends there — but it ends `blocked`, never the benign `stopped`.
// THE WITNESS GATE — a run that showed a human nothing may not call itself a success.
//
// The hero slot has been in the ledger prompt for a while and it changed nothing, because it was an
// INSTRUCTION and not a GATE: every archetype could finish `converged`/`drained`/`answered` having
// never once written a capture, and the board would render its "an absent picture must never read as
// nothing to show" placeholder under a green status. That is the same defect the counted-progress
// rule exists to stop, one level up — the run counts atoms it verified and never checks that any of
// it became visible. Twice here a lane went green, committed, and reached no frame at all.
//
// `witnessed` is decided by the AUDIT — a separate agent that read the ledger — and it is satisfied by
// hero.type="none" WITH a note just as much as by a real capture: the loop is allowed to be unable to
// produce a picture, it is not allowed to be silent about it. Fails closed — a dead auditor never sets
// it. It ranks BELOW blocker/budget (a blocked run is blocked first) and directly above the positive
// status, so it can only ever demote a would-be success.
//
// THE HANDOFF GATE — a run that left the next agent nothing to read may not call itself a success.
//
// progress.json is the run's counted state and it is machine-shaped: rounds, tallies, blocked ids. It
// is a record, not a handoff. A fresh agent picking up a run that died at round 40 needs prose — what
// this run is for, where it stands, what is stuck, what to do next, and the traps that would bite
// somebody who did not live the rounds. The one such document this project has ever had was written
// BY HAND by a human, after a workflow died mid-run; that is the failure this gate exists to stop
// recurring. So HANDOFF.md is rewritten EVERY round, never only at the end — a document that only
// exists at the terminal step does not exist for exactly the run that most needed it.
//
// `documented` is decided by the same audit, and it demands TWO things: a complete file, and one that
// describes THIS round. The round comparison is the whole gate. "A handoff was written at some point"
// is not the contract — the contract is that a run dying at round 40 leaves a document describing
// ROUND 40 — and a monotone latch measures exactly the wrong one of those.
//
// Note the ASYMMETRY with `witnessed`, and do not tidy it away: a capture taken in round 3 is still a
// real capture at round 40, so witnessing is honestly monotone; a handoff written in round 3 at round
// 40 is a fossil, and pointing a fresh agent at it is precisely the failure. Same fail-closed shape
// for both — a dead auditor, a null return, an unreadable value, or a mismatched round leaves both
// false and the run demotes.
//
// `undocumented` ranks immediately BELOW `unwitnessed` and immediately ABOVE the positive status.
// Showing a human NOTHING is the louder failure, so it wins when both are true; and a run that
// verified every atom but left nothing for the next agent still may not call itself a success. Like
// `unwitnessed` this is DEMOTE-ONLY — it can never invent a positive status, and the confirmed count
// is still reported truthfully in both cases, because the gate demotes the STATUS, not the count.
// The `none` branch is the one that needed a second reader, and this is the fix for the asymmetry
// that stood here as a KNOWN LIMIT: the handoff gate had `lyingLedger` — a writer claiming a file the
// auditor cannot find is believed by neither gate — and the witness gate had no equivalent, because
// its whole question was answered out of ONE place, the hero slot. So a run could set
// hero.type="none" with a note reading "no capture was possible", satisfy the gate honestly-looking,
// and finish `converged` while `artifacts/` held a dozen frames nobody was ever pointed at. That is
// the failure this rung exists to stop, arrived at from the other side: not a run that showed
// nothing, but a run that showed nothing while HAVING something.
//
// So `none` now means what it says — no picture exists — and the auditor counts the directory to
// check it. A real capture (`artifact`) needs no such test; it is the honest answer and it stands on
// its own. Note what this does NOT do: it never promotes. A run with a full gallery and hero="none"
// is never quietly upgraded to witnessed on the gallery's behalf, because the gate is about what the
// board LEADS WITH and a frame nobody points at is a frame nobody sees.
//
// WHY THE GATE NOW NAMES ITS REASON. Measured across five real ledgers, three repos, one operator:
// the hero slot was filled ZERO times out of five. Every run took the `type:"none"` escape hatch, and
// two of the five had a non-empty artifacts/ when they did. So the rung above was firing constantly,
// and it was firing the same word at three different facts:
//
//   * `stack`, `ring2`, `rooms` — hero "none", artifacts/ empty. Honest: the work was text-based and
//     there was nothing to photograph. This is the case the escape hatch was built for.
//   * `waves-port` — hero "none", 20 rounds, 19 confirmed, 0 blocked, and artifacts/ holding
//     round0-talk-idle.png, after-talk-idle.png and after-witness.md. It produced EXACTLY the
//     before/after pair the skill asks for and finished `unwitnessed` because nobody wrote the
//     pointer. The run was fine; the last line of bookkeeping was missing.
//   * `loop-475` — hero "none", and four PNGs that are byte-identical to each other because the
//     capture harness broke at round 3 and every later "capture" re-emitted round 1's frame.
//
// One word for all three is the counted-progress defect again: a status that cannot distinguish
// "nothing to show" from "something to show, unshown" from "the camera broke" is a status nobody can
// act on, and the operator has to go read the directory to find out which run they have. Splitting it
// costs one enum and one array, and it turns each ending into an instruction: `unwitnessed` means
// build a capture path, `unpointed` means promote one of the frames you already have,
// `evidence_regressed` means the harness that WORKED has stopped and the run should not continue
// quietly. Only the last one is a blocker, and it is a blocker for the reason kernel #4 gives: a
// capture that used to succeed and now does not is an unverified mandate wearing a picture's clothes.
const witness = witnessVerdict(audit, everCaptured(state))
const witnessed = witness === 'witnessed'
// Hoisted out of the ladder rather than compared inline, so the ladder holds ONLY the strings it can
// emit. The board's parity check reads that block to learn every status the driver can produce, and
// an inline `witness === 'regressed'` there advertises a status the driver never sets.
const evidenceRegressed = witness === 'regressed'
const unpointed = witness === 'unpointed'
const documented = audit !== null && audit.handoff === 'complete' && audit.handoffRound === state.round
const status =
  hasOpenBlocker(state) || state.gap || stalled(state) ? 'blocked'
  // Ranked with the blockers and ABOVE budget, because a harness that regressed makes every later
  // round's evidence untrustworthy — including the rounds that already went green. It is not a
  // reporting nicety like the two rungs below; it is a statement that the run stopped being able to
  // check itself. Demote-only like the rest: it can only ever replace a better status with this one.
  : evidenceRegressed                     ? 'evidence_regressed'
  : !withinBudget()                       ? 'budget_exhausted'
  : positive && unpointed                 ? 'unpointed'
  : positive && !witnessed                ? 'unwitnessed'
  : positive && !documented               ? 'undocumented'
  : positive                              ? mode.doneStatus
  : mode.inconclusive?.(state)            ? 'inconclusive'
  : (state.round >= ROUND_LIMIT)          ? (UNBOUNDED ? 'runaway_backstop' : 'capped')
  :                                         'stopped'

const fin = await agent(
  `Three edits, then stop.\n` +
  `1) In ${LEDGER}, set "status" to "${status}", "hitBackstop" to ${hitBackstop}, and "heroLog" to ` +
  `${JSON.stringify(state.heroLog)} (the complete per-round hero history, so a replay of this finished ` +
  `ledger sees the last round's capture too).\n` +
  `2) Write this compact JSON line to ${RUNS_LOG} (create the file if missing). If a line there ` +
  `already has "run_id":"${RUN_ID}", REPLACE that line in place; otherwise append. One line per run:\n` +
  `{"run_id":"${RUN_ID}","target":"${TARGET}","mode":"${MODE}","effort":"${EFFORT}","status":"${status}",` +
  `"rounds":${state.round},"confirmed":${state.confirmed.length},"blocked":${openBlockers(state).length},` +
  `"hitBackstop":${hitBackstop}}\n` +
  // The run is over, so the pickup document has to stop describing a run in flight. FINALIZE it in
  // place — same five sections, same file, same length budget — rather than writing a second one: a
  // fresh agent that finds two handoff documents has to work out which one is current, and the whole
  // point of rewriting one file every round is that there is never that question.
  `3) Finalize ${HANDOFF} (create it if missing, keeping the same five sections: ` +
  `"What this run is for", "Where it stands", "Open blockers", "What to do next", "Traps"). ` +
  `The run is FINISHED, so rewrite "Where it stands" to open with exactly "Round ${state.round}" — the ` +
  `same round-first shape every in-flight rewrite uses, so a reader never has to work out which file ` +
  `they are holding — then: terminal status "${status}", ${state.confirmed.length} confirmed, ` +
  `${openBlockers(state).length} open blocker(s)${hitBackstop ? ', RODE THE RUNAWAY BACKSTOP' : ''}. ` +
  (status === 'undocumented' || status === 'unwitnessed' || status === 'unpointed'
    ? `This status means the run verified its atoms but failed a reporting gate — say so plainly in ` +
      `"Where it stands" rather than presenting the confirmed count as a clean finish. `
    : '') +
  // The jammed camera gets its OWN instruction, and it is the opposite of the gallery one below: do
  // NOT tell the next agent to promote a frame, because the frames are the problem — the harness
  // emitted duplicates and every round since it broke is ungated. Point at the harness, not the wall.
  (status === 'evidence_regressed'
    ? `The evidence harness REGRESSED: ${audit ? audit.captures : '?'} frame(s) on disk but only ` +
      `${audit ? audit.distinctCaptures : '?'} distinct — it emitted duplicate captures, so every round ` +
      `since it broke is ungated. Under "What to do next", tell the next agent to REPAIR the capture ` +
      `harness and re-pin it (\`node ${SKILL_DIR}/scripts/check_harness.mjs ${LEDGER_DIR} --accept\` once a ` +
      `human has looked), NOT to promote one of the existing frames — they are stale. Say this plainly ` +
      `in "Where it stands". `
    : audit !== null && audit.hero === 'artifact'
    ? `A capture exists: read the top-level "hero" object in ${LEDGER} and add a one-line pointer to ` +
      `its path (and its "before", if set) under "Where it stands". Do NOT re-derive or guess the path. `
    : audit !== null && audit.captures > 0
      // The gallery is full and the board points at none of it. Say THAT, not "no capture was
      // produced" — which is what this branch used to say unconditionally, and it would have been a
      // false sentence written into the one document the next agent reads.
      ? `${audit.captures} capture(s) exist in ${LEDGER_DIR}/artifacts/ but the hero slot points at ` +
        `none of them, which is why this run is not witnessed. Say so in one line under "Where it ` +
        `stands" and name the directory, so the next agent can promote one. `
      : `No capture was produced this run; say so in one line under "Where it stands". `) +
  `Reconcile ${LEDGER_DIR}/footprint.jsonl (skip this if the file is absent, and say so in one "Traps" ` +
    `line) against the files this run actually changed: the shared tree's uncommitted changes ` +
    `(\`git status --porcelain\`) PLUS the files carried by this run's landed attempts ` +
    (VERIFIED_COMMITS
      ? `(\`git log --grep="merge verified attempt (run ${RUN_ID})" --diff-merges=first-parent ` +
        `--name-only --pretty=format: | sort -u\` — under attempt isolation every worker edit is ` +
        `committed inside its own worktree and reaches the shared tree as one of these merge ` +
        `commits, so porcelain alone is clean by construction and would show you nothing. Both ` +
        `flags are load-bearing: the run id scopes this to THIS run rather than every run that ` +
        `ever merged into this repo, and without an explicit diff mode \`git log --name-only\` ` +
        `prints NOTHING AT ALL for a merge commit). `
      : ``) +
    `Under "Traps", add ` +
    `one line per changed file no claim covers, and one line per file claimed by two different items. ` +
    `Cite file paths only; do not paste diffs. ` +
  `Carry "Traps" forward unchanged plus anything the ending taught. Keep the whole file under ~150 ` +
  `lines and cite paths instead of pasting content.\n` +
  `Return {"finalized": true} only if ALL THREE edits landed on disk; {"finalized": false} if any of ` +
  `them did not. Answer for the files, not for your intent.`,
  { ...TIER.mechanical, label: 'finalize', schema: FINALIZE_SCHEMA }
)
// FAIL-CLOSED, and DEMOTE-ONLY BY CONSTRUCTION: `status` is already fixed above, so nothing here can
// promote a run — a dead finalize cannot turn `blocked` into `drained`, and a live one cannot either.
// What it CAN do is leave the whole terminal rung unwitnessed by anything: progress.json still reading
// "running", no line in runs.jsonl, a HANDOFF.md that still describes a run in flight. The caller is
// the only party that can notice, so tell it.
const finalized = fin !== null && fin.finalized === true

log(`Done after ${state.round} rounds (${status}). Confirmed ${state.confirmed.length}, blocked ${openBlockers(state).length}.` +
  (finalized ? '' : ` BOARD NOT FINALIZED: ${LEDGER} may still read "running" and ${RUNS_LOG} may have no line for this run.`))
return {
  mode: MODE, rounds: state.round, status, hitBackstop,
  converged: status === mode.doneStatus,   // TRUE only if the archetype's positive stop fired
  confirmed: state.confirmed.length, blocked: openBlockers(state).length,
  finalized,   // the run ended; did the BOARD find out? false ⇒ progress.json/runs.jsonl/HANDOFF are stale
  history: state.history,
  // KEEP-BEST, surfaced. A high-water mark kept only in `state` is a number nobody reads: the run
  // would still report its LAST composite as though it were its best, which is the exact reading
  // keep-best exists to prevent. `best < composite` is impossible; `best > composite` means the run
  // ended below its own peak and the regressed list says which criteria took it there.
  ...(MODE === 'converger'
    ? { composite: state.composite, best: state.best, bestRound: state.bestRound,
        regressed: [...state.regressed] }
    : {}),
}

// ---- shared helpers (hoisted) -------------------------------------------------------------
// A MANDATE is written `key: the brief`. The key is the short name — it labels the agent and is
// stamped on the atom; the brief is what the critic is actually told. A mandate with no colon is its
// own key and its own brief, which is legal and weak.
//
// These are function DECLARATIONS on purpose. The round loop runs at module top level, above this
// block, and declarations hoist while `const` does not — a `const VERDICT_KEYS` placed down here once
// crashed fifteen scenarios with "cannot access before initialization".
function mandateKey(m) { const i = String(m).indexOf(':'); return (i < 0 ? String(m) : String(m).slice(0, i)).trim() }
function mandateBrief(m) { const i = String(m).indexOf(':'); return (i < 0 ? String(m) : String(m).slice(i + 1)).trim() }
// The verdict is the only thing that can advance an atom, so its SHAPE is load-bearing and a
// truthiness test is not a shape check. `{}` passes one, and then `v.pass` is undefined and the else
// branch records the atom as genuinely REFUTED — a crashed verifier read as an adjudication, and a
// frontier that dries into `converged` with nothing confirmed. `pass:'no'` passes one too, and reads
// as a PASS, so the blocker branch (which lives in the else) never runs on a verdict that refused.
// A verdict the kernel cannot read is an UNVERIFIED mandate and takes the null path: gap, retry,
// never `seen` — never a refutation and never a pass (kernel #4). Same rule, same words, as the
// `usable` helper this kernel grew out of.
// The evidence clause is the same fail-closed reading of guardrail #2: a PASS is a claim that some
// grounded, externally checkable signal was seen, so a pass carrying none is that gap wearing a
// valid shape. Presence is the kernel's job; judging the CONTENT is the critic's. A refutation needs
// no evidence to be a refutation — it advances no count — so only passes are held to it.
// The verdict's contribution to an atom, narrowed to the fields VERDICT_SCHEMA actually declares.
// Keys are read OUT of the schema for the same reason SEVERITIES and FINDINGS are: re-typing the list
// here would let the two drift, and the drift would be silent — a field added to the schema and not to
// this list is simply dropped, which is safe, while a field removed from the schema and left here is a
// hole. Deliberately NOT part of `usable`: an extra key is not grounds to reject an otherwise valid
// verdict (that would fail closed on a harmless field and open a way to void real work), it is grounds
// to ignore the key. Narrow the input, don't refuse it.
// `VERDICT_KEYS` is declared up with the schemas, not here, and that is a constraint of this file's
// shape rather than a style choice: the round loop runs at module top level ABOVE this section, so a
// `const` down here sits in its temporal dead zone when the first verdict lands. Function declarations
// hoist; `const`s do not. That is why `fromVerdict` can live here and its key list cannot.
function fromVerdict(v) {
  const out = {}
  for (const k of VERDICT_KEYS) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = v[k]
  return out
}
function usable(v) {
  return v && typeof v.pass === 'boolean' &&
    (v.severity === undefined || SEVERITIES.has(v.severity)) &&
    (v.novel === undefined || typeof v.novel === 'boolean') &&
    (!v.pass || (typeof v.evidence === 'string' && v.evidence.trim() !== ''))
}
// ---- the capture clause ----------------------------------------------------------------------
// The evidence half of a verifier's mandate: whether to photograph this item, and what counts as
// having done so. Kept in ONE function because it is the sentence the whole witness gate depends on,
// and it used to be improvised per-archetype in prose.
//
// THE CONTRACT IT WRITES DOWN, and every line of it is a measured failure:
//
//   * A TIMEOUT IS A FAILURE. The capture harness that broke mid-run did not exit non-zero — it hung,
//     and the runner answered "moved to the background", which is a SUCCESS-SHAPED result with no
//     exit code in it. A verifier branching on the exit status saw nothing wrong. 20 of 31 measured
//     invocations returned in under a tenth of a second and the run called every one of them fine.
//   * A FRAME WITHOUT ITS SIDECAR IS NOT EVIDENCE. The same harness, on its last round, wrote the PNG
//     and then died before the JSON that says what the PNG proves. A lone image is a picture of
//     something; the sidecar is what makes it a picture of THIS round's claim.
//   * SAY WHICH ROUND, AND CHECK THE FRAME IS NEW. Re-emitting an earlier frame is the failure that
//     hid for five rounds, because a directory that keeps growing looks like a working camera.
function captureClause(item, state) {
  if (item && item.bearsEvidence === false) return ''                  // this item changes nothing visible
  if (!capturesThisRound(state ? state.round : 0)) return ''           // evidence-free, or an off-cadence round
  return ` BEFORE capturing, run \`node ${SKILL_DIR}/scripts/check_harness.mjs ${LEDGER_DIR}\`. It holds the ` +
    `evidence harness still the way DESCENT holds the kernel still: first sight of a script is recorded, ` +
    `every later round must hash the same. If it exits non-zero the harness changed after it was pinned — ` +
    `do NOT capture, do NOT work around it, and return a FAILING verdict whose evidence names the drift. ` +
    `Every frame taken since such an edit is evidence nobody gated, which is a blocker and not a note.` +
    ` Then CAPTURE the evidence for this item into ${LEDGER_DIR}/artifacts/, named for round ` +
    `${state ? state.round : '<round>'}, and write a sidecar JSON beside it saying what the frame proves. ` +
    `AFTER capturing, run the SAME check again (\`node ${SKILL_DIR}/scripts/check_harness.mjs ${LEDGER_DIR}\`): ` +
    `if it now reports drift, the harness changed DURING the capture and the frame you just took came ` +
    `from bytes nobody gated — discard it and return a FAILING verdict. Checking only before the ` +
    `capture leaves a window the one measured breakage lived in. ` +
    `Treat the capture as FAILED — and say so — if the command exits non-zero, if it times out or gets ` +
    `backgrounded (a timeout is a failure, not a pass; it returns no exit code and must never read as ` +
    `one), if no new file appears, or if the frame is byte-identical to one already in that directory. ` +
    `A repeated frame means the harness is emitting a stale picture and is worth MORE to report than a ` +
    `clean run. Never hand-edit the capture harness to work around it; a harness that needs changing ` +
    `mid-run is a blocker, because every round after the edit is evidence nobody gated.`
}

// ---- the witness verdict -------------------------------------------------------------------
// PURE, and deliberately so: it is the one piece of gate logic that can be replayed against a
// finished run's ledger without re-running the run, which is how it was checked against five real
// ledgers before it shipped (scripts/replay_gates.mjs extracts THIS function by marker and evaluates
// it, so the replay tests the shipped code and not a copy of it that could drift).
//
// Four answers, and the order of the tests is the whole design:
//   'witnessed'  — the board points at a real frame, OR says "none" and the directory agrees.
//   'regressed'  — the harness looks stopped: EITHER the gallery is majority duplicates (checked FIRST
//                  after the fail-closed case, because it is the only answer that survives a full
//                  gallery — a run whose harness died at round 3 has frames on disk from rounds 1-2 and
//                  would otherwise read as merely `unpointed`), OR a capture succeeded in some earlier
//                  round, the board does not point at one now, AND the gallery is too small (below the
//                  4-capture floor) for the ratio test above to have an opinion either way — the
//                  conservative reading when that's the only evidence there is. A healthy-sized gallery
//                  the ratio test already cleared is NOT re-accused just because the pointer moved.
//   'unpointed'  — frames exist, the board points at none. A pointer bug, not a run failure.
//   'unwitnessed'— nothing to show and no capture path. Fail-closed default.
//
// `everCaptured` is the run's own per-round self-report, which guardrail #1 says may never GATE
// anything. It does not gate: every answer it can change is a DEMOTION, so the worst a lying writer
// can do with it is convict its own run. That asymmetry is what makes untrusted input safe here, and
// it is the only place in the kernel where such input is read at all.
function witnessVerdict(audit, everCaptured) {
  if (audit === null) return 'unwitnessed'                                  // dead auditor: fail closed
  // THE JAMMED CAMERA, and it is tested before everything including `artifact`. A board POINTING at a
  // stuck harness's frame would be the worst reading of all — a green run leading with a picture of
  // nothing having happened — which is why `artifact` does not get to answer first. But a jam is a
  // camera that is MOSTLY stuck, not a camera that ever repeated a frame: at least half the captured
  // frames have to be repeats before the harness gets accused. Measured on the loop that motivated the
  // rung: loop-475 wrote dock-1/2/7/8.png over eight rounds, all four the identical empty-state frame
  // from round 1 — 1 distinct of 4, still fires (1*2 <= 4). Measured against two corpora that broke
  // "ANY duplicate is a jam": a design-system run at 110 captures/77 distinct, a healthy 40-round
  // camera that would have been accused for its 33 incidental repeats; and an impeccable-radix run at
  // 6/4, where the camera was fine while the run itself was stuck on something unrelated. Below the
  // 4-capture floor there is not enough evidence to accuse the harness — an early single duplicate is
  // what a real long-running camera produces, not a jam — and occasional duplicates past the floor are
  // the same honest noise, not a broken harness. `distinctCaptures * 2 <= captures`, not `< captures`.
  if (audit.captures >= 4 && audit.distinctCaptures * 2 <= audit.captures) return 'regressed'
  if (audit.hero === 'artifact') return 'witnessed'
  // `everCaptured` is a CRUDER signal than the ratio test above: it knows only that some past round's
  // hero was 'artifact', not whether the gallery stayed healthy since. Below the ratio test's own
  // floor (`captures < 4`) there isn't enough gallery for that test to have an opinion, so this is the
  // only evidence available and a lost pointer is read the conservative way, same as it always was.
  // At or above the floor, the ratio test just ran and did NOT call this a jam — occasional duplicates
  // past that floor are honest noise, per its own comment above — so trusting a second, blunter test to
  // override that finding would re-accuse a camera the calibrated test just cleared. MEASURED: a
  // 25-round exhauster with 28 captures, 22 distinct (all duplicates early-run, capture script pinned
  // unchanged the whole run) whose final item legitimately bore no evidence read `evidence_regressed`
  // under the old unconditional rule — the harness had provably never stopped; the board had simply
  // lost its pointer on the last round. That case wants `unpointed`, below.
  if (everCaptured && audit.captures < 4) return 'regressed'                // too little gallery to trust the ratio test; it worked once, and now there's not enough evidence it still does
  if (audit.hero === 'none' && audit.captures === 0) return 'witnessed'     // honestly nothing to show
  if (audit.captures > 0) return 'unpointed'                                // something to show, unshown
  return 'unwitnessed'
}
function everCaptured(state) {
  return (state.heroLog || []).some(h => h.hero === 'artifact')
}

// The audit decides both reporting gates, so its SHAPE is load-bearing exactly as a verdict's is, and
// for the same reason: every unreadable answer is truthy. `{}` would read as an auditor that found no
// hero and no handoff — which is fail-closed by luck, not by design — while `{hero:'artifact'}` with a
// missing handoffRound would make `handoffRound === state.round` a comparison against undefined, which
// is false today and one careless `??` away from being true. Unreadable is UNAUDITED: both gates false.
function usableAudit(a) {
  return !!a && (a.hero === 'artifact' || a.hero === 'none' || a.hero === 'absent') &&
    (a.handoff === 'complete' || a.handoff === 'incomplete' || a.handoff === 'absent') &&
    Number.isInteger(a.handoffRound) && Number.isInteger(a.captures) && a.captures >= 0 &&
    // Same reason every other field here is checked rather than defaulted: `undefined` in the stuck
    // test below compares false and would quietly hand the jammed-camera case back to `captures`.
    Number.isInteger(a.distinctCaptures) && a.distinctCaptures >= 0 && a.distinctCaptures <= a.captures
}
function withinBudget() { return !budget.total || budget.remaining() > RESERVE }
function openBlockers(state) { return state.blocked }   // entries are removed the round they clear, below
function clearBlocked(state, item) {
  // Cleared in code from the verdict, NOT by looking for the id in `confirmed`: a re-verified atom can
  // be non-novel and never enter that array, and an id that passed once must not mask a later blocker
  // on the same key.
  state.blocked = state.blocked.filter(b => !sameBlocked(b, item))
}
function hasOpenBlocker(state) { return openBlockers(state).length > 0 }
function agePatience(state, grew) {
  // End of every round: the patience counter advances on any round that is both STUCK — a blocker or
  // an unverified gap still open — and UNPRODUCTIVE. Productive means `everConfirmed` GREW, so
  // re-confirming a known id, or an id merely dropping out of the report, buys nothing. A round that
  // left a mandate unverified is unproductive whatever else landed in it: a partial pass cannot
  // certify what the gap left unmeasured. Only a new confirmation resets the count: a clean round in
  // between HOLDS it, because a violation that clears and reopens on alternate polls would otherwise
  // hold patience open forever while nothing is ever verified fixed. The stuck rounds it counts need
  // not be consecutive; the monotone set is the only thing that can undo them.
  const stuck = hasOpenBlocker(state) || state.gap
  const productive = grew > 0 && !state.gap
  if (productive) state.stall = 0
  else if (stuck) state.stall++
}
function stalled(state) { return state.stall >= BLOCKER_PATIENCE }
function bumpFail(id) { state.fails.set(id, (state.fails.get(id) || 0) + 1) }
function isStuck(id) { return (state.fails.get(id) || 0) >= STUCK_AFTER }
function retryDirective(id) {
  // Same byte-identity discipline as stuckDirective: a first attempt returns '' so a run resumed
  // with resumeFromRunId replays it from cache. The string appears only once an item has a failed
  // attempt behind it. VERIFIED_COMMITS is fixed for the whole run, so which branch fires below never
  // varies attempt to attempt — the byte-identity the `stuck` scenario checks (attempts 2..STUCK_AFTER
  // share one prompt) holds either way.
  if (!((state.fails.get(id) || 0) > 0)) return ''
  if (VERIFIED_COMMITS) {
    // Issue #8 subtask 3 (spec: attempt-isolation-design) shrinks this to a short, constant note.
    // Subtask 2's "read footprint, checkout, clean" text assumed a shared tree with leftovers worth
    // resetting. Attempt isolation removes that premise a second time: there IS no leftover on the
    // shared tree to reset, because the dead attempt never touched it — its entire half-finished
    // state lived in a worktree worktreeDirective already destroys and rebuilds THIS dispatch,
    // unconditionally, whether or not this is a retry. Nothing left here to judge or instruct.
    return `\n\nRETRY: a previous attempt at this item did not land — either it failed verification ` +
      `or its merge conflicted. You are starting in a FRESH, isolated worktree (see WORKTREE below) ` +
      `that carries none of the prior attempt's edits; there is nothing to inspect or reset. ` +
      `Re-derive the item from a clean slate.`
  }
  return `\n\nRETRY: a previous attempt at this item failed, and the working tree may still hold its ` +
    `half-finished edits. Read ${LEDGER_DIR}/footprint.jsonl and find this item's lines first: a ` +
    `trailing claim line with no close line after it is the attempt that died mid-work, and its ` +
    `"files" list is where to look; a closed attempt the verifier failed names its files the same way. ` +
    `Before you work, run git status and git diff on the files this item touches. ` +
    `For each leftover change, either revert it or re-derive it and deliberately adopt it. ` +
    `Never let an inherited edit satisfy the done-criterion unexamined.`
}
function stuckDirective(id) {
  // Below STUCK_AFTER this returns '' so the worker prompt stays BYTE-IDENTICAL — a run resumed with
  // resumeFromRunId replays those agents from cache instead of re-paying for them. The string only
  // changes at the threshold, which is precisely the round where re-running is the point.
  if (!isStuck(id)) return ''
  return `\n\nSTUCK: ${state.fails.get(id)} consecutive rounds have failed on this item. Do NOT re-tune the ` +
    `previous approach — CHANGE it. State the root cause before the fix, then answer in order: ` +
    `(a) does the INPUT this code needs actually exist, or is it being synthesized? ` +
    `(b) can the INSTRUMENT disagree with reality, or does it read the same record it certifies? ` +
    `(c) is the fix landing in a file the RUNNING artifact never loads (a stale vendored build)?`
}
function footprintDirective(item) {
  // Constant for a given item — no round number, no attempt counter, no clock — for the same reason
  // activityDirective is constant per (phase, label): a resumed run replays byte-identical prompts
  // from cache, and a failing item's later attempts stay byte-identical to each other. The worker
  // stamps ts itself, exactly as the activity log works. The claim is the FIRST act so that an
  // attempt that dies mid-work still leaves behind which files it meant to touch; a trailing claim
  // with no close is how the retry learns its predecessor died and where to look.
  return `\n\nFOOTPRINT (bookkeeping, first and last actions; not part of the task, never let it ` +
    `change your answer): BEFORE your first edit, append one line to ${LEDGER_DIR}/footprint.jsonl ` +
    `(create it if missing): {"ts":"<ISO-8601 now>","item":${JSON.stringify(item.id)},"event":"claim",` +
    `"files":[<the file paths you intend to edit>]}. If your scope grows mid-work, append another ` +
    `claim line. As your LAST action, append {"ts":"<ISO-8601 now>","item":${JSON.stringify(item.id)},` +
    `"event":"close","status":"<one of: done, noop, blocked>","note":"<one line: where this attempt ended>"}. ` +
    `Append only; never rewrite or truncate the file — other agents are appending to it at the same time.`
}
function refSlug(id) {
  // The kernel does not choose item ids and must never assume they are legal git refs. A saturator's
  // id IS its locator (`src/a.rs:12`), a sentinel's is `${round}:${id}`, an exhauster's comes from an
  // enumerate agent. Interpolated raw, `git worktree add … -B attempt/src/a.rs:12` exits 128 with
  // "not a valid branch name" — so on a git target the attempt could never start at all, for EVERY
  // sentinel item and the typical saturator one.
  //
  // Slug to the charset git always accepts, then append a hash of the RAW id: two ids that slug
  // identically (`a/b` and `a:b`) must not collide onto one branch and one worktree, which would have
  // two items overwriting each other's attempt. Pure function of the id and nothing else — no round,
  // no attempt counter — so every directive built from it stays byte-identical across attempts.
  const raw = String(id)
  const slug = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.\.+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'item'
  // 64 bits, as two independent 32-bit lanes: no imports, no crypto, no clock — stable across runs
  // and across machines, which byte-identical prompt replay depends on. Width matters because a
  // collision is not a cosmetic clash: worktreeDirective REMOVES an existing path and branch before
  // recreating them, so two ids sharing a slug would have the second item delete the first's attempt
  // and the Merge phase then attribute one item's work to the other. At 32 bits that is a birthday
  // problem a long-running saturator could actually reach; at 64 it is not reachable.
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ (c + 0x9e3779b9), 0x85ebca6b) >>> 0
  }
  return `${slug}-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}
function attemptWorktree(id) {
  // Deterministic, pure function of LEDGER_DIR (Config) and the item id — every phase that needs to
  // find an attempt's worktree (worker, verifier, Merge) can derive it without a new record, the same
  // way footprintDirective's file lives at a path derived from LEDGER_DIR alone. Lives under
  // LEDGER_DIR, not inside TARGET's own tree, alongside footprint.jsonl/claims.jsonl/activity.jsonl —
  // this run's own bookkeeping directory, not the artifact being worked on.
  //
  // Both halves go through refSlug: the branch because git demands it, the path because an id with a
  // slash (`src/a.rs:12`) would otherwise nest the worktree in directories named after the artifact's
  // own layout, and `git worktree remove` would then be pointed at a path no cleanup step can predict.
  const safe = refSlug(id)
  return { path: `${LEDGER_DIR}/attempts/${safe}`, branch: `attempt/${safe}` }
}
function worktreeDirective(item) {
  // Issue #8 subtask 3 (spec: attempt-isolation-design). VERIFIED_COMMITS-gated, same as every other
  // git-specific instruction in this kernel: '' on a non-git TARGET, which gets none of this and
  // falls back to the shared-tree discipline subtasks 1/2 already establish for it.
  if (!VERIFIED_COMMITS) return ''
  const { path, branch } = attemptWorktree(item.id)
  // UNCONDITIONAL on every dispatch — first attempt and every retry alike, no branch on
  // state.fails — which is what makes this SIMPLER to hold byte-identical than footprintDirective's
  // own constancy: there is no separate "this is a retry" text at all, because the reset-and-recreate
  // step below is exactly what a retry needs and is harmless (a no-op remove) when nothing exists yet.
  return `\n\nWORKTREE (attempt isolation): this attempt is isolated in its own git worktree, never ` +
    `the shared tree directly. Before any edit: if ${path} already exists (a dead or failed prior ` +
    `attempt), remove it and its branch first — \`git worktree remove --force ${path}\` then ` +
    `\`git branch -D ${branch}\` if the branch still exists — so you always start from a clean slate. ` +
    `Then create a fresh one off the CURRENT mainline: \`git worktree add ${path} -B ${branch} HEAD\` ` +
    `(run from the shared tree). Do every edit, test, and commit INSIDE ${path} — never touch the ` +
    `shared tree directly, and never run \`git merge\` yourself; merging only happens after an ` +
    `independent verifier passes this attempt. Commit your work there as you go, on ${branch}, so ` +
    `the branch actually holds something to merge when it passes — an attempt with no commits is ` +
    `indistinguishable from one that did nothing. Footprint claims (below) name files relative to ${path}.`
}
function worktreeVerifyDirective(item) {
  // Same gate as worktreeDirective — a non-git TARGET never created a worktree, so there is nothing
  // for a verifier to be pointed at.
  if (!VERIFIED_COMMITS) return ''
  const { path, branch } = attemptWorktree(item.id)
  return `\n\nWORKTREE: this attempt happened in an isolated worktree, not the shared tree — if ` +
    `${path} exists, verify INSIDE it (cd there before running any check), never against the shared ` +
    `tree, which has not been updated with this attempt yet. If ${path} does not exist, or ${branch} ` +
    `holds no commits of its own, the attempt changed nothing: check this item's done-criterion ` +
    `against the shared tree instead, and name which of the two you checked in your evidence. An ` +
    `empty attempt is a FACT to report, never a verdict on its own — some items are legitimately ` +
    `no-ops (a criterion already passing, evidence that only needed gathering, an experiment that ` +
    `only needed running), so do not fail one merely for being empty and do not pass one merely ` +
    `because it is. The done-criterion decides.`
}
function activityDirective(phase, label) {
  // Mid-round visibility, paid for by agents that were going to run anyway. The driver has no
  // filesystem access, so this is the only way the board learns anything between ledger writes.
  //
  // The text is CONSTANT for a given (phase, label) — no timestamp, no round number, no counts.
  // Same reason stuckDirective holds its tongue below the threshold: a resumed run replays
  // byte-identical prompts from cache, and interpolating a clock here would silently re-pay for
  // every agent in the run on every resume, to log the resume.
  if (!ACTIVITY_LOG) return ''
  return `\n\nBOOKKEEPING (first and last actions; not part of the task, never let it change your ` +
    `answer): append one line to ${ACTIVITY} before you start — ` +
    `{"ts":"<ISO-8601 now>","agent":"${label}","phase":"${phase}","event":"start"} — and one when ` +
    `you finish, same shape with "event":"end" and "status":"ok" or "fail". Create the file if it ` +
    `does not exist. Append only; never rewrite or truncate it, because other agents are appending ` +
    `to it at the same time.`
}
function blockerKey(b) {
  // Sentinel violations are keyed by invariant (their ids are round-prefixed); everything else by id.
  return MODE === 'sentinel' ? (b.invariant || b.id) : b.id
}
function sameBlocked(b, item) { return blockerKey(b) === blockerKey(item) }
function round3(x) { return Math.round((x || 0) * 1000) / 1000 }
function roundEntry(grew) {
  // `total` is a real "how many to go" denominator ONLY for archetypes whose mode.init sets
  // state.total (converger: rubric size; exhauster: queue length). saturator/explorer/sentinel
  // never set it — they have no "total to be worked" concept, an unknown-size set or a standing
  // watch, not a queue with a length. Falling back to state.confirmed.length there used to make
  // pass_count and total IDENTICAL by construction every round, so `${pass}/${total}` always read
  // 100% — a substituted quantity presented as a measured ratio, exactly what DESIGN-CONTRACT.md
  // §1 rule 5 forbids. Report null instead so the board can say "not applicable" rather than lie.
  const total = (state.total != null) ? state.total : null
  const passCount = MODE === 'converger' ? state.passing.size : state.confirmed.length
  return {
    round: state.round, composite: round3(mode.progress ? mode.progress(state) : 0),
    pass_count: passCount, total, accepted: grew,
    confirmed: state.confirmed.length, open: state.open.size, dry: state.dry,
    gap: state.gap, hasBlocker: hasOpenBlocker(state), stall: state.stall,
  }
}
async function writeLedger(state) {
  const h = state.history[state.history.length - 1] || { round: state.round }
  const head = {
    target: TARGET, mode: MODE, status: 'running', pass_threshold: PASS_THRESHOLD,
    // How the run was priced. On the board so a `thrifty` run and a `quality-first` one no longer read
    // identically after launch, and in the run summary below for the same reason across runs.
    effort: EFFORT, evidence_every: EVIDENCE_EVERY,
    confirmed: state.confirmed.length, open: state.open.size, blocked: openBlockers(state).length,
    // The per-round hero self-report, PERSISTED — not just held in `state.heroLog`. It is what lets a
    // finished ledger be replayed (scripts/replay_gates.mjs reads `heroLog`): a run that captured in an
    // early round and lost its pointer later must replay as `regressed`, not `unpointed`, and that turn
    // is only knowable from the history. Lags this round by one (the current entry is pushed after the
    // writer returns, below), which does not matter to "did it EVER capture".
    heroLog: state.heroLog,
    // The previous round's self-report, on the board. It gates nothing (see the end of this function);
    // it is here so a watcher can compare what the writer SAID with what the terminal audit FOUND.
    last_reported: state.reported,
  }
  const newClaims = (state.roundAccepted || []).map(a => ({ id: a.id, evidence: a.evidence || a.claim || '' }))
  // `state.roundPassed` (this round's verified-AND-landed passes) no longer drives a commit here.
  // Issue #8 subtask 3 (spec: attempt-isolation-design) REPLACES commit-per-verified-pass with the
  // Merge phase, which now runs earlier in the round, right after Verify: a worker commits its own
  // work inside its isolated worktree as it goes, and Merge already lands those commits on the shared
  // tree the moment an item verifies pass. By the time the Ledger step runs, a landed item's commits
  // are already at HEAD — nothing left for this agent to stage or commit. `state.roundPassed` is kept
  // only as evidence text for `claims.jsonl` (via `newClaims`, above); it drives no git operation here.
  // The blocked set, BOUNDED — the handoff's "Open blockers" section needs ids and what is stuck, and
  // the driver is the only place that knows them. Passed as a slice for the same reason the explorer
  // passes a recent tail rather than the whole grounded log (kernel #6): the driver's context stays
  // thin, and a run with 50 open blockers has a bigger problem than an abridged handoff.
  const blockers = openBlockers(state).slice(0, 20).map(b => ({
    id: b.id, severity: b.severity || 'blocker', evidence: (b.evidence || b.claim || b.detail || '').slice(0, 240),
  }))
  const overflow = openBlockers(state).length - blockers.length
  const r = await agent(
    // TURN ECONOMY, stated first because it is the instruction most often ignored. Everything this
    // agent needs is already in this prompt; the measured failure mode is an agent that opens
    // progress.json and HANDOFF.md anyway to reconstruct context it was handed, then spends thirty
    // turns thinking about it. It is worth saying WHY rather than just forbidding it: re-reading is
    // not merely wasteful here, it is a correctness risk, because the file on disk is last round's
    // state and the prompt is this round's.
    `You have been handed everything you need. Do NOT read ${LEDGER} or ${HANDOFF} to work out what ` +
    `to write — the values below are authoritative and newer than the files. Read a file only to ` +
    `apply an edit to it, make the edits, report, and stop.\n\n` +
    `Update the JSON file ${LEDGER} (create it as {"rounds":[]} if missing) for round ${state.round}:\n` +
    `1) Merge these top-level fields: ${JSON.stringify(head)}.\n` +
    `2) If "started_at" is absent, set it to the current ISO timestamp.\n` +
    `3) Append this entry to the "rounds" array: ${JSON.stringify(h)}.\n` +
    (newClaims.length ? `4) Append these grounded claims (one JSON object per line) to ${LEDGER_DIR}/claims.jsonl: ${JSON.stringify(newClaims)}.\n` : '') +
    `Reference any per-round evidence you drop under ${LEDGER_DIR}/artifacts/ named r${state.round}-* in the round entry. ` +
    // The hero capture obeys the SAME cadence clock as the per-item capture (`EVIDENCE_EVERY`), so a
    // run declared evidence-free (0) never manufactures a hero, and an off-cadence round leaves the
    // last real picture in place rather than forcing a fresh one the work did not earn.
    (EVIDENCE_EVERY === 0
      ? `This loop is EVIDENCE-FREE (EVIDENCE_EVERY=0): do not capture. Set the top-level "hero" to ` +
        `type="none" with a note saying this run bears no evidence by declaration; never leave the slot empty. `
      : capturesThisRound(state.round)
        ? `The board LEADS WITH THE PICTURE: set the top-level "hero" to this round's headline capture — ` +
          `{path, label, commit (\`git rev-parse HEAD\` from the RUNNING code, never a filename or URL param), ` +
          `before: round 1's capture in the same framing, framing: "artifacts/framing.json" written once and ` +
          `read back, never re-derived}. If a picture is impossible, set hero.type="none" with a note naming ` +
          `what would be needed; never leave the slot empty. `
        : `This is an OFF-CADENCE round (EVIDENCE_EVERY=${EVIDENCE_EVERY}): do not capture a new hero. ` +
          `LEAVE the existing top-level "hero" in ${LEDGER} exactly as it stands; if the slot is still ` +
          `empty because no round has captured yet, set hero.type="none" with a note. Never leave it empty. `) +
    `Then REPORT WHAT YOU ACTUALLY WROTE into the hero slot — "artifact" if it names a real capture ` +
    `file, "none" if you set type="none" WITH a non-empty note, "absent" if you left it empty or could ` +
    `not write it. Answer for the file as it stands on disk after your edit, not for what you intended. ` +
    `Do NOT paste file contents back.\n\n` +
    // THE PICKUP DOCUMENT. Rewritten in full every round rather than appended to, for two reasons: it
    // never grows unbounded, and it always describes the run AS IT STANDS — an appended log makes a
    // reader reconstruct the present from a transcript, which is the work the document exists to
    // remove. The one exception is Traps, which is carried forward: those are the only lines somebody
    // who did not live the rounds cannot re-derive from the artifacts.
    `THE HANDOFF: now REWRITE ${HANDOFF} from scratch (create it if missing) so that an agent who ` +
    `has never seen this run could pick it up from where it stands RIGHT NOW. Overwrite the whole ` +
    `file — do NOT append to it. Exactly these five sections, all of them filled:\n` +
    `  ## What this run is for — the destination and what one verified atom is. ` +
    `If ${BRIEF} exists, carry its framing forward; otherwise state it from the target "${TARGET}" ` +
    `and the source "${SOURCE}".\n` +
    // The round number is REQUIRED, in a fixed position, because staleness is otherwise undetectable:
    // a handoff describing round 3 and a handoff describing round 40 are the same file to anything that
    // only asks "does it exist?". The terminal audit reads this number back and compares it with the
    // run's final round — that comparison is the only thing that can tell a fresh document from a
    // fossil, and it needs the number to be there and to be first.
    `  ## Where it stands — its FIRST line MUST begin with exactly "Round ${state.round}" (that number ` +
    `is how a reader and the terminal audit tell a fresh handoff from a stale one; never omit it and ` +
    `never carry an older round's number forward). Then: confirmed ${state.confirmed.length}, open ` +
    `${state.open.size}, blocked ${openBlockers(state).length}; and how far the terminal predicate is ` +
    `from firing, in its own terms (this is a ${MODE}: dry ${h.dry ?? state.dry}/${DRY_ROUNDS}, composite ` +
    `${h.composite ?? 0}/${PASS_THRESHOLD}, stall ${h.stall ?? state.stall}/${BLOCKER_PATIENCE}, round ${state.round}/` +
    `${ROUND_LIMIT}${state.gap ? ', AND an unverified mandate is open' : ''}).\n` +
    `  ## Open blockers — one line each, id + what is ACTUALLY stuck, from: ` +
    `${JSON.stringify(blockers)}${overflow > 0 ? ` (+${overflow} more; see "blocked" in ${LEDGER})` : ''}. ` +
    `If there are none, write exactly "none" — an empty section reads as an unfinished document.\n` +
    `  ## What to do next — up to 3 concrete actions a fresh agent could START on, most useful first. ` +
    `Name files/ids, not intentions.\n` +
    `  ## Traps — things learned THIS run that would bite somebody who did not live it (a tool that ` +
    `lies, a path that is stale, a check that certifies itself). These are the traps so far, carried ` +
    `for you so you do not have to open the old file: ${JSON.stringify(state.traps)}. Write every one ` +
    `of them out, then add any this round taught. Never drop one.\n` +
    `It is a pickup document, not a transcript: hold it under ~150 lines, cite paths (${LEDGER}, ` +
    `${LEDGER_DIR}/artifacts/, ${LEDGER_DIR}/claims.jsonl) instead of pasting content, and do not ` +
    `restate the per-round history that ${LEDGER} already holds.\n` +
    `Then REPORT the handoff the same way you reported the hero, ABOUT THE FILE ON DISK: "written" ` +
    `only if ${HANDOFF} now exists with all five sections present and filled AND "Where it stands" ` +
    `opens with "Round ${state.round}"; "absent" if you skipped it, left a section empty, wrote a ` +
    `different round number, or could not write it. ` +
    `Also return "traps": the full list of trap lines as you just wrote them, one string each, so the ` +
    `next round can be handed them the same way you were.`,
    { ...TIER.mechanical, phase: 'Ledger', label: 'ledger', schema: LEDGER_SCHEMA }
  )
  // BOARD STATE, NOT A LATCH. This is the writer's own answer about the writer's own file, so it
  // decides nothing: the terminal audit reads the ledger dir and the two reporting gates latch from
  // THAT. Kept because the divergence is the interesting signal — a round where this says 'written'
  // and the audit finds no handoff is a lying (or confused) writer, and the board should show it.
  // ASSIGNED every round, never OR-ed, so it describes the round it names and not the run's best
  // moment. It reaches progress.json on the NEXT round's head merge, which is why it carries its own
  // round number: one round late and unambiguous beats current and guessable.
  state.reported = { round: state.round, hero: (r && r.hero) || 'absent', handoff: (r && r.handoff) || 'absent' }
  // The same fact, kept rather than overwritten. `reported` answers "what did the last round say?";
  // this answers "did this run EVER have a picture?" — and only the second question can tell an
  // evidence harness that regressed from one that was never possible.
  state.heroLog.push({ round: state.round, hero: state.reported.hero })
  // MERGED, never replaced. The handoff contract is that every trap already learned carries into
  // every later round; a writer that returns a partial list — dropping earlier entries it did not
  // bother to echo — must not be able to erase them from driver state. So union the sanitized return
  // ONTO what we already carried, keeping first-seen order, then bound. `null`/non-array leaves the
  // carried list untouched (a dead writer erases nothing). Bounded on both axes so the one deliberate
  // exception to kernel #6 stays small: a run that has learned 40 traps has a handoff nobody will read.
  if (Array.isArray(r?.traps)) {
    const returned = r.traps.filter(t => typeof t === 'string' && t.trim()).map(t => t.slice(0, 300))
    state.traps = [...new Set([...state.traps, ...returned])].slice(0, 20)
  }
}
