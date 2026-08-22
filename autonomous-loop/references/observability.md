# Observability: the ledger, the board, and what each round must show

A dynamic workflow's tasks cannot be introspected from the harness. You see "an agent finished," not
whether the artifact changed. So every loop this skill builds writes **files** a human can watch, and
a positive finish is gated on having written two of them. This file is the contract: the schemas, the
gates, the board, retention, capture rules per archetype, and triage.

Stated elsewhere, not repeated here: **run vs round**, `resumeFromRunId` and the `hitBackstop`
precedence rule are `kernel.md` §6; the **witness rule** is `SKILL.md` invariant 8; **what goes in
the hero slot per archetype** is each `Surface` line in `archetypes.md`. Citations into
`assets/loop-template.js` name the function, not a line: the template moves.

## The seven files

| File | Written by | Answers |
|---|---|---|
| `<LEDGER_DIR>/progress.json` | ledger agent, every round (`writeLedger`) | is it working *right now* |
| `<LEDGER_DIR>/HANDOFF.md` | ledger agent, every round (`writeLedger`) | how does a fresh agent pick this up |
| `<LEDGER_DIR>/claims.jsonl` | ledger agent, every round (`writeLedger`) | *which* atoms, with what evidence |
| `<LEDGER_DIR>/footprint.jsonl` | every worker, claim-first then close-last (`footprintDirective`) | which files each attempt *meant* to touch, and how it ended — a trailing claim with no close is an attempt that died mid-work |
| `<LEDGER_DIR>/artifacts/` | worker/measure agents | *how* it is working, and what the count missed |
| `<LEDGER_DIR>/activity.jsonl` | optional; any agent, or the harness | what the loop is doing *between* rounds |
| `<RUNS_JSONL_PATH>` | finalize agent at terminal status | has this target moved across weeks |

The terminal step writes the final board — the status into `progress.json`, one line into
`runs.jsonl`, the finished `HANDOFF.md`. It returns `{finalized}` (`FINALIZE_SCHEMA`) and the driver
surfaces it: a dead finalize can promote nothing (the status is fixed before it runs) but it leaves
every one of those three reading as if the run were still going, and only the caller can see it.

The Workflow driver has no filesystem access. The **agents** write all seven; the driver only computes
what they are told to write. That is why the ledger step is a prompt, not a `writeFile`.

`claims.jsonl` gets one `{id, evidence}` line per atom newly confirmed that round — the only per-atom
trail on disk. The frontier agent is handed its *path*, never its contents, as the record behind the
count (see the explorer's `frontier`). Nothing renders it; read it with `jq`.

## `progress.json`

Merged top-level each round from `roundEntry`/`head`, plus the hero the ledger agent composes:

```json
{
  "target": "…", "mode": "saturator", "status": "running",
  "started_at": "2026-08-12T14:03:00Z",      // ledger agent sets it if absent
  "pass_threshold": 0.9,
  "confirmed": 41, "open": 6, "blocked": 0,
  "hitBackstop": false,                       // written at finalize; seeded false
  "hero": {
    "type": "image",                          // image | video | none — see the renderer note
    "path": "artifacts/r7-hero.png",          // relative to the ledger dir
    "label": "district A, azimuth 0",
    "commit": "a1b2c3d…",                     // `git rev-parse HEAD` in the process that RENDERED it
    "framing": "artifacts/framing.json",      // written once, read back, never re-derived
    "before": { "path": "artifacts/r1-hero.png", "commit": "…", "label": "round 1" },
    "note": "…"                               // REQUIRED when type is "none"
  },
  "rounds": [
    { "round": 7, "composite": 0.62, "pass_count": 15, "total": 25, "accepted": 3,
      "confirmed": 41, "open": 6, "dry": 0, "gap": false, "hasBlocker": false, "stall": 0 }
  ]
}
```

`composite` is the driver's counted progress, never a model's score (`kernel.md` §3). `accepted` is
atoms newly confirmed this round. It does **not** on its own reset `stall`: `agePatience` resets only
on `grew > 0 && !state.gap`, so with an unverified mandate open the counter keeps climbing through a
round that confirmed three atoms. Debugging a run that went `blocked` on patience, read `accepted`
and `gap` together.

**The hero renderer takes two values, not five.** `frameHTML` (`workbench.html`) branches on
`type === 'video'` and emits `<img src=path>` for everything else; `heroHTML` short-circuits on
`type === 'none'` or a missing `path`. So a hero with `type:"log"` or `"diff"` and a path renders a
broken image in the board's top slot. Logs and diffs belong in `artifacts/`, where the **Artifacts
tab** lists them by type with a link — never in the hero.

**Two different things are both called `hero`.** The object above lives in the file. The ledger agent
*returns* a separate three-value report — `"artifact" | "none" | "absent"` (`LEDGER_SCHEMA`) — about
the file **as it stands on disk after its edit**. That return latches **nothing**: it is the writer's
word about the writer's own file. It is carried onto the board as `last_reported` (one round behind,
and it names its own round), and the gates are decided by the terminal audit instead — below.

## `HANDOFF.md` — the pickup document

The same ledger agent rewrites `HANDOFF.md` **from scratch every round** — overwritten, never
appended. `progress.json` is counted state, machine-shaped; a fresh agent picking up a run that died
at round 40 needs prose. Rewriting keeps it bounded and keeps it describing the run *as it stands*,
rather than making a reader reconstruct the present from a transcript. Five sections, all filled:

