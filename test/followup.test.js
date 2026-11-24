// Fälle aus der Prüfrunde mit den vier Testpersonen (Erika, Lena, Max, Bernd)
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, diff } from "../src/engine.js";
import { planB, adopt, undoAdopt } from "../src/monitor.js";

const T0 = Date.parse("2026-11-24T12:00:00+01:00");
const iso = min => new Date(T0 + min * 60e3).toISOString();
const MIN = 60e3;
const trip = (obs = [], ticket = "spar") => ({
  id: "t1", ticket, obs, legs: [
    { jid: "a", label: "ICE 507", from: { eva: "8011160", name: "Berlin Hbf", plan: iso(0), platform: "14" }, to: { eva: "8010205", name: "Leipzig Hbf", plan: iso(70), platform: "12" } },
    { jid: "b", label: "ICE 1601", from: { eva: "8010205", name: "Leipzig Hbf", plan: iso(87), platform: "10" }, to: { eva: "8000261", name: "München Hbf", plan: iso(285), platform: "19" } },
  ],
});
const late = d => [{ dep: { rt: iso(d), t: 1, live: true }, arr: { rt: iso(70 + d), t: 1, live: true } }, {}];

test("verpasster Anschluss bleibt verpasst – kein „Alles läuft nach Plan“, kein „Angekommen“", () => {
  const t = trip(late(25));
  for (const m of [90, 120, 290, 320]) {
    const v = evaluate(t, T0 + m * MIN);
    assert.equal(v.transfers[0].status, "LOST", `Minute ${m}`);
    assert.notEqual(v.title, "Alles läuft nach Plan");
    assert.notEqual(v.phase, "done");
  }
  const v = evaluate(t, T0 + 100 * MIN);
  assert.match(v.title, /verpasst/);
  assert.equal(v.next.kind, "lost");
});

test("pünktlich umgestiegen gilt weiter als erledigt", () => {
  const v = evaluate(trip(late(5)), T0 + 120 * MIN);
  assert.equal(v.transfers[0].status, "DONE");
  assert.equal(v.status, "OK");
});

test("deutliche Verspätung am Ziel ist nicht grün", () => {
  const t = trip([{}, { dep: { rt: iso(87), t: 1, live: true }, arr: { rt: iso(285 + 22), t: 1, live: true } }]);
  const v = evaluate(t, T0 + 150 * MIN);
  assert.equal(v.status, "WATCH");
  assert.match(v.title, /22 Min\. später am Ziel/);
});

test("Erinnerung bei verpasstem Anschluss sagt nicht „umsteigen“", () => {
  const t = trip(late(25)), now = T0 + (70 + 25 - 4) * MIN;
  const { msgs } = diff(t, evaluate(t, now), { tr: [{ conf: "LOST", sent: "LOST" }], zb: true }, now);
  const r = msgs.find(m => /^Gleich/.test(m.title));
  assert.ok(r); assert.doesNotMatch(r.title, /umsteigen/); assert.match(r.body, /klappt nicht/);
});

test("Zugbindung wird genau einmal gemeldet, zusammen mit dem Grund", () => {
  const t = trip(late(25));
  let st = {}, all = [];
  for (const m of [60, 61, 62, 63]) { const now = T0 + m * MIN, d = diff(t, evaluate(t, now), st, now); st = d.state; all.push(...d.msgs); }
  const zb = all.filter(m => /Zugbindung/.test(m.title + m.body));
  assert.equal(zb.length, 1);
  assert.match(zb[0].title, /Anschluss/);
});

test("Gefährdet-Meldung: kurz, mit Vorschlag und Minutenunterschied", () => {
  const t = trip(late(13)), now = T0 + 40 * MIN;
  const alt = [{ kind: "stay", label: "ICE 507", at: "Leipzig Hbf", dep: iso(84), arr: iso(281), toName: "München Hbf" }];
  let st = { alt: { 0: alt } }, msgs = [];
  for (const m of [40, 41]) { const n = T0 + m * MIN, d = diff(t, evaluate(t, n), st, n); st = { ...d.state, alt: { 0: alt } }; msgs.push(...d.msgs); }
  const w = msgs.find(m => /gefährdet/.test(m.title));
  assert.ok(w, JSON.stringify(msgs));
  assert.match(w.body, /sitzen bleiben/i); assert.match(w.body, /4 Min\. früher/); assert.match(w.body, /Sparpreis/);
});

