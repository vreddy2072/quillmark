import type { Annotation, Point } from "./types";

export function rotatePoint([x, y]: Point, deg: number, [ox, oy]: Point = [0, 0]): Point {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const dx = x - ox;
  const dy = y - oy;
  // Screen coordinates (y down): positive degrees turn clockwise.
  return [ox + dx * c - dy * s, oy + dx * s + dy * c];
}

export function normRot(deg: number) {
  return ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
}

/**
 * Move an annotation along with its page when the page turns 90 degrees.
 * `w`/`h` are the page's view size before turning; dir 1 = clockwise.
 */
export function rotateAnnotation(a: Annotation, w: number, h: number, dir: 1 | -1): Annotation {
  const map = ([x, y]: Point): Point => (dir === 1 ? [h - y, x] : [y, w - x]);
  switch (a.kind) {
    case "ink":
      return { ...a, points: a.points.map(map) };
    case "highlight":
    case "whiteout": {
      const [x1, y1] = map([a.x, a.y]);
      const [x2, y2] = map([a.x + a.w, a.y + a.h]);
      return { ...a, x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    }
    case "mark": {
      const [cx, cy] = map([a.x + a.size / 2, a.y + a.size / 2]);
      return { ...a, x: cx - a.size / 2, y: cy - a.size / 2 };
    }
    case "text":
    case "image": {
      const [x, y] = map([a.x, a.y]);
      return { ...a, x, y, rot: normRot(a.rot + dir * 90) };
    }
  }
}

export function inkBounds(points: Point[], pad: number) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

export function smoothPath(pts: Point[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) {
    const [x, y] = pts[0];
    return `M ${x} ${y} L ${x + 0.01} ${y}`;
  }
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i];
    const [nx, ny] = pts[i + 1];
    d += ` Q ${x} ${y} ${(x + nx) / 2} ${(y + ny) / 2}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last[0]} ${last[1]}`;
  return d;
}
