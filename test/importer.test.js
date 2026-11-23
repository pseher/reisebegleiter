import { test } from "node:test";
import assert from "node:assert/strict";
import { berlinIso, importTrip } from "../src/importer.js";

test("berlinIso: Winter- und Sommerzeit", () => {
  assert.equal(berlinIso("2026-11-24", "20:10"), "2026-11-24T19:10:00.000Z");
  assert.equal(berlinIso("2026-07-01", "08:05"), "2026-07-01T06:05:00.000Z");
  assert.equal(berlinIso("2026-07-01", "8"), null);
});

test("Import (Testdaten): zwei Teilstrecken mit Fahrtkennung, Sparpreis erkannt", async () => {
  const r = await importTrip({ MOCK: "1" }, { text: "egal" });
  assert.equal(r.ticket, "spar"); assert.equal(r.trips.length, 1);
  const [a, b] = r.trips[0].legs;
  assert.match(a.jid, /^mock-5/); assert.match(b.jid, /^mock-16/);
  assert.equal(a.to.eva, "8010205"); assert.equal(b.to.name, "München Hbf");
});

test("Ticket ohne Ankunftszeit: Ankunft wird über den Verbindungsplaner ergänzt", async () => {
  const { resolveExtracted } = await import("../src/importer.js");
  const d = new Date(Date.now() + 3600e3), hu = d.getUTCHours();
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(d);
  const h = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", hourCycle: "h23" }).format(d);
  const leg = await resolveExtracted({ MOCK: "1" }, { train: `ICE ${500 + hu}`, from: "Berlin Hbf", dep_date: date, dep_time: `${h}:05`, to: "Leipzig Hbf" }, new Map());
  assert.ok(leg, "Teilstrecke trotz fehlender Ankunft");
  assert.equal(Date.parse(leg.to.plan) - Date.parse(leg.from.plan), 65 * 60e3);
  assert.match(leg.jid, /^mock-5/);
});