// Testdaten: ICE 5xx fährt Berlin → Leipzig → … → München, ICE 16xx ab Leipzig
const env = { MOCK: "1" };
const H = Math.floor(Date.now() / 3600e3) * 3600e3 + 24 * 3600e3;   // eine volle Stunde morgen
const at = m => new Date(H + m * MIN).toISOString();
const hh = new Date(H).getUTCHours();
const mockTrip = () => ({ id: "m1", ticket: "flex", obs: [], state: {}, legs: [
  { jid: "x", label: `ICE ${500 + hh}`, from: { eva: "8011160", name: "Berlin Hbf", plan: at(5), platform: "14" }, to: { eva: "8010205", name: "Leipzig Hbf", plan: at(70), platform: "12" } },
  { jid: "y", label: `ICE ${1600 + hh}`, from: { eva: "8010205", name: "Leipzig Hbf", plan: at(87), platform: "10" }, to: { eva: "8000261", name: "München Hbf", plan: at(260), platform: "19" } },
] });

test("Plan B unterwegs bietet „Sitzen bleiben“ an, wenn der eigene Zug weiterfährt", async () => {
  const t = mockTrip();
  t.obs = [{ dep: { rt: at(18), live: true, t: 1 }, arr: { rt: at(83), live: true, t: 1 } }, {}];   // +13
  const now = H + 40 * MIN, v = evaluate(t, now);
  const alts = await planB(env, t, v, 0, now);
  assert.equal(alts[0]?.kind, "stay", JSON.stringify(alts.map(a => a.kind + " " + a.label)));
  assert.ok(Date.parse(alts[0].arr) >= H + 258 * MIN, "Ankunft mit Verspätung");
});

test("Sitzen bleiben übernehmen verlängert den Zug; Meldungsstand zurückgesetzt; Rückgängig", async () => {
  const t = mockTrip();
  t.obs = [{ dep: { rt: at(18), live: true, t: 1 }, arr: { rt: at(83), live: true, t: 1 } }, {}];
  const now = H + 40 * MIN, v = evaluate(t, now);
  t.state = { alt: { 0: await planB(env, t, v, 0, now) }, pl: { d0: "14", d1: "11" }, legC: { 1: true }, rem: { 0: true } };
  await adopt(env, t, 0, 0);
  assert.equal(t.legs.length, 1);
  assert.equal(t.legs[0].to.name.startsWith("München"), true);
  assert.deepEqual(t.state.pl, { d0: "14" }); assert.deepEqual(t.state.legC, {});
  undoAdopt(t);
  assert.equal(t.legs.length, 2); assert.equal(t.legs[1].label, `ICE ${1600 + hh}`);
});

test("Ausfall einer Reise ohne Umstieg: nie „Angekommen“", () => {
  const t = { id: "s", ticket: "flex", legs: [trip().legs[0]], obs: [{ dep: { c: true, t: 1, live: true }, arr: { c: true, t: 1, live: true } }] };
  const v = evaluate(t, T0 + 200 * MIN);
  assert.notEqual(v.phase, "done"); assert.match(v.title, /fällt aus/);
});

test("nach „Sitzen bleiben“ zählt die ursprünglich gebuchte Ankunft", () => {
  const t = { id: "s", ticket: "spar", legs: [{ ...trip().legs[0], to: { eva: "8000261", name: "München Hbf", plan: iso(281), platform: "18" } }],
    obs: [{ dep: { rt: iso(13), t: 1 }, arr: {} }], state: { origArr: iso(285) } };
  const v = evaluate(t, T0 + 100 * MIN);
  assert.equal(v.finalDelay, 9); assert.equal(v.status, "OK");
});

test("Plan B vor der Abfahrt auch, wenn die Reise an einer Haltestelle ohne DB-Nummer beginnt", async () => {
  const t = mockTrip();
  // Start „Haltestelle“ nahe Berlin Hbf, ohne eva; Umstieg kürzer als die eigene Umstiegszeit → zu knapp
  t.legs[0] = { ...t.legs[0], jid: "", from: { eva: "", name: "Bushaltestelle", plan: at(5), lat: 52.526, lon: 13.37 } };
  t.legs.forEach(l => (l.minT = 18));
  const now = H - 9 * 3600e3, v = evaluate(t, now);
  assert.ok(["RISK", "WATCH"].includes(v.transfers[0].status), v.transfers[0].status);
  const alts = await planB(env, t, v, 0, now);
  assert.ok(alts.length > 0, "keine Alternativen");
  assert.ok(alts.every(a => a.from === "start"));
});

