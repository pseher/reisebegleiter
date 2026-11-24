import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, diff, transferMinutes, growthBuffer } from "../src/engine.js";

const T0 = Date.parse("2026-11-24T12:00:00+01:00");
const iso = min => new Date(T0 + min * 60e3).toISOString();
// Berlin 12:00 → Leipzig 13:10 (Gl. 12) | Leipzig 13:27 (Gl. 10) → München 16:45
const trip = (obs = [], ticket = "spar") => ({
  id: "t1", ticket, obs, legs: [
    { jid: "a", label: "ICE 507", from: { eva: "8011160", name: "Berlin Hbf", plan: iso(0), platform: "14" }, to: { eva: "8010205", name: "Leipzig Hbf", plan: iso(70), platform: "12" } },
    { jid: "b", label: "ICE 1601", from: { eva: "8010205", name: "Leipzig Hbf", plan: iso(87), platform: "10" }, to: { eva: "8000261", name: "München Hbf", plan: iso(285), platform: "19" } },
  ],
});
const arrDelay = (d, extra = {}) => [{ dep: { rt: iso(d), t: 1, live: true }, arr: { rt: iso(70 + d), t: 1, live: true, ...extra } }, {}];

test("Umstiegszeit: Knoten, gleiches Gleis, anderer Bahnhofsteil", () => {
  assert.equal(transferMinutes("8010205", "12", "8010205", "10"), 8);
  assert.equal(transferMinutes("8011160", "8", "8011160", "7"), 4);   // Berlin Hbf tief, gleicher Bahnsteig
  assert.equal(transferMinutes("8000001", "3", "8000001", "4"), 3);
  assert.equal(transferMinutes("8000001", "2", "8000001", "2"), 3);
  assert.equal(transferMinutes("8011160", "1", "8098160", "5"), 10);
  assert.equal(growthBuffer(0), 0); assert.equal(growthBuffer(65, 5), 3); assert.equal(growthBuffer(500, 5), 5); assert.equal(growthBuffer(500, 20), 10); assert.equal(growthBuffer(89), 0); assert.equal(growthBuffer(120), 1);
});

test("pünktlich: alles läuft nach Plan, 17 Min. Umstieg", () => {
  const v = evaluate(trip(), T0 + 30 * 60e3);
  assert.equal(v.status, "OK"); assert.equal(v.transfers[0].gap, 17);
  assert.match(v.sub, /Leipzig Hbf klappt, 17 Min/);
});

test("Verspätung 8 Min. kurz vor Leipzig: knapp", () => {
  const v = evaluate(trip(arrDelay(8)), T0 + 70 * 60e3);
  assert.equal(v.transfers[0].gap, 9); assert.equal(v.status, "WATCH");
});

test("gleiche Verspätung zwei Stunden vorher ist riskanter (Puffer wächst)", () => {
  const near = evaluate(trip(arrDelay(8)), T0 + 70 * 60e3), far = evaluate(trip(arrDelay(8)), T0 - 60 * 60e3);
  assert.equal(near.status, "WATCH"); assert.equal(far.status, "RISK");
});

test("Ankunft nach Abfahrt kurz vorher: Anschluss weg, Zugbindung bei Sparpreis", () => {
  const v = evaluate(trip(arrDelay(25)), T0 + 60 * 60e3);
  assert.equal(v.status, "LOST"); assert.equal(v.zbLifted, true); assert.equal(v.finalDelay, null);
  assert.equal(evaluate(trip(arrDelay(25), "flex"), T0 + 60 * 60e3).zbLifted, false);
});

test("Hysterese: Warnung erst nach zwei gleichen Messungen, Entwarnung danach", () => {
  const t = trip(arrDelay(13)), now = T0 + 40 * 60e3;
  const r1 = diff(t, evaluate(t, now), {}, now);
  assert.equal(r1.msgs.filter(m => /Anschluss/.test(m.title)).length, 0);
  const r2 = diff(t, evaluate(t, now + 60e3), r1.state, now + 60e3);
  assert.equal(r2.msgs.filter(m => /gefährdet/.test(m.title)).length, 1);
  const r3 = diff(t, evaluate(t, now + 120e3), r2.state, now + 120e3);
  assert.equal(r3.msgs.filter(m => /Anschluss/.test(m.title)).length, 0, "keine Wiederholung");
  const ok = trip(arrDelay(0));
  const r4 = diff(ok, evaluate(ok, now + 180e3), r3.state, now + 180e3);
  const r5 = diff(ok, evaluate(ok, now + 240e3), r4.state, now + 240e3);
  assert.equal(r5.msgs.filter(m => /klappt wieder/.test(m.title)).length, 1);
});

