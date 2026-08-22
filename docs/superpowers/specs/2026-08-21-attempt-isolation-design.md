# Attempt Isolation
### Each attempt gets its own worktree; only a passing one merges — subtask 3 of issue #8
*JJ Martin · 2026-08-21 · design spec*

---

## The bottom line, up front

Subtasks 1 and 2 made a dead attempt's leftovers *computable* (`footprint.jsonl`) and then
*discardable without judgment* (commit-per-verified-pass). Both still let every attempt — live or
dead — write into the one shared tree first and get reconciled after the fact. This spec removes the
"after the fact" entirely: every work attempt gets its own git worktree on its own branch
(`attempt/<id>`), the verifier verifies that isolated attempt, and a single sequential agent — the
same serialization point subtask 2 already established for `git commit` — merges the branch into the
shared tree ONLY when verify has already said pass. A failed attempt's worktree simply never merges;
there is no leftover to clean because nothing of a failed attempt ever touches the tree everyone else
reads. A NEW failure mode falls out of this for the first time — a verified attempt whose branch will
not merge cleanly — and this spec treats it exactly like a refuted verdict: the item does not land, it
retries, and the fresh worktree it retries into is thrown away and rebuilt from the (by then updated)
mainline unconditionally, every attempt, first or retry alike.

| Piece | Where | What it buys |
|---|---|---|
| `worktreeDirective(item)` | worker prompt, new function beside `footprintDirective` | every attempt isolated in `<LEDGER_DIR>/attempts/<id>` on branch `attempt/<id>`, reset-and-recreated unconditionally on every dispatch |
| Verify locates the worktree | verify prompt, new `worktreeVerifyDirective(item)` | the verifier checks the isolated attempt, never the shared tree, which has not been touched yet |
| **Merge** — a new kernel phase | between Verify and the per-item Ledger loop, one sequential agent, `MERGE_SCHEMA` | only a verified pass gets tried; a clean merge is the only way an attempt's work reaches the shared tree; a conflict is reported structurally, not discovered as a surprise later |
| Coherence, relocated | after Merge instead of before Verify | it reconciles ATTEMPTS THAT JUST MERGED, because before Merge the shared tree has not changed at all this round |
| `retryDirective`, shrunk | almost entirely subsumed by `worktreeDirective` | nothing left to judge — a fresh worktree IS the reset |

**Origin ruling, carried forward from subtask 1: worker claim-first, `VERIFIED_COMMITS`-gated.**
Everything here fires only when `VERIFIED_COMMITS` is true — the same knob subtask 2 introduced to
mean "this run's TARGET is a git working tree." A non-git substrate (design canvas, live system,
rubric artifact) gets none of this, exactly as it got none of subtask 2's commits, and falls back to
the shared-tree discipline subtasks 1/2 already establish for it.

---

## Why subtask 2 is not enough, and what this closes

Subtask 2 made "this item's leftovers" mechanically discardable, but it never removed the channel —
it shortened the *time* a leftover can sit unaccounted for to one round, and it left one hazard
explicitly unfixed, named twice in its own honesty flags: **two concurrently-dispatched items whose
footprint claims genuinely collide on a file remain equally possible.** If item A is mid-edit on a
file B also claims, B's unconditional reset (`git checkout` / `git clean` on ITS OWN claimed files)
can still erase A's in-flight, uncommitted work — because both are editing the SAME shared tree at the
SAME time, and nothing before this subtask stops that.

Attempt isolation removes the precondition for that hazard rather than mitigating its consequence:
if A and B never share a working tree while they work, A's in-flight edits are not reachable by
anything B's reset does, no matter what files the two claim in common. The claim-collision hazard
subtask 1 named and subtask 2 inherited is the thing subtask 3 is the "actual structural cure" for —
worded exactly that way in subtask 2's own honesty flags, and it is the reason this subtask exists.

---

## How a worker is told to create/name its worktree

A new function, `worktreeDirective(item)`, appended to the work dispatch alongside
`footprintDirective` — same slot, same discipline:

```
agent(mode.workerPrompt(item, state) + worktreeDirective(item) + footprintDirective(item) +
      retryDirective(item.id) + stuckDirective(item.id) + activityDirective('Work', `work:${item.id}`), ...)
```

