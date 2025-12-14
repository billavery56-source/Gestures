// scripts/content.js
// Mouse Gestures - content script (MV3)
//
// Right mouse button: draw gestures + comet trail
// Left mouse button: LINK SWIPE (hold left on a link, drag right, release -> open link in new tab)
//
// Fixes for left swipe:
// - Use Pointer Events for reliability
// - Prevent native link dragstart as soon as left-drag starts on a link
// - Suppress the ensuing click when swipe triggered
// - Avoid interfering with normal left clicking unless movement qualifies

const KEYS = {
  cfg: "mg_config_v1",
  list: "mg_blacklist_v1"
};

const DEFAULTS = {
  enabled: true,
  mode: "blacklist",
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

// ---------- utilities ----------
function normalizeHost(host) {
  return String(host || "").trim().toLowerCase();
}

function domainFromUrl(url) {
  try { return normalizeHost(new URL(url).hostname); } catch { return ""; }
}

function hostMatchesRule(host, rule) {
  host = normalizeHost(host);
  rule = normalizeHost(rule);
  if (!host || !rule) return false;
  return host === rule || host.endsWith("." + rule);
}

async function readAll() {
  try {
    const res = await chrome.storage.local.get([KEYS.cfg, KEYS.list]);
    const cfgIn = (res[KEYS.cfg] && typeof res[KEYS.cfg] === "object") ? res[KEYS.cfg] : {};
    const listIn = Array.isArray(res[KEYS.list]) ? res[KEYS.list] : [];

    const merged = {
      enabled: typeof cfgIn.enabled === "boolean" ? cfgIn.enabled : DEFAULTS.enabled,
      mode: (cfgIn.mode === "blacklist" || cfgIn.mode === "whitelist") ? cfgIn.mode : DEFAULTS.mode,
      prefs: {
        ...DEFAULTS.prefs,
        ...(cfgIn.prefs && typeof cfgIn.prefs === "object" ? cfgIn.prefs : {})
      },
      gestureMap: {
        ...DEFAULTS.gestureMap,
        ...(cfgIn.gestureMap && typeof cfgIn.gestureMap === "object" ? cfgIn.gestureMap : {})
      }
    };

    return { cfg: merged, list: listIn };
  } catch {
    return { cfg: { ...DEFAULTS }, list: [] };
  }
}

function shouldRunOnThisSite(cfg, list, url) {
  const host = domainFromUrl(url);
  if (!cfg?.enabled) return false;
  if (!host) return true;

  const matched = (list || []).some((rule) => hostMatchesRule(host, rule));
  if (cfg.mode === "whitelist") return matched;
  return !matched; // blacklist mode
}

function clamp(n, a, b) {
  n = Number(n);
  if (!Number.isFinite(n)) return a;
  return Math.min(b, Math.max(a, n));
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  return false;
}

function getLinkHrefUnderPointer(clientX, clientY, target) {
  try {
    // Prefer actual event target chain
    if (target && target.closest) {
      const a = target.closest("a[href]");
      if (a && a.href) return a.href;
    }
    // Fallback: elementFromPoint
    const el = document.elementFromPoint(clientX, clientY);
    if (el && el.closest) {
      const a2 = el.closest("a[href]");
      if (a2 && a2.href) return a2.href;
    }
  } catch {}
  return "";
}

// Normalize 2-step diagonals so UR==RU, DR==RD, etc.
function normalizePattern(pattern) {
  pattern = String(pattern || "").toUpperCase();
  if (!pattern) return "";

  let compact = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if ("LRUD".includes(c) && compact[compact.length - 1] !== c) compact += c;
  }

  if (compact.length === 2) {
    const a = compact[0], b = compact[1];
    const set = a + b;
    if (set === "RU") return "UR";
    if (set === "RD") return "DR";
    if (set === "LU") return "UL";
    if (set === "LD") return "DL";
  }
  return compact;
}

/* =========================
   Trail overlay (comet)
   ========================= */
let overlay = null;
let ctx2d = null;

function ensureOverlay() {
  if (overlay && ctx2d) return;

  overlay = document.createElement("canvas");
  overlay.id = "__mg_trail";
  overlay.style.position = "fixed";
  overlay.style.left = "0";
  overlay.style.top = "0";
  overlay.style.width = "100vw";
  overlay.style.height = "100vh";
  overlay.style.pointerEvents = "none";
  overlay.style.zIndex = "2147483646";

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  overlay.width = Math.floor(window.innerWidth * dpr);
  overlay.height = Math.floor(window.innerHeight * dpr);

  ctx2d = overlay.getContext("2d", { alpha: true });
  if (ctx2d) ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);

  document.documentElement.appendChild(overlay);

  window.addEventListener("resize", () => {
    if (!overlay || !ctx2d) return;
    const dpr2 = Math.max(1, window.devicePixelRatio || 1);
    overlay.width = Math.floor(window.innerWidth * dpr2);
    overlay.height = Math.floor(window.innerHeight * dpr2);
    ctx2d.setTransform(dpr2, 0, 0, dpr2, 0, 0);
  }, { passive: true });
}

