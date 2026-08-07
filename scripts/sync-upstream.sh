#!/usr/bin/env bash
# omp upstream → GUI feature-sync.
#
# Merges the latest omp upstream into the current (GUI release) branch, then
# re-runs the GUI-specific rebuild steps a plain `git merge` can't do. Run from
# the repo root: `bash packages/gui/scripts/sync-upstream.sh`.
#
# Steps:
#   1. fetch upstream, show what's incoming
#   2. merge upstream/main (stop on conflict for manual resolution)
#   3. bun install (lockfile may have moved)
#   4. if the omp version bumped, re-provision pi_natives for the new version
#   5. gen:stats (re-embed the stats dashboard client bundle)
#   6. build:omp (rebuild the bundled sidecar with upstream + local changes)
#   7. build the GUI renderer + typecheck + tests
set -euo pipefail
cd "$(dirname "$0")/../../.."

GUI=packages/gui
say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

say "1/7 fetch upstream"
git fetch upstream --quiet
incoming=$(git rev-list --count HEAD..upstream/main)
echo "incoming commits: $incoming"
git log --oneline HEAD..upstream/main | head -15 || true
if [ "$incoming" = "0" ]; then echo "already up to date"; exit 0; fi

say "2/7 merge upstream/main"
if ! git merge upstream/main --no-edit; then
	echo "CONFLICT — resolve the listed files, then re-run this script with SKIP_MERGE=1"
	echo "  git status --short"
	exit 1
fi

say "3/7 bun install"
bun install

new_version="$(cd packages/coding-agent && node -p "require('./package.json').version" 2>/dev/null || true)"
say "4/7 pi_natives for v$new_version"
# build:omp (step 6) now stages the matching-version addon itself — including
# replacing stale addons whose version sentinel doesn't match — so this step is
# only an early, explicit check that the new version is available somewhere.
native_dir="$HOME/.omp/natives/$new_version"
if [ -n "$new_version" ] && [ ! -f "$native_dir/pi_natives.darwin-arm64.node" ]; then
	tmp="$(mktemp -d)"
	bun add --no-cache --registry=https://registry.npmjs.org --os=darwin --cpu=arm64 "@oh-my-pi/pi-natives-darwin-arm64@$new_version" --cwd "$tmp" || \
		echo "WARN: natives $new_version not on npm yet — build:omp will fail unless you build from crates/pi-natives"
	mkdir -p "$native_dir"
	cp "$tmp"/node_modules/@oh-my-pi/pi-natives-darwin-arm64/pi_natives.darwin-arm64.node "$native_dir/" 2>/dev/null || true
else
	echo "natives present (or version unchanged)"
fi

say "5/7 gen:stats (embed stats dashboard)"
bun --cwd=packages/stats run gen:stats

say "6/7 build:omp (rebuild bundled sidecar)"
bun --cwd="$GUI" run build:omp
"$GUI/resources/omp" --smoke-test

say "7/7 GUI build + typecheck + tests"
bun --cwd="$GUI" run build
# `bun --cwd x tsc|vitest` resolves tsconfig/vitest.config by the SHELL's cwd,
# not --cwd — from the repo root that picks the monorepo's root configs and
# fails (TS6306) or runs the wrong suite. `run <script>` cds properly.
bun --cwd="$GUI" run check:types
bun --cwd="$GUI" run test

say "sync complete — review with: git log --oneline -5; git status --short"