**Naming is deterministic and constant per item — no round number, no attempt counter — exactly the
cache-constancy discipline `footprintDirective` already holds:**

- Worktree path: `${LEDGER_DIR}/attempts/${item.id}`
- Branch: `attempt/${item.id}`

Both live under `LEDGER_DIR`, the run's own bookkeeping directory — the same place `footprint.jsonl`,
`claims.jsonl`, and `activity.jsonl` already live, not inside TARGET's own tree. `git worktree add`
accepts any path on disk; putting attempts there means every step that needs to find one only ever
needs `LEDGER_DIR` and an item id, which every phase already has, rather than a fact only the worker
that created it would know.

**The directive text, unconditionally, on every dispatch:**

> Before any edit: if `<path>` already exists (a dead or failed prior attempt), remove it and its
> branch first — `git worktree remove --force <path>` then `git branch -D <branch>` if the branch
> still exists — so you always start from a clean slate. Then create a fresh one off the CURRENT
> mainline: `git worktree add <path> -B <branch> HEAD` (run from the shared tree). Do every edit,
> test, and commit INSIDE `<path>` — never touch the shared tree directly, and never run `git merge`
> yourself; merging only happens after an independent verifier passes this attempt. Commit your work
> there as you go, on `<branch>`, so the branch actually holds something to merge when it passes — an
> attempt with no commits is indistinguishable from one that did nothing. Footprint claims name files
> relative to `<path>`.

**Why unconditional, on the first attempt too:** the reset-and-recreate step is harmless when nothing
exists yet (`git worktree remove` on a path that is not a worktree is the only branch that needs a
defensive "if it exists" clause, which the instruction already carries) and it is exactly what a retry
needs when something does. One text, one behavior, no branch on `state.fails` at all — which is a
STRICTLY simpler invariant than `retryDirective` needed before this subtask (see below): the worker
prompt does not need to know whether this is attempt 1 or attempt 6, because the recreate step means
attempt 6 is not meaningfully different from attempt 1 to the worker that receives it. This is what
lets `worktreeDirective` be constant with respect to `state.fails` where `retryDirective` could not
be — and it is the reason the STUCK scenario's byte-identity invariant (attempts 2..STUCK_AFTER share
one prompt) gets EASIER to hold here, not harder: this directive doesn't even have the two-branch
shape that invariant exists to police.

---

## How the verifier locates the attempt's worktree, and merges on pass

**Locating it needs no new record.** The path is `${LEDGER_DIR}/attempts/${item.id}` — a pure function
of two values every phase already has (`LEDGER_DIR` is Config, `item.id` is the batch entry). A new
`worktreeVerifyDirective(item)` is appended to the verify dispatch:

> This attempt happened in an isolated worktree, not the shared tree — verify INSIDE `<path>` (cd
> there before running any check), never against the shared tree, which has not been updated with
> this attempt yet. If `<path>` does not exist, or `<branch>` has no commits, that is itself a FAIL —
> the worker never produced a real attempt — say so as your evidence.

