#!/usr/bin/env python3
"""Generate a symbol -> line-range partition table for a source file.

This generalizes the FPS harness's gen-arch.mjs. It re-derives the volatile
symbol->line layer from the CURRENT source every time it runs, so line numbers
never drift and parallel builders can edit disjoint ranges without collisions.

What it does:
  - finds structural anchors (top-level defs/classes, class methods, assigned
    function expressions) for the file's language,
  - merges ranges separated by small gaps for legibility,
  - marks "red zones" (hot shared regions like update/render/__init__/constructor)
    as append-only,
  - detects overlapping ownership and fails loudly,
  - reports coverage %.

Usage:
    python gen_partition.py <source-file> [--gap 12] [--json] [--check]

--check exits non-zero if any overlap is detected (wire into CI as partition:check).

Language is inferred from the extension; .py .js .ts .jsx .tsx .mjs are supported.
For anything else it falls back to a generic top-level/indented-block scan, which
is coarse but safe.
"""
import argparse
import json
import re
import sys
from pathlib import Path

RED_ZONE_NAMES = {"update", "render", "draw", "tick", "loop", "main",
                  "__init__", "constructor", "setup"}

# Control-flow / keywords that regex method-detection catches as false positives
# (e.g. `if (x) {` looks like a method signature). Never treat these as symbols.
KEYWORD_STOPWORDS = {"if", "for", "while", "switch", "catch", "do", "else",
                     "return", "function", "typeof", "await", "yield", "case"}

# (name-capture regex, is_top_level) per language. Patterns match a definition's
# opening line; the range runs to the next same-or-shallower anchor.
LANG_PATTERNS = {
    "py": [
        (re.compile(r"^(?P<indent>\s*)(?:async\s+)?def\s+(?P<name>\w+)"), "def"),
        (re.compile(r"^(?P<indent>\s*)class\s+(?P<name>\w+)"), "class"),
    ],
    "js": [
        (re.compile(r"^(?P<indent>\s*)(?:export\s+)?(?:async\s+)?function\s+(?P<name>\w+)"), "func"),
        (re.compile(r"^(?P<indent>\s*)(?:export\s+)?class\s+(?P<name>\w+)"), "class"),
        # assigned function expression / arrow:  this.foo = (…) => {   |   const foo = (…) => {
        (re.compile(r"^(?P<indent>\s*)(?:export\s+)?(?:const|let|var)\s+(?P<name>\w+)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|\w+\s*=>)"), "assign"),
        (re.compile(r"^(?P<indent>\s*)(?:this\.)?(?P<name>\w+)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>)"), "assign"),
        # class method:  foo(args) {   at consistent indent (heuristic)
        (re.compile(r"^(?P<indent>\s{2,})(?P<name>\w+)\s*\([^)]*\)\s*\{"), "method"),
    ],
}
EXT_TO_LANG = {".py": "py", ".js": "js", ".ts": "js", ".jsx": "js",
               ".tsx": "js", ".mjs": "js", ".cjs": "js"}


def infer_lang(path: Path) -> str:
    return EXT_TO_LANG.get(path.suffix.lower(), "generic")


def find_anchors(lines, lang):
    """Return a list of (start_line_1indexed, indent_len, name, kind)."""
    patterns = LANG_PATTERNS.get(lang)
    anchors = []
    seen_on_line = set()
    if patterns is None:  # generic fallback: any non-indented, non-blank line starts a block
        for i, line in enumerate(lines, 1):
            if line.strip() and not line[0].isspace() and not line.lstrip().startswith(("//", "#", "*", "/*")):
                name = re.split(r"[\s(={:]", line.strip(), 1)[0][:40] or f"L{i}"
                anchors.append((i, 0, name, "block"))
        return anchors
    for i, line in enumerate(lines, 1):
        for rx, kind in patterns:
            m = rx.match(line)
            if m and i not in seen_on_line:
                if m.group("name") in KEYWORD_STOPWORDS:
                    continue  # a control-flow keyword, not a real symbol
                anchors.append((i, len(m.group("indent")), m.group("name"), kind))
                seen_on_line.add(i)
                break
    return anchors


def build_ranges(anchors, total_lines):
    """Each anchor owns from its start until the next anchor at same-or-shallower indent."""
    ranges = []
    for idx, (start, indent, name, kind) in enumerate(anchors):
        end = total_lines
        for (nstart, nindent, _, _) in anchors[idx + 1:]:
            if nindent <= indent:
                end = nstart - 1
                break
        ranges.append({"name": name, "kind": kind, "indent": indent,
                       "start": start, "end": end,
                       "red_zone": name in RED_ZONE_NAMES})
    return ranges


def merge_small_gaps(ranges, gap):
    """Merge adjacent ranges of the same owner name separated by <= gap lines."""
    if not ranges:
        return ranges
    ranges = sorted(ranges, key=lambda r: r["start"])
    merged = [dict(ranges[0])]
    for r in ranges[1:]:
        last = merged[-1]
        if r["name"] == last["name"] and r["start"] - last["end"] <= gap:
            last["end"] = max(last["end"], r["end"])
            last["red_zone"] = last["red_zone"] or r["red_zone"]
        else:
            merged.append(dict(r))
    return merged


def detect_overlaps(ranges):
    overlaps = []
    ordered = sorted(ranges, key=lambda r: r["start"])
    for a, b in zip(ordered, ordered[1:]):
        # nested (b inside a) is expected (method inside class); flag only true crossing
        if b["start"] <= a["end"] and b["end"] > a["end"] and b["indent"] <= a["indent"]:
            overlaps.append((a["name"], b["name"], b["start"], a["end"]))
    return overlaps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("--gap", type=int, default=12, help="merge same-owner ranges within this many lines")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of a table")
    ap.add_argument("--check", action="store_true", help="exit 1 if overlaps found (CI gate)")
    args = ap.parse_args()

    path = Path(args.source)
    if not path.exists():
        print(f"error: {path} not found", file=sys.stderr)
        return 2
    lines = path.read_text(errors="replace").splitlines()
    total = len(lines)
    lang = infer_lang(path)

    anchors = find_anchors(lines, lang)
    ranges = merge_small_gaps(build_ranges(anchors, total), args.gap)
    overlaps = detect_overlaps(ranges)

    # top-level coverage (ignore nested methods to avoid double counting)
    top = [r for r in ranges if r["indent"] == 0] or ranges
    covered = sum(r["end"] - r["start"] + 1 for r in top)
    coverage = 100.0 * covered / total if total else 0.0

    if args.json:
        print(json.dumps({"file": str(path), "lang": lang, "total_lines": total,
                          "coverage_pct": round(coverage, 1),
                          "overlaps": overlaps, "ranges": ranges}, indent=2))
    else:
        print(f"# Partition — {path}  ({lang}, {total} lines, {coverage:.1f}% covered)\n")
        print(f"{'symbol':<32} {'kind':<8} {'lines':<15} zone")
        print("-" * 66)
        for r in ranges:
            zone = "APPEND-ONLY" if r["red_zone"] else ""
            span = f"{r['start']}-{r['end']}"
            indent = "  " * (1 if r["indent"] else 0)
            print(f"{indent + r['name']:<32} {r['kind']:<8} {span:<15} {zone}")
        if overlaps:
            print("\n!! OVERLAPS (builders would collide — fix before running):")
            for a, b, s, e in overlaps:
                print(f"   '{a}' and '{b}' both claim lines {s}-{e}")

    if args.check and overlaps:
        print(f"\npartition:check FAILED — {len(overlaps)} overlap(s)", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
