#!/usr/bin/env bash
# Install the autonomous-loop skill from source into one or more Claude homes, and repack the
# .skill bundle.
#
#   ./install.sh                  run the gates, then install and repack
#   ./install.sh --check          run the source gate only, change nothing
#   ./install.sh --pack           gate, repack, gate the bundles; install nothing
#   ./install.sh --check-bundles  gate the bundles already on disk, change nothing
#
# Where it installs, highest precedence first:
#
#   ./install.sh --home ~/.claude --home ~/.claude-work   repeatable, explicit
#   CLAUDE_HOMES=~/.claude:~/.claude-work ./install.sh    colon-separated
#   CLAUDE_CONFIG_DIR=~/.claude-alt ./install.sh          Claude Code's own config-dir variable
#   ./install.sh                                          default: ~/.claude
#
# The gate is fail-closed: if any selfcheck exits non-zero, NOTHING is copied. A skill that
# ships an untested stop rule is worse than one that ships nothing.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$SRC/$(basename "${BASH_SOURCE[0]}")"
SKILLS=(autonomous-loop)
# Present in source, never installed and never packaged. __pycache__ is here because importing
# scripts/workbench_server.py once — to unit-test one helper — left a .pyc in the skill, and the next
# install shipped it to every home and both bundles before the verify caught the drift. Build output
# from a dev machine is not part of the skill.
EXCLUDES=(--exclude=evals --exclude=dist --exclude=.DS_Store --exclude=__pycache__ --exclude='*.pyc')
SHARE="$SRC/autonomous-loop-share.zip"

say() { printf '%s\n' "$*"; }
die() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }

# Asked-for help is not a failure: it prints on stdout and exits 0, so a wrapper can pipe it. A
# parse error prints the same line on stderr and exits 2. The text is identical; the exit status is
# the only thing that tells the two apart from outside.
usage() {  # [exit status, default 2]
  local status="${1:-2}"
  if [ "$status" -eq 0 ]; then
    printf 'usage: %s [--check|--pack|--check-bundles] [--home DIR ...]\n' "$(basename "$0")"
  else
    printf 'usage: %s [--check|--pack|--check-bundles] [--home DIR ...]\n' "$(basename "$0")" >&2
  fi
  exit "$status"
}
# An empty --home is refused rather than skipped. "" would build "/skills/autonomous-loop", and the
# install rm -rf's that path before it writes: an unlucky empty variable in a caller's script is not
# something to answer with a delete at the filesystem root.
add_home() {
  [ -n "$1" ] || { printf 'install.sh: --home needs a directory, got an empty value\n' >&2; usage; }
  HOMES+=("$1")
}

MODE=all
HOMES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --check|--pack|--check-bundles) MODE="$1"; shift ;;
    --home) [ $# -ge 2 ] || usage; add_home "$2"; shift 2 ;;
    --home=*) add_home "${1#--home=}"; shift ;;
    -h|--help) usage 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage ;;
  esac
done

# No --home given: fall back to the environment, then to the one home every install has.
if [ "${#HOMES[@]}" -eq 0 ]; then
  if [ -n "${CLAUDE_HOMES:-}" ]; then
    # Colon-separated, the way PATH is. Empty segments are dropped rather than expanding to "/".
    IFS=':' read -r -a _split <<<"$CLAUDE_HOMES"
    for h in "${_split[@]}"; do
      if [ -n "$h" ]; then HOMES+=("$h"); fi
    done
    # Set but holding nothing usable — ":" or "::" — is a misconfiguration, not a request to
    # install nowhere. Left alone it would run every gate, repack both bundles, and exit 0 having
    # installed nothing, which in CI reads exactly like a successful install.
    [ "${#HOMES[@]}" -gt 0 ] || die "CLAUDE_HOMES is set but names no path"
  elif [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
    HOMES+=("$CLAUDE_CONFIG_DIR")
  else
    HOMES+=("$HOME/.claude")
  fi
fi
# Expand a leading ~ so CLAUDE_HOMES=~/.claude works when it arrives unexpanded.
for i in "${!HOMES[@]}"; do
  case "${HOMES[$i]}" in "~/"*) HOMES[$i]="$HOME/${HOMES[$i]#\~/}" ;; "~") HOMES[$i]="$HOME" ;; esac