import { changesFV, isFV } from "../src/engine.js";
test("Zugbindung nur bei anderem Fernzug – Bus/S-Bahn/RE sind frei", () => {
  const L = (label, plan, mode = "") => ({ label, mode, from: { plan } });
  const plan = [L("Bus M19", "2026-11-24T07:56"), L("RE 1", "2026-11-24T08:16"), L("ICE 840", "2026-11-24T08:50")];
  assert.equal(changesFV(plan, [L("Bus X10", "2026-11-24T07:54"), L("S 5", "2026-11-24T08:10"), L("ICE 840", "2026-11-24T08:50")]), false);
  assert.equal(changesFV(plan, [L("Bus M19", "2026-11-24T07:46"), L("ICE 842", "2026-11-24T09:50")]), true);
  assert.equal(isFV(L("RE 1")), false); assert.equal(isFV(L("IC 2037")), true); assert.equal(isFV(L("S 5")), false);
});

test("gleicher ICE, anderer Zustiegsbahnhof ist kein anderer Fernzug", () => {
  const L = (label, plan) => ({ label, from: { plan } });
  assert.equal(changesFV([L("ICE 1540", "2026-11-23T22:42:00Z")], [L("Bus 115", "2026-11-23T22:23:00Z"), L("S 1", "2026-11-23T22:30:00Z"), L("ICE 1540", "2026-11-23T22:20:00Z")]), false);
});

test("„Zug verpasst“: Status Handeln, kein Umsteigen-Hinweis, keine Meldungen zur alten Verbindung", () => {
  const t = { ...trip(), state: { missed: { i: 0, at: T0 } } };
  const v = evaluate(t, T0 + 2 * MIN);
  assert.equal(v.status, "LOST"); assert.match(v.title, /verpasst/); assert.equal(v.next.kind, "missed");
  assert.equal(evaluate(t, T0 + 400 * MIN).phase, "enroute");   // nie „Angekommen“ mit dem verpassten Zug
});

import { platWord, isStreet } from "../src/engine.js";
test("Busse haben Steige statt Gleise, Steigwechsel wird nicht gemeldet", () => {
  assert.equal(platWord({ label: "Bus M29", mode: "BUS" }, "Pos. 8+9"), "Steig 8+9");
  assert.equal(platWord({ label: "RE 1" }, "4"), "Gleis 4");
  assert.equal(isStreet({ label: "Tram M10" }), true); assert.equal(isStreet({ label: "S 7" }), false);
  const T = Date.now() + 30 * MIN, iso2 = m => new Date(T + m * MIN).toISOString();
  const t = { id: "b", ticket: "flex", state: {}, obs: [{ dep: { rt: iso2(0), pl: "Pos. 8+9", t: 1, live: true } }],
    legs: [{ jid: "", tid: "x", label: "Bus M29", mode: "BUS", from: { eva: "", name: "Roseneck", plan: iso2(0), platform: "Pos. 3" }, to: { eva: "", name: "Halensee", plan: iso2(8) } }] };
  const now = Date.now(), v = evaluate(t, now), d = diff(t, v, { pl: {} }, now);
  assert.ok(!d.msgs.some(m => /Gleiswechsel/.test(m.title)), JSON.stringify(d.msgs));
});

test("Bus → S-Bahn an derselben Station: kein Fehlalarm durch aufgeblähten Fußweg", () => {
  const T = (h, m) => new Date(Date.UTC(2026, 10, 24, h - 1, m)).toISOString();
  const leg = (label, mode, from, to, dep, arr, a, b, walk) => ({ label, mode, walk,
    from: { name: from, plan: dep, lat: a[0], lon: a[1] }, to: { name: to, plan: arr, lat: b[0], lon: b[1] } });
  const trip = { id: "x", legs: [
    leg("Bus 115", "BUS", "Elsterplatz (Berlin)", "S Hohenzollerndamm (Berlin)", T(9, 57), T(10, 6), [52.47, 13.29], [52.4885, 13.3001], 12),
    leg("S 42", "SUBURBAN", "Hohenzollerndamm (Berlin)", "Südkreuz", T(10, 18), T(10, 30), [52.4889, 13.2990], [52.475, 13.365], 0)] };
  const ev = evaluate(trip, new Date(T(9, 40)));
  assert.equal(ev.transfers[0].samePlace, true);
  assert.ok(ev.transfers[0].walk <= 4, "Fußweg aus Entfernung: " + ev.transfers[0].walk);
  assert.notEqual(ev.transfers[0].status, "RISK");
});

