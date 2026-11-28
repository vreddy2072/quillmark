import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { icons } from "./icons";
import { blankPages, openPdf, viewportFor, type OpenedPdf } from "./pdf";
import { PageView, type PageApi, type PendingBlock, type SearchRect } from "./PageView";
import { Sidebar } from "./Sidebar";
import { SignatureDialog, loadSignatures, storeSignatures, type SavedSignature } from "./SignatureDialog";
import { buildEditedPdf } from "./save";
import { extractEditable } from "./editable";
import { findMatches, type Match } from "./search";
import { printPdf } from "./print";
import { rotateAnnotation } from "./geometry";
import { fetchPdf } from "./platform";
import { HistoryPanel } from "./HistoryPanel";
import { recordOpen, reopenFile, type HistoryEntry } from "./history";
import {
  FONTS,
  TEXT_LINE_HEIGHT,
  newId,
  type Annotation,
  type DocState,
  type FieldValue,
  type FontFamily,
  type ImageAnnotation,
  type TextAnnotation,
  type Tool,
} from "./types";

const INK_COLORS = ["#1A1A1A", "#1F3A93", "#D93B3B", "#1F9D55", "#D97757"];
const HIGHLIGHT_COLORS = ["#FFE14D", "#7CE38B", "#7CC7FF", "#FF9ECF", "#FFB561"];
const MARKER_WIDTHS = [1.5, 3, 6];
const HL_WIDTHS = [8, 12, 16];
const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 24, 32, 48];
const MARK_SIZES = [10, 14, 20];
// Zoom buttons step by 25%; any value in this range can be typed in.
const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 4;
const clampZoom = (z: number) => Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100;

export type FileHandle = {
  name: string;
  getFile: () => Promise<File>;
  createWritable: () => Promise<{ write: (d: Blob) => Promise<void>; close: () => Promise<void> }>;
  requestPermission?: (o: { mode: "readwrite" }) => Promise<string>;
};

// File System Access API (Edge/Chrome), typed loosely.
type FsWindow = Window & {
  showOpenFilePicker?: (o: unknown) => Promise<FileHandle[]>;
  showSaveFilePicker?: (o: unknown) => Promise<FileHandle>;
};

interface Loaded {
  name: string;
  bytes: Uint8Array;
  pdf: OpenedPdf;
  handle: FileHandle | null;
  overwriteOk: boolean;
}

type Placing =
  | { kind: "image"; src: string; aspect: number; role: "signature" | "initials" }
  | { kind: "date" }
  | null;

const EMPTY: DocState = { pages: [], annotations: [], fields: {} };
const PDF_TYPES = [{ description: "PDF documents", accept: { "application/pdf": [".pdf"] } }];

/**
 * The last item Quillmark put on the clipboard. Pasting it back keeps its
 * size on the page (a pasted picture from elsewhere comes in at 96 dpi).
 */
let lastCopied: { pw: number; ph: number; w: number; h: number } | null = null;

/** Put a selected text box or image on the system clipboard. */
async function copyAnnotation(a: Annotation): Promise<boolean> {
  try {
    if (a.kind === "text") {
      await navigator.clipboard.writeText(a.text);
      return true;
    }
    if (a.kind !== "image") return false;
    const img = new Image();
    img.src = a.src;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d")!.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
    if (!blob) return false;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    lastCopied = { pw: c.width, ph: c.height, w: a.w, h: a.h };
    return true;
  } catch (e) {
    console.warn("Copy failed", e);
    return false;
  }
}

