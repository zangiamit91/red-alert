#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"

echo "Checking $BASE_URL"
echo "- /health"
curl -sS "$BASE_URL/health"
echo

echo "- /api/system-status"
curl -sS "$BASE_URL/api/system-status" | node -e '
let d="";
process.stdin.on("data",c=>d+=c);
process.stdin.on("end",()=>{
  const j=JSON.parse(d);
  console.log("historyCount="+j.historyCount);
  console.log("historySource="+(j.historySyncState?.sourceUrl||""));
  console.log("historyError="+(j.historySyncState?.error||""));
  console.log("lastAlertFetchError="+(j.lastAlertFetchState?.error||""));
});
'

echo "- /api/history (last 48h, limit 5)"
curl -sS "$BASE_URL/api/history?onlySirens=true&lastHours=48&limit=5" | node -e '
let d="";
process.stdin.on("data",c=>d+=c);
process.stdin.on("end",()=>{
  const j=JSON.parse(d);
  console.log("count="+(Array.isArray(j)?j.length:0));
  if(Array.isArray(j) && j[0]){
    console.log("first="+j[0].title+" | "+j[0].areas.join(", ")+" | "+j[0].receivedAt);
  }
});
'
