#!/usr/bin/env python3
"""Serve the loop workbench dashboard for a live (or finished) run.

Zero dependencies (stdlib only). Serves a run directory that contains:
    progress.json   — the live ledger the dashboard polls (see references/observability.md), whose
                      `hero` block is the board's top slot: the CURRENT artifact, rendered large,
                      above the counters
    runs.jsonl      — optional longitudinal log (one run summary per line)
    artifacts/      — per-round frames / video / diffs / logs linked from progress.json
and drops the bundled workbench.html in as index.html if it isn't already there.

Why a server (not just file://): browsers block fetch() of local JSON over file://,
which would leave the dashboard blank. This also sends no-cache headers so the page
always sees the latest progress.json while the loop is running.

Renders are SERVED, never committed: this script writes a `.gitignore` into the run dir and prunes
`artifacts/r<N>-*` down to the most recent --keep-rounds plus round 1, which is kept forever as the
permanent BEFORE. 5,704 committed SVGs once produced a 9.1M-line PR and consumed a month of review
quota, so the frames belong beside the ledger — disposable — and not in git.

Usage:
    python workbench_server.py <run-dir> [--port 8787] [--no-open] [--keep-rounds 6]

Point <run-dir> at the ephemeral ledger directory of the run. Ctrl-C to stop.
"""
import argparse
import functools
import http.server
import os
import re
import shutil
import sys
import threading
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
BUNDLED_HTML = HERE.parent / "assets" / "workbench.html"

# artifacts/r7-hero.png, artifacts/round_7-orbit.mp4, … — anything that names its round.
ROUND_RE = re.compile(r"^r(?:ound)?[-_]?(\d+)[-_.]")

GITIGNORE = (
    "# Renders are served from here and are DISPOSABLE — never commit them.\n"
    "# 5,704 committed SVGs once made a 9.1M-line PR and ate a month of review quota.\n"
    "*\n"
)


def prune_artifacts(run_dir: Path, keep: int) -> None:
    """Keep round 1 (the permanent BEFORE) plus the most recent `keep` rounds; delete the rest.

    Only touches files directly under artifacts/ whose name names a round, so hand-placed evidence
    and the framing spec (framing.json) survive. keep <= 0 disables pruning entirely.
    """
    art = run_dir / "artifacts"
    if keep <= 0 or not art.is_dir():
        return
    by_round: dict[int, list[Path]] = {}
    for p in art.iterdir():
        m = ROUND_RE.match(p.name) if p.is_file() else None
        if m:
            by_round.setdefault(int(m.group(1)), []).append(p)
    rounds = sorted(by_round)
    if len(rounds) <= keep:
        return
    survivors = set(rounds[-keep:]) | {rounds[0]}
    for r in rounds:
        if r in survivors:
            continue
        for p in by_round[r]:
            try:
                p.unlink()
            except OSError:
                pass


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, *a):  # keep the console quiet
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--no-open", action="store_true")
    ap.add_argument("--keep-rounds", type=int, default=6, metavar="N",
                    help="prune artifacts/ to the last N rounds plus round 1 (0 disables)")
    args = ap.parse_args()

    run_dir = Path(args.run_dir).resolve()
    run_dir.mkdir(parents=True, exist_ok=True)

    # make the dashboard available as index.html in the served dir
    index = run_dir / "index.html"
    if BUNDLED_HTML.exists():
        shutil.copyfile(BUNDLED_HTML, index)
    elif not index.exists():
        print(f"error: bundled dashboard not found at {BUNDLED_HTML}", file=sys.stderr)
        return 2
    (run_dir / "artifacts").mkdir(exist_ok=True)
    if not (run_dir / ".gitignore").exists():
        (run_dir / ".gitignore").write_text(GITIGNORE)
    if not (run_dir / "progress.json").exists():
        # The hero is seeded ABSENT-AND-EXPLAINED, never empty: a board with no picture must say
        # what would be needed, because a blank slot reads as "nothing to show" and it never is.
        (run_dir / "progress.json").write_text(
            '{"status":"running","hitBackstop":false,"rounds":[],'
            '"hero":{"type":"none","note":"No capture yet. The measure step must write hero.path '
            '(shot to artifacts/framing.json), hero.commit from git rev-parse HEAD in the process '
            'that rendered it, and hero.before pinned to round 1 — or state here what would be '
            'needed to produce a picture at all."}}'
        )

    # Renders are served and disposable: prune at startup, then on a slow timer for long runs.
    prune_artifacts(run_dir, args.keep_rounds)
    if args.keep_rounds > 0:
        stop = threading.Event()

        def _pruner():
            while not stop.wait(60):
                prune_artifacts(run_dir, args.keep_rounds)

        threading.Thread(target=_pruner, daemon=True).start()

    os.chdir(run_dir)
    handler = functools.partial(NoCacheHandler, directory=str(run_dir))
    # bind_and_activate with address reuse; try the port, bump if taken
    port = args.port
    for attempt in range(10):
        try:
            httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
            break
        except OSError:
            port += 1
    else:
        print("error: no free port found", file=sys.stderr)
        return 2

    url = f"http://127.0.0.1:{port}/"
    print(f"workbench serving {run_dir}\n  {url}\nCtrl-C to stop.")
    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
