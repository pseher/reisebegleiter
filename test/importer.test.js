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
