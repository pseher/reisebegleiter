import { test } from "node:test";
import assert from "node:assert/strict";
import { simplify, legLabel, connections, resolveConnection } from "../src/routing.js";

test("legLabel: Fernverkehr mit Zugnummer, S-Bahn mit Linie", () => {
  assert.equal(legLabel({ mode: "HIGHSPEED_RAIL", routeShortName: "ICE", tripShortName: "1234" }), "ICE 1234");
  assert.equal(legLabel({ mode: "SUBURBAN", routeShortName: "S2" }), "S 2");
  assert.equal(legLabel({ mode: "BUS", routeShortName: "M85" }), "M 85");
  assert.equal(legLabel({ mode: "REGIONAL_RAIL", displayName: "RE1" }), "RE 1");
});

test("simplify: Fußwege werden Gehzeit, Umstiege gezählt", () => {
  const c = simplify({ itineraries: [{ startTime: "2026-11-24T19:10:00Z", endTime: "2026-11-24T21:00:00Z", duration: 6600, legs: [
    { mode: "WALK", duration: 120 },
    { mode: "SUBURBAN", routeShortName: "S2", from: { name: "Südkreuz", lat: 52.475, lon: 13.365, scheduledDeparture: "2026-11-24T19:10:00Z" }, to: { name: "Berlin Hbf", lat: 52.525, lon: 13.369, scheduledArrival: "2026-11-24T19:22:00Z" } },
    { mode: "WALK", duration: 420 },
    { mode: "HIGHSPEED_RAIL", routeShortName: "ICE", tripShortName: "845", from: { name: "Berlin Hbf", lat: 52.525, lon: 13.369, scheduledDeparture: "2026-11-24T19:40:00Z", track: "14" }, to: { name: "Magdeburg Hbf", lat: 52.13, lon: 11.627, scheduledArrival: "2026-11-24T21:00:00Z" } },
  ] }] })[0];
  assert.equal(c.transfers, 1); assert.equal(c.legs[0].walk, 7); assert.equal(c.legs[1].label, "ICE 845"); assert.equal(c.legs[1].from.track, "14");
});

test("Testdaten: Berlin → München mit Umstieg, Bahn-Teilstrecken bekommen Fahrtkennungen", async () => {
  const env = { MOCK: "1" };
  const cs = await connections(env, "8011160", "8000261", Date.now());
  const c = cs.find(x => x.transfers === 1);
  assert.ok(c, "Verbindung mit Umstieg gefunden");
  const legs = await resolveConnection(env, c.legs);
  assert.equal(legs.length, 2);
  assert.match(legs[0].jid, /^mock-5/); assert.match(legs[1].jid, /^mock-16/);
  assert.equal(legs[0].to.eva, "8010205"); assert.equal(legs[1].from.eva, "8010205");
});
