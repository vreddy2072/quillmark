import { memo, useEffect, useRef, useState } from "react";
import { icons } from "./icons";
import { pdfjs, viewportFor, type PDFPageProxy } from "./pdf";
import type { PageRef } from "./types";

const THUMB_W = 112;

const Thumb = memo(function Thumb({ page, rot }: { page: PDFPageProxy; rot: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const vp1 = viewportFor(page, rot);
  const scale = THUMB_W / vp1.width;

  useEffect(() => {
    const el = ref.current!;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: "400px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const dpr = window.devicePixelRatio || 1;
    const vp = viewportFor(page, rot, scale * dpr);
    const off = document.createElement("canvas");
    off.width = Math.floor(vp.width);
    off.height = Math.floor(vp.height);
    let cancelled = false;
    const task = page.render({ canvas: off, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE });
    task.promise.then(
      () => {
        if (cancelled || !ref.current) return;
        ref.current.width = off.width;
        ref.current.height = off.height;
        ref.current.getContext("2d")!.drawImage(off, 0, 0);
      },
      () => {},
    );
    return () => {
      cancelled = true;
      task.cancel();
    };
  }, [visible, page, rot, scale]);

  return <canvas ref={ref} className="thumb-canvas" style={{ width: THUMB_W, height: vp1.height * scale }} />;
});

interface Props {
  pages: PageRef[];
  pdfPages: PDFPageProxy[];
  current: number;
  onJump: (index: number) => void;
  onRotate: (id: string, dir: 1 | -1) => void;
  onDelete: (id: string) => void;
  onMove: (from: number, to: number) => void;
}

export function Sidebar({ pages, pdfPages, current, onJump, onRotate, onDelete, onMove }: Props) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the current page's thumbnail in view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-thumb="${current}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [current]);

  return (
    <aside className="sidebar" aria-label="Pages">
      <div className="sidebar-head">
        <span className="label">Pages</span>
        <span className="sidebar-hint">Drag to reorder</span>
      </div>
      <div className="thumbs" ref={listRef}>
        {pages.map((p, i) => (
          <div
            key={p.id}
            data-thumb={i}
            className={`thumb ${i === current ? "current" : ""} ${dropAt === i && dragFrom !== null && dragFrom !== i ? (dragFrom < i ? "drop-after" : "drop-before") : ""}`}
            draggable
            onDragStart={(e) => {
              setDragFrom(i);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/x-quillmark-page", String(i));
            }}
            onDragOver={(e) => {
              if (dragFrom === null) return;
              e.preventDefault();
              e.stopPropagation();
              setDropAt(i);
            }}
            onDrop={(e) => {
              if (dragFrom === null) return;
              e.preventDefault();
              e.stopPropagation();
              if (dragFrom !== i) onMove(dragFrom, i);
              setDragFrom(null);
              setDropAt(null);
            }}
            onDragEnd={() => {
              setDragFrom(null);
              setDropAt(null);
            }}
            onClick={() => onJump(i)}
          >
            <div className="thumb-frame">
              <Thumb page={pdfPages[p.src]} rot={p.rot} />
              <div className="thumb-actions" onClick={(e) => e.stopPropagation()}>
                <button className="mini" title="Rotate left" aria-label={`Rotate page ${i + 1} left`} onClick={() => onRotate(p.id, -1)}>
                  {icons.rotateLeft}
                </button>
                <button className="mini" title="Rotate right" aria-label={`Rotate page ${i + 1} right`} onClick={() => onRotate(p.id, 1)}>
                  {icons.rotateRight}
                </button>
                <button
                  className="mini danger"
                  title="Delete page"
                  aria-label={`Delete page ${i + 1}`}
                  disabled={pages.length === 1}
                  onClick={() => onDelete(p.id)}
                >
                  {icons.trash}
                </button>
              </div>
            </div>
            <div className="thumb-num">{i + 1}</div>
          </div>
        ))}
      </div>
    </aside>
  );
}
