// SOS-Modus: „Ich sitze im Zug, es gibt Verspätung – wie komme ich am besten noch ans Ziel?“
// 1. Zug zuordnen: die aktuelle Teilstrecke laut Plan, ihre Halte aus der DB-Abfahrtstafel (journeyId + via).
// 2. Position: der Halt dieser Strecke, der dem Standort am nächsten liegt (falls Standort erlaubt).
// 3. Mögliche Ausstiege vor dir (nächste Halte, große Knoten, dein Umstieg) mit Echtzeit-Ankunft.
// 4. Ab jedem Ausstieg Verbindungen zum Ziel suchen, nach Ankunft sortieren, live mitprüfen.
import { evaluate, HUBS, changesFV } from "./engine.js";
import { findJourney } from "./openboards.js";
import { connections } from "./routing.js";
import { byEva, search as searchStationsSync } from "./stations.js";
import { watchAlts } from "./monitor.js";

const MIN = 60e3;
const km = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lon - b.lon) * 111 * Math.cos(a.lat * Math.PI / 180));
const clean = n => String(n || "").replace(/\s*\(tief\)$/i, "");
const placeOf = s => (s?.eva ? { eva: s.eva, lat: s.lat, lon: s.lon } : s?.lat != null ? { lat: s.lat, lon: s.lon } : null);
const minGapOf = legs => legs.slice(1).reduce((m, l, i) => Math.min(m, Math.round((Date.parse(l.from.plan) - Date.parse(legs[i].to.plan)) / MIN)), Infinity);
const rtOf = s => Math.max(Date.parse(s.rt || s.plan) || 0, Date.parse(s.plan) || 0);