`VERDICT_SCHEMA` is untouched: the verifier still returns exactly `{id, pass, evidence, ...}`. Verify
does not merge and does not need to know how — it answers the same question it always has (did this
attempt meet the item's done-criterion?), just scoped to a directory instead of the shared tree. This
is also a small SAFETY WIN over subtask 2, worth naming: subtask 2's verifiers were read-only with
respect to the shared tree "in every case this spec changes," which was true but delicate — a verifier
running the wrong command could still touch the shared tree by mistake, because it was sitting right
there. An isolated verifier physically cannot touch what it cannot see; the shared tree is not in its
working directory at all.

**Merging is a NEW kernel phase, not something the verifier does itself**, for the identical reason
subtask 2 put the commit in the Ledger step and not the Verify step: **Verify runs in parallel, up to
`BATCH` items at once (`parallel(worked.map(...))`), and `git merge` against the shared tree is not
concurrency-safe any more than `git commit` was.** Two verifiers each running `git merge` against the
same `.git/index` at the same wall-clock time do not corrupt anything, but the second to the lock
either waits, fails outright, or — worse than the commit case — could conflict against a
merge-in-progress it never intended to touch. A verifier that legitimately passed an item would have
its merge silently lost or corrupted, which is a sharper version of the exact "un-recorded-pass" defect
subtask 2 exists to eliminate.

So: **Verify answers the pass/fail question; a new, single, sequential phase — Merge — does the git
operation**, immediately after Verify and before the per-item Ledger accounting loop:

```
phase('Merge')
const toMerge = verdicts.map((v, i) => (v && v.pass) ? batch[i] : null).filter(Boolean)
const mergeResult = (VERIFIED_COMMITS && toMerge.length)
  ? await agent(<merge instructions, below>, { ...TIER.mechanical, phase: 'Merge', label: 'merge', schema: MERGE_SCHEMA })
  : { merged: toMerge.map(m => m.id), conflicts: [] }
```

Skipped entirely when nothing verified pass this round (cost discipline identical to Coherence's own
`worked.length < 2` guard) and a no-op passthrough when `VERIFIED_COMMITS` is off (non-git target).

**The merge agent's instructions**, one prompt, sequential over the passed ids in the driver's own
listed order — same "batching means one agent, sequential commands, never a squashed operation"
discipline subtask 2 established for commits:

> This round's verifiers passed `<ids>`. First check whether the shared tree is inside a git
> repository; if not, report every id "merged" (there is nothing to merge against) and stop.
> Otherwise, for EACH id, IN ORDER, from the shared tree: `git merge --no-ff attempt/<id> -m "<id>:
> merge verified attempt"`. If it merges cleanly, remove that attempt's worktree and report it
> "merged". If it conflicts, run `git merge --abort`, leave the attempt's worktree in place (its
> branch still holds the work — a retry rebuilds it fresh; this one is just not landing THIS round),
> and report it in "conflicts" with the id and the conflicted file list
> (`git diff --name-only --diff-filter=U` BEFORE the abort) as evidence. Never leave the repo
> mid-merge: always resolve to a clean `git status` before you finish.

`MERGE_SCHEMA` (new — see "What this forces to change," below):

```js
const MERGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['merged', 'conflicts'],
  properties: {
    merged:    { type: 'array', items: { type: 'string' } },
    conflicts: { type: 'array', items: { type: 'object', additionalProperties: false,
                   required: ['id', 'evidence'],
                   properties: { id: { type: 'string' }, evidence: { type: 'string' } } } },
  },
}
```

## What a merge conflict means — the new failure mode

A conflict is not a crash and not a malformed response — the merge agent answered cleanly, it just
could not fast-track the merge. It means exactly this: **the attempt's verifier-blessed work is real,
but it no longer applies cleanly to a mainline that moved since the attempt's worktree branched.**
Nothing about the attempt was wrong; the world under it changed. Two ways that happens: a DIFFERENT
item's attempt merged into the shared tree earlier in the SAME round's Merge sequence (Merge is
sequential and processes ids in order, so an earlier id's merge genuinely can move the tree under a
later one), or an item on its second-plus attempt whose worktree, per `worktreeDirective`, was
rebuilt off a mainline from an EARLIER round that has since accepted other merges.

**The kernel treats a conflicted item exactly like a refuted verdict, not like a crash:**

```js
const merged = new Set((mergeResult && Array.isArray(mergeResult.merged)) ? mergeResult.merged : [])
...
if (v.pass && !merged.has(item.id)) {
  // verified, but did not land — treated like a refutation: retry, not confirmed, not committed
  bumpFail(item.id)
  state.seen.add(key)
  mode.retry(state, item)
  continue
}
```

This is FAIL-CLOSED in the same sense every other unreadable-or-negative signal in this kernel is: an
item is never counted, never committed, never resolved unless it is BOTH independently verified AND
actually landed on the shared tree. A `mergeResult` that is missing or malformed (`merged` not an
array — the same shape of failure `usable()` already guards against for verdicts) defaults `merged` to
an empty set, so a crashed or unreadable Merge agent fails EVERY item that round rather than
guessing — the identical posture subtask 2 already takes for a Ledger step that cannot commit
("degrades to a no-op for that round... silently from the driver's point of view"), just with the
consequence made visible in the SAME round instead of accumulating silently, because this kernel can
now read the outcome structurally instead of trusting free text.

