// scripts/content.js
// Mouse Gestures - content script (MV3)
// - Right-drag gestures with HUD + comet trail
// - Smart exclusions: don't start gestures over inputs/editors/contenteditable
// - Respects blacklist/whitelist mode + enabled flag from storage
// - Sends actions to service worker when needed

(() => {
  "use strict";

  /***********************
   * Storage keys / defaults
   ***********************/
  const KEYS = {
    cfg: "mg_config_v1",     // { enabled, mode, theme, prefs, gestureMap }
    list: "mg_blacklist_v1"  // array of domains
  };

  const DEFAULTS = {
    enabled: true,
    mode: "blacklist", // "blacklist" | "whitelist"
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

  /***********************
   * Utils
   ***********************/
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function clamp(n, a, b) {
    n = Number(n);
    if (!Number.isFinite(n)) return a;
    return Math.min(b, Math.max(a, n));
  }

  function normalizeHost(host) {
    return String(host || "").trim().toLowerCase();
  }

  function hostMatchesRule(host, rule) {
    host = normalizeHost(host);
    rule = normalizeHost(rule);
    if (!host || !rule) return false;
    return host === rule || host.endsWith("." + rule);
  }

  function domainFromUrl(url) {
    try { return normalizeHost(new URL(url).hostname); } catch { return ""; }
  }

  async function readAll() {
    try {
      const res = await chrome.storage.local.get([KEYS.cfg, KEYS.list]);
      const cfgRaw = res[KEYS.cfg] && typeof res[KEYS.cfg] === "object" ? res[KEYS.cfg] : {};
      const listRaw = Array.isArray(res[KEYS.list]) ? res[KEYS.list] : [];

      const cfg = {
        enabled: typeof cfgRaw.enabled === "boolean" ? cfgRaw.enabled : DEFAULTS.enabled,
        mode: (cfgRaw.mode === "whitelist" || cfgRaw.mode === "blacklist") ? cfgRaw.mode : DEFAULTS.mode,
        prefs: {
          ...DEFAULTS.prefs,
          ...(cfgRaw.prefs && typeof cfgRaw.prefs === "object" ? cfgRaw.prefs : {})
        },
        gestureMap: {
          ...DEFAULTS.gestureMap,
          ...(cfgRaw.gestureMap && typeof cfgRaw.gestureMap === "object" ? cfgRaw.gestureMap : {})
        }
      };

      return { cfg, list: listRaw };
    } catch {
      return { cfg: structuredClone(DEFAULTS), list: [] };
    }
  }

  function isExtensionPageBlocked() {
    const url = location.href || "";
    return (
      url.startsWith("chrome://") ||
      url.startsWith("edge://") ||
      url.startsWith("about:") ||
      url.startsWith("chrome-extension://") ||
      url.startsWith("https://chrome.google.com/webstore") ||
      url.startsWith("https://chromewebstore.google.com")
    );
  }

  /***********************
   * Smart "do not gesture here" detection
   ***********************/
  const EXCLUDE_SELECTORS = [
    "input",
    "textarea",
    "select",
    "[contenteditable='true']",
    "[contenteditable='']",
    "[contenteditable='plaintext-only']",

    // Monaco / VS Code web
    ".monaco-editor",
    ".monaco-workbench",

    // Ace
    ".ace_editor",

    // CodeMirror (5 + 6)
    ".CodeMirror",
    ".cm-editor",

    // common “editor-like” wrappers people use
    "[role='textbox']",
    "[role='combobox']",
    "[role='searchbox']"
  ].join(",");

  function closestEditableOrEditor(el) {
    if (!el || el === document || el === window) return null;

    // Fast path: native form controls
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return el;

    // contenteditable anywhere up the chain
    if (el.isContentEditable) return el;

    // selector-based detection
    try {
      const hit = el.closest(EXCLUDE_SELECTORS);
      if (hit) return hit;
    } catch {
      // ignore
    }

    return null;
  }

  function shouldIgnoreGestureStart(target) {
    const hit = closestEditableOrEditor(target);
    if (!hit) return false;

    // Allow right-drag gestures if user holds Alt (optional override).
    // If you don't want this, set to false always.
    if (gestureState.altOverride && gestureState.altOverrideActive) {
      return false;
    }
    return true;
  }

  /***********************
   * Gesture + trail state
   ***********************/
  const gestureState = {
    ready: false,
    enabled: true,
    mode: "blacklist",
    list: [],
    prefs: structuredClone(DEFAULTS.prefs),
    gestureMap: structuredClone(DEFAULTS.gestureMap),

    // gesture runtime
    tracking: false,
    moved: false,
    points: [],
    pattern: "",
    startTarget: null,

    // right-click context menu suppression
    suppressContextOnce: false,

    // optional override
    altOverride: true,
    altOverrideActive: false,

    // trail canvas
    canvas: null,
    ctx: null,
    raf: 0
  };

  function isAllowedOnThisSite() {
    if (!gestureState.enabled) return false;
    const host = domainFromUrl(location.href);
    const match = gestureState.list.some((rule) => hostMatchesRule(host, rule));
    if (gestureState.mode === "blacklist") return !match;
    return match; // whitelist mode
  }

  /***********************
   * Comet trail (canvas overlay)
   ***********************/
  function ensureCanvas() {
    if (gestureState.canvas && document.documentElement.contains(gestureState.canvas)) return;

    const c = document.createElement("canvas");
    c.id = "mg_trail";
    c.style.position = "fixed";
    c.style.left = "0";
    c.style.top = "0";
    c.style.width = "100vw";
    c.style.height = "100vh";
    c.style.pointerEvents = "none";
    c.style.zIndex = "2147483647";
    c.style.opacity = "1";
    c.style.mixBlendMode = "normal"; // looks good on most
    document.documentElement.appendChild(c);

    const ctx = c.getContext("2d", { alpha: true });
    gestureState.canvas = c;
    gestureState.ctx = ctx;

    resizeCanvas();
  }

  function resizeCanvas() {
    const c = gestureState.canvas;
    if (!c) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    c.width = Math.floor(window.innerWidth * dpr);
    c.height = Math.floor(window.innerHeight * dpr);
    const ctx = gestureState.ctx;
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function clearTrail() {
    const ctx = gestureState.ctx;
    if (!ctx || !gestureState.canvas) return;
    ctx.clearRect(0, 0, gestureState.canvas.width, gestureState.canvas.height);
  }

  // Draw a "comet": thick near cursor, pointy tail, fades out
  function drawComet(points) {
    const ctx = gestureState.ctx;
    if (!ctx || !points || points.length < 2) return;

    const color = String(gestureState.prefs.trailColor || "#00e5ff");
    const baseAlpha = clamp(gestureState.prefs.trailAlpha ?? 0.85, 0.05, 1);
    const lw = clamp(gestureState.prefs.lineWidth ?? 3, 1, 18);

    // We draw segments with decreasing alpha and decreasing width toward the tail
    // Tail is points[0], head is last point.
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    const n = points.length;
    for (let i = 1; i < n; i++) {
      const t = i / (n - 1);       // 0..1
      const alpha = baseAlpha * t; // tail faint, head strong
      const width = Math.max(1, lw * t);

      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;

      ctx.beginPath();
      ctx.moveTo(points[i - 1].x, points[i - 1].y);
      ctx.lineTo(points[i].x, points[i].y);
      ctx.stroke();
    }

    // Pointy "head" tip (small triangle pointing in direction of last segment)
    const a = points[n - 2];
    const b = points[n - 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;

    const tipLen = Math.max(6, lw * 4);
    const tipW = Math.max(4, lw * 2);

    // perpendicular
    const px = -uy;
    const py = ux;

    const tipX = b.x + ux * tipLen;
    const tipY = b.y + uy * tipLen;

    ctx.globalAlpha = baseAlpha;
    ctx.fillStyle = color;

    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(b.x + px * tipW, b.y + py * tipW);
    ctx.lineTo(b.x - px * tipW, b.y - py * tipW);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  function scheduleTrailRender() {
    if (gestureState.raf) return;
    gestureState.raf = requestAnimationFrame(() => {
      gestureState.raf = 0;
      clearTrail();
      drawComet(gestureState.points);
    });
  }

  /***********************
   * Pattern detection
   ***********************/
  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

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

  /***********************
   * Execute actions
   ***********************/
  async function execAction(action, gestureTarget) {
    // Some actions can be done locally; others should go through SW.
    switch (action) {
      case "back":
        history.back();
        return;
      case "forward":
        history.forward();
        return;
      case "top":
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      case "bottom":
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
        return;
      case "reload":
        location.reload();
        return;
      case "new_tab": {
        // If gesture started over a link, open that link in new tab.
        const href = getLinkHref(gestureTarget);
        if (href) {
          window.open(href, "_blank", "noopener,noreferrer");
          return;
        }
        // Otherwise ask SW to open a blank new tab.
        try {
          await chrome.runtime.sendMessage({ type: "MG_OPEN_NEW_TAB" });
        } catch { /* ignore */ }
        return;
      }
      case "close_tab": {
        try {
          await chrome.runtime.sendMessage({ type: "MG_CLOSE_TAB" });
        } catch { /* ignore */ }
        return;
      }
      default:
        return;
    }
  }

  function getLinkHref(target) {
    if (!target) return "";
    try {
      const a = target.closest("a[href]");
      if (!a) return "";
      const href = a.getAttribute("href") || "";
      if (!href) return "";
      // Resolve relative
      const u = new URL(href, location.href);
      return u.href;
    } catch {
      return "";
    }
  }

  /***********************
   * Event handling
   ***********************/
  function pagePointFromMouse(e) {
    return { x: e.clientX, y: e.clientY, t: performance.now() };
  }

  function cancelGesture() {
    gestureState.tracking = false;
    gestureState.moved = false;
    gestureState.points = [];
    gestureState.pattern = "";
    gestureState.startTarget = null;
    gestureState.suppressContextOnce = false;
    clearTrail();
  }

  function startGesture(e) {
    // Only right button gestures (button=2)
    if (e.button !== 2) return;

    // optional override tracking
    gestureState.altOverrideActive = !!e.altKey;

    // If user is right-clicking inside editable/editor areas, do nothing.
    if (shouldIgnoreGestureStart(e.target)) return;

    // If not allowed on this site, do nothing.
    if (!isAllowedOnThisSite()) return;

    gestureState.tracking = true;
    gestureState.moved = false;
    gestureState.points = [pagePointFromMouse(e)];
    gestureState.pattern = "";
    gestureState.startTarget = e.target || null;

    ensureCanvas();
    scheduleTrailRender();

    // prevent immediate context menu on right-down
    // (we'll allow it if they don't move)
    e.preventDefault();
    e.stopPropagation();
  }

  function updateGesture(e) {
    if (!gestureState.tracking) return;

    // If user drifts into an editor/textarea etc, cancel gesture (safe).
    if (closestEditableOrEditor(e.target)) {
      cancelGesture();
      return;
    }

    const p = pagePointFromMouse(e);
    gestureState.points.push(p);

    if (!gestureState.moved) {
      // Consider it "moved" if cursor moved more than tiny threshold
      const first = gestureState.points[0];
      if (dist(first, p) >= 6) {
        gestureState.moved = true;
      }
    }

    // Update pattern
    const minSeg = Number(gestureState.prefs.minSegmentPx ?? DEFAULTS.prefs.minSegmentPx);
    const jitter = Number(gestureState.prefs.jitterPx ?? DEFAULTS.prefs.jitterPx);
    gestureState.pattern = detectPattern(gestureState.points, minSeg, jitter);

    scheduleTrailRender();

    // While dragging, block default selection/drag/context behaviors
    e.preventDefault();
    e.stopPropagation();
  }

  async function endGesture(e) {
    if (!gestureState.tracking) return;

    const pattern = gestureState.pattern || "";
    const action = pattern ? (gestureState.gestureMap?.[pattern] || "") : "";

    // If they moved, suppress context menu
    if (gestureState.moved) {
      gestureState.suppressContextOnce = true;
    } else {
      // no movement -> allow normal context menu
      gestureState.suppressContextOnce = false;
      cancelGesture();
      return;
    }

    // Clear trail immediately
    clearTrail();

    // Execute action if any
    if (action) {
      try {
        await execAction(action, gestureState.startTarget);
      } catch { /* ignore */ }
    }

    // cleanup
    gestureState.tracking = false;
    gestureState.moved = false;
    gestureState.points = [];
    gestureState.pattern = "";
    gestureState.startTarget = null;

    e.preventDefault();
    e.stopPropagation();
  }

  function onContextMenu(e) {
    // If a gesture just happened, suppress this one context menu
    if (gestureState.suppressContextOnce) {
      gestureState.suppressContextOnce = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /***********************
   * Boot / live updates
   ***********************/
  async function refreshConfig() {
    const { cfg, list } = await readAll();
    gestureState.enabled = !!cfg.enabled;
    gestureState.mode = cfg.mode || "blacklist";
    gestureState.prefs = { ...DEFAULTS.prefs, ...(cfg.prefs || {}) };
    gestureState.gestureMap = { ...DEFAULTS.gestureMap, ...(cfg.gestureMap || {}) };
    gestureState.list = Array.isArray(list) ? list : [];
  }

  async function init() {
    if (isExtensionPageBlocked()) return;

    await refreshConfig();

    // Listen for storage changes so Options changes apply instantly
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[KEYS.cfg] || changes[KEYS.list]) {
        refreshConfig().catch(() => {});
      }
    });

    // Track Alt key for optional override UX
    window.addEventListener("keydown", (e) => {
      if (e.key === "Alt") gestureState.altOverrideActive = true;
    }, true);
    window.addEventListener("keyup", (e) => {
      if (e.key === "Alt") gestureState.altOverrideActive = false;
    }, true);

    window.addEventListener("resize", resizeCanvas, { passive: true });

    // Capture phase is important so we can beat page handlers (GitHub etc)
    window.addEventListener("mousedown", startGesture, true);
    window.addEventListener("mousemove", updateGesture, true);
    window.addEventListener("mouseup", endGesture, true);
    window.addEventListener("contextmenu", onContextMenu, true);

    // Prevent dragging images/links while gesturing
    window.addEventListener("dragstart", (e) => {
      if (gestureState.tracking) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    gestureState.ready = true;
  }

  init().catch(() => {});
})();
