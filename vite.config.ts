import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const root = dirname(fileURLToPath(import.meta.url));
const PDFJS = join(root, "node_modules", "pdfjs-dist");

// pdf.js support files (character maps, standard fonts, image decoders) are
// fetched at runtime, so they are copied next to the app under pdfjs/.
// quickjs (PDF JavaScript) is left out: Quillmark never runs scripts in PDFs.
const PDFJS_DIRS = ["cmaps", "standard_fonts", "wasm"];
const skip = (name: string) => name.startsWith("quickjs") || name.startsWith("LICENSE");

function pdfjsAssets(): Plugin {
  let outDir = "dist";
  return {
    name: "quillmark-pdfjs-assets",
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use("/pdfjs", (req, res, next) => {
        const file = join(PDFJS, decodeURIComponent((req.url ?? "").split("?")[0]));
        if (!file.startsWith(PDFJS) || !existsSync(file)) return next();
        res.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : file.endsWith(".js") ? "text/javascript" : "application/octet-stream");
        res.end(readFileSync(file));
      });
    },
    writeBundle() {
      for (const d of PDFJS_DIRS) {
        const dest = join(outDir, "pdfjs", d);
        mkdirSync(dest, { recursive: true });
        for (const f of readdirSync(join(PDFJS, d))) if (!skip(f)) cpSync(join(PDFJS, d, f), join(dest, f));
      }
    },
  };
}

/** The Chrome extension build also copies the manifest, background worker, options page and icons. */
function extensionFiles(): Plugin {
  let outDir = "extension";
  return {
    name: "quillmark-extension-files",
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    writeBundle() {
      cpSync(join(root, "extension-src"), outDir, { recursive: true });
    },
  };
}

export default defineConfig(({ mode }) => {
  const ext = mode === "extension";
  return {
    // Extension pages live at chrome-extension://<id>/, so use relative paths.
    base: ext ? "./" : "/",
    plugins: [react(), pdfjsAssets(), ...(ext ? [extensionFiles()] : [])],
    build: {
      target: "es2023",
      chunkSizeWarningLimit: 2000,
      outDir: ext ? "extension" : "dist",
      emptyOutDir: true,
    },
  };
});
