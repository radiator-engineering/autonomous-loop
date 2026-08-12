# autonomous-loop

Source repo for the `autonomous-loop` Claude Code skill.

The skill designs and runs an autonomous loop for a task too big for one context: many
fresh-context agents work the task while a thin deterministic driver decides what to work on next
and when to stop. `share/README.md` describes what the skill does and the five loop shapes it
routes between; this file covers the repo.

## Layout

| Path | What it is |
|---|---|
| `autonomous-loop/` | The skill itself — the only thing that gets installed |
| `autonomous-loop/evals/`, `autonomous-loop/dist/` | Present in source, never installed (see `EXCLUDES` in `install.sh`) |
| `share/` | Prose shipped inside `autonomous-loop-share.zip` |
| `autonomous-loop-workspace/` | Recorded eval runs, with-skill vs baseline |
| `install.sh` | Gate, install, and repack |

## Commands

```sh
./install.sh --check          # run the source gates, change nothing
./install.sh --check-bundles  # gate the .skill bundles on disk, change nothing
./install.sh --pack           # gate, repack the bundles, install nothing
./install.sh                  # gate, back up, install to every Claude home, repack
```

`--check` and `--check-bundles` answer different questions, and the first says so: a green source
gate does not mean the bundles on disk are shippable. Both were red-then-green at least once on
purpose.

## The gates

The install is **fail-closed** — if any check exits non-zero, nothing is copied. A skill that ships
an untested stop rule is worse than one that ships nothing.

| Gate | Refuses |
|---|---|
| `scripts/selfcheck_loops.mjs` | A kernel whose stop logic can report success it did not earn — runs the real template against a mocked harness for every archetype |
| `scripts/selfcheck_preflight.mjs` | A launch gate that would pass a driver which does not descend from the template |
| `scripts/selfcheck_docs.mjs` | A citation in the prose that no longer resolves |
| `install.sh` | A `scripts/selfcheck_*.mjs` that exists but that no `run_gate` line invokes |
| `install.sh` | A bundle that does not reproduce source's own harness result and template bytes |

Each harness carries its own red half: it feeds itself a case built to trip it and fails if that
case comes back clean. A gate that cannot fail is not a gate.

## Relationship to `gauntlet-loop`

`gauntlet-loop` is one instance of this method — the converger, with the full treatment. The two
skills cite each other in prose, and `selfcheck_docs.mjs` resolves those cross-skill citations
through the installed skill roots rather than a sibling directory, so each repo checks out and
gates on its own.
