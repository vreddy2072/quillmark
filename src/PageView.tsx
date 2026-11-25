import { memo, useEffect, useRef, useState } from "react";
import { pdfjs, toViewRect, viewportFor, type PDFPageProxy, type Widget } from "./pdf";
import { inkBounds, rotatePoint, smoothPath } from "./geometry";
import {
  FONTS,
  HIGHLIGHT_OPACITY,
  MARK_PATHS,
  TEXT_LINE_HEIGHT,
  newId,
  type Annotation,
  type FieldValue,
  type PageRef,
  type Point,
  type TextAnnotation,
  type Tool,
} from "./types";

export interface SearchRect {
  x: number;
  y: number;
  w: number;
  h: number;
  current: boolean;
}

export interface PageApi {
  tool: Tool;
  zoom: number;
  color: string;
  markerWidth: number;
  highlightColor: string;
  highlightWidth: number;
  fontSize: number;
  font: TextAnnotation["font"];
  bold: boolean;
  markSize: number;
  selectedId: string | null;
  editingId: string | null;
  create: (a: Annotation, opts?: { edit?: boolean; keepTool?: boolean }) => void;
  createMany: (list: Annotation[], editId?: string) => void;
  /** Block select: cover the area and add the lifted copy as a movable image. */
  lift: (cover: Annotation, block: Annotation) => void;
  place: (pageId: string, x: number, y: number) => void;
  checkpoint: () => void;
  updateLive: (id: string, patch: Partial<Annotation>) => void;
  select: (id: string | null) => void;
  startEdit: (id: string) => void;
  finishEdit: () => void;
  setField: (name: string, value: FieldValue) => void;
}

interface Props {
  pdfPage: PDFPageProxy;
  pageRef: PageRef;
  annotations: Annotation[];
  widgets: Widget[];
  fields: Record<string, FieldValue>;
  search: SearchRect[];
  api: PageApi;
}

type Draft =
  | { kind: "ink"; points: Point[]; hl: boolean }
  | { kind: "highlight" | "whiteout" | "area"; x0: number; y0: number; x1: number; y1: number }
  | null;

interface CursorSpec {
  svg: string;
  size: number;
  hx: number;
  hy: number;
}

/** A pen cursor whose tip (the hotspot, bottom-left) shows the ink colour. */
function penCursor(color: string): CursorSpec {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
<g stroke-linejoin="round" stroke-linecap="round">
<path d="M22.2 4.2L19.8 1.8L4.8 16.8L2 22L7.2 19.2z" fill="#ffffff" stroke="#ffffff" stroke-width="2.4"/>
<path d="M22.2 4.2L19.8 1.8L4.8 16.8L7.2 19.2z" fill="#FBFAF7" stroke="#1A1A1A" stroke-width="1"/>
<path d="M18.4 3.2L20.8 5.6" stroke="#1A1A1A" stroke-width="1"/>
<path d="M4.8 16.8L2 22L7.2 19.2z" fill="#E8E6E0" stroke="#1A1A1A" stroke-width="1"/>
<path d="M2 22L3.3 19.7L4.3 20.7z" fill="${color}" stroke="${color}" stroke-width="0.8"/>
</g></svg>`;
  return { svg, size: 24, hx: 2, hy: 22 };
}

/** A highlighter with a flat chisel tip; the hotspot is the middle of the tip. */
function highlighterCursor(color: string): CursorSpec {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
<g stroke-linejoin="round">
<path d="M25.6 7.6L20.4 2.4L7.4 15.4L2.2 20.6L7.4 25.8L12.6 20.6z" fill="#ffffff" stroke="#ffffff" stroke-width="2.6"/>
<path d="M25.6 7.6L20.4 2.4L10.6 12.2L15.8 17.4z" fill="#FBFAF7" stroke="#1A1A1A" stroke-width="1"/>
<path d="M18.6 4.2L23.8 9.4" stroke="#1A1A1A" stroke-width="1"/>
<path d="M10.6 12.2L15.8 17.4L12.6 20.6L7.4 15.4z" fill="#E8E6E0" stroke="#1A1A1A" stroke-width="1"/>
<path d="M7.4 15.4L12.6 20.6L7.4 25.8L2.2 20.6z" fill="${color}" stroke="#1A1A1A" stroke-width="1"/>
</g></svg>`;
  return { svg, size: 28, hx: 4, hy: 23 };
}

