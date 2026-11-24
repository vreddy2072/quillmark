// Recently opened documents, kept in IndexedDB on this computer so they can be
// reopened: by file handle (picker or drag-and-drop), by URL (PDF links in the
// Chrome extension), or from a stored copy when neither is available.

import type { FileHandle } from "./Editor";

export interface HistoryEntry {
  id: string;
  name: string;
  openedAt: number;
  size: number;
  pages: number;
  handle?: FileHandle | null;
  url?: string;
  /** A copy of the file, kept only when there is no handle or URL to reopen it with. */
  blob?: Blob;
}

const DB = "quillmark-history";
const STORE = "entries";
const MAX = 40;
const MAX_COPY = 25 * 1024 * 1024;
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("quillmark-history") : null;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export async function listHistory(): Promise<HistoryEntry[]> {
  try {
    const all = ((await tx<HistoryEntry[]>("readonly", (s) => s.getAll())) ?? []) as HistoryEntry[];
    return all.sort((a, b) => b.openedAt - a.openedAt);
  } catch {
    return [];
  }
}

function changed() {
  window.dispatchEvent(new Event("quillmark-history-changed"));
  channel?.postMessage("changed");
}

export function onHistoryChanged(fn: () => void): () => void {
  window.addEventListener("quillmark-history-changed", fn);
  channel?.addEventListener("message", fn);
  return () => {
    window.removeEventListener("quillmark-history-changed", fn);
    channel?.removeEventListener("message", fn);
  };
}

/** Is this entry the same document as `e`? */
async function same(e: HistoryEntry, name: string, size: number, handle?: FileHandle | null, url?: string) {
  if (url) return e.url === url;
  if (handle && e.handle) {
    try {
      const h = handle as unknown as { isSameEntry?: (o: unknown) => Promise<boolean> };
      if (h.isSameEntry) return await h.isSameEntry(e.handle);
    } catch {
      /* fall through */
    }
  }
  return !e.url && e.name === name && e.size === size;
}

export async function recordOpen(r: { file: File; handle?: FileHandle | null; url?: string; pages: number }) {
  try {
    const list = await listHistory();
    const dupes: string[] = [];
    for (const e of list) if (await same(e, r.file.name, r.file.size, r.handle, r.url)) dupes.push(e.id);
    const entry: HistoryEntry = {
      id: crypto.randomUUID(),
      name: r.file.name,
      openedAt: Date.now(),
      size: r.file.size,
      pages: r.pages,
      handle: r.handle ?? null,
      url: r.url,
      blob: !r.handle && !r.url && r.file.size <= MAX_COPY ? r.file : undefined,
    };
    const extra = list.filter((e) => !dupes.includes(e.id)).slice(MAX - 1).map((e) => e.id);
    await tx("readwrite", (s) => {
      for (const id of [...dupes, ...extra]) s.delete(id);
      s.put(entry);
    });
    changed();
  } catch (e) {
    console.warn("Could not record history", e);
  }
}

export async function removeHistory(id: string) {
  await tx("readwrite", (s) => s.delete(id));
  changed();
}

export async function clearHistory() {
  await tx("readwrite", (s) => s.clear());
  changed();
}

type PermHandle = FileHandle & {
  queryPermission?: (o: { mode: "read" | "readwrite" }) => Promise<string>;
  requestPermission?: (o: { mode: "read" | "readwrite" }) => Promise<string>;
};

/**
 * Get the file back for an entry. Chrome forgets file permissions between
 * sessions, so this may show Chrome's "let Quillmark view this file?" prompt.
 * Returns null for URL entries (the caller downloads those).
 */
export async function reopenFile(e: HistoryEntry): Promise<{ file: File; handle: FileHandle | null } | null> {
  if (e.handle) {
    const h = e.handle as PermHandle;
    let state = (await h.queryPermission?.({ mode: "read" })) ?? "granted";
    if (state !== "granted") state = (await h.requestPermission?.({ mode: "read" })) ?? "denied";
    if (state !== "granted") throw new Error("Permission to open the file was not given.");
    try {
      return { file: await h.getFile(), handle: e.handle };
    } catch {
      throw new Error(`${e.name} wasn't found. It may have been moved, renamed or deleted.`);
    }
  }
  if (e.blob) return { file: new File([e.blob], e.name, { type: "application/pdf" }), handle: null };
  if (e.url) return null;
  throw new Error("Quillmark can't reopen this one by itself. Use Open to pick it again.");
}

export function whenText(t: number): string {
  const d = new Date(t);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  if (days < 7) return `${d.toLocaleDateString([], { weekday: "long" })}, ${time}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: now.getFullYear() === d.getFullYear() ? undefined : "numeric" });
}