**"Item retries on a fresh worktree off updated main" needs no separate instruction.** This is the
payoff of `worktreeDirective` being unconditional on every dispatch, not just retries: the conflicted
item's NEXT dispatch — whether that is later this same run's next round, or immediately if the
frontier re-offers it — carries the identical `worktreeDirective` text every other dispatch carries,
and that text always resets-and-recreates off `HEAD`, which by then reflects every merge that has
landed, including the one that just conflicted with it. No new directive branch, no new prompt text
keyed on "this failed because of a MERGE conflict specifically" — the existing unconditional reset
already does the right thing, which is the whole reason this subtask's retry story is simpler than
subtask 2's, not more complex.

---

## The coherence pass: from "reconcile one tree" to "reconcile after merges"

Coherence existed to catch a break visible only BETWEEN regions, invisible to any per-item verifier
scoped to its own region. Before this subtask, it ran BEFORE Verify, reconciling the raw result of
parallel workers who had just edited the ONE shared tree, each blind to the others — "so the verifiers
judge the reconciled artifact rather than the raw merge of parallel edits."

**That reason is gone, because the premise is gone.** Workers no longer edit the shared tree at all —
each works in its own isolated worktree, and the shared tree does not change AT ALL until Merge runs.
Running coherence before Verify, as before, would have it staring at a shared tree that is byte-for-
byte what it was at the start of the round: there is nothing yet to reconcile. The cross-region break
coherence exists to catch can only be VISIBLE after the round's passing attempts have actually landed
on the one tree that shows it — which is after Merge, not before Verify.

**New position in the round:** Frontier → Work (isolated) → Verify (isolated) → Merge (sequential) →
**Coherence** → Ledger. The kernel's call site changes from filtering `worked` (every worker that ran,
crashed or not) to filtering to items that actually merged this round:

```js
if (mode.coherence) {
  const landed = batch.filter((item, i) => verdicts[i] && verdicts[i].pass && merged.has(item.id))
  phase('Coherence')
  await mode.coherence(state, landed)   // mode.coherence's own `worked.length < 2` guard, unchanged,
}                                        // still no-ops the agent call when there is nothing to reconcile
```

Only items that actually landed are worth reconciling — a failed OR conflicted attempt changed nothing
on the shared tree, so passing it to coherence would have the reconciler reading region names for work
that is not there.

**The converger's coherence prompt — the only implementation in the reference file — changes to
describe what actually happened**, replacing "parallel workers just edited these disjoint regions...
each edit was made without sight of the others" with:

> These items just MERGED into the shared tree this round, each from its own isolated worktree,
> without sight of each other while it worked: `<regions>`. Reconcile them: fix breaks that exist only
> BETWEEN regions — a shared helper changed under another region, duplicated logic, an interface
> renamed on one side, imports or types that no longer line up. Do NOT fix a criterion, and do not
> touch anything that is not a cross-region break: a separate verifier already re-measured every
> criterion before it merged, and work you do inside a region here is work nothing independently
> checks THIS round.

The last clause is a genuinely new caveat, not a copyedit: previously a coherence FIX inside a region
would be re-verified next round by construction (verify always ran after coherence). Now verify has
ALREADY run, before coherence, on the isolated attempt — a coherence edit made now, inside a region,
touches the shared tree post-merge with no verifier scheduled to look at it again until that item is
NEXT dispatched, which may be never if it never needs rework. This does not change what coherence is
ALLOWED to touch (still cross-region breaks only, never a criterion) — it sharpens WHY that boundary
matters more than it used to, and the prompt now says so.

**Coherence's guardrails are otherwise unchanged**: still optional per archetype, still a repair and
not a mandate (a crash here is still not a gap — nothing has claimed a criterion is met, so a failed
reconciliation leaves the round exactly as unreconciled as skipping it would, per the kernel's existing
comment), still runs at the escalate tier, still may not fix a criterion.

---

## What happens to `retryDirective`

