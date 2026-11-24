// Quillmark background worker: opens the editor from the toolbar button,
// sends PDF links and local PDFs to it, and adds "Open link in Quillmark".

const APP = chrome.runtime.getURL("index.html");
const DEFAULTS = { tabMode: "tabs", openLinks: true, openLocalFiles: true };

const settings = () => chrome.storage.local.get(DEFAULTS);
const appUrl = (pdfUrl) => (pdfUrl ? `${APP}?file=${encodeURIComponent(pdfUrl)}` : APP);
const isAppUrl = (url) => typeof url === "string" && url.startsWith(APP);

/** A Quillmark tab to reuse in "Quillmark tabs" mode, preferring the given window. */
async function findAppTab(windowId) {
  const all = (await chrome.tabs.query({})).filter((t) => isAppUrl(t.url) || isAppUrl(t.pendingUrl));
  return all.find((t) => t.windowId === windowId) ?? all[0];
}

async function focus(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

/** Ask an open Quillmark tab to open the URL as a new Quillmark tab. */
async function sendToApp(tab, url) {
  try {
    return (await chrome.runtime.sendMessage({ type: "quillmark-open-url", url, tabId: tab.id })) === true;
  } catch {
    return false;
  }
}

// Tabs whose PDF went to an existing Quillmark tab: once the PDF page has
// loaded there, step back to the page the link was on (or close the tab if
// it was opened just for the PDF). Keyed by tab id: { url, at }.
const leaveAfterCommit = new Map();

/**
 * Open a PDF URL in Quillmark.
 * sourceTabId: the tab that is navigating to the PDF (or -1 for a context-menu click).
 */
async function openPdf(url, sourceTabId, sourceWindowId) {
  const s = await settings();
  if (s.tabMode === "tabs") {
    const app = await findAppTab(sourceWindowId);
    if (app && app.id !== sourceTabId && (await sendToApp(app, url))) {
      await focus(app);
      if (sourceTabId >= 0) {
        leaveAfterCommit.set(sourceTabId, { url, at: Date.now() });
        // The PDF page may already have loaded while we were busy (Chrome can
        // report the new URL a little after the commit event), so check again.
        const check = async () => {
          const src = await chrome.tabs.get(sourceTabId).catch(() => null);
          if (src && src.url === url && !src.pendingUrl) leaveTab(sourceTabId, url);
        };
        check();
        for (const ms of [300, 1000, 2500]) setTimeout(check, ms);
      }
      return;
    }
  }
  if (sourceTabId >= 0) await chrome.tabs.update(sourceTabId, { url: appUrl(url) });
  else {
    const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.tabs.create({ url: appUrl(url), ...(current ? { index: current.index + 1, openerTabId: current.id } : {}) });
  }
}

async function leaveTab(tabId, url) {
  const entry = leaveAfterCommit.get(tabId);
  if (!entry || entry.url !== url) return;
  leaveAfterCommit.delete(tabId);
  if (Date.now() - entry.at > 60_000) return;
  try {
    await chrome.tabs.goBack(tabId);
  } catch {
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0 && leaveAfterCommit.has(d.tabId)) leaveTab(d.tabId, d.url);
});

// ---- PDF links on the web ----------------------------------------------------
// Watch page loads (not just URLs ending in .pdf) for a PDF response that
// Chrome would show in its own viewer.
chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.method !== "GET" || d.statusCode < 200 || d.statusCode >= 300) return;
    if (isAppUrl(d.url)) return;
    const header = (name) => d.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
    const type = header("content-type").split(";")[0].trim().toLowerCase();
    const looksPdf =
      type === "application/pdf" ||
      ((type === "application/octet-stream" || type === "binary/octet-stream") && /\.pdf$/i.test(new URL(d.url).pathname));
    if (!looksPdf) return;
    // Downloads stay downloads.
    if (/^\s*attachment/i.test(header("content-disposition"))) return;
    settings().then(async (s) => {
      if (!s.openLinks) return;
      const tab = await chrome.tabs.get(d.tabId).catch(() => null);
      openPdf(d.url, d.tabId, tab?.windowId);
    });
  },
  { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
  ["responseHeaders"],
);

// ---- Local PDFs (file://), e.g. double-clicked in File Explorer ---------------
chrome.webNavigation.onBeforeNavigate.addListener(
  async (d) => {
    if (d.frameId !== 0) return;
    if (!/\.pdf$/i.test(new URL(d.url).pathname)) return;
    const s = await settings();
    if (!s.openLocalFiles) return;
    // Without "Allow access to file URLs" Quillmark couldn't read the file,
    // so leave it to Chrome's viewer.
    if (!(await chrome.extension.isAllowedFileSchemeAccess())) return;
    const tab = await chrome.tabs.get(d.tabId).catch(() => null);
    openPdf(d.url, d.tabId, tab?.windowId);
  },
  { url: [{ schemes: ["file"] }] },
);

// ---- Toolbar button and menus ---------------------------------------------------
chrome.action.onClicked.addListener(async (tab) => {
  const s = await settings();
  if (s.tabMode === "tabs") {
    const app = await findAppTab(tab?.windowId);
    if (app) return focus(app);
  }
  chrome.tabs.create({ url: APP, ...(tab ? { index: tab.index + 1 } : {}) });
});

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.create({ id: "open-link", title: "Open link in Quillmark", contexts: ["link"] });
  chrome.contextMenus.create({ id: "settings", title: "Quillmark settings", contexts: ["action"] });
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "open-link" && info.linkUrl) openPdf(info.linkUrl, -1, tab?.windowId);
  if (info.menuItemId === "settings") chrome.runtime.openOptionsPage();
});
