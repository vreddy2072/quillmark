import { useEffect, useRef, useState } from "react";
import "@fontsource/great-vibes/latin-400.css";
import "@fontsource/dancing-script/latin-400.css";
import "@fontsource/homemade-apple/latin-400.css";
import { smoothPath } from "./geometry";
import type { Point } from "./types";

export interface SavedSignature {
  id: string;
  kind: "signature" | "initials";
  src: string; // transparent PNG data URL, trimmed
  aspect: number; // width / height
}

const KEY = "quillmark.signatures.v1";
// Signatures saved before the app was renamed from PDFEdit.
const OLD_KEY = "pdfedit.signatures.v1";

export function loadSignatures(): SavedSignature[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function storeSignatures(list: SavedSignature[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

const SCRIPT_FONTS = [
  { css: '"Great Vibes"', label: "Elegant" },
  { css: '"Dancing Script"', label: "Casual" },
  { css: '"Homemade Apple"', label: "Handwritten" },
];
const INKS = [
  { c: "#1A1A1A", label: "Black" },
  { c: "#1F3A93", label: "Blue" },
];

/** Crop a canvas to its non-transparent pixels and return a PNG data URL. */
function trimCanvas(c: HTMLCanvasElement): { src: string; aspect: number } | null {
  const ctx = c.getContext("2d")!;
  const { width, height } = c;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 6;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d")!.drawImage(c, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return { src: out.toDataURL("image/png"), aspect: out.width / out.height };
}

const PAD_W = 520;
const PAD_H = 170;
const SCALE = 3;

export function SignatureDialog({
  kind,
  onDone,
  onCancel,
}: {
  kind: "signature" | "initials";
  onDone: (s: { src: string; aspect: number }, save: boolean) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"draw" | "type">("draw");
  const [ink, setInk] = useState(INKS[0].c);
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const [current, setCurrent] = useState<Point[] | null>(null);
  const [typed, setTyped] = useState("");
  const [fontIdx, setFontIdx] = useState(0);
  const [save, setSave] = useState(true);
  const padRef = useRef<HTMLDivElement>(null);
  const noun = kind === "signature" ? "signature" : "initials";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const pt = (e: React.PointerEvent): Point => {
    const r = padRef.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * PAD_W, ((e.clientY - r.top) / r.height) * PAD_H];
  };

  const canFinish = mode === "draw" ? strokes.length > 0 : typed.trim().length > 0;

  const finish = async () => {
    const c = document.createElement("canvas");
    c.width = PAD_W * SCALE;
    c.height = PAD_H * SCALE;
    const ctx = c.getContext("2d")!;
    ctx.scale(SCALE, SCALE);
    if (mode === "draw") {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2.6;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const s of strokes) ctx.stroke(new Path2D(smoothPath(s)));
    } else {
      const f = SCRIPT_FONTS[fontIdx].css;
      await document.fonts.load(`72px ${f}`);
      let size = 72;
      ctx.font = `${size}px ${f}`;
      while (ctx.measureText(typed).width > PAD_W - 40 && size > 20) {
        size -= 2;
        ctx.font = `${size}px ${f}`;
      }
      ctx.fillStyle = ink;
      ctx.textBaseline = "middle";
      ctx.fillText(typed.trim(), 20, PAD_H / 2);
    }
    const out = trimCanvas(c);
    if (out) onDone(out, save);
  };

  return (
    <div className="modal-backdrop" onPointerDown={onCancel}>
      <div className="modal" role="dialog" aria-label={`Add ${noun}`} onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Add {noun}</h2>
          <div className="seg" role="tablist">
            <button role="tab" aria-selected={mode === "draw"} className={mode === "draw" ? "on" : ""} onClick={() => setMode("draw")}>
              Draw
            </button>
            <button role="tab" aria-selected={mode === "type"} className={mode === "type" ? "on" : ""} onClick={() => setMode("type")}>
              Type
            </button>
          </div>
        </div>

        {mode === "draw" ? (
          <div
            ref={padRef}
            className="sig-pad"
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture(e.pointerId);
              setCurrent([pt(e)]);
            }}
            onPointerMove={(e) => current && setCurrent([...current, pt(e)])}
            onPointerUp={() => {
              if (current) setStrokes([...strokes, current]);
              setCurrent(null);
            }}
          >
            <svg viewBox={`0 0 ${PAD_W} ${PAD_H}`} width="100%" height="100%">
              <line x1="24" x2={PAD_W - 24} y1={PAD_H - 40} y2={PAD_H - 40} className="sig-line" />
              {[...strokes, ...(current ? [current] : [])].map((s, i) => (
                <path key={i} d={smoothPath(s)} fill="none" stroke={ink} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
              ))}
            </svg>
            {!strokes.length && !current && <span className="sig-placeholder">Sign here with your mouse, pen or finger</span>}
          </div>
        ) : (
          <div className="sig-type">
            <input
              className="text-input"
              autoFocus
              placeholder={kind === "signature" ? "Type your full name" : "Type your initials"}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && canFinish && finish()}
            />
            <div className="sig-fonts">
              {SCRIPT_FONTS.map((f, i) => (
                <button
                  key={f.css}
                  className={`sig-font ${i === fontIdx ? "on" : ""}`}
                  style={{ fontFamily: f.css, color: ink }}
                  onClick={() => setFontIdx(i)}
                  aria-label={`${f.label} style`}
                >
                  {typed.trim() || (kind === "signature" ? "Your Name" : "YN")}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="modal-foot">
          <div className="opt">
            <span className="label">Ink</span>
            {INKS.map((k) => (
              <button key={k.c} className={`swatch ${ink === k.c ? "on" : ""}`} style={{ background: k.c }} onClick={() => setInk(k.c)} aria-label={`${k.label} ink`} />
            ))}
            {mode === "draw" && (
              <button className="link" onClick={() => setStrokes([])} disabled={!strokes.length}>
                Clear
              </button>
            )}
          </div>
          <label className="check">
            <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Save for next time
          </label>
          <div className="actions">
            <button className="ghost" onClick={onCancel}>
              Cancel
            </button>
            <button className="primary" disabled={!canFinish} onClick={finish}>
              Place {noun}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
