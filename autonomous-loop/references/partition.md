# Partition

The partition is how the artifact splits into regions that parallel builders can edit without
colliding. It is what lets 3+ builders work the *same* file simultaneously with zero content
conflicts. Get it wrong and either builders stomp each other's edits or the artifact loses global
coherence.

## The model

A partition is a table with two layers:

- **front → symbols** (stable, human/skill-authored): named regions of responsibility. "renderer",
  "input", "netcode", "HUD". These rarely change.
- **symbols → line ranges** (volatile, regenerated every round): the actual byte/line extent each
  symbol occupies in the *current* source.

The second layer must be **regenerated from the live source at the start of every round**, never
hand-maintained. Line numbers drift the instant anyone edits; a stale partition is how two builders
end up assigned overlapping ranges. This is the single most important property.

## Generating it (code)

`scripts/gen_partition.py` generalizes the FPS harness's `gen-arch.mjs`. It derives the
symbol→line-range layer by scanning the source for structural anchors:

- top-level declarations (`def`/`function`/`class`/`const`/`let` at column 0 or module scope),
- class methods (by consistent indentation + signature),
- assigned function expressions / arrow methods.

It then:

- merges contiguous ranges when the gap is small (≤ ~12 lines) for legibility,
- marks **red zones** — hot shared regions like a main `update()`/`render()`/`__init__`/constructor
  — as **append-only** (builders may add, not rewrite, to avoid churning the one place everyone
  touches),
- **detects overlap** — if two fronts claim the same lines, it fails loudly rather than letting
  builders collide,
- reports **coverage %** so you know how much of the file is unowned,
- validates any hand-written `file:line` pointers so stale pointers fail instead of misleading.

Wire `gen_partition` into round 0 (RE-ANCHOR). In a committed harness, gate CI on it
(`partition:check`) so the table can't go stale between runs.

## Parallel isolation options

- **Disjoint line ranges in one file** — the FPS model. Cheapest; works when the artifact is one
  big file and the partition is clean. Builders each get a range and a `node --check`/syntax gate
  before returning.
- **`isolation:"worktree"` per builder** (Agent tool / Workflow) — each builder edits in its own git
  worktree; you merge/select after. Use when builders touch overlapping regions or when you want to
  generate *competing* variants of the same region and pick the best (best-of-N).
- **File-level partition** — in a multi-file codebase, assign whole files/modules to builders. The
  symbol→line layer becomes file→owner. Simpler, coarser-grained parallelism.

## When NOT to partition

Partitioning trades global coherence for parallelism. The research is blunt: disjoint decomposition
produces locally-correct, globally-incoherent results on a large fraction of cases, and the naive
fixes (retrieval, partition-aware prompting, aggregator LLM) often regress.

- If the change is small or deeply cross-cutting, **run a single holistic builder** — don't
  partition for its own sake.
- If you do partition, **always** keep the two coherence guards from the loop: a whole-artifact
  coherence critic (reads the entire artifact, not slices) and a single-owner synthesis/integration
  pass that reconciles the parallel edits against the frozen spec.
- Declare cross-region coupling constraints explicitly (e.g. "renderer and HUD share the color
  palette in `theme`") so a builder editing one knows what invariant it must not break.

Partition to go faster, not to go blind. The parallelism is a means; the frozen spec and the
coherence pass are what keep it correct.
