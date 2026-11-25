import {
  BlendMode,
  LineCapStyle,
  LineJoinStyle,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFFont,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  StandardFonts,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setLineJoin,
} from "pdf-lib";
import type { PDFPageProxy, Widget } from "./pdf";
import { viewportFor } from "./pdf";
import { embedEditable } from "./editable";
import { rotatePoint, smoothPath } from "./geometry";
import {
  FONTS,
  HIGHLIGHT_OPACITY,
  MARK_PATHS,
  TEXT_LINE_HEIGHT,
  type Annotation,
  type DocState,
  type FieldValue,
  type FontFamily,
  type Point,
} from "./types";

function hexToRgb(hex: string) {
  const n = parseInt(hex.replace("#", ""), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Replace characters a standard PDF font cannot encode. */
export function encodable(font: PDFFont, line: string): string {
  let out = "";
  for (const ch of line) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

const STD: Record<FontFamily, [StandardFonts, StandardFonts]> = {
  helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
  times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold],
  courier: [StandardFonts.Courier, StandardFonts.CourierBold],
};

function fillFields(doc: PDFDocument, fields: Record<string, FieldValue>, original: Record<string, FieldValue>, helv: () => Promise<PDFFont>) {
  return (async () => {
    let form;
    try {
      form = doc.getForm();
    } catch {
      return;
    }
    for (const [name, value] of Object.entries(fields)) {
      if (JSON.stringify(value) === JSON.stringify(original[name])) continue;
      let f;
      try {
        f = form.getField(name);
      } catch {
        continue;
      }
      try {
        if (f instanceof PDFTextField) {
          const font = await helv();
          f.setText(encodable(font, String(value ?? "")));
        } else if (f instanceof PDFCheckBox) {
          if (value) f.check();
          else f.uncheck();
        } else if (f instanceof PDFRadioGroup) {
          if (typeof value === "string" && value) f.select(value);
          else f.clear();
        } else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
          if (typeof value === "string" && value) f.select(value);
          else f.clear();
        }
      } catch (e) {
        console.warn("Could not fill field", name, e);
      }
    }
  })();
}

/**
 * Apply the document state (page order/rotation, annotations, form values) to
 * a copy of the original PDF and return the new bytes. Annotations are merged
 * into the page content.
 */
export async function buildEditedPdf(
  original: Uint8Array,
  pdfPages: PDFPageProxy[],
  state: DocState,
  originalFields: Record<string, FieldValue> = {},
  _widgets: Widget[] = [],
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(original, { ignoreEncryption: true });
  const libPages = doc.getPages();
  const fontCache = new Map<StandardFonts, PDFFont>();
  const font = async (name: StandardFonts) => {
    let f = fontCache.get(name);
    if (!f) {
      f = await doc.embedFont(name);
      fontCache.set(name, f);
    }
    return f;
  };
  const imageCache = new Map<string, Awaited<ReturnType<PDFDocument["embedPng"]>>>();

  await fillFields(doc, state.fields, originalFields, () => font(StandardFonts.Helvetica));

  for (const ref of state.pages) {
    const page = libPages[ref.src];
    const vp = viewportFor(pdfPages[ref.src], ref.rot);
    const toPdf = (p: Point): Point => {
      const [px, py] = vp.convertToPdfPoint(p[0], p[1]);
      return [px, py];
    };
    // Angle (degrees, PDF convention) of an on-screen direction at a point.
    const angleOf = (p: Point, screenDeg: number) => {
      const [ax, ay] = toPdf(p);
      const q = rotatePoint([p[0] + 1, p[1]], screenDeg, p);
      const [bx, by] = toPdf(q);
      return (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
    };

    const anns = state.annotations
      .filter((a) => a.pageId === ref.id)
      .map((a, i) => ({ a, i }))
      // Draw in the order items were added, so a whiteout covers anything
      // placed before it (and text typed afterwards sits on top).
      .map((p) => p.a);

    for (const a of anns) {
      if (a.kind === "highlight" || a.kind === "whiteout") {
        const [x1, y1] = toPdf([a.x, a.y]);
        const [x2, y2] = toPdf([a.x + a.w, a.y + a.h]);
        page.drawRectangle({
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
          color: hexToRgb(a.color),
          ...(a.kind === "highlight" ? { opacity: HIGHLIGHT_OPACITY, blendMode: BlendMode.Multiply } : {}),
        });
      } else if (a.kind === "ink" || a.kind === "mark") {
        let pts: Point[][];
        let width: number;
        if (a.kind === "ink") {
          pts = [a.points];
          width = a.width;
        } else {
          // Parse the 0..1 mark path into polylines inside the mark's box.
          pts = [];
          for (const seg of MARK_PATHS[a.mark].split("M").filter((s) => s.trim())) {
            const nums = seg.replace(/L/g, " ").trim().split(/\s+/).map(Number);
            const line: Point[] = [];
            for (let i = 0; i < nums.length; i += 2) line.push([a.x + nums[i] * a.size, a.y + nums[i + 1] * a.size]);
            pts.push(line);
          }
          width = Math.max(1, a.size * 0.13);
        }
        page.pushOperators(pushGraphicsState(), setLineJoin(LineJoinStyle.Round));
        for (const line of pts) {
          const pdfPts = line.map(toPdf);
          // drawSvgPath treats y as pointing down from the origin, so negate y.
          const path =
            a.kind === "ink"
              ? smoothPath(pdfPts.map(([x, y]) => [x, -y] as Point))
              : pdfPts.map(([x, y], i) => `${i ? "L" : "M"} ${x} ${-y}`).join(" ");
          const hl = a.kind === "ink" && a.hl;
          page.drawSvgPath(path, {
            x: 0,
            y: 0,
            borderColor: hexToRgb(a.color),
            borderWidth: width,
            borderLineCap: hl ? LineCapStyle.Butt : LineCapStyle.Round,
            ...(hl ? { borderOpacity: HIGHLIGHT_OPACITY, blendMode: BlendMode.Multiply } : {}),
          });
        }
        page.pushOperators(popGraphicsState());
      } else if (a.kind === "text") {
        if (!a.text.trim()) continue;
        const f = await font(STD[a.font][a.bold ? 1 : 0]);
        const lh = a.size * TEXT_LINE_HEIGHT;
        const base = FONTS[a.font].baseline;
        a.text.split("\n").forEach((line, i) => {
          const start = rotatePoint([a.x, a.y + i * lh + a.size * base], a.rot, [a.x, a.y]);
          const [px, py] = toPdf(start);
          page.drawText(encodable(f, line), {
            x: px,
            y: py,
            size: a.size,
            font: f,
            color: hexToRgb(a.color),
            rotate: degrees(angleOf(start, a.rot)),
          });
        });
      } else if (a.kind === "image") {
        let img = imageCache.get(a.src);
        if (!img) {
          img = a.src.startsWith("data:image/png") ? await doc.embedPng(a.src) : await doc.embedJpg(a.src);
          imageCache.set(a.src, img);
        }
        // drawImage anchors at the image's bottom-left corner.
        const corner = rotatePoint([a.x, a.y + a.h], a.rot, [a.x, a.y]);
        const [px, py] = toPdf(corner);
        page.drawImage(img, {
          x: px,
          y: py,
          width: a.w,
          height: a.h,
          rotate: degrees(angleOf(corner, a.rot)),
          ...(a.blend === "multiply" ? { blendMode: BlendMode.Multiply } : {}),
        });
      }
    }
    if (ref.rot) page.setRotation(degrees((page.getRotation().angle + ref.rot) % 360));
  }

  // Page order and deletions.
  const unchanged =
    state.pages.length === libPages.length && state.pages.every((p, i) => p.src === i);
  if (!unchanged) {
    for (let i = libPages.length - 1; i >= 0; i--) doc.removePage(i);
    state.pages.forEach((ref, i) => doc.insertPage(i, libPages[ref.src]));
  }
  // Keep the changes editable when Quillmark opens this file again.
  if (state.annotations.length || !unchanged || state.pages.some((p) => p.rot)) embedEditable(doc, original, state);
  return doc.save({ useObjectStreams: false });
}
