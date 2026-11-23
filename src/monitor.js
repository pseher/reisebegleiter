// Überwachung: Echtzeit für laufende Reisen holen, bewerten, Plan B vorbereiten, Meldungen schicken.
import { evaluate, diff, transferMinutes } from "./engine.js";
import { findJourney } from "./openboards.js";
import { connections, resolveConnection, resolveLeg } from "./routing.js";
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
// Kleinster geplanter Umstieg einer Verbindung (Minuten)
const minGapOf = legs => legs.slice(1).reduce((m, l, i) => Math.min(m, Math.round((Date.parse(l.from.plan) - Date.parse(legs[i].to.plan)) / MIN)), Infinity);

export async function planB(env, trip, v, k, now) {
  const t = v.transfers[k], last = trip.legs[trip.legs.length - 1], own = +trip.legs[0]?.minT || 0;
  // Pflichtzug hinter dem gefährdeten Umstieg? Dann gezielt rechtzeitig dorthin.
  const mi = trip.legs.findIndex(l => l.must);
  if (mi > k && trip.legs[mi].from.eva) return planToMust(env, trip, v, k, mi, now, own);
  const finalEva = last.to.eva || nearestEvaByName(last.to.name);
  if (!finalEva) return [];
  const before = now < v.legs[0].dep.rt - MIN;
  const fromEva = before ? trip.legs[0].from.eva : t.eva;
  if (!fromEva) return [];
  // Vor der Abfahrt auch frühere Abfahrten zulassen (bis 45 Min. vor Plan)
  const fromMs = before ? Math.max(now + 2 * MIN, v.legs[0].dep.plan - 45 * MIN) : Math.max(now, t.arrRt + Math.max(own, 3) * MIN);
  const current = trip.legs.slice(before ? 0 : k + 1).map(l => `${l.label}@${Date.parse(l.from.plan)}`).join("|");
  const curArr = v.legs[v.legs.length - 1].arr.rt;
  const curMin = v.transfers.filter(x => x.status !== "DONE").reduce((m, x) => Math.min(m, x.gap), Infinity);
  // Zwei Anfragen: normal und „mit mehr Luft“ – der Planer liefert sonst bei gleicher Ankunft nur die späteste (knappste) Abfahrt
  const [normal, roomy] = await Promise.all([
    connections(env, fromEva, finalEva, fromMs, own).catch(() => []),
    connections(env, fromEva, finalEva, fromMs, Math.max(own, 5) + 7).catch(() => []),
  ]);
  const seen = new Set(), all = [];
  for (const c of [...roomy, ...normal]) {
    const key = c.legs.map(l => `${l.label}@${Date.parse(l.from.plan)}`).join("|");
    if (key === current || seen.has(key) || c.legs.some(l => l.cancelled)) continue;
    seen.add(key); all.push({ c, arr: Date.parse(c.legs[c.legs.length - 1].to.plan), minGap: minGapOf(c.legs) });
  }
  const mk = (x, kind) => ({ kind, from: before ? "start" : k, at: before ? v.legs[0].dep.name : t.at, label: x.c.legs.map(l => l.label).join(" → "), transfers: x.c.transfers,
    dep: x.c.legs[0].from.plan, depPl: x.c.legs[0].from.track || "", arr: x.c.legs[x.c.legs.length - 1].to.plan, minGap: Number.isFinite(x.minGap) ? x.minGap : null,
    toName: (last.to.name || "").replace(/\s*\(tief\)$/i, ""), legs: x.c.legs });
  const out = [];
  // Sicherer: gleiche (oder frühere) Ankunft, deutlich mehr Umstiegszeit – möglichst spät los
  const safer = all.filter(x => x.arr <= curArr + 2 * MIN && x.minGap >= Math.max(curMin + 4, own + 3)).sort((a, b) => Date.parse(b.c.dep) - Date.parse(a.c.dep))[0];
  if (safer) out.push(mk(safer, "safer"));
  // Schneller: früher am Ziel
  const faster = all.filter(x => x !== safer && x.arr < curArr - 2 * MIN && (x.minGap >= own || x.minGap === Infinity)).sort((a, b) => a.arr - b.arr)[0];
  if (faster) out.push(mk(faster, "faster"));
  // Später: nächste entspannte Möglichkeit, falls der Plan kippt
  const later = all.filter(x => x !== safer && x !== faster && x.arr > curArr + 2 * MIN).sort((a, b) => a.arr - b.arr)[0];
  if (later) out.push(mk(later, "later"));
  return out.slice(0, 3);
}

async function planToMust(env, trip, v, k, mi, now, own) {
  const must = trip.legs[mi], before = now < v.legs[0].dep.rt - MIN;
  const fromEva = before ? trip.legs[0].from.eva : v.transfers[k].eva;
  if (!fromEva || fromEva === must.from.eva) return [];
  const deadline = v.legs[mi].dep.rt - Math.max(own, 3) * MIN;             // spätestens hier am Bahnsteig des Pflichtzugs
  const startMs = before ? Math.max(now + 2 * MIN, v.legs[0].dep.plan - 60 * MIN) : Math.max(now, v.transfers[k].arrRt + 3 * MIN);
  const current = trip.legs.slice(before ? 0 : k + 1, mi).map(l => `${l.label}@${Date.parse(l.from.plan)}`).join("|");
  const cs = await connections(env, fromEva, must.from.eva, startMs, own);
  return cs.filter(c => !c.legs.some(l => l.cancelled) && Date.parse(c.legs[c.legs.length - 1].to.rt || c.arr) <= deadline)
    .filter(c => c.legs.map(l => `${l.label}@${Date.parse(l.from.plan)}`).join("|") !== current)
    .sort((x, y) => Date.parse(y.dep) - Date.parse(x.dep)).slice(0, 2)            // möglichst spät los, aber rechtzeitig
    .map(c => ({ kind: "must", minGap: Number.isFinite(minGapOf(c.legs)) ? minGapOf(c.legs) : null, from: before ? "start" : k, until: mi, at: before ? v.legs[0].dep.name : v.transfers[k].at, label: `${c.legs.map(l => l.label).join(" → ")} → ${must.label}`,
      transfers: c.transfers + 1, dep: c.legs[0].from.plan, depPl: c.legs[0].from.track || "", arr: trip.legs[trip.legs.length - 1].to.plan,
      toName: (trip.legs[trip.legs.length - 1].to.name || "").replace(/\s*\(tief\)$/i, ""), reach: `${must.label} in ${must.from.name} erreicht`, legs: c.legs }));
}
const nearestEvaByName = name => searchStationsSync(name)?.[0]?.eva || "";

