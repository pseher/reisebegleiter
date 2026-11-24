// Lokaler Testserver mit Testdaten (MOCK=1) – ohne Cloudflare, ohne DB-Schlüssel.
// Aufruf: npm run dev  →  http://localhost:8787
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import worker from "../src/worker.js";

const PUB = new URL("../public/", import.meta.url).pathname, PORT = +process.env.PORT || 8787;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };
const ASSETS = { async fetch(req) {
  let p = normalize(decodeURIComponent(new URL(req.url).pathname)).replace(/^(\.\.[/\\])+/, "");
  if (p.endsWith("/")) p += "index.html";
  try { return new Response(await readFile(join(PUB, p)), { headers: { "Content-Type": TYPES[extname(p)] || "application/octet-stream" } }); }
  catch { return new Response(await readFile(join(PUB, "index.html")), { headers: { "Content-Type": TYPES[".html"] } }); }
} };
const env = { MOCK: "1", ASSETS, ADMIN_KEY: process.env.ADMIN_KEY };
const ctx = { waitUntil: p => p };

http.createServer(async (req, res) => {
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await new Promise(r => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
  const r = await worker.fetch(new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers: req.headers, body }), env, ctx);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PORT, () => console.log(`Reisebegleiter (Testdaten) auf http://localhost:${PORT}`));

setInterval(() => worker.scheduled({}, env, ctx), 60e3);
