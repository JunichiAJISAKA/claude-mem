#!/usr/bin/env bash
# Re-apply the ajio integration build (CJK/FTS5 fallback fix + semantic-inject
# session dedup) to the installed claude-mem plugin cache.
#
# Run this whenever a plugin update wipes the patched bundles:
#   bash scripts/apply-ajio-patches.sh
#
# Cycle (perma-fork policy, 2026-07-13):
#   1. git fetch upstream && git checkout ajio && git merge upstream/main
#      (resolve source conflicts; generated *.cjs conflicts: take either side,
#       they are rebuilt below)
#   2. bash scripts/apply-ajio-patches.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE_BASE="$HOME/.claude/plugins/cache/thedotmack/claude-mem"

cd "$REPO_ROOT"

branch="$(git branch --show-current)"
if [[ "$branch" != "ajio" ]]; then
    echo "ERROR: run on the ajio branch (current: $branch)" >&2
    exit 1
fi

# Latest installed plugin version directory (mtime, fallback to name sort).
version_dir="$(ls -1t "$CACHE_BASE" 2>/dev/null | head -1)"
if [[ -z "$version_dir" ]]; then
    echo "ERROR: no installed plugin found under $CACHE_BASE" >&2
    exit 1
fi
TARGET="$CACHE_BASE/$version_dir/scripts"
if [[ ! -d "$TARGET" ]]; then
    echo "ERROR: $TARGET does not exist" >&2
    exit 1
fi

echo "== Building ajio bundles (npm run build) =="
npm run build

echo "== Deploying to $TARGET =="
stamp="$(date +%Y%m%d-%H%M%S)"
for f in plugin/scripts/*.cjs; do
    base="$(basename "$f")"
    if [[ -f "$TARGET/$base" ]]; then
        cp "$TARGET/$base" "$TARGET/$base.bak-ajio-$stamp"
    fi
    cp "$f" "$TARGET/$base"
    echo "  deployed $base (backup: $base.bak-ajio-$stamp)"
done

echo "== Restarting worker =="
bun plugin/scripts/worker-service.cjs restart || npm run worker:restart

echo "== Verifying =="
sleep 3
bun plugin/scripts/worker-service.cjs status
grep -c "supplementEmptyCategories" "$TARGET/worker-service.cjs" >/dev/null \
    && echo "  OK: CJK fix present in deployed worker"
grep -cE "SEMANTIC_INJECT_DEDUP" "$TARGET/worker-service.cjs" >/dev/null \
    && echo "  OK: session dedup present in deployed worker"
echo "Done."
