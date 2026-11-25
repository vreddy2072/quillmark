// Helpers for covering and lifting parts of a page.

type RGB = [number, number, number];

const hex = ([r, g, b]: RGB) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();

/**
 * The page's background colour around a box (canvas pixels): the most common
 * colour on the box's edge. Pages aren't always pure white, so covers use it.
 */
export function sampleBackground(canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number): RGB {
  const g = canvas.getContext("2d", { willReadFrequently: true });
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(canvas.width - 1, Math.ceil(x + w));
  const y1 = Math.min(canvas.height - 1, Math.ceil(y + h));
  if (!g || x1 <= x0 || y1 <= y0) return [255, 255, 255];
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  const add = (data: Uint8ClampedArray) => {
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 250) continue;
      // Vote in buckets of 4 levels so tiny noise doesn't split it, then
      // average the exact colours in the winning bucket.
      const k = ((data[i] >> 2) << 12) | ((data[i + 1] >> 2) << 6) | (data[i + 2] >> 2);
      const c = counts.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
      c.n++;
      c.r += data[i];
      c.g += data[i + 1];
      c.b += data[i + 2];
      counts.set(k, c);
    }
  };
  add(g.getImageData(x0, y0, x1 - x0 + 1, 1).data);
  add(g.getImageData(x0, y1, x1 - x0 + 1, 1).data);
  add(g.getImageData(x0, y0, 1, y1 - y0 + 1).data);
  add(g.getImageData(x1, y0, 1, y1 - y0 + 1).data);
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  if (!best) return [255, 255, 255];
  return [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];
}

export const backgroundHex = (canvas: HTMLCanvasElement | null, x: number, y: number, w: number, h: number) =>
  canvas && canvas.width ? hex(sampleBackground(canvas, x, y, w, h)) : "#FFFFFF";

/**
 * Make the background colour transparent ("colour to alpha"), keeping
 * anti-aliased edges smooth, so a lifted block can sit over other content.
 */
export function backgroundToAlpha(canvas: HTMLCanvasElement, bg: RGB) {
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let a = 0;
    for (let c = 0; c < 3; c++) {
      const diff = d[i + c] - bg[c];
      // Floor the range so a near-white page's tiny headroom doesn't turn
      // rendering noise into visible specks.
      const range = Math.max(48, diff > 0 ? 255 - bg[c] : bg[c]);
      a = Math.max(a, Math.abs(diff) / range);
    }
    if (a < 0.05) {
      d[i + 3] = 0;
      continue;
    }
    a = Math.min(1, a);
    for (let c = 0; c < 3; c++) d[i + c] = Math.round(Math.min(255, Math.max(0, (d[i + c] - bg[c]) / a + bg[c])));
    d[i + 3] = Math.round(a * d[i + 3]);
  }
  g.putImageData(img, 0, 0);
}

export { hex as rgbHex };
export type { RGB };