done

# Everything below shells out to these. Say which one is missing now, rather than failing halfway
# through a repack with a bare "command not found".
for t in node tar zip unzip diff cmp; do
  command -v "$t" >/dev/null 2>&1 || die "required tool not on PATH: $t"
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---- 1. Gate -------------------------------------------------------------------------------
say "== gate =="
gate_fail=0
run_gate() {  # <dir> <script>
  local d="$1" s="$2"
  if (cd "$SRC/$d" && node "scripts/$s" >"$WORK/gate.log" 2>&1); then
    say "  PASS  $d/scripts/$s"
  else
    say "  FAIL  $d/scripts/$s"
    sed 's/^/        /' "$WORK/gate.log" | tail -25
    gate_fail=1
  fi
}
run_gate autonomous-loop selfcheck_loops.mjs
# Every harness a skill ships must be RUN here, not merely shipped. Two of these were written,
# proven against mutations, and then sat outside this list — which is the same defect they exist to
# catch, one level up: a gate the publisher does not invoke is a document again. If you add a
# scripts/selfcheck_*.mjs to a skill, add the line here in the same change.
run_gate autonomous-loop selfcheck_preflight.mjs
run_gate autonomous-loop selfcheck_docs.mjs
run_gate autonomous-loop selfcheck_board.mjs

# Proof that the list above is not missing one. A harness on disk that nothing runs is invisible, so
# compare the two sets rather than trusting the list to have been updated.
for s in "${SKILLS[@]}"; do
  for h in "$SRC/$s/scripts/"selfcheck_*.mjs; do
    [ -e "$h" ] || continue
    b="$(basename "$h")"
    if grep -q "run_gate $s *$b\$" "$SELF"; then
      :
    else
      say "  FAIL  $s/scripts/$b exists but no run_gate line invokes it"
      gate_fail=1
    fi
  done
done

for s in "${SKILLS[@]}"; do
  if [ -f "$SRC/$s/evals/evals.json" ]; then
    node -e "JSON.parse(require('fs').readFileSync('$SRC/$s/evals/evals.json','utf8'))" \
      && say "  PASS  $s/evals/evals.json parses" \
      || { say "  FAIL  $s/evals/evals.json does not parse"; gate_fail=1; }
  fi
done

# The share prose lives in source (share/) and nothing regenerates it, so the only way it stays
# true is to state no counts — it points at the harness instead. Enforced, because prose drifts.
if grep -Eqi '[0-9]+ +(scenario|check|invariant|file)s?\b' "$SRC/share/README.md"; then
  say "  FAIL  share/README.md hardcodes a count; point at the harness instead"
  gate_fail=1
else
  say "  PASS  share/README.md states no counts"
fi

[ "$gate_fail" -eq 0 ] || die "gate is red — nothing installed"
say "  gate green"

if [ "$MODE" = "--check" ]; then
  # --check gates the SOURCE. It used to stop here, which made the safe-looking command green while
  # the bundles on disk were stale — "the gate is green" read as "the artifacts are shippable", and
  # those are different claims. Say which one this answered, and point at the command for the other.
  say "== --check: source gate green; bundles NOT checked =="
  say "   run ./install.sh --check-bundles to gate what would actually ship"
  exit 0
fi

# ---- 2. The bundle gate --------------------------------------------------------------------
# A bundle has to reproduce source's own result or it does not ship. Unzip what was packed, run
# the harness FROM INSIDE the copy, and require exit 0, source's scenario count, and a template
# identical to source. The count is compared against SOURCE for a reason: a bundle graded by its
# own embedded harness always agrees with itself, which is how a share zip shipped a harness
# eighteen hours behind the template it was grading, passing clean over the bugs it carried.
bad=0

scenarios() {  # <harness log> -> number of printed scenario lines
  grep -cE '^(PASS|FAIL)[[:space:]]' "$1" || true
}

