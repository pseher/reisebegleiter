// Verbindungssuche über MOTIS (Transitous) und Zuordnung der Bahn-Teilstrecken zu OpenBoards-Fahrten.
// Transitous: ehrenamtlich, Best-Effort, keine kommerzielle Nutzung → für den Familientest. Später eigene MOTIS-Instanz (TRANSITOUS_URL).
import { board, findJourney, isoBerlin, trainLabel } from "./openboards.js";
import { nearest, byEva } from "./stations.js";
import { mockPlan } from "./mock.js";

const MIN = 60e3;
const RAIL = new Set(["RAIL", "HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL", "REGIONAL_FAST_RAIL", "REGIONAL_RAIL", "SUBURBAN"]);
const FV_MODES = new Set(["HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL"]);
const key = s => String(s || "").toUpperCase().replace(/[\s\-]/g, "");
const spaced = s => String(s || "").replace(/^([A-Za-z]+)(\d.*)$/, "$1 $2");

async function motis(env, params) {
  if (env.MOCK === "1") return mockPlan(params);
  const base = env.TRANSITOUS_URL || "https://api.transitous.org";
  const { fromEva, toEva, ...rest } = params;
  const qs = new URLSearchParams(rest).toString();
  for (const v of ["v6", "v5", "v4"]) {
    const r = await fetch(`${base}/api/${v}/plan?${qs}`, { headers: { "User-Agent": "Reisebegleiter/0.1 (kontakt@herdzeit.de)", Accept: "application/json" } });
    if (r.status === 404) continue;
    if (!r.ok) throw new Error(`Verbindungssuche: HTTP ${r.status}`);
    return r.json();
  }
  throw new Error("Verbindungssuche nicht erreichbar");
}

const PREFIX = { BUS: "Bus", COACH: "Bus", TRAM: "Tram", FERRY: "Fähre", SUBWAY: "U", METRO: "U" };
export function legLabel(l) { const s = rawLabel(l), p = PREFIX[l.mode];
  if (!p || new RegExp(`^${p}\\b|^${p}\\s?\\d`, "i").test(s) || (p === "U" && /^U\s?\d/i.test(s))) return s;
  return `${p} ${s.replace(/^(STR|Bus)\s*/i, "")}`;
}
function rawLabel(l) {
  if (PREFIX[l.mode] && PREFIX[l.mode] !== "U") return l.displayName || l.routeShortName || l.tripShortName || "";   // Bus/Tram: Linienname wie M10, X9
  if (l.displayName) return spaced(l.displayName);
  const rs = l.routeShortName || "", ts = l.tripShortName || "";
  if (FV_MODES.has(l.mode) && ts) return `${(l.category?.shortName || rs.split(" ")[0] || "Zug").trim()} ${ts}`;
  return spaced(rs || ts || l.mode);
}

const place = p => ({ name: p.name, lat: p.lat, lon: p.lon, plan: p.scheduledDeparture || p.scheduledArrival || p.departure || p.arrival,
  rt: p.departure || p.arrival, track: p.track || p.scheduledTrack || "" });

// Antwort → einfache Verbindungen (Fußwege werden als Gehzeit an die vorherige Teilstrecke gehängt)
export function simplify(data) {
  return (data.itineraries || []).map(it => {
    const legs = [];
    let walk = 0;
    for (const l of it.legs || []) {
      if (["WALK", "BIKE", "CAR"].includes(l.mode)) { walk += Math.round((l.duration || 0) / 60); continue; }
      if (legs.length && walk) legs[legs.length - 1].walk = walk;
      walk = 0;
      legs.push({ mode: l.mode, rail: RAIL.has(l.mode), label: legLabel(l), num: l.tripShortName || "", line: l.routeShortName || "",
        headsign: l.headsign || "", cancelled: !!l.cancelled,
        from: { ...place(l.from), plan: l.scheduledStartTime || place(l.from).plan, rt: l.startTime },
        to: { ...place(l.to), plan: l.scheduledEndTime || place(l.to).plan, rt: l.endTime } });
    }
    const lead = (it.legs || []).findIndex(l => !["WALK", "BIKE", "CAR"].includes(l.mode));
    const walkStart = Math.round((it.legs || []).slice(0, Math.max(0, lead)).reduce((m, l) => m + (l.duration || 0), 0) / 60);
    return { dep: it.startTime, arr: it.endTime, minutes: Math.round((it.duration || 0) / 60), transfers: Math.max(0, legs.length - 1), walkStart, legs };
  }).filter(c => c.legs.length);
}