export async function sos(env, trip, here, now = Date.now()) {
  const v = evaluate(trip, now), cache = new Map(), own = +trip.legs[0]?.minT || 0;
  const last = trip.legs[trip.legs.length - 1];
  const to = placeOf(last.to) || (searchStationsSync(last.to.name)?.[0]?.eva ? { eva: searchStationsSync(last.to.name)[0].eva } : null);
  if (!to) throw Object.assign(new Error("Für das Ziel kenne ich keinen Ort."), { user: true });
  // Teilstrecke, in der du laut Plan gerade sitzt (oder die als nächste losfährt)
  let ci = v.legs.findIndex(l => now >= l.dep.rt - MIN && now < l.arr.rt + MIN);
  if (ci < 0) ci = Math.max(0, v.legs.findIndex(l => now < l.dep.rt));
  const leg = trip.legs[ci], lv = v.legs[ci];
  const info = { label: leg.label, onTrain: now >= lv.dep.rt - MIN, near: null, dist: null, located: !!here };

  // Halte der Fahrt ab ihrem Abfahrtsbahnhof (DB-Abfahrtstafel mit langer via-Liste)
  let route = [];
  if (leg.jid && leg.from.eva) {
    const dep = await findJourney(env, "dep", leg.from.eva, leg.jid, lv.dep.rt, { planMs: lv.dep.plan, windows: 1, cache, maxVia: 40 }).catch(() => null);
    route = (dep?.via || []).filter(x => x.eva && !x.cancelled).map(x => ({ eva: x.eva, name: x.name || byEva(x.eva)?.name || "" }));
  }
  const end = route.findIndex(x => x.eva === leg.to.eva);
  route = end >= 0 ? route.slice(0, end + 1) : [...route, { eva: leg.to.eva, name: leg.to.name }].filter(x => x.eva);

  // Wo bist du ungefähr? Nächster Halt der Strecke zum Standort
  let from = 0;
  if (here && route.length) {
    const d = route.map(x => { const b = byEva(x.eva); return b ? km(here, b) : Infinity; });
    const i = d.indexOf(Math.min(...d));
    if (d[i] < 40) { info.near = clean(route[i].name); info.dist = Math.round(d[i] * 10) / 10; from = i; }
  }
  // Kandidaten zum Aussteigen: die nächsten zwei Halte, große Knoten, dein geplanter Umstieg – höchstens vier
  const ahead = route.slice(from);
  const pick = [];
  for (const x of ahead) if (pick.length < 2) pick.push(x);
  for (const x of ahead) if (pick.length < 4 && HUBS.has(x.eva) && !pick.includes(x)) pick.push(x);
  const goal = ahead[ahead.length - 1];
  if (goal && !pick.includes(goal)) { if (pick.length >= 4) pick.pop(); pick.push(goal); }

  // Echtzeit-Ankunft an jedem Kandidaten (Halte schon hinter dir fallen weg)
  const exits = [];
  for (const x of pick) {
    if (!leg.jid) break;
    const hit = await findJourney(env, "arr", x.eva, leg.jid, Math.max(now, lv.dep.rt) + 5 * MIN, { windows: 6, cache, maxVia: 1, label: leg.label, after: lv.dep.plan }).catch(() => null);
    if (!hit || Date.parse(hit.rt) < now - MIN) continue;
    exits.push({ eva: x.eva, name: clean(hit.name || x.name), arr: Date.parse(hit.rt), plan: hit.plan, platform: hit.platformPlan || hit.platform || "", delay: Math.round((Date.parse(hit.rt) - Date.parse(hit.plan)) / MIN) });
  }
  if (exits[0]) info.next = exits[0].name;

  // Ab jedem Ausstieg zum Ziel – je Ausstieg die zwei besten Ankünfte
  const opts = [], seen = new Set(), rest = trip.legs.slice(ci + 1);
  for (const x of exits) {
    const cs = await connections(env, x.eva, to, x.arr + Math.max(own, 3) * MIN, own).catch(() => []);
    for (const c of cs.filter(c => !c.legs.some(l => l.cancelled)).sort((a, b) => rtOf(a.legs[a.legs.length - 1].to) - rtOf(b.legs[b.legs.length - 1].to)).slice(0, 2)) {
      const key = c.legs.map(l => `${l.label}@${Date.parse(l.from.plan)}`).join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const arr = rtOf(c.legs[c.legs.length - 1].to), mg = minGapOf(c.legs);
      opts.push({ kind: "sos", from: ci, at: x.name, cut: { eva: x.eva, name: x.name, plan: x.plan, platform: x.platform }, exitAt: new Date(x.arr).toISOString(),
        exitDelay: x.delay, label: c.legs.map(l => l.label).join(" → "), transfers: c.transfers + 1, legs: c.legs,
        dep: new Date(rtOf(c.legs[0].from)).toISOString(), depPlan: c.legs[0].from.plan, depPl: c.legs[0].from.track || "",
        arr: new Date(arr).toISOString(), arrPlan: c.legs[c.legs.length - 1].to.plan, minGap: Number.isFinite(mg) ? mg : null,
        toName: clean(last.to.name), zb: changesFV(rest, c.legs) });
    }
  }
  // Fährt dein Zug selbst bis zum Ziel? Dann „Sitzen bleiben“
  if (leg.jid && to.eva && to.eva !== leg.to.eva) {
    const hit = await findJourney(env, "arr", to.eva, leg.jid, Math.max(now, lv.arr.rt), { windows: 10, cache, maxVia: 1, label: leg.label, after: lv.dep.plan }).catch(() => null);
    // ohne Prognose fürs Ziel: mindestens die aktuelle Verspätung des Zugs annehmen
    const curDelay = Math.max(0, lv.arr.delay || lv.dep.delay || 0), arrMs = hit ? Math.max(Date.parse(hit.rt), Date.parse(hit.plan) + curDelay * MIN) : 0;
    if (hit) hit.rt = new Date(arrMs).toISOString();
    if (hit && !hit.cancelled) opts.push({ kind: "sos", stayOn: true, from: ci, at: clean(hit.name || last.to.name), cut: { eva: to.eva, name: clean(hit.name || last.to.name), plan: hit.plan, platform: hit.platformPlan || hit.platform || "" },
      exitAt: hit.rt, exitDelay: Math.round((Date.parse(hit.rt) - Date.parse(hit.plan)) / MIN), label: leg.label, transfers: 0, legs: [],
      dep: new Date(Math.max(now, lv.dep.rt)).toISOString(), arr: hit.rt, toName: clean(last.to.name), zb: rest.some(l => /^(ICE|IC|EC|ECE|RJ|NJ|EN)\b/i.test(l.label)) });
  }
  // gleiche Weiterfahrt über verschiedene Ausstiege: den späteren Ausstieg nehmen (länger bequem im Zug)
  const byFinal = new Map();
  for (const o of opts) { const f = o.legs.length ? `${o.legs[o.legs.length - 1].label}@${o.arr}` : `stay@${o.arr}`, prev = byFinal.get(f);
    if (!prev || Date.parse(o.exitAt) > Date.parse(prev.exitAt)) byFinal.set(f, o); }
  // die frühesten Ankünfte zuerst, höchstens fünf
  const list = [...byFinal.values()].sort((a, b) => Date.parse(a.arr) - Date.parse(b.arr)).slice(0, 5);
  await watchAlts(env, list, now, own, cache).catch(e => console.log("SOS beobachten:", e.message));
  return { at: now, info, exits: exits.map(x => ({ name: x.name, arr: new Date(x.arr).toISOString(), delay: x.delay })), list,
    plan: { arr: new Date(v.legs[v.legs.length - 1].arr.rt).toISOString(), ok: v.status !== "LOST" } };
}
