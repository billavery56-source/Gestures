// scripts/options.js

const KEYS = {
  cfg: "mg_config_v1",
  list: "mg_blacklist_v1"
};

const DEFAULTS = {
  enabled: true,
  mode: "blacklist",
  theme: "dark",
  prefs: {
    minSegmentPx: 18,
    jitterPx: 4,
    lineWidth: 3,
    trailColor: "#00e5ff",
    trailAlpha: 0.85
  },
  gestureMap: {
    L: "back",
    R: "forward",
    U: "top",
    D: "bottom",
    UR: "new_tab",
    DR: "close_tab",
    DL: "reload"
  }
};

const ACTIONS = ["", "back", "forward", "reload", "top", "bottom", "close_tab", "new_tab"];
const COMMON_PATTERNS = ["L","R","U","D","UL","UR","DL","DR","LU","LD","RU","RD","LR","RL","UD","DU","URD","ULD","DRU","DLU"];

function uniq(arr){ return Array.from(new Set(arr.filter(Boolean))); }
function clamp(n,a,b){ n=Number(n); if(!Number.isFinite(n)) return a; return Math.min(b, Math.max(a,n)); }
function normalizeHost(host){ return String(host||"").trim().toLowerCase(); }
function isValidHost(s){
  s = normalizeHost(s);
  if(!s) return false;
  if(s.includes("://")) return false;
  if(s.includes("/")) return false;
  return true;
}

