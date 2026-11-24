# Quillmark

A local Windows PDF editor. Open a PDF, add typed text, draw with a freehand
marker, highlight, place images, and save a new PDF with the edits merged into
the pages.

## Run it

Double-click `Start Quillmark.cmd`. It needs Node.js (24 LTS) and nothing else:
the built app is already in `dist/`, so there is no `npm install` step. The app
opens in its own Microsoft Edge window at http://127.0.0.1:4317. Keep the small
console window open while you work; close it to quit.

## Using it

| Tool | Key | What it does |
|------|-----|--------------|
| Select | V | Click an item to select it, drag to move (arrow keys nudge), drag the corner dot to resize. Change its colour, font, size or bold in the bar below. Double-click text to edit it. |
| Text | T | Click anywhere on a page and type. Enter adds a line, Esc finishes. Pick Sans, Serif or Mono, a size and bold. |
| Marker | M | Freehand drawing in five colours and three thicknesses. |
| Highlight | H | Drag a box over text to highlight it. |
| Whiteout | W | Drag over anything (page text, your marks, text you placed) to cover it like correction tape. Double-click a covered area to type replacement text. |
| Check / Cross | C / X | Click a box on the form to tick it or cross it. Three sizes. |
| Sign | S | Draw or type a signature or initials, or stamp today's date. Signatures and initials you save appear in this menu next time. |
| Image | I | Pick a PNG, JPEG, GIF, WebP or BMP. You can also paste an image (Ctrl+V) or drop one on the window. |

**Tabs.** Open several PDFs at once: each opens in its own tab with its own
pages, edits, undo history, search and saving. Open lets you pick more than
one file, and dropping several PDFs on the window opens them all. The + button
opens an empty tab. A dot on a tab means it has unsaved changes, and closing
it asks first.

**Pages.** The panel on the left shows every page. Click one to jump to it,
drag one to reorder, and use the buttons on a page to rotate it or delete it.

**Find.** Ctrl+F searches the document text and highlights every match; Enter
moves to the next one.

**Forms.** If a PDF has fillable fields, they appear as light blue boxes you
can type into, tick or choose from. The values are saved into the fields.

**Saving and printing.** Save (Ctrl+S) writes your edits into the file you
opened, after asking once. Save as (the small button next to Save, or
Ctrl+Shift+S) writes a new file and keeps the original. Print (Ctrl+P) prints
the document with all your edits.

Also: Ctrl+O open, Ctrl+Z undo, Ctrl+Y redo, Delete removes the selected item.

## Known limits

- Text is saved in Helvetica. Characters outside Western European (WinAnsi)
  encoding, such as emoji or CJK, are saved as `?`.
- Password-protected PDFs can't be opened yet.
- Edits are merged on save, so reopening the saved file shows them as part of
  the page, not as editable items.
- Whiteout covers text visually. The original text is still inside the file
  (it can be found by search or copied), so it is not a secure redaction.
- Saving over the original needs the file to be opened with Open or by
  dragging it in from Explorer; otherwise Save works like Save as.

## Developing

Source is React + TypeScript + Vite (the same stack as AppVeyra), with
pdf.js for rendering and pdf-lib for writing the saved PDF.

```
npm ci
npm run dev      # http://127.0.0.1:4317 with hot reload
npm run build    # type-check and rebuild dist/
```

Code map: `src/App.tsx` (toolbar, state, undo, open/save/print),
`src/PageView.tsx` (page rendering, drawing and editing on a page, form
fields), `src/Sidebar.tsx` (page thumbnails), `src/SignatureDialog.tsx`,
`src/search.ts`, `src/print.ts`, `src/save.ts` (merging edits, page changes and
form values into the PDF), `server.mjs` (dependency-free local server used by
the launcher).
