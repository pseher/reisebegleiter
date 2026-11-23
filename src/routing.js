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

export function legLabel(l) {
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
    return { dep: it.startTime, arr: it.endTime, minutes: Math.round((it.duration || 0) / 60), transfers: Math.max(0, legs.length - 1), legs };
  }).filter(c => c.legs.length);
}

export async function connections(env, fromEva, toEva, timeMs, minT = 0) {
  const a = byEva(fromEva), b = byEva(toEva);
  if (!a || !b) throw new Error("Bahnhof unbekannt");
  const data = await motis(env, { fromPlace: `${a.lat},${a.lon}`, toPlace: `${b.lat},${b.lon}`, time: new Date(timeMs).toISOString(),
    numItineraries: "6", searchWindow: "5400", minTransferTime: String(Math.max(0, Math.min(30, minT | 0))), detailedTransfers: "false", joinInterlinedLegs: "true", language: "de", fromEva, toEva });
  const seen = new Set();
  return simplify(data).filter(c => !c.legs.some(l => l.mode === "COACH" || l.mode === "AIRPLANE"))   // Fernbus/Flug passen nicht zum Bahnticket
    .filter(c => { const k = c.legs.map(l => `${l.label}@${l.from.plan}`).join("|"); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((x, y) => Date.parse(x.dep) - Date.parse(y.dep)).slice(0, 8);
}

// Bahn-Teilstrecke → OpenBoards-Fahrt (journeyId) an Abfahrts- und Ankunftsbahnhof
export async function resolveLeg(env, l, cache = new Map()) {
  const base = { jid: "", label: l.label, mode: l.mode, walk: l.walk || 0,
    from: { eva: "", name: l.from.name, plan: l.from.plan, platform: l.from.track || "" },
    to: { eva: "", name: l.to.name, plan: l.to.plan, platform: l.to.track || "" } };
  if (!l.rail) return base;
  const f = nearest(l.from.lat, l.from.lon), t = nearest(l.to.lat, l.to.lon);
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
  return { ...base, jid: e.jid, label: e.label,
    from: { eva: f.eva, name: f.name, plan: e.plan, platform: e.platformPlan || e.platform || base.from.platform },
    to: { eva: t.eva, name: t.name, plan: arr?.plan || l.to.plan, platform: arr ? (arr.platformPlan || arr.platform) : base.to.platform } };
}

export async function resolveConnection(env, legs) {
  const cache = new Map(), out = [];
  for (const l of legs.slice(0, 8)) out.push(await resolveLeg(env, l, cache));
  return out;
}

export { trainLabel };
