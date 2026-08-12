# autonomous-loop (Claude Code skill)

A skill that designs and runs an **autonomous loop** for a task too big for one context: it spends
many fresh-context agents against the task while a thin deterministic driver decides what to work on
next and when to stop. It is the generic method behind the `gauntlet-loop` skill, and it covers every
loop shape below and picks the right one for you.

| Shape | Frontier (next work) | Stop when | Canonical ask |
|---|---|---|---|
| **Converger** | rubric failures on one artifact | counted score ≥ bar | "make X as good as Y" |
| **Exhauster** | pop a known, enumerable queue | queue empty, every item verified | "migrate all N files / clear this backlog" |
| **Saturator** | finders over an unknown-size set | K dry rounds in a row | "find every place that does X" |
| **Explorer** | hypotheses from prior grounded results | question answered / surprise dries up | "research this end to end" |
| **Sentinel** | events from a live stream | invariants held over a window | "watch this and keep it healthy" |

The correctness lives in a shared **kernel** every shape uses: worker ≠ verifier, every "done"
grounded in a checkable signal, progress **counted** from verified atoms in code (never a model's
gestalt), **fail-closed** verification (a crashed verifier is an unverified mandate, not a pass),
hard blocker gate, context isolation, and a budget ceiling with model tiering.

The shapes **compose**: a real engagement is often explore → converge → sentinel, and an exhauster
over a board of tickets can route each ticket to its own inner loop. See
`autonomous-loop/references/archetypes.md` (Composition) inside the package.

## What's in the package

`autonomous-loop.skill` is a zip with a top-level `autonomous-loop/` folder:

```
autonomous-loop/
  SKILL.md                      # the skill: routing, kernel, the loop, self-check, substrates
  assets/loop-template.js       # single-mode driver template (all five shapes as a MODES table)
  assets/workbench.html         # bundled live dashboard
  references/router.md          # how to route a task to the right shape + the decidability gate
  references/kernel.md          # the guardrails, each mapped to a failure mode
  references/archetypes.md      # per-shape frontier/stop/atom/example + Composition
  references/substrates.md      # Workflow / in-session Agent / committed-CI wiring
  scripts/selfcheck_loops.mjs   # zero-token proof the stop logic is safe
  scripts/workbench_server.py   # serves the dashboard on a run's ledger dir
```

## Install

The `.skill` is a plain zip. Unzip it into any Claude profile's `skills/` directory:

```bash
# pick the profile you want (repeat for each)
unzip -o autonomous-loop.skill -d ~/.claude/skills/
```

That produces `~/.claude/skills/autonomous-loop/`. Claude Code picks it up on the next session; the
skill triggers on asks like "migrate all N files", "find every place that does X", "audit the
codebase for Y", "research this end to end", or "keep this healthy".

## Verify the install (recommended)

The driver's stop logic is code, so it is tested as code — a zero-token, deterministic check:

```bash
cd ~/.claude/skills/autonomous-loop
node scripts/selfcheck_loops.mjs        # expect exit 0
```

It runs the template against a mocked harness for every shape, one printed line per scenario, and
asserts the kernel invariants on each: a clean run reaches its positive terminal state; a verifier
that crashes, dies or returns nothing usable can never produce a positive finish; an open blocker
forces `status='blocked'` and can't be averaged or dried away.

The harness in this bundle is the one the driver was built against — `install.sh` unzips each bundle
it packs, runs the copy inside it, and refuses to ship one whose result or template differs from
source. So the scenario list you get here is the scenario list the template was proved against.

## Requirements

- **node** — to run the self-check and (via the Workflow substrate) the generated driver.
- **python3** — only for the optional live dashboard (`scripts/workbench_server.py`); not needed to
  install, trigger, or self-check the skill.

## Evidence

`BENCHMARK.md` in this bundle has the honest with-skill-vs-baseline results across the eval
iterations, including where the skill measurably helps (routing) and where it doesn't (the
decidability gate, which a capable base model already handles).
