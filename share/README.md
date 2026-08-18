# autonomous-loop (Claude Code skill)

A skill that designs and runs an **autonomous loop** for a task that does not fit in one context. It
spends many fresh-context agents against the task while a thin deterministic driver decides what to
work on next and when to stop. The driver is code, not a judgment call: it counts verified work, and
it refuses to report success it cannot show evidence for.

The skill covers every loop shape below and picks the right one for you.

| Shape | Picks the next work from | Stops when | Canonical ask |
|---|---|---|---|
| **Converger** | rubric failures on one artifact | the counted score reaches the bar | "make X as good as Y" |
| **Exhauster** | a known, enumerable queue | the queue is empty and every item verified | "migrate all N files / clear this backlog" |
| **Saturator** | finders sweeping an unknown-size set | K rounds in a row turn up nothing new | "find every place that does X" |
| **Explorer** | hypotheses raised by earlier grounded results | the question is answered, or surprise dries up | "research this end to end" |
| **Sentinel** | events from a live stream | the invariants held across a window | "watch this and keep it healthy" |

The shapes differ only in how they pick the next work and how they stop. Everything that keeps a
long unattended run honest lives in one shared **kernel**: the worker is never the verifier; every
"done" is grounded in a signal you can check; progress is counted in code from verified units of
work, never read off a model's impression of the run; verification is **fail-closed**, so a crashed
verifier leaves the work unverified rather than passing it; a hard blocker stops the run and cannot
be averaged away; each agent starts with a fresh context; and a budget ceiling bounds the run, with
cheaper models on the mechanical stages.

The shapes also **compose**. Real work is often explore, then converge, then sentinel, and an
exhauster over a board of tickets can route each ticket to its own inner loop. See
`autonomous-loop/references/archetypes.md` (Composition) inside the package.

## What's in the package

`autonomous-loop.skill` is a zip with a top-level `autonomous-loop/` folder:

```
autonomous-loop/
  SKILL.md                      # the skill: routing, kernel, the loop, self-check, substrates
  assets/loop-template.js       # the driver template — all five shapes as one MODES table
  assets/workbench.html         # bundled live dashboard
  references/targeting.md       # choosing what to point a loop at, and what not to
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

That produces `~/.claude/skills/autonomous-loop/`. Claude Code picks it up on the next session. The
skill triggers on asks like "migrate all N files", "find every place that does X", "audit the
codebase for Y", "research this end to end", or "keep this healthy".

## Verify the install (recommended)

The driver's stop logic is code, so it is tested as code. The check costs no tokens and is
deterministic:

```bash
cd ~/.claude/skills/autonomous-loop
node scripts/selfcheck_loops.mjs        # expect exit 0
```

It runs the template against a mocked harness for every shape, prints one line per scenario, and
asserts the kernel holds in each: a clean run reaches its finished state; a verifier that crashes,
dies, or returns nothing usable can never produce a positive finish; an open blocker forces
`status='blocked'` and cannot be averaged or dried away.

The harness in this bundle is the one the driver was built against. `install.sh` unzips each bundle
it packs, runs the copy inside it, and refuses to ship one whose result or template differs from
source. So the scenario list you get here is the scenario list the template was proved against.

## Requirements

- **node** — runs the self-check and, through the Workflow substrate, the generated driver.
- **python3** — only for the optional live dashboard (`scripts/workbench_server.py`). You do not
  need it to install, trigger, or self-check the skill.

## Evidence

`BENCHMARK.md` in this bundle has the with-skill against baseline results across the eval
iterations, reported as measured. It shows where the skill helps (routing) and where it does not
(the decidability gate, which a capable base model already handles).

## License

Apache License 2.0 — see `LICENSE`, packaged alongside this file. Copyright 2026 Radiator.
