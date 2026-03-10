#!/usr/bin/env bash
set -euo pipefail

LOG_PATH="/tmp/red-alert-public-tunnel.log"

pkill -f "ssh .*localhost.run" >/dev/null 2>&1 || true

nohup ssh -o StrictHostKeyChecking=no \
  -o ServerAliveInterval=30 \
  -o ExitOnForwardFailure=yes \
  -R 80:127.0.0.1:3000 \
  nokey@localhost.run >"$LOG_PATH" 2>&1 &

sleep 5

URL="$(rg -o 'https://[a-zA-Z0-9.-]+' "$LOG_PATH" | head -n 1 || true)"
if [[ -z "$URL" ]]; then
  echo "No public URL found yet. Check: $LOG_PATH"
  exit 1
fi

echo "Public URL: $URL"
echo "Tunnel log: $LOG_PATH"
echo "Health check:"
curl -sS -m 20 "$URL/health" || true
echo
