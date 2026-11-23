// Überwachung: Echtzeit für laufende Reisen holen, bewerten, Plan B vorbereiten, Meldungen schicken.
import { evaluate, diff, transferMinutes } from "./engine.js";
import { board, findJourney, isoBerlin, WINDOW_MIN } from "./openboards.js";
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

// Plan B: spätere Züge ab dem Umsteigebahnhof, die das Ziel der nächsten Teilstrecke erreichen
export async function planB(env, trip, v, k, now, cache) {
  const t = v.transfers[k], next = trip.legs[k + 1], target = next.to.eva;
  const from = Math.max(now, t.arrRt + transferMinutes(t.eva, t.arrPl, t.eva, "") * MIN);
  const dur = Date.parse(next.to.plan) - Date.parse(next.from.plan);
  const seen = new Set(), cands = [];
  for (let w = 0; w < 2 && cands.length < 3; w++) {
    const list = await board(env, "dep", t.eva, isoBerlin(from + w * WINDOW_MIN * MIN), { maxVia: 40, cache });
    for (const e of list) {
      if (seen.has(e.jid) || e.jid === next.jid || e.cancelled || Date.parse(e.rt) < from) continue;
      seen.add(e.jid);
      if (e.via.some(x => x.eva === target) || e.direction.some(x => x.eva === target)) cands.push(e);
    }
  }
  const alts = [];
  for (const c of cands.slice(0, 2)) {
    const a = await findJourney(env, "arr", target, c.jid, Date.parse(c.rt) + dur, { windows: 3, cache }).catch(() => null);
    alts.push({ label: c.label, jid: c.jid, dep: c.rt, depPl: c.platform, at: t.at, arr: a?.rt || null, arrPl: a?.platform || "", toName: next.to.name.replace(/\s*\(tief\)$/i, "") });
  }
  return alts.sort((x, y) => Date.parse(x.arr || "2100-01-01") - Date.parse(y.arr || "2100-01-01"));
}

// Bewertung + Plan B + Meldungen für eine Reise (nach dem Beobachten)
export async function assess(env, trip, now, cache) {
  let v = evaluate(trip, now);
  const prev = { ...(trip.state || {}) }, alt = { ...(prev.alt || {}) }, altAt = { ...(prev.altAt || {}) };
  for (const t of v.transfers) {
    const k = v.transfers.indexOf(t);
    if (t.status === "RISK" || t.status === "LOST") {
      if (!alt[k] || now - (altAt[k] || 0) > 5 * MIN) { try { alt[k] = await planB(env, trip, v, k, now, cache); altAt[k] = now; } catch (e) { console.log("Plan B:", e.message); } }
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
