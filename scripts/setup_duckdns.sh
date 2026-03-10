#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <duckdns-domain> <duckdns-token>"
  exit 1
fi

DOMAIN="$1"
TOKEN="$2"
LABEL="com.amit.duckdns"
SCRIPT_PATH="$HOME/.duckdns-update.sh"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

cat >"$SCRIPT_PATH" <<SCRIPT
#!/usr/bin/env bash
curl -fsS "https://www.duckdns.org/update?domains=${DOMAIN}&token=${TOKEN}&ip=" >/tmp/duckdns.log
SCRIPT
chmod +x "$SCRIPT_PATH"

mkdir -p "$HOME/Library/LaunchAgents"
cat >"$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
      <string>$SCRIPT_PATH</string>
    </array>
    <key>StartInterval</key>
    <integer>300</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/duckdns-launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/duckdns-launchd.err.log</string>
  </dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

sleep 1
echo "DuckDNS updater installed for domain: $DOMAIN"
echo "Latest response:"
cat /tmp/duckdns.log || true
