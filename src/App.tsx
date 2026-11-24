import { useCallback, useMemo, useState } from "react";
import { Editor, type OpenRequest } from "./Editor";
import { icons } from "./icons";
import { newId } from "./types";

interface Tab {
  id: string;
  initial?: OpenRequest;
  name: string | null;
  dirty: boolean;
}

const blank = (initial?: OpenRequest): Tab => ({
  id: newId(),
  initial,
  name: initial?.file.name ?? null,
  dirty: false,
});

export function App() {
  const [tabs, setTabs] = useState<Tab[]>(() => [blank()]);
  const [activeId, setActiveId] = useState(() => tabs[0].id);

  const openMore = useCallback((list: OpenRequest[]) => {
    if (!list.length) return;
    const added = list.map((r) => blank(r));
    setTabs((t) => [...t, ...added]);
    setActiveId(added[added.length - 1].id);
  }, []);

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

  return (
    <div className="shell">
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
        <button className="tab-new" onClick={newTab} title="New tab" aria-label="New tab">
          {icons.plus}
        </button>
      </nav>
      {tabs.map((t) => (
        <Editor key={t.id} active={t.id === activeId} initial={t.initial} onStatus={statusFor(t.id)} onOpenMore={openMore} />
      ))}
    </div>
  );
}
