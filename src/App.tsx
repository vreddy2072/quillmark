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

  const addTabs = useCallback((added: Tab[]) => {
    if (!added.length) return;
    setTabs((list) => {
      // Replace a lone empty tab rather than leaving it behind.
      const keep = list.length === 1 && !list[0].name && !list[0].initial && !list[0].url && !list[0].dirty ? [] : list;
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
  useEffect(() => onOpenUrlRequest((url) => addTabs([blank(undefined, url)])), [addTabs]);

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
            {tabs.map((t) => (
              <div
                key={t.id}
                role="tab"
                aria-selected={t.id === activeId}
                className={`tab ${t.id === activeId ? "active" : ""}`}
                title={t.name ?? "New tab"}
                onClick={() => setActiveId(t.id)}
                onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
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
        />
      ))}
    </div>
  );
}
