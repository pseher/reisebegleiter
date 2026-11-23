// Testdaten im Format der OpenBoards-Antworten (nur mit MOCK=1, z. B. lokal über `npm run dev`).
// Jede Stunde: ICE 5xx Berlin → Leipzig → Erfurt → Nürnberg → München und ICE 16xx Leipzig → München.
// Verspätungen wechseln je Stunde, damit alle Statusstufen vorkommen.

export const MOCK_STATIONS = [
  { eva: "8011160", name: "Berlin Hbf" }, { eva: "8010050", name: "Bitterfeld" }, { eva: "8010205", name: "Leipzig Hbf" },
  { eva: "8010101", name: "Erfurt Hbf" }, { eva: "8000284", name: "Nürnberg Hbf" }, { eva: "8000261", name: "München Hbf" },
];
const NAME = Object.fromEntries(MOCK_STATIONS.map(s => [s.eva, s.name]));

// [eva, an (Min. ab Stundenbeginn), ab, Gleis]
const LINES = [
  { cat: "ICE", base: 500, stops: [["8011160", null, 5, "14"], ["8010050", 55, 56, "3"], ["8010205", 70, 74, "12"], ["8010101", 115, 117, "2"], ["8000284", 180, 183, "8"], ["8000261", 245, null, "18"]],
    delay: h => [13, 3, 0, 22][h % 4] },
  { cat: "ICE", base: 1600, stops: [["8010205", null, 87, "10"], ["8010101", 130, 132, "3"], ["8000284", 195, 198, "9"], ["8000261", 260, null, "19"]],
    delay: h => [2, 0, 5, 0][h % 4], cancel: h => h % 6 === 5, platformChange: h => h % 4 === 0 ? { "8010205": "11" } : {} },
];

const iso = ms => new Date(ms).toISOString().replace(".000Z", "+00:00");

function journeys(fromMs) {
  const day = Math.floor(fromMs / 864e5) * 864e5, out = [];
  for (let h = -6; h < 30; h++) for (const L of LINES) {
    const t0 = day + h * 3600e3, hh = ((h % 24) + 24) % 24, d = L.delay(hh);
    out.push({ jid: `mock-${L.base + hh}-${t0}`, cat: L.cat, num: L.base + hh, t0, delay: d, cancel: L.cancel?.(hh), pc: L.platformChange?.(hh) || {},
      stops: L.stops.map(([eva, a, dp, pl]) => ({ eva, a: a == null ? null : t0 + a * 60e3, d: dp == null ? null : t0 + dp * 60e3, pl })) });
  }
  return out;
}

export function mockBoard(kind, body) {
  const eva = String(body?.stopPlaceOrStation?.evaNumbers?.[0] || ""), start = Date.parse(body?.timeWindow?.timeStart || new Date().toISOString());
  const end = start + 30 * 60e3, now = Date.now() + (globalThis.RB_MOCK_SHIFT || 0), maxVia = body?.maxViaStops ?? 3, list = [], evas = new Set([eva]);
  for (const j of journeys(start)) {
    const i = j.stops.findIndex(s => s.eva === eva); if (i < 0) continue;
    const s = j.stops[i], plan = kind === "arr" ? s.a : s.d; if (plan == null) continue;
    const rtMs = plan + j.delay * 60e3;
    if (!((plan >= start && plan < end) || (rtMs >= start && rtMs < end))) continue;
    const live = plan - now < 2 * 3600e3, rest = kind === "arr" ? j.stops.slice(0, i).reverse() : j.stops.slice(i + 1);
    const dest = j.stops[j.stops.length - 1].eva, pl = j.pc[eva] && live ? j.pc[eva] : s.pl;
    rest.forEach(x => evas.add(x.eva)); evas.add(dest); evas.add(j.stops[0].eva);
    list.push({
      [kind === "arr" ? "arrivalId" : "departureId"]: `${eva}_${j.num}`, evaNumber: eva, journeyId: j.jid,
      journeyInfo: { origin: { evaNumber: j.stops[0].eva }, destination: { evaNumber: dest }, scheduledStartTime: iso(j.stops[0].d) },
      platform: { name: pl }, platformSchedule: { name: s.pl },
      time: iso(live ? rtMs : plan), timeSchedule: iso(plan), timeType: live ? "PREVIEW" : "SCHEDULE",
      ...(j.cancel && live ? { canceled: true } : {}), messages: j.delay >= 10 && live ? [1] : [],
      transport: { category: j.cat, journeyNumber: j.num, line: { name: `${j.cat} ${j.num}` }, type: "HIGH_SPEED_TRAIN",
        direction: { stopPlaces: [{ evaNumber: kind === "arr" ? j.stops[0].eva : dest }] },
        via: rest.slice(0, maxVia).map((x, k) => ({ displayPriority: k + 1, evaNumber: x.eva })) },
    });
  }
  list.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  return {
    [kind === "arr" ? "arrivals" : "departures"]: list,
    stopPlaces: [...evas].map(e => ({ evaNumber: e, localizedNames: [{ language: "deu", name: NAME[e] || e }] })),
    messages: { attributes: [], delays: [{ messageID: 1, descriptions: [{ language: "deu", text: "Verzögerungen im Betriebsablauf" }] }] },
  };
}