**What this run is for** (destination + what one verified atom is) · **Where it stands** (**its first
line must begin `Round N`** — the audit reads that number back and a handoff whose round is not the
run's last one does not count; then counts, and how far the terminal predicate is from firing *in its
own terms* — dry/`DRY_ROUNDS`, composite/`PASS_THRESHOLD`, stall/`BLOCKER_PATIENCE`) · **Open
blockers** (one line each, id + what
is actually stuck, or exactly `none`) · **What to do next** (≤3 actions naming files and ids) ·
**Traps** (a tool that lies, a stale path, a check that certifies itself).

**Traps is carried forward**; the other four are replaced each round. Those are the only lines a
fresh reader cannot re-derive from the artifacts, so dropping one loses it for good. Hold the whole
file under ~150 lines and cite paths instead of pasting content; the driver passes a **bounded**
blocker slice (20, plus an overflow count) for the reason `kernel.md` §6 gives. At terminal status
the finalize agent rewrites *"Where it stands"* in place, in the same file — a fresh agent that finds
two handoff documents has to work out which is current.

## The two output gates

A run that showed a human nothing, or left the next agent nothing to read, may not call itself a
success. `SKILL.md` invariant 8 states the witness half.

**Both are decided by a terminal AUDIT, not by the ledger agent.** One cheap `TIER.mechanical` agent
runs after the last round and before the status is computed; it reads `LEDGER_DIR` and returns five
scalars (`AUDIT_SCHEMA`): `hero`, `handoff`, `handoffRound`, `captures`, `distinctCaptures`. The agent that skipped `HANDOFF.md` used
to be the one asked whether it wrote `HANDOFF.md` — guardrail #1 (worker ≠ verifier) broken inside the
kernel, in the two rungs that exist to catch a run reporting well and showing nothing.

| Gate | True when the audit returns | Demotes to |
|---|---|---|
| `witnessed` | `hero` is `artifact`, **or** `none` with `captures === 0` | see the three below |
| `documented` | `handoff` is `complete` **and** `handoffRound === state.round` | `undocumented` |

The witness half demotes to one of **three** statuses, not one, because it was firing the same word at
three different facts. Replayed over five real ledgers the hero slot had been filled zero times, and
the single `unwitnessed` was wrong about two of the five runs:

The tests run in this order, and the order is the whole design (`witnessVerdict` in the template):

| # | Audit shape | Status | What it tells the operator |
|---|---|---|---|
| 1 | `captures >= 4`, `distinctCaptures * 2 <= captures` | `evidence_regressed` | **The camera is jammed.** Ranks with the blockers. |
| 2 | `hero: artifact` | *(witnessed)* | A real frame, pointed at. Converges. |
| 3 | the run *ever* reported an artifact, points at none now, **and** `captures < 4` | `evidence_regressed` | **The harness worked and stopped**, going only on the pointer history because the gallery is too small for row 1's ratio test to have an opinion. |
| 4 | `hero: none`, `captures: 0` | *(witnessed)* | Nothing to show, said out loud. Converges. |
| 5 | frames exist, `hero` points at none, never captured before | `unpointed` | **Promote one.** Only the pointer is missing. |
| 6 | nothing on disk, no hero | `unwitnessed` | **Build a capture path.** |

Two subtleties the order encodes, both of which triage depends on:

- **The jam is tested first, before even `hero: artifact`** — a board leading with a frame from a
  stuck harness is the worst reading of all, not an acceptable one. But the test is *mostly* stuck, not
  *ever* repeated: `distinctCaptures * 2 <= captures`, gated on `captures >= 4` so there is enough
  evidence before the harness gets accused. Two real corpora broke the earlier "any duplicate is a
  jam" rule — a healthy 40-round camera at 110 captures/77 distinct, and a run at 6/4 where the camera
  was fine while the run itself was stuck on something unrelated — both of which a majority-repeat
  floor waves through. Measured on the jam it was built to catch: a harness broke at round 3 and each
  later capture re-emitted round 1's frame byte-for-byte, four files deep, while the board read 7 of 9
  confirmed with no blocker — 1 distinct of 4, still fires.
