import { count } from "./stats.js";
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
  for (const v of VER.plan ? [VER.plan] : ["v6", "v5", "v4"]) {
    count("motis"); count("mt_plan"); const r = await fetch(`${base}/api/${v}/plan?${qs}`, { headers: { "User-Agent": "Umstiegsheld/0.1 (kontakt@umstiegsheld.de)", Accept: "application/json" } });
    if (r.status === 404 && !VER.plan) continue;
    if (!r.ok) { count("err_motis"); throw new Error(`Verbindungssuche: HTTP ${r.status}`); }
    VER.plan = v; return r.json();
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

const place = p => ({ name: p.name, lat: p.lat, lon: p.lon, stopId: p.stopId || "", plan: p.scheduledDeparture || p.scheduledArrival || p.departure || p.arrival,
  rt: p.departure || p.arrival, track: p.track || p.scheduledTrack || "" });

// Antwort → einfache Verbindungen (Fußwege werden als Gehzeit an die vorherige Teilstrecke gehängt)
export function simplify(data) {
  return (data.itineraries || []).map(it => {
    const legs = [];
    let walk = 0;
    for (const l of it.legs || []) {
      // Fußweg: lieber aus der Entfernung (die Dauer enthält oft die gewünschte Umstiegszeit)
      if (["WALK", "BIKE", "CAR"].includes(l.mode)) { walk += l.distance ? Math.max(1, Math.round(l.distance * 1.1 / 75)) : Math.round((l.duration || 0) / 60); continue; }
      if (legs.length && walk) legs[legs.length - 1].walk = walk;
      walk = 0;
      legs.push({ mode: l.mode, rail: RAIL.has(l.mode), label: legLabel(l), num: l.tripShortName || "", line: l.routeShortName || "", tripId: l.tripId || "",
        headsign: l.headsign || "", cancelled: !!l.cancelled, live: !!l.realTime,
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
  const search = async mt => {
    const data = await motis(env, { fromPlace: `${a.lat},${a.lon}`, toPlace: `${b.lat},${b.lon}`, time: new Date(timeMs).toISOString(),
      numItineraries: arriveBy ? "10" : "6", searchWindow: arriveBy ? "2700" : "5400", minTransferTime: String(Math.max(0, Math.min(30, mt | 0))), ...(arriveBy ? { arriveBy: "true" } : {}), detailedTransfers: "false", joinInterlinedLegs: "true", language: "de", fromEva, toEva });
    const seen = new Set();
    const l = simplify(data).filter(c => !c.legs.some(x => x.mode === "COACH" || x.mode === "AIRPLANE"))   // Fernbus/Flug passen nicht zum Bahnticket
      .filter(c => { const k = c.legs.map(x => `${x.label}@${x.from.plan}`).join("|"); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((x, y) => Date.parse(x.legs[0].from.plan) - Date.parse(y.legs[0].from.plan));   // nach der angezeigten Planzeit
    // „Ankunft bis“: die Verbindungen kurz vor der Zeit sind die interessanten, nicht die frühesten im Suchfenster
    if (arriveBy) l.splice(0, Math.max(0, l.length - 8)); else l.length = Math.min(l.length, 8);
    await rideOn(env, l, mt).catch(e => console.log("Weiterfahren:", e.message));
    return l;
  };
  let list = await search(minT);
  // Der Planer zählt einen Fußweg als Umstiegszeit. Wird daraus durch „sitzen bleiben“ ein kürzerer Umstieg als deine Mindestzeit,
  // lieber die Verbindung mit gleicher Ankunft nehmen, die deine Umstiegszeit wirklich einhält (z. B. einen Bus früher).
  const minT0 = Math.max(0, minT | 0);
  const gapsOk = c => c.legs.slice(1).every((x, i) => Math.round((Date.parse(x.from.rt || x.from.plan) - Date.parse(c.legs[i].to.rt || c.legs[i].to.plan)) / MIN) - (c.legs[i].walk || 0) >= Math.min(minT0, 2) &&
    Math.round((Date.parse(x.from.rt || x.from.plan) - Date.parse(c.legs[i].to.rt || c.legs[i].to.plan)) / MIN) >= minT0);
  if (minT0 > 0 && list.some(c => !gapsOk(c))) {
    const more = await search(minT0 + 4).catch(() => []);
    const arrOf = c => Date.parse(c.legs[c.legs.length - 1].to.plan);
    const seen = new Set();
    list = list.map(c => gapsOk(c) ? c : more.filter(m => gapsOk(m) && arrOf(m) <= arrOf(c) + MIN).sort((x, y) => arrOf(y) - arrOf(x) || Date.parse(y.dep) - Date.parse(x.dep))[0] || c)
      .filter(c => { const k = c.legs.map(x => `${x.label}@${x.from.plan}`).join("|"); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((x, y) => Date.parse(x.dep) - Date.parse(y.dep));
  }
  return list;
}

// Der Planer schickt dich manchmal eine Station zu früh raus und lässt dich laufen, obwohl derselbe Bus/dieselbe Bahn
// bis zum Umstieg weiterfährt (gleich schnell → für ihn gleichwertig). Dann lieber sitzen bleiben: Fahrt bis dorthin verlängern.
const distM = (a, b) => (a?.lat == null || b?.lat == null ? Infinity : Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180)));
const plainStopName = n => String(n || "").replace(/\s*\([^)]*\)\s*$/, "").replace(/^(S\+U|S|U)\s+/i, "").replace(/[^a-zäöüß0-9]/gi, "").toLowerCase();
export async function rideOn(env, list, minT = 0) {
  const cache = new Map();
  for (const c of list.slice(0, 6)) for (let i = 0; i < c.legs.length - 1; i++) {
    const l = c.legs[i], nx = c.legs[i + 1];
    if (!l.tripId || !l.walk || l.walk < 2 || distM(l.to, nx.from) < 120) continue;
    if (!cache.has(l.tripId)) cache.set(l.tripId, await tripStops(env, l.tripId, Date.parse(l.to.plan)).catch(() => []));
    const need = Math.max(2, Math.min(minT || 0, 10)) * 60e3, dep = Date.parse(nx.from.rt || nx.from.plan);
    // Vergleich mit dem Fußweg: sitzen bleiben ist ok, wenn du damit nicht später am Bahnsteig bist als zu Fuß (oder sowieso genug Zeit hast)
    const viaWalk = Date.parse(l.to.rt || l.to.plan) + l.walk * 60e3;
    const ok = s => { const w = distM(s, nx.from) < 120 ? 0 : Math.max(1, Math.round(distM(s, nx.from) * 1.3 / 75)), at = Date.parse(s.rt || s.plan) + w * 60e3;
      return at <= viaWalk + 60e3 || Date.parse(s.rt || s.plan) + need <= dep; };
    const hit = cache.get(l.tripId).find(s => (distM(s, nx.from) < 250 || (plainStopName(s.name) && plainStopName(s.name) === plainStopName(nx.from.name))) && Date.parse(s.rt || s.plan) < dep && ok(s));
    if (!hit) continue;
    const walk = distM(hit, nx.from) < 120 ? 0 : Math.max(1, Math.round(distM(hit, nx.from) * 1.3 / 75));
    if (walk >= l.walk) continue;
    l.to = { ...l.to, name: hit.name, lat: hit.lat, lon: hit.lon, stopId: hit.stopId || "", plan: hit.plan, rt: hit.rt || hit.plan, track: hit.track || "" };
    l.walk = walk; l.rideOn = true;
  }
}

// Bahn-Teilstrecke → OpenBoards-Fahrt (journeyId) an Abfahrts- und Ankunftsbahnhof
export async function resolveLeg(env, l, cache = new Map()) {
  // tid/stopId: Fahrt und Halte bei Transitous – damit auch Bus/Tram/U-Bahn mit Echtzeit überwacht werden können
  const base = { jid: "", tid: l.tripId || "", label: l.label, mode: l.mode, walk: l.walk || 0,
    from: { eva: "", name: l.from.name, plan: l.from.plan, platform: l.from.track || "", lat: l.from.lat, lon: l.from.lon, stopId: l.from.stopId || "" },
    to: { eva: "", name: l.to.name, plan: l.to.plan, platform: l.to.track || "", lat: l.to.lat, lon: l.to.lon, stopId: l.to.stopId || "" } };
  if (!l.rail) return base;
  const f = l.from.eva ? byEva(l.from.eva) : nearest(l.from.lat, l.from.lon), t = l.to.eva ? byEva(l.to.eva) : nearest(l.to.lat, l.to.lon);
  if (!f) return base;
  base.from.eva = f.eva; if (t) base.to.eva = t.eva;
  // Ziel im Ausland (z. B. Wien, Prag): kein DB-Bahnhof – den Zug trotzdem an der Abfahrt erkennen (Nummer/Name)
  const dep = Date.parse(l.from.plan), list = await board(env, "dep", f.eva, isoBerlin(dep - 5 * MIN), { maxVia: 40, cache });
  const digits = String(l.num).replace(/\D/g, "");
  const scored = list.filter(e => Math.abs(Date.parse(e.plan) - dep) <= 2 * MIN).map(e => {
    let s = 0;
    if (digits && String(e.num) === digits) s += 5;
    if (key(e.label) === key(l.label)) s += 4;
    if (l.line && (key(e.line) === key(l.line) || key(e.label) === key(l.line))) s += 3;
    if (t && (e.via.some(v => v.eva === t.eva) || e.direction.some(d => d.eva === t.eva))) s += 2;
    return { e, s };
  }).filter(x => x.s >= (t ? 2 : 4)).sort((a, b) => b.s - a.s);
  const e = scored[0]?.e;
  if (!e) return base;
  const arr = t ? await findJourney(env, "arr", t.eva, e.jid, Date.parse(l.to.plan), { windows: 2, cache, label: e.label, after: dep }).catch(() => null) : null;
  // live: Echtzeit zum Zeitpunkt der Zuordnung (für die Beobachtung von Alternativen)
  return { ...base, jid: e.jid, label: e.label,
    live: { dep: { rt: e.rt, pl: e.platform, c: e.cancelled, rtKnown: e.realtime }, arr: arr ? { rt: arr.rt, pl: arr.platform, c: arr.cancelled, rtKnown: arr.realtime } : null },
    from: { eva: f.eva, name: f.name, plan: e.plan, platform: e.platformPlan || e.platform || base.from.platform, lat: l.from.lat ?? byEva(f.eva)?.lat, lon: l.from.lon ?? byEva(f.eva)?.lon },
    to: t ? { eva: t.eva, name: t.name, plan: arr?.plan || l.to.plan, platform: arr ? (arr.platformPlan || arr.platform) : base.to.platform, lat: l.to.lat ?? byEva(t.eva)?.lat, lon: l.to.lon ?? byEva(t.eva)?.lon }
      : { ...base.to, abroad: true } };
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
  count("motis"); const r = await fetch(`${base}/api/v1/geocode?${qs}`, { headers: { "User-Agent": "Umstiegsheld/0.1 (kontakt@umstiegsheld.de)", Accept: "application/json" } }).catch(() => null);
  if (!r || !r.ok) return [];
  const list = await r.json().catch(() => []);
  const seen = new Set();
  return (Array.isArray(list) ? list : []).filter(m => m.lat != null && m.lon != null).map(m => {
    const area = (m.areas || []).find(a => a.default)?.name || (m.areas || []).find(a => a.adminLevel <= 8)?.name || "";
    return { eva: "", id: m.id || "", name: m.name, area, lat: +(+m.lat).toFixed(5), lon: +(+m.lon).toFixed(5), stop: true };
  }).filter(x => { const k = `${x.name}|${x.area}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, limit);
}

// ---------- Abfahrten und Fahrtverlauf an beliebigen Haltestellen (Transitous/MOTIS) ----------
// Transitous schonen: die funktionierende API-Version merken (statt jedes Mal ältere durchzuprobieren)
// und gleiche Abrufe kurz zwischenspeichern – mehrere Fahrten/Alternativen fragen oft dieselbe Fahrt ab
const VER = {}, MEMO = new Map(), MEMO_MS = 50e3;
async function motisGet(env, path, params) {
  const base = env.TRANSITOUS_URL || "https://api.transitous.org", qs = new URLSearchParams(params).toString(), mk = `${path}?${qs}`;
  const hit = MEMO.get(mk); if (hit && Date.now() - hit.t < MEMO_MS) { count("motis_memo"); return hit.p; }
  const p = (async () => {
    const vs = VER[path] ? [VER[path]] : ["v5", "v4", "v3", "v2", "v1"];
    for (const v of vs) {
      count("motis"); count(`mt_${path}`); const r = await fetch(`${base}/api/${v}/${path}?${qs}`, { headers: { "User-Agent": "Umstiegsheld/0.1 (kontakt@umstiegsheld.de)", Accept: "application/json" } }).catch(() => null);
      if (!r) continue;
      if (r.status === 404 && !VER[path]) continue;
      if (!r.ok) throw new Error(`Haltestelle: HTTP ${r.status}`);
      VER[path] = v; return r.json();
    }
    throw new Error("Haltestellen-Abfahrten nicht erreichbar");
  })();
  if (MEMO.size > 500) MEMO.clear();
  MEMO.set(mk, { t: Date.now(), p }); p.catch(() => MEMO.delete(mk));
  return p;
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
    return { tripId: s.tripId, stopId: p.stopId || "", label: legLabel(l), mode: s.mode || "", plan: p.scheduledDeparture || p.departure, rt: p.departure || p.scheduledDeparture,
      platform: p.track || p.scheduledTrack || "", cancelled: !!(s.cancelled || p.cancelled), direction: [{ name: s.headsign || s.tripTo?.name || "" }], via: [], realtime: !!s.realTime };
  }).filter(x => x.plan && Date.parse(x.rt) >= fromMs - 2 * 60e3);
}
// Halte einer Fahrt nach der Abfahrt an der Haltestelle (für „Wo steigst du aus?“)
export { motisGet };
export async function tripStops(env, tripId, afterMs) {
  if (env.MOCK === "1") { const t0 = afterMs; return [["Adenauerplatz", 4, 52.4999, 13.3074], ["Wilmersdorfer Str.", 8, 52.5066, 13.3069], ["Berlin Hbf", 22, 52.52559, 13.36955]]
    .map(([name, m, lat, lon]) => ({ name, plan: new Date(t0 + m * 60e3).toISOString(), rt: new Date(t0 + m * 60e3).toISOString(), lat, lon, eva: name === "Berlin Hbf" ? "8011160" : "" })); }
  const d = await motisGet(env, "trip", { tripId });
  const out = [];
  for (const l of d.legs || []) for (const p of [...(l.intermediateStops || []), l.to].filter(Boolean)) {
    const t = p.scheduledArrival || p.arrival; if (!t || Date.parse(t) <= afterMs) continue;
    const st = p.lat != null ? nearest(p.lat, p.lon, 250) : null;   // DB-Bahnhof am selben Ort? (für spätere Echtzeit)
    out.push({ name: p.name, plan: t, rt: p.arrival || t, track: p.track || "", lat: p.lat, lon: p.lon, eva: st?.eva || "", stopId: p.stopId || "" });
  }
  return out;
}

// Haltestelle per Name nachschlagen (MOTIS-Geocoder), bevorzugt nahe einem bekannten Punkt
export async function geocodeStop(env, name, near) {
  if (env.MOCK === "1" || !name) return null;
  const base = env.TRANSITOUS_URL || "https://api.transitous.org";
  const q = new URLSearchParams({ text: String(name).replace(/\s*\((Berlin|tief)\)/g, ""), type: "STOP", numResults: "5", language: "de",
    ...(near ? { place: `${near.lat},${near.lon}`, placeBias: "8" } : {}) });
  count("motis"); const r = await fetch(`${base}/api/v1/geocode?${q}`, { headers: { "User-Agent": "Umstiegsheld/0.1 (kontakt@umstiegsheld.de)", Accept: "application/json" } }).catch(() => null);
  if (!r || !r.ok) return null;
  const list = await r.json().catch(() => []);
  const dist = m => near ? Math.hypot((m.lat - near.lat) * 111, (m.lon - near.lon) * 68) : 0;
  const hit = (Array.isArray(list) ? list : []).filter(m => m.lat != null && dist(m) < 3).sort((a, b) => dist(a) - dist(b))[0];
  return hit ? { lat: +hit.lat.toFixed(5), lon: +hit.lon.toFixed(5) } : null;
}

// Weg vom Standort zur Start-Haltestelle: Dauer zu Fuß oder mit dem Auto (der Standort wird nicht gespeichert)
export async function accessTime(env, from, to, mode) {
  const km = Math.hypot((from.lat - to.lat) * 111, (from.lon - to.lon) * 68);
  const rough = () => ({ min: Math.max(1, Math.round(mode === "CAR" ? km * 1.4 / 28 * 60 + 2 : km * 1.3 / 4.5 * 60)), rough: true, km: +km.toFixed(1) });
  if (env.MOCK === "1" || km < 0.05) return rough();
  try {
    const d = await motis(env, { fromPlace: `${from.lat},${from.lon}`, toPlace: `${to.lat},${to.lon}`, time: new Date().toISOString(), transitModes: "", directModes: mode, maxDirectTime: "7200" });
    const it = (d.direct || []).find(x => x.duration > 0);
    if (it) return { min: Math.max(1, Math.round(it.duration / 60)), rough: false, km: +km.toFixed(1) };
  } catch (e) { console.log("Weg zur Haltestelle:", e.message); }
  return rough();
}

// Adressen und Orte (für „Meine Orte“: Zuhause, Arbeit, Arzt …) – Haltestellen inklusive
export async function searchPlaces(env, q, limit = 8) {
  if (!q || q.trim().length < 3) return [];
  if (env.MOCK === "1") return [{ eva: "", name: `${q.trim()} 12`, area: "Berlin", lat: 52.4876, lon: 13.2851, addr: true }];
  const base = env.TRANSITOUS_URL || "https://api.transitous.org";
  const qs = new URLSearchParams({ text: q.trim(), numResults: String(limit + 4), language: "de" });
  count("motis"); const r = await fetch(`${base}/api/v1/geocode?${qs}`, { headers: { "User-Agent": "Umstiegsheld/0.1 (kontakt@umstiegsheld.de)", Accept: "application/json" } }).catch(() => null);
  if (!r || !r.ok) return [];
  const list = await r.json().catch(() => []), seen = new Set();
  return (Array.isArray(list) ? list : []).filter(m => m.lat != null && m.lon != null).map(m => {
    const area = (m.areas || []).find(a => a.default)?.name || (m.areas || []).find(a => a.adminLevel <= 8)?.name || "";
    const name = m.type === "ADDRESS" && m.street ? `${m.street}${m.houseNumber ? ` ${m.houseNumber}` : ""}` : m.name;
    return { eva: "", name, area, lat: +(+m.lat).toFixed(5), lon: +(+m.lon).toFixed(5), ...(m.type === "STOP" ? { stop: true, id: m.id || "" } : { addr: true }) };
  }).filter(x => { const k = `${x.name}|${x.area}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, limit);
}

// ---------- Bausteine: andere Fahrten für genau eine Teilstrecke (Fahrt ändern) ----------
// Eine kurze Verbindungssuche nur für dieses Stück (1–2 Abrufe), Ergebnis 5 Min. für alle zwischengespeichert.
const SEG = new Map(), SEG_MS = 5 * MIN;
const walkMin = (a, b) => { const d = distM(a, b); return !Number.isFinite(d) ? 0 : d < 120 ? 0 : Math.max(1, Math.round(d * 1.3 / 75)); };
export async function segmentOptions(env, legs, i, now = Date.now(), at = null) {
  const L = legs[i], N = legs[i + 1] || null;
  if (env.MOCK === "1") {   // Testdaten: gleiche Strecke 20/10 Min. früher, 10/20 Min. später, dazu eine andere Linie
    const sh = (iso, m) => new Date(Date.parse(iso) + m * MIN).toISOString();
    return [-20, -10, 0, 5, 10, 20].map(m => ({ mode: L.mode || "BUS", rail: !!L.jid, label: m === 5 ? "Bus X10" : L.label, tripId: `mock_seg_${m}`, walk: L.walk || 0,
      from: { name: L.from.name, lat: L.from.lat, lon: L.from.lon, plan: sh(L.from.plan, m), rt: sh(L.from.plan, m), track: "" },
      to: { name: m === 5 ? `${L.to.name} (andere Haltestelle)` : L.to.name, lat: L.to.lat, lon: L.to.lon, plan: sh(L.to.plan, m + (m === 5 ? -1 : 0)), rt: sh(L.to.plan, m + (m === 5 ? -1 : 0)), track: "" } }))
      .filter(o => Date.parse(o.from.plan) > now - MIN);
  }
  // Verbindungssuche nur für dieses Stück: vom Start der Teilstrecke bis zum Einstieg der nächsten (bzw. zum Ziel).
  // Findet alle Linien und Haltestellen in Laufweite – auch zwei Fahrten hintereinander (z. B. S-Bahn mit Umstieg).
  const P = s => (s.lat != null ? { eva: s.eva || "", lat: s.lat, lon: s.lon } : s.eva ? s.eva : null);
  const from = P(L.from), target = N ? (N.from.lat != null || N.from.eva ? N.from : L.to) : L.to, to = P(target);
  if (!from || !to) throw new Error("Für diese Haltestelle kenne ich keinen Ort.");
  // Dichter Takt (Bus + S-Bahn alle paar Minuten): eine Suche liefert nur ~8 Fahrten. Darum eine Suche kurz davor und eine ab der
  // bisherigen Abfahrt; blättert man darüber hinaus, holt die App gezielt eine weitere Seite (at = Zeitpunkt).
  const dep0 = Date.parse(L.from.plan), times = at != null ? [Math.max(now - MIN, +at)] : [Math.max(now - MIN, dep0 - 20 * MIN), Math.max(now - MIN, dep0 + MIN)];
  const key = `${JSON.stringify(from)}|${JSON.stringify(to)}|${times.map(x => Math.floor(x / (5 * MIN))).join(",")}`, hit = SEG.get(key);
  if (hit && now - hit.t < SEG_MS) { count("seg_memo"); return hit.v; }
  const tgt = target.lat != null ? target : { ...target, ...(byEva(target.eva) || {}) };
  const all = [], seen = new Set();
  const lists = await Promise.all([...new Set(times)].map(t => connections(env, from, to, t, 0)));
  for (const c of lists.flat()) { const kk = c.legs.map(l => `${l.label}@${l.from.plan}`).join("|");
    if (Date.parse(c.legs[0].from.plan) < now - MIN || seen.has(kk) || c.legs.some(l => l.cancelled)) continue;
    seen.add(kk); all.push(c); }
  const out = all.sort((x, y) => Date.parse(x.legs[0].from.plan) - Date.parse(y.legs[0].from.plan)).map(c => {
    const l0 = c.legs[0], lz = c.legs[c.legs.length - 1];
    return { mode: l0.mode, rail: !!l0.rail, label: c.legs.map(l => l.label).join(" → "), tripId: l0.tripId || "", walk: N ? walkMin(lz.to, tgt) : 0,
      from: l0.from, to: lz.to, legs: c.legs };
  });
  count("seg");
  if (SEG.size > 300) SEG.clear();
  SEG.set(key, { t: now, v: out.slice(0, 30) });
  return out.slice(0, 30);
}
