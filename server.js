import express from "express";
import http from "http";
import cors from "cors";
import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = Number(process.env.PORT || 3000);
const SERVER_AUDIO_ENABLED = process.env.SERVER_AUDIO_ENABLED === "true";

const ALERT_SOURCE_URL = "https://www.oref.org.il/WarningMessages/alert/alerts.json";
const SOUND_EXTENSIONS = new Set([".mp3", ".wav", ".aiff", ".aif", ".m4a"]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETTINGS_PATH = process.env.SETTINGS_PATH
  ? path.resolve(process.env.SETTINGS_PATH)
  : path.join(__dirname, "settings.json");

const DEFAULT_SOUND = "315618__modularsamples__yamaha-cs-30l-whoopie-bass-c5-whoopie-bass-72-127.aiff";
const DEFAULT_SETTINGS = Object.freeze({
  trackedAreas: [],
  areaSoundMap: {},
  defaultSound: DEFAULT_SOUND,
});

let availableSounds = [];
let settings = {
  trackedAreas: [],
  areaSoundMap: {},
  defaultSound: DEFAULT_SOUND,
};

let lastAlertSignature = null;
let lastAlertObject = null;
let history = [];

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

const categoryMap = {
  1: "ירי רקטות וטילים",
  2: "חשש לחדירת מחבלים",
  3: "רעידת אדמה",
  4: "אירוע חומרים מסוכנים",
  5: "אירוע ביטחוני",
  6: "חדירת כלי טיס עוין",
  10: "האירוע הסתיים",
};

function cloneDefaultSettings() {
  return {
    trackedAreas: [],
    areaSoundMap: {},
    defaultSound: DEFAULT_SETTINGS.defaultSound,
  };
}

function rtl(text) {
  return String(text).split("").reverse().join("");
}

function colorize(text, color) {
  return `${color}${text}${colors.reset}`;
}

function printLine(text, color = colors.white) {
  console.log(colorize(rtl(text), color));
}

function printDivider(color = colors.dim) {
  console.log(colorize("========================================", color));
}

function nowStr() {
  return new Date().toLocaleString("he-IL", {
    timeZone: "Asia/Jerusalem",
  });
}

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function areaMatches(areaName, trackedName) {
  const area = normalizeText(areaName);
  const tracked = normalizeText(trackedName);

  if (!area || !tracked) return false;
  return area === tracked || area.includes(tracked) || tracked.includes(area);
}

function buildSignature(alert) {
  const title = alert?.title ?? "";
  const desc = alert?.desc ?? "";
  const areas = Array.isArray(alert?.data)
    ? alert.data.slice().sort().join("|")
    : "";

  return `${title}__${desc}__${areas}`;
}

function resolveCategoryName(raw) {
  const cat = Number(raw?.cat ?? 0);
  const title = String(raw?.title ?? "");
  const desc = String(raw?.desc ?? "");

  if (
    cat === 10 ||
    title.includes("האירוע הסתיים") ||
    desc.includes("האירוע הסתיים")
  ) {
    return "האירוע הסתיים";
  }

  return categoryMap[cat] || "קטגוריה לא ידועה";
}

function normalizeAlert(raw) {
  const areas = Array.isArray(raw?.data) ? raw.data : [];
  const categoryCode = Number(raw?.cat ?? 0);

  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: raw?.title ?? "התרעה",
    desc: raw?.desc ?? "",
    areas,
    category: categoryCode,
    categoryName: resolveCategoryName(raw),
    receivedAt: new Date().toISOString(),
  };
}

function getCategoryColor(alert) {
  const category = Number(alert?.category ?? 0);

  if (category === 10) return colors.green;

  switch (category) {
    case 1:
      return colors.red;
    case 6:
      return colors.cyan;
    default:
      return colors.white;
  }
}

async function discoverSoundFiles() {
  try {
    const files = await fs.readdir(__dirname);
    return files
      .filter((file) => SOUND_EXTENSIONS.has(path.extname(file).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, "he"));
  } catch {
    return [];
  }
}

