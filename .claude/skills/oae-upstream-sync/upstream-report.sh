#!/usr/bin/env bash
# upstream-report.sh — read-only report on how far `oae` is from upstream OpenClaw Enterprise and
# what a merge would involve (SKILL.md in this directory). Changes nothing except a throwaway
# worktree it removes again.
#
#   upstream-report.sh [TARGET]    TARGET: an upstream commit (default: the newest one with
#                                  published controller and runtime images, else upstream/main)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git fetch -q upstream
git fetch -q origin

published() {  # upstream commits with both images on ghcr.io, oldest first
  local repo t
  for repo in runtime controller; do
    t=$(curl -fsS "https://ghcr.io/token?scope=repository:openclaw/openclaw-enterprise-$repo:pull" | jq -r .token)
    curl -fsS -H "Authorization: Bearer $t" \
      "https://ghcr.io/v2/openclaw/openclaw-enterprise-$repo/tags/list?n=5000" | jq -r '.tags[]' | grep '^sha-' | sort -u
  done | sort | uniq -d | sed 's/^sha-//' | while read -r s; do
    git cat-file -e "$s^{commit}" 2>/dev/null && git merge-base --is-ancestor "$s" upstream/main &&
      echo "$(git log -1 --format='%cI' "$s") $s"
  done | sort | cut -d' ' -f2
}

BASE=$(git merge-base origin/oae upstream/main)
PUB=$(published)
NEWEST_PUB=$(tail -1 <<<"$PUB")
TARGET=${1:-}
if [ -z "$TARGET" ]; then
  if [ -n "$NEWEST_PUB" ] && ! git merge-base --is-ancestor "$NEWEST_PUB" "$BASE"; then TARGET=$NEWEST_PUB
  else TARGET=upstream/main; fi
fi
TARGET=$(git rev-parse "$TARGET")

echo "# Upstream report $(date -u +%F)"
echo
echo "- oae:            $(git log -1 --format='%h %cs' origin/oae)"
echo "- merge base:     $(git log -1 --format='%h %cs %s' "$BASE")"
echo "- upstream/main:  $(git log -1 --format='%h %cs' upstream/main), $(git rev-list --count "$BASE"..upstream/main) commits past the base"
echo "- newest published-image commit: $([ -n "$NEWEST_PUB" ] && git log -1 --format='%h %cs' "$NEWEST_PUB" || echo none)"
if [ -n "$NEWEST_PUB" ] && git merge-base --is-ancestor "$NEWEST_PUB" "$BASE"; then
  echo "  (already in oae: no newer upstream release; a later target needs OAE-built runtime images)"
fi
echo "- target:         $(git log -1 --format='%h %cs' "$TARGET"), $(git rev-list --count "$BASE".."$TARGET") commits to bring in"
echo "- oae carries:    $(git rev-list --count --no-merges "$BASE"..origin/oae) commits"

echo
echo "## Fork commits upstream now has (drop or take upstream's file)"
found=0
while read -r c; do
  pid=$(git show "$c" | git patch-id --stable | cut -d' ' -f1)
  [ -n "$pid" ] || continue
  # same patch in upstream, or the same PR number in an upstream subject
  pr=$(git log -1 --format=%s "$c" | grep -oE '#[0-9]+\)?$' | tr -d ')' || true)
  match=""
  if [ -n "$pr" ]; then match=$(git log --format='%h' "$BASE".."$TARGET" --grep="($pr)" -F | head -1); fi
  if [ -n "$match" ]; then
    same=$([ "$(git show "$match" | git patch-id --stable | cut -d' ' -f1)" = "$pid" ] && echo "identical patch" || echo "upstream version differs")
    echo "- $(git log -1 --format='%h %s' "$c") → upstream $match ($same)"; found=1
  fi
done < <(git rev-list --no-merges "$BASE"..origin/oae)
[ $found = 1 ] || echo "- none"

echo
echo "## Trial merge of the target into oae"
WT=$(mktemp -d)
git worktree add -q --detach "$WT" origin/oae
trap 'git worktree remove --force "$WT" >/dev/null 2>&1 || true' EXIT
if (cd "$WT" && git merge -q --no-commit --no-ff "$TARGET" >/dev/null 2>&1); then
  echo "- merges cleanly"
else
  echo "| File | Conflict hunks | Fork commits touching it |"
  echo "|---|---|---|"
  (cd "$WT" && git diff --name-only --diff-filter=U) | while read -r f; do
    n=$(cd "$WT" && grep -c '^<<<<<<<' "$f" 2>/dev/null || echo "?")
    cs=$(git log --format='%h' --no-merges "$BASE"..origin/oae -- "$f" | tr '\n' ' ')
    echo "| \`$f\` | $n | $cs|"
  done
fi

echo
echo "## Upstream changes worth reading (target range, excluding docs/test/ci)"
git log --format='- %h %s' --no-merges "$BASE".."$TARGET" |
  grep -i -E 'secur|vulnerab|cve|leak|redact|bypass|privilege|oidc|sign-in|session|enrol|trusted.proxy|kubernetes|helm|migration|channel|harness|runtime image|breaking|teams|hermes|claude|anthropic|openai' |
  grep -v -i -E '^- [0-9a-f]+ (docs|test|tests|ci|perf\(ci\)|refactor\(ci\))[(:]' | head -60

echo
echo "## Upstream RFCs added or changed"
git diff --name-status "$BASE" "$TARGET" -- specs/rfcs | grep -E '\.md$' | while read -r st f; do
  echo "- $st $f: $(git show "$TARGET:$f" 2>/dev/null | grep -m1 '^# ' | sed 's/^# //')"
done
