// Regelmäßige Fahrten: Zeitrechnung, Feiertage, Anlegen am Fahrtag
import { test } from "node:test";
import assert from "node:assert/strict";
import { wallToMs, berlinDate, holidayName, offReason, nextRun, makeDue, isoDow } from "../src/routines.js";
import * as db from "../src/db.js";

test("Ortszeit Berlin in Winter und Sommer", () => {
  assert.equal(new Date(wallToMs("2026-11-24", "07:40")).toISOString(), "2026-11-24T06:40:00.000Z");
  assert.equal(new Date(wallToMs("2026-07-01", "07:40")).toISOString(), "2026-07-01T05:40:00.000Z");
  assert.equal(berlinDate(Date.parse("2026-11-24T23:30:00Z")), "2026-11-25");
  assert.equal(isoDow("2026-11-24"), 2);
});

test("Feiertage Berlin", () => {
  assert.equal(holidayName("2026-04-03"), "Karfreitag");
  assert.equal(holidayName("2026-05-25"), "Pfingstmontag");
  assert.equal(holidayName("2026-03-08"), "Frauentag");
  assert.equal(holidayName("2026-11-24"), null);
  const r = { days: [1, 2, 3, 4, 5], dep: "07:40", holidays: true, skip: ["2026-11-26"] };
  assert.equal(offReason(r, "2026-12-25"), "1. Weihnachtstag");
  assert.equal(offReason({ ...r, holidays: false }, "2026-12-25"), null);
  assert.equal(offReason(r, "2026-11-28"), "kein Fahrtag");
  assert.equal(offReason(r, "2026-11-26"), "ausgesetzt");
  // nach der Abfahrt am Dienstag: nächste Fahrt Mittwoch (Donnerstag ausgesetzt)
  assert.equal(nextRun(r, Date.parse("2026-11-24T08:00:00Z")).date, "2026-11-25");
});

test("Am Fahrtag wird die Reise ca. 3 Std. vorher angelegt – nur einmal", async () => {
  const env = { MOCK: "1" };
  const acc = await db.insert(env, "rb_accounts", { favs: [] });
  const tpl = [{ jid: "", label: "ICE 509", mode: "HIGHSPEED_RAIL", from: { name: "Berlin Hbf", eva: "8011160", plan: "2026-11-23T09:05:00Z" },
    to: { name: "Leipzig Hbf", eva: "8010205", plan: "2026-11-23T10:20:00Z" } }];
  const r = await db.insert(env, "rb_routines", { account_id: acc.id, name: "Arbeit hin", days: [1, 2, 3, 4, 5], dep: "10:05", tpl, ticket: "dticket", min_t: 0, holidays: true, paused: false, skip: [], made: [] });
  const at = wallToMs("2026-11-24", "10:05");
  assert.equal((await makeDue(env, at - 4 * 3600e3)).length, 0);
  assert.equal((await db.tripsOf(env, acc.id)).length, 0, "zu früh");
  assert.equal((await makeDue(env, at - 2 * 3600e3)).length, 0, "gleiche Verbindung: keine Meldung");
  const trips = await db.tripsOf(env, acc.id);
  assert.equal(trips.length, 1);
  assert.equal(trips[0].state.routine, r.id);
  assert.equal(trips[0].ticket, "dticket");
  await makeDue(env, at - 1 * 3600e3);
  assert.equal((await db.tripsOf(env, acc.id)).length, 1, "nicht doppelt");
});