async function send(type, payload = {}) {
  try {
    return await chrome.runtime.sendMessage({ type, ...payload });
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function showSaved(msg = "Saved") {
  const el = document.getElementById("saved");
  if (!el) return;
  el.textContent = msg;
  if (msg) setTimeout(() => (el.textContent = ""), 900);
}

function setStatus(text) {
  const el = document.getElementById("statusText");
  if (!el) return;
  el.textContent = text || "";
  if (text) setTimeout(() => (el.textContent = ""), 1400);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

function setRangeValue(range, value) {
  if (!range) return;
  range.value = String(value);
}

async function readAll() {
  const res = await chrome.storage.local.get([KEYS.cfg, KEYS.list]);
  const cfg = res[KEYS.cfg] && typeof res[KEYS.cfg] === "object" ? res[KEYS.cfg] : {};
  const list = Array.isArray(res[KEYS.list]) ? res[KEYS.list] : [];

  const merged = {
    enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : DEFAULTS.enabled,
    mode: (cfg.mode === "whitelist" || cfg.mode === "blacklist") ? cfg.mode : DEFAULTS.mode,
    theme: (cfg.theme === "light" || cfg.theme === "dim" || cfg.theme === "dark") ? cfg.theme : DEFAULTS.theme,
    prefs: { ...DEFAULTS.prefs, ...(cfg.prefs && typeof cfg.prefs === "object" ? cfg.prefs : {}) },
    gestureMap: { ...DEFAULTS.gestureMap, ...(cfg.gestureMap && typeof cfg.gestureMap === "object" ? cfg.gestureMap : {}) }
  };

  return { cfg: merged, list };
}

async function writeCfg(cfg) {
  await chrome.storage.local.set({ [KEYS.cfg]: cfg });
}

async function writeList(list) {
  await chrome.storage.local.set({ [KEYS.list]: list });
}

// ===== Quick Controls =====
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return (tabs && tabs[0]) ? tabs[0] : null;
}

function domainFromUrl(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

function isBlockedUrl(url) {
  if (!url) return true;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("https://chrome.google.com/webstore") ||
    url.startsWith("https://chromewebstore.google.com")
  );
}

async function initQuickControls(cfg) {
  const domainLabel = document.getElementById("domainLabel");
  const globalEnabled = document.getElementById("globalEnabled");
  const tempDisable = document.getElementById("tempDisable");
  const siteDisable = document.getElementById("siteDisable");
  const qcHint = document.getElementById("qcHint");

  const tab = await getActiveTab();
  const tabId = tab?.id;
  const url = tab?.url || "";
  const domain = domainFromUrl(url);

  if (domainLabel) domainLabel.textContent = domain || "(no domain)";

  // Set global checkbox based on cfg
  if (globalEnabled) globalEnabled.checked = !!cfg.enabled;

  const blocked = !tabId || isBlockedUrl(url);

  if (blocked) {
    if (qcHint) qcHint.textContent = "This page blocks extensions or has no URL. Per-tab/per-site controls disabled.";
    if (tempDisable) { tempDisable.checked = false; tempDisable.disabled = true; }
    if (siteDisable) { siteDisable.checked = false; siteDisable.disabled = true; }
  } else {
    if (qcHint) qcHint.textContent = "Applies to your current active tab.";
    if (tempDisable) tempDisable.disabled = false;
    if (siteDisable) siteDisable.disabled = false;

    const status = await send("MG_GET_TAB_STATUS", { tabId, tabUrl: url });
    if (!status?.ok) setStatus(status?.error || "Status error");
    else {
      if (globalEnabled) globalEnabled.checked = !!status.globalEnabled;
      if (tempDisable) tempDisable.checked = !!status.tempDisabled;
      if (siteDisable) siteDisable.checked = !!status.blacklisted;
    }
  }

  globalEnabled?.addEventListener("change", async () => {
    const res = await send("MG_SET_GLOBAL_ENABLED", { enabled: !!globalEnabled.checked });
    if (!res?.ok) setStatus(res?.error || "Error saving");
    else setStatus("Saved");
  });

  tempDisable?.addEventListener("change", async () => {
    if (!tabId) return;
    const res = await send("MG_SET_TEMP_DISABLED", { tabId, tempDisabled: !!tempDisable.checked });
    if (!res?.ok) setStatus(res?.error || "Error saving");
    else setStatus("Saved");
  });

  siteDisable?.addEventListener("change", async () => {
    if (!domain) return;
    const res = await send("MG_SET_DOMAIN_BLACKLISTED", { domain, blacklisted: !!siteDisable.checked });
    if (!res?.ok) setStatus(res?.error || "Error saving");
    else setStatus("Saved");
  });
}

/* =========================
   Trainer
   ========================= */
function initTrainer() {
  const canvas = document.getElementById("trainerCanvas");
  const clearBtn = document.getElementById("trainerClear");
  const patEl = document.getElementById("trainerPattern");
  const actEl = document.getElementById("trainerAction");
  if (!canvas || !patEl || !actEl) return;

  // size canvas to its CSS box
  function resizeCanvas() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.floor(r.width * dpr);
    canvas.height = Math.floor(r.height * dpr);
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    clearCanvas();
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  canvas.style.touchAction = "none";
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  let points = [];
  let drawing = false;

  const cssVar = (name, fb) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;

  function clearCanvas() {
    const r = canvas.getBoundingClientRect();
    const w = r.width, h = r.height;
    ctx.clearRect(0, 0, w, h);

    const border = cssVar("--border", "rgba(255,255,255,.12)");
    const text = cssVar("--muted", "rgba(255,255,255,.6)");
    const accent = cssVar("--accent", "#00e5ff");

    // grid
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    for (let x = 30; x < w; x += 30) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 30; y < h; y += 30) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    ctx.restore();

    // crosshair
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = accent;
    ctx.beginPath();
    ctx.moveTo(w / 2, 10); ctx.lineTo(w / 2, h - 10);
    ctx.moveTo(10, h / 2); ctx.lineTo(w - 10, h / 2);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = text;
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText("Draw gesture here (left or right mouse)", 12, 18);
    ctx.restore();
  }

  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  const dist = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);

  function detectPattern(pts, minSeg, jitter) {
    if (!pts || pts.length < 2) return "";
    let last = pts[0], acc = 0, out = "";

    const dir = (dx, dy) => {
      const adx = Math.abs(dx), ady = Math.abs(dy);
      if (adx < jitter && ady < jitter) return "";
      if (adx >= ady) return dx >= 0 ? "R" : "L";
      return dy >= 0 ? "D" : "U";
    };

    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      acc += dist(last, p);
      if (acc >= minSeg) {
        const d = dir(p.x - last.x, p.y - last.y);
        if (d && out[out.length - 1] !== d) out += d;
        last = p;
        acc = 0;
      }
    }
    return out;
  }

  function drawPath(pts) {
    clearCanvas();
    if (!pts || pts.length < 2) return;

    const accent = cssVar("--accent", "#00e5ff");
    const lw = Math.max(2, Number(window.prefs?.lineWidth ?? 2));

    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = lw;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.globalAlpha = 0.95;

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.restore();
  }

  function update() {
    const minSeg = Number(window.prefs?.minSegmentPx ?? 18);
    const jitter = Number(window.prefs?.jitterPx ?? 4);

    const pattern = detectPattern(points, minSeg, jitter);
    patEl.textContent = pattern || "—";

    const action = pattern && window.gestureMap?.[pattern] ? String(window.gestureMap[pattern]) : "";
    actEl.textContent = action || "—";
  }

  function start(e) {
    // allow left (0) OR right (2)
    if (e.button !== 0 && e.button !== 2) return;
    drawing = true;
    points = [pos(e)];
    canvas.setPointerCapture(e.pointerId);
    drawPath(points);
    update();
    e.preventDefault();
  }

  function move(e) {
    if (!drawing) return;
    points.push(pos(e));
    drawPath(points);
    update();
    e.preventDefault();
  }

  function end() {
    drawing = false;
    update();
  }

  canvas.addEventListener("pointerdown", start);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  clearBtn?.addEventListener("click", () => {
    points = [];
    patEl.textContent = "—";
    actEl.textContent = "—";
    clearCanvas();
  });

  new MutationObserver(clearCanvas).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"]
  });

  window.addEventListener("resize", resizeCanvas);
  setTimeout(resizeCanvas, 0);
}