async function fileToImage(file: File): Promise<{ src: string; w: number; h: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let src: string;
    if (file.type === "image/png" || file.type === "image/jpeg") {
      src = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result as string);
        r.onerror = rej;
        r.readAsDataURL(file);
      });
    } else {
      // GIF, WebP, BMP, SVG...: convert to PNG so it can go into the PDF.
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d")!.drawImage(img, 0, 0);
      src = c.toDataURL("image/png");
    }
    return { src, w: img.naturalWidth, h: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function today() {
  return new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
}

export interface OpenRequest {
  file: File;
  handle: FileHandle | null;
  /** Where the file was downloaded from (PDF links, file:// URLs). */
  url?: string;
}

export interface EditorProps {
  active: boolean;
  initial?: OpenRequest;
  /** A PDF link or file:// URL to download and open (Chrome extension). */
  initialUrl?: string;
  onStatus: (s: { name: string | null; dirty: boolean }) => void;
  onOpenMore: (list: OpenRequest[]) => void;
  historyOpen: boolean;
  onToggleHistory: () => void;
}

const SIG_EVENT = "quillmark-signatures-changed";

export function Editor({ active, initial, initialUrl, onStatus, onOpenMore, historyOpen, onToggleHistory }: EditorProps) {
  const [file, setFile] = useState<Loaded | null>(null);
  const [doc, setDoc] = useState<DocState>(EMPTY);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(INK_COLORS[0]);
  const [highlightColor, setHighlightColor] = useState(HIGHLIGHT_COLORS[0]);
  const [highlightWidth, setHighlightWidth] = useState(HL_WIDTHS[1]);
  const [markerWidth, setMarkerWidth] = useState(MARKER_WIDTHS[1]);
  const [fontSize, setFontSize] = useState(11);
  const [font, setFont] = useState<FontFamily>("helvetica");
  const [bold, setBold] = useState(false);
  const [markSize, setMarkSize] = useState(MARK_SIZES[0]);
  const [zoom, setZoom] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingBlock, setPendingBlock] = useState<PendingBlock | null>(null);
  const pendingRef = useRef<PendingBlock | null>(null);
  pendingRef.current = pendingBlock;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [sidebar, setSidebar] = useState(true);
  const [placing, setPlacing] = useState<Placing>(null);
  const [signatures, setSignatures] = useState<SavedSignature[]>(() => loadSignatures());
  const [sigDialog, setSigDialog] = useState<"signature" | "initials" | null>(null);
  const [signMenu, setSignMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [matchIdx, setMatchIdx] = useState(0);
  const [, setHistTick] = useState(0);

  const past = useRef<DocState[]>([]);
  const future = useRef<DocState[]>([]);
  const docRef = useRef(doc);
  docRef.current = doc;
  const lastField = useRef<{ name: string; t: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pdfInput = useRef<HTMLInputElement>(null);
  const imgInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2800);
  };

  // ---- History -------------------------------------------------------------

  const checkpoint = useCallback(() => {
    past.current.push(docRef.current);
    if (past.current.length > 200) past.current.shift();
    future.current = [];
    lastField.current = null;
    setDirty(true);
    setHistTick((t) => t + 1);
  }, []);

  const commit = useCallback(
    (next: DocState) => {
      checkpoint();
      setDoc(next);
    },
    [checkpoint],
  );

  const commitAnns = useCallback(
    (anns: Annotation[]) => commit({ ...docRef.current, annotations: anns }),
    [commit],
  );

  const restore = (from: React.RefObject<DocState[]>, to: React.RefObject<DocState[]>) => {
    const s = from.current.pop();
    if (!s) return;
    to.current.push(docRef.current);
    setDoc(s);
    setSelectedId(null);
    setEditingId(null);
    setDirty(true);
    lastField.current = null;
    setHistTick((t) => t + 1);
  };
  const undo = useCallback(() => restore(past, future), []);
  const redo = useCallback(() => restore(future, past), []);

  const updateLive = useCallback((id: string, patch: Partial<Annotation>) => {
    setDoc((d) => ({
      ...d,
      annotations: d.annotations.map((a) => (a.id === id ? ({ ...a, ...patch } as Annotation) : a)),
    }));
    setDirty(true);
  }, []);

  const finishEdit = useCallback(() => {
    setEditingId((id) => {
      if (id) {
        const a = docRef.current.annotations.find((x) => x.id === id);
        if (a?.kind === "text" && !a.text.trim()) {
          setDoc((d) => ({ ...d, annotations: d.annotations.filter((x) => x.id !== id) }));
          setSelectedId(null);
        }
      }
      return null;
    });
  }, []);

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    commitAnns(docRef.current.annotations.filter((a) => a.id !== selectedId));
    setSelectedId(null);
    setEditingId(null);
  }, [selectedId, commitAnns]);

  const setField = useCallback((name: string, value: FieldValue) => {
    const now = Date.now();
    const lf = lastField.current;
    if (!lf || lf.name !== name || now - lf.t > 1500) {
      past.current.push(docRef.current);
      future.current = [];
      setHistTick((t) => t + 1);
    }
    lastField.current = { name, t: now };
    setDoc((d) => ({ ...d, fields: { ...d.fields, [name]: value } }));
    setDirty(true);
  }, []);

  // ---- Opening -------------------------------------------------------------

  const loadFile = useCallback(
    async (f: File, handle: FileHandle | null = null, url?: string) => {
      setError(null);
      setBusy("Opening…");
      try {
        let bytes = new Uint8Array(await f.arrayBuffer());
        // A PDF saved by Quillmark carries the original and the changes, so
        // they can be edited again instead of being stuck in the page.
        const ex = await extractEditable(bytes);
        if (ex?.kind === "editable") bytes = new Uint8Array(ex.original);
        const pdf = await openPdf(bytes);
        // Blank pages added last time come back too.
        if (ex?.kind === "editable") {
          const blanks = ex.state.pages.filter((p) => p.blank);
          const made = await blankPages(blanks.map((p) => p.blank!));
          blanks.forEach((p, i) => (pdf.pages[p.src] = made[i]));
        }
        file?.pdf.destroy();
        // A tab opened in the background is hidden (width 0), so estimate
        // the viewer width from the window: thumbnails + options rail.
        const avail = (scrollRef.current?.clientWidth || document.documentElement.clientWidth - 240) - 96;
        const maxW = Math.max(...pdf.pages.map((p) => viewportFor(p, 0).width));
        setZoom(Math.round(Math.min(1.5, Math.max(0.5, avail / maxW)) * 100) / 100);
        setFile({ name: f.name, bytes, pdf, handle, overwriteOk: false });
        const restored = ex?.kind === "editable" && ex.state.pages.every((p) => !!pdf.pages[p.src]) ? ex.state : null;
        setDoc(
          restored
            ? { pages: restored.pages, annotations: restored.annotations, fields: { ...pdf.fields, ...restored.fields } }
            : {
                pages: pdf.pages.map((_, i) => ({ id: newId(), src: i, rot: 0 })),
                annotations: [],
                fields: { ...pdf.fields },
              },
        );
        past.current = [];
        future.current = [];
        setSelectedId(null);
        setEditingId(null);
        setDirty(false);
        setCurrentPage(0);
        setMatches([]);
        setPlacing(null);
        setTool("select");
        scrollRef.current?.scrollTo({ top: 0 });
        if (restored?.annotations.length)
          flash(`Your ${restored.annotations.length} change${restored.annotations.length === 1 ? "" : "s"} from last time can still be edited. Click one to select it.`);
        else if (ex?.kind === "changed-elsewhere")
          flash("This PDF was changed in another program after Quillmark saved it, so earlier Quillmark changes are now part of the page.");
        else if (pdf.widgets.length) flash(`This PDF has ${pdf.widgets.length} fillable fields. Click a field to fill it in.`);
        recordOpen({ file: f, handle, url, pages: pdf.pages.length });
      } catch (e) {
        console.error(e);
        setError(
          (e as Error)?.name === "PasswordException"
            ? "This PDF is password protected, which isn't supported yet."
            : "That file couldn't be opened as a PDF.",
        );
      } finally {
        setBusy(null);
      }
    },
    [dirty, file],
  );

  // The first file opens in this tab if it is empty; the rest open in new tabs.
  const openFiles = (list: OpenRequest[]) => {
    if (!list.length) return;
    if (!file && !busy) {
      loadFile(list[0].file, list[0].handle, list[0].url);
      onOpenMore(list.slice(1));
    } else onOpenMore(list);
  };

  const openDialog = async () => {
    const w = window as FsWindow;
    if (w.showOpenFilePicker) {
      try {
        const hs = await w.showOpenFilePicker({ types: PDF_TYPES, multiple: true });
        openFiles(await Promise.all(hs.map(async (h) => ({ file: await h.getFile(), handle: h }))));
      } catch (e) {
        if ((e as Error).name !== "AbortError") console.error(e);
      }
    } else {
      pdfInput.current?.click();
    }
  };

  const openFromHistory = async (e: HistoryEntry) => {
    setError(null);
    try {
      const r = await reopenFile(e);
      if (r) openFiles([r]);
      else if (e.url) {
        setBusy("Downloading…");
        const f = await fetchPdf(e.url);
        setBusy(null);
        openFiles([{ file: f, handle: null, url: e.url }]);
      }
    } catch (err) {
      setBusy(null);
      setError((err as Error)?.message ?? "That document couldn't be opened.");
    }
  };

  // Open the file this tab was created for.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    if (initial) {
      opened.current = true;
      loadFile(initial.file, initial.handle, initial.url);
    } else if (initialUrl) {
      opened.current = true;
      setBusy("Downloading…");
      fetchPdf(initialUrl)
        .then((f) => loadFile(f, null, initialUrl))
        .catch((e) => {
          console.error(e);
          setBusy(null);
          setError(`Couldn't open ${initialUrl}. ${(e as Error)?.message ?? ""}`.trim());
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onStatus({ name: file?.name ?? null, dirty });
  }, [file?.name, dirty, onStatus]);

  // Saved signatures are shared by all tabs.
  useEffect(() => {
    const reload = () => setSignatures(loadSignatures());
    // Other Chrome tabs (extension, one PDF per tab) change localStorage directly.
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key.endsWith(".signatures.v1")) reload();
    };
    window.addEventListener(SIG_EVENT, reload);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(SIG_EVENT, reload);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // ---- Pages ---------------------------------------------------------------

  const pageIndex = (id: string) => docRef.current.pages.findIndex((p) => p.id === id);

  const rotatePage = useCallback(
    (id: string, dir: 1 | -1) => {
      if (!file) return;
      const d = docRef.current;
      const ref = d.pages.find((p) => p.id === id);
      if (!ref) return;
      const vp = viewportFor(file.pdf.pages[ref.src], ref.rot);
      commit({
        ...d,
        pages: d.pages.map((p) => (p.id === id ? { ...p, rot: (p.rot + (dir === 1 ? 90 : 270)) % 360 } : p)),
        annotations: d.annotations.map((a) => (a.pageId === id ? rotateAnnotation(a, vp.width, vp.height, dir) : a)),
      });
    },
    [file, commit],
  );

  const deletePage = useCallback(
    (id: string) => {
      const d = docRef.current;
      if (d.pages.length <= 1) return;
      commit({ ...d, pages: d.pages.filter((p) => p.id !== id), annotations: d.annotations.filter((a) => a.pageId !== id) });
      setSelectedId(null);
      flash("Page deleted. Ctrl+Z brings it back.");
    },
    [commit],
  );

  /** Add a blank page after the given position, the same size as the page there. */
  const insertBlankPage = useCallback(
    async (after: number) => {
      if (!file) return;
      const d = docRef.current;
      const near = d.pages[Math.min(Math.max(after, 0), d.pages.length - 1)];
      const vp = viewportFor(file.pdf.pages[near.src], near.rot);
      const size = { w: Math.round(vp.width * 100) / 100, h: Math.round(vp.height * 100) / 100 };
      const [proxy] = await blankPages([size]);
      const src = file.pdf.pages.length;
      file.pdf.pages.push(proxy);
      const ref = { id: newId(), src, rot: 0, blank: size };
      const cur = docRef.current;
      const pages = [...cur.pages];
      pages.splice(after + 1, 0, ref);
      commit({ ...cur, pages });
      flash("Blank page added. Ctrl+Z removes it.");
      requestAnimationFrame(() => jumpTo(after + 1));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [file, commit],
  );

  const movePage = useCallback(
    (from: number, to: number) => {
      const d = docRef.current;
      const pages = [...d.pages];
      const [p] = pages.splice(from, 1);
      pages.splice(to, 0, p);
      commit({ ...d, pages });
    },
    [commit],
  );

  const jumpTo = (index: number) => {
    const id = docRef.current.pages[index]?.id;
    const el = id && scrollRef.current?.querySelector<HTMLElement>(`[data-page-id="${id}"]`);
    if (el && scrollRef.current) {
      scrollRef.current.scrollTo({ top: el.offsetTop - 24, behavior: "auto" });
      setCurrentPage(index);
    }
  };

  // ---- Images, signatures, stamps ---------------------------------------------

  const currentPageId = () => docRef.current.pages[currentPage]?.id ?? docRef.current.pages[0]?.id;

  const pageSize = (pageId: string) => {
    const ref = docRef.current.pages.find((p) => p.id === pageId)!;
    return viewportFor(file!.pdf.pages[ref.src], ref.rot);
  };

  /** The page under the middle of the viewer right now (worked out fresh, not from the last scroll). */
  const pageInView = () => {
    const sc = scrollRef.current;
    if (!sc) return currentPageId();
    const mid = sc.getBoundingClientRect().top + sc.clientHeight / 2;
    let best: string | null = null;
    let bestDist = Infinity;
    sc.querySelectorAll<HTMLElement>("[data-page-id]").forEach((el) => {
      const r = el.getBoundingClientRect();
      const d = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0;
      if (d < bestDist) {
        bestDist = d;
        best = el.dataset.pageId ?? null;
      }
    });
    return best && docRef.current.pages.some((p) => p.id === best) ? best : currentPageId();
  };

  /** Middle (page units) of the part of the page that is on screen. */
  const visibleMid = (pageId: string) => {
    const vp = pageSize(pageId);
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-page-id="${pageId}"]`);
    const sc = scrollRef.current?.getBoundingClientRect();
    if (!el || !sc) return { x: vp.width / 2, y: vp.height / 2 };
    const r = el.getBoundingClientRect();
    const mid = (lo: number, hi: number, a: number, b: number, size: number) =>
      b <= a ? size / 2 : ((Math.max(lo, a) + Math.min(hi, b)) / 2 - lo) / zoom;
    return {
      x: Math.min(vp.width, Math.max(0, mid(r.left, r.right, sc.left, sc.right, vp.width))),
      y: Math.min(vp.height, Math.max(0, mid(r.top, r.bottom, sc.top, sc.bottom, vp.height))),
    };
  };
  const visibleMidY = (pageId: string) => visibleMid(pageId).y;


  /** Ctrl+V with text on the clipboard: drop it on the page as a text box to drag or edit. */
  const insertText = (raw: string) => {
    if (!file) return;
    const pageId = pageInView();
    const vp = pageSize(pageId);
    const size = fontSize;
    // Wrap long lines so a pasted paragraph fits on the page.
    const maxChars = Math.max(10, Math.floor((vp.width * 0.8) / (size * 0.5)));
    const lines: string[] = [];
    for (const para of raw.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").replace(/\s+$/, "").split("\n")) {
      let line = "";
      for (const word of para.split(" ")) {
        if (line && (line + " " + word).length > maxChars) {
          lines.push(line.trimEnd());
          line = word;
        } else line = line ? `${line} ${word}` : word;
      }
      lines.push(line.trimEnd());
    }
    while (lines.length && !lines[0].trim()) lines.shift();
    if (!lines.length) return;
    const estW = Math.max(...lines.map((l) => l.length)) * size * 0.5;
    const estH = lines.length * size * TEXT_LINE_HEIGHT;
    const t: TextAnnotation = {
      id: newId(),
      pageId,
      kind: "text",
      x: Math.min(Math.max(8, vp.width - estW), Math.max(8, visibleMid(pageId).x - estW / 2)),
      y: Math.min(Math.max(0, vp.height - estH), Math.max(0, visibleMidY(pageId) - estH / 2)),
      text: lines.join("\n"),
      size,
      color,
      font,
      bold,
      rot: 0,
    };
    finishEdit();
    commitAnns([...docRef.current.annotations, t]);
    setPlacing(null);
    setTool("select");
    setSelectedId(t.id);
    flash("Text pasted. Drag to move, double-click to edit.");
  };

  const insertImage = useCallback(
    async (f: File) => {
      if (!file) return;
      try {
        const { src, w, h } = await fileToImage(f);
        const pageId = pageInView();
        const vp = pageSize(pageId);
        // Images come in at 96 dpi, capped to 60% of the page; something
        // copied in Quillmark keeps its size.
        const own = lastCopied && lastCopied.pw === w && lastCopied.ph === h ? lastCopied : null;
        let iw = own ? own.w : (w * 72) / 96;
        let ih = own ? own.h : (h * 72) / 96;
        const s = own ? Math.min(1, vp.width / iw, vp.height / ih) : Math.min(1, (Math.min(vp.width, vp.height) * 0.6) / Math.max(iw, ih));
        iw *= s;
        ih *= s;
        // Centre on the part of the page that's on screen.
        const c = visibleMid(pageId);
        const a: ImageAnnotation = {
          id: newId(),
          pageId,
          kind: "image",
          x: Math.min(vp.width - iw, Math.max(0, c.x - iw / 2)),
          y: Math.min(vp.height - ih, Math.max(0, c.y - ih / 2)),
          w: iw,
          h: ih,
          src,
          rot: 0,
        };
        commitAnns([...docRef.current.annotations, a]);
        setTool("select");
        setSelectedId(a.id);
        flash("Image added. Drag to move, use the corner to resize.");
      } catch (e) {
        console.error(e);
        setError("That image couldn't be read.");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [file, currentPage, zoom, commitAnns],
  );

  const startPlacing = (p: NonNullable<Placing>) => {
    finishEdit();
    setPlacing(p);
    setTool("place");
    setSelectedId(null);
    setSignMenu(false);
  };

  const place = useCallback(
    (pageId: string, x: number, y: number) => {
      if (!placing) return;
      let a: Annotation;
      if (placing.kind === "date") {
        const t: TextAnnotation = {
          id: newId(),
          pageId,
          kind: "text",
          x,
          y: y - (fontSize * TEXT_LINE_HEIGHT) / 2,
          text: today(),
          size: fontSize,
          color,
          font,
          bold,
          rot: 0,
        };
        a = t;
      } else {
        const h = placing.role === "signature" ? 30 : 20;
        const w = h * placing.aspect;
        a = { id: newId(), pageId, kind: "image", x: x - w / 2, y: y - h / 2, w, h, src: placing.src, rot: 0, role: placing.role };
      }
      commitAnns([...docRef.current.annotations, a]);
      setPlacing(null);
      setTool("select");
      setSelectedId(a.id);
    },
    [placing, fontSize, color, font, bold, commitAnns],
  );

  const onSignatureDone = (s: { src: string; aspect: number }, save: boolean) => {
    const kind = sigDialog!;
    if (save) {
      const list = [...signatures.filter((x) => x.kind !== kind || x.src !== s.src), { id: newId(), kind, ...s }];
      setSignatures(list);
      if (!storeSignatures(list)) setError("Couldn't save the signature for next time.");
      window.dispatchEvent(new Event(SIG_EVENT));
    }
    setSigDialog(null);
    startPlacing({ kind: "image", src: s.src, aspect: s.aspect, role: kind });
  };

  const removeSignature = (id: string) => {
    const list = signatures.filter((x) => x.id !== id);
    setSignatures(list);
    storeSignatures(list);
    window.dispatchEvent(new Event(SIG_EVENT));
  };

  // ---- Saving & printing ---------------------------------------------------

  const buildBytes = useCallback(async () => {
    finishEdit();
    // Let a pending text edit flush into state first.
    await new Promise((r) => setTimeout(r, 0));
    return buildEditedPdf(file!.bytes, file!.pdf.pages, docRef.current, file!.pdf.fields);
  }, [file, finishEdit]);

  const writeTo = async (handle: FileHandle, out: Uint8Array) => {
    if (handle.requestPermission && (await handle.requestPermission({ mode: "readwrite" })) !== "granted") {
      throw new Error("Permission to write the file was not given.");
    }
    const ws = await handle.createWritable();
    await ws.write(new Blob([out as BlobPart], { type: "application/pdf" }));
    await ws.close();
  };

  const saveAs = useCallback(async () => {
    if (!file) return;
    setBusy("Saving…");
    setError(null);
    try {
      const out = await buildBytes();
      const suggested = file.name.replace(/\.pdf$/i, "") + (file.name.endsWith("-edited.pdf") ? ".pdf" : "-edited.pdf");
      const w = window as FsWindow;
      if (w.showSaveFilePicker) {
        let handle: FileHandle;
        try {
          handle = await w.showSaveFilePicker({ suggestedName: suggested, types: PDF_TYPES });
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
          throw e;
        }
        await writeTo(handle, out);
        setFile((f) => (f ? { ...f, handle, name: handle.name, overwriteOk: true } : f));
        recordOpen({ file: new File([out as BlobPart], handle.name, { type: "application/pdf" }), handle, pages: docRef.current.pages.length });
        flash(`Saved as ${handle.name}`);
      } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([out as BlobPart], { type: "application/pdf" }));
        a.download = suggested;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        flash("Saved");
      }
      setDirty(false);
    } catch (e) {
      console.error(e);
      setError("Saving failed: " + ((e as Error)?.message ?? "unknown error"));
    } finally {
      setBusy(null);
    }
  }, [file, buildBytes]);

  const save = useCallback(async () => {
    if (!file) return;
    if (!file.handle) return saveAs();
    if (
      !file.overwriteOk &&
      !window.confirm(`Save over "${file.name}"?\n\nYour edits will be merged into this file permanently. Use "Save as" to keep the original.`)
    )
      return;
    setBusy("Saving…");
    setError(null);
    try {
      const out = await buildBytes();
      await writeTo(file.handle, out);
      setFile((f) => (f ? { ...f, overwriteOk: true } : f));
      setDirty(false);
      flash(`Saved ${file.name}`);
    } catch (e) {
      console.error(e);
      setError("Saving failed: " + ((e as Error)?.message ?? "unknown error"));
    } finally {
      setBusy(null);
    }
  }, [file, buildBytes, saveAs]);

  const print = useCallback(async () => {
    if (!file) return;
    setBusy("Preparing to print…");
    setError(null);
    try {
      const out = await buildBytes();
      await printPdf(out, (d, t) => setBusy(`Preparing to print… page ${d} of ${t}`));
    } catch (e) {
      console.error(e);
      setError("Printing failed: " + ((e as Error)?.message ?? "unknown error"));
    } finally {
      setBusy(null);
    }
  }, [file, buildBytes]);

  // ---- Search --------------------------------------------------------------

  useEffect(() => {
    if (!file || !searchOpen) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const m = await findMatches(query, doc.pages, file.pdf.pages);
      if (cancelled) return;
      setMatches(m);
      setMatchIdx(0);
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, doc.pages, file, searchOpen]);

  const showMatch = useCallback(
    (i: number) => {
      const m = matches[i];
      if (!m || !scrollRef.current) return;
      const el = scrollRef.current.querySelector<HTMLElement>(`[data-page-id="${m.pageId}"]`);
      if (!el) return;
      const y = el.offsetTop + m.rects[0].y * zoom;
      const sc = scrollRef.current;
      if (y < sc.scrollTop + 40 || y > sc.scrollTop + sc.clientHeight - 80) sc.scrollTo({ top: y - sc.clientHeight / 3 });
    },
    [matches, zoom],
  );

  useEffect(() => {
    if (matches.length) showMatch(matchIdx);
  }, [matchIdx, matches, showMatch]);

  const stepMatch = (dir: 1 | -1) => {
    if (!matches.length) return;
    setMatchIdx((i) => (i + dir + matches.length) % matches.length);
  };

  const searchByPage = useMemo(() => {
    const map = new Map<string, SearchRect[]>();
    if (!searchOpen) return map;
    matches.forEach((m, i) => {
      const list = map.get(m.pageId) ?? [];
      for (const r of m.rects) list.push({ ...r, current: i === matchIdx });
      map.set(m.pageId, list);
    });
    return map;
  }, [matches, matchIdx, searchOpen]);

  const openSearch = () => {
    setSearchOpen(true);
    setTimeout(() => searchInput.current?.select(), 0);
  };

  // ---- Style changes apply to the selection too -----------------------------

  const selected = doc.annotations.find((a) => a.id === selectedId) ?? null;
  // Picking an item ends any text selection, so Ctrl+C copies the item.
  useEffect(() => {
    if (selectedId) window.getSelection()?.removeAllRanges();
  }, [selectedId]);

  const applyToSelected = (patch: Partial<Annotation>, kinds: Annotation["kind"][]) => {
    if (selected && kinds.includes(selected.kind)) {
      commitAnns(docRef.current.annotations.map((a) => (a.id === selected.id ? ({ ...a, ...patch } as Annotation) : a)));
    }
  };

  const selHl = selected?.kind === "ink" && !!selected.hl;
  const pickColor = (c: string) => {
    setColor(c);
    if (!selHl) applyToSelected({ color: c }, ["ink", "text", "mark", "shape"]);
  };
  const pickHighlight = (c: string) => {
    setHighlightColor(c);
    applyToSelected({ color: c }, selHl ? ["ink"] : ["highlight"]);
  };
  const pickWidth = (wd: number) => {
    setMarkerWidth(wd);
    if (!selHl) applyToSelected({ width: wd }, ["ink", "shape"]);
  };
  const pickHlWidth = (wd: number) => {
    setHighlightWidth(wd);
    if (selHl) applyToSelected({ width: wd }, ["ink"]);
  };
  const pickFontSize = (s: number) => {
    setFontSize(s);
    applyToSelected({ size: s }, ["text"]);
  };
  const pickFont = (f: FontFamily) => {
    setFont(f);
    applyToSelected({ font: f }, ["text"]);
  };
  const toggleBold = () => {
    const b = selected?.kind === "text" ? !selected.bold : !bold;
    setBold(b);
    applyToSelected({ bold: b }, ["text"]);
  };
  const pickMarkSize = (s: number) => {
    setMarkSize(s);
    if (selected?.kind === "mark") {
      const c = s - selected.size;
      applyToSelected({ size: s, x: selected.x - c / 2, y: selected.y - c / 2 }, ["mark"]);
    }
  };

  // ---- Select block: act on a marked block ---------------------------------

  /**
   * Only now does the page change: the spot is covered in the page colour,
   * items inside the box go with the block, and (when moved) the block is
   * placed as a picture at its new spot.
   */
  const commitBlock = useCallback(
    (mode: "move" | "cut" | "erase", dx = 0, dy = 0) => {
      const p = pendingRef.current;
      if (!p) return;
      const gone = new Set(p.absorbed);
      const rest = docRef.current.annotations.filter((a) => !gone.has(a.id));
      // The cover goes underneath everything already added, so only the
      // page's own content (and the absorbed items) disappear.
      const moved = mode === "move" ? [{ ...p.block, id: newId(), x: p.block.x + dx, y: p.block.y + dy }] : [];
      commitAnns([p.cover, ...rest, ...moved]);
      setPendingBlock(null);
      if (moved.length) {
        setTool("select");
        setSelectedId(moved[0].id);
        flash("Moved. Drag to adjust; Ctrl+Z puts it back.");
      }
    },
    [commitAnns],
  );

  // Changing tool or document lets go of a marked block.
  useEffect(() => setPendingBlock(null), [tool, file]);

  // ---- Keyboard, paste, drop, unload guard ---------------------------------

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT";
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const pb = pendingRef.current;
      if (pb && !typing && ((mod && (k === "c" || k === "x")) || e.key === "Delete" || e.key === "Backspace" || e.key === "Escape")) {
        e.preventDefault();
        if (e.key === "Escape") setPendingBlock(null);
        else if (e.key === "Delete" || e.key === "Backspace") commitBlock("erase");
        else
          copyAnnotation(pb.block).then((ok) => {
            if (!ok) return setError("Couldn't copy that to the clipboard.");
            if (k === "x") {
              commitBlock("cut");
              flash("Cut. Press Ctrl+V to paste it.");
            } else flash("Copied. Press Ctrl+V to paste a copy; the original stays as it is.");
          });
        return;
      }
      if (mod && k === "o") {
        e.preventDefault();
        openDialog();
      } else if (mod && k === "s") {
        e.preventDefault();
        if (e.shiftKey) saveAs();
        else save();
      } else if (mod && k === "p") {
        e.preventDefault();
        print();
      } else if (mod && k === "f") {
        e.preventDefault();
        if (file) openSearch();
      } else if (typing) {
        return;
      } else if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && (k === "c" || k === "x") && selected && !window.getSelection()?.toString()) {
        // Copy or cut the selected text box or image (e.g. a lifted block).
        if (selected.kind !== "text" && selected.kind !== "image") return;
        e.preventDefault();
        const cut = k === "x";
        const id = selected.id;
        copyAnnotation(selected).then((ok) => {
          if (!ok) {
            setError("Couldn't copy that to the clipboard.");
            return;
          }
          if (cut) {
            commitAnns(docRef.current.annotations.filter((a) => a.id !== id));
            setSelectedId(null);
            flash("Cut. Press Ctrl+V to paste it on the page you're viewing.");
          } else flash("Copied. Press Ctrl+V to paste a copy.");
        });
      } else if (mod && k === "y") {
        e.preventDefault();
        redo();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedId) {
          e.preventDefault();
          deleteSelected();
        }
      } else if (e.key === "Escape") {
        setSelectedId(null);
        setSignMenu(false);
        if (tool === "place") {
          setPlacing(null);
          setTool("select");
        }
      } else if (e.key.startsWith("Arrow") && selected) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        commitAnns(
          docRef.current.annotations.map((a) =>
            a.id !== selected.id
              ? a
              : a.kind === "ink"
                ? { ...a, points: a.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) }
                : a.kind === "shape"
                  ? { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy }
                  : { ...a, x: a.x + dx, y: a.y + dy },
          ),
        );
      } else if (!mod && !e.altKey && file) {
        const map: Record<string, Tool> = { v: "select", t: "text", m: "marker", h: "highlight", w: "whiteout", e: "edittext", b: "area", l: "line", a: "arrow", r: "rect", o: "ellipse", c: "check", x: "cross" };
        if (map[k]) {
          finishEdit();
          setPlacing(null);
          setTool(map[k]);
        } else if (k === "i") imgInput.current?.click();
        else if (k === "s") setSignMenu((o) => !o);
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (!file) return;
      // Text wins when there is any: Word and other apps also put a picture
      // of the copied text on the clipboard.
      const text = e.clipboardData?.getData("text/plain") ?? "";
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith("image/"));
      if (text.trim()) {
        e.preventDefault();
        insertText(text);
      } else if (f) {
        e.preventDefault();
        insertImage(f);
      }
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("beforeunload", onUnload);
    };
  });

  const onDrop = async (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("text/x-quillmark-page")) return;
    e.preventDefault();
    // Handles must be requested while the drop event is still running.
    const items = [...(e.dataTransfer.items ?? [])] as (DataTransferItem & { getAsFileSystemHandle?: () => Promise<unknown> })[];
    const handlePromises = items.map((it) => (it.kind === "file" ? it.getAsFileSystemHandle?.() : undefined));
    const files = [...e.dataTransfer.files];
    const pdfs: OpenRequest[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
        let handle: FileHandle | null = null;
        try {
          const h = (await handlePromises[i]) as FileHandle | undefined;
          if (h && "createWritable" in h) handle = h;
        } catch {
          handle = null;
        }
        pdfs.push({ file: f, handle });
      }
    }
    if (pdfs.length) openFiles(pdfs);
    else {
      const img = files.find((f) => f.type.startsWith("image/"));
      if (img) insertImage(img);
    }
  };

  // Track which page is most visible.
  const onScroll = () => {
    const sc = scrollRef.current;
    if (!sc || !file) return;
    const mid = sc.getBoundingClientRect().top + sc.clientHeight / 2;
    let best = 0;
    let bestDist = Infinity;
    sc.querySelectorAll<HTMLElement>("[data-page-id]").forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const d = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    setCurrentPage(best);
  };

  // Zooming keeps the spot in the middle of the viewer where it was: note
  // which page (and where on it) is in the middle now, and scroll back to it
  // once the pages have their new size.
  const zoomAnchor = useRef<{ pageId: string; fx: number; fy: number } | null>(null);
  const zoomTo = (z: number) => {
    const next = clampZoom(z);
    if (next === zoom) return;
    const sc = scrollRef.current;
    const pageId = file ? pageInView() : null;
    const el = pageId ? sc?.querySelector<HTMLElement>(`[data-page-id="${pageId}"]`) : null;
    if (sc && el && pageId) {
      const v = sc.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const cx = v.left + sc.clientWidth / 2;
      const cy = v.top + sc.clientHeight / 2;
      zoomAnchor.current = {
        pageId,
        fx: Math.min(1, Math.max(0, (cx - r.left) / r.width)),
        fy: Math.min(1, Math.max(0, (cy - r.top) / r.height)),
      };
    }
    setZoom(next);
  };
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    zoomAnchor.current = null;
    const sc = scrollRef.current;
    const el = a && sc?.querySelector<HTMLElement>(`[data-page-id="${a.pageId}"]`);
    if (!a || !sc || !el) return;
    const v = sc.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    sc.scrollTop += r.top + a.fy * r.height - (v.top + sc.clientHeight / 2);
    sc.scrollLeft += r.left + a.fx * r.width - (v.left + sc.clientWidth / 2);
  }, [zoom]);

  // From a fitted value like 137%, the first step lands on 150% or 125%.
  const changeZoom = (dir: 1 | -1) => {
    const steps = zoom / ZOOM_STEP;
    const next = dir > 0 ? (Math.floor(steps + 1e-6) + 1) * ZOOM_STEP : (Math.ceil(steps - 1e-6) - 1) * ZOOM_STEP;
    zoomTo(next < ZOOM_MIN ? ZOOM_MIN : next);
  };

  const api: PageApi = useMemo(
    () => ({
      tool,
      zoom,
      color,
      markerWidth,
      highlightColor,
      highlightWidth,
      fontSize,
      font,
      bold,
      markSize,
      selectedId,
      editingId,
      create: (a, opts) => {
        commitAnns([...docRef.current.annotations, a]);
        if (opts?.edit) {
          setEditingId(a.id);
          setSelectedId(a.id);
        }
      },
      renderBlock: async (pageId, r, include, scale) => {
        // Draw exactly what saving would produce for this page (the page plus
        // the given items), then cut out the box.
        const ref = docRef.current.pages.find((p) => p.id === pageId);
        if (!file || !ref) return null;
        const bytes = await buildEditedPdf(
          file.bytes,
          file.pdf.pages,
          { pages: [ref], annotations: include, fields: docRef.current.fields },
          file.pdf.fields,
        );
        const tmp = await openPdf(bytes);
        try {
          const page = tmp.pages[0];
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(r.w * scale));
          canvas.height = Math.max(1, Math.round(r.h * scale));
          await page.render({
            canvas,
            viewport: page.getViewport({ scale }),
            transform: [1, 0, 0, 1, -r.x * scale, -r.y * scale],
          }).promise;
          return canvas;
        } finally {
          tmp.destroy();
        }
      },
      pending: pendingBlock,
      offerBlock: (p) => {
        finishEdit();
        setSelectedId(null);
        setPendingBlock(p);
        flash("Block selected. Drag it to move, Ctrl+C to copy, Ctrl+X to cut, Delete to erase. Click elsewhere or Esc to let go.");
      },
      commitBlock,
      clearPending: () => setPendingBlock(null),
      createMany: (list, editId) => {
        commitAnns([...docRef.current.annotations, ...list]);
        if (editId) {
          setEditingId(editId);
          setSelectedId(editId);
        }
      },
      place,
      checkpoint,
      updateLive,
      select: setSelectedId,
      startEdit: (id) => {
        checkpoint();
        setSelectedId(id);
        setEditingId(id);
      },
      finishEdit,
      setField,
    }),
    [tool, zoom, color, markerWidth, highlightColor, highlightWidth, fontSize, font, bold, markSize, selectedId, editingId, commitAnns, place, checkpoint, updateLive, finishEdit, setField, file, pendingBlock, commitBlock],
  );

  useEffect(() => {
    if (active) document.title = file ? `${dirty ? "• " : ""}${file.name} · Quillmark` : "Quillmark";
  }, [file, dirty, active]);

  const toolBtn = (t: Tool, label: string, key: string, icon: React.ReactNode) => (
    <button
      className={`tool ${tool === t ? "active" : ""}`}
      onClick={() => {
        finishEdit();
        setPlacing(null);
        setTool(t);
        if (t !== "select") setSelectedId(null);
      }}
      disabled={!file}
      title={`${label} (${key})`}
      aria-label={label}
      aria-pressed={tool === t}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  const sk = selected?.kind;
  const shapeTool = tool === "line" || tool === "arrow" || tool === "rect" || tool === "ellipse";
  const showInk = ["marker", "text", "check", "cross", "whiteout"].includes(tool) || shapeTool || (sk === "ink" && !selHl) || sk === "text" || sk === "mark" || sk === "shape";
  const showWidth = tool === "marker" || shapeTool || (sk === "ink" && !selHl) || sk === "shape";
  const showFont = tool === "text" || tool === "whiteout" || sk === "text" || (tool === "place" && placing?.kind === "date");
  const showHl = tool === "highlight" || sk === "highlight" || selHl;
  const showMark = tool === "check" || tool === "cross" || sk === "mark";
  const curColor = sk === "ink" || sk === "text" || sk === "mark" || sk === "shape" ? (selected as { color: string }).color : color;
  const curFont = sk === "text" ? (selected as TextAnnotation).font : font;
  const curSize = sk === "text" ? (selected as TextAnnotation).size : fontSize;
  const curBold = sk === "text" ? (selected as TextAnnotation).bold : bold;

  let hint = "";
  if (tool === "place") hint = placing?.kind === "date" ? "Click where the date should go. Esc to cancel." : `Click where the ${placing?.kind === "image" ? placing.role : ""} should go. Esc to cancel.`;
  else if (tool === "highlight") hint = "Drag along a line of text. Hold Shift for a straight line.";
  else if (shapeTool) hint = tool === "line" || tool === "arrow" ? "Drag to draw. Hold Shift for straight or 45° lines." : `Drag to draw. Hold Shift for a ${tool === "rect" ? "square" : "circle"}.`;
  else if (tool === "area") hint = "Drag a box around part of the page to pick it up. Then drag it to move it, or press Ctrl+X to cut it.";
  else if (tool === "edittext") hint = "Click a line of the document's text to retype it. The old words are covered over.";
  else if (tool === "whiteout") hint = "Drag over anything to cover it, like correction tape. Double-click a covered area to type new text.";
  else if (tool === "check" || tool === "cross") hint = "Click a box to mark it.";

  const sigs = signatures.filter((s) => s.kind === "signature");
  const inits = signatures.filter((s) => s.kind === "initials");

  return (
    <div className="app" style={active ? undefined : { display: "none" }} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="topbar">
        <div className="brand">
          <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={20} height={20} />
          <span className="file-name" title={file?.name ?? "Quillmark"}>
            {file ? file.name : "Quillmark"}
          </span>
          {dirty && <span className="dirty-dot" title="Unsaved changes" aria-label="Unsaved changes" />}
          <span className="vsep" />
          <button className={`icon sm ${historyOpen ? "on" : ""}`} onClick={onToggleHistory} title="Show or hide history" aria-label="History" aria-pressed={historyOpen}>
            {icons.history}
          </button>
        </div>

        <div className="tools" role="toolbar" aria-label="Tools">
          {toolBtn("select", "Select", "V", icons.select)}
          {toolBtn("text", "Text", "T", icons.text)}
          {toolBtn("marker", "Marker", "M", icons.marker)}
          {toolBtn("highlight", "Highlight", "H", icons.highlight)}
          {toolBtn("whiteout", "Whiteout", "W", icons.whiteout)}
          {toolBtn("edittext", "Edit PDF text", "E", icons.editText)}
          {toolBtn("area", "Select block", "B", icons.area)}
          <span className="tool-sep" />
          {toolBtn("line", "Line", "L", icons.line)}
          {toolBtn("arrow", "Arrow", "A", icons.arrow)}
          {toolBtn("rect", "Rectangle", "R", icons.rect)}
          {toolBtn("ellipse", "Ellipse / circle", "O", icons.ellipse)}
          <span className="tool-sep" />
          {toolBtn("check", "Check", "C", icons.check)}
          {toolBtn("cross", "Cross", "X", icons.cross)}
          <div className="menu-wrap">
            <button
              className={`tool ${tool === "place" || signMenu ? "active" : ""}`}
              onClick={() => setSignMenu((o) => !o)}
              disabled={!file}
              title="Sign, initial or date (S)"
              aria-label="Sign"
              aria-expanded={signMenu}
            >
              {icons.sign}
              <span>Sign</span>
            </button>
            {signMenu && (
              <div className="menu" role="menu" onPointerDown={(e) => e.stopPropagation()}>
                <div className="menu-label">Signature</div>
                {sigs.map((s) => (
                  <div key={s.id} className="menu-sig">
                    <button className="menu-sig-btn" onClick={() => startPlacing({ kind: "image", src: s.src, aspect: s.aspect, role: "signature" })} aria-label="Place saved signature">
                      <img src={s.src} alt="Saved signature" />
                    </button>
                    <button className="mini" onClick={() => removeSignature(s.id)} title="Forget this signature" aria-label="Forget this signature">
                      {icons.close}
                    </button>
                  </div>
                ))}
                <button className="menu-item" onClick={() => { setSignMenu(false); setSigDialog("signature"); }}>
                  {icons.plus} New signature
                </button>
                <div className="menu-label">Initials</div>
                {inits.map((s) => (
                  <div key={s.id} className="menu-sig">
                    <button className="menu-sig-btn" onClick={() => startPlacing({ kind: "image", src: s.src, aspect: s.aspect, role: "initials" })} aria-label="Place saved initials">
                      <img src={s.src} alt="Saved initials" />
                    </button>
                    <button className="mini" onClick={() => removeSignature(s.id)} title="Forget these initials" aria-label="Forget these initials">
                      {icons.close}
                    </button>
                  </div>
                ))}
                <button className="menu-item" onClick={() => { setSignMenu(false); setSigDialog("initials"); }}>
                  {icons.plus} New initials
                </button>
                <div className="menu-sep" />
                <button className="menu-item" onClick={() => startPlacing({ kind: "date" })}>
                  {icons.calendar} Date ({today()})
                </button>
              </div>
            )}
          </div>
          <button className="tool" onClick={() => imgInput.current?.click()} disabled={!file} title="Add image (I)" aria-label="Image">
            {icons.image}
            <span>Image</span>
          </button>
        </div>

        <div className="actions">
          {file && (
            <>
                  {searchOpen ? (
                    <div className="searchbox">
                      {icons.search}
                      <input
                        ref={searchInput}
                        value={query}
                        placeholder="Find in document"
                        aria-label="Find in document"
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") stepMatch(e.shiftKey ? -1 : 1);
                          else if (e.key === "Escape") {
                            setSearchOpen(false);
                            setQuery("");
                            setMatches([]);
                          }
                          e.stopPropagation();
                        }}
                      />
                      <span className="search-count">{query.trim() ? (matches.length ? `${matchIdx + 1} of ${matches.length}` : "No results") : ""}</span>
                      <button className="mini" onClick={() => stepMatch(-1)} disabled={!matches.length} aria-label="Previous match">
                        {icons.up}
                      </button>
                      <button className="mini" onClick={() => stepMatch(1)} disabled={!matches.length} aria-label="Next match">
                        {icons.down}
                      </button>
                      <button
                        className="mini"
                        onClick={() => {
                          setSearchOpen(false);
                          setQuery("");
                          setMatches([]);
                        }}
                        aria-label="Close search"
                      >
                        {icons.close}
                      </button>
                    </div>
                  ) : (
                    <button className="icon" onClick={openSearch} title="Find (Ctrl+F)" aria-label="Find in document">
                      {icons.search}
                    </button>
                  )}
              <span className="vsep" />
            </>
          )}
          <button className="icon sm" onClick={openDialog} title="Open PDF (Ctrl+O)" aria-label="Open PDF">
            {icons.open}
          </button>
          <button className="icon sm" onClick={print} disabled={!file || !!busy} title="Print (Ctrl+P)" aria-label="Print">
            {icons.print}
          </button>
          <div className="split">
            <button
              className="primary"
              onClick={save}
              disabled={!file || !!busy}
              title={file?.handle ? `Save over ${file.name} (Ctrl+S)` : "Save (Ctrl+S)"}
            >
              {icons.save}
              <span>Save</span>
            </button>
            <button className="primary split-right" onClick={saveAs} disabled={!file || !!busy} title="Save as a new file (Ctrl+Shift+S)" aria-label="Save as">
              {icons.saveAs}
            </button>
          </div>
        </div>
      </header>

      <div className="body">
        {historyOpen && <HistoryPanel onOpen={openFromHistory} onClose={onToggleHistory} currentName={file?.name} />}
        {file && sidebar && (
          <Sidebar
            pages={doc.pages}
            pdfPages={file.pdf.pages}
            current={currentPage}
            onJump={jumpTo}
            onRotate={rotatePage}
            onDelete={deletePage}
            onMove={movePage}
            onInsertBlank={insertBlankPage}
          />
        )}
        <div className="viewer-wrap">
          <main className="viewer" ref={scrollRef} onScroll={onScroll} onPointerDown={() => setSignMenu(false)}>
            {!file ? (
              <div className="empty">
                <div className="empty-card">
                  <div className="empty-icon">{icons.file}</div>
                  <h1>Open a PDF to start editing</h1>
                  <p>Fill in, sign, add text, check boxes, highlight, white out and rearrange pages. Save merges your edits into the PDF.</p>
                  <button className="primary big" onClick={openDialog}>
                    {icons.open}
                    <span>Open PDF</span>
                  </button>
                  <p className="drop-hint">or drop a PDF file anywhere in this window</p>
                </div>
              </div>
            ) : (
              <div className="pages">
                {doc.pages.map((p) => (
                  <PageView
                    key={p.id}
                    pdfPage={file.pdf.pages[p.src]}
                    pageRef={p}
                    annotations={doc.annotations.filter((a) => a.pageId === p.id)}
                    widgets={file.pdf.widgets.filter((wd) => wd.src === p.src)}
                    fields={doc.fields}
                    search={searchByPage.get(p.id) ?? []}
                    api={api}
                  />
                ))}
              </div>
            )}
          </main>
          {file && hint && <div className="hint-chip">{hint}</div>}
        </div>
        {file && (
          <aside className="rail" aria-label="Edit options">
            <button className={`icon ${sidebar ? "on" : ""}`} onClick={() => setSidebar((s) => !s)} title="Show or hide pages" aria-label="Toggle page thumbnails">
              {icons.sidebar}
            </button>
            <span className="hsep" />
            <button className="icon" onClick={undo} disabled={!past.current.length} title="Undo (Ctrl+Z)" aria-label="Undo">
              {icons.undo}
            </button>
            <button className="icon" onClick={redo} disabled={!future.current.length} title="Redo (Ctrl+Y)" aria-label="Redo">
              {icons.redo}
            </button>
            <button className="icon" onClick={deleteSelected} disabled={!selectedId} title="Delete selected (Del)" aria-label="Delete selected">
              {icons.trash}
            </button>
            <div className="rail-options">
          {showInk && (
            <div className="opt">
              <span className="label">Colour</span>
              {INK_COLORS.map((c) => (
                <button key={c} className={`swatch ${curColor === c ? "on" : ""}`} style={{ background: c }} onClick={() => pickColor(c)} aria-label={`Colour ${c}`} />
              ))}
            </div>
          )}
          {showWidth && (
            <div className="opt">
              <span className="label">Size</span>
              {MARKER_WIDTHS.map((wd) => (
                <button
                  key={wd}
                  className={`chip ${(sk === "ink" || sk === "shape" ? (selected as { width: number }).width : markerWidth) === wd ? "on" : ""}`}
                  onClick={() => pickWidth(wd)}
                  aria-label={`Marker size ${wd}`}
                >
                  <span className="dot" style={{ width: wd * 2 + 2, height: wd * 2 + 2 }} />
                </button>
              ))}
            </div>
          )}
          {showFont && (
            <div className="opt">
              <span className="label">Text</span>
              <select value={curFont} onChange={(e) => pickFont(e.target.value as FontFamily)} aria-label="Font">
                {(Object.keys(FONTS) as FontFamily[]).map((f) => (
                  <option key={f} value={f}>
                    {FONTS[f].label}
                  </option>
                ))}
              </select>
              <select value={curSize} onChange={(e) => pickFontSize(Number(e.target.value))} aria-label="Font size">
                {[...new Set([...FONT_SIZES, curSize])].sort((a, b) => a - b).map((s) => (
                  <option key={s} value={s}>
                    {s} pt
                  </option>
                ))}
              </select>
              <button className={`chip bold ${curBold ? "on" : ""}`} onClick={toggleBold} aria-label="Bold" aria-pressed={curBold} title="Bold">
                B
              </button>
            </div>
          )}
          {showHl && (
            <div className="opt">
              <span className="label">Highlight</span>
              {HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c}
                  className={`swatch ${(sk === "highlight" || selHl ? (selected as { color: string }).color : highlightColor) === c ? "on" : ""}`}
                  style={{ background: c }}
                  onClick={() => pickHighlight(c)}
                  aria-label={`Highlight colour ${c}`}
                />
              ))}
            </div>
          )}
          {(tool === "highlight" || selHl) && (
            <div className="opt">
              <span className="label">Width</span>
              {HL_WIDTHS.map((wd) => (
                <button
                  key={wd}
                  className={`chip ${(selHl ? (selected as { width: number }).width : highlightWidth) === wd ? "on" : ""}`}
                  onClick={() => pickHlWidth(wd)}
                  aria-label={`Highlighter width ${wd}`}
                >
                  <span className="hl-bar" style={{ height: wd * 0.75, background: highlightColor }} />
                </button>
              ))}
            </div>
          )}
          {showMark && (
            <div className="opt">
              <span className="label">Mark size</span>
              {MARK_SIZES.map((s) => (
                <button
                  key={s}
                  className={`chip ${(sk === "mark" ? (selected as { size: number }).size : markSize) === s ? "on" : ""}`}
                  onClick={() => pickMarkSize(s)}
                  aria-label={`Mark size ${s}`}
                >
                  <span className="mark-dot" style={{ fontSize: s * 0.9 }}>✓</span>
                </button>
              ))}
            </div>
          )}
            </div>
            <div className="rail-foot">
              <span className="page-ind" title="Current page">
                {Math.min(currentPage + 1, doc.pages.length)}
                <span className="of">of {doc.pages.length}</span>
              </span>
              <span className="hsep" />
              <button className="icon" onClick={() => changeZoom(1)} title="Zoom in" aria-label="Zoom in">
                {icons.zoomIn}
              </button>
              <ZoomInput zoom={zoom} onZoom={zoomTo} />
              <button className="icon" onClick={() => changeZoom(-1)} title="Zoom out" aria-label="Zoom out">
                {icons.zoomOut}
              </button>
            </div>
          </aside>
        )}
      </div>

      {sigDialog && <SignatureDialog kind={sigDialog} onDone={onSignatureDone} onCancel={() => setSigDialog(null)} />}

      {(busy || toast || error) && (
        <div className={`toast ${error ? "error" : ""}`} role="status" onClick={() => setError(null)}>
          {error ?? busy ?? toast}
        </div>
      )}

      <input
        ref={pdfInput}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={(e) => {
          openFiles([...(e.target.files ?? [])].map((f) => ({ file: f, handle: null })));
          e.target.value = "";
        }}
      />
      <input
        ref={imgInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) insertImage(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** The zoom percentage in the rail. Click it, type a number and press Enter. */
function ZoomInput({ zoom, onZoom }: { zoom: number; onZoom: (z: number) => void }) {
  const shown = `${Math.round(zoom * 100)}%`;
  const [text, setText] = useState<string | null>(null);
  const cancelled = useRef(false);
  const justFocused = useRef(false);
  const apply = () => {
    if (text !== null && !cancelled.current) {
      const n = parseFloat(text.replace("%", "").trim());
      if (Number.isFinite(n) && n > 0) onZoom(n / 100);
    }
    cancelled.current = false;
    setText(null);
  };
  return (
    <input
      className="zoom-input"
      value={text ?? shown}
      inputMode="numeric"
      aria-label="Zoom percentage"
      title={`Zoom: type ${Math.round(ZOOM_MIN * 100)}–${Math.round(ZOOM_MAX * 100)} and press Enter`}
      onFocus={(e) => {
        justFocused.current = true;
        e.target.select();
      }}
      onMouseUp={(e) => {
        // Keep the whole value selected after a click, so typing replaces it.
        if (justFocused.current) e.preventDefault();
        justFocused.current = false;
      }}
      onChange={(e) => setText(e.target.value.replace(/[^0-9.%]/g, "").slice(0, 5))}
      onBlur={apply}
      onKeyDown={(e) => {
        const el = e.target as HTMLInputElement;
        if (e.key === "Enter") el.blur();
        else if (e.key === "Escape") {
          cancelled.current = true;
          el.blur();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const n = parseFloat((text ?? shown).replace("%", "")) || zoom * 100;
          setText(`${Math.round(n + (e.key === "ArrowUp" ? 5 : -5))}%`);
        }
      }}
    />
  );
}
