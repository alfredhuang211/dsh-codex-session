#!/usr/bin/env bash
# Verifies the whole "new session -> Codex" chain inside a REAL DSH Host, without touching the
# user's live profile or the running app.
#
# It copies the desktop profile into a throwaway DSH home, installs this plugin plus a test-only
# probe, and boots the Web composition there. The probe then does exactly what the desktop UI does
# when you pick "Codex" in the new-session picker — `sessionController.create({agentPreset:'codex'})`
# — and records the resulting session log. Asserts:
#
#   1. the codex-preset session is pinned to codex-local (a `model/selection` event says so)
#   2. the deployment default is RESTORED, so later "DSH default" sessions stay on DSH's own model
#   3. a session created with the ordinary `standard` preset is left completely alone
#
# Exit code 0 = all three hold.
#
# Usage: ./scripts/verify-preset-pin.sh [path-to-plugin]

set -euo pipefail

PLUGIN="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
PROBE_SRC="$(cd "$(dirname "$0")/preset-probe" && pwd)"
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
ROOT=/tmp/dsh-codex-preset-pin
PROFILE=pinprobe
PORT=19461
RESULT="$ROOT/result.json"

if [ ! -x "$DSH" ]; then
  echo "dsh CLI not found at $DSH" >&2
  exit 2
fi
if [ ! -d "$HOME/.dsh/profiles/desktop" ]; then
  echo "no desktop profile at ~/.dsh/profiles/desktop — nothing to copy" >&2
  exit 2
fi

rm -rf "$ROOT"
mkdir -p "$ROOT/profiles" "$ROOT/workspace"
cp -R "$HOME/.dsh/profiles/desktop" "$ROOT/profiles/$PROFILE"
rm -f "$ROOT/profiles/$PROFILE"/*.lock

# A known, NON-codex deployment default, so "was it restored?" is an observable question.
python3 - "$ROOT/profiles/$PROFILE/package.json" "$ROOT/profiles/$PROFILE/cordis.patch.yml" <<'PY'
import json, pathlib, sys
manifest, patch = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
d = json.loads(manifest.read_text())
d['name'] = 'dsh-profile-pinprobe'
deps = d.setdefault('dependencies', {})
deps.pop('dsh-codex-session', None)
d['dsh']['profile']['bundles'] = [b for b in d['dsh']['profile']['bundles'] if b != 'dsh-codex-session']
manifest.write_text(json.dumps(d, indent=2) + '\n')

s = patch.read_text()
i = s.find('- id: agent-default-model')
if i < 0:
    s = ("- id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'\n"
         "  config:\n    provider: opencode-go\n    model: deepseek-v4.1-flash\n") + s
else:
    j = s.find('\n- ', i + 10)
    s = s[:i] + ("- id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'\n"
                 "  config:\n    provider: opencode-go\n    model: deepseek-v4.1-flash\n") + (s[j+1:] if j > 0 else '')
patch.write_text(s)
print('seeded throwaway profile with deployment default opencode-go/deepseek-v4.1-flash')
PY

export DSH_HOME="$ROOT"
# Install via the plugin manager so the linked package resolves inside the throwaway home.
"$DSH" plugin --profile "$PROFILE" remove dsh-codex-session >/dev/null 2>&1 || true
rm -f "$ROOT/profiles/$PROFILE"/*.lock
"$DSH" plugin --profile "$PROFILE" add "$PLUGIN" >/dev/null 2>&1 || true
rm -f "$ROOT/profiles/$PROFILE"/*.lock
"$DSH" plugin --profile "$PROFILE" add "$PROBE_SRC" >/dev/null 2>&1 || true
rm -f "$ROOT/profiles/$PROFILE"/*.lock

# Both rows must be present, with the plugin's patch applied after the shipped web layer.
python3 - "$ROOT/profiles/$PROFILE/package.json" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
d = json.loads(p.read_text())
b = d['dsh']['profile']['bundles']
for name in ('dsh-codex-session', 'dsh-codex-session-preset-probe'):
    if name not in b:
        b.append(name)
p.write_text(json.dumps(d, indent=2) + '\n')
print('bundles:', b)
PY

"$DSH" --profile "$PROFILE" --port "$PORT" --no-open > "$ROOT/boot.log" 2>&1 &
PID=$!
for _ in $(seq 1 90); do
  [ -f "$RESULT" ] && break
  sleep 2
done
sleep 2
kill "$PID" 2>/dev/null || true
sleep 1

if grep -qi 'did not activate\|skipping profile bundle' "$ROOT/boot.log"; then
  echo "FAIL: an entry did not activate"; grep -i 'did not activate\|skipping' "$ROOT/boot.log"; exit 1
fi
if [ ! -f "$RESULT" ]; then
  echo "FAIL: the probe wrote no result (see $ROOT/boot.log)"; tail -20 "$ROOT/boot.log"; exit 1
fi

python3 - "$RESULT" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
if 'error' in d:
    print('FAIL: probe error:', d['error']); sys.exit(1)
codex = d['codex']; dsh = d['dshDefaultSession']
pinned = bool(codex['modelSelections']) and codex['modelSelections'][0]['provider'] == 'codex-local'
restored = d['defaultAfterCodex'] == d['defaultBefore']
untouched = dsh['modelSelections'] == []
switched = any(s.get('provider') == 'codex-local' for s in d.get('afterChipSwitch', {}).get('modelSelections', []))
print('deployment default before :', d['defaultBefore'])
print('codex session             :', codex['created'], '| headerPreset =', codex['headerPreset'])
print('  pinned route            :', codex['modelSelections'])
print('deployment default after  :', d['defaultAfterCodex'])
print('standard-preset session   :', dsh['created'], '| headerPreset =', dsh['headerPreset'],
      '| modelSelections =', dsh['modelSelections'])
print('composer-chip switch      :', d.get('afterChipSwitch', {}).get('modelSelections'))
print()
for ok, label in ((pinned, 'codex session pinned to codex-local'),
                  (restored, 'deployment default restored'),
                  (untouched, 'standard-preset session left alone'),
                  (switched, 'switching an existing session to Codex re-pins it')):
    print(('ok   ' if ok else 'FAIL ') + label)
sys.exit(0 if (pinned and restored and untouched and switched) else 1)
PY
