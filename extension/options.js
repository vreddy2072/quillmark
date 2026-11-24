const DEFAULTS = { tabMode: "tabs", openLinks: true, openLocalFiles: true };

async function render() {
  const s = await chrome.storage.local.get(DEFAULTS);
  for (const r of document.querySelectorAll('input[name="tabMode"]')) r.checked = r.value === s.tabMode;
  document.querySelector('input[name="openLinks"]').checked = s.openLinks;
  document.querySelector('input[name="openLocalFiles"]').checked = s.openLocalFiles;
  const allowed = await chrome.extension.isAllowedFileSchemeAccess();
  document.getElementById("file-access").hidden = allowed || !s.openLocalFiles;
  document.getElementById("file-access-ok").hidden = !allowed || !s.openLocalFiles;
}

document.addEventListener("change", async (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement)) return;
  if (el.name === "tabMode") await chrome.storage.local.set({ tabMode: el.value });
  else if (el.name in DEFAULTS) await chrome.storage.local.set({ [el.name]: el.checked });
  render();
});

document.getElementById("open-extensions").addEventListener("click", () => {
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

document.getElementById("open-app").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
});

// Chrome reloads the extension when file access is switched on, but re-check
// when the page regains focus too.
window.addEventListener("focus", render);
render();