// Verbindungssuche im MOTIS-Format (nur Testdaten): direkt auf einer Linie oder mit Umstieg in Leipzig
const COORD = { "8011160": [52.52559, 13.36955], "8010050": [51.62367, 12.31803], "8010205": [51.34497, 12.38207],
  "8010101": [50.97257, 11.03796], "8000284": [49.44593, 11.08278], "8000261": [48.14031, 11.55827] };
export function mockPlan(params) {
  const from = params.fromEva, to = params.toEva, t = Date.parse(params.time || new Date().toISOString());
  const js = journeys(t).filter(j => j.stops[0].d ? true : true);
  const pl = (eva, ms, pltf) => ({ name: NAME[eva], lat: COORD[eva][0], lon: COORD[eva][1], scheduledDeparture: new Date(ms).toISOString(), scheduledArrival: new Date(ms).toISOString(), track: pltf });
  const leg = (j, a, b) => {
    const sa = j.stops.find(s => s.eva === a), sb = j.stops.find(s => s.eva === b);
    return { mode: "HIGHSPEED_RAIL", routeShortName: j.cat, tripShortName: String(j.num), headsign: NAME[j.stops[j.stops.length - 1].eva],
      from: pl(a, sa.d, sa.pl), to: pl(b, sb.a, sb.pl), scheduledStartTime: new Date(sa.d).toISOString(), scheduledEndTime: new Date(sb.a).toISOString(),
      startTime: new Date(sa.d + j.delay * 60e3).toISOString(), endTime: new Date(sb.a + j.delay * 60e3).toISOString(), duration: (sb.a - sa.d) / 1e3 };
  };
  const on = (j, a, b) => { const i = j.stops.findIndex(s => s.eva === a), k = j.stops.findIndex(s => s.eva === b); return i >= 0 && k > i && j.stops[i].d && j.stops[k].a; };
  const its = [];
  for (const j of js) {
    if (on(j, from, to) && j.stops.find(s => s.eva === from).d >= t) its.push([leg(j, from, to)]);
    if (to !== "8010205" && on(j, from, "8010205") && j.stops.find(s => s.eva === from).d >= t) {
      const arr = j.stops.find(s => s.eva === "8010205").a;
      const j2 = js.filter(x => x !== j && on(x, "8010205", to) && x.stops.find(s => s.eva === "8010205").d >= arr + 5 * 60e3)
        .sort((x, y) => x.stops.find(s => s.eva === "8010205").d - y.stops.find(s => s.eva === "8010205").d)[0];
      if (j2) its.push([leg(j, from, "8010205"), { mode: "WALK", duration: 360 }, leg(j2, "8010205", to)]);
    }
  }
  return { itineraries: its.sort((a, b) => Date.parse(a[0].scheduledStartTime) - Date.parse(b[0].scheduledStartTime)).slice(0, 6).map(legs => {
    const tr = legs.filter(l => l.mode !== "WALK");
    return { startTime: tr[0].startTime, endTime: tr[tr.length - 1].endTime, duration: (Date.parse(tr[tr.length - 1].endTime) - Date.parse(tr[0].startTime)) / 1e3, legs };
  }) };
}
