// Tiny static server for the built app (dist/). No dependencies, so the app
// runs on any machine with Node.js and no `npm install`.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "dist");
const PORT = Number(process.env.QUILLMARK_PORT ?? 4317);
const HOST = "127.0.0.1";
const URL_ = `http://${HOST}:${PORT}/`;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".json": "application/json",
  ".map": "application/json",
};

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url ?? "/", URL_).pathname);
    let file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    if (path === "/" || !(await stat(file).catch(() => null))?.isFile()) {
      file = join(ROOT, "index.html");
    }
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(500).end("Server error");
  }
});

function openWindow() {
  if (process.env.QUILLMARK_NO_OPEN) return;
  if (process.platform === "win32") {
    // Open as an app window in Microsoft Edge; fall back to the default browser.
    const opts = { shell: true, windowsHide: true, detached: true, stdio: "ignore" };
    spawn(`start "" msedge --app=${URL_}`, opts).on("exit", (code) => {
      if (code) spawn(`start "" ${URL_}`, opts);
    });
  } else {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(cmd, [URL_], { detached: true, stdio: "ignore" }).on("error", () => {});
  }
}

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.log(`Quillmark is already running. Opening ${URL_}`);
    openWindow();
    setTimeout(() => process.exit(0), 1500);
  } else {
    console.error(e);
    process.exit(1);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Quillmark is running at ${URL_}`);
  console.log("Keep this window open while you use Quillmark. Close it to quit.");
  openWindow();
});