check_bundle() {  # <label> <zip> <skill> <harness> <template>
  local label="$1" zip="$2" s="$3" harness="$4" tpl="$5"
  local d="$WORK/gate/${label//\//_}" want have log
  say "  -- $label"
  if [ ! -f "$zip" ]; then say "     FAIL  no bundle at $zip"; bad=1; return 0; fi
  mkdir -p "$d"
  if ! unzip -oq "$zip" -d "$d" 2>/dev/null; then say "     FAIL  not readable as a zip"; bad=1; return 0; fi
  if [ ! -f "$d/$s/scripts/$harness" ]; then say "     FAIL  bundle carries no scripts/$harness"; bad=1; return 0; fi

  log="$WORK/src.$s.log"
  if ! (cd "$SRC/$s" && node "scripts/$harness" >"$log" 2>&1); then
    say "     FAIL  source harness is red — nothing to compare against"; bad=1; return 0
  fi
  want="$(scenarios "$log")"
  if [ "$want" -lt 1 ]; then say "     FAIL  source harness printed no scenarios"; bad=1; return 0; fi

  log="$WORK/bundle.${label//\//_}.log"
  if (cd "$d/$s" && node "scripts/$harness" >"$log" 2>&1); then
    have="$(scenarios "$log")"
    if [ "$have" -eq "$want" ]; then
      say "     OK    embedded $harness: exit 0, $have scenarios (source: $want)"
    else
      say "     FAIL  embedded $harness ran $have scenarios, source runs $want"
      bad=1
    fi
  else
    say "     FAIL  embedded $harness exited non-zero"
    sed 's/^/           /' "$log" | tail -15
    bad=1
  fi

  if cmp -s "$SRC/$s/assets/$tpl" "$d/$s/assets/$tpl"; then
    say "     OK    embedded assets/$tpl is byte-identical to source"
  else
    say "     FAIL  embedded assets/$tpl differs from source ($(wc -c <"$d/$s/assets/$tpl" 2>/dev/null | tr -d ' ' || echo 0) vs $(wc -c <"$SRC/$s/assets/$tpl" | tr -d ' ') bytes)"
    bad=1
  fi
}

check_share() {
  local d="$WORK/gate/share" f
  say "  -- autonomous-loop-share.zip"
  if [ ! -f "$SHARE" ]; then say "     FAIL  no share zip at $SHARE"; bad=1; return 0; fi
  mkdir -p "$d"
  if ! unzip -oq "$SHARE" -d "$d" 2>/dev/null; then say "     FAIL  not readable as a zip"; bad=1; return 0; fi
  for f in README.md BENCHMARK.md; do
    if cmp -s "$SRC/share/$f" "$d/autonomous-loop-share/$f"; then
      say "     OK    $f is byte-identical to share/$f"
    else
      say "     FAIL  $f differs from share/$f — the zip carried prose forward"
      bad=1
    fi
  done
  check_bundle "share-embedded/autonomous-loop.skill" \
    "$d/autonomous-loop-share/autonomous-loop.skill" autonomous-loop selfcheck_loops.mjs loop-template.js
}

gate_bundles() {
  check_bundle "autonomous-loop/dist/autonomous-loop.skill" "$SRC/autonomous-loop/dist/autonomous-loop.skill" \
    autonomous-loop selfcheck_loops.mjs loop-template.js
  check_share
}

if [ "$MODE" = "--check-bundles" ]; then
  say "== bundles (as they sit on disk) =="
  gate_bundles
  [ "$bad" -eq 0 ] || die "a shipped bundle does not reproduce source — repack with ./install.sh --pack"
  say "== --check-bundles: every bundle reproduces source =="
  exit 0
fi