test("Fahrplan geändert: nächstgelegene Verbindung mit Hinweis", async () => {
  const env = { MOCK: "1" };
  const acc = await db.insert(env, "rb_accounts", { favs: [] });
  const tpl = [{ jid: "", label: "ICE 999", mode: "HIGHSPEED_RAIL", from: { name: "Berlin Hbf", eva: "8011160", plan: "2026-11-23T09:07:00Z" },
    to: { name: "Leipzig Hbf", eva: "8010205", plan: "2026-11-23T10:20:00Z" } }];
  await db.insert(env, "rb_routines", { account_id: acc.id, name: "Arbeit hin", days: [2], dep: "10:07", tpl, ticket: "flex", min_t: 0, holidays: true, paused: false, skip: [], made: [] });
  const msgs = await makeDue(env, wallToMs("2026-11-24", "10:07") - 3600e3);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].body, /ICE 509, ab 10:05 \(sonst 10:07\)/);
  assert.match((await db.tripsOf(env, acc.id))[0].state.rnote, /andere Verbindung/);
});

test("Zeitfenster: erste Fahrt überwachen, übrige zur Wahl, ohne Wahl keine Meldungen; verpasst → nächste", async () => {
  const env = { MOCK: "1" };
  const { refreshWindow } = await import("../src/routines.js");
  const acc = await db.insert(env, "rb_accounts", { favs: [] });
  await db.insert(env, "rb_routines", { account_id: acc.id, name: "Arbeit", days: [2], dep: "10:00", win_from: "10:00", win_to: "13:00",
    tpl: [{ jid: "", label: "", from: { name: "Berlin Hbf", eva: "8011160" }, to: { name: "Leipzig Hbf", eva: "8010205" } }], ticket: "flex", min_t: 0, holidays: true, paused: false, skip: [], made: [] });
  const t0 = wallToMs("2026-11-24", "10:00");
  await makeDue(env, t0 - 2 * 3600e3);
  const [t] = await db.tripsOf(env, acc.id);
  assert.ok(t.state.win && !t.state.win.picked);
  assert.equal(t.legs[0].label, "ICE 509");
  assert.ok(t.state.win.list.length >= 2, "weitere Fahrten im Fenster");
  // erste Abfahrt (10:05) vorbei, nichts gewählt → nächste Fahrt im Fenster
  await refreshWindow(env, t, wallToMs("2026-11-24", "10:10"));
  assert.equal(t.legs[0].label, "ICE 510");
  assert.ok(!t.state.win.list.some(o => o.label === "ICE 510"));
});

test("Zeitfenster: gewählte spätere Fahrt gilt nicht als Verspätung", async () => {
  const worker = (await import("../src/worker.js")).default, env = { MOCK: "1" };
  const call = async (path, auth, method = "GET", body) => { const r = await worker.fetch(new Request(`http://x${path}`, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth.id}.${auth.token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: p => p }); return r.json(); };
  const A = await call("/api/register", null, "POST", {});
  const dev = await db.get(env, "rb_devices", A.id);
  const day = berlinDate(Date.now() + 864e5), dow = isoDow(day);
  await db.insert(env, "rb_routines", { account_id: dev.account_id, name: "Fenster", days: [dow], dep: "10:00", win_from: "10:00", win_to: "13:00",
    tpl: [{ jid: "", label: "", from: { name: "Berlin Hbf", eva: "8011160" }, to: { name: "Leipzig Hbf", eva: "8010205" } }], ticket: "flex", min_t: 0, holidays: false, paused: false, skip: [], made: [] });
  await makeDue(env, wallToMs(day, "10:00") - 2 * 3600e3);
  const [t] = await call("/api/trips", A);
  assert.ok(t.win && t.win.list.length);
  const v = await call(`/api/trips/${t.id}/adopt`, A, "POST", { win: true, idx: t.win.list.length - 1 });
  assert.ok(v.win.picked);
  assert.ok(!(v.finalDelay >= 3), "keine Verspätung durch die eigene Wahl: " + v.finalDelay);
});

