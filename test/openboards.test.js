import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, trainLabel, isoBerlin, findJourney } from "../src/openboards.js";

// Aufbau wie eine echte OpenBoards-Antwort (gekürzt)
const sample = {
  departures: [
    { departureId: "8000237_D_1", evaNumber: "8000237", journeyId: "20261108-abc", time: "2026-11-08T17:08:00+01:00", timeSchedule: "2026-11-08T17:03:00+01:00", timeType: "PREVIEW",
      platform: { name: "7" }, platformSchedule: { name: "6" }, messages: [1, 9],
      journeyInfo: { origin: { evaNumber: "8000237" } },
      transport: { category: "RE", journeyNumber: 11424, line: { name: "RE8" }, direction: { stopPlaces: [{ evaNumber: "8003778" }] },
        via: [{ displayPriority: 2, evaNumber: "8003776" }, { displayPriority: 1, evaNumber: "8003786" }] } },
    { departureId: "378258_D_1", evaNumber: "378258", journeyId: "20261108-sev", time: "2026-11-08T16:59:00+01:00", timeSchedule: "2026-11-08T16:59:00+01:00", timeType: "SCHEDULE",
      platform: {}, platformSchedule: {}, transport: { category: "Bus", journeyNumber: 9324, line: { name: "RE83" }, replacementTransport: { realType: "BUS" } } },
  ],
  stopPlaces: [
    { evaNumber: "8000237", localizedNames: [{ language: "deu", name: "Lübeck Hbf" }] },
    { evaNumber: "8003778", localizedNames: [{ language: "deu", name: "Hamburg Hbf" }] },
    { evaNumber: "8003786", localizedNames: [{ language: "deu", name: "Reinfeld" }] },
  ],
  messages: { attributes: [{ messageID: 1, descriptions: [{ language: "deu", text: "Fahrradmitnahme begrenzt möglich" }] }],
    delays: [{ messageID: 9, descriptions: [{ language: "deu", text: "Reparatur am Zug" }] }] },
};

test("normalize: Zeiten, Gleiswechsel, Richtung, Via, Meldungen", () => {
  const [re, sev] = normalize(sample, "dep");
  assert.equal(re.label, "RE 8"); assert.equal(re.jid, "20261108-abc");
  assert.equal(re.platform, "7"); assert.equal(re.platformPlan, "6"); assert.equal(re.realtime, true);
  assert.equal(Date.parse(re.rt) - Date.parse(re.plan), 5 * 60e3);
  assert.equal(re.direction[0].name, "Hamburg Hbf");
  assert.deepEqual(re.via.map(v => v.name), ["Reinfeld", ""]);
  assert.deepEqual(re.messages, ["Reparatur am Zug"]);
  assert.equal(sev.replacement, true); assert.match(sev.label, /Ersatzverkehr/); assert.equal(sev.realtime, false);
});

test("trainLabel: Fernverkehr mit Zugnummer, Nahverkehr mit Linie", () => {
  assert.equal(trainLabel({ category: "ICE", journeyNumber: 507, line: { name: "ICE 28" } }), "ICE 507");
  assert.equal(trainLabel({ category: "S", journeyNumber: 7123, line: { name: "S5" } }), "S 5");
  assert.equal(trainLabel({ category: "RB", journeyNumber: 1 }), "RB 1");
});

test("isoBerlin: Winter- und Sommerzeit, auf 5 Min. gerundet", () => {
  assert.equal(isoBerlin(Date.parse("2026-11-24T11:07:30Z")), "2026-11-24T12:05:00+01:00");
  assert.equal(isoBerlin(Date.parse("2026-07-01T10:03:00Z")), "2026-07-01T12:00:00+02:00");
});

test("findJourney sucht im Mock nach Prognose und Sollzeit", async () => {
  const env = { MOCK: "1" }, cache = new Map();
  const now = Date.now(), { mockBoard } = await import("../src/mock.js");
  const dep = normalize(mockBoard("dep", { stopPlaceOrStation: { evaNumbers: ["8011160"] }, timeWindow: { timeStart: new Date(now).toISOString() } }), "dep");
  if (!dep.length) return; // keine Abfahrt in diesem 30-Min.-Fenster
  const j = dep[0], hit = await findJourney(env, "arr", "8010205", j.jid, Date.parse(j.plan) + 65 * 60e3, { cache, windows: 3 });
  assert.ok(hit, "Ankunft in Leipzig gefunden"); assert.equal(hit.jid, j.jid);
});