test("Alternativen: Bus bekommt Live-Verspätung je Teilstrecke", async () => {
  const { watchAlts } = await import("../src/monitor.js");
  const now = Date.UTC(2026, 10, 24, 8, 0), iso = m => new Date(now + m * 60e3).toISOString();
  const alt = { dep: iso(20), arr: iso(40), legs: [{ label: "Bus 115", mode: "BUS", rail: false, tripId: "x",
    from: { name: "Elsterplatz", plan: iso(20), lat: 52.47, lon: 13.29 }, to: { name: "Hohenzollerndamm", plan: iso(40), lat: 52.49, lon: 13.30 } }] };
  await watchAlts({ MOCK: "1" }, [alt], now);
  assert.equal(alt.watch.legs[0].live, true);
  assert.equal(alt.watch.legs[0].delay, 2);
  assert.equal(alt.watch.arrDelay, 2);
});

test("Freiwillig späteren Plan gewählt: Zugbindung bleibt bestehen", () => {
  const T = (h, m) => new Date(Date.UTC(2026, 10, 24, h - 1, m)).toISOString();
  const trip = { id: "z", ticket: "spar", state: { origArr: T(13, 15) }, legs: [
    { label: "ICE 707", mode: "HIGHSPEED_RAIL", jid: "j", from: { name: "Berlin Hbf", plan: T(11, 55) }, to: { name: "Bamberg", plan: T(14, 16) } }] };
  const v = evaluate(trip, new Date(T(6, 33)));
  assert.equal(v.finalDelay, 61);
  assert.equal(v.zbLifted, false);
  assert.equal(evaluate({ ...trip, state: { ...trip.state, zbAt: T(6, 0) } }, new Date(T(6, 33))).zbLifted, true);
});

test("Verkehrsmittel richtig benannt", async () => {
  const { vehicle } = await import("../src/engine.js");
  assert.equal(vehicle({ mode: "BUS", label: "X10" }).dein, "deinen Bus");
  assert.equal(vehicle({ label: "Tram M10" }).n, "Tram");
  assert.equal(vehicle({ mode: "SUBWAY", label: "U7" }).fest, "Feste U-Bahn");
  assert.equal(vehicle({ mode: "HIGHSPEED_RAIL", label: "ICE 707" }).dein, "deinen Zug");
  assert.equal(vehicle({ mode: "SUBURBAN", label: "S 42" }).n, "Zug");
});

test("Mehrere Meldungen einer Fahrt → eine Mitteilung, die dringende zuerst", async () => {
  const { bundle } = await import("../src/monitor.js");
  const m = bundle([{ title: "🛤️ Gleiswechsel", body: "Jetzt Gleis 5." }, { title: "❌ Anschluss in Leipzig klappt nicht", body: "ICE 1601 fährt schon.", urgent: true }]);
  assert.match(m.title, /klappt nicht/); assert.match(m.body, /Außerdem: Gleiswechsel: Jetzt Gleis 5/); assert.equal(m.urgent, true);
});

test("Reiner bahn.de-Link (vbid) wird freundlich erklärt statt Fehler", async () => {
  const { importTrip, onlyBahnLink } = await import("../src/importer.js");
  assert.ok(onlyBahnLink("https://www.bahn.de/buchung/start?vbid=b17ac62b-7275-4637-97c3-9ea72ec58a25"));
  assert.ok(!onlyBahnLink("Meine Reise: ICE 507 Berlin Hbf 12:00 → Leipzig 13:10 https://www.bahn.de/buchung/start?vbid=x"));
  await assert.rejects(importTrip({ MOCK: "1" }, { text: "https://www.bahn.de/buchung/start?vbid=b17ac62b" }), e => e.user && /Screenshot/.test(e.message));
});

test("Einlesen: Bushaltestellen wie „Bahnhof, Nauen“ werden dem richtigen Ort zugeordnet, nicht „Berlin Anhalter Bahnhof“", async () => {
  const { station } = await import("../src/importer.js");
  assert.equal(station("Bahnhof, Nauen")?.name, "Nauen");
  assert.equal(station("Bahnhof, Stendal")?.name, "Stendal Hbf");
  assert.equal(station("Berlin Jungfernheide (S)")?.eva, "8011167");
  assert.equal(station("Bahnhof"), null);
  assert.equal(station("Markt, Nauen"), null);
  assert.equal(station("Berlin Hbf (tief)")?.name, "Berlin Hbf");
});
