// Reisebegleiter – Service Worker: App startet auch mit schlechtem Netz, Meldungen kommen an
const V = "rb-1";
const SHELL = ["/", "/app.js", "/style.css", "/icon.svg", "/icon-192.png", "/manifest.webmanifest"];
self.addEventListener("install", e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/")) return;
  // Erst Netz (immer aktuell), ohne Netz die gespeicherte Version
  e.respondWith(fetch(r).then(res => { if (res.ok) { const c = res.clone(); caches.open(V).then(x => x.put(r.mode === "navigate" ? "/" : r, c)); } return res; })
    .catch(() => caches.match(r.mode === "navigate" ? "/" : r)));
});
self.addEventListener("push", e => {
  let m = {}; try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(m.title || "Reisebegleiter", { body: m.body || "", tag: m.tag || undefined, renotify: !!m.tag,
    icon: "/icon-192.png", badge: "/icon-192.png", data: { url: m.url || "/" }, requireInteraction: !!m.urgent }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(ws => { const w = ws[0]; if (w) return w.focus(); return clients.openWindow(url); }));
});