test("Ausfall des Anschlusszugs: sofort eine Meldung, nicht doppelt", () => {
  const t = trip([{ dep: { rt: iso(0), t: 1 }, arr: { rt: iso(70), t: 1 } }, { dep: { rt: iso(87), c: true, t: 1 } }]);
  const now = T0 + 30 * 60e3, r = diff(t, evaluate(t, now), {}, now);
  assert.equal(evaluate(t, now).status, "LOST");
  assert.equal(r.msgs.filter(m => /fällt aus/.test(m.title)).length, 1);
  assert.equal(r.msgs.filter(m => /nicht zu schaffen/.test(m.title)).length, 0);
});

test("Gleiswechsel beim Einsteigen wird gemeldet, aber nur einmal", () => {
  const t = trip([{ dep: { rt: iso(0), t: 1 }, arr: { rt: iso(70), t: 1 } }, { dep: { rt: iso(87), pl: "11", t: 1 } }]);
  const now = T0 + 20 * 60e3, r1 = diff(t, evaluate(t, now), {}, now);
  assert.equal(r1.msgs.filter(m => /Gleiswechsel/.test(m.title)).length, 1);
  assert.equal(diff(t, evaluate(t, now + 60e3), r1.state, now + 60e3).msgs.filter(m => /Gleiswechsel/.test(m.title)).length, 0);
});

test("Erinnerung 5 Min. vor dem Umstieg mit Anschluss-Gleis", () => {
  const t = trip(), now = T0 + 65 * 60e3, r = diff(t, evaluate(t, now), {}, now);
  const m = r.msgs.find(x => /umsteigen/.test(x.title));
  assert.ok(m); assert.match(m.body, /ICE 1601 von Gleis 10/);
});

test("vor Reisebeginn: Abfahrt +12 wird einmal gemeldet", () => {
  const t = trip([{ dep: { rt: iso(12), t: 1 }, arr: { rt: iso(82), t: 1 } }, {}], "flex"), now = T0 - 30 * 60e3;
  const r = diff(t, evaluate(t, now), {}, now);
  assert.equal(r.msgs.filter(m => /startet später/.test(m.title)).length, 1);
  assert.equal(diff(t, evaluate(t, now + 60e3), r.state, now + 60e3).msgs.filter(m => /startet/.test(m.title)).length, 0);
});

test("Ziel mit 25 Min. Verspätung: Zugbindung-Meldung einmal", () => {
  const t = trip([{}, { dep: { rt: iso(87 + 25), t: 1 }, arr: { rt: iso(285 + 25), t: 1 } }]), now = T0 + 100 * 60e3;
  const r = diff(t, evaluate(t, now), {}, now);
  assert.equal(r.msgs.filter(m => /Zugbindung/.test(m.title)).length, 1);
  assert.equal(diff(t, evaluate(t, now + 60e3), r.state, now + 60e3).msgs.filter(m => /Zugbindung/.test(m.title)).length, 0);
});

test("Abfahrt +22 ohne Ankunftsprognose: Verspätung wird mitgenommen", () => {
  const t = trip([{ dep: { rt: iso(22), t: 1, live: true }, arr: { t: 1 } }, {}]);
  const v = evaluate(t, T0 - 60 * 60e3);
  assert.equal(v.legs[0].arr.delay, 22); assert.equal(v.legs[0].arr.estimated, true);
  assert.equal(v.transfers[0].gap, -5); assert.equal(v.status, "RISK");
});

