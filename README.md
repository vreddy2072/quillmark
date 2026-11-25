# Quillmark

A local PDF editor for Windows and Chrome. Open a PDF, add typed text, draw
with a freehand marker, highlight, white out, sign, fill forms, rearrange pages,
and save a new PDF with the edits merged into the pages. Nothing leaves your
computer.

Saved PDFs stay editable in Quillmark: the file also carries the untouched
original and the list of changes, so reopening it in Quillmark brings back
every text box, mark, image and signature as an item you can move, edit or
delete. Other PDF readers just show the finished pages. (Files are about
twice the size because of the stored original. If another program changes
the file afterwards, Quillmark opens it as a normal PDF.)

It comes two ways from the same code: a desktop app (`Start Quillmark.cmd`)
and a Chrome extension (the `extension/` folder).

## Run it

Double-click `Start Quillmark.cmd`. It needs Node.js (24 LTS) and nothing else:
the built app is already in `dist/`, so there is no `npm install` step. The app
opens in its own Microsoft Edge window at http://127.0.0.1:4317. Keep the small
console window open while you work; close it to quit.

## Chrome extension

### Add it to Chrome

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension` folder inside this
   folder (for example `C:\projects\apps\Quillmark\extension`).
4. Click the puzzle-piece icon in Chrome's toolbar and pin **Quillmark**.
5. To open PDFs from File Explorer in Quillmark: click **Details** on the
   Quillmark card and turn on **Allow access to file URLs**. Also make Chrome
   your PDF app in Windows (right-click a PDF, Open with, Choose another app).

The settings page opens the first time. Open it again from the gear in
Quillmark's tab bar, or by right-clicking the toolbar button and picking
**Quillmark settings**.

To update after pulling new code, click the reload arrow on the Quillmark card
in `chrome://extensions`. Chrome may show a reminder about developer-mode
extensions now and then; that is expected for an extension you load yourself.

### How it behaves

- **Toolbar button** opens Quillmark (or switches to it).
- **Tabs setting**: *Quillmark tabs in one Chrome tab* (the default, like the
  desktop app) or *One PDF per Chrome tab*.
- **PDF links** you click on websites open in Quillmark instead of Chrome's
  viewer. Links that download a file still download. Turn this off in settings.
  Right-click any link for **Open link in Quillmark**.
- **Saving**: files opened with Open or dragged in can be saved over the
  original. PDFs opened from a link or File Explorer use Save as.
- Chrome warns at install that Quillmark can "read and change all your data on
  all websites". It needs that to notice PDF links and download them; it does
  not read pages and sends nothing anywhere.
- Saved signatures are kept separately from the desktop app.

## Layout

- **Top bar**: the file name, History, the tools (hover for names and keys),
  Find, Open, Print and Save.
- **Right-hand rail**: page thumbnails on/off, undo, redo, delete, the options
  for the current tool (colour, size, font), the page number and zoom. Zoom
  steps by 25%; click the percentage to type any value from 10% to 400%.
- **Tabs** can be dragged to reorder them, or moved with Ctrl+Shift+PageUp /
  PageDown.
- **History** (clock button) lists recently opened documents. Click one to
  reopen it; Chrome may ask once to let Quillmark view the file again. Remove
  an entry with its x, or Clear the list. History is kept only on this
  computer, separately for the desktop app and the extension.

## Using it

| Tool | Key | What it does |
|------|-----|--------------|
| Select | V | Click an item to select it, drag to move (arrow keys nudge), drag the corner dot to resize. Change its colour, font, size or bold in the bar below. Double-click text to edit it. Drag across the document's own text to select it, then Ctrl+C (or right-click, Copy) to copy it. |
| Text | T | Click anywhere on a page and type. Enter adds a line, Esc finishes. Pick Sans, Serif or Mono, a size and bold. |
| Marker | M | Freehand drawing in five colours and three thicknesses. |
| Highlight | H | Drag a box over text to highlight it. |
| Whiteout | W | Drag over anything (page text, your marks, text you placed) to cover it like correction tape. Double-click a covered area to type replacement text. |
| Edit PDF text | E | Click a line of the document's own text: it is covered over and the same words appear in a text box, ready to retype. The font and size are matched as closely as the standard fonts allow. (The old words stay hidden under the cover, so search and copy in other readers may still find them.) |
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

Also: Ctrl+O open, Ctrl+Z undo, Ctrl+Y redo, Delete removes the selected item, Ctrl+C copies selected document text, Ctrl+V pastes copied text (as a text box you can drag and double-click to edit) or a copied image onto the page you are looking at.

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
npm run dev              # http://127.0.0.1:4317 with hot reload
npm run build            # type-check, rebuild dist/ and extension/
npm run build:desktop    # only dist/
npm run build:extension  # only extension/
```

The extension's own files (manifest, background worker, settings page and
icons) are in `extension-src/` and are copied into `extension/` by the build.

Code map: `src/App.tsx` (tabs), `src/Editor.tsx` (one document: toolbar,
state, undo, open/save/print), `src/platform.ts` (desktop vs extension:
settings, opening links, handing files to other Chrome tabs),
`src/PageView.tsx` (page rendering, drawing and editing on a page, form
fields), `src/Sidebar.tsx` (page thumbnails), `src/SignatureDialog.tsx`,
`src/search.ts`, `src/print.ts`, `src/save.ts` (merging edits, page changes and
form values into the PDF), `server.mjs` (dependency-free local server used by
the launcher).
