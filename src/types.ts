// All annotation coordinates are in page "view space" at zoom 1:
// PDF points, origin at the top-left of the page as it is displayed
// (after the page's rotation is applied), y pointing down.

export type Point = [number, number];

interface Base {
  id: string;
  pageId: string;
}

export type FontFamily = "helvetica" | "times" | "courier";

export interface TextAnnotation extends Base {
  kind: "text";
  x: number;
  y: number; // top of the first line
  text: string;
  size: number;
  color: string;
  font: FontFamily;
  bold: boolean;
  rot: number; // degrees clockwise on screen: 0, 90, 180, 270
}

export interface InkAnnotation extends Base {
  kind: "ink";
  points: Point[];
  color: string;
  width: number;
  hl?: boolean; // highlighter stroke: translucent, flat (square) ends
}

export interface RectAnnotation extends Base {
  kind: "highlight" | "whiteout";
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

export interface ImageAnnotation extends Base {
  kind: "image";
  x: number;
  y: number;
  w: number;
  h: number;
  src: string; // data: URL (PNG or JPEG)
  rot: number;
  role?: "signature" | "initials";
}

export interface MarkAnnotation extends Base {
  kind: "mark";
  mark: "check" | "cross";
  x: number;
  y: number;
  size: number;
  color: string;
}

export type Annotation =
  | TextAnnotation
  | InkAnnotation
  | RectAnnotation
  | ImageAnnotation
  | MarkAnnotation;

export type Tool =
  | "select"
  | "text"
  | "marker"
  | "highlight"
  | "whiteout"
  | "check"
  | "cross"
  | "place"; // placing a signature / initials / date stamp

export interface PageRef {
  id: string;
  src: number; // 0-based page index in the original file
  rot: number; // extra clockwise rotation added in this app: 0, 90, 180, 270
}

export type FieldValue = string | boolean | string[];

export interface DocState {
  pages: PageRef[];
  annotations: Annotation[];
  fields: Record<string, FieldValue>;
}

export const TEXT_LINE_HEIGHT = 1.2;
export const HIGHLIGHT_OPACITY = 0.4;

export const FONTS: Record<FontFamily, { label: string; css: string; baseline: number }> = {
  // `baseline` is the distance from the top of a line box to the baseline, as a
  // fraction of the font size, for the CSS font on screen. The saved PDF uses
  // the same number so text lands where it was shown.
  helvetica: { label: "Sans (Helvetica)", css: "Helvetica, Arial, sans-serif", baseline: 0.94 },
  times: { label: "Serif (Times)", css: '"Times New Roman", Times, serif', baseline: 0.935 },
  courier: { label: "Mono (Courier)", css: '"Courier New", Courier, monospace', baseline: 0.865 },
};

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Paths for check and cross marks in a 0..1 box. */
export const MARK_PATHS: Record<MarkAnnotation["mark"], string> = {
  check: "M 0.12 0.55 L 0.4 0.82 L 0.9 0.18",
  cross: "M 0.18 0.18 L 0.82 0.82 M 0.82 0.18 L 0.18 0.82",
};
