#!/usr/bin/env bash
# Proves the plugin installs the way ANOTHER DEVICE will install it.
#
# It does not use the local working copy. It clones this repository into a bare repo (standing in
# for GitHub), then installs the plugin into a throwaway DSH profile straight from that git URL —
# exactly the `dsh plugin add git+https://github.com/...` path a new machine would take — and boots
# the profile there to confirm every entry activates.
#
# Also packs the npm tarball and installs from that, since `npm publish` is the other shipping path.
#
# Usage: ./scripts/verify-install-from-git.sh [path-to-repo]

set -euo pipefail

REPO="$(cd "${1:-$(dirname "$0")/..}" && pwd)"
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
ROOT=/tmp/dsh-codex-gitinstall
ORIGIN="$ROOT/origin.git"
PORT=19471

if [ ! -x "$DSH" ]; then
  echo "dsh CLI not found at $DSH" >&2
  exit 2
fi
if [ ! -d "$REPO/.git" ]; then
  echo "$REPO is not a git repository; commit the plugin first" >&2
  exit 2
fi

rm -rf "$ROOT"
mkdir -p "$ROOT/profiles"

# A bare clone stands in for `git clone https://github.com/<you>/dsh-codex-session`.
git clone --quiet --bare "$REPO" "$ORIGIN"
echo "origin: $ORIGIN"
echo "HEAD  : $(git --git-dir="$ORIGIN" rev-parse --short HEAD) $(git --git-dir="$ORIGIN" log -1 --pretty=%s)"
echo

# A throwaway profile, seeded from the real desktop one but with this plugin removed.
PROFILE="$ROOT/profiles/gi"
cp -R "$HOME/.dsh/profiles/desktop" "$PROFILE"
rm -f "$PROFILE"/*.lock

python3 - "$PROFILE/package.json" <<'PY'
import json, pathlib, sys
manifest = pathlib.Path(sys.argv[1])
d = json.loads(manifest.read_text())
d['name'] = 'dsh-profile-gitinstall'
deps = d.setdefault('dependencies', {})
# Drop the developer's `link:` install so the test cannot silently fall back to the working copy.
deps.pop('dsh-codex-session', None)
d['dsh']['profile']['bundles'] = [b for b in d['dsh']['profile']['bundles'] if b != 'dsh-codex-session']
manifest.write_text(json.dumps(d, indent=2) + '\n')
print('seeded profile without dsh-codex-session')
PY

export DSH_HOME="$ROOT"

echo "=== install from the git URL ==="
"$DSH" plugin --profile gi add "git+file://$ORIGIN" 2>&1 | tail -3 || true
rm -f "$PROFILE"/*.lock

if ! grep -q 'dsh-codex-session' "$PROFILE/package.json"; then
  echo "FAIL: the git install did not register the plugin in the profile"; exit 1
fi
RESOLVED="$PROFILE/node_modules/dsh-codex-session"
if [ ! -f "$RESOLVED/package.json" ]; then
  echo "FAIL: $RESOLVED is missing after the install"; exit 1
fi
echo "installed at: $RESOLVED"
python3 - "$RESOLVED/package.json" <<'PY'
import json, pathlib, sys
d = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert d['version'], 'no version'
assert not d.get('private'), 'package must not be private to install elsewhere'
assert d.get('dsh', {}).get('bundle', {}).get('patch'), 'missing dsh.bundle.patch'
assert not d.get('dependencies'), f"unexpected dependencies: {d.get('dependencies')}"
assert not d.get('peerDependencies'), f"unexpected peerDependencies: {d.get('peerDependencies')}"
print(f"manifest ok: {d['name']}@{d['version']}  dependencies=0  peerDependencies=0")
PY
for required in lib/index.js lib/provider.js lib/client.js cordis.patch.yml; do
  [ -f "$RESOLVED/$required" ] || { echo "FAIL: packed package is missing $required"; exit 1; }
done
echo "all runtime files present in the installed copy"

echo
echo "=== boot the profile from the installed copy ==="
"$DSH" --profile gi --port "$PORT" --no-open > "$ROOT/boot.log" 2>&1 &
PID=$!
sleep 25
kill "$PID" 2>/dev/null || true
sleep 1

if grep -qi 'did not activate\|failed to import\|skipping profile bundle' "$ROOT/boot.log"; then
  echo "FAIL: an entry did not activate"; grep -i 'did not activate\|failed to import\|skipping' "$ROOT/boot.log"; exit 1
fi
grep -q 'http://127.0.0.1:' "$ROOT/boot.log" || { echo "FAIL: the host never came up"; tail -20 "$ROOT/boot.log"; exit 1; }
echo "host booted with every entry activated"

echo
echo "=== also verify the npm tarball path ==="
TARBALL_DIR="$ROOT/tarball"
mkdir -p "$TARBALL_DIR"
TARBALL="$(cd "$REPO" && npm pack --silent --pack-destination "$TARBALL_DIR")"
echo "packed: $TARBALL"
python3 - "$TARBALL_DIR/$TARBALL" <<'PY'
import sys, tarfile
names = tarfile.open(sys.argv[1]).getnames()
required = ['package/lib/index.js', 'package/lib/provider.js', 'package/lib/client.js',
            'package/cordis.patch.yml', 'package/package.json', 'package/LICENSE']
missing = [r for r in required if r not in names]
if missing:
    print('FAIL: tarball is missing', missing); sys.exit(1)
leaked = [n for n in names if '.backup-desktop-profile' in n or 'node_modules' in n]
if leaked:
    print('FAIL: tarball leaked local state', leaked[:5]); sys.exit(1)
print(f'tarball ok: {len(names)} files, no local state leaked')
PY

echo
echo "PASS: installs from a git URL and from the npm tarball, and boots from the installed copy"
