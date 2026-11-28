import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFPageProxy, PageViewport } from "pdfjs-dist";
import type { FieldValue } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };

/** pdf.js support files copied beside the app at build time (see vite.config.ts). */
const asset = (p: string) => new URL(`pdfjs/${p}`, document.baseURI).href;
export type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";

/** A form widget (one visible box of an AcroForm field) on an original page. */
export interface Widget {
  id: string;
  src: number;
  name: string;
  type: "text" | "checkbox" | "radio" | "choice";
  rect: [number, number, number, number]; // PDF user space
  exportValue?: string; // checkbox/radio "on" value
  options?: { value: string; label: string }[];
  multiLine?: boolean;
  readOnly?: boolean;
  combo?: boolean;
  maxLen?: number;
  fontSize?: number;
}

/** View-space viewport at zoom 1 for a page with an extra app rotation. */
export function viewportFor(page: PDFPageProxy, extraRot: number, scale = 1): PageViewport {
  return page.getViewport({ scale, rotation: (page.rotate + extraRot) % 360 });
}

export async function openPdf(bytes: Uint8Array) {
  // pdf.js transfers the buffer it is given, so hand it a copy and keep the
  // original bytes for saving.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: asset("cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: asset("standard_fonts/"),
    wasmUrl: asset("wasm/"),
  });
  const doc = await task.promise;
  const pages: PDFPageProxy[] = [];
  const widgets: Widget[] = [];
  const fields: Record<string, FieldValue> = {};
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    pages.push(page);
    let annots: Record<string, unknown>[] = [];
    try {
      annots = await page.getAnnotations();
    } catch {
      annots = [];
    }
    for (const a of annots) {
      if (a.subtype !== "Widget" || !a.fieldName) continue;
      const name = String(a.fieldName);
      const rect = a.rect as [number, number, number, number];
      const base = { id: String(a.id ?? `${i}-${widgets.length}`), src: i - 1, name, rect, readOnly: !!a.readOnly };
      const fontSize = (a.defaultAppearanceData as { fontSize?: number } | undefined)?.fontSize;
      if (a.fieldType === "Tx") {
        widgets.push({ ...base, type: "text", multiLine: !!a.multiLine, maxLen: (a.maxLen as number) || undefined, fontSize });
        if (!(name in fields)) fields[name] = typeof a.fieldValue === "string" ? a.fieldValue : "";
      } else if (a.fieldType === "Btn" && a.checkBox) {
        const exportValue = String(a.exportValue ?? "Yes");
        widgets.push({ ...base, type: "checkbox", exportValue });
        if (!(name in fields)) fields[name] = a.fieldValue != null && a.fieldValue !== "Off" && a.fieldValue !== "";
      } else if (a.fieldType === "Btn" && a.radioButton) {
        widgets.push({ ...base, type: "radio", exportValue: String(a.buttonValue ?? "") });
        if (!(name in fields)) fields[name] = typeof a.fieldValue === "string" && a.fieldValue !== "Off" ? a.fieldValue : "";
      } else if (a.fieldType === "Ch") {
        const opts = ((a.options as { exportValue: string; displayValue: string }[]) ?? []).map((o) => ({
          value: String(o.exportValue),
          label: String(o.displayValue ?? o.exportValue),
        }));
        widgets.push({ ...base, type: "choice", options: opts, combo: !!a.combo, fontSize });
        const v = a.fieldValue;
        if (!(name in fields)) fields[name] = Array.isArray(v) ? String(v[0] ?? "") : typeof v === "string" ? v : "";
      }
    }
  }
  return { doc, pages, widgets, fields, destroy: () => task.destroy() };
}

export type OpenedPdf = Awaited<ReturnType<typeof openPdf>>;

/** Text items of a page, with cached results. */
const textCache = new WeakMap<PDFPageProxy, Promise<TextItem[]>>();
export interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
}
export function pageText(page: PDFPageProxy): Promise<TextItem[]> {
  let p = textCache.get(page);
  if (!p) {
    p = page.getTextContent().then((tc) =>
      (tc.items as unknown as TextItem[]).filter((it) => typeof it.str === "string"),
    );
    textCache.set(page, p);
  }
  return p;
}

/** Convert a PDF-space rectangle to a view-space [x1, y1, x2, y2]. */
export function toViewRect(vp: PageViewport, r: number[]): number[] {
  const [x1, y1] = vp.convertToViewportPoint(r[0], r[1]);
  const [x2, y2] = vp.convertToViewportPoint(r[2], r[3]);
  return [x1, y1, x2, y2];
}

/** pdf.js pages for blank pages of the given sizes, to show pages added in Quillmark. */
export async function blankPages(sizes: { w: number; h: number }[]): Promise<PDFPageProxy[]> {
  if (!sizes.length) return [];
  const { PDFDocument } = await import("pdf-lib");
  const d = await PDFDocument.create();
  for (const s of sizes) d.addPage([s.w, s.h]);
  const opened = await openPdf(await d.save());
  return opened.pages;
}
