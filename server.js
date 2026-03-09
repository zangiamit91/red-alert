import express from "express";
import http from "http";
import cors from "cors";
import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import multer from "multer";

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = Number(process.env.PORT || 3000);
const SERVER_AUDIO_ENABLED = process.env.SERVER_AUDIO_ENABLED === "true";
const MAX_HISTORY_ITEMS = 2000;
const SOUND_UPLOAD_MAX_BYTES = 15 * 1024 * 1024;

const ALERT_SOURCE_URL = "https://www.oref.org.il/WarningMessages/alert/alerts.json";
const ALLOWED_SOUND_EXTENSIONS = [".mp3", ".wav", ".aiff", ".aif", ".m4a"];
const SOUND_EXTENSIONS = new Set(ALLOWED_SOUND_EXTENSIONS);
const NON_SIREN_TEXT_MARKERS = ["האירוע הסתיים", "מוקדמת", "תרגיל"];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETTINGS_PATH = process.env.SETTINGS_PATH
  ? path.resolve(process.env.SETTINGS_PATH)
  : path.join(__dirname, "settings.json");
const HISTORY_PATH = process.env.HISTORY_PATH
  ? path.resolve(process.env.HISTORY_PATH)
  : path.join(__dirname, "history.json");

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

function sanitizeFileBaseName(fileName) {
  return String(fileName ?? "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "sound";
}

const soundUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, __dirname);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = sanitizeFileBaseName(path.basename(file.originalname, ext));
    cb(null, `${base}_${Date.now()}${ext}`);
  },
});

const uploadSound = multer({
  storage: soundUploadStorage,
  limits: {
    fileSize: SOUND_UPLOAD_MAX_BYTES,
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_SOUND_EXTENSIONS.includes(ext)) {
      cb(new Error("unsupported-sound-extension"));
      return;
    }
    cb(null, true);
  },
});

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function areaMatches(areaName, trackedName) {
  const area = normalizeText(areaName);
  const tracked = normalizeText(trackedName);

  if (!area || !tracked) return false;
  return area === tracked || area.includes(tracked) || tracked.includes(area);
}

function hasNonSirenMarker(text) {
  const normalized = normalizeText(text);
  return NON_SIREN_TEXT_MARKERS.some((marker) =>
    normalized.includes(normalizeText(marker))
  );
}

