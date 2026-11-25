// Keeping edits editable after saving.
//
// A saved PDF has every change merged into its pages, so any PDF reader shows
// it. Quillmark also tucks two things inside the file, where other readers
// ignore them: the untouched original PDF, and the list of changes (text
// boxes, marks, images, page order, form values). When Quillmark opens the
// file again it starts from the original and puts the changes back as
// separate items that can still be moved, edited or deleted.

import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } from "pdf-lib";
import type { DocState } from "./types";

const KEY = "QuillmarkEdits";
const VERSION = 1;

/** Store the original file and the changes in the document being saved. */
export function embedEditable(doc: PDFDocument, original: Uint8Array, state: DocState) {
  const ctx = doc.context;
  const json = new TextEncoder().encode(JSON.stringify({ v: VERSION, state }));
  const dict = ctx.obj({
    Version: VERSION,
    Pages: state.pages.length,
    Original: ctx.register(ctx.flateStream(original)),
    State: ctx.register(ctx.flateStream(json)),
  });
  doc.catalog.set(PDFName.of(KEY), ctx.register(dict));
}

/** Does this look like it may carry Quillmark edits? (Cheap check before parsing.) */
function hasMarker(bytes: Uint8Array): boolean {
  const needle = new TextEncoder().encode(`/${KEY}`);
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

function countEof(bytes: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < bytes.length - 4; i++)
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x25 && bytes[i + 2] === 0x45 && bytes[i + 3] === 0x4f && bytes[i + 4] === 0x46) n++;
  return n;
}

export type Extracted =
  | { kind: "editable"; original: Uint8Array; state: DocState }
  /** Changed by another program after Quillmark saved it: open as a normal PDF. */
  | { kind: "changed-elsewhere" }
  | null;

export async function extractEditable(bytes: Uint8Array): Promise<Extracted> {
  if (!hasMarker(bytes)) return null;
  try {
    // Another program appending its own changes (e.g. a signature) adds
    // another end-of-file marker; restoring the original would undo them.
    if (countEof(bytes) > 1) return { kind: "changed-elsewhere" };
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const entry = doc.catalog.lookupMaybe(PDFName.of(KEY), PDFDict);
    if (!entry) return null;
    const stream = (name: string) => {
      const ref = entry.get(PDFName.of(name));
      const s = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
      if (!(s instanceof PDFRawStream)) throw new Error(`Missing ${name}`);
      return decodePDFRawStream(s).decode();
    };
    const pages = entry.lookupMaybe(PDFName.of("Pages"), PDFNumber)?.asNumber();
    if (pages !== doc.getPageCount()) return { kind: "changed-elsewhere" };
    const data = JSON.parse(new TextDecoder().decode(stream("State"))) as { v: number; state: DocState };
    if (data.v !== VERSION || !Array.isArray(data.state?.pages) || !Array.isArray(data.state?.annotations)) return null;
    return { kind: "editable", original: stream("Original"), state: data.state };
  } catch (e) {
    console.warn("Could not read Quillmark edits", e);
    return null;
  }
}
