// scripts/popup.js

function setStatus(text) {
  const el = document.getElementById("statusText");
  if (!el) return;
  el.textContent = text || "";
  if (text) setTimeout(() => (el.textContent = ""), 1200);
}

document.addEventListener("DOMContentLoaded", () => {
  const openOptionsBtn = document.getElementById("openOptions");

  if (!openOptionsBtn) {
    console.warn("[popup] #openOptions not found");
    return;
  }

  openOptionsBtn.addEventListener("click", async () => {
    try {
      // Preferred MV3 way
      await chrome.runtime.openOptionsPage();
      window.close();
      return;
    } catch (e) {
      console.warn("[popup] openOptionsPage failed, using fallback:", e);
    }

    try {
      // Bulletproof fallback
      const url = chrome.runtime.getURL("options.html");
      await chrome.tabs.create({ url });
      window.close();
      setStatus("Opened options");
    } catch (e) {
      console.error("[popup] fallback tabs.create failed:", e);
      setStatus("Failed to open options");
    }
  });
});
