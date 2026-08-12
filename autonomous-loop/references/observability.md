# Observability: the ledger, the board, and what each round must show

A dynamic workflow's tasks cannot be introspected from the harness. You see "an agent finished," not
whether the artifact changed. So every loop this skill builds writes **files** a human can watch, and
a positive finish is gated on having written two of them. This file is the contract: the schemas, the
gates, the board, retention, capture rules per archetype, and triage.

Stated elsewhere, not repeated here: **run vs round**, `resumeFromRunId` and the `hitBackstop`
precedence rule are `kernel.md` §6; the **witness rule** is `SKILL.md` invariant 8; **what goes in
the hero slot per archetype** is each `Surface` line in `archetypes.md`. Citations into
`assets/loop-template.js` name the function, not a line: the template moves.

## The five files

| File | Written by | Answers |
|---|---|---|
| `<LEDGER_DIR>/progress.json` | ledger agent, every round (`writeLedger`) | is it working *right now* |
| `<LEDGER_DIR>/HANDOFF.md` | ledger agent, every round (`writeLedger`) | how does a fresh agent pick this up |
| `<LEDGER_DIR>/claims.jsonl` | ledger agent, every round (`writeLedger`) | *which* atoms, with what evidence |
| `<LEDGER_DIR>/artifacts/` | worker/measure agents | *how* it is working, and what the count missed |
| `<RUNS_JSONL_PATH>` | finalize agent at terminal status | has this target moved across weeks |

The terminal step writes the final board — the status into `progress.json`, one line into
`runs.jsonl`, the finished `HANDOFF.md`. It returns `{finalized}` (`FINALIZE_SCHEMA`) and the driver
surfaces it: a dead finalize can promote nothing (the status is fixed before it runs) but it leaves
every one of those three reading as if the run were still going, and only the caller can see it.

The Workflow driver has no filesystem access. The **agents** write all five; the driver only computes
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
broken image in the board's top slot. Logs and diffs are **per-round artifacts**, where `artHTML`
renders them as `<pre>` (`stripHTML` in `workbench.html`) — put them in `rounds[].artifacts[]`, never in the
hero.

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
runs after the last round and before the status is computed; it reads `LEDGER_DIR` and returns three
scalars (`AUDIT_SCHEMA`): `hero`, `handoff`, `handoffRound`. The agent that skipped `HANDOFF.md` used
to be the one asked whether it wrote `HANDOFF.md` — guardrail #1 (worker ≠ verifier) broken inside the
kernel, in the two rungs that exist to catch a run reporting well and showing nothing.

| Gate | True when the audit returns | Demotes to |
|---|---|---|
| `witnessed` | `hero` is `artifact` **or** `none` | `unwitnessed` |
| `documented` | `handoff` is `complete` **and** `handoffRound === state.round` | `undocumented` |

The documentation gate is the narrower one deliberately: there is no honest "a handoff is impossible
here." The **round equality** is what makes staleness detectable — a run dying at round 40 must leave a
document describing round 40, and "a handoff was written at some point" is not that. Note the
asymmetry with the witness gate and do not tidy it away: a capture taken in round 3 is still a real
capture at round 40; a *handoff* from round 3 is a fossil.

Both fail closed — a dead auditor, a null return, a value outside the schema (`usableAudit`) or a
mismatched round leaves both false. The audit can only demote: it has no way to say "success". **Ladder order** in
the driver's terminal `status` expression: `blocked` → `budget_exhausted` → `unwitnessed` →
`undocumented` → the archetype's positive status. Showing a human nothing is the louder failure, so
it wins when both are true. Both are demote-only, and the confirmed count is still reported
truthfully either way: the gate demotes the **status**, not the count.

**Proof** — scenarios in `selfcheck_loops.mjs`: `heroAbsent` (verified 3 atoms, showed nothing)
expects `unwitnessed` with `confirmed === 3`; `heroNone` (said so out loud) converges;
`handoffAbsent` expects `undocumented` with the witness rung satisfied; `bothMissing` ranks
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
python3 scripts/workbench_server.py <LEDGER_DIR> --port <PORT>
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

**Pruning is not free, and the board does not know about it.** `stripHTML`
(`artHTML` in `workbench.html`) iterates *every* round entry in `progress.json`, so after round 8 at
`--keep-rounds 6` rounds 2-3 render as broken images in the filmstrip while the ledger still lists
them. Expected, not a bug — but if the filmstrip is the deliverable, launch with `--keep-rounds 0`
and take the disk cost. Round 1 surviving forever is a **converger** rule; for a saturator or
exhauster it just pins one unrelated early artifact on disk.

## What a round must capture

`archetypes.md` says what goes in the slot; this says how to shoot it. Six rules, and what actually
enforces each:

