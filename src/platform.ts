// Things that differ between the desktop app (served by server.mjs) and the
// Chrome extension (served from chrome-extension://<id>/).

import type { OpenRequest } from "./Editor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const chrome: any;

export const isExtension = typeof chrome !== "undefined" && !!chrome?.runtime?.id;

export type TabMode = "tabs" | "single";

export interface Settings {
  /** "tabs": Quillmark's own tabs inside one Chrome tab. "single": one PDF per Chrome tab. */
  tabMode: TabMode;
  /** Open PDF links clicked on the web in Quillmark instead of Chrome's viewer. */
  openLinks: boolean;
  /** Open local PDFs (file:// URLs, e.g. double-clicked in File Explorer) in Quillmark. */
  openLocalFiles: boolean;
}

export const DEFAULT_SETTINGS: Settings = { tabMode: "tabs", openLinks: true, openLocalFiles: true };

export async function loadSettings(): Promise<Settings> {
  if (!isExtension) return DEFAULT_SETTINGS;
  try {
    return { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(DEFAULT_SETTINGS)) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function onSettingsChanged(fn: (s: Settings) => void): () => void {
  if (!isExtension) return () => {};
  const listener = () => loadSettings().then(fn);
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export function openSettings() {
  if (isExtension) chrome.runtime.openOptionsPage();
}

// ---- Opening PDFs from URLs -------------------------------------------------

function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    if (last) return /\.pdf$/i.test(last) ? last : `${last}.pdf`;
    return `${u.hostname || "document"}.pdf`;
  } catch {
    return "document.pdf";
  }
}

function nameFromDisposition(cd: string | null): string | null {
  if (!cd) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*("?)([^";]+)\1/.exec(cd);
  return plain ? plain[2].trim() : null;
}

function readFileUrl(url: string): Promise<ArrayBuffer> {
  // fetch() does not support file:// URLs; XHR does when the extension is
  // allowed to access file URLs.
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("GET", url);
    x.responseType = "arraybuffer";
    x.onload = () => (x.response ? resolve(x.response) : reject(new Error("The file is empty.")));
    x.onerror = () =>
      reject(new Error('Chrome blocked reading this local file. Turn on "Allow access to file URLs" for Quillmark in chrome://extensions.'));
    x.send();
  });
}

/** Download a PDF the user opened from a link or a local file:// URL. */
export async function fetchPdf(url: string): Promise<File> {
  let name = nameFromUrl(url);
  let buf: ArrayBuffer;
  if (url.startsWith("file:")) buf = await readFileUrl(url);
  else {
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) throw new Error(`The website answered ${r.status} ${r.statusText}`.trim() + ".");
    name = nameFromDisposition(r.headers.get("content-disposition")) ?? name;
    buf = await r.arrayBuffer();
  }
  if (!/\.pdf$/i.test(name)) name += ".pdf";
  return new File([buf], name, { type: "application/pdf" });
}

export { nameFromUrl };

// ---- Handing files to another Chrome tab ------------------------------------
// In "one PDF per Chrome tab" mode, extra files are passed to new tabs through
// IndexedDB. File objects and file handles can both be stored there, so the new
// tab can still save over the original.

const DB = "quillmark-handoff";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("files");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function stashForTab(r: OpenRequest): Promise<string> {
  const id = crypto.randomUUID();
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction("files", "readwrite");
    tx.objectStore("files").put({ file: r.file, handle: r.handle, at: Date.now() }, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  d.close();
  return id;
}

export async function takeStashed(id: string): Promise<OpenRequest | null> {
  const d = await db();
  const rec = await new Promise<{ file: File; handle: OpenRequest["handle"] } | undefined>((resolve, reject) => {
    const tx = d.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    const get = store.get(id);
    get.onsuccess = () => {
      store.delete(id);
      resolve(get.result);
    };
    tx.onerror = () => reject(tx.error);
  });
  d.close();
  return rec ? { file: rec.file, handle: rec.handle ?? null } : null;
}

/** Open each request in its own new Chrome tab, right after this one. */
export async function openInNewChromeTabs(list: OpenRequest[]) {
  const me = await chrome.tabs.getCurrent();
  let index = (me?.index ?? 0) + 1;
  for (let i = 0; i < list.length; i++) {
    const id = await stashForTab(list[i]);
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`index.html?pending=${id}`),
      index: index++,
      active: i === list.length - 1,
      ...(me ? { windowId: me.windowId, openerTabId: me.id } : {}),
    });
  }
}

/** Messages from the background worker asking this Quillmark tab to open a URL. */
export function onOpenUrlRequest(fn: (url: string) => void): () => void {
  if (!isExtension) return () => {};
  let myTab: number | undefined;
  chrome.tabs.getCurrent().then((t: { id?: number } | undefined) => (myTab = t?.id));
  const listener = (msg: { type?: string; url?: string; tabId?: number }, _sender: unknown, reply: (ok: boolean) => void) => {
    if (msg?.type !== "quillmark-open-url" || !msg.url || msg.tabId !== myTab) return;
    fn(msg.url);
    reply(true);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
