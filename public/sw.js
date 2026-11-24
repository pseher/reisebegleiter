// Reisebegleiter – Service Worker: App startet auch mit schlechtem Netz, Meldungen kommen an
const V = "rb-77";
const SHELL = ["/", "/app.js", "/style.css", "/icon.svg", "/icon-192.png", "/manifest.webmanifest"];
self.addEventListener("install", e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
// Teilen-Ziel (Android): Inhalte aus „Teilen → Reisebegleiter“ zwischenspeichern, dann App öffnen
async function shareIn(req) {
  const fd = await req.formData(), c = await caches.open("rb-share"), files = [];
  let i = 0;
  for (const f of fd.getAll("files")) { if (!(f instanceof File) || i >= 3) continue; const k = `/share-file-${i++}`; await c.put(k, new Response(f, { headers: { "Content-Type": f.type } })); files.push(k); }
  await c.put("/share-meta", new Response(JSON.stringify({ title: fd.get("title") || "", text: fd.get("text") || "", url: fd.get("url") || "", files })));
  return Response.redirect("/?share=1", 303);
}
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method === "POST" && u.origin === location.origin && u.pathname === "/share") { e.respondWith(shareIn(r)); return; }
  if (r.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/")) return;
  // Erst Netz (immer aktuell), ohne Netz die gespeicherte Version
  // Eigene Seiten (Impressum, Datenschutz, Zähler) nicht als App-Startseite speichern
  if (u.pathname === "/admin.html" || u.pathname.startsWith("/video/")) return;   // Video lädt der Browser stückweise selbst
  const app = r.mode === "navigate" && (u.pathname === "/" || u.pathname === "/index.html"), key = app ? "/" : r;
  // Erst Netz – braucht es länger als 2,5 Sek. (schlechtes Netz), die gespeicherte Version; die frische landet trotzdem im Speicher
  const net = fetch(r).then(res => { if (res.ok) { const c = res.clone(); caches.open(V).then(x => x.put(key, c)); } return res; });
  const saved = () => caches.match(key).then(m => m || (r.mode === "navigate" ? caches.match("/") : undefined));
  e.respondWith(new Promise(resolve => {
    let done = false; const give = x => { if (!done && x) { done = true; resolve(x); } };
    const t = setTimeout(() => saved().then(give), 2500);
    net.then(res => { clearTimeout(t); give(res); }).catch(() => { clearTimeout(t); saved().then(m => { if (m) give(m); else if (!done) { done = true; resolve(Response.error()); } }); });
  }));
});
self.addEventListener("push", e => {
  let m = {}; try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(m.title || "Umstiegsheld", { body: m.body || "", tag: m.tag || undefined, renotify: !!m.tag,
    icon: "/icon-192.png", badge: "/icon-192.png", data: { url: m.url || "/" }, requireInteraction: !!m.urgent }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", self.location.origin).href;
  // Tippen auf die Meldung: direkt zur betroffenen Reise – offene App umschalten, sonst mit dieser Reise starten
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(ws => {
    const w = ws[0];
    if (!w) return clients.openWindow(url);
    w.postMessage({ open: url });
    return w.focus().catch(() => clients.openWindow(url));
  }));
});
