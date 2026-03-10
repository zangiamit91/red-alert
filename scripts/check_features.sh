#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"

node - "$BASE_URL" <<'NODE'
const baseUrl = String(process.argv[2] || "http://localhost:3000").replace(/\/$/, "");

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function areaMatches(areaName, trackedName) {
  const area = normalizeText(areaName);
  const tracked = normalizeText(trackedName);
  if (!area || !tracked) return false;
  return area === tracked || area.includes(tracked) || tracked.includes(area);
}

async function fetchJson(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  if (!response.ok) {
    fail(`${path} returned HTTP ${response.status}`);
  }
  return response.json();
}

function resolveExpectedSound(settings, areaName) {
  const areaSoundMap =
    settings && typeof settings.areaSoundMap === "object" && settings.areaSoundMap
      ? settings.areaSoundMap
      : {};

  const exactKey = Object.keys(areaSoundMap).find(
    (key) => normalizeText(key) === normalizeText(areaName)
  );
  if (exactKey) {
    return areaSoundMap[exactKey];
  }

  const fuzzyKey = Object.keys(areaSoundMap).find((key) => areaMatches(areaName, key));
  if (fuzzyKey) {
    return areaSoundMap[fuzzyKey];
  }

  return settings?.defaultSound || null;
}

async function main() {
  const health = await fetchJson("/health");
  if (!health || health.ok !== true) {
    fail("/health returned invalid payload");
  }

  const settings = await fetchJson("/api/settings");
  const trackedAreas = Array.isArray(settings?.trackedAreas) ? settings.trackedAreas : [];
  if (trackedAreas.length === 0) {
    fail("No tracked areas configured in settings");
  }

  const areasToTest = trackedAreas.slice(0, Math.min(2, trackedAreas.length));
  console.log(`Health OK (${baseUrl})`);
  console.log(`Tracked areas: ${trackedAreas.length}`);
  console.log(`Testing areas: ${areasToTest.join(", ")}`);

  for (const areaName of areasToTest) {
    const payload = await fetchJson("/api/test-alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ areas: [areaName] }),
    });

    if (!payload?.shouldNotify) {
      fail(`Test alert for "${areaName}" returned shouldNotify=false`);
    }

    const matchedAreas = Array.isArray(payload?.matchedAreas) ? payload.matchedAreas : [];
    const hasAreaMatch = matchedAreas.some((value) => areaMatches(value, areaName));
    if (!hasAreaMatch) {
      fail(
        `Test alert for "${areaName}" did not include a matched area (got: ${matchedAreas.join(
          ", "
        )})`
      );
    }

    const expectedSound = resolveExpectedSound(settings, areaName);
    const actualSound = payload?.soundFile || null;
    if (expectedSound && actualSound !== expectedSound) {
      fail(
        `Unexpected sound for "${areaName}" (expected "${expectedSound}", got "${actualSound}")`
      );
    }

    console.log(
      `Test area OK: ${areaName} | matched=${matchedAreas.join(", ")} | sound=${actualSound || "-"}`
    );
  }

  const history = await fetchJson("/api/history?onlySirens=true&includeTests=true&lastHours=24&limit=500");
  const historyItems = Array.isArray(history) ? history : [];
  const testsInHistory = historyItems.filter((item) => item?.isTest === true).length;
  if (testsInHistory > 0) {
    fail(`History contains ${testsInHistory} test alerts`);
  }

  console.log(`History OK: ${historyItems.length} siren alerts, 0 test alerts`);
}

main().catch((error) => {
  fail(error?.message || "Unknown validation error");
});
NODE
