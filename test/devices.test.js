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
