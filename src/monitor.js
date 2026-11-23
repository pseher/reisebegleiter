// Überwachung: Echtzeit für laufende Reisen holen, bewerten, Plan B vorbereiten, Meldungen schicken.
import { evaluate, diff, transferMinutes } from "./engine.js";
import { findJourney } from "./openboards.js";
import { connections, resolveConnection } from "./routing.js";
import { search as searchStationsSync } from "./stations.js";
import * as db from "./db.js";
import { sendPush } from "./push.js";

const MIN = 60e3;
// Wie oft ein Halt geprüft wird – je näher, desto öfter (Minuten)
export const intervalFor = dist => (dist <= 45 * MIN ? 1 : dist <= 150 * MIN ? 4 : dist <= 6 * 3600e3 ? 15 : null);

// Fällige Abfragen einer Reise
export function dueChecks(trip, now, force = false) {
  const out = [];
  trip.legs.forEach((leg, i) => {
    if (!leg.jid || !leg.from.eva || !leg.to.eva) return;     // Bus/U-Bahn/Tram: vorerst nur Fahrplan
    for (const side of ["dep", "arr"]) {
      const s = side === "dep" ? leg.from : leg.to, o = trip.obs?.[i]?.[side] || {};
      const plan = Date.parse(s.plan), eff = o.rt ? Date.parse(o.rt) : plan;
      if (eff < now - 3 * MIN) continue;                                   // schon vorbei
      const iv = intervalFor(eff - now);
      if (!iv || (!force && o.t && now - o.t < iv * MIN - 20e3)) continue;
      out.push({ trip, i, side, eva: s.eva, jid: leg.jid, eff, plan, dist: eff - now });
    }
  });
  return out;
}

async function inBatches(items, size, fn) { for (let k = 0; k < items.length; k += size) await Promise.all(items.slice(k, k + size).map(fn)); }

// Echtzeit holen und in trip.obs eintragen
export async function observe(env, checks, now, cache) {
  await inBatches(checks, 6, async c => {
    const kind = c.side === "dep" ? "dep" : "arr";
    let hit = null;
    try { hit = await findJourney(env, kind, c.eva, c.jid, c.eff, { planMs: c.plan, windows: 1, cache }); } catch (e) { console.log("OpenBoards:", e.message); return; }
    const obs = (c.trip.obs ||= []), o = (obs[c.i] ||= {}), prev = o[c.side] || {};
    o[c.side] = hit
      ? { rt: hit.rt, pl: hit.platform, c: hit.cancelled, live: hit.realtime, msgs: hit.messages.slice(0, 3), t: now }
      : { ...prev, t: now, miss: (prev.miss || 0) + 1 };
    c.trip._dirty = true;
  });
}

// Plan B: die Restreise bis zum Ziel neu suchen (MOTIS), mit der eigenen Umstiegszeit.
// Vor der Abfahrt ab dem Startbahnhof, unterwegs ab dem gefährdeten Umsteigebahnhof.
export async function planB(env, trip, v, k, now) {
  const t = v.transfers[k], last = trip.legs[trip.legs.length - 1], own = +trip.legs[0]?.minT || 0;
  const finalEva = last.to.eva || nearestEvaByName(last.to.name);
  if (!finalEva) return [];
  const before = now < v.legs[0].dep.rt - MIN;
  const fromEva = before ? trip.legs[0].from.eva : t.eva;
  if (!fromEva) return [];
  const fromMs = before ? Math.max(now + 2 * MIN, v.legs[0].dep.plan - 20 * MIN) : Math.max(now, t.arrRt + Math.max(own, 3) * MIN);
  const current = trip.legs.slice(before ? 0 : k + 1).map(l => `${l.label}@${Date.parse(l.from.plan)}`).join("|");
  const cs = await connections(env, fromEva, finalEva, fromMs, own);
  return cs.filter(c => !c.legs.some(l => l.cancelled))
    .filter(c => c.legs.map(l => `${l.label}@${Date.parse(l.from.plan)}`).join("|") !== current)
    .sort((x, y) => Date.parse(x.arr) - Date.parse(y.arr)).slice(0, 2)
    .map(c => ({ from: before ? "start" : k, at: before ? v.legs[0].dep.name : t.at, label: c.legs.map(l => l.label).join(" → "), transfers: c.transfers,
      dep: c.legs[0].from.plan, depPl: c.legs[0].from.track || "", arr: c.legs[c.legs.length - 1].to.plan,
      toName: (last.to.name || "").replace(/\s*\(tief\)$/i, ""), legs: c.legs }));
}
const nearestEvaByName = name => searchStationsSync(name)?.[0]?.eva || "";

