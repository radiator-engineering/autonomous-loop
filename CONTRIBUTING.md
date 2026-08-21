# Contributing

The skill's stop logic is code, so it is tested as code, and the tests are the contract. Two rules
below are not style preferences — `install.sh` refuses the change if you skip them, and both exist
because the failure they describe already happened once.

## Before you open a pull request

```sh
./install.sh --check          # source gates: every selfcheck, plus the evals JSON
./install.sh --check-bundles  # the .skill bundles on disk, graded against source
```

CI runs both on every pull request. Neither costs tokens, and both are deterministic.

## The two rules

**A new `scripts/selfcheck_*.mjs` needs its `run_gate` line in the same change.** A harness nothing
invokes is a document, not a gate. `install.sh` compares the harnesses on disk against the
`run_gate` lines that call them and fails when one is missing, so this is enforced rather than
remembered. The scan only recognizes the `selfcheck_*` name — a gate named something else
(`eval_driver.mjs`, `lint_design.mjs`) gets no automated check, so its `run_gate` line has to be
added by hand and review is what guards that it was.

**Repack after touching anything the bundle carries.** `autonomous-loop/dist/autonomous-loop.skill`
is tracked, and the bundle gate grades it against source — the embedded harness must reproduce
source's scenario count, and the template, `LICENSE`, and `NOTICE` must match byte for byte:

```sh
./install.sh --pack
```

That covers edits under `autonomous-loop/` except `evals/` and `dist/`, which the `EXCLUDES` list
in `install.sh` keeps out of the bundle — along with `.DS_Store` and Python build output. Editing
only those, or only files outside `autonomous-loop/`, needs no repack.

One wrinkle worth knowing: a zip records the timestamps of the files inside it, so `--pack` always
produces different bytes even when nothing that ships has changed. If `git status` shows the
`.skill` modified after a repack you did not need, restore it with
`git checkout -- autonomous-loop/dist/autonomous-loop.skill` rather than committing the churn. The
gate compares contents, not archive bytes, so it stays green either way.

## What a good change looks like

Every harness carries its own red half: it feeds itself a case built to trip it and fails if that
case comes back clean. A gate that cannot fail is not a gate, so if you add a check, add the case
that proves it can go red — and say in the pull request what you saw it catch.

## Licensing

Contributions are accepted under the Apache License 2.0, the same terms as the rest of the repo.