function svgCursor({ svg, hx, hy }: CursorSpec) {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hx} ${hy}, crosshair`;
}

/*
 * Chromium on Windows often drops SVG cursors on high-DPI screens and falls
 * back to the crosshair, so the cursor is also drawn to PNGs (1x and the
 * screen's pixel ratio). The SVG cursor is used until the PNGs are ready.
 */
const pngCursors = new Map<string, Promise<string>>();

function pngCursor(spec: CursorSpec): Promise<string> {
  const key = spec.svg;
  let p = pngCursors.get(key);
  if (!p) {
    p = new Promise<string>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const draw = (scale: number) => {
          const c = document.createElement("canvas");
          c.width = c.height = Math.round(spec.size * scale);
          c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
          return c.toDataURL("image/png");
        };
        const dpr = Math.min(4, Math.max(1, window.devicePixelRatio || 1));
        const one = draw(1);
        const { hx, hy } = spec;
        const set =
          dpr > 1 ? `image-set(url("${one}") 1x, url("${draw(dpr)}") ${dpr}x) ${hx} ${hy}, ` : "";
        resolve(`${set}url("${one}") ${hx} ${hy}, crosshair`);
      };
      img.onerror = reject;
      img.src = `data:image/svg+xml,${encodeURIComponent(spec.svg)}`;
    });
    pngCursors.set(key, p);
  }
  return p;
}

function useToolCursor(spec: CursorSpec | null) {
  const key = spec?.svg ?? "";
  const [png, setPng] = useState<{ key: string; css: string } | null>(null);
  useEffect(() => {
    if (!spec) return;
    let live = true;
    pngCursor(spec).then(
      (css) => live && setPng({ key: spec.svg, css }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [key]); // the spec object is rebuilt each render; its SVG is the identity
  if (!spec) return undefined;
  return png?.key === key ? png.css : svgCursor(spec);
}

/** Local (unrotated) size of a selectable item, used for resize handles. */
function localBox(a: Annotation, el: HTMLElement | null, zoom = 1) {
  switch (a.kind) {
    case "image":
    case "highlight":
    case "whiteout":
      return { x: a.x, y: a.y, w: a.w, h: a.h };
    case "mark":
      return { x: a.x, y: a.y, w: a.size, h: a.size };
    case "ink":
      return inkBounds(a.points, a.width / 2 + 3);
    case "text":
      return { x: a.x, y: a.y, w: el ? el.offsetWidth / zoom : 0, h: el ? el.offsetHeight / zoom : 0 };
  }
}

export const PageView = memo(function PageView({ pdfPage, pageRef, annotations, widgets, fields, search, api }: Props) {
  const { zoom, tool } = api;
  const vp = viewportFor(pdfPage, pageRef.rot);
  const w = vp.width;
  const h = vp.height;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const textEls = useRef(new Map<string, HTMLElement>());
  const [visible, setVisible] = useState(false);
  const [draft, setDraft] = useState<Draft>(null);
  const cursor = useToolCursor(
    tool === "marker"
      ? penCursor(api.color)
      : tool === "highlight"
        ? highlighterCursor(api.highlightColor)
        : null,
  );

  // Render only pages near the viewport.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: "800px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const dpr = window.devicePixelRatio || 1;
    const rvp = viewportFor(pdfPage, pageRef.rot, zoom * dpr);
    const off = document.createElement("canvas");
    off.width = Math.floor(rvp.width);
    off.height = Math.floor(rvp.height);
    // Form fields are drawn as live inputs on top, so leave them off the canvas.
    const task = pdfPage.render({
      canvas: off,
      viewport: rvp,
      annotationMode: widgets.length ? pdfjs.AnnotationMode.ENABLE_FORMS : pdfjs.AnnotationMode.ENABLE,
    });
    task.promise.then(
      () => {
        if (cancelled) return;
        const canvas = canvasRef.current!;
        canvas.width = off.width;
        canvas.height = off.height;
        canvas.getContext("2d")!.drawImage(off, 0, 0);
      },
      () => {},
    );
    return () => {
      cancelled = true;
      task.cancel();
    };
  }, [pdfPage, pageRef.rot, zoom, visible, widgets.length]);

  // Invisible text laid over the page so words can be selected and copied
  // (Ctrl+C) with the Select tool, like in any PDF reader.
  useEffect(() => {
    const div = textLayerRef.current;
    if (!visible || !div) return;
    const layer = new pdfjs.TextLayer({
      textContentSource: pdfPage.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
      container: div,
      viewport: viewportFor(pdfPage, pageRef.rot, zoom),
    });
    const end = document.createElement("div");
    end.className = "endOfContent";
    layer.render().then(
      () => div.append(end),
      () => {},
    );
    return () => {
      layer.cancel();
      div.replaceChildren();
    };
  }, [pdfPage, pageRef.rot, zoom, visible]);

  const toPage = (e: { clientX: number; clientY: number }): Point => {
    const r = wrapRef.current!.getBoundingClientRect();
    return [
      Math.min(w, Math.max(0, (e.clientX - r.left) / zoom)),
      Math.min(h, Math.max(0, (e.clientY - r.top) / zoom)),
    ];
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const [x, y] = toPage(e);
    if (tool === "marker" || tool === "highlight") {
      (e.target as Element).setPointerCapture(e.pointerId);
      setDraft({ kind: "ink", points: [[x, y]], hl: tool === "highlight" });
    } else if (tool === "whiteout" || tool === "area") {
      (e.target as Element).setPointerCapture(e.pointerId);
      setDraft({ kind: tool, x0: x, y0: y, x1: x, y1: y });
    } else if (tool === "text") {
      e.preventDefault();
      if (api.editingId) {
        api.finishEdit();
        return;
      }
      const t: TextAnnotation = {
        id: newId(),
        pageId: pageRef.id,
        kind: "text",
        x,
        y: Math.max(0, y - (api.fontSize * TEXT_LINE_HEIGHT) / 2),
        text: "",
        size: api.fontSize,
        color: api.color,
        font: api.font,
        bold: api.bold,
        rot: 0,
      };
      api.create(t, { edit: true });
    } else if (tool === "check" || tool === "cross") {
      const s = api.markSize;
      api.create(
        { id: newId(), pageId: pageRef.id, kind: "mark", mark: tool, x: x - s / 2, y: y - s / 2, size: s, color: api.color },
        { keepTool: true },
      );
    } else if (tool === "place") {
      api.place(pageRef.id, x, y);
    } else {
      if (api.editingId) api.finishEdit();
      api.select(null);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!draft) return;
    const [x, y] = toPage(e);
    if (draft.kind === "ink") {
      // Shift draws a straight line, like running a highlighter along a ruler.
      if (e.shiftKey) {
        setDraft({ ...draft, points: [draft.points[0], [x, y]] });
        return;
      }
      const last = draft.points[draft.points.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) * zoom < 1.5) return;
      setDraft({ ...draft, points: [...draft.points, [x, y]] });
    } else {
      setDraft({ ...draft, x1: x, y1: y });
    }
  };

  const onPointerUp = () => {
    if (!draft) return;
    if (draft.kind === "ink") {
      if (draft.hl) {
        // A single tap leaves a short dab, as a real highlighter would.
        const pts = draft.points.length > 1 ? draft.points : [draft.points[0], [draft.points[0][0] + 2, draft.points[0][1]] as Point];
        api.create({ id: newId(), pageId: pageRef.id, kind: "ink", points: pts, color: api.highlightColor, width: api.highlightWidth, hl: true });
      } else {
        api.create({ id: newId(), pageId: pageRef.id, kind: "ink", points: draft.points, color: api.color, width: api.markerWidth });
      }
    } else {
      const x = Math.min(draft.x0, draft.x1);
      const y = Math.min(draft.y0, draft.y1);
      const ww = Math.abs(draft.x1 - draft.x0);
      const hh = Math.abs(draft.y1 - draft.y0);
      if (ww * zoom > 3 && hh * zoom > 3) {
        if (draft.kind === "area") {
          liftBlock(x, y, ww, hh);
        } else if (draft.kind === "highlight") {
          api.create({ id: newId(), pageId: pageRef.id, kind: "highlight", x, y, w: ww, h: hh, color: api.highlightColor });
        } else {
          // Cover the area like correction tape. Typing a replacement is optional
          // (double-click the covered area).
          api.create(
            { id: newId(), pageId: pageRef.id, kind: "whiteout", x, y, w: ww, h: hh, color: "#FFFFFF" },
            { keepTool: true },
          );
        }
      }
    }
    setDraft(null);
  };

  /**
   * Block select: draw the page's own content inside the box to an image,
   * cover the original spot, and hand back the image to drag, cut or copy.
   * (Items added in Quillmark stay where they are.)
   */
  const liftBlock = async (x: number, y: number, w: number, h: number) => {
    const scale = Math.min(4, Math.max(2, zoom * (window.devicePixelRatio || 1)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    try {
      await pdfPage.render({
        canvas,
        viewport: viewportFor(pdfPage, pageRef.rot, scale),
        transform: [1, 0, 0, 1, -x * scale, -y * scale],
        annotationMode: widgets.length ? pdfjs.AnnotationMode.ENABLE_FORMS : pdfjs.AnnotationMode.ENABLE,
      }).promise;
    } catch (e) {
      console.error(e);
      return;
    }
    // Areas already covered (cut or whited out) stay blank in the copy.
    const g = canvas.getContext("2d")!;
    for (const a of annotations)
      if (a.kind === "whiteout") {
        g.fillStyle = a.color;
        g.fillRect((a.x - x) * scale, (a.y - y) * scale, a.w * scale, a.h * scale);
      }
    const cover: Annotation = { id: newId(), pageId: pageRef.id, kind: "whiteout", x, y, w, h, color: "#FFFFFF" };
    const block: Annotation = {
      id: newId(),
      pageId: pageRef.id,
      kind: "image",
      x,
      y,
      w,
      h,
      src: canvas.toDataURL("image/png"),
      rot: 0,
      blend: "multiply",
    };
    api.lift(cover, block);
  };

  // Start typing replacement text inside a whiteout.
  const typeIn = (wo: { x: number; y: number; w: number; h: number }) => {
    const size = Math.round(Math.max(7, Math.min(api.fontSize, (wo.h * 0.8) / TEXT_LINE_HEIGHT)));
    const t: TextAnnotation = {
      id: newId(),
      pageId: pageRef.id,
      kind: "text",
      x: wo.x + 1,
      y: wo.y + Math.max(0, (wo.h - size * TEXT_LINE_HEIGHT) / 2),
      text: "",
      size,
      color: api.color,
      font: api.font,
      bold: api.bold,
      rot: 0,
    };
    api.create(t, { edit: true });
  };

  // Drag-to-move (select tool) for any annotation.
  const startMove = (e: React.PointerEvent, a: Annotation) => {
    if (tool !== "select" || e.button !== 0) return;
    e.stopPropagation();
    if (api.editingId && api.editingId !== a.id) api.finishEdit();
    api.select(a.id);
    const start = toPage(e);
    let moved = false;
    const orig = a;
    const move = (ev: PointerEvent) => {
      const [x, y] = toPage(ev);
      const dx = x - start[0];
      const dy = y - start[1];
      if (!moved) {
        if (Math.hypot(dx, dy) * zoom < 2) return;
        moved = true;
        api.checkpoint();
      }
      if (orig.kind === "ink") {
        api.updateLive(orig.id, { points: orig.points.map(([px, py]) => [px + dx, py + dy] as Point) });
      } else {
        api.updateLive(orig.id, { x: orig.x + dx, y: orig.y + dy });
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startResize = (e: React.PointerEvent, a: Annotation) => {
    e.stopPropagation();
    e.preventDefault();
    const box = localBox(a, textEls.current.get(a.id) ?? null, zoom);
    if (!box.w || !box.h) return;
    api.checkpoint();
    const rot = a.kind === "text" || a.kind === "image" ? a.rot : 0;
    const textW = box.w;
    const move = (ev: PointerEvent) => {
      // Pointer position in the item's own (unrotated) frame.
      const p = toPage(ev);
      const [lx, ly] = rotatePoint(p, -rot, [box.x, box.y]);
      const nw = Math.max(6, lx - box.x);
      const nh = Math.max(6, ly - box.y);
      if (a.kind === "image") {
        const ratio = a.w / a.h;
        const s = Math.max(nw / a.w, nh / a.h);
        api.updateLive(a.id, { w: Math.max(8, a.w * s), h: Math.max(8 / ratio, a.h * s) });
      } else if (a.kind === "highlight" || a.kind === "whiteout") {
        api.updateLive(a.id, { w: nw, h: nh });
      } else if (a.kind === "mark") {
        api.updateLive(a.id, { size: Math.max(6, Math.max(nw, nh)) });
      } else if (a.kind === "text") {
        const s = Math.max(4, Math.min(144, a.size * (nw / textW)));
        api.updateLive(a.id, { size: Math.round(s * 2) / 2 });
      } else if (a.kind === "ink") {
        const sx = nw / box.w;
        const sy = nh / box.h;
        api.updateLive(a.id, {
          points: a.points.map(([px, py]) => [box.x + (px - box.x) * sx, box.y + (py - box.y) * sy] as Point),
        });
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const selectable = tool === "select";

  /**
   * "Edit PDF text": cover the clicked line of the page's own text with
   * whiteout and put an editable text box with the same words on top.
   */
  const retypeLine = (target: HTMLElement) => {
    if (api.editingId) {
      api.finishEdit();
      return;
    }
    const layer = textLayerRef.current;
    const wrap = wrapRef.current;
    if (!layer || !wrap || target.tagName !== "SPAN" || !target.textContent?.trim()) return;
    const origin = wrap.getBoundingClientRect();
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: (r.left - origin.left) / zoom, y: (r.top - origin.top) / zoom, w: r.width / zoom, h: r.height / zoom, el };
    };
    const hit = box(target);
    // The rest of the visual line: spans at the same height, without a wide
    // gap (so table columns stay separate).
    const row = [...layer.querySelectorAll("span")]
      .filter((s) => !s.querySelector("span") && s.textContent)
      .map(box)
      .filter((b) => Math.abs(b.y - hit.y) < hit.h * 0.35 && Math.abs(b.h - hit.h) < hit.h * 0.35)
      .sort((a, b) => a.x - b.x);
    const gapMax = hit.h * 1.2;
    let i = row.findIndex((b) => b.el === target);
    if (i < 0) return;
    let lo = i;
    let hi = i;
    while (lo > 0 && row[lo].x - (row[lo - 1].x + row[lo - 1].w) < gapMax) lo--;
    while (hi < row.length - 1 && row[hi + 1].x - (row[hi].x + row[hi].w) < gapMax) hi++;
    const line = row.slice(lo, hi + 1);
    let text = "";
    line.forEach((b, k) => {
      const t = b.el.textContent ?? "";
      if (k && !/\s$/.test(text) && !/^\s/.test(t) && b.x - (line[k - 1].x + line[k - 1].w) > hit.h * 0.15) text += " ";
      text += t;
    });
    text = text.trim();
    const x0 = Math.min(...line.map((b) => b.x));
    const y0 = Math.min(...line.map((b) => b.y));
    const x1 = Math.max(...line.map((b) => b.x + b.w));
    const y1 = Math.max(...line.map((b) => b.y + b.h));
    const size = Math.max(4, Math.round(hit.h * 2) / 2);
    const fam = (target.style.fontFamily || getComputedStyle(target).fontFamily).toLowerCase();
    const font: TextAnnotation["font"] = /mono|courier/.test(fam) ? "courier" : /sans|arial|helvetica/.test(fam) ? "helvetica" : /serif|times/.test(fam) ? "times" : "helvetica";
    const pad = size * 0.12;
    const cover: Annotation = {
      id: newId(),
      pageId: pageRef.id,
      kind: "whiteout",
      x: x0 - pad,
      y: y0 - pad,
      w: x1 - x0 + pad * 2,
      h: y1 - y0 + pad * 2.5,
      color: "#FFFFFF",
    };
    // Line the new baseline up with the old one (pdf.js puts the span top at
    // roughly 0.8 em above the baseline).
    const t: TextAnnotation = {
      id: newId(),
      pageId: pageRef.id,
      kind: "text",
      x: x0,
      y: y0 + size * 0.8 - size * FONTS[font].baseline,
      text,
      size,
      color: "#000000",
      font,
      bold: false,
      rot: 0,
    };
    api.createMany([cover, t], t.id);
  };
  const selected = annotations.find((a) => a.id === api.selectedId) ?? null;

  // Outline + handle for SVG-drawn selections (text/images draw their own).
  let selBox: { x: number; y: number; w: number; h: number } | null = null;
  if (selected && selected.kind !== "text" && selected.kind !== "image") selBox = localBox(selected, null);

  return (
    <div
      ref={wrapRef}
      className={`page tool-${tool}`}
      data-page-id={pageRef.id}
      style={{ width: w * zoom, height: h * zoom }}
    >
      <canvas ref={canvasRef} className="page-canvas" />
      <div
        className="overlay"
        style={cursor ? { cursor } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          ref={textLayerRef}
          className="textLayer"
          style={{ "--total-scale-factor": zoom } as React.CSSProperties}
          onPointerDown={(e) => {
            if (tool === "edittext" && e.button === 0) {
              e.stopPropagation();
              e.preventDefault();
              retypeLine(e.target as HTMLElement);
              return;
            }
            // While dragging, stretch the end marker over the page so the
            // selection doesn't jump to the start when the pointer leaves the text.
            if (selectable && e.button === 0) {
              const div = e.currentTarget;
              div.classList.add("selecting");
              const up = () => {
                div.classList.remove("selecting");
                window.removeEventListener("pointerup", up);
              };
              window.addEventListener("pointerup", up);
            }
          }}
        />
        {annotations.map((a, i) => {
          const z = i + 1;
          if (a.kind === "text" || a.kind === "image") return null;
          const pe = { pointerEvents: selectable ? ("all" as const) : ("none" as const) };
          let item: React.ReactNode = null;
          if (a.kind === "highlight" || a.kind === "whiteout")
            item = (
              <rect
                data-kind={a.kind}
                className={a.kind === "whiteout" ? "whiteout" : undefined}
                x={a.x}
                y={a.y}
                width={a.w}
                height={a.h}
                fill={a.color}
                opacity={a.kind === "highlight" ? HIGHLIGHT_OPACITY : 1}
                strokeWidth={1 / zoom}
                style={{
                  ...(a.kind === "highlight" ? { mixBlendMode: "multiply" } : {}),
                  pointerEvents: selectable || (a.kind === "whiteout" && tool === "whiteout") ? "all" : "none",
                }}
                onPointerDown={(e) => startMove(e, a)}
                onDoubleClick={a.kind === "whiteout" ? () => typeIn(a) : undefined}
              >
                {a.kind === "whiteout" && <title>Whiteout. Double-click to type replacement text.</title>}
              </rect>
            );
          else if (a.kind === "mark")
            item = (
                <g data-kind="mark" transform={`translate(${a.x} ${a.y}) scale(${a.size})`}>
                  <rect width={1} height={1} fill="transparent" style={pe} onPointerDown={(e) => startMove(e, a)} />
                  <path
                    d={MARK_PATHS[a.mark]}
                    fill="none"
                    stroke={a.color}
                    strokeWidth={Math.max(1, a.size * 0.13) / a.size}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    pointerEvents="none"
                  />
                </g>
              );
          else if (a.kind === "ink")
            item = (
                <g data-kind={a.hl ? "hl" : "ink"}>
                  <path
                    d={smoothPath(a.points)}
                    fill="none"
                    stroke={a.color}
                    strokeWidth={a.width}
                    strokeLinecap={a.hl ? "butt" : "round"}
                    strokeLinejoin="round"
                    strokeOpacity={a.hl ? HIGHLIGHT_OPACITY : 1}
                    style={a.hl ? { mixBlendMode: "multiply" } : undefined}
                    pointerEvents="none"
                  />
                  <path
                    d={smoothPath(a.points)}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={Math.max(a.width, 10 / zoom)}
                    strokeLinecap="round"
                    style={{ pointerEvents: selectable ? "stroke" : "none" }}
                    onPointerDown={(e) => startMove(e, a)}
                  />
                </g>
              );
          return (
            <svg className="strokes" viewBox={`0 0 ${w} ${h}`} width={w * zoom} height={h * zoom} key={a.id} style={{ zIndex: z }}>
              {item}
            </svg>
          );
        })}

        <svg className="strokes" viewBox={`0 0 ${w} ${h}`} width={w * zoom} height={h * zoom} style={{ zIndex: 1000 }}>
          {search.map((r, i) => (
            <rect
              key={`s${i}`}
              className={`search-hit ${r.current ? "current" : ""}`}
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
            />
          ))}
          {draft?.kind === "ink" && (
            <path
              d={smoothPath(draft.points)}
              fill="none"
              stroke={draft.hl ? api.highlightColor : api.color}
              strokeWidth={draft.hl ? api.highlightWidth : api.markerWidth}
              strokeLinecap={draft.hl ? "butt" : "round"}
              strokeLinejoin="round"
              strokeOpacity={draft.hl ? HIGHLIGHT_OPACITY : 1}
              style={draft.hl ? { mixBlendMode: "multiply" } : undefined}
            />
          )}
          {draft?.kind === "area" && (
            <rect
              className="area-draft"
              x={Math.min(draft.x0, draft.x1)}
              y={Math.min(draft.y0, draft.y1)}
              width={Math.abs(draft.x1 - draft.x0)}
              height={Math.abs(draft.y1 - draft.y0)}
              strokeWidth={1.25 / zoom}
              strokeDasharray={`${4 / zoom} ${3 / zoom}`}
            />
          )}
          {(draft?.kind === "highlight" || draft?.kind === "whiteout") && (
            <rect
              x={Math.min(draft.x0, draft.x1)}
              y={Math.min(draft.y0, draft.y1)}
              width={Math.abs(draft.x1 - draft.x0)}
              height={Math.abs(draft.y1 - draft.y0)}
              fill={draft.kind === "highlight" ? api.highlightColor : "#FFFFFF"}
              opacity={draft.kind === "highlight" ? HIGHLIGHT_OPACITY : 1}
              stroke={draft.kind === "whiteout" ? "#D97757" : "none"}
              strokeWidth={1 / zoom}
              style={draft.kind === "highlight" ? { mixBlendMode: "multiply" } : {}}
            />
          )}
          {selBox && (
            <rect
              className="sel-outline"
              x={selBox.x}
              y={selBox.y}
              width={selBox.w}
              height={selBox.h}
              strokeWidth={1.5 / zoom}
              strokeDasharray={`${4 / zoom} ${3 / zoom}`}
            />
          )}
        </svg>

        {selBox && selected && tool === "select" && (
          <div
            className="handle"
            title="Drag to resize"
            style={{ left: (selBox.x + selBox.w) * zoom, top: (selBox.y + selBox.h) * zoom, zIndex: 1001 }}
            onPointerDown={(e) => startResize(e, selected)}
          />
        )}

        {widgets.map((wd) => (
          <FieldInput key={wd.id} widget={wd} vpConvert={(r) => toViewRect(vp, r)} zoom={zoom} value={fields[wd.name]} api={api} />
        ))}

        {annotations.map((a, i) =>
          a.kind === "image" ? (
            <div
              key={a.id}
              className={`box image-box ${a.id === api.selectedId ? "selected" : ""}`}
              data-role={a.role ?? "image"}
              style={{
                left: a.x * zoom,
                top: a.y * zoom,
                width: a.w * zoom,
                height: a.h * zoom,
                transform: a.rot ? `rotate(${a.rot}deg)` : undefined,
                mixBlendMode: a.blend,
                pointerEvents: selectable ? "auto" : "none",
                zIndex: a.id === api.selectedId ? 999 : i + 1,
              }}
              onPointerDown={(e) => startMove(e, a)}
            >
              <img src={a.src} alt="" draggable={false} />
              {a.id === api.selectedId && tool === "select" && (
                <div className="handle" title="Drag to resize" style={{ left: a.w * zoom, top: a.h * zoom }} onPointerDown={(e) => startResize(e, a)} />
              )}
            </div>
          ) : a.kind === "text" ? (
            <TextBox
              key={a.id}
              z={a.id === api.editingId ? 999 : i + 1}
              a={a}
              api={api}
              register={(el) => {
                if (el) textEls.current.set(a.id, el);
                else textEls.current.delete(a.id);
              }}
              onMoveStart={(e) => startMove(e, a)}
              onResizeStart={(e) => startResize(e, a)}
            />
          ) : null,
        )}
      </div>
    </div>
  );
});

function FieldInput({
  widget,
  vpConvert,
  zoom,
  value,
  api,
}: {
  widget: Widget;
  vpConvert: (r: number[]) => number[];
  zoom: number;
  value: FieldValue | undefined;
  api: PageApi;
}) {
  const [x1, y1, x2, y2] = vpConvert(widget.rect);
  const style: React.CSSProperties = {
    left: Math.min(x1, x2) * zoom,
    top: Math.min(y1, y2) * zoom,
    width: Math.abs(x2 - x1) * zoom,
    height: Math.abs(y2 - y1) * zoom,
    zIndex: 900,
  };
  const h = Math.abs(y2 - y1);
  const fs = (widget.fontSize || Math.max(6, Math.min(12, h * 0.7))) * zoom;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const common = {
    className: `field field-${widget.type}`,
    "data-field": widget.name,
    title: widget.name,
    disabled: widget.readOnly,
    onPointerDown: stop,
    onKeyDown: stop,
  };
  if (widget.type === "text") {
    return widget.multiLine ? (
      <textarea {...common} style={{ ...style, fontSize: fs }} value={String(value ?? "")} onChange={(e) => api.setField(widget.name, e.target.value)} />
    ) : (
      <input
        {...common}
        style={{ ...style, fontSize: fs }}
        value={String(value ?? "")}
        maxLength={widget.maxLen}
        onChange={(e) => api.setField(widget.name, e.target.value)}
      />
    );
  }
  if (widget.type === "checkbox") {
    return (
      <label {...common} style={style}>
        <input type="checkbox" checked={!!value} disabled={widget.readOnly} onChange={(e) => api.setField(widget.name, e.target.checked)} />
      </label>
    );
  }
  if (widget.type === "radio") {
    return (
      <label {...common} style={style}>
        <input
          type="radio"
          name={`radio-${widget.name}`}
          checked={value === widget.exportValue}
          disabled={widget.readOnly}
          onChange={() => api.setField(widget.name, widget.exportValue ?? "")}
        />
      </label>
    );
  }
  return (
    <select {...common} style={{ ...style, fontSize: fs }} value={String(value ?? "")} onChange={(e) => api.setField(widget.name, e.target.value)}>
      <option value=""></option>
      {widget.options?.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function TextBox({
  z,
  a,
  api,
  register,
  onMoveStart,
  onResizeStart,
}: {
  z: number;
  a: TextAnnotation;
  api: PageApi;
  register: (el: HTMLElement | null) => void;
  onMoveStart: (e: React.PointerEvent) => void;
  onResizeStart: (e: React.PointerEvent) => void;
}) {
  const { zoom, tool } = api;
  const editing = api.editingId === a.id;
  const ref = useRef<HTMLTextAreaElement>(null);
  const selected = a.id === api.selectedId;

  useEffect(() => {
    if (editing) {
      const t = ref.current!;
      t.focus();
      t.setSelectionRange(t.value.length, t.value.length);
    }
  }, [editing]);

  const style: React.CSSProperties = {
    left: a.x * zoom,
    top: a.y * zoom,
    fontSize: a.size * zoom,
    lineHeight: TEXT_LINE_HEIGHT,
    color: a.color,
    fontFamily: FONTS[a.font].css,
    fontWeight: a.bold ? 700 : 400,
    transform: a.rot ? `rotate(${a.rot}deg)` : undefined,
    zIndex: z,
  };

  if (editing) {
    const lines = a.text.split("\n");
    const cols = Math.max(4, ...lines.map((l) => l.length + 1));
    return (
      <textarea
        ref={(el) => {
          ref.current = el;
          register(el);
        }}
        className="box text-box editing"
        style={{ ...style, width: `${cols * 0.62}em`, height: `${lines.length * TEXT_LINE_HEIGHT}em` }}
        value={a.text}
        placeholder="Type here"
        spellCheck={false}
        onChange={(e) => api.updateLive(a.id, { text: e.target.value })}
        onBlur={() => api.finishEdit()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            api.finishEdit();
          }
          e.stopPropagation();
        }}
        onPointerDown={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <div
      ref={register}
      className={`box text-box ${selected ? "selected" : ""}`}
      style={{ ...style, pointerEvents: tool === "select" || tool === "text" || tool === "edittext" ? "auto" : "none" }}
      onPointerDown={(e) => {
        if (tool === "text" || tool === "edittext") {
          e.stopPropagation();
          e.preventDefault();
          if (api.editingId) api.finishEdit();
          api.startEdit(a.id);
          return;
        }
        onMoveStart(e);
      }}
      onDoubleClick={() => api.startEdit(a.id)}
    >
      {a.text}
      {selected && tool === "select" && <span className="handle text-handle" title="Drag to resize" onPointerDown={onResizeStart} />}
    </div>
  );
}
