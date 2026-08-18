# autonomous-loop

Source repo for the `autonomous-loop` Claude Code skill.

The skill points Claude at a task that does not fit in one context. It spends many fresh-context
agents against the task while a thin deterministic driver decides what to work on next and when to
stop. The driver is code, not a judgment call: it counts verified work, and it refuses to report
success it cannot show evidence for.

Ask for it the way you would ask a person — "migrate all 40 handlers", "find every place that
writes a raw SQL string", "research this end to end", "keep this healthy" — and the skill picks the
loop shape, designs the unit of work, proves the stop rule, then runs it.

## The five shapes

| Shape | Picks the next work from | Stops when | Canonical ask |
|---|---|---|---|
| **Converger** | rubric failures on one artifact | the counted score reaches the bar | "make X as good as Y" |
| **Exhauster** | a known, enumerable queue | the queue is empty and every item verified | "migrate all N files / clear this backlog" |
| **Saturator** | finders sweeping an unknown-size set | K rounds in a row turn up nothing new | "find every place that does X" |
| **Explorer** | hypotheses raised by earlier grounded results | the question is answered, or surprise dries up | "research this end to end" |
| **Sentinel** | events from a live stream | the invariants held across a window | "watch this and keep it healthy" |

Choosing the shape is the decision that matters most, and it is the one the skill measurably
improves — see [Evidence](#evidence). The shapes also compose: real work is often explore, then
converge, then sentinel, and an exhauster over a board of tickets can route each ticket to its own
inner loop.

## What every shape shares

The five shapes differ only in how they pick the next work and how they stop. Everything that keeps
a long unattended run honest lives in one shared kernel:

- **The worker is never the verifier.** The agent that did the work does not get to grade it.
- **Every "done" is grounded in a signal you can check** — a test, a diff, a command's exit code —
  not an agent's summary of its own work.
- **Progress is counted in code** from verified units of work, never read off a model's impression
  of how the run is going.
- **Verification is fail-closed.** A verifier that crashes, hangs, or returns nothing usable leaves
  the work unverified. It never passes by default.
- **A hard blocker stops the run.** It cannot be averaged away or waited out.
- **Each agent starts with a fresh context**, so one confused round does not poison the next.
- **A budget ceiling bounds the run**, with cheaper models on the mechanical stages.

`autonomous-loop/references/kernel.md` maps each guarantee to the failure it exists to prevent.

## Install

From this repo, into `~/.claude`:

```sh
./install.sh
```

The install is fail-closed. If any gate exits non-zero, nothing is copied.

If you keep more than one Claude home — separate profiles, a work config dir — name them and the
install goes to each:

```sh
./install.sh --home ~/.claude --home ~/.claude-work
CLAUDE_HOMES=~/.claude:~/.claude-work ./install.sh    # same thing, colon-separated
```

With neither given, `install.sh` uses `CLAUDE_CONFIG_DIR` if it is set, and `~/.claude` otherwise.
A named home that does not exist is skipped rather than created, and an install that reaches no
home at all fails instead of reporting success.

To install somewhere else, or on another machine, unzip the packaged skill instead. It is a plain
zip with a single top-level `autonomous-loop/` folder:

```sh
unzip -o autonomous-loop/dist/autonomous-loop.skill -d ~/.claude/skills/
```

Claude Code picks the skill up on the next session.

**Requirements:** `node` runs the self-checks and the generated driver. `python3` serves the
optional live dashboard and nothing else — you can install, trigger, and verify the skill without
it.

## Verify

The stop logic is code, so it is tested as code. The check costs no tokens and is deterministic:

```sh
cd ~/.claude/skills/autonomous-loop
node scripts/selfcheck_loops.mjs        # expect exit 0
```

It runs the real driver template against a mocked harness, once per shape, and asserts the kernel
holds in each: a clean run reaches its finished state; a verifier that crashes or returns nothing
can never produce a positive finish; an open blocker forces `status='blocked'`.

## Evidence

`share/BENCHMARK.md` reports with-skill against baseline across both eval iterations. Pooled, the
skill scores 23/23 and the baseline 18/23, on single samples graded by a separate strict grader.

The whole gap is routing. The sharpest case is the saturator eval, where the baseline treated an
unknown-size search as an enumerable queue and scored 2/5 against the skill's 5/5 — exactly the
exhauster-versus-saturator call the router names as most decisive.

The transcripts under `autonomous-loop-workspace/` are kept as they were produced. Some of them
name a `gauntlet-loop` skill: a private predecessor converger this skill absorbed and replaced. It
is not part of this repo, and nothing here depends on it.

The decidability gate — refusing a loop aimed at something you cannot measure — did not
discriminate at this model tier. Both configurations scored full marks on both decidability evals.
The gate guards against regressions and helps weaker tiers, but it is not measured lift here, and
the benchmark says so.

## Repo layout

| Path | What it is |
|---|---|
| `autonomous-loop/` | The skill itself — the only thing that gets installed |
| `autonomous-loop/SKILL.md` | Routing, kernel, the loop, the launch gate, substrates |
| `autonomous-loop/references/` | The long-form docs the skill reads while designing a loop |
| `autonomous-loop/assets/loop-template.js` | The driver template — all five shapes as one `MODES` table |
| `autonomous-loop/assets/workbench.html` | Live dashboard for a running loop |
| `autonomous-loop/scripts/` | The self-check harnesses, the launch gate, the dashboard server |
| `autonomous-loop/evals/`, `autonomous-loop/dist/` | Present in source, never installed (see `EXCLUDES` in `install.sh`) |
| `share/` | Prose packed into `autonomous-loop-share.zip` |
| `autonomous-loop-workspace/` | Recorded eval runs, with-skill against baseline |
| `install.sh` | Gate, install, repack |

## License

Apache License 2.0 — see [LICENSE](LICENSE). Copyright 2026 Radiator.

Use it, fork it, ship it inside your own work, commercial or not. What the license asks in return
is that you keep the copyright and NOTICE intact and say what you changed; what it does not grant
is any right to the Radiator name or marks. Contributions come in under the same terms.

`LICENSE` and `NOTICE` are packaged into the `.skill` bundle as well, so a copy that travels on its
own still carries its terms.

## Working on the skill

```sh
./install.sh --check          # run the source gates, change nothing
./install.sh --check-bundles  # gate the .skill bundles on disk, change nothing
./install.sh --pack           # gate, repack the bundles, install nothing
./install.sh                  # gate, back up, install (see Install for --home), repack
```

`--check` and `--check-bundles` answer different questions, and `--check` says so on the way out: a
green source gate does not mean the bundles on disk are shippable. Run `--pack` after editing
anything under `share/`, which is packed into the share zip and byte-compared against it.

Each run backs up the current installs to `.install-backup/` first. Restore by copying them back.

### The gates

| Gate | Refuses |
|---|---|
| `scripts/selfcheck_loops.mjs` | A kernel whose stop logic can report success it did not earn — runs the real template against a mocked harness for every shape |
| `scripts/selfcheck_preflight.mjs` | A launch gate that would pass a driver not descended from the template |
| `scripts/selfcheck_docs.mjs` | A citation in the skill's prose that no longer resolves |
| `install.sh` | A `scripts/selfcheck_*.mjs` that exists but that no `run_gate` line invokes |
| `install.sh` | A bundle that does not reproduce source's own harness result and template bytes |

Every harness carries its own red half: it feeds itself a case built to trip it, and fails if that
case comes back clean. A gate that cannot fail is not a gate.

Two rules follow from the table, and both were learned the hard way. If you add a
`scripts/selfcheck_*.mjs`, add its `run_gate` line in the same change — a harness nothing runs is a
document. And a bundle is graded against source, never against the harness embedded in itself,
because a bundle graded by its own copy always agrees with itself.
