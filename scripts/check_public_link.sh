#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="${1:-https://red-alert-o5nd.onrender.com}"
LOCAL_BUILD="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"

echo "Checking public link: $BASE_URL"

node - "$BASE_URL" "$LOCAL_BUILD" <<'NODE'
const baseUrl = String(process.argv[2] || "").replace(/\/$/, "");
const localBuild = String(process.argv[3] || "unknown").trim();

async function safeFetch(path) {
  try {
    const response = await fetch(`${baseUrl}${path}`);
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return {
      ok: response.ok,
      status: response.status,
      json,
      text,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      json: null,
      text: String(error?.message || "network-error"),
    };
  }
}

async function main() {
  const health = await safeFetch("/health");
  console.log(`healthStatus=${health.status}`);
  if (health.json?.buildVersion) {
    console.log(`healthBuild=${health.json.buildVersion}`);
  }

  const config = await safeFetch("/api/app-config");
  console.log(`appConfigStatus=${config.status}`);
  if (!config.json) {
    console.log("appConfig=unavailable");
    return;
  }

  const publicShareUrl = String(config.json.publicShareUrl || "").trim();
  const repoUrl = String(config.json.repoUrl || "").trim();
  const remoteBuild = String(config.json.buildVersion || "").trim();

  console.log(`remoteBuild=${remoteBuild || "-"}`);
  console.log(`localBuild=${localBuild}`);
  console.log(`publicShareUrl=${publicShareUrl || "-"}`);
  console.log(`repoUrl=${repoUrl || "-"}`);

  if (remoteBuild && localBuild !== "unknown") {
    console.log(
      `buildMatch=${remoteBuild === localBuild ? "yes" : "no"}`
    );
  }
}

main().catch((error) => {
  console.error(error?.message || "check-public-link-failed");
  process.exit(1);
});
NODE