Before this subtask, `retryDirective` (with `VERIFIED_COMMITS` on) told the retry worker to reset its
OWN claimed files unconditionally — `git checkout` / `git clean` — because commit-per-pass guaranteed
nothing verified could be sitting uncommitted on the shared tree. That instruction assumed a shared
tree with leftovers worth resetting.

**Attempt isolation removes the premise a second time.** There is no leftover to reset on the shared
tree, because the dead attempt never touched the shared tree — its entire half-finished state lives in
a worktree `worktreeDirective` already destroys and rebuilds on THIS dispatch, unconditionally, whether
or not this is a retry. `retryDirective`'s git-specific job — read footprint, checkout, clean — has
NOTHING left to do that `worktreeDirective` was not already going to do anyway.

**`retryDirective` shrinks to a short, constant-per-attempt-count-independent note, kept only for
observability continuity** (a worker benefits from being told explicitly that a prior attempt existed,
even though the tree gives it no evidence of that fact any more — the isolated worktree it receives
looks IDENTICAL whether this is attempt 1 or attempt 6):

```js
function retryDirective(id) {
  if (!((state.fails.get(id) || 0) > 0)) return ''
  if (VERIFIED_COMMITS) {
    return `\n\nRETRY: a previous attempt at this item did not land — either it failed verification ` +
      `or its merge conflicted. You are starting in a FRESH, isolated worktree (see WORKTREE below) ` +
      `that carries none of the prior attempt's edits; there is nothing to inspect or reset. Re-derive ` +
      `the item from a clean slate.`
  }
  return `\n\nRETRY: ...` // subtask 1's original text, byte-for-byte, unchanged — the fallback for a
                           // non-git TARGET, which never gets a worktree at all
}
```

This keeps the SAME byte-identity property the scenario suite already polices — `retryDirective`
returns `''` on a first attempt and a constant string on every attempt after, never varying by attempt
NUMBER (2 vs. 6) — and it is a strictly smaller invariant to hold than before, because the new text no
longer branches on "which files, which commits" at all; it is the same three sentences on every retry
regardless of how many prior attempts there were.

---

## What this forces to change (and what stays untouched)

The task brief is explicit that the witness gate, status ladder, and schemas stay untouched **unless
the design proves a change is forced.** Two things are forced, both named plainly:

1. **`MERGE_SCHEMA` is a new schema.** It is forced because a merge, unlike subtask 2's commit, can
   genuinely fail for a reason that is not a crash — a real conflict against a mainline that moved —
   and the kernel needs a STRUCTURED answer to keep treating that fail-closed the way it treats every
   other verdict. Subtask 2 could get away with pure free text because a commit of files the verifier
   JUST examined on the SAME tree cannot meaningfully conflict; nothing analogous protects a merge
   against a mainline other attempts may have already advanced this same round. This is a new schema,
   not a change to `VERDICT_SCHEMA` or `LEDGER_SCHEMA` — verify and the ledger writer answer exactly
   the same questions they always have.
2. **The per-item Ledger loop gains one new fail-closed branch** (`v.pass && !merged.has(item.id)` ⇒
   treated as refuted), immediately after the existing `usable(v)` check and before the existing
   `if (v.pass)` branch. This is additive: every existing branch — crashed verifier, refuted verdict,
   blocker escalation — is unchanged in shape and order; a run whose `MERGE_SCHEMA` agent always
   reports 100% merged (the `VERIFIED_COMMITS`-off passthrough, and every existing scenario's default)
   takes this branch NEVER, so no existing invariant's outcome moves.

**Untouched, and stated so nothing here is mistaken for having quietly touched it:**

- **The witness gate** (`witnessVerdict`, the hero/handoff reporting rungs, the terminal AUDIT). Merges
  are not evidence in the witness gate's sense and are never consulted by it, exactly as subtask 2's
  commits were not.
- **The status ladder.** `blocked` → `evidence_regressed` → … is unchanged; a merge conflict routes
  through the SAME `mode.retry` / `bumpFail` path a refuted verdict always has, so it can trip
  `STUCK_AFTER` or `BLOCKER_PATIENCE` exactly as a refuted verdict would and no differently.
- **`VERDICT_SCHEMA`.** The verifier's contract is unchanged; it answers pass/fail about an isolated
  directory instead of the shared tree, which is a change to WHERE it looks, never to WHAT it returns.
- **`LEDGER_SCHEMA` and the Ledger writer's own prompt shape.** Commit-per-pass (subtask 2's own
  addition to that prompt) is REPLACED by the Merge phase for a git target — the Ledger agent no
  longer stages and commits a passed item's files itself; that work already happened inside the
  worker's own worktree commits, and Merge already landed them. The Ledger writer's job — progress.json,
  HANDOFF.md, `claims.jsonl` — is otherwise identical.

---

## The honest costs

**Workers lose live sight of each other's in-flight work.** This is the cost the ticket names up
front, and it is real, not a formality: before this subtask, two workers editing genuinely disjoint
files in the SAME shared tree could each see the other's edits appear on disk mid-round — an
accidental but sometimes useful channel (a worker noticing a helper another item just renamed, for
instance, even though nothing FORMALLY told it to look). After this subtask, that channel is gone by
construction: an isolated worktree shows a worker nothing about any other item's attempt until AFTER
Merge lands it, which is after that worker has already finished and reported. The coherence pass is
the FORMAL substitute for exactly this — it is the one place a whole-artifact view exists at all after
this change — but it is optional per archetype, escalate-tier (expensive), and only reconciles what
already landed; it cannot warn a still-working item about a collision in progress the way an
accidental glance at a shared tree sometimes could.

**A genuine claim collision is now a MERGE conflict instead of a silent overwrite — worse to hit, but
detectable for the first time.** Subtask 2 left cross-item claim collisions "surface, don't gate": a
colliding retry's unconditional reset could erase another item's in-flight work with NOTHING recording
that it happened, because both were edits to the same file in the same tree and a `git checkout`
cannot tell whose intent it is discarding. Under attempt isolation, two items editing genuinely the
same file in the same round show up as a REAL git merge conflict — reported, in `conflicts`, with the
file list, exactly once, structurally, not merely surfaced in HANDOFF prose after the fact. This is
strictly better information than subtask 2 could ever produce, but it costs a round: a genuine
collision between two items that were BOTH doing real, good work now costs one of them a retry it did
not, in isolation, deserve — the price of the isolation is that the kernel can no longer let the
SECOND item's edit simply win by writing over the first's, the way the shared tree quietly allowed
before.

**Retries pay for a git worktree add/remove pair on every dispatch, not just retries.** `worktreeDirective`
being unconditional (the property that makes the retry story simple) means EVERY first attempt also
pays for a defensive `worktree remove --force` on a path that, on a first attempt, never existed —
one wasted, cheap, and always-safe shell command per dispatch. Priced at essentially nothing next to
an agent turn, but named because "unconditional" is a real trade against "only pay the removal cost
when there is something to remove," and this spec chooses the simpler invariant over the cheaper one.

**The Merge phase adds one more agent per round that pays even when nothing conflicts** — a small,
bounded cost (skipped entirely when nothing verified pass; one sequential call, not one per item,
when something did), but it is a NEW agent in the round's critical path that did not exist before this
subtask, sitting between Verify and Ledger on every round that landed anything.

---

## Testing

Red-first, extending `selfcheck_loops.mjs` alongside the existing footprint/commit scenarios:

- **`workerGetsWorktree`** — every `work:` prompt, first attempt and retry alike, carries the WORKTREE
  directive naming `<LEDGER_DIR>/attempts/<id>` and `attempt/<id>`, and the instruction is IDENTICAL
  across attempts (byte-identity, same assertion shape as `workClaimsFootprint`).
- **`verifyLocatesWorktree`** — the `verify:` prompt for an item names the same worktree path the
  worker's prompt named, and instructs cd'ing there rather than checking the shared tree.
- **`mergeRunsAfterPassingVerify`** — an item passes verify; the `merge` prompt for that round names
  its id and instructs `git merge --no-ff attempt/<id>`, never a bulk operation across ids not passed.
- **`mergeSkipsUnpassedItems`** — an item fails verify; the same round's `merge` prompt does not name
  it (paired with the case above, mirroring `ledgerSkipsFailedItems`'s pattern).
- **`mergeSkippedWhenNothingPassed`** — no item verifies pass this round; `h.counts['merge']` is 0
  (cost discipline, mirroring `coherenceSkipped`).
- **`mergeConflictRetries`** — the harness's `merge` mock reports one passed id in `conflicts` instead
  of `merged`; that id is NOT counted (`everConfirmed` does not grow for it), NOT committed/landed, and
  IS retried — its next `work:` prompt is dispatched again, carrying the RETRY text.
- **`mergeCrashFailsClosed`** — the harness's `merge` mock returns `null`; every item that verified
  pass this round is treated as unmerged (none confirmed), the SAME fail-closed posture as a crashed
  verifier, and the round registers a gap.
- **`coherenceReadsLandedOnly`** — extends `coherenceRuns`: an item that verified pass but whose merge
  conflicts is NOT included in the region list the coherence prompt names, even though it "worked"
  this round; only merged items appear.
- **`coherencePromptDescribesMerge`** — the coherence prompt for a run with `>= 2` landed items
  contains "MERGED into the shared tree" and does not contain the retired "each edit was made without
  sight of the others" wording, pinning the prompt-text rewrite, not just the call-site change.
- **`retryShrunkToNote`** — the two-round shape `retryGetsTreeWarning`/`retryResetIsUnconditional`
  already use: the retry `work:` prompt carries `RETRY:` and mentions the fresh worktree, but no longer
  contains `git checkout` / `git clean` (that instruction moved to being redundant with
  `worktreeDirective` and was removed, not merely renamed).
- Every existing scenario must stay green UNCHANGED: the harness's default `merge` mock
  (`{ merged: <every passed id>, conflicts: [] }`) makes the new phase's fail-closed branch never fire
  for a scenario that does not deliberately exercise it — the same "off-branch proven by inspection,
  not separately exercised" posture `VERIFIED_COMMITS`'s own off-state already takes, except here the
  DEFAULT behavior of the new mock IS the pass-through case, so nothing needs a separate off-switch.

Gates + bundle repack per CONTRIBUTING; the private bench must stay green with zero truth-column edits.

---

## Honesty flags

- **A worktree is a directory, not a sandbox.** Nothing stops a worker from `cd`-ing back to the
  shared tree and editing it directly against the directive's instruction, the same way nothing ever
  stopped a worker from ignoring `footprintDirective`. The isolation here is a discipline the prompt
  asks for and the Merge phase's structure rewards (only a merged branch counts), not an enforced
  filesystem permission — this kernel has never had the latter for anything.
- **`worktreeDirective`'s reset step trusts `git worktree remove --force` and `git branch -D` to be
  safe on a path/branch that may not exist.** Both commands are documented to fail cleanly (non-zero
  exit, no side effect) when their target is absent; the directive relies on that rather than asking
  the worker to check existence first, to keep the text unconditional and constant.
- **Two items merging in the SAME round can still make a THIRD item's later-round retry conflict for a
  reason that has nothing to do with that third item's own work** — its worktree branched off a
  mainline that two OTHER items' merges have since moved twice. This is not a bug in the isolation; it
  is the same "the world under it changed" story stated above, compounding when a round lands more than
  one merge. Nothing in this spec bounds how many times a single item can be pushed through this by bad
  luck alone; `STUCK_AFTER`'s existing escalation is the only backstop, unchanged.
- **Skipped-Merge-phase-when-nothing-passed leaves one edge implicit**: if `toMerge.length === 0` the
  driver never asks whether the shared tree is even a git repo this round. That check only happens
  inside the merge agent's own prompt, so a round that verifies nothing pass tells the operator nothing
  about whether `VERIFIED_COMMITS` is correctly configured. Not new — subtask 2's commit block had the
  identical gap — but inherited, not closed, here either.

---
**The one-liner for the room:** *A failed attempt that never touches the tree everyone else reads
cannot leave a leftover in it — this subtask is subtasks 1 and 2's record-and-reset discipline, made
structurally unnecessary for the case that mattered most.*
