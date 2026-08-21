# Ownership Footprints
### Every attempt writes down what it touches, before it touches it — subtask 1 of issue #8
*JJ Martin · 2026-08-21 · design spec, approved in conversation before writing*

---

## The bottom line, up front

The shared working tree has no way to tell a ledger-blessed edit from a dead attempt's residue, because nothing records **which files each attempt meant to touch**. This spec adds one append-only record — `footprint.jsonl` — written by every worker as its first act, closed by every worker as its last, and read by the retry worker and the finalize agent. It is the smallest change that makes "this item's leftovers" *computable* instead of guessable, and it is the prerequisite for issue #8's subtask 2 (commit-per-verified-pass) and for any safe mechanical cleanup.

| Piece | Where | What it buys |
|---|---|---|
| `footprint.jsonl` claim/close protocol | worker prompts, via a new `footprintDirective` | a crash-surviving record of every attempt's intended files |
| Retry pointer | one sentence added to `retryDirective` | the retry worker starts from the dead attempt's footprint, not from `git status` alone |
| Reconciliation at finalize | one instruction in the finalize prompt | unclaimed edits and cross-item collisions surface in HANDOFF's "Traps" |

**Origin ruling (made in conversation): worker claim-first, not frontier-declared.** The attempt that matters most is the one that dies, and a crashed worker reports nothing afterward — so the record must be written *before* the first edit. A frontier-side declaration is a prediction by an agent that has not done the work; gating dispatch on it would serialize items that don't actually collide or wave through ones that do.

---

## The problem

When a work item's attempt fails or crashes, its partial edits stay in the shared tree (workers share one artifact by design; the driver has no filesystem access). PR #9's `retryDirective` tells the retry worker to inspect `git status`/`git diff` — but the worker has no record of *which files the dead attempt meant to touch*, so it must guess which leftovers are its predecessor's, which belong to concurrent items' live work, and which were already there. Attribution is exactly the judgment the directive demands and exactly the information the representation withholds.

The same gap blocks everything stronger: a mechanical janitor cannot be safe (it cannot tell debris from another item's in-flight progress), commit-per-verified-pass cannot scope its commits, and cross-item file collisions — two workers editing the same file in one round — are invisible until the coherence pass trips over the wreckage.

In the theory's terms: the tree is an unrecorded channel between rounds. This spec converts the channel's traffic into ledger-mediated, auditable records — the same move the kernel makes everywhere else. It is also the principled form of a session handoff: the successor reads what the predecessor *wrote down*, never what it merely remembers.

---

## The record — `footprint.jsonl`

One append-only file at `<LEDGER_DIR>/footprint.jsonl`, beside `claims.jsonl` but never confused with it: `claims.jsonl` records **verified assertions** (the ledger agent's file); `footprint.jsonl` records **intent and disposition** (the workers' file). Two line shapes:

```jsonl
{"round":4,"item":"q7","attempt":1,"event":"claim","files":["src/parser.mjs","test/parser.test.mjs"]}
{"round":4,"item":"q7","attempt":1,"event":"close","status":"done","note":"parser rewritten, tests green"}
```

- **claim** — appended BEFORE the worker's first edit. Files are the worker's honest intent at start; if scope grows mid-work, the worker appends a second claim line (append-only, never rewrite — other agents append concurrently).
- **close** — appended as the worker's last act. `status` is `done`, `noop`, or `blocked`; `note` is one line, the worker-side half of the handoff (the verifier's verdict is the other half).
- **A claim with no matching close is the signal, not an error**: the attempt died mid-work, and its claimed files are the leftover suspects. Absence is load-bearing by design — a crashed worker cannot be asked to report, so the protocol is arranged so its silence still says something precise.

`attempt` is `state.fails.get(id)+1` — driver-known, deterministic for a given round history, so a resumed run interpolates the same number and prompts replay byte-identical from cache.

---

## The three touch points

**1. `footprintDirective(item)`** — new function beside `activityDirective`, appended to every work dispatch (`workerPrompt + footprintDirective + retryDirective + stuckDirective + activityDirective`). Same bookkeeping framing as `activityDirective`: first and last actions, never lets it change the answer, append-only. Text is constant for a given (item, round, attempt) — no clocks, no counts — preserving the resume-cache discipline every other directive follows. Always on: one appended line per dispatch is the whole cost, and retry semantics should not depend on an optional flag.

**2. `retryDirective` gains one sentence**: read `<LEDGER_DIR>/footprint.jsonl` lines for this item first — a prior claim without a close is an attempt that died mid-work, and its `files` list is where to look for leftovers. The directive's existing instruction (revert or deliberately re-derive, never adopt unexamined) is unchanged; the footprint tells it *where*, which was the missing half.

**3. Finalize reconciles**: one instruction added to the finalize prompt — compare `git diff --name-only` for the run against the union of claimed files in `footprint.jsonl`; list edits no attempt claimed, and files claimed by two different items, as one line each under "Traps". Surface, don't gate: reconciliation changes no status and touches no schema.

## What deliberately does NOT change

- **No status-ladder or witness-gate change.** The audit prompt, `AUDIT_SCHEMA`, and `witnessVerdict` are untouched. Reconciliation lands in HANDOFF as prose, where a human or the next run reads it. Gating on footprints is a later decision, taken only after the bench shows footprint data is reliable in real runs.
- **No dispatch gating.** The driver never refuses to dispatch on predicted collisions — see the origin ruling.
- **No transcript handoff.** The successor reads footprint lines and the ledger, never the dead attempt's context. (The colleague's "pass the session over" proposal, in its literal form, violates context isolation; this record is its auditable substitute.)
- **No janitor.** Mechanical cleanup stays subtask 2 of #8; this spec supplies the record that will make it safe.

---

## Testing

- `selfcheck_loops.mjs`, both-halves discipline throughout:
  - every archetype's `work:` prompt carries the footprint instruction (green half); a scenario asserting the exact marker so a stripped directive goes red.
  - retried dispatch's prompt names `footprint.jsonl` (extends `retryGetsTreeWarning`); first-attempt prompt does not change beyond the constant footprint text — the byte-identity assertions in the `stuck` scenario extend to cover the new directive.
  - finalize prompt contains the reconciliation instruction.
- `eval_driver.mjs` battery: unaffected by design (asserts statuses, not prompt bytes); its self-test must stay green as the proof.
- Gates + bundle repack per CONTRIBUTING; the private bench must stay green with zero truth-column edits.

## Honesty flags

- **The footprint is testimony about intent, not a measurement.** A worker can under-claim, over-claim, or skip the append entirely; nothing enforces it in v1. What makes this acceptable: the record is cheap, the finalize reconciliation *measures* the gap between claimed and actual, and the bench will show how honest real workers are before anything gates on it.
- **A worker that crashes before its claim line leaves nothing.** The window is small (the claim is the first act) but not zero. The retry worker's existing `git status` instruction remains the backstop for exactly this case.
- **Concurrent appends to one file** rely on line-append atomicity, the same bet `activity.jsonl` already makes. Same mitigation: append-only, one line per write, never rewrite.

---
**The one-liner for the room:** *An attempt that writes down what it will touch before touching it can die without becoming a mystery — and every stronger fix on issue #8 starts from that record.*
