// Echtzeit für Bus, Tram, U-Bahn (Teilstrecken ohne DB-Fahrtkennung).
// 1. Transitous/MOTIS: Fahrt per tripId abrufen (dort fließen GTFS-RT-Feeds ein, z. B. VBB).
// 2. Rückfall Berlin/Brandenburg: VBB-Auskunft über v6.vbb.transport.rest (Gemeinschaftsdienst, ohne Garantie).
import { motisGet } from "./routing.js";

const MIN = 60e3;
const fold = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").replace(/[^a-z0-9]/g, "");
const lineOf = label => String(label || "").replace(/^(Bus|Tram|STR|Fähre)\s*/i, "").replace(/\s+/g, "").toUpperCase();
const inVBB = s => s?.lat != null && s.lat > 51.3 && s.lat < 53.6 && s.lon > 11.2 && s.lon < 14.8;

// Zeiten eines Halts aus einer MOTIS-Fahrt
function findStop(it, s, kind) {
  const places = [];
  for (const l of it.legs || []) places.push(l.from, ...(l.intermediateStops || []), l.to);
  const p = places.find(x => x && s.stopId && x.stopId === s.stopId) || places.find(x => x && fold(x.name) === fold(s.name));
  if (!p) return null;
  const plan = kind === "dep" ? p.scheduledDeparture || p.departure : p.scheduledArrival || p.arrival;
  const rt = kind === "dep" ? p.departure || p.scheduledDeparture : p.arrival || p.scheduledArrival;
  return plan ? { plan, rt, cancelled: !!p.cancelled, track: p.track || "" } : null;
}

async function viaMotis(env, leg) {
  if (!leg.tid) return null;
  const it = await motisGet(env, "trip", { tripId: leg.tid }).catch(() => null);
  if (!it) return null;
  const live = (it.legs || []).some(l => l.realTime), cancelled = (it.legs || []).some(l => l.cancelled);
  const dep = findStop(it, leg.from, "dep"), arr = findStop(it, leg.to, "arr");
  return { live, dep: dep && { ...dep, cancelled: dep.cancelled || cancelled }, arr: arr && { ...arr, cancelled: arr.cancelled || cancelled } };
}

// VBB: Abfahrt bzw. Ankunft derselben Linie zur geplanten Zeit an der nächsten Haltestelle
async function vbbOne(env, s, label, kind, cache) {
  if (!inVBB(s)) return null;
  const base = env.VBB_REST_URL || "https://v6.vbb.transport.rest", h = { "User-Agent": "Reisebegleiter/0.1 (kontakt@herdzeit.de)", Accept: "application/json" };
  const key = `vbbstop|${s.lat.toFixed(4)},${s.lon.toFixed(4)}`;
  let stopId = cache?.get(key);
  if (!stopId) {
    const r = await fetch(`${base}/locations/nearby?latitude=${s.lat}&longitude=${s.lon}&results=3&distance=400`, { headers: h }).catch(() => null);
    const list = r?.ok ? await r.json().catch(() => []) : [];
    stopId = (list.find(x => fold(x.name).includes(fold(s.name).slice(0, 8))) || list[0])?.id;
    if (!stopId) return null;
    cache?.set(key, stopId);
  }
  const plan = Date.parse(s.plan), when = new Date(plan - 5 * MIN).toISOString();
  const r = await fetch(`${base}/stops/${encodeURIComponent(stopId)}/${kind === "dep" ? "departures" : "arrivals"}?when=${encodeURIComponent(when)}&duration=20&results=60`, { headers: h }).catch(() => null);
  if (!r?.ok) return null;
  const d = await r.json().catch(() => ({}));
  const list = d.departures || d.arrivals || (Array.isArray(d) ? d : []);
  const ln = lineOf(label);
  const hit = list.find(x => lineOf(x.line?.name) === ln && Math.abs(Date.parse(x.plannedWhen) - plan) < 1.5 * MIN);
  if (!hit) return null;
  return { plan: hit.plannedWhen, rt: hit.when || hit.plannedWhen, cancelled: !!hit.cancelled, live: hit.delay != null || !!hit.cancelled, track: hit.platform || "" };
}

// Ergebnis im Format der Beobachtungen (trip.obs[i]): { dep: {rt, c, live, t}, arr: {...} }
export async function busLive(env, leg, now, cache = new Map()) {
  if (env.MOCK === "1") {   // Testdaten: Bus 2 Min. später
    const sh = iso => new Date(Date.parse(iso) + 2 * MIN).toISOString();
    return { dep: { rt: sh(leg.from.plan), c: false, live: true, t: now, src: "test" }, arr: { rt: sh(leg.to.plan), c: false, live: true, t: now, src: "test" } };
  }
  const m = await viaMotis(env, leg).catch(() => null);
  const out = {};
  for (const [side, s] of [["dep", leg.from], ["arr", leg.to]]) {
    let x = m?.[side] && m.live ? { ...m[side], live: true, src: "transitous" } : null;
    if (!x) { const v = await vbbOne(env, s, leg.label, side, cache).catch(() => null); if (v) x = { ...v, src: "vbb" }; }
    if (!x && m?.[side]) x = { ...m[side], live: false, src: "transitous" };
    if (x) out[side] = { rt: x.rt, c: !!x.cancelled, live: !!x.live, t: now, src: x.src, ...(x.track ? { pl: x.track } : {}) };
  }
  return out;
}