test("Zeitfenster schon angefangen: wird trotzdem angelegt; verpasst → ‚Ich sitze in der …‘ führt zurück", async () => {
  const env = { MOCK: "1" };
  const { refreshWindow } = await import("../src/routines.js");
  const acc = await db.insert(env, "rb_accounts", { favs: [] });
  await db.insert(env, "rb_routines", { account_id: acc.id, name: "Spät", days: [2], dep: "10:00", win_from: "10:00", win_to: "13:00",
    tpl: [{ jid: "", label: "", from: { name: "Berlin Hbf", eva: "8011160" }, to: { name: "Leipzig Hbf", eva: "8010205" } }], ticket: "flex", min_t: 0, holidays: true, paused: false, skip: [], made: [] });
  await makeDue(env, wallToMs("2026-11-24", "10:02"));   // Fenster läuft schon
  const [t] = await db.tripsOf(env, acc.id);
  assert.ok(t, "trotz begonnenem Fenster angelegt");
  const first = t.legs[0].label;
  await refreshWindow(env, t, wallToMs("2026-11-24", "10:10"));
  assert.notEqual(t.legs[0].label, first); assert.equal(t.state.win.prev.label.split(" → ")[0], first);
});

test("Gleiche Strecke zur gleichen Zeit kann man nicht doppelt anlegen", async () => {
  const worker = (await import("../src/worker.js")).default, env = { MOCK: "1" };
  const call = async (path, auth, method = "GET", body) => { const r = await worker.fetch(new Request(`http://x${path}`, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth.id}.${auth.token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: p => p }); return { s: r.status, j: await r.json() }; };
  const A = (await call("/api/register", null, "POST", {})).j;
  const body = { from: { name: "Berlin Hbf", eva: "8011160" }, to: { name: "Leipzig Hbf", eva: "8010205" }, name: "Arbeit", days: [1, 2, 3, 4, 5], winFrom: "07:00", winTo: "08:00" };
  assert.equal((await call("/api/routines", A, "POST", body)).s, 201);
  const r2 = await call("/api/routines", A, "POST", { ...body, name: "Nochmal" });
  assert.equal(r2.s, 409); assert.match(r2.j.error || JSON.stringify(r2.j), /schon überwacht/);
});

test("Fehlt die Fahrt trotz ‚angelegt‘-Vermerk, wird sie einmal nachgeholt; selbst gelöscht heißt: an dem Tag nicht fahren", async () => {
  const env = { MOCK: "1" };
  const acc = await db.insert(env, "rb_accounts", { favs: [] });
  const r = await db.insert(env, "rb_routines", { account_id: acc.id, name: "Abends", days: [2], dep: "22:00", win_from: "22:00", win_to: "22:30",
    tpl: [{ jid: "", label: "", from: { name: "Berlin Hbf", eva: "8011160" }, to: { name: "Leipzig Hbf", eva: "8010205" } }], ticket: "flex", min_t: 0, holidays: true, paused: false, skip: [], made: ["2026-11-24"] });
  await makeDue(env, wallToMs("2026-11-24", "19:30"));
  let mine = (await db.tripsOf(env, acc.id)).filter(t => t.state?.routine === r.id);
  assert.equal(mine.length, 1, "nachgeholt");
  await makeDue(env, wallToMs("2026-11-24", "19:40"));
  assert.equal((await db.tripsOf(env, acc.id)).filter(t => t.state?.routine === r.id).length, 1, "nicht doppelt");
});

test("Nur Nahverkehr: erst 1 Std. vorher anlegen, mit Fernzug 3 Std.", async () => {
  const { leadOf } = await import("../src/routines.js");
  assert.equal(leadOf({ tpl: [{ label: "Bus M19" }, { label: "S 41" }] }), 3600e3);
  assert.equal(leadOf({ tpl: [{ label: "S 41" }, { label: "ICE 509" }] }), 3 * 3600e3);
  assert.equal(leadOf({ tpl: [{ label: "" }] }), 3 * 3600e3);
  assert.equal(leadOf({ tpl: [{ label: "", fv: false }] }), 3600e3, "Zeitfenster ohne Fernzug");
  assert.equal(leadOf({ tpl: [{ label: "", fv: true }] }), 3 * 3600e3, "Zeitfenster mit Fernzug");
});
