#!/usr/bin/env python3
"""Pin prompt files by content hash — a package-lock for prompts.

A loop's behavior lives in its prompt contracts (builder, critic panel,
synthesis). If one of those is edited — especially an upstream skill pulled in from
elsewhere — the loop's behavior changes silently. This makes prompts reviewed
dependencies instead of live wires: any drift shows up as a diff on the lock file.

Usage:
    python lock_prompts.py write <prompts-dir> [--lock prompts-lock.json]
    python lock_prompts.py check <prompts-dir> [--lock prompts-lock.json]

`write` records SHA-256 of every prompt file. `check` re-hashes and exits non-zero
if anything changed, was added, or went missing (wire into CI). Each entry also
stores an optional `source` field you can fill in by hand to record where a pulled-in
prompt came from (repo URL + path), mirroring the FPS harness's skills-lock.json.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

PROMPT_GLOBS = ("*.md", "*.txt", "*.prompt")


def hash_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def collect(prompts_dir: Path):
    files = sorted(
        f for pat in PROMPT_GLOBS for f in prompts_dir.rglob(pat) if f.is_file()
    )
    return {
        str(f.relative_to(prompts_dir)): {"sha256": hash_file(f), "source": ""}
        for f in files
    }


def load_lock(lock_path: Path):
    if not lock_path.exists():
        return {}
    return json.loads(lock_path.read_text()).get("prompts", {})


def cmd_write(prompts_dir: Path, lock_path: Path):
    current = collect(prompts_dir)
    # preserve any hand-entered `source` fields from an existing lock
    prev = load_lock(lock_path)
    for name, entry in current.items():
        if name in prev and prev[name].get("source"):
            entry["source"] = prev[name]["source"]
    lock_path.write_text(json.dumps({"prompts": current}, indent=2) + "\n")
    print(f"locked {len(current)} prompt(s) -> {lock_path}")
    return 0


def cmd_check(prompts_dir: Path, lock_path: Path):
    if not lock_path.exists():
        print(f"error: {lock_path} not found — run `write` first", file=sys.stderr)
        return 2
    locked = load_lock(lock_path)
    current = collect(prompts_dir)
    changed = [n for n in current if n in locked and current[n]["sha256"] != locked[n]["sha256"]]
    added = [n for n in current if n not in locked]
    missing = [n for n in locked if n not in current]

    if not (changed or added or missing):
        print(f"prompts:check OK — {len(locked)} prompt(s) match the lock")
        return 0

    for n in changed:
        print(f"CHANGED  {n}")
    for n in added:
        print(f"ADDED    {n}  (not in lock)")
    for n in missing:
        print(f"MISSING  {n}  (in lock, gone from dir)")
    print("\nprompts:check FAILED — review the drift, then re-run `write` to accept.",
          file=sys.stderr)
    return 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["write", "check"])
    ap.add_argument("prompts_dir")
    ap.add_argument("--lock", default="prompts-lock.json")
    args = ap.parse_args()

    prompts_dir = Path(args.prompts_dir)
    if not prompts_dir.is_dir():
        print(f"error: {prompts_dir} is not a directory", file=sys.stderr)
        return 2
    lock_path = Path(args.lock)
    return cmd_write(prompts_dir, lock_path) if args.action == "write" else cmd_check(prompts_dir, lock_path)


if __name__ == "__main__":
    sys.exit(main())
