import { test } from "node:test";
import assert from "node:assert/strict";
import { simplify, legLabel, connections, resolveConnection } from "../src/routing.js";

test("legLabel: Fernverkehr mit Zugnummer, S-Bahn mit Linie", () => {
  assert.equal(legLabel({ mode: "HIGHSPEED_RAIL", routeShortName: "ICE", tripShortName: "1234" }), "ICE 1234");
  assert.equal(legLabel({ mode: "SUBURBAN", routeShortName: "S2" }), "S 2");
  assert.equal(legLabel({ mode: "BUS", routeShortName: "M85" }), "Bus M85");
  assert.equal(legLabel({ mode: "BUS", routeShortName: "101" }), "Bus 101");
  assert.equal(legLabel({ mode: "TRAM", routeShortName: "M10" }), "Tram M10");
  assert.equal(legLabel({ mode: "SUBWAY", routeShortName: "U7" }), "U 7");
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

test("Weiterfahren statt laufen: derselbe Bus fährt bis zum Umstieg", async () => {
  const { rideOn } = await import("../src/routing.js");
  const T = m => new Date(Date.UTC(2026, 10, 24, 8, 55 + m)).toISOString();
  const c = { legs: [
    { label: "Bus 310", mode: "BUS", tripId: "t310", walk: 6, from: { name: "Berkaer Str./Breite Str.", plan: T(0) }, to: { name: "Mecklenburgische Str./Binger Str.", lat: 52.4810, lon: 13.3050, plan: T(5) } },
    { label: "S 42", mode: "SUBURBAN", from: { name: "Heidelberger Platz", lat: 52.4797, lon: 13.3122, plan: T(23) }, to: { name: "Südkreuz", plan: T(30) } }] };
  // Testdaten: Trip-Halte nach der Ankunft – der Bus erreicht „S+U Heidelberger Platz“ 1 Min. später
  const env = { MOCK: "0", TRANSITOUS_URL: "http://127.0.0.1:9" };
  const routing = await import("../src/routing.js");
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ legs: [{ intermediateStops: [], to: { name: "S+U Heidelberger Platz", lat: 52.4798, lon: 13.3120, scheduledArrival: T(6), arrival: T(6), stopId: "x" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  try { await rideOn(env, [c], 0); } finally { globalThis.fetch = orig; }
  assert.equal(c.legs[0].to.name, "S+U Heidelberger Platz");
  assert.equal(c.legs[0].walk, 0);
});

test("Weiterfahren auch bei hoher eigener Umstiegszeit, wenn es nicht später ist als zu Fuß", async () => {
  const { rideOn } = await import("../src/routing.js");
  const T = m => new Date(Date.UTC(2026, 10, 24, 9, m)).toISOString();
  const c = { legs: [
    { label: "Bus 249", mode: "BUS", tripId: "t249", walk: 8, from: { name: "Berkaer Str./Breite Str.", plan: T(0) }, to: { name: "Mecklenburgische Str./Binger Str.", lat: 52.4810, lon: 13.3050, plan: T(5) } },
    { label: "S 42", mode: "SUBURBAN", from: { name: "Heidelberger Platz", lat: 52.4797, lon: 13.3122, plan: T(13) }, to: { name: "Südkreuz", plan: T(20) } }] };
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ legs: [{ intermediateStops: [], to: { name: "S+U Heidelberger Platz", lat: 52.4798, lon: 13.3120, scheduledArrival: T(6), arrival: T(6) } }] }), { status: 200 });
  try { await rideOn({ TRANSITOUS_URL: "http://127.0.0.1:9" }, [c], 10); } finally { globalThis.fetch = orig; }
  assert.equal(c.legs[0].to.name, "S+U Heidelberger Platz");
});

test("Umstiegszeit 8: Verbindung, die nur per Fußweg auf 8 Min. kommt, wird durch eine mit echten 8 Min. ersetzt", async () => {
  const { connections } = await import("../src/routing.js");
  const T = m => new Date(Date.UTC(2026, 10, 24, 9, m)).toISOString();
  const P = (name, lat, lon, t) => ({ name, lat, lon, scheduledDeparture: t, scheduledArrival: t, departure: t, arrival: t });
  const it = (busDep, busArr, stopName, lat, lon, walkMin) => ({ startTime: T(busDep), endTime: T(35), duration: 1800, legs: [
    { mode: "BUS", routeShortName: "249", tripId: `b${busDep}`, from: P("Berkaer Str.", 52.47, 13.29, T(busDep)), to: P(stopName, lat, lon, T(busArr)), scheduledStartTime: T(busDep), scheduledEndTime: T(busArr), startTime: T(busDep), endTime: T(busArr) },
    ...(walkMin ? [{ mode: "WALK", duration: walkMin * 60, distance: walkMin * 68 }] : []),
    { mode: "SUBURBAN", routeShortName: "S42", tripId: "s42", from: P("Heidelberger Platz", 52.4797, 13.3122, T(23)), to: P("Südkreuz", 52.475, 13.365, T(35)), scheduledStartTime: T(23), scheduledEndTime: T(35), startTime: T(23), endTime: T(35) }] });
  const orig = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = new URL(url);
    if (u.pathname.includes("/trip")) return new Response(JSON.stringify({ legs: [{ intermediateStops: [], to: { name: "S+U Heidelberger Platz", lat: 52.4798, lon: 13.312, scheduledArrival: T(16), arrival: T(16) } }] }), { status: 200 });
    const mt = +u.searchParams.get("minTransferTime");
    const its = mt <= 8 ? [it(10, 15, "Mecklenburgische Str.", 52.481, 13.305, 8)] : [it(0, 6, "S+U Heidelberger Platz", 52.4798, 13.312, 0)];
    return new Response(JSON.stringify({ itineraries: its }), { status: 200 });
  };
  try {
    const list = await connections({ TRANSITOUS_URL: "http://x" }, { lat: 52.47, lon: 13.29 }, { lat: 52.475, lon: 13.365 }, Date.parse(T(0)), 8);
    assert.equal(list.length, 1);
    assert.equal(list[0].legs[0].from.plan, T(0), "einen Bus früher");
  } finally { globalThis.fetch = orig; }
});
