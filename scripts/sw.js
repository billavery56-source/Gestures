// scripts/sw.js
// Mouse Gestures - service worker (MV3)

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

function clamp(n, a, b) {
  n = Number(n);
  if (!Number.isFinite(n)) return a;
  return Math.min(b, Math.max(a, n));
}

function normalizeHost(host) {
  return String(host || "").trim().toLowerCase();
}

function safeUrl(url) {
  try {
    if (!url) return "";
    const u = new URL(url);
    // allow http(s) and chrome internal new tab fallback
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
    return "";
  } catch {
    return "";
  }
}

async function ensureDefaultsExist() {
  const res = await chrome.storage.local.get([KEYS.cfg, KEYS.list]);

  let cfg = res[KEYS.cfg];
  let list = res[KEYS.list];

  const cfgOk = cfg && typeof cfg === "object";
  const listOk = Array.isArray(list);

  if (!cfgOk) cfg = {};
  if (!listOk) list = [];

  // Merge cfg with defaults
  const merged = {
    enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : DEFAULTS.enabled,
    mode: (cfg.mode === "blacklist" || cfg.mode === "whitelist") ? cfg.mode : DEFAULTS.mode,
    theme: (cfg.theme === "dark" || cfg.theme === "dim" || cfg.theme === "light") ? cfg.theme : DEFAULTS.theme,
    prefs: {
      ...DEFAULTS.prefs,
      ...(cfg.prefs && typeof cfg.prefs === "object" ? cfg.prefs : {})
    },
    gestureMap: {
      ...DEFAULTS.gestureMap,
      ...(cfg.gestureMap && typeof cfg.gestureMap === "object" ? cfg.gestureMap : {})
    }
  };

  // clamp a few prefs just to keep them sane
  merged.prefs.minSegmentPx = clamp(merged.prefs.minSegmentPx, 6, 60);
  merged.prefs.jitterPx = clamp(merged.prefs.jitterPx, 0, 20);
  merged.prefs.lineWidth = clamp(merged.prefs.lineWidth, 1, 12);
  merged.prefs.trailAlpha = clamp(merged.prefs.trailAlpha, 0.05, 1);

  await chrome.storage.local.set({
    [KEYS.cfg]: merged,
    [KEYS.list]: listOk ? list : []
  });
}

async function openOptionsPage() {
  try {
    // Chrome will focus an existing options tab if it exists
    await chrome.runtime.openOptionsPage();
    return true;
  } catch {
    // Fallback: open options.html explicitly
    try {
      const url = chrome.runtime.getURL("options.html");
      await chrome.tabs.create({ url });
      return true;
    } catch {
      return false;
    }
  }
}

async function openNewTab(urlMaybe, active = true) {
  const url = safeUrl(urlMaybe);
  if (url) {
    await chrome.tabs.create({ url, active });
    return;
  }
  // fallback new tab page
  await chrome.tabs.create({ url: "chrome://newtab/", active });
}

async function goBack(tabId) {
  try {
    await chrome.tabs.goBack(tabId);
  } catch {
    // fallback: ask the content page to do it
    try {
      await chrome.tabs.sendMessage(tabId, { type: "MG_PAGE_NAV", nav: "back" });
    } catch {}
  }
}

async function goForward(tabId) {
  try {
    await chrome.tabs.goForward(tabId);
  } catch {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "MG_PAGE_NAV", nav: "forward" });
    } catch {}
  }
}

async function reloadTab(tabId) {
  try {
    await chrome.tabs.reload(tabId);
  } catch {}
}

async function closeTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch {}
}

async function execActionFromMessage(action, sender, href) {
  const tabId = sender?.tab?.id;

  switch (String(action || "")) {
    case "new_tab": {
      // If href is provided (gesture over link), open that. Otherwise open new tab.
      await openNewTab(href, true);
      return;
    }

    case "close_tab": {
      if (tabId != null) await closeTab(tabId);
      return;
    }

    case "reload": {
      if (tabId != null) await reloadTab(tabId);
      return;
    }

    case "back": {
      if (tabId != null) await goBack(tabId);
      return;
    }

    case "forward": {
      if (tabId != null) await goForward(tabId);
      return;
    }

    // These are usually handled in the content script (smooth scroll),
    // but leaving here as no-ops keeps it safe if something sends them.
    case "top":
    case "bottom":
    default:
      return;
  }
}

// On install/update, ensure settings exist
chrome.runtime.onInstalled.addListener(() => {
  ensureDefaultsExist().catch(() => {});
});

// IMPORTANT:
// action.onClicked will NOT fire if your manifest has action.default_popup set.
// If you remove default_popup from manifest.json, this will make toolbar click open Options.
chrome.action?.onClicked?.addListener(() => {
  openOptionsPage().catch(() => {});
});

// Messages from content script / popup / options
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const type = msg?.type;

    if (type === "MG_OPEN_OPTIONS") {
      const ok = await openOptionsPage();
      sendResponse?.({ ok });
      return;
    }

    if (type === "MG_EXEC_ACTION") {
      const action = msg?.action;
      const href = msg?.href || "";
      await execActionFromMessage(action, sender, href);
      sendResponse?.({ ok: true });
      return;
    }

    if (type === "MG_GET_DEFAULTS") {
      sendResponse?.({ ok: true, defaults: DEFAULTS });
      return;
    }

    // Unknown message
    sendResponse?.({ ok: false });
  })().catch(() => {
    try { sendResponse?.({ ok: false }); } catch {}
  });

  // Keep the message channel open for async response
  return true;
});