// Bewertung + Plan B + Meldungen für eine Reise (nach dem Beobachten)
export async function assess(env, trip, now, cache) {
  let v = evaluate(trip, now);
  const prev = { ...(trip.state || {}) }, alt = { ...(prev.alt || {}) }, altAt = { ...(prev.altAt || {}) };
  for (const t of v.transfers) {
    const k = v.transfers.indexOf(t);
    if (t.status === "RISK" || t.status === "LOST") {
      if (!alt[k] || now - (altAt[k] || 0) > 5 * MIN) { try { alt[k] = await planB(env, trip, v, k, now); altAt[k] = now; } catch (e) { console.log("Plan B:", e.message); } }
    } else if (t.status === "OK" || t.status === "DONE") { delete alt[k]; delete altAt[k]; }
  }
  const { state, msgs } = diff(trip, v, { ...prev, alt }, now);
  trip.state = { ...state, alt, altAt, status: v.status, at: now };
  const last = v.legs[v.legs.length - 1];
  if (v.phase === "done" && now > last.arr.rt + 30 * MIN) trip.active = false;
  trip.ends_at = new Date(last.arr.rt).toISOString();
  return { v, msgs };
}

const saveTrip = (env, t) => db.update(env, "rb_trips", t.id, { obs: t.obs, state: t.state, active: t.active, ends_at: t.ends_at, updated_at: new Date().toISOString() });

// Cron: jede Minute
export async function runMonitor(env, now = Date.now()) {
  const trips = await db.activeTrips(env), cache = new Map();
  const checks = trips.flatMap(t => dueChecks(t, now)).sort((a, b) => a.dist - b.dist).slice(0, 24);
  await observe(env, checks, now, cache);
  const out = new Map();
  for (const t of trips) {
    const before = JSON.stringify(t.state || {});
    const { msgs } = await assess(env, t, now, cache);
    if (t._dirty || !t.active || JSON.stringify(t.state) !== before) await saveTrip(env, t).catch(e => console.log("Speichern:", e.message));
    if (msgs.length) out.set(t.device_id, [...(out.get(t.device_id) || []), ...msgs.slice(0, 4)]);
  }
  let sent = 0;
  if (out.size) {
    const devs = await db.devicesByIds(env, [...out.keys()]);
    for (const d of devs) {
      if (!d.push && env.MOCK === "1") { out.get(d.id).forEach(m => console.log("PUSH (kein Abo)", m.title, "–", m.body)); continue; }
      if (!d.push) continue;
      for (const m of out.get(d.id)) {
        const st = await deliver(env, d.push, { ...m, url: "/" });
        if (st === 404 || st === 410) { await db.update(env, "rb_devices", d.id, { push: null }); break; }
        if (st >= 200 && st < 300) sent++;
      }
    }
  }
  if (new Date(now).getUTCMinutes() === 7) await db.cleanup(env).catch(() => {});
  return { trips: trips.length, checks: checks.length, requests: cache.size, msgs: [...out.values()].flat().length, sent };
}

export async function deliver(env, sub, msg) {
  if (env.MOCK === "1") { console.log("PUSH", msg.title, "–", msg.body); return 201; }
  return sendPush(env, sub, msg);
}

// Plan B übernehmen: Teilstrecken ab dem Abweichungspunkt ersetzen, Echtzeit und Meldungsstand dafür zurücksetzen
export async function adopt(env, trip, k, idx) {
  const a = trip.state?.alt?.[k]?.[idx];
  if (!a?.legs?.length) throw new Error("Plan B nicht mehr verfügbar");
  const fresh = (await resolveConnection(env, a.legs)).map(l => ({ ...l, minT: +trip.legs[0]?.minT || 0 }));
  const keep = a.from === "start" ? 0 : k + 1;
  trip.legs = [...trip.legs.slice(0, keep), ...fresh];
  trip.obs = (trip.obs || []).slice(0, keep);
  trip.state = { ...(trip.state || {}), tr: [], alt: {}, altAt: {}, rem: Object.fromEntries(Object.entries(trip.state?.rem || {}).filter(([i]) => +i < keep)) };
  trip.ends_at = trip.legs[trip.legs.length - 1].to.plan;
  return trip;
}
