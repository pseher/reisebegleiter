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