function isRawSirenAlert(raw) {
  const category = Number(raw?.cat ?? 0);
  if (category !== 1) return false;

  const title = String(raw?.title ?? "");
  const desc = String(raw?.desc ?? "");

  return !hasNonSirenMarker(`${title} ${desc}`);
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
  const title = String(raw?.title ?? "התרעה");
  const desc = String(raw?.desc ?? "");
  const rawIsSiren =
    typeof raw?.isSiren === "boolean" ? raw.isSiren : isRawSirenAlert(raw);

  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title,
    desc,
    areas,
    category: categoryCode,
    categoryName: resolveCategoryName(raw),
    receivedAt: new Date().toISOString(),
    isSiren: rawIsSiren,
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

async function loadRawHistoryFromDisk() {
  try {
    const content = await fs.readFile(HISTORY_PATH, "utf8");
    return JSON.parse(content);
  } catch {
    return [];
  }
}

function sanitizeHistory(input) {
  if (!Array.isArray(input)) return [];

  const cleaned = [];

  for (const item of input) {
    if (!item || typeof item !== "object") continue;

    const id = String(item.id ?? "").trim();
    const title = String(item.title ?? "התרעה");
    const desc = String(item.desc ?? "");
    const category = Number(item.category ?? 0);
    const categoryName =
      String(item.categoryName ?? "").trim() ||
      categoryMap[category] ||
      "קטגוריה לא ידועה";
    const receivedAtDate = new Date(item.receivedAt ?? Date.now());
    if (Number.isNaN(receivedAtDate.getTime())) continue;

    const areas = Array.isArray(item.areas)
      ? item.areas.map((v) => String(v ?? "").trim()).filter(Boolean)
      : [];
    const matchedAreas = Array.isArray(item.matchedAreas)
      ? item.matchedAreas.map((v) => String(v ?? "").trim()).filter(Boolean)
      : areas;
    const isTest =
      typeof item.isTest === "boolean"
        ? item.isTest
        : title.includes("התראת בדיקה") || desc.includes("בדיקה");

    cleaned.push({
      id: id || `${receivedAtDate.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      desc,
      areas,
      matchedAreas,
      category,
      categoryName,
      receivedAt: receivedAtDate.toISOString(),
      shouldNotify:
        typeof item.shouldNotify === "boolean"
          ? item.shouldNotify
          : matchedAreas.length > 0,
      soundFile: typeof item.soundFile === "string" ? item.soundFile : null,
      isTest,
      isSiren:
        typeof item.isSiren === "boolean"
          ? item.isSiren
          : category === 1 && !hasNonSirenMarker(`${title} ${desc}`),
    });
  }

  cleaned.sort(
    (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
  );

  return cleaned.slice(0, MAX_HISTORY_ITEMS);
}

async function persistHistory() {
  await fs.mkdir(path.dirname(HISTORY_PATH), { recursive: true });
  await fs.writeFile(HISTORY_PATH, JSON.stringify(history, null, 2), "utf8");
}

function persistHistoryInBackground() {
  persistHistory().catch(() => {});
}

async function initializeHistory() {
  const diskHistory = await loadRawHistoryFromDisk();
  history = sanitizeHistory(diskHistory).filter((item) => !item.isTest);
  if (history.length > 0) {
    lastAlertObject = history[0];
  }
  await persistHistory();
}

function parseDateParam(value) {
  const parsed = new Date(String(value ?? "").trim());
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function buildHistoryFilter(query) {
  const now = Date.now();

  const parsedLimit = Number(query.limit ?? 300);
  const limit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(Math.trunc(parsedLimit), MAX_HISTORY_ITEMS))
    : 300;

  const onlySirens = String(query.onlySirens ?? "true") !== "false";
  const includeTests = String(query.includeTests ?? "false") === "true";

  const lastHours = Number(query.lastHours);
  const lastDays = Number(query.lastDays);

  let fromDate = null;
  let toDate = null;

  if (Number.isFinite(lastHours) && lastHours > 0) {
    fromDate = new Date(now - lastHours * 60 * 60 * 1000);
  } else if (Number.isFinite(lastDays) && lastDays > 0) {
    fromDate = new Date(now - lastDays * 24 * 60 * 60 * 1000);
  } else {
    fromDate = query.from ? parseDateParam(query.from) : null;
  }

  if (query.to) {
    toDate = parseDateParam(query.to);
  }

  return {
    limit,
    onlySirens,
    includeTests,
    fromTs: fromDate ? fromDate.getTime() : null,
    toTs: toDate ? toDate.getTime() : null,
  };
}

function getFilteredHistory(filter) {
  return history
    .filter((item) => {
      if (filter.onlySirens && !item.isSiren) return false;
      if (!filter.includeTests && item.isTest) return false;

      const ts = new Date(item.receivedAt).getTime();
      if (Number.isNaN(ts)) return false;
      if (filter.fromTs !== null && ts < filter.fromTs) return false;
      if (filter.toTs !== null && ts > filter.toTs) return false;

      return true;
    })
    .slice(0, filter.limit);
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
    isSiren:
      typeof alert.isSiren === "boolean"
        ? alert.isSiren
        : Number(alert.category ?? 0) === 1 &&
          !hasNonSirenMarker(`${alert.title ?? ""} ${alert.desc ?? ""}`),
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

function publishAlert(alert, options = {}) {
  const { recordHistory = true } = options;

  lastAlertObject = alert;

  if (recordHistory) {
    history.unshift(alert);
    history = history.slice(0, MAX_HISTORY_ITEMS);
    persistHistoryInBackground();
  }

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

    if (!isRawSirenAlert(raw)) {
      scheduleNextFetch();
      return;
    }

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
  const filter = buildHistoryFilter(req.query ?? {});
  res.json(getFilteredHistory(filter));
});

app.get("/api/sounds", async (req, res) => {
  await refreshSoundsAndSettings();
  res.json(availableSounds);
});

app.post("/api/sounds/upload", (req, res) => {
  uploadSound.single("soundFile")(req, res, async (error) => {
    if (error) {
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        res.status(400).json({
          error: "file-too-large",
          message: "Maximum allowed size is 15MB",
        });
        return;
      }

      if (error.message === "unsupported-sound-extension") {
        res.status(400).json({
          error: "unsupported-sound-extension",
          message: "Allowed formats: mp3, wav, aiff, aif, m4a",
        });
        return;
      }

      res.status(400).json({
        error: "upload-failed",
        message: "Failed to upload sound file",
      });
      return;
    }

    if (!req.file) {
      res.status(400).json({
        error: "missing-file",
        message: "No file uploaded",
      });
      return;
    }

    await refreshSoundsAndSettings();

    const setAsDefault = String(req.body?.setAsDefault ?? "false") === "true";
    if (setAsDefault && availableSounds.includes(req.file.filename)) {
      settings.defaultSound = req.file.filename;
      await persistSettings();

      broadcast({
        type: "settings",
        payload: settings,
      });
    }

    res.json({
      fileName: req.file.filename,
      sounds: availableSounds,
      settings,
    });
  });
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
    isSiren: true,
    isTest: true,
  });

  if (!testAlert.shouldNotify) {
    testAlert.matchedAreas = areasForTest;
    testAlert.shouldNotify = true;
    testAlert.soundFile = settings.defaultSound || null;
  }

  publishAlert(testAlert, { recordHistory: false });
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
await initializeHistory();

setInterval(printHeartbeat, 60000);

server.listen(PORT, () => {
  printLine(`השרת רץ בכתובת http://localhost:${PORT}`, colors.green);
  printLine("מאזין להתראות פיקוד העורף", colors.bright + colors.yellow);
  console.log("");
  fetchAlerts();
});
