// Geräte verbinden: zwei Geräte, ein Konto – gleiche Reisen und Favoriten
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

const env = { MOCK: "1" };
const call = async (path, { auth, method = "GET", body } = {}) => {
  const r = await worker.fetch(new Request(`http://x${path}`, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth.id}.${auth.token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: p => p });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const leg = (h) => { const d = new Date(Date.now() + h * 3600e3), a = new Date(d.getTime() + 3600e3);
  return { jid: "", label: "RE 1", mode: "REGIONAL_RAIL", from: { name: "Berlin Hbf", eva: "8011160", plan: d.toISOString() }, to: { name: "Potsdam Hbf", eva: "8012666", plan: a.toISOString() } }; };

test("Geräte verbinden: Reisen und Favoriten teilen, Code nur einmal, Trennen", async () => {
  const A = (await call("/api/register", { method: "POST", body: { label: "Android-Handy" } })).data;
  const B = (await call("/api/register", { method: "POST", body: { label: "Windows-PC" } })).data;
  const tA = await call("/api/trips", { auth: A, method: "POST", body: { legs: [leg(3)], ticket: "flex" } });
  assert.equal(tA.status, 201, JSON.stringify(tA.data));
  await call("/api/favs", { auth: A, method: "PUT", body: [{ id: "f1", name: "Arbeit" }] });
  await call("/api/favs", { auth: B, method: "PUT", body: [{ id: "f2", name: "Oma" }] });
  assert.equal((await call("/api/trips", { auth: B })).data.length, 0);

  // falscher Code
  assert.equal((await call("/api/link/join", { auth: B, method: "POST", body: { code: "000000" } })).status, 400);
  const { code } = (await call("/api/link/start", { auth: A, method: "POST" })).data;
  assert.match(code, /^\d{6}$/);
  const j = await call("/api/link/join", { auth: B, method: "POST", body: { code } });
  assert.equal(j.status, 200, JSON.stringify(j.data));
  // Code ist verbraucht
  assert.equal((await call("/api/link/join", { auth: B, method: "POST", body: { code } })).status, 400);

  assert.equal((await call("/api/trips", { auth: B })).data.length, 1);
  const favs = (await call("/api/favs", { auth: A })).data.map(f => f.id).sort();
  assert.deepEqual(favs, ["f1", "f2"]);
  const devs = (await call("/api/devices", { auth: B })).data;
  assert.deepEqual(devs.map(d => d.label).sort(), ["Android-Handy", "Windows-PC"]);

  // A trennt B: B hat keinen Zugang mehr
  const bId = devs.find(d => d.me).id;
  assert.equal((await call(`/api/devices/${bId}`, { auth: A, method: "DELETE" })).status, 200);
  assert.equal((await call("/api/trips", { auth: B })).status, 401);
  assert.equal((await call("/api/trips", { auth: A })).data.length, 1);
});

test("Code raten wird nach 5 Fehlversuchen gesperrt", async () => {
  const C = (await call("/api/register", { method: "POST", body: {} })).data;
  for (let i = 0; i < 5; i++) assert.equal((await call("/api/link/join", { auth: C, method: "POST", body: { code: "11111" + i } })).status, 400);
  assert.equal((await call("/api/link/join", { auth: C, method: "POST", body: { code: "111119" } })).status, 429);
});

test("Verbinden übernimmt regelmäßige Fahrten des beitretenden Geräts", async () => {
  const A = (await call("/api/register", { method: "POST", body: {} })).data, B = (await call("/api/register", { method: "POST", body: {} })).data;
  const t = await call("/api/trips", { auth: A, method: "POST", body: { legs: [leg(5)], ticket: "flex" } });
  assert.equal((await call("/api/routines", { auth: A, method: "POST", body: { tripId: t.data.id, days: [1, 2, 3], name: "Test" } })).status, 201);
  const { code } = (await call("/api/link/start", { auth: B, method: "POST" })).data;
  assert.equal((await call("/api/link/join", { auth: A, method: "POST", body: { code } })).status, 200);
  assert.equal((await call("/api/routines", { auth: A })).data.length, 1);
  assert.equal((await call("/api/routines", { auth: B })).data.length, 1);
});

test("Abfragezähler: Überwachung zählt DB-Abfragen, Ansicht nur mit Admin-Schlüssel", async () => {
  const worker = (await import("../src/worker.js")).default, env = { MOCK: "1", ADMIN_KEY: "geheim-geheim-1234" };
  const { runMonitor } = await import("../src/monitor.js");
  const call = async (path, auth, method = "GET", body, extra = {}) => { const r = await worker.fetch(new Request(`http://x${path}`, { method, headers: { ...extra, ...(auth ? { Authorization: `Bearer ${auth.id}.${auth.token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: p => p }); return { s: r.status, j: await r.json() }; };
  const A = (await call("/api/register", null, "POST", {})).j;
  const T = Date.now(), iso = m => new Date(T + m * 60e3).toISOString();
  await call("/api/trips", A, "POST", { ticket: "flex", legs: [{ jid: "a", label: "ICE 1", from: { eva: "8011160", name: "Berlin Hbf", plan: iso(20) }, to: { eva: "8010205", name: "Leipzig Hbf", plan: iso(90) } }] });
  await runMonitor(env);
  assert.equal((await call("/api/admin/stats", null, "GET", null, { "X-Admin-Key": "falsch" })).s, 403);
  const r = await call("/api/admin/stats", null, "GET", null, { "X-Admin-Key": "geheim-geheim-1234" });
  assert.equal(r.s, 200); assert.ok(r.j.rows.length && r.j.rows[0].db > 0 && r.j.rows[0].runs >= 1, JSON.stringify(r.j.rows));
});

test("Fremde kommen nicht an Fahrten, regelmäßige Fahrten oder Geräte anderer; Code-Raten wird auch über neue Geräte gebremst", async () => {
  const worker = (await import("../src/worker.js")).default, env = { MOCK: "1" };
  const call = async (path, auth, method = "GET", body, ip = "10.0.0.1") => { const r = await worker.fetch(new Request(`http://x${path}`, { method, headers: { "CF-Connecting-IP": ip, ...(auth ? { Authorization: `Bearer ${auth.id}.${auth.token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: p => p }); return { s: r.status, j: await r.json() }; };
  const A = (await call("/api/register", null, "POST", {})).j, B = (await call("/api/register", null, "POST", {})).j;
  const T = Date.now(), iso = m => new Date(T + m * 60e3).toISOString();
  const t = (await call("/api/trips", A, "POST", { ticket: "flex", legs: [{ jid: "a", label: "ICE 1", from: { eva: "8011160", name: "Berlin Hbf", plan: iso(20) }, to: { eva: "8010205", name: "Leipzig Hbf", plan: iso(90) } }] })).j;
  const r = (await call("/api/routines", A, "POST", { from: { name: "Berlin Hbf", eva: "8011160" }, to: { name: "Leipzig Hbf", eva: "8010205" }, name: "X", days: [1], winFrom: "07:00", winTo: "08:00" })).j;
  assert.equal((await call("/api/trips", B)).j.length, 0);
  assert.equal((await call(`/api/trips/${t.id}`, B, "DELETE")).s, 404);
  assert.equal((await call(`/api/trips/${t.id}/adopt`, B, "POST", { idx: 0 })).s, 404);
  assert.equal((await call(`/api/routines/${r.id}`, B, "DELETE")).s, 404);
  assert.equal((await call("/api/routines", B)).j.length, 0);
  assert.equal((await call("/api/trips", { id: A.id, token: "falsch-falsch-falsch-falsch" })).s, 401);
  // Raten mit immer neuen Geräten von derselben Adresse: nach 15 Versuchen ist Schluss
  let last = 0;
  for (let i = 0; i < 6; i++) { const X = (await call("/api/register", null, "POST", {}, "10.9.9.9")).j;
    for (let k = 0; k < 3; k++) last = (await call("/api/link/join", X, "POST", { code: String(100000 + i * 10 + k) }, "10.9.9.9")).s; }
  assert.equal(last, 429);
});

test("Abfahrtstafel am Bahnhof zeigt auch Busse von der Haltestelle nebenan", async () => {
  const worker = (await import("../src/worker.js")).default, env = { MOCK: "1" };
  const call = async (path, auth) => { const r = await worker.fetch(new Request(`http://x${path}`, { headers: { "CF-Connecting-IP": "10.0.0.7", ...(auth ? { Authorization: `Bearer ${auth.id}.${auth.token}` } : {}) } }), env, { waitUntil: p => p }); return { s: r.status, j: await r.json() }; };
  const A = (await worker.fetch(new Request("http://x/api/register", { method: "POST", headers: { "CF-Connecting-IP": "10.0.0.7" } }), env, { waitUntil: p => p }).then(r => r.json()));
  const l = (await call(`/api/departures?eva=8011160&time=${encodeURIComponent(new Date().toISOString())}`, A)).j;
  const bus = l.filter(e => e.mode === "BUS");
  assert.ok(bus.length && bus.every(e => e.tripId && e.stop?.name === "Mommsenstraße"), JSON.stringify(l.slice(0, 3)));
  assert.ok(l.every((e, i) => !i || Date.parse(l[i - 1].rt) <= Date.parse(e.rt)));
});

test("Eine Teilstrecke früher fahren: frühere Busse finden und nur diese Teilstrecke tauschen", async () => {
  const worker = (await import("../src/worker.js")).default, env = { MOCK: "1" };
  const call = async (path, auth, method = "GET", body) => { const r = await worker.fetch(new Request(`http://x${path}`, { method, headers: { "CF-Connecting-IP": "10.0.0.8", ...(auth ? { Authorization: `Bearer ${auth.id}.${auth.token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: p => p }); return { s: r.status, j: await r.json() }; };
  const A = (await call("/api/register", null, "POST", {})).j, B = (await call("/api/register", null, "POST", {})).j;
  const T = Date.now(), iso = m => new Date(T + m * 60e3).toISOString();
  const t = (await call("/api/trips", A, "POST", { ticket: "dticket", legs: [
    { jid: "", tid: "orig", label: "Bus M19", mode: "BUS", from: { eva: "", name: "Mommsenstraße", plan: iso(40), lat: 52.5045, lon: 13.3066, stopId: "mock_mommsen" }, to: { eva: "", name: "Adenauerplatz", plan: iso(46), lat: 52.4999, lon: 13.3074 } },
    { jid: "b", label: "RE 1", from: { eva: "8010406", name: "Berlin-Charlottenburg", plan: iso(70) }, to: { eva: "8010224", name: "Magdeburg Hbf", plan: iso(170) } }] })).j;
  const l = (await call(`/api/trips/${t.id}/earlier?leg=0`, A)).j;
  assert.ok(l.length >= 2 && l.every(c => Date.parse(c.from.plan) < Date.parse(iso(40)) && c.to.name === "Adenauerplatz"), JSON.stringify(l));
  assert.equal((await call(`/api/trips/${t.id}/earlier?leg=0`, B)).s, 404);
  assert.equal((await call(`/api/trips/${t.id}/earlier`, A, "POST", { leg: 0, tid: "erfunden", dep: iso(5) })).s, 409);
  const v = (await call(`/api/trips/${t.id}/earlier`, A, "POST", { leg: 0, tid: l[l.length - 1].tid, dep: l[l.length - 1].from.plan })).j;
  assert.ok(v.legs, JSON.stringify(v)); assert.equal(v.legs.length, 2); assert.ok(Math.abs(Date.parse(v.legs[0].dep.plan) - Date.parse(l[l.length - 1].from.plan)) < 60e3); assert.equal(v.legs[1].label, "RE 1"); assert.equal(v.ticket || "dticket", "dticket");
});

test("Reise ändern mit fester Fahrt: neue Anreise, der feste Zug und alles danach bleiben", async () => {
  const worker = (await import("../src/worker.js")).default, env = { MOCK: "1" };
  const call = async (path, auth, method = "GET", body) => { const r = await worker.fetch(new Request(`http://x${path}`, { method, headers: { "CF-Connecting-IP": "10.0.0.9", ...(auth ? { Authorization: `Bearer ${auth.id}.${auth.token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: p => p }); return { s: r.status, j: await r.json() }; };
  const A = (await call("/api/register", null, "POST", {})).j, T = Date.now(), iso = m => new Date(T + m * 60e3).toISOString();
  const bus = (dep, arr) => ({ jid: "", tid: `b${dep}`, label: "Bus M29", mode: "BUS", from: { eva: "", name: "S Halensee", plan: iso(dep), lat: 52.4964, lon: 13.2903 }, to: { eva: "", name: "U Adenauerplatz", plan: iso(arr), lat: 52.4999, lon: 13.3074 } });
  const re = { jid: "b", label: "RE 1", from: { eva: "8010406", name: "Berlin-Charlottenburg", plan: iso(70) }, to: { eva: "8010224", name: "Magdeburg Hbf", plan: iso(170) } };
  const t = (await call("/api/trips", A, "POST", { ticket: "dticket", legs: [bus(40, 46), re] })).j;
  const v = (await call(`/api/trips/${t.id}`, A, "PUT", { keepFrom: 1, legs: [bus(25, 31)] })).j;
  assert.equal(v.legs.length, 2); assert.equal(v.legs[0].dep.plan, iso(25)); assert.equal(v.legs[1].label, "RE 1"); assert.equal(v.legs[1].dep.plan, iso(70));
  const bad = await call(`/api/trips/${t.id}`, A, "PUT", { keepFrom: 1, legs: [bus(70, 80)] });
  assert.equal(bad.s, 400); assert.match(bad.j.error, /festen Zug/);
});

test("Doppelt getippt: dieselbe Reise wird nur einmal angelegt", async () => {
  const worker = (await import("../src/worker.js")).default, env = { MOCK: "1" };
  const call = async (path, auth, method = "GET", body) => { const r = await worker.fetch(new Request(`http://x${path}`, { method, headers: { "CF-Connecting-IP": "10.0.0.10", ...(auth ? { Authorization: `Bearer ${auth.id}.${auth.token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: p => p }); return { s: r.status, j: await r.json() }; };
  const A = (await call("/api/register", null, "POST", {})).j, T = Date.now(), iso = m => new Date(T + m * 60e3).toISOString();
  const legs = [{ jid: "", tid: "t1", label: "Tram 6", mode: "TRAM", from: { eva: "", name: "Magdeburg, Arndtstr.", plan: iso(30), lat: 52.13, lon: 11.62 }, to: { eva: "", name: "Magdeburg, Hauptbahnhof", plan: iso(35), lat: 52.13, lon: 11.63 } }];
  const a = await call("/api/trips", A, "POST", { ticket: "flex", legs }), b = await call("/api/trips", A, "POST", { ticket: "flex", legs });
  assert.equal(a.s, 201); assert.equal(b.j.id, a.j.id);
  assert.equal((await call("/api/trips", A)).j.length, 1);
});

test("Wann muss ich los: Wegzeit vom Standort zum Start (zu Fuß/Auto), nur für eigene Reisen", async () => {
  const worker = (await import("../src/worker.js")).default, env = { MOCK: "1" };
  const call = async (path, auth, method = "GET", body) => { const r = await worker.fetch(new Request(`http://x${path}`, { method, headers: { "CF-Connecting-IP": "10.0.0.11", ...(auth ? { Authorization: `Bearer ${auth.id}.${auth.token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: p => p }); return { s: r.status, j: await r.json() }; };
  const A = (await call("/api/register", null, "POST", {})).j, B = (await call("/api/register", null, "POST", {})).j, T = Date.now(), iso = m => new Date(T + m * 60e3).toISOString();
  const t = (await call("/api/trips", A, "POST", { ticket: "flex", legs: [{ jid: "a", label: "ICE 1", from: { eva: "8011160", name: "Berlin Hbf", plan: iso(90) }, to: { eva: "8010205", name: "Leipzig Hbf", plan: iso(160) } }] })).j;
  const w = (await call(`/api/trips/${t.id}/access`, A, "POST", { lat: 52.5200, lon: 13.3500, mode: "WALK" })).j, c = (await call(`/api/trips/${t.id}/access`, A, "POST", { lat: 52.5200, lon: 13.3500, mode: "CAR" })).j;
  assert.ok(w.min > 5 && w.min < 40 && c.min < w.min, JSON.stringify([w, c]));
  assert.equal((await call(`/api/trips/${t.id}/access`, B, "POST", { lat: 52.52, lon: 13.35, mode: "WALK" })).s, 404);
});

test("Regelmäßige Fahrt: Zeitraum aussetzen und ganze Serie ersetzen", async () => {
  const worker = (await import("../src/worker.js")).default, env = { MOCK: "1" };
  const call = async (path, auth, method = "GET", body) => { const r = await worker.fetch(new Request(`http://x${path}`, { method, headers: { "CF-Connecting-IP": "10.0.0.12", ...(auth ? { Authorization: `Bearer ${auth.id}.${auth.token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: p => p }); return { s: r.status, j: await r.json() }; };
  const A = (await call("/api/register", null, "POST", {})).j;
  const base = { days: [1, 2, 3, 4, 5], from: { eva: "8011160", name: "Berlin Hbf" }, to: { eva: "8010205", name: "Leipzig Hbf" }, winFrom: "07:00", winTo: "08:00" };
  const r = (await call("/api/routines", A, "POST", { ...base, name: "Arbeit" })).j;
  const d = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const s1 = (await call(`/api/routines/${r.id}/skip`, A, "POST", { date: d(3), to: d(9) })).j;
  assert.equal(s1.skip.length, 7);
  const s2 = (await call(`/api/routines/${r.id}/skip`, A, "POST", { date: d(3), to: d(9), on: false })).j;
  assert.equal(s2.skip.length, 0);
  assert.equal((await call("/api/routines", A, "POST", { ...base, name: "Arbeit 2" })).s, 409);   // doppelt
  const n = (await call("/api/routines", A, "POST", { ...base, winFrom: "07:00", winTo: "08:30", name: "Arbeit neu", replace: r.id })).j;
  const all = (await call("/api/routines", A)).j;
  assert.deepEqual(all.map(x => x.name), ["Arbeit neu"]); assert.deepEqual(n.win, ["07:00", "08:30"]);
});

test("Meine Orte: speichern, säubern, nur fürs eigene Konto", async () => {
  const worker = (await import("../src/worker.js")).default, env = { MOCK: "1" };
  const call = async (path, auth, method = "GET", body) => { const r = await worker.fetch(new Request(`http://x${path}`, { method, headers: { "CF-Connecting-IP": "10.0.0.13", ...(auth ? { Authorization: `Bearer ${auth.id}.${auth.token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: p => p }); return { s: r.status, j: await r.json() }; };
  const A = (await call("/api/register", null, "POST", {})).j, B = (await call("/api/register", null, "POST", {})).j;
  const hit = (await call("/api/places/search?q=Musterweg", A)).j[0];
  assert.ok(hit.lat && hit.addr);
  const saved = (await call("/api/places", A, "PUT", [{ id: "p1", icon: "🏠", name: "Zuhause", place: hit, evil: "<x>" }, { id: "p2", name: "ohne Ort" }])).j;
  assert.equal(saved.length, 1); assert.equal(saved[0].evil, undefined);
  assert.equal((await call("/api/places", A)).j[0].name, "Zuhause");
  assert.deepEqual((await call("/api/places", B)).j, []);
});

test("Verbindung teilen: Link ohne Konto abrufen, anderer übernimmt sie, gleicher Link beim zweiten Teilen", async () => {
  const A = (await call("/api/register", { method: "POST", body: { label: "Android-Handy" } })).data;
  const B = (await call("/api/register", { method: "POST", body: { label: "iPhone" } })).data;
  const t = (await call("/api/trips", { auth: A, method: "POST", body: { legs: [leg(5), { ...leg(6.5), label: "RE 7" }], ticket: "flex" } })).data;
  const s1 = await call(`/api/trips/${t.id}/share`, { auth: A, method: "POST" });
  assert.equal(s1.status, 200, JSON.stringify(s1.data));
  assert.match(s1.data.url, /\/\?v=[A-Za-z0-9_-]{8,16}$/);
  assert.equal((await call(`/api/trips/${t.id}/share`, { auth: A, method: "POST" })).data.id, s1.data.id);
  // fremde Reise darf B nicht teilen
  assert.equal((await call(`/api/trips/${t.id}/share`, { auth: B, method: "POST" })).status, 404);
  const g = await call(`/api/shared/${s1.data.id}`);
  assert.equal(g.status, 200);
  assert.equal(g.data.legs.length, 2);
  assert.equal(JSON.stringify(g.data).includes(A.id), false);
  const nb = await call("/api/trips", { auth: B, method: "POST", body: { legs: g.data.legs, ticket: "flex", src: "share" } });
  assert.equal(nb.status, 201, JSON.stringify(nb.data));
  assert.equal((await call("/api/trips", { auth: B })).data.length, 1);
  assert.equal((await call("/api/shared/AAAAAAAAAAA")).status, 404);
});

test("Regelmäßige Fahrt teilen: ohne eigenen Namen, anderer übernimmt Tage und Zeit, doppelt nicht", async () => {
  const A = (await call("/api/register", { method: "POST", body: { label: "Android-Handy" } })).data;
  const B = (await call("/api/register", { method: "POST", body: { label: "iPhone" } })).data;
  const t = (await call("/api/trips", { auth: A, method: "POST", body: { legs: [leg(20)], ticket: "dticket" } })).data;
  const r = (await call("/api/routines", { auth: A, method: "POST", body: { tripId: t.id, name: "Schulweg Testkind", days: [1, 2, 3, 4, 5] } })).data;
  const s = await call(`/api/routines/${r.id}/share`, { auth: A, method: "POST" });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal((await call(`/api/routines/${r.id}/share`, { auth: B, method: "POST" })).status, 404);
  const g = (await call(`/api/shared/${s.data.id}`)).data;
  assert.equal(g.kind, "routine");
  assert.equal(JSON.stringify(g).includes("Testkind"), false);
  assert.deepEqual(g.routine.days, [1, 2, 3, 4, 5]);
  const nb = await call("/api/routines", { auth: B, method: "POST", body: { share: s.data.id, days: g.routine.days } });
  assert.equal(nb.status, 201, JSON.stringify(nb.data));
  assert.equal(nb.data.dep, r.dep);
  assert.equal(nb.data.name, "Nach Potsdam Hbf");
  assert.equal((await call("/api/routines", { auth: B, method: "POST", body: { share: s.data.id, days: g.routine.days } })).status, 409);
});

test("Live-Link: ohne Konto ansehen, ohne Namen, gleicher Link, fremde Reise nicht", async () => {
  const A = (await call("/api/register", { method: "POST", body: { label: "Android-Handy" } })).data;
  const B = (await call("/api/register", { method: "POST", body: { label: "iPhone" } })).data;
  const t = (await call("/api/trips", { auth: A, method: "POST", body: { legs: [leg(2), { ...leg(3.5), label: "RE 7" }], ticket: "flex" } })).data;
  const l1 = await call(`/api/trips/${t.id}/live`, { auth: A, method: "POST" });
  assert.equal(l1.status, 200, JSON.stringify(l1.data));
  assert.match(l1.data.url, /\/live\?i=[A-Za-z0-9_-]{8,16}$/);
  assert.equal((await call(`/api/trips/${t.id}/live`, { auth: A, method: "POST" })).data.id, l1.data.id);
  assert.equal((await call(`/api/trips/${t.id}/live`, { auth: B, method: "POST" })).status, 404);
  const g = await call(`/api/live/${l1.data.id}`);
  assert.equal(g.status, 200, JSON.stringify(g.data));
  assert.equal(g.data.legs.length, 2);
  assert.equal(g.data.phase, "before");
  for (const k of ["id", "rname", "routine", "account_id", "device_id"]) assert.equal(k in g.data, false, k);
  // Live-Code taugt nicht als „Verbindung übernehmen“-Link
  assert.equal((await call(`/api/shared/${l1.data.id}`)).status, 404);
});

test("Mitverfolgen vom Live-Link: Kopie gleicht Echtzeit und Plan-B-Wechsel vom Original ab", async () => {
  const A = (await call("/api/register", { method: "POST", body: { label: "Android-Handy" } })).data;
  const B = (await call("/api/register", { method: "POST", body: { label: "iPhone" } })).data;
  const t = (await call("/api/trips", { auth: A, method: "POST", body: { legs: [leg(2), { ...leg(3.5), label: "RE 7" }], ticket: "flex" } })).data;
  const { id } = (await call(`/api/trips/${t.id}/live`, { auth: A, method: "POST" })).data;
  const f = await call("/api/follow", { auth: B, method: "POST", body: { id } });
  assert.equal(f.status, 201, JSON.stringify(f.data));
  assert.equal(f.data.follow, true);
  assert.equal((await call("/api/follow", { auth: B, method: "POST", body: { id } })).data.existed, true);
  assert.equal((await call("/api/follow", { auth: A, method: "POST", body: { id } })).data.own, true);
  // Absender ändert die Verbindung → Kopie zieht beim nächsten Lauf nach
  const db = await import("../src/db.js"), src = await db.get(env, "rb_trips", t.id);
  const nl = { ...leg(4), label: "RB 53" };
  await db.update(env, "rb_trips", t.id, { legs: [src.legs[0], { ...nl, from: { ...nl.from }, to: { ...nl.to } }] });
  await call("/api/mock/tick");
  const mine = (await call("/api/trips", { auth: B })).data.find(x => x.id === f.data.id);
  assert.equal(mine.legs[1].label, "RB 53");
});

test("Wiederherstellungscode: nach gelöschten Browserdaten alles zurückholen, alter Code nach neuem ungültig", async () => {
  const A = (await call("/api/register", { method: "POST", body: { label: "Android-Handy" } })).data;
  await call("/api/trips", { auth: A, method: "POST", body: { legs: [leg(3)], ticket: "flex" } });
  assert.equal((await call("/api/recovery", { auth: A })).data.has, false);
  const c1 = (await call("/api/recovery", { auth: A, method: "POST" })).data.code;
  assert.match(c1, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  const c2 = (await call("/api/recovery", { auth: A, method: "POST" })).data.code;
  // Browserdaten gelöscht: neues Gerät, neues leeres Konto
  const N = (await call("/api/register", { method: "POST", body: { label: "Android-Handy" } })).data;
  assert.equal((await call("/api/recovery/restore", { auth: N, method: "POST", body: { code: c1 } })).status, 400);
  const r = await call("/api/recovery/restore", { auth: N, method: "POST", body: { code: c2.toLowerCase().replace(/-/g, " ") } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await call("/api/trips", { auth: N })).data.length, 1);
  assert.equal((await call("/api/recovery/restore", { auth: N, method: "POST", body: { code: c2 } })).status, 400);   // schon im Konto
});

test("Verbinden: Wiederherstellungscodes gelten danach nicht mehr", async () => {
  const A = (await call("/api/register", { method: "POST", body: { label: "Android-Handy" } })).data;
  const B = (await call("/api/register", { method: "POST", body: { label: "Windows-PC" } })).data;
  const cA = (await call("/api/recovery", { auth: A, method: "POST" })).data.code;
  const { code } = (await call("/api/link/start", { auth: A, method: "POST" })).data;
  const j = await call("/api/link/join", { auth: B, method: "POST", body: { code } });
  assert.equal(j.data.recReset, true);
  assert.equal((await call("/api/recovery", { auth: A })).data.has, false);
  const N = (await call("/api/register", { method: "POST", body: {} })).data;
  assert.equal((await call("/api/recovery/restore", { auth: N, method: "POST", body: { code: cA } })).status, 400);
});

test("Reise nach London: Zug mit Ziel im Ausland (ohne DB-Nummer) und U-Bahn ohne Kennung werden angenommen", async () => {
  const A = (await call("/api/register", { method: "POST", body: {} })).data;
  const at = h => new Date(Date.now() + h * 3600e3).toISOString();
  const legs = [
    { jid: "20261129-abc", label: "ICE 858", mode: "HIGHSPEED_RAIL", from: { name: "Berlin Hbf", eva: "8011160", plan: at(20) }, to: { name: "Köln Hbf", eva: "8000207", plan: at(25.5) } },
    { jid: "20261129-def", label: "EST 9167", mode: "HIGHSPEED_RAIL", from: { name: "Bruxelles-Midi", eva: "8800004", plan: at(26) }, to: { name: "St-Pancras-International", eva: "", plan: at(28), abroad: true } },
    { label: "U Victoria", mode: "SUBWAY", from: { name: "King's Cross St. Pancras", plan: at(28.3) }, to: { name: "Victoria", plan: at(28.5) } }];
  const r = await call("/api/trips", { auth: A, method: "POST", body: { legs, ticket: "flex" } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
});

test("Reise ändern: mittlere Züge fest, davor und danach neu, neue Umstiegszeit für alle", async () => {
  const A = (await call("/api/register", { method: "POST", body: {} })).data;
  const at = h => new Date(Date.now() + h * 3600e3).toISOString();
  const L = (lab, a, b, f, t) => ({ jid: "", label: lab, mode: "REGIONAL_RAIL", from: { name: f, eva: "", lat: 52.5, lon: 13.4, plan: at(a) }, to: { name: t, eva: "", lat: 52.6, lon: 13.5, plan: at(b) } });
  const t = (await call("/api/trips", { auth: A, method: "POST", body: { legs: [L("Bus 1", 5, 5.5, "A", "B"), L("RE 2", 6, 7, "B", "C"), L("RE 3", 7.5, 8, "C", "D"), L("Bus 4", 8.5, 9, "D", "E")], ticket: "flex" } })).data;
  const r = await call(`/api/trips/${t.id}`, { auth: A, method: "PUT", body: { keep: { a: 1, b: 2 }, pre: [L("Tram 9", 5.2, 5.7, "A", "B")], post: [L("Bus 8", 8.3, 8.8, "D", "E")], minT: 10, ticket: "flex" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.legs.map(l => l.label), ["Tram 9", "RE 2", "RE 3", "Bus 8"]);
  assert.equal(r.data.minT, 10);
  const bad = await call(`/api/trips/${t.id}`, { auth: A, method: "PUT", body: { keep: { a: 1, b: 2 }, pre: [L("Tram 9", 5.8, 6.5, "A", "B")], post: [], ticket: "flex" } });
  assert.equal(bad.status, 400);
});
