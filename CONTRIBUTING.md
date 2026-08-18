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
remembered.

**Repack after touching anything the bundles carry.** `autonomous-loop/dist/autonomous-loop.skill`
is tracked, and the bundle gate grades it against source — the embedded harness must reproduce
source's scenario count, and the template, `LICENSE`, and `NOTICE` must match byte for byte:

```sh
./install.sh --pack
```

That covers any edit under `autonomous-loop/`, since everything there is packed into the `.skill`
and byte-compared against source.

## What a good change looks like

Every harness carries its own red half: it feeds itself a case built to trip it and fails if that
case comes back clean. A gate that cannot fail is not a gate, so if you add a check, add the case
that proves it can go red — and say in the pull request what you saw it catch.

## Licensing

Contributions are accepted under the Apache License 2.0, the same terms as the rest of the repo.