async function loadRawSettingsFromDisk() {
  try {
    const content = await fs.readFile(SETTINGS_PATH, "utf8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function sanitizeSettings(input, sounds) {
  const clean = cloneDefaultSettings();
  const source =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};

  const tracked = Array.isArray(source.trackedAreas)
    ? source.trackedAreas
    : [];

  const uniqueTracked = new Map();

  for (const item of tracked) {
    const city = String(item ?? "").trim();
    if (!city) continue;
    uniqueTracked.set(normalizeText(city), city);
  }

  clean.trackedAreas = Array.from(uniqueTracked.values());

  const rawMap =
    source.areaSoundMap &&
    typeof source.areaSoundMap === "object" &&
    !Array.isArray(source.areaSoundMap)
      ? source.areaSoundMap
      : {};

  for (const [cityRaw, soundRaw] of Object.entries(rawMap)) {
    const city = String(cityRaw ?? "").trim();
    const sound = String(soundRaw ?? "").trim();
    if (!city || !sound) continue;
    if (!sounds.includes(sound)) continue;
    clean.areaSoundMap[city] = sound;
  }

  const preferredDefault = String(source.defaultSound ?? "").trim();

  if (sounds.includes(preferredDefault)) {
    clean.defaultSound = preferredDefault;
  } else if (sounds.includes(DEFAULT_SOUND)) {
    clean.defaultSound = DEFAULT_SOUND;
  } else {
    clean.defaultSound = sounds[0] ?? "";
  }

  return clean;
}

async function persistSettings() {
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
}

async function refreshSoundsAndSettings() {
  availableSounds = await discoverSoundFiles();
  settings = sanitizeSettings(settings, availableSounds);
  await persistSettings();
}

async function initializeSettings() {
  availableSounds = await discoverSoundFiles();
  const diskSettings = await loadRawSettingsFromDisk();
  settings = sanitizeSettings(diskSettings, availableSounds);
  await persistSettings();
}

function getMatchedAreas(alertAreas) {
  if (!Array.isArray(alertAreas) || alertAreas.length === 0) return [];

  if (settings.trackedAreas.length === 0) {
    return alertAreas;
  }

  return alertAreas.filter((alertArea) =>
    settings.trackedAreas.some((trackedArea) => areaMatches(alertArea, trackedArea))
  );
}

function resolveMappedSound(areas) {
  const mapEntries = Object.entries(settings.areaSoundMap);
  if (mapEntries.length === 0) return null;

  for (const area of areas) {
    const areaNorm = normalizeText(area);
    for (const [city, sound] of mapEntries) {
      if (!availableSounds.includes(sound)) continue;
      if (areaNorm && areaNorm === normalizeText(city)) {
        return sound;
      }
    }
  }

  for (const area of areas) {
    for (const [city, sound] of mapEntries) {
      if (!availableSounds.includes(sound)) continue;
      if (areaMatches(area, city)) {
        return sound;
      }
    }
  }

  return null;
}

function enrichAlert(alert) {
  const matchedAreas = getMatchedAreas(alert.areas);
  const shouldNotify = matchedAreas.length > 0;

  const soundFile = shouldNotify
    ? resolveMappedSound(matchedAreas) || settings.defaultSound || null
    : null;

  return {
    ...alert,
    matchedAreas,
    shouldNotify,
    soundFile,
  };
}

function playSound(soundFile) {
  if (!SERVER_AUDIO_ENABLED) return;
  if (!soundFile) return;
  if (!availableSounds.includes(soundFile)) return;

  const soundPath = path.join(__dirname, soundFile);
  const player = spawn("afplay", [soundPath], {
    stdio: "ignore",
    detached: true,
  });

  player.on("error", () => {});
  player.unref();
}

function printAlert(alert) {
  const categoryColor = getCategoryColor(alert);
  const shownAreas = Array.isArray(alert.matchedAreas) ? alert.matchedAreas : alert.areas;

  console.log("");
  printDivider(colors.dim);
  printLine(`זמן קליטה: ${nowStr()}`, colors.green);
  printLine(`כותרת: ${alert.title}`, colors.bright + colors.yellow);
  printLine(`תיאור: ${alert.desc || "ללא תיאור"}`, colors.white);
  printLine(`קטגוריה: ${alert.category}`, categoryColor);
  printLine(`סוג קטגוריה: ${alert.categoryName}`, categoryColor);
  printLine(`יישובים (${shownAreas.length}):`, colors.magenta);

  shownAreas.forEach((city) => {
    printLine(`• ${city}`, colors.cyan);
  });

  printDivider(colors.dim);
  console.log("");
}

function printHeartbeat() {
  printLine(`השרת פעיל: ${nowStr()}`, colors.dim);
}

function publishAlert(alert) {
  lastAlertObject = alert;
  history.unshift(alert);
  history = history.slice(0, 100);

  printAlert(alert);

  if (alert.category !== 10) {
    playSound(alert.soundFile);
  }

  broadcast({
    type: "alert",
    payload: alert,
  });
}

function broadcast(payload) {
  const data = JSON.stringify(payload);

  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(data);
    }
  }
}