| # | Rule | Enforced by |
|---|---|---|
| 1 | One framing spec on disk (`artifacts/framing.json`: camera, distance, subject, seed, phase), written once and read back — never re-derived | nothing writes it; the board only *reports* its absence (`frameHTML`) |
| 2 | Four azimuths minimum for anything with a body or a place in it | prompt discipline |
| 3 | Large enough that the defect resolves; judge shape and contact before colour | prompt discipline |
| 4 | Motion when motion is the subject — a looping clip, and `type:"video"` or it renders as `<img>` | nothing writes `hero.type` (see gaps) |
| 5 | `commit` from `git rev-parse HEAD` in the process that produced the frame, never a filename or URL parameter | nothing; the board shows a missing sha as `commit unknown` |
| 6 | Same captures every round, small — thumbnails and clips, not raw 4K | pruning caps disk, not size |

`SKILL.md` Step 5 states these as prose and carries the incidents behind 2 and 5. The enforcement
column is the part you can act on: five of the six are prompt discipline, so they hold only if your
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
`framing.json` only for a measurement you repeat. The gauntlet-loop skill assumes the converger row
throughout.

Whatever the target, the hero must be **an image or a video** — a frame battery, a screenshot, a
flamegraph, a plotted benchmark, a rendered diff captured as an image. A benchmark table, a raw diff,
a log or a test report goes in `rounds[].artifacts[]`, which renders it. A loop that genuinely cannot
produce a picture sets `type:"none"` with a note naming what would be needed, and the board renders
that note in the hero slot.

## Triage: the board is not moving

| What you see | What it means | Next read |
|---|---|---|
| subtitle reads `waiting for progress.json…` | the **fetch failed** (`load` in `workbench.html`) — wrong dir, server down, or file missing. Not an idle loop | `curl <URL>/progress.json` |
| header reads `run complete`, nothing updates | polling runs every 3s only while `status === "running"`, and is cleared at terminal (`load` in `workbench.html`) | `status` in the file; reload after a resume |
| the workflow returned, and the board still says `running` | the **finalize agent died**. The run's own return says so: `finalized:false`. `progress.json` keeps the last round's `running`, `runs.jsonl` has no line, and `HANDOFF.md` still describes a run in flight | the driver's return value, then re-run the three finalize edits by hand |
| status badge is the striped violet `b-ungated` | a **reporting gate** failed (`unwitnessed`/`undocumented`) — the atoms are fine, the board or the pickup document is not. Never amber: a failed gate must not look like a benign `stopped` | the audit's finding vs `last_reported` in `progress.json` |
| hero note starts *"No capture yet. The measure step must write hero.path…"* | that is the `workbench_server.py` seed **verbatim** — the ledger step has never fired | the workflow's ledger task; expect `unwitnessed` |
| hero says "No visual evidence this round" with a *different* note | the ledger agent wrote `type:"none"` itself — witnessed, and the picture was declined deliberately | the note names what is missing |
| counters and chart move, hero frozen | the ledger agent is merging head + `rounds[]` but not writing `hero` | fix the ledger prompt; expect `unwitnessed` |
| hero slot shows a broken image | `hero.type` is `log`/`diff`, or `path` is wrong relative to the ledger dir | the `path` field |
| middle rounds broken in the filmstrip | pruning (see the workbench section) | expected |
| board looks healthy, no `HANDOFF.md` on disk | the ledger agent wrote the JSON and skipped the document — the board never shows this | `HANDOFF.md`; expect `undocumented` |

## Known gaps — do not describe these as working

| Gap | Where | Consequence |
|---|---|---|
| `hero.type` written by nothing — the ledger prompt names it only for the `"none"` case | `writeLedger`'s hero clause | a video hero renders as `<img>` unless an agent invents the field |
| `runs.jsonl` lacks `started_at`/`best_composite`/`trajectory` | finalize line vs `loadHistory` in `workbench.html` | History sparkline flat at 0.000 |
| `budget`/`model_spend` never written to the ledger head | `writeLedger`'s `head` | Budget panel reads "no budget cap" |
| Per-round `artifacts[]` / `hero` not written by the driver | the prompt says only "reference" them | the filmstrip stays empty unless the ledger agent writes them |
| `bar` (the human-readable target) never written | — | the board's subtitle is blank |
| `framing.json` generated by nothing | the prompt names the path only | comparability is prompt discipline, not enforced |
| `hero.commit` unverified | — | a wrong commit caption is possible and has happened before |
| `HANDOFF.md` and `claims.jsonl` rendered by nothing | `workbench.html` fetches neither | both are terminal work, not a board view |

Closing any of these is a driver change, not a doc change. Until then, a run that needs the missing
field has its measure or finalize agent write it explicitly.