function clearOverlay() {
  if (!ctx2d || !overlay) return;
  ctx2d.clearRect(0, 0, overlay.width, overlay.height);
}

function hexToRgb(hex) {
  let h = String(hex || "").trim();
  if (!h.startsWith("#")) return { r: 0, g: 229, b: 255 };
  h = h.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return { r: 0, g: 229, b: 255 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function drawComet(points, colorHex, baseAlpha, baseWidth) {
  if (!ctx2d || !points || points.length < 2) return;

  const rgb = hexToRgb(colorHex);
  const n = points.length;

  clearOverlay();

  ctx2d.save();
  ctx2d.lineJoin = "round";
  ctx2d.lineCap = "round";

  for (let i = 1; i < n; i++) {
    const t = i / (n - 1); // tail->head
    const alpha = baseAlpha * (0.15 + 0.85 * t);
    const width = Math.max(1, baseWidth * (0.35 + 0.65 * t));

    ctx2d.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
    ctx2d.lineWidth = width;
    ctx2d.beginPath();
    ctx2d.moveTo(points[i - 1].x, points[i - 1].y);
    ctx2d.lineTo(points[i].x, points[i].y);
    ctx2d.stroke();
  }

  const head = points[n - 1];
  ctx2d.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${clamp(baseAlpha * 1.05, 0, 1)})`;
  ctx2d.beginPath();
  ctx2d.arc(head.x, head.y, Math.max(1.2, baseWidth * 0.55), 0, Math.PI * 2);
  ctx2d.fill();

  ctx2d.restore();
}

/* =========================
   Gesture detection (4-dir -> normalized diagonals)
   ========================= */
function detectDir(dx, dy, jitter) {
  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (adx < jitter && ady < jitter) return "";
  if (adx >= ady) return dx >= 0 ? "R" : "L";
  return dy >= 0 ? "D" : "U";
}

function detectPattern(points, minSeg, jitter) {
  if (!points || points.length < 2) return "";
  let out = "";
  let last = points[0];
  let acc = 0;

  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    acc += dist(last, p);
    if (acc >= minSeg) {
      const d = detectDir(p.x - last.x, p.y - last.y, jitter);
      if (d && out[out.length - 1] !== d) out += d;
      last = p;
      acc = 0;
    }
  }
  return normalizePattern(out);
}

async function execAction(action, href, meta = {}) {
  action = String(action || "");
  if (!action) return;
  try {
    await chrome.runtime.sendMessage({
      type: "MG_EXEC_ACTION",
      action,
      href: href || "",
      meta: { url: location.href, ...meta }
    });
  } catch {}
}

/* =========================
   Runtime config
   ========================= */
let liveCfg = { ...DEFAULTS };
let liveList = [];
let enabledOnSite = true;

async function refreshConfig() {
  const { cfg, list } = await readAll();
  liveCfg = cfg;
  liveList = list;
  enabledOnSite = shouldRunOnThisSite(liveCfg, liveList, location.href);
}

chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[KEYS.cfg] || changes[KEYS.list]) refreshConfig();
});

/* =========================
   RIGHT-button gestures
   ========================= */
let rightTracking = false;
let rightMoved = false;
let suppressContextMenuOnce = false;

let rightStart = null;
let rightPoints = [];
let rightPattern = "";
let rightHref = "";

const RIGHT_MOVE_THRESHOLD = 8;

function resetRightGesture() {
  rightTracking = false;
  rightMoved = false;
  rightStart = null;
  rightPoints = [];
  rightPattern = "";
  rightHref = "";
  clearOverlay();
}

document.addEventListener("contextmenu", (e) => {
  if (suppressContextMenuOnce) {
    e.preventDefault();
    e.stopPropagation();
    return false;
  }
  return true;
}, true);

document.addEventListener("mousedown", (e) => {
  if (e.button !== 2) return;
  if (!enabledOnSite || !liveCfg?.enabled) return;

  rightTracking = true;
  rightMoved = false;
  suppressContextMenuOnce = false;

  ensureOverlay();
  clearOverlay();

  rightStart = { x: e.clientX, y: e.clientY };
  rightPoints = [rightStart];

  rightHref = getLinkHrefUnderPointer(e.clientX, e.clientY, e.target);
}, true);

document.addEventListener("mousemove", (e) => {
  if (!rightTracking) return;

  const p = { x: e.clientX, y: e.clientY };
  const total = dist(rightStart, p);

  if (!rightMoved && total >= RIGHT_MOVE_THRESHOLD) {
    rightMoved = true;
    suppressContextMenuOnce = true;
  }
  if (!rightMoved) return;

  const href = getLinkHrefUnderPointer(e.clientX, e.clientY, e.target);
  if (href) rightHref = href;

  rightPoints.push(p);

  const prefs = liveCfg?.prefs || DEFAULTS.prefs;
  const minSeg = clamp(prefs.minSegmentPx, 6, 60);
  const jitter = clamp(prefs.jitterPx, 0, 20);

  rightPattern = detectPattern(rightPoints, minSeg, jitter);

  const maxPoints = 140;
  if (rightPoints.length > maxPoints) rightPoints.splice(0, rightPoints.length - maxPoints);

  drawComet(
    rightPoints,
    prefs.trailColor,
    clamp(prefs.trailAlpha, 0.05, 1),
    clamp(prefs.lineWidth, 1, 12)
  );

  e.preventDefault();
  e.stopPropagation();
}, true);

document.addEventListener("mouseup", async (e) => {
  if (!rightTracking) return;
  if (e.button !== 2) return;

  if (!rightMoved) {
    resetRightGesture();
    return;
  }

  suppressContextMenuOnce = true;
  e.preventDefault();
  e.stopPropagation();

  const map = liveCfg?.gestureMap || DEFAULTS.gestureMap;
  const action = map[rightPattern] || "";

  setTimeout(clearOverlay, 120);

  if (action) {
    const useHref = (action === "new_tab") ? rightHref : "";
    await execAction(action, useHref, { pattern: rightPattern, source: "rightGesture" });
  }

  resetRightGesture();
  setTimeout(() => { suppressContextMenuOnce = false; }, 60);
}, true);

/* =========================
   LEFT-button LINK SWIPE (Pointer Events)
   =========================
   Goal:
   - Start on link with left button
   - Drag RIGHT past threshold
   - Release -> open link in new tab
   - Prevent native dragstart + suppress click only when swipe triggers
*/
let leftActive = false;
let leftPointerId = null;
let leftStart = null;
let leftHref = "";
let leftTriggered = false;

const LEFT_THRESHOLD = 26;      // pixels
const LEFT_DOMINANCE = 1.35;    // dx must be >= dy * this
const LEFT_MAX_VERTICAL = 220;  // safety: if user drags a mile vertically, bail

function resetLeftSwipe() {
  leftActive = false;
  leftPointerId = null;
  leftStart = null;
  leftHref = "";
  // don't clear leftTriggered here (we clear it after click suppression)
}

// Block native link drag as soon as left-drag on link begins
document.addEventListener("dragstart", (e) => {
  if (leftActive) {
    e.preventDefault();
    e.stopPropagation();
    return false;
  }
  return true;
}, true);

// Suppress click if swipe triggered (so the page doesn't also navigate)
document.addEventListener("click", (e) => {
  if (leftTriggered) {
    e.preventDefault();
    e.stopPropagation();
    leftTriggered = false;
    return false;
  }
  return true;
}, true);

document.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return; // left only
  if (!enabledOnSite || !liveCfg?.enabled) return;
  if (isTypingTarget(e.target)) return;

  const href = getLinkHrefUnderPointer(e.clientX, e.clientY, e.target);
  if (!href) return; // ONLY links

  leftActive = true;
  leftPointerId = e.pointerId;
  leftStart = { x: e.clientX, y: e.clientY };
  leftHref = href;
  leftTriggered = false;

  // Capture the pointer so we continue receiving events
  try { e.target.setPointerCapture(e.pointerId); } catch {}
}, true);

document.addEventListener("pointermove", (e) => {
  if (!leftActive) return;
  if (leftPointerId !== e.pointerId) return;

  const dx = e.clientX - leftStart.x;
  const dy = e.clientY - leftStart.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  if (ady > LEFT_MAX_VERTICAL) {
    // user is doing something else; bail
    resetLeftSwipe();
    return;
  }

  // Trigger when mostly right and past threshold
  if (!leftTriggered && dx > 0 && adx >= LEFT_THRESHOLD && adx >= ady * LEFT_DOMINANCE) {
    leftTriggered = true;

    // Once triggered, we must stop default behavior (drag/click)
    e.preventDefault();
    e.stopPropagation();
  }

  // While triggered, keep suppressing defaults so the browser doesn't start drag-n-drop
  if (leftTriggered) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

document.addEventListener("pointerup", async (e) => {
  if (!leftActive) return;
  if (leftPointerId !== e.pointerId) return;

  if (leftTriggered && leftHref) {
    e.preventDefault();
    e.stopPropagation();

    await execAction("new_tab", leftHref, { source: "leftLinkSwipe" });

    // Keep leftTriggered true through the click phase, then it gets cleared in click listener
    setTimeout(() => {
      // If click never fired for some reason, still clear it
      leftTriggered = false;
    }, 350);
  }

  resetLeftSwipe();
}, true);

document.addEventListener("pointercancel", (e) => {
  if (!leftActive) return;
  if (leftPointerId !== e.pointerId) return;
  resetLeftSwipe();
}, true);

/* =========================
   Init
   ========================= */
refreshConfig();
