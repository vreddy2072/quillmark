import { useEffect, useState } from "react";
import { icons } from "./icons";
import { clearHistory, listHistory, onHistoryChanged, removeHistory, whenText, type HistoryEntry } from "./history";

interface Props {
  onOpen: (e: HistoryEntry) => void;
  onClose: () => void;
  currentName?: string | null;
}

function source(e: HistoryEntry) {
  if (e.url?.startsWith("file:")) return "From your computer";
  if (e.url) {
    try {
      return new URL(e.url).hostname;
    } catch {
      return "From a link";
    }
  }
  return e.pages ? `${e.pages} page${e.pages === 1 ? "" : "s"}` : "";
}

export function HistoryPanel({ onOpen, onClose, currentName }: Props) {
  const [items, setItems] = useState<HistoryEntry[] | null>(null);

  useEffect(() => {
    const load = () => listHistory().then(setItems);
    load();
    return onHistoryChanged(load);
  }, []);

  return (
    <aside className="history" aria-label="History">
      <div className="history-head">
        <span className="history-title">History</span>
        {!!items?.length && (
          <button
            className="link-btn"
            onClick={() => {
              if (window.confirm("Clear the list of recently opened documents? The files themselves are not touched.")) clearHistory();
            }}
          >
            Clear
          </button>
        )}
        <button className="mini" onClick={onClose} title="Hide history" aria-label="Hide history">
          {icons.close}
        </button>
      </div>
      <div className="history-list">
        {items && !items.length && <p className="history-empty">Documents you open will be listed here.</p>}
        {items?.map((e) => (
          <div key={e.id} className={`history-item ${e.name === currentName ? "current" : ""}`}>
            <button className="history-open" onClick={() => onOpen(e)} title={e.url ?? e.name}>
              <span className="history-icon">{icons.file}</span>
              <span className="history-text">
                <span className="history-name">{e.name}</span>
                <span className="history-meta">
                  {whenText(e.openedAt)}
                  {source(e) ? ` · ${source(e)}` : ""}
                </span>
              </span>
            </button>
            <button className="mini history-remove" onClick={() => removeHistory(e.id)} title="Remove from history" aria-label={`Remove ${e.name} from history`}>
              {icons.close}
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