- **`unpointed` and `evidence_regressed` look identical on disk** — frames present, hero pointing at
  none — and row 3's tiebreak is *history*, not the directory, but only below row 1's own floor. A run
  whose earlier rounds reported an `artifact` hero (`everCaptured`) and whose gallery is still small
  (`captures < 4`, too little for the ratio test to have cleared or convicted it) had a working camera
  and lost the pointer, so it is `evidence_regressed`, not `unpointed`. Once the gallery is big enough
  for row 1's ratio test to run, that test's finding stands: a healthy, mostly-distinct gallery is not
  re-accused just because history shows an earlier `artifact` hero. **MEASURED** (issue #4): a 25-round
  exhauster with 28 captures, 22 distinct — all duplicates early-run, capture script pinned unchanged
  the whole run — whose final item legitimately had nothing to show read `evidence_regressed` under the
  old unconditional history check; the harness had provably never stopped, so the accurate read is
  `unpointed` (row 5), promote a frame. Only a run that produced frames but *never* pointed at one, or
  one whose history-based case falls below the floor, lands here as the one-line bookkeeping fix. The
  doc's own motivating jam case — a harness that broke mid-run and re-emitted a stale frame — still
  lands on `evidence_regressed` via row 1's ratio test, and "promote a frame" would be exactly the
  wrong advice for it. `evidence_regressed` sits with the blockers rather than with the reporting
  rungs because a capture path that worked and stopped makes every later round's evidence
  untrustworthy, including rounds already counted green.

The rung is replayable without running a loop: `scripts/replay_gates.mjs` extracts the decision
function from the template (never a copy of it) and runs it over synthetic cases plus any ledger
directories you pass.

The documentation gate is the narrower one deliberately: there is no honest "a handoff is impossible
here." The **round equality** is what makes staleness detectable — a run dying at round 40 must leave a
document describing round 40, and "a handoff was written at some point" is not that. Note the
asymmetry with the witness gate and do not tidy it away: a capture taken in round 3 is still a real
capture at round 40; a *handoff* from round 3 is a fossil.

Both fail closed — a dead auditor, a null return, a value outside the schema (`usableAudit`) or a
mismatched round leaves both false. The audit can only demote: it has no way to say "success". **Ladder order** in
the driver's terminal `status` expression: `blocked` → `evidence_regressed` → `budget_exhausted` →
`unpointed` → `unwitnessed` → `undocumented` → the archetype's positive status. Showing a human nothing is the louder failure, so
it wins when both are true. Both are demote-only, and the confirmed count is still reported
truthfully either way: the gate demotes the **status**, not the count.

**Proof** — scenarios in `selfcheck_loops.mjs`: `heroAbsent` (verified 3 atoms, showed nothing)
expects `unwitnessed` with `confirmed === 3`; `heroNone` (said so out loud) converges;
`heroNoneWithGallery` (said so out loud with four frames on disk) demotes to `unpointed`;
`heroNoneJammedCamera` and `heroArtifactJammedCamera` (four frames, one picture) demote to
`evidence_regressed` whether or not the board points at one, and `heroJammedCamera` (six frames, two
distinct — a majority-repeat gallery) demotes the same way, proving the test is `distinctCaptures * 2
<= captures` and not `< captures`; `heroBenignDuplicates` (six frames, four distinct — under half
repeats, the corpus-shaped counterexample) reaches its positive status instead;
`heroFinalNoneAfterHealthyGallery` (issue #4 — earlier rounds pointed at a real frame, the final
round's item legitimately has none, 28 captures/22 distinct) demotes to `unpointed`, not
`evidence_regressed`, proving row 3's history tiebreak yields to row 1's ratio test once the gallery
clears its floor; and `heroNoneNoGallery`
keeps the honest half converging; `auditNoCaptures` (an otherwise-perfect audit missing the new
scalar) is unreadable and fails closed; `handoffAbsent` expects `undocumented` with the witness rung
satisfied; `bothMissing` ranks
`unwitnessed` above; `deadLedger` fails closed; `staleHandoff` (written in round 1, skipped in round
2) is `undocumented`; `deadAuditor` demotes; `staleAudit` (a complete handoff naming the round before
last) demotes; `lyingLedger` (the writer says `written`, the audit finds nothing) demotes and the
writer's claim still reaches the board. `handoffAbsent`, `deadLedger` and `staleAudit` also run under
the **converger**: the ladder is shared kernel code, so no mode-specific regression can hide.

**Trap:** `workbench_server.py` (`main`, the seeding branch) seeds `progress.json` with `hero.type:"none"` plus a note so a
fresh board never renders blank. That seed is not a witness — so a run whose ledger step never fires
finishes `unwitnessed` while the file on disk looks answered. The audit reads the *file*, so this is
the one place it is told a rule rather than left to look: a note still beginning "No capture yet." is
the seed, and it answers `absent`. Triage tells the two apart by the same wording.

**The lying hero, and why the gate now counts the directory.** For a while `hero.type="none"` plus a
non-empty note converged on its own word, and nothing compared that note against the directory it was
a claim about. Measured, on a run whose whole purpose was improving this board: the ledger agent wrote

> *"Chrome not available in this environment; capture.sh requires /Applications/Google Chrome.app …
> headless screenshot capability is required to generate r5-board.png."*

while `r5-board.png` sat in `artifacts/` beside eleven other round captures, all taken by that same
script, on that same machine, in that same run. Chrome was installed. The capture step had succeeded
every round. The agent did not look; it composed a plausible reason for an absence that did not
exist, and the board rendered it as the run's headline evidence — the amber "no visual evidence"
panel sitting directly on top of a full gallery.

The gate accepted it. `witnessed` was satisfied by `none`-with-a-note exactly as by a real capture,
which is deliberate — a loop is allowed to be unable to produce a picture. What was not deliberate is
that the escape hatch was unfalsifiable: the same defect as counting an unverified atom, one rung up,
inside the gate that exists to catch runs which report well and show nothing.

The terminal audit already opens `LEDGER_DIR`, so it now answers a fourth scalar — **`captures`**, how
many image files sit in `artifacts/` — and `witnessed` reads:

```js
witnessVerdict(audit, everCaptured(state)) === 'witnessed'
```

A `none` returned beside a non-empty gallery is not believed. *Which* demotion it earns depends on the
directory first and the run's history second: a run that never once pointed at a frame demotes to
`unpointed` — it produced evidence and failed only to point at it, one line of bookkeeping, and should
not read as "showed a human nothing." A run that *had* been pointing at real captures and lost the
pointer demotes to `evidence_regressed` only while the gallery is still too small (`captures < 4`) for
the ratio test to have cleared it; once the gallery is big enough and that test finds it healthy, a lost
pointer alone reads as `unpointed`, not as a blocker — a camera that worked and stopped is a blocker,
losing a pointer on a healthy camera is a bookkeeping slip (see the ordered table above, row 3, and
issue #4). `captures` is asked as its own question
for the same reason the audit exists at all: `hero` is what the board points at, `captures` is what
the run produced, and the two disagreeing is the finding. `distinctCaptures` asks the follow-up that
counting alone cannot: *are those frames the same picture?* Both are required by `AUDIT_SCHEMA` and by
`usableAudit`, so an audit that omits either is unreadable and both gates fail closed.

Note what the rung does **not** do: it never promotes. A full gallery with `hero.type="none"` is
demoted, not quietly upgraded on the gallery's behalf — the gate is about what the board *leads with*,
and a frame nobody points at is a frame nobody sees. `scripts/selfcheck_loops.mjs` holds the three
cases (`heroNoneWithGallery`, `heroNoneNoGallery`, `auditNoCaptures`); the middle one is what keeps
the fix from collapsing into "stop believing `none`", which would punish a genuinely non-visual loop.

## `activity.jsonl` — the round in flight

`writeLedger` fires **once per round**. A round routinely runs for minutes and spends dozens of
agents, so between two writes `progress.json` says nothing and the board is frozen — and a frozen
board is indistinguishable, to the person watching it, from a hung run. That ambiguity is the whole
reason this file exists. It is the only view of a round that has not finished.

`workbench_server.py` serves the panel at `/activity.json`, assembled from the first of two sources
that answers, and it tells the board **which one it got**:

| Source | Cost | Use when |
|---|---|---|
| `activity.jsonl` in the ledger dir | tokens, if an agent writes it | any substrate — including a committed CI harness, where no transcript exists |
| the harness's `<session>/subagents/agent-*.jsonl` | free | an in-session or Workflow run on this machine |

One JSON object per line, appended, never rewritten:

```json
{"ts":"2026-08-13T14:31:02Z","agent":"verify:auth.ts","phase":"Verify","event":"start"}
{"ts":"2026-08-13T14:33:40Z","agent":"verify:auth.ts","phase":"Verify","event":"end","status":"ok"}
```

`event` is `start` or `end`; later lines win, so an `end` closes the agent its `start` opened. A
half-written trailing line is skipped rather than fatal — something is appending to this file while
the server reads it, and that is normal.

**The driver cannot write it, so the agents that already run do.** `activityDirective` in
`assets/loop-template.js` appends a short bookkeeping instruction to every **work** and **verify**
prompt: one line before the agent starts, one when it finishes. No extra agent and no extra round —
the only cost is the directive's own tokens, and `ACTIVITY_LOG = false` in Config turns it off.

The directive text is **constant** for a given (phase, label): no timestamp, no round number, no
counts. Same rule `stuckDirective` follows. A resumed run replays byte-identical prompts from cache,
so interpolating a clock here would re-pay for every agent in the run on every resume, in order to
log the resume.

The same discipline covers `retryDirective`: an item's second dispatch tells its worker something
about its dead predecessor, but a first attempt's prompt stays untouched. Its wording has evolved
twice — see the two paragraphs below — but the byte-identity rule (constant text once an attempt has
failed, never varying attempt to attempt) has held through both.

`footprintDirective` still fires on every dispatch, first and retried alike: the worker claims the
files it means to touch, before its first edit, into `footprint.jsonl`. The finalize agent reconciles
claimed footprints against what this run actually changed — the shared tree's uncommitted changes
(`git status --porcelain`) plus the files carried by its landed attempt merges — surfacing unclaimed
edits and cross-item collisions under HANDOFF's "Traps". (Under attempt isolation, porcelain alone
is clean by construction: every worker edit is committed inside its own worktree and reaches the
shared tree as a merge commit, so reconciling against porcelain only would see nothing.)

**Commit-per-verified-pass** (issue #8 subtask 2, spec: `2026-08-21-verified-commits-design.md`; superseded by subtask 3, below, on a git substrate). With `VERIFIED_COMMITS` on, the Ledger step used to commit each item that verified `pass` this round straight out of `footprint.jsonl`'s claimed files: `git add -A -- <those files>` (never a bare `git add -A`) then `git commit -m "<id>: …"`, one commit per item. `retryDirective` reset the item's own claimed files unconditionally — `git checkout` / `git clean` — before working, because nothing verified could ever be sitting uncommitted any more.

**Attempt isolation** (issue #8 subtask 3, spec: `2026-08-21-attempt-isolation-design.md`) replaces that mechanism for any git substrate. With `VERIFIED_COMMITS` on, every worker isolates its attempt in its own git worktree and branch (`<LEDGER_DIR>/attempts/<slug>` on `attempt/<slug>`, where the slug is `refSlug(id)`: item ids are not
legal git refs — a saturator's id IS its locator (`src/a.rs:12`) and a sentinel's is `<round>:<id>` — so the
kernel slugs every id to git's charset and appends a hash of the raw id so two ids cannot collide onto one
attempt; `selfcheck_refnames.mjs` proves the derived names against real git for every archetype's id shape —
`worktreeDirective`, constant text on every dispatch, first attempt or retry, that resets-and-recreates the worktree off the current mainline unconditionally), commits its own work inside that worktree as it goes, and never touches the shared tree. An independent verifier checks that isolated attempt (`worktreeVerifyDirective`), never the shared tree, which has not changed yet this round — and when the attempt is EMPTY (no worktree, or a branch with no commits of its own) it checks the item's done-criterion against the shared tree instead. An empty attempt is a fact to report, never a verdict: some items are legitimately no-ops (a criterion already passing, evidence that only needed gathering, an experiment that only needed running), and mandating a FAIL for them made a mostly-passing rubric unable to converge. A NEW, single, sequential **Merge** phase — for the identical concurrency-safety reason subtask 2 put commits in the Ledger step rather than the parallel Verify step — runs immediately after Verify: for every item that verified pass, it attempts `git merge --no-ff <that item's branch>` against the shared tree, in the driver's own listed
order, using the id-to-branch mapping the driver supplies (the agent never builds a ref from an id itself).
A branch that does not exist, or a merge that reports "Already up to date", is a legitimate no-op attempt —
reported as merged, because there is nothing to land and nothing to retry. A clean merge lands the item; a genuine conflict is a NEW failure mode, reported structurally (`MERGE_SCHEMA`, not free text) and treated as an OPEN MANDATE — filed under `unverified`, exactly where a crashed verifier's item is filed, so it is not confirmed, not counted, holds `gap` true (no positive terminal status can fire while it is open), and is retried into a fresh worktree off the (by then updated) mainline, which `worktreeDirective`'s unconditional reset already provides with no separate instruction needed. `retryDirective` shrinks to a short constant note: there is nothing left on the shared tree to reset, because a dead attempt never touched it. The Coherence pass (only the converger archetype implements it) relocates from before Verify to after Merge, reconciling only the items that actually landed — before Merge runs, the shared tree has not changed at all this round, so there is nothing yet to reconcile. It is the one step that edits the shared tree directly, so it COMMITS what it changes (`git add -A && git commit -m "coherence: reconcile round"`) and finishes on a clean `git status`: nothing else in the run commits that tree, and an uncommitted edit left behind is not merely lost from HEAD — it blocks the next round's merge of any attempt touching the same file. `VERIFIED_COMMITS` defaults true and MUST be set false on a target that is not a git working tree: it is not self-disabling. The worker and verifier directives gate on the constant alone, so a `true` on a non-git target hands every worker a `git worktree add` that cannot run; only the Merge phase probes the tree itself (`git rev-parse --is-inside-work-tree`), and it never runs when nothing verified pass.

Because the agents write it, this is the source that works on **any** substrate, including a
committed CI harness where no transcript exists.

The transcript fallback is **auto-detected** when `--transcripts` is not passed: the most recently
modified `subagents/` dir under `~/.claude/projects`. That is right almost always and wrong the
moment two sessions run at once, so the board prints that it guessed rather than presenting the
answer as certain. Pass `--transcripts <session>/subagents` when it matters.

When neither source exists the panel does **not** render empty. It names the two ways to feed it, on
the same rule the hero slot follows: absent evidence must say what would produce it, because a blank
box reads as "nothing is happening" and that is exactly the claim it cannot support.

The agent list is capped at `ACTIVITY_MAX` (60) so one enormous round cannot make `/activity.json`
itself unbounded — the same construction rule `build-dashboard` gives every paginated table. The
server reports what it dropped as `truncated`, and the board renders that count as a small note next
to the agent total whenever it is nonzero, so a capped list never reads as a complete one.

## `runs.jsonl`

One line per run at terminal status; a resume rewrites its own line rather than adding a second:

```json
{"run_id":"…","target":"…","mode":"saturator","status":"saturated","rounds":9,"confirmed":41,"blocked":0,"hitBackstop":false}
```

One target's history in one file: did the last five runs converge, or did three ride the rail? To
answer that read `hitBackstop`, not `status` (`kernel.md` §6 gives the precedence and why). The
board's History panel wants three fields this line does not carry — see the gaps table.

## The workbench: launch, LIVE, retention

```
python3 scripts/workbench_server.py <LEDGER_DIR> --port <PORT> [--transcripts <session>/subagents]
node   scripts/preflight_launch.mjs <driver.js> <LEDGER_DIR> --workbench http://127.0.0.1:<PORT>
```

Start the server **first**: it seeds the ledger, creates `artifacts/`, writes the `.gitignore`, and
copies `workbench.html` in as `index.html` (`workbench_server.py`, `main`). The board leads with the
hero at full width — `before` beside `now`, each captioned with its own commit — and puts the
counters underneath (`heroHTML` in `workbench.html`). Then the **LIVE** gate
(the **LIVE** gate in `preflight_launch.mjs`) writes a random nonce into the ledger dir and fetches it back over
HTTP, the only proof the board a human was handed is serving *this* run (`SKILL.md` Step 4 records
why). Green writes `PREFLIGHT.json`; that is when the URL goes to the user.

Renders are **served, never committed** — `SKILL.md` Step 5 carries the measured reason. The dir gets
a `*` `.gitignore`, and `prune_artifacts` in `workbench_server.py` prunes `artifacts/r<N>-*` to the most recent
`--keep-rounds` (default 6) plus **round 1, kept forever**, at startup and every 60s. Only files
whose name matches `r<N>-` / `round_<N>-` are touched, so hand-placed evidence and `framing.json`
survive.

**Pruning is not free, and the filmstrip does not know about it.** `renderStrip` (`workbench.html`)
iterates *every* round entry in `progress.json`, so after round 8 at
`--keep-rounds 6` rounds 2-3 render as broken images in the filmstrip while the ledger still lists
them. The **Artifacts tab** does not have this problem — it lists what is on disk, so a pruned round
is simply absent rather than broken. Expected, not a bug — but if the filmstrip is the deliverable, launch with `--keep-rounds 0`
and take the disk cost. Round 1 surviving forever is a **converger** rule; for a saturator or
exhauster it just pins one unrelated early artifact on disk.

### How the board updates, and why it matters

The server **pushes**. It stats the ledger files a few times a second — no reads — and emits one
server-sent event on `/events` when a digest actually moves, so the page updates within about 200ms
of a write and is idle the rest of the time. If that connection dies the page falls back to polling
every 3s, compares the raw response text first, and re-renders only on a real change. The header
says which transport is live (`live · pushed` vs `live · polling`); they fail differently and a
watcher who cannot tell them apart cannot trust either.

Every update is a **diff against what is on screen**, and this is a load-bearing property rather
than an optimisation. The board previously rebuilt eight containers with `innerHTML` on a 3-second
timer against a file written once per round: it paid that cost roughly sixty times per real change,
and each time the round a reader had expanded collapsed, a looping `<video>` hero restarted before
it had played a second of the motion it was in the slot to demonstrate, and a horizontally scrolled
filmstrip snapped back to round 1 mid-look. The board was busy and blind at the same time.

The rule when editing `assets/workbench.html`: **never assign `innerHTML` to a container a person can
interact with.** Text goes through `setText` (compares first), whole subtrees through
`setHTMLIfChanged` (compares a signature first), and lists through `keyed` (reconciles by key, so a
row still on screen is the *same node object* it was — which is what preserves scroll, selection and
`<details>` state). `<details open>` is decided at creation only; re-deciding it on every pass is
what slammed an open round shut three seconds after it was opened.

`scripts/selfcheck_board.mjs` checks all of that, including running the real `keyed` against a fake
DOM to assert an unchanged list performs **zero** DOM mutations. Like every harness here it carries
its own red half — five deliberate defects plus a rebuild-everything reconciler — because a comment
asking the next editor not to re-render is what failed the first time.

## The board's design bar

Read this before you change `assets/workbench.html`. It is the bar the board is judged against, and
it is written down so a reviewer has to name a rule instead of stating a preference. Three outside
skills set it — `building-dashboards` (axiomhq), `build-dashboard` (anthropics) and `enterprise`
(bergside/awesome-design-skills). Their rules are copied here rather than cited, because two of the
three live in repositories this skill does not control and one of them has already been deleted
once.

**Who the board is for.** Somebody who walks up to a run that has been going for two hours and needs
to know within seconds whether to leave it alone, kill it, or go read something. Build and ops
engineers, on call. Not an executive summary, and not a reader of these reference files. That
audience decides every trade-off below: fast refresh, blockers near the top, and no word on the
screen that has to be looked up.

### Purpose — what each panel owes

1. Every panel answers a question that leads to an action. A panel that answers no question is
   decoration, however well it renders.
2. Broad at the top, narrower in the middle, raw at the bottom.
3. Prefer rates and percentiles to averages. An average hides the bad case.
4. One question per panel.
5. **Compute what was asked for, or say you cannot. Never substitute a different quantity, even
   with a disclaimer.**

Rule 5 is the one this board keeps breaking, and it is the witness gate one level down: an absent
picture must never read as "nothing to show". A panel that renders `–`, `0` or an empty list because
its *source* is missing is making a false statement about the run. It has to say what is missing and
what would fill it.

| Tier | Question it answers | On this board |
|---|---|---|
| At a glance | Is it working right now? | hero capture, status, confirmed/blocked, live agent count |
| Trends | Is it still moving, or has it plateaued? | the chart across rounds, the dry-round streak |
| Breakdowns | Where should I look? | the rounds list, open blockers, the per-phase agent split |
| Evidence | What exactly happened? | the Artifacts tab, claims, the handoff |

### Words on the board

The board must not print this skill's own vocabulary. `atom`, `archetype`, `composite`, `frontier`
and `ledger dir` are the right words in the driver and in these reference files, and the wrong words
on a screen: a headline number whose noun the reader has to look up is a headline number the reader
skips. That is rule 1 failing quietly — the panel renders, and it still leads to no action.

So the board names the unit the way the run's own subject would name it. `unit(mode, n)` in
`workbench.html` maps each archetype's atom to a plain noun, straight from the `Atom:` line in
`archetypes.md`:

| Loop shape | What it counts | The board says |
|---|---|---|
| converger | a rubric criterion | check / checks |
| exhauster | a queue item | item / items |
| saturator | a finding | finding / findings |
| explorer | a claim | claim / claims |
| sentinel | an invariant | rule / rules |
| unknown mode | — | result / results |

An unknown mode gets a deliberately vague noun rather than a borrowed one. "18 results" is thin;
"18 findings" on a run that counts queue items is false.

`composite` became **score**, and it is shown only for the converger, which is the only archetype
that computes one. The `VOCABULARY` check in `selfcheck_board.mjs` scans the page markup and every
string the render path emits — not comments, not identifiers, not `${…}` interpolations — and fails
if any banned word reaches the screen. Phase names (`Frontier`, `Verify`) are exempt: the board
echoes whatever `phase()` title the driver emitted, so renaming them is a template change.

### Construction

- Two to four headline numbers at the top, each with its change against the prior round. A number
  with no delta cannot tell progress from a standstill, and that is the one thing a loop watcher
  needs.
- Update only what changed. Never rebuild the DOM for a poll or a filter — the rule in "How the
  board updates" above, and `setText` / `setHTMLIfChanged` / `keyed` are how it is kept.
- Responsive grid, and print styles.
- Cap table rows rather than letting a list grow without bound.

**Two deliberate deviations. Do not tidy them into conformance:**

- *No Chart.js and no CDN of any kind.* The board is one HTML file served over localhost with no
  network guarantee, copied into a run directory that is deleted afterwards. A CDN `<script>` makes
  it fail exactly when somebody is offline debugging a run. Charts stay as hand-written inline SVG.
- *No webfont.* Same reason. The system font stack stays.

### Surface tokens

Dark cloud-platform look, modular grid, panels, strong hierarchy in the data.

| Token | Value |
|---|---|
| primary | `#0C5CAB` |
| secondary | `#0a4a8a` |
| success | `#10b981` |
| warning | `#f59e0b` |
| danger | `#ef4444` |
| surface | `#09090b` |
| text | `#fafafa` |
| radius | `4px` small, `8px` medium |
| spacing | 8pt baseline grid |
| type scale | 12 / 14 / 16 / 20 / 24 / 32 |

Conformance means every padding, margin and gap is a multiple of 8 — 4 is allowed inside a control —
every font size is on the scale, and every status colour comes from success/warning/danger instead of
being invented per badge. `selfcheck_board.mjs` checks the spacing and the type scale directly, so
this is a gate rather than a review note. Where the board already reads as GitHub dark and a token
would be a jarring repaint, prefer the token but keep the contrast: the goal is one system, not a
reskin.

### What a change to the board must not break

Each of these fails a check, not a review:

- `selfcheck_loops.mjs` reads the board: every terminal status the driver can emit has a badge, the
  two gate statuses look different from an ordinary stop, and every badge class has a CSS rule. It
  matches the literal `const map={` and the `.b-xxx{` spellings as text — no space before the brace.
- `selfcheck_board.mjs` reads it too: no `innerHTML` outside the allowed writers, `<details>` open
  state decided once at creation, every id selector resolving, the rounds empty state a sibling of
  the reconciled list, the inline script parsing, the server routing all three endpoints, the
  gallery reading the directory, and capture mode connecting to nothing.
- A capture must stay possible. `?static=1` connects to no stream and starts no repeating timer, or
  the board can no longer be photographed and the run loses its evidence.

## What a round must capture

`archetypes.md` says what goes in the slot; this says how to shoot it. Eight rules, and what actually
enforces each:

| # | Rule | Enforced by |
|---|---|---|
| 1 | One framing spec on disk (`artifacts/framing.json`: camera, distance, subject, seed, phase), written once and read back — never re-derived | nothing writes it; the board only *reports* its absence (`frameHTML`) |
| 2 | Four azimuths minimum for anything with a body or a place in it | prompt discipline |
| 3 | Large enough that the defect resolves; judge shape and contact before colour | prompt discipline |
| 4 | Motion when motion is the subject — a looping clip, and `type:"video"` or it renders as `<img>` | nothing writes `hero.type` (see gaps) |
| 5 | `commit` from `git rev-parse HEAD` in the process that produced the frame, never a filename or URL parameter | nothing; the board shows a missing sha as `commit unknown` |
| 6 | Same captures every round, small — thumbnails and clips, not raw 4K | pruning caps disk, not size |
| 7 | A browser-driving harness only ever drives a browser it started itself — own `user-data-dir`, own debug port, launched and killed by the script. An operator's already-running browser is never a CDP target | `scripts/check_harness.mjs` pins the script, not what it touches; `scripts/lint_design.mjs`'s L6 warns at design time on a capture plan that names attaching to an existing/running browser; and a capture that finds the browser's process id changed since its last call must report a **failed capture**, not a frame (`SKILL.md` Step 4) |
| 8 | A harness claims one tab by URL prefix at startup and reuses it for every capture and every retry — it never opens a new tab per invocation, even inside a browser it owns | prompt discipline; `SKILL.md` Step 4 carries the incident and the fix, since owning the browser (rule 7) does not by itself stop a self-owned browser from accumulating its own tabs |

`SKILL.md` Step 5 states these as prose and carries the incidents behind 2, 5, 7 and 8. The enforcement
column is the part you can act on: six of the eight are prompt discipline, so they hold only if your
measure step's prompt names them.

**Rules 1 and 6 are converger-shaped, and so is the filmstrip.** They assume one artifact re-shot
over time, which is what makes rounds comparable — the converger's point, not every loop's:

| Archetype | Same subject each round? | `before` should be | Filmstrip reads as |
|---|---|---|---|
| Converger | yes | round 1, permanently | a trajectory — use it |
| Sentinel | yes (the watched thing) | last known-good, not round 1 | a trajectory — use it |
| Exhauster | no — a different queue item | that item's own pre-state (its diff) | a gallery; ignore it |
| Saturator | no — a different finding | omit it | a gallery; ignore it |
| Explorer | no — a different measurement | omit, or the prior run of the *same* experiment | a gallery; ignore it |

For the bottom three, one shared framing spec across unrelated items is meaningless: round 1's
finding is not a BEFORE for round 7's. Shoot each item in the framing that resolves *it*, and write
`framing.json` only for a measurement you repeat. The converger row is the one this guidance was
first written for, and it is still the row it fits best.

Whatever the target, the hero must be **an image or a video** — a frame battery, a screenshot, a
flamegraph, a plotted benchmark, a rendered diff captured as an image. A benchmark table, a raw diff,
a log or a test report is written into `artifacts/`, where the Artifacts tab lists it by type and
links it, and may also be declared in `rounds[].artifacts[]` to tie it to a round. A loop that genuinely cannot
produce a picture sets `type:"none"` with a note naming what would be needed, and the board renders
that note in the hero slot.

## Triage: the board is not moving

| What you see | What it means | Next read |
|---|---|---|
| subtitle reads `waiting for progress.json…` | the **fetch failed** (`load` in `workbench.html`) — wrong dir, server down, or file missing. Not an idle loop | `curl <URL>/progress.json` |
| header reads `run complete`, nothing updates | updates run only while `status === "running"`, and stop at terminal (`schedulePoll` in `workbench.html`) | `status` in the file; reload after a resume |
| counters frozen but the workflow panel is moving | **normal, and the point of the panel** — a round is in flight and `writeLedger` has not fired yet | nothing; watch the phase and the agent ages |
| both the counters and the workflow panel are frozen | no agent has written a line for over 90s. A round that is genuinely stuck looks exactly like this | the agent ages in the panel; then the run's own return |
| workflow panel says *"No workflow feed configured"* | neither source resolved — no `activity.jsonl`, and no transcripts dir found or passed | restart the server with `--transcripts`, per the `activity.jsonl` section |
| workflow panel names agents from another run | the transcript dir was **auto-detected** and a second session is newer. The panel says it guessed | pass `--transcripts <session>/subagents` explicitly |
| header says `live · polling`, not `live · pushed` | the `/events` stream is not connected — an older server, or the page is on `file://` | `curl -N <URL>/events`; expect `event: change` lines |
| the workflow returned, and the board still says `running` | the **finalize agent died**. The run's own return says so: `finalized:false`. `progress.json` keeps the last round's `running`, `runs.jsonl` has no line, and `HANDOFF.md` still describes a run in flight | the driver's return value, then re-run the three finalize edits by hand |
| status badge is the striped violet `b-ungated` | a **reporting gate** failed (`unwitnessed`/`undocumented`) — the atoms are fine, the board or the pickup document is not. Never amber: a failed gate must not look like a benign `stopped` | the audit's finding vs `last_reported` in `progress.json` |
| hero note starts *"No capture yet. The measure step must write hero.path…"* | that is the `workbench_server.py` seed **verbatim** — the ledger step has never fired | the workflow's ledger task; expect `unwitnessed` |
| amber "no visual evidence" panel, but the **Artifacts tab is full** | a LYING HERO: the ledger agent wrote a `none` note without opening `artifacts/`. The witness gate accepts it — it checks the note exists, never that it is true | open the gallery; the run is witnessed in fact. Treat the terminal status as unearned and fix the ledger step, not the board |
| hero says "No visual evidence this round" with a *different* note | the ledger agent wrote `type:"none"` itself — witnessed, and the picture was declined deliberately | the note names what is missing |
| counters and chart move, hero frozen | the ledger agent is merging head + `rounds[]` but not writing `hero` | fix the ledger prompt; expect `unwitnessed` |
| hero slot shows a broken image | `hero.type` is `log`/`diff`, or `path` is wrong relative to the ledger dir | the `path` field |
| middle rounds broken in the filmstrip | pruning (see the workbench section) | expected |
| board looks healthy, no `HANDOFF.md` on disk | the ledger agent wrote the JSON and skipped the document — the board never shows this | `HANDOFF.md`; expect `undocumented` |

## Known gaps — do not describe these as working

| Gap | Where | Consequence |
|---|---|---|
| `hero.type` written by nothing — the ledger prompt names it only for the `"none"` case | `writeLedger`'s hero clause | a video hero renders as `<img>` unless an agent invents the field |
| `runs.jsonl` lacks `started_at`/`best_composite`/`trajectory` | finalize line vs `loadHistory` in `workbench.html` | History sparkline flat (no trajectory points); the best-composite number beside it now falls back to `–` via `fmt()` instead of fabricating `0.000` — the render-side substitution is closed, but finalize still owes the write |
| `budget`/`model_spend` never written to the ledger head | `writeLedger`'s `head` | Budget panel reads "no budget cap" |
| Per-round `artifacts[]` / `hero` not written by the driver | the prompt says only "reference" them | the **hero slot** and the filmstrip stay empty unless the ledger agent writes them. The **Artifacts tab** is unaffected: it reads `artifacts/` off disk, so evidence the run produced is visible whether or not an agent declared it |
| `bar` (the human-readable target) never written | — | the board's subtitle is blank |
| `framing.json` generated by nothing | the prompt names the path only | comparability is prompt discipline, not enforced |
| `hero.commit` unverified | — | a wrong commit caption is possible and has happened before |
| `claims.jsonl` missing vs. empty read the same | `loadClaims` in `workbench.html` | `HANDOFF.md` tells "no file yet" apart from "file is empty", but a missing `claims.jsonl` and a present-but-empty one both fall through to the same "No claims.jsonl yet" text — a cosmetic gap, not a false-positive one |
| the transcript fallback reads a path this skill does not own | `find_transcript_dir` in `workbench_server.py` | if the harness moves `subagents/`, the fallback goes quiet. It reports its source, so this is visible rather than silent — and `activity.jsonl` is unaffected |
| agent **phase** is absent from the transcript source | the shards carry the session `slug`, not the driver's `phase()` | the phase row is filled only by `activity.jsonl`. The fallback still shows liveness, names and ages |
| `activity.jsonl` depends on agents following a prompt | `activityDirective` | an agent that ignores the directive is simply missing from the panel. Nothing verifies the log, and nothing should: a run must never be failed for a bookkeeping line |
| **Frontier**, **Coherence**, **Ledger** and the terminal agents write no activity line | only work and verify carry the directive | those phases show as gaps in the panel. They are single agents on the round's critical path, and the directive costs prompt budget in every one of them — deliberate, revisit if a frontier step ever gets slow enough to need watching |

Closing any of these is a driver change, not a doc change. Until then, a run that needs the missing
field has its measure or finalize agent write it explicitly.
