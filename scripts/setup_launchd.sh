#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="$(command -v node || true)"
PLIST_PATH="$HOME/Library/LaunchAgents/com.amit.red-alert.plist"
LABEL="com.amit.red-alert"
ADMIN_KEY_VALUE="${ADMIN_KEY:-}"

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "$value"
}

if [[ -z "$NODE_BIN" ]]; then
  if [[ -x "/opt/homebrew/bin/node" ]]; then
    NODE_BIN="/opt/homebrew/bin/node"
  elif [[ -x "/usr/local/bin/node" ]]; then
    NODE_BIN="/usr/local/bin/node"
  fi
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Node binary not found. Install Node.js first."
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"

ADMIN_KEY_PLIST_ENTRY=""
if [[ -n "$ADMIN_KEY_VALUE" ]]; then
  ESCAPED_ADMIN_KEY="$(xml_escape "$ADMIN_KEY_VALUE")"
  ADMIN_KEY_PLIST_ENTRY=$(cat <<EOF
      <key>ADMIN_KEY</key>
      <string>$ESCAPED_ADMIN_KEY</string>
EOF
)
fi

cat >"$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>WorkingDirectory</key>
    <string>$APP_DIR</string>
    <key>ProgramArguments</key>
    <array>
      <string>$NODE_BIN</string>
      <string>$APP_DIR/server.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/red-alert-launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/red-alert-launchd.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PORT</key>
      <string>3000</string>
      <key>SERVER_AUDIO_ENABLED</key>
      <string>false</string>
${ADMIN_KEY_PLIST_ENTRY}
    </dict>
  </dict>
</plist>
PLIST

LAUNCH_DOMAIN="gui/$(id -u)"
LAUNCH_SERVICE="$LAUNCH_DOMAIN/$LABEL"

launchctl bootout "$LAUNCH_SERVICE" >/dev/null 2>&1 || true
BOOTSTRAP_OK=0
for _ in 1 2 3; do
  if launchctl bootstrap "$LAUNCH_DOMAIN" "$PLIST_PATH" >/dev/null 2>&1; then
    BOOTSTRAP_OK=1
    break
  fi
  launchctl bootout "$LAUNCH_SERVICE" >/dev/null 2>&1 || true
  sleep 1
done

if [[ "$BOOTSTRAP_OK" -ne 1 ]]; then
  echo "Failed to bootstrap LaunchAgent: $LABEL"
  exit 1
fi

launchctl kickstart -k "$LAUNCH_SERVICE"

sleep 2
echo "LaunchAgent installed: $PLIST_PATH"
launchctl print "$LAUNCH_SERVICE" | sed -n '1,40p' || true
echo "Health check:"
for _ in {1..20}; do
  if curl -fsS http://localhost:3000/health >/tmp/red-alert-health.json 2>/dev/null; then
    cat /tmp/red-alert-health.json
    echo
    exit 0
  fi
  sleep 1
done

echo "Server did not become healthy on http://localhost:3000/health"
exit 1
