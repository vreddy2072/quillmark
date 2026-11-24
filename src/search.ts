import { pageText, toViewRect, viewportFor, type PDFPageProxy } from "./pdf";
import type { PageRef } from "./types";

export interface Match {
  pageId: string;
  rects: { x: number; y: number; w: number; h: number }[];
}

/** Find every case-insensitive occurrence of `query` and its on-page boxes. */
export async function findMatches(query: string, refs: PageRef[], pdfPages: PDFPageProxy[]): Promise<Match[]> {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return [];
  const out: Match[] = [];
  for (const ref of refs) {
    const page = pdfPages[ref.src];
    const items = await pageText(page);
    const vp = viewportFor(page, ref.rot);
    // Join the page's text, remembering which item each character came from.
    let text = "";
    const owner: number[] = [];
    const offset: number[] = [];
    items.forEach((it, i) => {
      for (let k = 0; k < it.str.length; k++) {
        text += it.str[k];
        owner.push(i);
        offset.push(k);
      }
      if (it.hasEOL || (it.str && !/\s$/.test(it.str))) {
        text += " ";
        owner.push(-1);
        offset.push(0);
      }
    });
    const hay = text.toLowerCase().replace(/\s/g, " ");
    // Spaces in the query match any run of whitespace on the page.
    const pattern = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"), "g");
    for (const m of hay.matchAll(pattern)) {
      const start = m.index!;
      const end = start + m[0].length;
      // Group consecutive characters by text item.
      const spans = new Map<number, [number, number]>();
      for (let c = start; c < end; c++) {
        const i = owner[c];
        if (i < 0) continue;
        const s = spans.get(i);
        if (s) s[1] = offset[c] + 1;
        else spans.set(i, [offset[c], offset[c] + 1]);
      }
      const rects: Match["rects"] = [];
      for (const [i, [a, b]] of spans) {
        const it = items[i];
        const [sa, sb, , , e, f] = it.transform;
        const fontH = Math.hypot(sa, sb) || it.height || 10;
        const len = it.str.length || 1;
        const x0 = e + (it.width * a) / len;
        const x1 = e + (it.width * b) / len;
        const r = toViewRect(vp, [x0, f - fontH * 0.22, x1, f + fontH * 0.88]);
        rects.push({
          x: Math.min(r[0], r[2]),
          y: Math.min(r[1], r[3]),
          w: Math.abs(r[2] - r[0]),
          h: Math.abs(r[3] - r[1]),
        });
      }
      if (rects.length) out.push({ pageId: ref.id, rects });
    }
  }
  return out;
}
