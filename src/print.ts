import { pdfjs } from "./pdf";

/**
 * Print a PDF by rendering each page to an image and using the browser's print
 * dialog. Works the same in every browser and keeps page sizes.
 */
export async function printPdf(bytes: Uint8Array, onProgress?: (done: number, total: number) => void) {
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  document.getElementById("print-root")?.remove();
  const root = document.createElement("div");
  root.id = "print-root";
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 200 / 72 }); // 200 dpi
      const c = document.createElement("canvas");
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      await page.render({ canvas: c, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE }).promise;
      const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), "image/png"));
      const img = document.createElement("img");
      img.src = URL.createObjectURL(blob);
      img.style.width = `${vp1.width / 72}in`;
      img.style.height = `${vp1.height / 72}in`;
      await img.decode();
      const sheet = document.createElement("div");
      sheet.className = "print-sheet";
      sheet.appendChild(img);
      root.appendChild(sheet);
      onProgress?.(i, doc.numPages);
    }
    document.body.appendChild(root);
    await new Promise<void>((resolve) => {
      const done = () => {
        window.removeEventListener("afterprint", done);
        root.querySelectorAll("img").forEach((im) => URL.revokeObjectURL(im.src));
        root.remove();
        resolve();
      };
      window.addEventListener("afterprint", done);
      window.print();
    });
  } finally {
    await task.destroy();
  }
}