// Bewertung + Plan B + Meldungen für eine Reise (nach dem Beobachten)
export async function assess(env, trip, now, cache) {
  let v = evaluate(trip, now);
  const prev = { ...(trip.state || {}) }, alt = { ...(prev.alt || {}) }, altAt = { ...(prev.altAt || {}) };
  for (const t of v.transfers) {
    const k = v.transfers.indexOf(t);
    if (t.status === "RISK" || t.status === "LOST" || t.status === "WATCH") {
      if (!alt[k] || now - (altAt[k] || 0) > (t.status === "WATCH" ? 10 : 5) * MIN) { try { alt[k] = await planB(env, trip, v, k, now); altAt[k] = now; } catch (e) { console.log("Plan B:", e.message); } }
    } else if (t.status === "OK" || t.status === "DONE") { delete alt[k]; delete altAt[k]; }
  }
  const { state, msgs } = diff(trip, v, { ...prev, alt }, now);
  trip.state = { ...state, alt, altAt, status: v.status, at: now };
  const last = v.legs[v.legs.length - 1];
  if (v.phase === "done" && now > last.arr.rt + 30 * MIN) trip.active = false;
  trip.ends_at = new Date(last.arr.rt).toISOString();
  return { v, msgs };
}

const saveTrip = (env, t) => db.update(env, "rb_trips", t.id, { obs: t.obs, state: t.state, active: t.active, ends_at: t.ends_at, ...(t._legsDirty ? { legs: t.legs } : {}), updated_at: new Date().toISOString() });

// Bahn-Teilstrecken ohne DB-Fahrtkennung (z. B. aus einem Ticket für in ein paar Tagen) nachträglich verknüpfen,
// sobald die Abfahrt weniger als 6 Std. entfernt ist – höchstens alle 30 Min. je Teilstrecke
const RAILY = /^(ICE|IC|EC|ECE|RJX?|NJ|EN|FLX|TGV|IRE|RE|RB|S|MEX|FEX|HBX|ERB|NWB|ME|BRB|ALX|ODEG|STB)\b/i;
export async function bindLate(env, trip, now, cache) {
  let changed = false;
  for (let i = 0; i < trip.legs.length; i++) {
    const l = trip.legs[i], dep = Date.parse(l.from.plan), key = `bind${i}`;
    if (l.jid || !l.from.eva || !l.to.eva || !RAILY.test(l.label) || dep - now > 6 * 3600e3 || dep < now - 10 * MIN) continue;
    if (now - (trip.state?.[key] || 0) < 30 * MIN) continue;
    trip.state = { ...(trip.state || {}), [key]: now };
    const num = (l.label.match(/(\d{2,6})\s*$/) || [])[1] || "";
    const r = await resolveLeg(env, { rail: true, label: l.label, num, line: l.label.replace(/\s+/g, ""), mode: l.mode || "RAIL",
      from: { ...l.from, track: l.from.platform }, to: { ...l.to, track: l.to.platform } }, cache).catch(() => null);
    if (r?.jid) { trip.legs[i] = { ...l, jid: r.jid, label: r.label, from: { ...l.from, plan: r.from.plan, platform: r.from.platform }, to: { ...l.to, plan: r.to.plan, platform: r.to.platform } }; changed = true; }
  }
  if (changed) trip._legsDirty = true;
  return changed;
}

// Cron: jede Minute
export async function runMonitor(env, now = Date.now()) {
  const trips = await db.activeTrips(env), cache = new Map();
  for (const t of trips) await bindLate(env, t, now, cache).catch(() => {});
  const checks = trips.flatMap(t => dueChecks(t, now)).sort((a, b) => a.dist - b.dist).slice(0, 24);
  await observe(env, checks, now, cache);
  const out = new Map();
  for (const t of trips) {
    const before = JSON.stringify(t.state || {});
    const { msgs } = await assess(env, t, now, cache);
    if (t._dirty || t._legsDirty || !t.active || JSON.stringify(t.state) !== before) await saveTrip(env, t).catch(e => console.log("Speichern:", e.message));
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
  const keep = a.from === "start" ? 0 : k + 1, tail = a.until != null ? trip.legs.slice(a.until) : [], tailObs = a.until != null ? (trip.obs || []).slice(a.until) : [];
  trip.legs = [...trip.legs.slice(0, keep), ...fresh, ...tail];
  trip.obs = [...(trip.obs || []).slice(0, keep), ...fresh.map(() => ({})), ...tailObs];
  trip.state = { ...(trip.state || {}), tr: [], alt: {}, altAt: {}, rem: Object.fromEntries(Object.entries(trip.state?.rem || {}).filter(([i]) => +i < keep)) };
  trip.ends_at = trip.legs[trip.legs.length - 1].to.plan;
  return trip;
}
