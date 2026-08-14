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

Two endpoints exist beyond the static files, and both are here because a board that polls a file
which changes once a round is busy and blind at the same time:

    GET /events        server-sent events. The server stats the ledger files a few times a second
                       (cheap) and pushes one line when a digest actually changes, so the page
                       updates within ~200ms of a real write and is idle the rest of the time.
    GET /activity.json what the WORKFLOW is doing right now, between ledger writes — see
                       `collect_activity`. The driver has no filesystem access and `writeLedger`
                       runs once per round, so without this the board cannot see a round in flight.

Renders are SERVED, never committed: this script writes a `.gitignore` into the run dir and prunes
`artifacts/r<N>-*` down to the most recent --keep-rounds plus round 1, which is kept forever as the
permanent BEFORE. 5,704 committed SVGs once produced a 9.1M-line PR and consumed a month of review
quota, so the frames belong beside the ledger — disposable — and not in git.

Usage:
    python workbench_server.py <run-dir> [--port 8787] [--no-open] [--keep-rounds 6]
                               [--transcripts DIR]

Point <run-dir> at the ephemeral ledger directory of the run. Ctrl-C to stop.
"""
import argparse
import functools
import http.server
import json
import os
import re
import shutil
import sys
import threading
import time
import webbrowser
from datetime import datetime, timezone
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


# ── Workflow activity ───────────────────────────────────────────────────────────────────────────
# `writeLedger` fires once per round. A round can run for many minutes and spend dozens of agents,
# so between two writes progress.json says nothing at all and the board reads as frozen — which is
# indistinguishable, to a watcher, from a hung run. This is the seam that closes that window.
#
# Two sources, in this order, and the board is TOLD which one it got. Never invent a third that
# silently returns nothing: an empty agent list and "no source configured" mean different things,
# and conflating them is the same defect as a blank hero slot.
#
#   1. `activity.jsonl` in the ledger dir — the contract this skill owns. One JSON object per line:
#        {"ts": "…", "agent": "verify:auth.ts", "phase": "Verify", "event": "start"|"end",
#         "status": "ok"|"fail", "note": "…"}
#      Works on every substrate, including a committed CI harness where no transcript exists. The
#      driver cannot write it (no filesystem access) — an agent must, or the harness wrapping it.
#   2. The harness's own per-agent transcript shards, `<session>/subagents/agent-*.jsonl`. Free:
#      already written, no tokens, no driver change. Coupled to a path this skill does not own, so
#      it is the fallback and its guess is reported rather than assumed.
ACTIVE_WINDOW_S = 90       # no line written for this long ⇒ the agent is no longer working
TRANSCRIPT_MAX_AGE_S = 4 * 3600
ACTIVITY_MAX = 60

_shard_cache: dict[str, tuple[int, dict]] = {}   # path -> (size_seen, parsed head fields)


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def find_transcript_dir(explicit: str | None) -> tuple[Path | None, bool]:
    """Locate the harness's subagents/ dir. Returns (dir, guessed).

    An explicit --transcripts is taken at its word. Otherwise pick the most recently modified
    subagents/ dir under ~/.claude/projects — right almost always, wrong the moment two sessions run
    at once, which is exactly why the answer carries `guessed` out to the board instead of passing
    itself off as certain.
    """
    if explicit:
        p = Path(explicit).expanduser().resolve()
        return (p if p.is_dir() else None), False
    root = Path.home() / ".claude" / "projects"
    if not root.is_dir():
        return None, False
    best, best_mtime = None, 0.0
    for d in root.glob("*/*/subagents"):
        try:
            m = d.stat().st_mtime
        except OSError:
            continue
        if m > best_mtime:
            best, best_mtime = d, m
    if best is None or time.time() - best_mtime > TRANSCRIPT_MAX_AGE_S:
        return None, False
    return best, True


_HEXTAIL = re.compile(r"^(.*?)-?[0-9a-f]{12,}$")


def _agent_name(agent_id: str, slug: str | None) -> str:
    """A label a person can scan down a column.

    Agent ids come in two shapes: a meaningful prefix plus a hash (`afix-529-86d13ad12bc4`), where
    the prefix is the label the driver gave the agent and is exactly what a watcher wants; and pure
    hash, where there is nothing to recover. `slug` is NOT a per-agent name — it is the SESSION
    slug, so leading with it prints the same word on every row and the panel becomes unreadable at
    the moment it has the most to say: every pure-hash agent in one session shares a slug, so
    falling back to it collapses every such row to one indistinguishable label. Prefer the prefix;
    when there is none, fall back to a short suffix of the id itself, which is unique per agent even
    when the slug is not.
    """
    m = _HEXTAIL.match(agent_id)
    stem = (m.group(1) if m else agent_id).strip("-")
    if stem and not re.fullmatch(r"[0-9a-f]*", stem):
        return stem
    tail = agent_id[-8:] if len(agent_id) > 8 else agent_id
    return f"agent-{tail}" if tail else (slug or agent_id)


def _read_shard(path: Path) -> dict | None:
    """Head fields for one agent shard, cached: a shard grows to megabytes and only its first line
    and its mtime are needed, so re-reading the whole file several times a second would spend real
    disk for nothing."""
    try:
        st = path.stat()
    except OSError:
        return None
    key = str(path)
    cached = _shard_cache.get(key)
    if cached and cached[0] > 0:
        head = cached[1]
    else:
        head = {}
        try:
            with path.open("r", encoding="utf-8", errors="replace") as fh:
                first = fh.readline()
            rec = json.loads(first) if first.strip() else {}
            agent_id = rec.get("agentId") or path.stem
            head = {
                "id": agent_id,
                "name": _agent_name(agent_id, rec.get("slug")),
                "started_at": rec.get("timestamp"),
            }
        except (OSError, ValueError):
            head = {"id": path.stem, "name": path.stem, "started_at": None}
        _shard_cache[key] = (1, head)
    age = time.time() - st.st_mtime
    return {
        **head,
        "last_at": _iso(st.st_mtime),
        "idle_s": round(age, 1),
        "state": "running" if age <= ACTIVE_WINDOW_S else "done",
        "bytes": st.st_size,
    }


def _from_transcripts(d: Path) -> list[dict]:
    agents = []
    for p in d.glob("agent-*.jsonl"):
        rec = _read_shard(p)
        if rec:
            agents.append(rec)
    return agents


def _from_activity_log(path: Path) -> list[dict]:
    """Fold activity.jsonl into one record per agent. Later lines win, so an `end` event closes the
    agent a `start` opened."""
    by_agent: dict[str, dict] = {}
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue        # a half-written line is normal while something is appending
        name = str(e.get("agent") or e.get("id") or "agent")
        rec = by_agent.setdefault(name, {"id": name, "name": name, "started_at": e.get("ts")})
        rec["phase"] = e.get("phase", rec.get("phase"))
        rec["last_at"] = e.get("ts") or rec.get("last_at")
        rec["status"] = e.get("status", rec.get("status"))
        if e.get("note"):
            rec["note"] = e["note"]
        if e.get("event") == "end":
            rec["state"] = "done"
        elif e.get("event") == "start":
            rec["state"] = "running"
    now = time.time()
    for rec in by_agent.values():
        ep = _epoch(rec.get("last_at"))
        rec["idle_s"] = round(now - ep, 1) if ep is not None else None
    return list(by_agent.values())


def collect_activity(run_dir: Path, transcripts: Path | None, guessed: bool) -> dict:
    """What the workflow is doing right now. Shape is documented in references/observability.md."""
    log = run_dir / "activity.jsonl"
    if log.is_file() and log.stat().st_size > 0:
        agents, source, where = _from_activity_log(log), "ledger", str(log)
    elif transcripts is not None:
        agents, source, where = _from_transcripts(transcripts), "transcripts", str(transcripts)
    else:
        agents, source, where = [], "none", ""
    # Running first, then the most recently active — a watcher looks for what is live now, and a
    # long-finished agent scrolling above an in-flight one is the panel failing at its one job.
    agents.sort(key=lambda a: (a.get("state") != "running", -(_epoch(a.get("last_at")) or 0)))
    running = [a for a in agents if a.get("state") == "running"]
    return {
        "source": source,
        "where": where,
        "guessed": guessed and source == "transcripts",
        "generated_at": _iso(time.time()),
        "running": len(running),
        "total": len(agents),
        "truncated": max(0, len(agents) - ACTIVITY_MAX),
        "agents": agents[:ACTIVITY_MAX],
    }


def _epoch(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


# ── Artifacts ───────────────────────────────────────────────────────────────────────────────────
# The board used to learn about evidence only through `rounds[].artifacts[]` in progress.json, which
# nothing in the driver writes — so a run could fill artifacts/ with every frame it captured and the
# board would show an empty gallery and a filmstrip with two entries. The files are RIGHT THERE. Read
# the directory instead of waiting for an agent to describe it, and the gallery is complete by
# construction: what you see is what the run actually produced, not what it remembered to declare.
ART_TYPES = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".svg": "image",
    ".mp4": "video", ".webm": "video", ".mov": "video", ".m4v": "video",
    ".log": "log", ".txt": "log", ".out": "log",
    ".diff": "diff", ".patch": "diff",
    ".json": "data", ".jsonl": "data", ".csv": "data",
    ".md": "doc", ".html": "doc",
}


def collect_artifacts(run_dir: Path) -> dict:
    art = run_dir / "artifacts"
    groups: dict[int | None, list[dict]] = {}
    if art.is_dir():
        for p in sorted(art.iterdir()):
            if not p.is_file() or p.name.startswith("."):
                continue
            try:
                st = p.stat()
            except OSError:
                continue
            m = ROUND_RE.match(p.name)
            rnd = int(m.group(1)) if m else None
            groups.setdefault(rnd, []).append({
                "name": p.name,
                "path": f"artifacts/{p.name}",
                "type": ART_TYPES.get(p.suffix.lower(), "file"),
                "bytes": st.st_size,
                "mtime": _iso(st.st_mtime),
            })
    # Newest round first, matching the Rounds panel. Files that name no round ("unfiled" — the
    # framing spec, hand-placed evidence) sort last: they are context, not the trajectory.
    rounds = sorted((r for r in groups if r is not None), reverse=True)
    out = [{"round": r, "items": groups[r]} for r in rounds]
    if None in groups:
        out.append({"round": None, "items": groups[None]})
    return {
        "generated_at": _iso(time.time()),
        "total": sum(len(v) for v in groups.values()),
        "groups": out,
    }


def watch_digest(run_dir: Path, transcripts: Path | None) -> str:
    """A cheap fingerprint of everything the board renders. Only stat() calls — this runs a few
    times a second and must never read a file to decide whether a file changed."""
    parts = []
    for name in ("progress.json", "runs.jsonl", "activity.jsonl"):
        try:
            st = (run_dir / name).stat()
            parts.append(f"{name}:{int(st.st_mtime * 1000)}:{st.st_size}")
        except OSError:
            parts.append(f"{name}:-")
    # The artifacts dir's own mtime moves when a file is added or removed, so a new capture pushes
    # the gallery without reading a single file. A frame that lands mid-round is the strongest
    # evidence the loop is working, and it used to wait for the next ledger write to appear.
    try:
        st = (run_dir / "artifacts").stat()
        parts.append(f"art:{int(st.st_mtime * 1000)}")
    except OSError:
        parts.append("art:-")
    if transcripts is not None:
        try:
            newest = max((p.stat().st_mtime for p in transcripts.glob("agent-*.jsonl")), default=0)
            parts.append(f"tx:{int(newest * 1000)}")
        except OSError:
            parts.append("tx:-")
    return "|".join(parts)


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    run_dir: Path = Path(".")
    transcripts: Path | None = None
    guessed: bool = False

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, *a):  # keep the console quiet
        pass

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html") and BUNDLED_HTML.exists():
            # Re-copy the board on every request instead of only at startup. Startup-only copying
            # made the board unable to show a change to itself: a run whose whole job is improving
            # workbench.html edited the file, screenshotted the page, and got the version from
            # before the edit — evidence that silently described the wrong artifact. The copy is a
            # few tens of KB off local disk and only happens on a page load, not on the SSE stream.
            try:
                shutil.copyfile(BUNDLED_HTML, self.run_dir / "index.html")
            except OSError:
                pass   # a served-but-stale board beats a 500; the startup copy is still there
        if path == "/activity.json":
            return self._send_json(collect_activity(self.run_dir, self.transcripts, self.guessed))
        if path == "/artifacts.json":
            return self._send_json(collect_artifacts(self.run_dir))
        if path == "/events":
            return self._stream_events()
        return super().do_GET()

    def _send_json(self, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _stream_events(self):
        """Push one line whenever the digest moves. The page falls back to polling if this dies, so
        a broken pipe here is an ordinary end-of-connection, not an error worth logging."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        last, beat = None, time.time()
        try:
            while True:
                digest = watch_digest(self.run_dir, self.transcripts)
                now = time.time()
                if digest != last:
                    last = digest
                    self.wfile.write(b"event: change\ndata: {}\n\n")
                    self.wfile.flush()
                    beat = now
                elif now - beat >= 20:
                    # A comment line keeps the connection warm without waking the page's handler.
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    beat = now
                time.sleep(0.25)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--no-open", action="store_true")
    ap.add_argument("--keep-rounds", type=int, default=6, metavar="N",
                    help="prune artifacts/ to the last N rounds plus round 1 (0 disables)")
    ap.add_argument("--transcripts", metavar="DIR", default=None,
                    help="the harness's subagents/ dir, for the live workflow panel. Omit to "
                         "auto-detect the most recent one (the board says when it guessed).")
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

    transcripts, guessed = find_transcript_dir(args.transcripts)
    NoCacheHandler.run_dir = run_dir
    NoCacheHandler.transcripts = transcripts
    NoCacheHandler.guessed = guessed

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
    if (run_dir / "activity.jsonl").is_file():
        feed = f"activity.jsonl in the ledger dir"
    elif transcripts is not None:
        feed = f"{transcripts}{' (auto-detected)' if guessed else ''}"
    else:
        feed = "none — the workflow panel will say so and name the two ways to feed it"
    print(f"workbench serving {run_dir}\n  {url}\n  workflow activity: {feed}\nCtrl-C to stop.")
    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