/* =========================
   Gesture map UI
   ========================= */
function renderMapGrid(mapGrid, gestureMap) {
  if (!mapGrid) return;
  mapGrid.innerHTML = "";

  const patterns = uniq([...Object.keys(gestureMap || {}), ...COMMON_PATTERNS]);

  patterns.forEach((p) => {
    const row = document.createElement("div");
    row.className = "row";
    row.style.justifyContent = "flex-start";
    row.style.gap = "10px";

    const label = document.createElement("div");
    label.style.minWidth = "72px";
    label.style.fontWeight = "800";
    label.textContent = p;

    const select = document.createElement("select");
    select.dataset.pattern = p;
    select.style.flex = "1";

    ACTIONS.forEach((a) => {
      const opt = document.createElement("option");
      opt.value = a;
      opt.textContent = a ? a : "(disabled)";
      select.appendChild(opt);
    });

    select.value = gestureMap?.[p] ?? "";

    row.appendChild(label);
    row.appendChild(select);
    mapGrid.appendChild(row);
  });
}

/* =========================
   Export helper
   ========================= */
async function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  await chrome.downloads.download({ url, filename, saveAs: true });

  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

/* =========================
   Main
   ========================= */
(async () => {
  const themeSelect = document.getElementById("themeSelect");
  const enabledEl = document.getElementById("enabled");

  const modeBlacklist = document.getElementById("modeBlacklist");
  const modeWhitelist = document.getElementById("modeWhitelist");
  const blacklistBox = document.getElementById("blacklist");
  const saveBlacklistBtn = document.getElementById("saveBlacklist");

  const minSegmentPx = document.getElementById("minSegmentPx");
  const jitterPx = document.getElementById("jitterPx");
  const lineWidth = document.getElementById("lineWidth");
  const trailColor = document.getElementById("trailColor");
  const trailAlpha = document.getElementById("trailAlpha");
  const savePrefs = document.getElementById("savePrefs");
  const resetPrefs = document.getElementById("resetPrefs");

  const exportBtn = document.getElementById("exportBtn");
  const importBtn = document.getElementById("importBtn");
  const importFile = document.getElementById("importFile");

  const mapGrid = document.getElementById("mapGrid");
  const saveMap = document.getElementById("saveMap");

  // Load
  const { cfg, list } = await readAll();

  // expose for trainer
  window.prefs = cfg.prefs;
  window.gestureMap = cfg.gestureMap;

  // Apply theme
  applyTheme(cfg.theme);
  if (themeSelect) themeSelect.value = cfg.theme;

  // Quick controls (popup replacement)
  await initQuickControls(cfg);

  // Enabled
  if (enabledEl) enabledEl.checked = !!cfg.enabled;

  // Mode
  if (modeBlacklist) modeBlacklist.checked = cfg.mode === "blacklist";
  if (modeWhitelist) modeWhitelist.checked = cfg.mode === "whitelist";

  // List textarea
  if (blacklistBox) blacklistBox.value = (list || []).join("\n");

  // Trail tuning UI
  setRangeValue(minSegmentPx, clamp(cfg.prefs.minSegmentPx, 6, 60));
  setRangeValue(jitterPx, clamp(cfg.prefs.jitterPx, 0, 20));
  setRangeValue(lineWidth, clamp(cfg.prefs.lineWidth, 1, 12));
  if (trailColor) trailColor.value = String(cfg.prefs.trailColor || DEFAULTS.prefs.trailColor);
  setRangeValue(trailAlpha, clamp(cfg.prefs.trailAlpha, 0.05, 1));

  // Gesture map UI
  renderMapGrid(mapGrid, cfg.gestureMap);

  // Trainer
  initTrainer();

  // Theme
  themeSelect?.addEventListener("change", async () => {
    cfg.theme = themeSelect.value;
    applyTheme(cfg.theme);
    await writeCfg(cfg);
    showSaved("Theme saved");
  });

  // Global enable
  enabledEl?.addEventListener("change", async () => {
    cfg.enabled = !!enabledEl.checked;
    await writeCfg(cfg);
    showSaved();
  });

  // Mode toggles
  modeBlacklist?.addEventListener("change", async () => {
    if (!modeBlacklist.checked) return;
    cfg.mode = "blacklist";
    await writeCfg(cfg);
    showSaved();
  });

  modeWhitelist?.addEventListener("change", async () => {
    if (!modeWhitelist.checked) return;
    cfg.mode = "whitelist";
    await writeCfg(cfg);
    showSaved();
  });

  // Save list
  saveBlacklistBtn?.addEventListener("click", async () => {
    const raw = String(blacklistBox?.value || "");
    const next = uniq(
      raw.split("\n")
        .map((s) => normalizeHost(s))
        .filter((s) => isValidHost(s))
    );
    await writeList(next);
    showSaved("List saved");
  });

  // Save tuning
  savePrefs?.addEventListener("click", async () => {
    cfg.prefs = {
      minSegmentPx: clamp(minSegmentPx?.value ?? cfg.prefs.minSegmentPx, 6, 60),
      jitterPx: clamp(jitterPx?.value ?? cfg.prefs.jitterPx, 0, 20),
      lineWidth: clamp(lineWidth?.value ?? cfg.prefs.lineWidth, 1, 12),
      trailColor: String(trailColor?.value || cfg.prefs.trailColor || DEFAULTS.prefs.trailColor),
      trailAlpha: clamp(trailAlpha?.value ?? cfg.prefs.trailAlpha, 0.05, 1)
    };
    await writeCfg(cfg);
    window.prefs = cfg.prefs;
    showSaved("Tuning saved");
  });

  resetPrefs?.addEventListener("click", async () => {
    cfg.prefs = { ...DEFAULTS.prefs };
    await writeCfg(cfg);

    window.prefs = cfg.prefs;

    setRangeValue(minSegmentPx, cfg.prefs.minSegmentPx);
    setRangeValue(jitterPx, cfg.prefs.jitterPx);
    setRangeValue(lineWidth, cfg.prefs.lineWidth);
    if (trailColor) trailColor.value = cfg.prefs.trailColor;
    setRangeValue(trailAlpha, cfg.prefs.trailAlpha);

    showSaved("Reset");
  });

  // Save mappings
  saveMap?.addEventListener("click", async () => {
    const selects = mapGrid?.querySelectorAll("select[data-pattern]") || [];
    const next = {};
    selects.forEach((sel) => {
      const p = sel.dataset.pattern;
      const v = String(sel.value || "");
      if (p && v) next[p] = v;
    });

    cfg.gestureMap = next;
    await writeCfg(cfg);

    window.gestureMap = { ...DEFAULTS.gestureMap, ...cfg.gestureMap };
    showSaved("Mappings saved");
  });

  // Export / Import
  exportBtn?.addEventListener("click", async () => {
    const { cfg: liveCfg, list: liveList } = await readAll();
    const payload = {
      meta: { app: "Mouse Gestures", schema: 1, exportedAt: new Date().toISOString() },
      cfg: liveCfg,
      list: liveList
    };
    const filename = `mouse-gestures-settings-${new Date().toISOString().slice(0, 10)}.json`;
    await downloadJson(filename, payload);
    showSaved("Exported");
  });

  importBtn?.addEventListener("click", () => importFile?.click());

  importFile?.addEventListener("change", async () => {
    const file = importFile.files && importFile.files[0];
    if (!file) return;

    let data;
    try { data = JSON.parse(await file.text()); }
    catch { showSaved("Bad JSON"); importFile.value = ""; return; }

    const incomingCfg = data?.cfg;
    const incomingList = data?.list;

    if (!incomingCfg || typeof incomingCfg !== "object") {
      showSaved("Missing cfg");
      importFile.value = "";
      return;
    }

    const nextCfg = {
      enabled: typeof incomingCfg.enabled === "boolean" ? incomingCfg.enabled : DEFAULTS.enabled,
      mode: (incomingCfg.mode === "whitelist" || incomingCfg.mode === "blacklist") ? incomingCfg.mode : DEFAULTS.mode,
      theme: (incomingCfg.theme === "light" || incomingCfg.theme === "dim" || incomingCfg.theme === "dark") ? incomingCfg.theme : DEFAULTS.theme,
      prefs: { ...DEFAULTS.prefs, ...(incomingCfg.prefs && typeof incomingCfg.prefs === "object" ? incomingCfg.prefs : {}) },
      gestureMap: (incomingCfg.gestureMap && typeof incomingCfg.gestureMap === "object") ? incomingCfg.gestureMap : {}
    };

    const nextList = Array.isArray(incomingList)
      ? uniq(incomingList.map(normalizeHost).filter(isValidHost))
      : [];

    await chrome.storage.local.set({ [KEYS.cfg]: nextCfg, [KEYS.list]: nextList });

    showSaved("Imported");
    setTimeout(() => location.reload(), 250);
  });
})();