# ---- 3. Back up the current installs --------------------------------------------------------
if [ "$MODE" != "--pack" ]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  BACKUP="$SRC/.install-backup/$STAMP"
  say "== backup -> $BACKUP =="
  for home in "${HOMES[@]}"; do
    # Key the backup by the whole path, not by basename: two homes named .claude under different
    # parents would otherwise overwrite each other's backup. Escaping _ before folding / into _
    # keeps the encoding reversible, so /a_b/.claude and /a/b/.claude stay distinct instead of both
    # landing on a_b_.claude, and the leading separator is kept so a relative home cannot collide
    # with the absolute one of the same name.
    slot="${home//_/__}"; slot="${slot//\//_}"
    for s in "${SKILLS[@]}"; do
      [ -d "$home/skills/$s" ] || continue
      mkdir -p "$BACKUP/$slot/skills"
      cp -R "$home/skills/$s" "$BACKUP/$slot/skills/$s"
    done
  done
  say "  backed up (restore by copying these back)"

  # ---- 4. Install ---------------------------------------------------------------------------
  say "== install =="
  installed=0
  for home in "${HOMES[@]}"; do
    # A home that does not exist is a typo, not a profile to create: making ~/.clade/skills/ would
    # look like a clean install and put the skill somewhere Claude Code never reads.
    [ -d "$home" ] || { say "  SKIP  $home (no such directory)"; continue; }
    # mkdir without -p on purpose. -p would recreate the home itself if it vanished between the
    # check above and this line, which is the one thing this block promises not to do; plain mkdir
    # fails on a missing parent instead.
    [ -d "$home/skills" ] || mkdir "$home/skills"
    for s in "${SKILLS[@]}"; do
      rm -rf "$home/skills/$s"
      mkdir -p "$home/skills/$s"
      tar -cf - -C "$SRC/$s" "${EXCLUDES[@]}" . | tar -xf - -C "$home/skills/$s"
      say "  $home/skills/$s"
      installed=$((installed + 1))
    done
  done
  [ "$installed" -gt 0 ] || die "no Claude home to install into (tried: ${HOMES[*]}) — pass --home DIR"
fi

# ---- 5. Repack the bundles ------------------------------------------------------------------
# Layout must match what already ships: a single top-level dir named for the skill. Everything
# here is built from source on every run; nothing is lifted out of the previous zip.
say "== package =="
STAGE="$WORK/stage"
for s in "${SKILLS[@]}"; do
  mkdir -p "$STAGE/$s"
  tar -cf - -C "$SRC/$s" "${EXCLUDES[@]}" . | tar -xf - -C "$STAGE/$s"
done

mkdir -p "$SRC/autonomous-loop/dist"
(cd "$STAGE" && rm -f "$SRC/autonomous-loop/dist/autonomous-loop.skill" \
   && zip -qr "$SRC/autonomous-loop/dist/autonomous-loop.skill" autonomous-loop -x '*.DS_Store')
say "  autonomous-loop/dist/autonomous-loop.skill"

SHD="$STAGE/autonomous-loop-share"
mkdir -p "$SHD"
cp "$SRC/share/README.md" "$SRC/share/BENCHMARK.md" "$SHD/"
cp "$SRC/autonomous-loop/dist/autonomous-loop.skill" "$SHD/autonomous-loop.skill"
(cd "$STAGE" && rm -f "$SHARE" && zip -qr "$SHARE" autonomous-loop-share -x '*.DS_Store')
say "  autonomous-loop-share.zip"

# ---- 6. Verify what actually landed ---------------------------------------------------------
say "== verify =="
if [ "$MODE" != "--pack" ]; then
  for home in "${HOMES[@]}"; do
    [ -d "$home/skills/${SKILLS[0]}" ] || continue
    for s in "${SKILLS[@]}"; do
      out="$(diff -rq "$STAGE/$s" "$home/skills/$s" 2>&1 || true)"
      [ -z "$out" ] && say "  OK    $home/skills/$s" || { say "  DRIFT $home/skills/$s"; echo "$out" | sed 's/^/        /'; bad=1; }
    done
  done
fi
V="$WORK/verify"; mkdir -p "$V" && (cd "$V" \
  && unzip -oq "$SRC/autonomous-loop/dist/autonomous-loop.skill")
for s in "${SKILLS[@]}"; do
  out="$(diff -rq "$V/$s" "$STAGE/$s" 2>&1 || true)"
  [ -z "$out" ] && say "  OK    dist bundle: $s" || { say "  DRIFT dist bundle: $s"; echo "$out" | sed 's/^/        /'; bad=1; }
done
gate_bundles

[ "$bad" -eq 0 ] || die "verify found drift — installs and bundles do not match source"
if [ "$MODE" = "--pack" ]; then
  say "== done: bundles repacked and gated, nothing installed =="
else
  say "== done: $installed skill install(s), 1 bundle, 1 share zip =="
fi
