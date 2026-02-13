// scripts/content.js
// Mouse Gestures - content script (MV3)
// With Option 2: right-drag on a link opens it in new tab, otherwise forward

(() => {
  "use strict";

  const KEYS = {
    cfg: "mg_config_v1",
    list: "mg_blacklist_v1",
    policies: "mg_site_policies_v1"
  };

  const DEFAULTS = {
    enabled: true,
    mode: "blacklist",
    prefs: {
      minSegmentPx: 8,
      jitterPx: 4,
      sampleMinPx: 3,
      movedPx: 3,
      lineWidth: 3,
      trailColor: "#00e5ff",
      trailAlpha: 0.85
    },
    gestureMap: {
      L: "back",
      R: "forward",
      U: "top",
      D: "bottom"
      // Diagonals disabled by default to avoid misfires
    }
  };

  const DEFAULT_POLICIES = {
    "github.com": { behavior: "require_alt" },
    "gist.github.com": { behavior: "require_alt" },
    "docs.google.com": { behavior: "require_alt" },
    "drive.google.com": { behavior: "require_alt" },
    "figma.com": { behavior: "require_alt" }
  };

  function clamp(n, a, b) {
    n = Number(n);
    if (!Number.isFinite(n)) return a;
    return Math.min(b, Math.max(a, n));
  }

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
      const res = await chrome.storage.local.get([KEYS.cfg, KEYS.list, KEYS.policies]);

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

      cfg.prefs.minSegmentPx = clamp(cfg.prefs.minSegmentPx, 6, 60);
      cfg.prefs.jitterPx = clamp(cfg.prefs.jitterPx, 0, 20);
      cfg.prefs.sampleMinPx = clamp(cfg.prefs.sampleMinPx, 0, 10);
      cfg.prefs.movedPx = clamp(cfg.prefs.movedPx, 1, 20);
      cfg.prefs.lineWidth = clamp(cfg.prefs.lineWidth, 1, 18);
      cfg.prefs.trailAlpha = clamp(cfg.prefs.trailAlpha, 0.05, 1);

      const policiesRaw = res[KEYS.policies] && typeof res[KEYS.policies] === "object" ? res[KEYS.policies] : {};
      const policies = { ...DEFAULT_POLICIES, ...(policiesRaw || {}) };

      return { cfg, list: listRaw, policies };
    } catch {
      return { cfg: structuredClone(DEFAULTS), list: [], policies: structuredClone(DEFAULT_POLICIES) };
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

  const EXCLUDE_SELECTORS = [
    "input",
    "textarea",
    "select",
    "[contenteditable='true']",
    "[contenteditable='']",
    "[contenteditable='plaintext-only']",
    ".monaco-editor",
    ".monaco-workbench",
    ".ace_editor",
    ".CodeMirror",
    ".cm-editor",
    "[role='textbox']",
    "[role='combobox']",
    "[role='searchbox']"
  ].join(",");

  function closestEditableOrEditor(el) {
    if (!el || el === document || el === window) return null;

    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return el;
    if (el.isContentEditable) return el;

    try { return el.closest(EXCLUDE_SELECTORS); } catch { return null; }
  }

  const state = {
    enabled: true,
    mode: "blacklist",
    list: [],
    prefs: structuredClone(DEFAULTS.prefs),
    gestureMap: structuredClone(DEFAULTS.gestureMap),
    policies: structuredClone(DEFAULT_POLICIES),

    tracking: false,
    moved: false,
    points: [],
    tokens: [],
    startTarget: null,

    suppressContextOnce: false,

    canvas: null,
    ctx: null,
    raf: 0
  };

  function getSitePolicy(host) {
    host = normalizeHost(host);
    if (!host) return { behavior: "normal" };

    if (state.policies && state.policies[host]) return state.policies[host];

    const parts = host.split(".");
    for (let i = 1; i < parts.length - 1; i++) {
      const candidate = parts.slice(i).join(".");
      if (state.policies && state.policies[candidate]) return state.policies[candidate];
    }
    return { behavior: "normal" };
  }

  function isAllowedOnThisSite() {
    if (!state.enabled) return false;

    const host = domainFromUrl(location.href);
    const policy = getSitePolicy(host);
    if (policy.behavior === "disabled") return false;

    const match = state.list.some((rule) => hostMatchesRule(host, rule));
    return state.mode === "blacklist" ? !match : match;
  }

  function shouldRequireAltHere() {
    const host = domainFromUrl(location.href);
    return getSitePolicy(host).behavior === "require_alt";
  }

  function ensureCanvas() {
    if (state.canvas && document.documentElement.contains(state.canvas)) return;

    const c = document.createElement("canvas");
    c.id = "mg_trail";
    c.style.position = "fixed";
    c.style.left = "0";
    c.style.top = "0";
    c.style.width = "100vw";
    c.style.height = "100vh";
    c.style.pointerEvents = "none";
    c.style.zIndex = "2147483647";
    document.documentElement.appendChild(c);

    state.canvas = c;
    state.ctx = c.getContext("2d", { alpha: true });
    resizeCanvas();
  }

  function resizeCanvas() {
    const c = state.canvas;
    if (!c) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    c.width = Math.floor(window.innerWidth * dpr);
    c.height = Math.floor(window.innerHeight * dpr);
    if (state.ctx) state.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function clearTrail() {
    const ctx = state.ctx;
    const c = state.canvas;
    if (!ctx || !c) return;
    ctx.clearRect(0, 0, c.width, c.height);
  }

  function drawComet(points) {
    const ctx = state.ctx;
    if (!ctx || !points || points.length < 2) return;

    const color = String(state.prefs.trailColor || "#00e5ff");
    const baseAlpha = clamp(state.prefs.trailAlpha ?? 0.85, 0.05, 1);
    const lw = clamp(state.prefs.lineWidth ?? 3, 1, 18);

    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    const n = points.length;
    for (let i = 1; i < n; i++) {
      const t = i / (n - 1);
      ctx.globalAlpha = baseAlpha * t;
      ctx.lineWidth = Math.max(1, lw * t);
      ctx.strokeStyle = color;

      ctx.beginPath();
      ctx.moveTo(points[i - 1].x, points[i - 1].y);
      ctx.lineTo(points[i].x, points[i].y);
      ctx.stroke();
    }

    const a = points[n - 2];
    const b = points[n - 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const px = -uy, py = ux;

    const tipLen = Math.max(6, lw * 4);
    const tipW = Math.max(4, lw * 2);
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
    if (state.raf) return;
    state.raf = requestAnimationFrame(() => {
      state.raf = 0;
      clearTrail();
      drawComet(state.points);
    });
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function dir8(dx, dy, jitter) {
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (adx < jitter && ady < jitter) return "";

    const ang = Math.atan2(dy, dx) * 180 / Math.PI;

    // ±85° tolerance for horizontal to forgive wobble
    if (Math.abs(ang) <= 85 || Math.abs(ang - 180) <= 85 || Math.abs(ang + 180) <= 85) {
      return dx >= 0 ? "R" : "L";
    }

    if (Math.abs(ang - 90) <= 40 || Math.abs(ang + 90) <= 40) {
      return dy >= 0 ? "D" : "U";
    }

    if (Math.abs(ang - 45) <= 30)  return "DR";
    if (Math.abs(ang + 45) <= 30)  return "UR";
    if (Math.abs(ang - 135) <= 30) return "DL";
    if (Math.abs(ang + 135) <= 30) return "UL";

    return "";
  }

  function getLinkHref(target) {
    if (!target) return "";
    try {
      const a = target.closest("a[href]");
      if (!a) return "";
      const href = a.getAttribute("href") || "";
      if (!href) return "";
      return new URL(href, location.href).href;
    } catch {
      return "";
    }
  }

  async function execAction(action, gestureTarget) {
    switch (action) {
      case "back":
        history.back(); return;
      case "forward":
        history.forward(); return;
      case "top":
        window.scrollTo({ top: 0, behavior: "smooth" }); return;
      case "bottom":
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }); return;
      case "reload":
        location.reload(); return;

      case "new_tab": {
        const href = getLinkHref(gestureTarget);
        try {
          await chrome.runtime.sendMessage({ type: "MG_EXEC_ACTION", action: "new_tab", href });
        } catch {
          try { window.open(href || "about:blank", "_blank", "noopener,noreferrer"); } catch {}
        }
        return;
      }

      case "close_tab": {
        try { await chrome.runtime.sendMessage({ type: "MG_EXEC_ACTION", action: "close_tab" }); } catch {}
        return;
      }

      default:
        return;
    }
  }

  function pagePointFromMouse(e) {
    return { x: e.clientX, y: e.clientY, t: performance.now() };
  }

  function cancelGesture() {
    state.tracking = false;
    state.moved = false;
    state.points = [];
    state.tokens = [];
    state.startTarget = null;
    state.suppressContextOnce = false;
    clearTrail();
  }

  function startGesture(e) {
    if (e.button !== 2) return;

    if (shouldRequireAltHere() && !e.altKey) return;
    if (closestEditableOrEditor(e.target)) return;
    if (!isAllowedOnThisSite()) return;

    state.tracking = true;
    state.moved = false;
    state.points = [pagePointFromMouse(e)];
    state.tokens = [];
    state.startTarget = e.target || null;

    ensureCanvas();
    scheduleTrailRender();

    e.preventDefault();
    e.stopPropagation();
  }

  function updateGesture(e) {
    if (!state.tracking) return;

    if (closestEditableOrEditor(e.target)) {
      cancelGesture();
      return;
    }

    const p = pagePointFromMouse(e);

    const last = state.points[state.points.length - 1];
    const minPt = Number(state.prefs.sampleMinPx ?? DEFAULTS.prefs.sampleMinPx);
    if (!last || dist(last, p) >= minPt) state.points.push(p);

    if (!state.moved) {
      const first = state.points[0];
      const movedPx = Number(state.prefs.movedPx ?? DEFAULTS.prefs.movedPx);
      if (dist(first, p) >= movedPx) state.moved = true;
    }

    const minSeg = Number(state.prefs.minSegmentPx ?? DEFAULTS.prefs.minSegmentPx);
    const jitter = Number(state.prefs.jitterPx ?? DEFAULTS.prefs.jitterPx);

    const anchorIndex = state.tokens.length === 0 ? 0 : state._lastTokenIndex;
    const anchor = state.points[anchorIndex] || state.points[0];

    if (dist(anchor, p) >= minSeg) {
      const d = dir8(p.x - anchor.x, p.y - anchor.y, jitter);
      if (d) {
        const lastToken = state.tokens[state.tokens.length - 1] || "";
        if (d !== lastToken) {
          state.tokens.push(d);
        }
        state._lastTokenIndex = state.points.length - 1;
      }
    }

    scheduleTrailRender();

    e.preventDefault();
    e.stopPropagation();
  }

  async function endGesture(e) {
    if (!state.tracking) return;

    clearTrail();

    if (state.moved) {
      state.suppressContextOnce = true;
    } else {
      state.suppressContextOnce = false;
      cancelGesture();
      return;
    }

    const pattern = (state.tokens || []).join("");
    let action = state.gestureMap[pattern] || "";

    // Option 2: if pattern is "R" and started on a link → open link in new tab instead of forward
    if (pattern === "R" && state.startTarget) {
      const linkHref = getLinkHref(state.startTarget);
      if (linkHref) {
        action = "new_tab";
        console.log(`[MG] Link detected on "R" gesture → overriding to new_tab: ${linkHref}`);
      }
    }

    console.log(`[MG] Final pattern: "${pattern}" | Action: "${action || '(none)'}"`);

    if (action) {
      try {
        await execAction(action, state.startTarget);
        console.log(`[MG] Action "${action}" executed`);
      } catch (err) {
        console.error(`[MG] Action "${action}" failed:`, err);
      }
    }

    state.tracking = false;
    state.moved = false;
    state.points = [];
    state.tokens = [];
    state._lastTokenIndex = 0;
    state.startTarget = null;

    e.preventDefault();
    e.stopPropagation();
  }

  function onContextMenu(e) {
    if (state.suppressContextOnce) {
      state.suppressContextOnce = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }

  async function refreshConfig() {
    const { cfg, list, policies } = await readAll();
    state.enabled = !!cfg.enabled;
    state.mode = cfg.mode || "blacklist";
    state.prefs = { ...DEFAULTS.prefs, ...(cfg.prefs || {}) };
    state.gestureMap = { ...DEFAULTS.gestureMap, ...(cfg.gestureMap || {}) };
    state.list = Array.isArray(list) ? list : [];
    state.policies = { ...DEFAULT_POLICIES, ...(policies || {}) };
  }

  async function init() {
    if (isExtensionPageBlocked()) return;

    await refreshConfig();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[KEYS.cfg] || changes[KEYS.list] || changes[KEYS.policies]) {
        refreshConfig().catch(() => {});
      }
    });

    window.addEventListener("resize", resizeCanvas, { passive: true });

    window.addEventListener("mousedown", startGesture, true);
    window.addEventListener("mousemove", updateGesture, true);
    window.addEventListener("mouseup", endGesture, true);
    window.addEventListener("contextmenu", onContextMenu, true);
  }

  init().catch(() => {});
})();