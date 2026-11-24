import { useCallback, useEffect, useMemo, useState } from "react";
import { Editor, type OpenRequest } from "./Editor";
import { icons } from "./icons";
import { newId } from "./types";
import {
  DEFAULT_SETTINGS,
  isExtension,
  loadSettings,
  nameFromUrl,
  onOpenUrlRequest,
  onSettingsChanged,
  openInNewChromeTabs,
  openSettings,
  takeStashed,
  type Settings,
} from "./platform";

interface Tab {
  id: string;
  initial?: OpenRequest;
  url?: string;
  name: string | null;
  dirty: boolean;
}

const blank = (initial?: OpenRequest, url?: string): Tab => ({
  id: newId(),
  initial,
  url,
  name: initial?.file.name ?? (url ? nameFromUrl(url) : null),
  dirty: false,
});

/** What this page was opened with: ?file=<url> (a PDF link) or ?pending=<id> (a file handed over by another tab). */
const params = new URLSearchParams(location.search);
const startUrl = params.get("file");
const pendingId = params.get("pending");

export function App() {
  const [tabs, setTabs] = useState<Tab[]>(() => [startUrl ? blank(undefined, startUrl) : blank()]);
  const [activeId, setActiveId] = useState(() => tabs[0].id);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(!isExtension);

  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s);
      setSettingsLoaded(true);
    });
    return onSettingsChanged(setSettings);
  }, []);

  // A file handed over from another Quillmark tab replaces the empty first tab.
  useEffect(() => {
    if (!pendingId) return;
    takeStashed(pendingId).then((r) => {
      if (!r) return;
      const t = blank(r);
      setTabs([t]);
      setActiveId(t.id);
    });
    history.replaceState(null, "", location.pathname);
  }, []);

  const single = isExtension && settings.tabMode === "single";

  // History panel: shown or hidden for all tabs, remembered on this computer.
  const [historyOpen, setHistoryOpen] = useState(() => {
    try {
      return localStorage.getItem("quillmark.historyOpen") === "1";
    } catch {
      return false;
    }
  });
  const toggleHistory = useCallback(() => {
    setHistoryOpen((o) => {
      try {
        localStorage.setItem("quillmark.historyOpen", o ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !o;
    });
  }, []);

  // ---- Reordering tabs by dragging -----------------------------------------
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const moveTab = useCallback((id: string, to: number) => {
    setTabs((list) => {
      const from = list.findIndex((t) => t.id === id);
      if (from < 0) return list;
      const next = [...list];
      const [t] = next.splice(from, 1);
      next.splice(to > from ? to - 1 : to, 0, t);
      return next;
    });
  }, []);
  const TAB_MIME = "text/x-quillmark-tab";

  // Ctrl+Shift+PageUp / PageDown moves the current tab left or right.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || (e.key !== "PageUp" && e.key !== "PageDown")) return;
      const i = tabs.findIndex((t) => t.id === activeId);
      const to = e.key === "PageUp" ? i - 1 : i + 2;
      if (i < 0 || to < 0 || to > tabs.length) return;
      e.preventDefault();
      moveTab(activeId, to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs, activeId, moveTab]);

  const addTabs = useCallback((added: Tab[], replaceBlank = false) => {
    if (!added.length) return;
    setTabs((list) => {
      // A link opened from outside replaces a lone empty tab rather than
      // leaving it behind. (Not for files opened from inside a tab: that tab
      // is loading the first of them.)
      const blankOnly = list.length === 1 && !list[0].name && !list[0].initial && !list[0].url && !list[0].dirty;
      const keep = replaceBlank && blankOnly ? [] : list;
      return [...keep, ...added];
    });
    setActiveId(added[added.length - 1].id);
  }, []);

  const openMore = useCallback(
    (list: OpenRequest[]) => {
      if (!list.length) return;
      if (single) openInNewChromeTabs(list);
      else addTabs(list.map((r) => blank(r)));
    },
    [single, addTabs],
  );

  // The background worker sends PDF links here when using Quillmark tabs.
  useEffect(() => onOpenUrlRequest((url) => addTabs([blank(undefined, url)], true)), [addTabs]);

  const newTab = () => {
    const t = blank();
    setTabs((list) => [...list, t]);
    setActiveId(t.id);
  };

  const closeTab = (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.dirty && !window.confirm(`"${tab.name}" has unsaved changes. Close it anyway?`)) return;
    const idx = tabs.findIndex((t) => t.id === id);
    let rest = tabs.filter((t) => t.id !== id);
    if (!rest.length) rest = [blank()];
    setTabs(rest);
    if (id === activeId) setActiveId(rest[Math.min(idx, rest.length - 1)].id);
  };

  // Warn before closing the window or Chrome tab while any document has unsaved edits.
  const anyDirty = tabs.some((t) => t.dirty);
  useEffect(() => {
    if (!anyDirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [anyDirty]);

  // One stable status callback per tab, so editors don't re-run effects.
  const statusFns = useMemo(() => new Map<string, (s: { name: string | null; dirty: boolean }) => void>(), []);
  const statusFor = (id: string) => {
    let fn = statusFns.get(id);
    if (!fn) {
      fn = (s) =>
        setTabs((list) =>
          list.map((t) => (t.id === id && (t.name !== s.name || t.dirty !== s.dirty) ? { ...t, ...s } : t)),
        );
      statusFns.set(id, fn);
    }
    return fn;
  };

  // In "one PDF per Chrome tab" mode the tab bar only appears if this page
  // somehow holds several documents (e.g. the setting changed while open).
  const showTabBar = settingsLoaded && (!single || tabs.length > 1);

  return (
    <div className="shell">
      {showTabBar && (
        <nav className="tabbar" aria-label="Open documents">
          <div className="tabs" role="tablist">
            {tabs.map((t, i) => (
              <div
                key={t.id}
                role="tab"
                aria-selected={t.id === activeId}
                className={`tab ${t.id === activeId ? "active" : ""} ${dragId === t.id ? "dragging" : ""} ${
                  dropAt === i && dragId ? "drop-before" : ""
                } ${dropAt === i + 1 && i === tabs.length - 1 && dragId ? "drop-after" : ""}`}
                title={t.name ? `${t.name} (drag to reorder)` : "New tab"}
                draggable={tabs.length > 1}
                onClick={() => setActiveId(t.id)}
                onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
                onDragStart={(e) => {
                  e.dataTransfer.setData(TAB_MIME, t.id);
                  e.dataTransfer.effectAllowed = "move";
                  setDragId(t.id);
                  setActiveId(t.id);
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(TAB_MIME)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  const r = e.currentTarget.getBoundingClientRect();
                  setDropAt(e.clientX < r.left + r.width / 2 ? i : i + 1);
                }}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData(TAB_MIME);
                  if (!id) return;
                  e.preventDefault();
                  if (dropAt !== null) moveTab(id, dropAt);
                  setDragId(null);
                  setDropAt(null);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDropAt(null);
                }}
              >
                <span className="tab-icon">{icons.file}</span>
                <span className="tab-name">{t.name ?? "New tab"}</span>
                {t.dirty && <span className="tab-dirty" aria-label="Unsaved changes" />}
                <button
                  className="tab-close"
                  aria-label={`Close ${t.name ?? "tab"}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                >
                  {icons.close}
                </button>
              </div>
            ))}
          </div>
          {!single && (
            <button className="tab-new" onClick={newTab} title="New tab" aria-label="New tab">
              {icons.plus}
            </button>
          )}
          {isExtension && (
            <button className="tab-new tab-settings" onClick={openSettings} title="Quillmark settings" aria-label="Quillmark settings">
              {icons.settings}
            </button>
          )}
        </nav>
      )}
      {tabs.map((t) => (
        <Editor
          key={t.id}
          active={t.id === activeId}
          initial={t.initial}
          initialUrl={t.url}
          onStatus={statusFor(t.id)}
          onOpenMore={openMore}
          historyOpen={historyOpen}
          onToggleHistory={toggleHistory}
        />
      ))}
    </div>
  );
}