// from/to: DB-Bahnhofsnummer oder ein Ort { eva?, lat, lon } (z. B. Bus-Haltestelle ohne DB-Nummer)
const pointOf = x => (x && typeof x === "object" ? (x.eva && byEva(x.eva)) || (x.lat != null && x.lon != null ? { eva: "", lat: +x.lat, lon: +x.lon } : null) : byEva(x));
export async function connections(env, from, to, timeMs, minT = 0, arriveBy = false) {
  const a = pointOf(from), b = pointOf(to);
  if (!a || !b) throw new Error("Bahnhof unbekannt");
  const fromEva = a.eva || "", toEva = b.eva || "";
  const data = await motis(env, { fromPlace: `${a.lat},${a.lon}`, toPlace: `${b.lat},${b.lon}`, time: new Date(timeMs).toISOString(),
    numItineraries: "6", searchWindow: "5400", minTransferTime: String(Math.max(0, Math.min(30, minT | 0))), ...(arriveBy ? { arriveBy: "true" } : {}), detailedTransfers: "false", joinInterlinedLegs: "true", language: "de", fromEva, toEva });
  const seen = new Set();
  return simplify(data).filter(c => !c.legs.some(l => l.mode === "COACH" || l.mode === "AIRPLANE"))   // Fernbus/Flug passen nicht zum Bahnticket
    .filter(c => { const k = c.legs.map(l => `${l.label}@${l.from.plan}`).join("|"); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((x, y) => Date.parse(x.dep) - Date.parse(y.dep)).slice(0, 8);
}

// Bahn-Teilstrecke → OpenBoards-Fahrt (journeyId) an Abfahrts- und Ankunftsbahnhof
export async function resolveLeg(env, l, cache = new Map()) {
  const base = { jid: "", label: l.label, mode: l.mode, walk: l.walk || 0,
    from: { eva: "", name: l.from.name, plan: l.from.plan, platform: l.from.track || "", lat: l.from.lat, lon: l.from.lon },
    to: { eva: "", name: l.to.name, plan: l.to.plan, platform: l.to.track || "", lat: l.to.lat, lon: l.to.lon } };
  if (!l.rail) return base;
  const f = l.from.eva ? byEva(l.from.eva) : nearest(l.from.lat, l.from.lon), t = l.to.eva ? byEva(l.to.eva) : nearest(l.to.lat, l.to.lon);
  if (!f || !t) return base;
  base.from.eva = f.eva; base.to.eva = t.eva;
  const dep = Date.parse(l.from.plan), list = await board(env, "dep", f.eva, isoBerlin(dep - 5 * MIN), { maxVia: 40, cache });
  const digits = String(l.num).replace(/\D/g, "");
  const scored = list.filter(e => Math.abs(Date.parse(e.plan) - dep) <= 2 * MIN).map(e => {
    let s = 0;
    if (digits && String(e.num) === digits) s += 5;
    if (key(e.label) === key(l.label)) s += 4;
    if (l.line && (key(e.line) === key(l.line) || key(e.label) === key(l.line))) s += 3;
    if (e.via.some(v => v.eva === t.eva) || e.direction.some(d => d.eva === t.eva)) s += 2;
    return { e, s };
  }).filter(x => x.s >= 2).sort((a, b) => b.s - a.s);
  const e = scored[0]?.e;
  if (!e) return base;
  const arr = await findJourney(env, "arr", t.eva, e.jid, Date.parse(l.to.plan), { windows: 2, cache, label: e.label, after: dep }).catch(() => null);
  // live: Echtzeit zum Zeitpunkt der Zuordnung (für die Beobachtung von Alternativen)
  return { ...base, jid: e.jid, label: e.label,
    live: { dep: { rt: e.rt, pl: e.platform, c: e.cancelled, rtKnown: e.realtime }, arr: arr ? { rt: arr.rt, pl: arr.platform, c: arr.cancelled, rtKnown: arr.realtime } : null },
    from: { eva: f.eva, name: f.name, plan: e.plan, platform: e.platformPlan || e.platform || base.from.platform, lat: l.from.lat ?? byEva(f.eva)?.lat, lon: l.from.lon ?? byEva(f.eva)?.lon },
    to: { eva: t.eva, name: t.name, plan: arr?.plan || l.to.plan, platform: arr ? (arr.platformPlan || arr.platform) : base.to.platform, lat: l.to.lat ?? byEva(t.eva)?.lat, lon: l.to.lon ?? byEva(t.eva)?.lon } };
}

export async function resolveConnection(env, legs) {
  const cache = new Map(), out = [];
  for (const l of legs.slice(0, 8)) out.push(await resolveLeg(env, l, cache));
  return out;
}

export { trainLabel };

// Haltestellen (Bus, Tram, U-Bahn …) per Name suchen – für Start/Ziel ohne DB-Bahnhof
export async function searchStops(env, q, limit = 6) {
  if (!q || q.trim().length < 3) return [];
  if (env.MOCK === "1") return /halt|platz|str/i.test(q) ? [{ eva: "", id: "mock_mommsen", name: "Mommsenstraße", area: "Berlin", lat: 52.5045, lon: 13.3066, stop: true }] : [];
  const base = env.TRANSITOUS_URL || "https://api.transitous.org";
  const qs = new URLSearchParams({ text: q.trim(), type: "STOP", numResults: String(limit + 4), language: "de" });
  const r = await fetch(`${base}/api/v1/geocode?${qs}`, { headers: { "User-Agent": "Reisebegleiter/0.1 (kontakt@herdzeit.de)", Accept: "application/json" } }).catch(() => null);
  if (!r || !r.ok) return [];
  const list = await r.json().catch(() => []);
  const seen = new Set();
  return (Array.isArray(list) ? list : []).filter(m => m.lat != null && m.lon != null).map(m => {
    const area = (m.areas || []).find(a => a.default)?.name || (m.areas || []).find(a => a.adminLevel <= 8)?.name || "";
    return { eva: "", id: m.id || "", name: m.name, area, lat: +(+m.lat).toFixed(5), lon: +(+m.lon).toFixed(5), stop: true };
  }).filter(x => { const k = `${x.name}|${x.area}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, limit);
}

// ---------- Abfahrten und Fahrtverlauf an beliebigen Haltestellen (Transitous/MOTIS) ----------
async function motisGet(env, path, params) {
  const base = env.TRANSITOUS_URL || "https://api.transitous.org", qs = new URLSearchParams(params).toString();
  for (const v of ["v5", "v4", "v3", "v2", "v1"]) {
    const r = await fetch(`${base}/api/${v}/${path}?${qs}`, { headers: { "User-Agent": "Reisebegleiter/0.1 (kontakt@herdzeit.de)", Accept: "application/json" } }).catch(() => null);
    if (!r || r.status === 404) continue;
    if (!r.ok) throw new Error(`Haltestelle: HTTP ${r.status}`);
    return r.json();
  }
  throw new Error("Haltestellen-Abfahrten nicht erreichbar");
}
const MOCK_STOP = { name: "Mommsenstraße", lat: 52.5045, lon: 13.3066 };
// Haltestellen in der Nähe eines Standorts
export async function stopsNear(env, lat, lon) {
  if (env.MOCK === "1") return [{ eva: "", id: "mock_mommsen", ...MOCK_STOP, area: "Berlin", stop: true, dist: 180 }];
  const d = await motisGet(env, "reverse-geocode", { place: `${lat},${lon}`, type: "STOP" }).catch(() => []);
  const km = m => Math.hypot((m.lat - lat) * 111, (m.lon - lon) * 68);
  return (Array.isArray(d) ? d : []).filter(m => m.lat != null).map(m => ({ eva: "", id: m.id || "", name: m.name, area: (m.areas || []).find(a => a.default)?.name || "",
    lat: +m.lat, lon: +m.lon, stop: true, dist: Math.round(km(m) * 1000) })).filter(x => x.dist < 1500).sort((a, b) => a.dist - b.dist).slice(0, 4);
}
// Abfahrten an einer Haltestelle (gleiches Format wie die DB-Abfahrtstafel, soweit nötig)
export async function stopDepartures(env, stop, fromMs) {
  if (env.MOCK === "1") return [0, 7, 14].map(m => { const t = new Date(fromMs + (m + 3) * 60e3).toISOString();
    return { tripId: `mock_trip_${m}`, label: "Bus M19", mode: "BUS", plan: t, rt: t, platform: "", cancelled: false, direction: [{ name: "Grunewald" }], via: [], realtime: false }; });
  const d = await motisGet(env, "stoptimes", { stopId: stop.id, time: new Date(fromMs).toISOString(), n: "24", arriveBy: "false" });
  return (d.stopTimes || []).map(s => { const p = s.place || {};
    const l = { mode: s.mode, displayName: s.displayName, routeShortName: s.routeShortName, tripShortName: s.tripShortName, category: s.category };
    return { tripId: s.tripId, label: legLabel(l), mode: s.mode || "", plan: p.scheduledDeparture || p.departure, rt: p.departure || p.scheduledDeparture,
      platform: p.track || p.scheduledTrack || "", cancelled: !!(s.cancelled || p.cancelled), direction: [{ name: s.headsign || s.tripTo?.name || "" }], via: [], realtime: !!s.realTime };
  }).filter(x => x.plan && Date.parse(x.rt) >= fromMs - 2 * 60e3);
}
// Halte einer Fahrt nach der Abfahrt an der Haltestelle (für „Wo steigst du aus?“)
export async function tripStops(env, tripId, afterMs) {
  if (env.MOCK === "1") { const t0 = afterMs; return [["Adenauerplatz", 4, 52.4999, 13.3074], ["Wilmersdorfer Str.", 8, 52.5066, 13.3069], ["Berlin Hbf", 22, 52.52559, 13.36955]]
    .map(([name, m, lat, lon]) => ({ name, plan: new Date(t0 + m * 60e3).toISOString(), rt: new Date(t0 + m * 60e3).toISOString(), lat, lon, eva: name === "Berlin Hbf" ? "8011160" : "" })); }
  const d = await motisGet(env, "trip", { tripId });
  const out = [];
  for (const l of d.legs || []) for (const p of [...(l.intermediateStops || []), l.to].filter(Boolean)) {
    const t = p.scheduledArrival || p.arrival; if (!t || Date.parse(t) <= afterMs) continue;
    const st = p.lat != null ? nearest(p.lat, p.lon, 250) : null;   // DB-Bahnhof am selben Ort? (für spätere Echtzeit)
    out.push({ name: p.name, plan: t, rt: p.arrival || t, track: p.track || "", lat: p.lat, lon: p.lon, eva: st?.eva || "" });
  }
  return out;
}

// Haltestelle per Name nachschlagen (MOTIS-Geocoder), bevorzugt nahe einem bekannten Punkt
export async function geocodeStop(env, name, near) {
  if (env.MOCK === "1" || !name) return null;
  const base = env.TRANSITOUS_URL || "https://api.transitous.org";
  const q = new URLSearchParams({ text: String(name).replace(/\s*\((Berlin|tief)\)/g, ""), type: "STOP", numResults: "5", language: "de",
    ...(near ? { place: `${near.lat},${near.lon}`, placeBias: "8" } : {}) });
  const r = await fetch(`${base}/api/v1/geocode?${q}`, { headers: { "User-Agent": "Reisebegleiter/0.1 (kontakt@herdzeit.de)", Accept: "application/json" } }).catch(() => null);
  if (!r || !r.ok) return null;
  const list = await r.json().catch(() => []);
  const dist = m => near ? Math.hypot((m.lat - near.lat) * 111, (m.lon - near.lon) * 68) : 0;
  const hit = (Array.isArray(list) ? list : []).filter(m => m.lat != null && dist(m) < 3).sort((a, b) => dist(a) - dist(b))[0];
  return hit ? { lat: +hit.lat.toFixed(5), lon: +hit.lon.toFixed(5) } : null;
}