function scheduleNextFetch() {
  const delay = 1800 + Math.random() * 400;
  setTimeout(fetchAlerts, delay);
}

async function fetchAlerts() {
  try {
    const res = await fetch(ALERT_SOURCE_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json",
        Referer: "https://www.oref.org.il/",
        Connection: "keep-alive",
      },
    });

    if (!res.ok) {
      scheduleNextFetch();
      return;
    }

    const text = await res.text();
    if (!text || text.length < 5) {
      scheduleNextFetch();
      return;
    }

    let raw;

    try {
      raw = JSON.parse(text);
    } catch {
      scheduleNextFetch();
      return;
    }

    if (!raw || !Array.isArray(raw.data) || raw.data.length === 0) {
      scheduleNextFetch();
      return;
    }

    const signature = buildSignature(raw);
    if (signature === lastAlertSignature) {
      scheduleNextFetch();
      return;
    }

    lastAlertSignature = signature;

    const normalized = normalizeAlert(raw);
    const enriched = enrichAlert(normalized);

    if (!enriched.shouldNotify) {
      scheduleNextFetch();
      return;
    }

    publishAlert(enriched);
  } catch {}

  scheduleNextFetch();
}

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/last-alert", (req, res) => {
  res.json(lastAlertObject);
});

app.get("/api/history", (req, res) => {
  res.json(history);
});

app.get("/api/sounds", async (req, res) => {
  await refreshSoundsAndSettings();
  res.json(availableSounds);
});

app.get("/api/settings", (req, res) => {
  res.json(settings);
});

app.put("/api/settings", async (req, res) => {
  await refreshSoundsAndSettings();
  settings = sanitizeSettings(req.body, availableSounds);
  await persistSettings();

  broadcast({
    type: "settings",
    payload: settings,
  });

  res.json(settings);
});

app.post("/api/test-alert", (req, res) => {
  const rawAreas = Array.isArray(req.body?.areas) ? req.body.areas : [];
  const cleanedAreas = rawAreas
    .map((area) => String(area ?? "").trim())
    .filter(Boolean)
    .slice(0, 20);

  const areasForTest =
    cleanedAreas.length > 0
      ? cleanedAreas
      : settings.trackedAreas.length > 0
        ? settings.trackedAreas
        : ["תל אביב"];

  const testAlert = enrichAlert({
    id: `${Date.now()}_test_${Math.random().toString(36).slice(2, 8)}`,
    title: "התראת בדיקה",
    desc: "הודעת בדיקה ידנית מהמערכת",
    areas: areasForTest,
    category: 1,
    categoryName: categoryMap[1],
    receivedAt: new Date().toISOString(),
  });

  publishAlert(testAlert);
  res.json(testAlert);
});

wss.on("connection", (socket) => {
  socket.send(
    JSON.stringify({
      type: "welcome",
      payload: {
        lastAlert: lastAlertObject,
        sounds: availableSounds,
        settings,
      },
    })
  );
});

await initializeSettings();

setInterval(printHeartbeat, 60000);

server.listen(PORT, () => {
  printLine(`השרת רץ בכתובת http://localhost:${PORT}`, colors.green);
  printLine("מאזין להתראות פיקוד העורף", colors.bright + colors.yellow);
  console.log("");
  fetchAlerts();
});