test("vom Fahrplan geplanter 2-Min.-Umstieg ist knapp, nicht gefährdet – erst Verspätung macht ihn kritisch", () => {
  const legs = [
    { jid: "a", label: "S 41", from: { eva: "8089021", name: "Heidelberger Platz", plan: iso(0), platform: "1" }, to: { eva: "8089047", name: "Westkreuz", plan: iso(5), platform: "11" } },
    { jid: "b", label: "S 7", from: { eva: "8089047", name: "Westkreuz", plan: iso(7), platform: "1" }, to: { eva: "8012666", name: "Potsdam Hbf", plan: iso(29), platform: "6" } },
  ];
  assert.equal(evaluate({ id: "w", ticket: "flex", legs, obs: [] }, T0 - 10 * 60e3).transfers[0].status, "WATCH");
  const late = [{ dep: { rt: iso(2), t: 1, live: true }, arr: { rt: iso(7), t: 1, live: true } }, {}];
  assert.equal(evaluate({ id: "w", ticket: "flex", legs, obs: late }, T0 - 10 * 60e3).transfers[0].status, "RISK");
});

test("eigene Mindest-Umstiegszeit: 9 Min. geplant, ich brauche 10 → zu knapp", () => {
  const t = trip([], "flex"); t.legs = t.legs.map(l => ({ ...l, minT: 10 }));
  const v = evaluate({ ...t, legs: t.legs.map((l, i) => i === 1 ? { ...l, from: { ...l.from, plan: iso(79) } } : l) }, T0 + 60 * 60e3);
  assert.equal(v.transfers[0].gap, 9); assert.equal(v.transfers[0].need, 10); assert.equal(v.transfers[0].status, "RISK");
  const ok = evaluate(t, T0 + 60 * 60e3);   // 17 Min. geplant
  assert.equal(ok.transfers[0].status, "OK");
});

test("8 Min. Umstieg, ich brauche 5, 90 Min. vorher, pünktlich: alles im Plan", () => {
  const legs = [
    { jid: "a", label: "S 7", from: { eva: "1", name: "A", plan: iso(0), platform: "1" }, to: { eva: "8012666", name: "Potsdam Hbf", plan: iso(90), platform: "6" }, minT: 5 },
    { jid: "b", label: "ICE 648", from: { eva: "8012666", name: "Potsdam Hbf", plan: iso(98), platform: "3" }, to: { eva: "8010224", name: "Magdeburg Hbf", plan: iso(160), platform: "8" }, minT: 5 },
  ];
  assert.equal(evaluate({ id: "p", ticket: "flex", legs, obs: [] }, T0).transfers[0].status, "OK");
});

test("3 Min. Verspätung, 14 Min. Umstieg, ich brauche 5: kein Alarm", () => {
  const t = trip([{ dep: { rt: iso(3), t: 1, live: true }, arr: { rt: iso(73), t: 1, live: true } }, {}], "flex");
  t.legs = t.legs.map(l => ({ ...l, minT: 5 }));
  const v = evaluate(t, T0 - 100 * 60e3);
  assert.equal(v.transfers[0].gap, 14); assert.equal(v.transfers[0].status, "OK");
});

test("Pflichtzug: Anschluss weg → eigene Überschrift und Meldung", () => {
  const t = trip(arrDelay(25), "flex"); t.legs[1].must = true;
  const now = T0 + 60 * 60e3, v = evaluate(t, now);
  assert.equal(v.transfers[0].toMust, true); assert.match(v.title, /Fester Zug ICE 1601/);
  const r1 = diff(t, v, {}, now), r2 = diff(t, evaluate(t, now + 60e3), r1.state, now + 60e3);
  assert.ok([...r1.msgs, ...r2.msgs].some(m => /Fester Zug ICE 1601 nicht mehr erreichbar/.test(m.title)));
});

test("Anschluss rechnerisch zu spät (nur geschätzt): ‚wohl nicht zu schaffen‘, Zugbindung absehbar aufgehoben", async () => {
  const { headline } = await import("../src/engine.js");
  const t = trip([{ dep: { rt: iso(22), t: 1, live: true }, arr: { t: 1 } }, {}], "spar");
  const v = evaluate(t, T0 - 60 * 60e3);
  assert.equal(v.status, "RISK");
  assert.equal(v.zbLifted, true);
  assert.match(headline(v, t, T0 - 60 * 60e3).title, /wohl nicht zu schaffen/);
});
