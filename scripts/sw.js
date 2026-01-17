// scripts/sw.js
// Mouse Gestures - service worker (MV3)

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const type = msg?.type;

    if (type === "MG_EXEC_ACTION") {
      const action = String(msg?.action || "");
      const href = String(msg?.href || "");

      if (action === "new_tab") {
        // open link href if present, else a new tab
        const url = (() => {
          try {
            if (!href) return "";
            const u = new URL(href);
            return (u.protocol === "http:" || u.protocol === "https:") ? u.toString() : "";
          } catch {
            return "";
          }
        })();

        if (url) {
          await chrome.tabs.create({ url, active: true });
        } else {
          await chrome.tabs.create({ url: "chrome://newtab/", active: true });
        }

        sendResponse({ ok: true });
        return;
      }

      if (action === "close_tab") {
        const tabId = sender?.tab?.id;
        if (tabId != null) {
          try { await chrome.tabs.remove(tabId); } catch {}
        }
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: true });
      return;
    }

    // Back-compat (harmless)
    if (type === "MG_OPEN_NEW_TAB") {
      await chrome.tabs.create({ url: "chrome://newtab/", active: true });
      sendResponse({ ok: true });
      return;
    }
    if (type === "MG_CLOSE_TAB") {
      const tabId = sender?.tab?.id;
      if (tabId != null) {
        try { await chrome.tabs.remove(tabId); } catch {}
      }
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false });
  })().catch(() => {
    try { sendResponse({ ok: false }); } catch {}
  });

  return true;
});
