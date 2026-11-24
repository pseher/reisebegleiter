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
