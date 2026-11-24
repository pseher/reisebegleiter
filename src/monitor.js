// Überwachung: Echtzeit für laufende Reisen holen, bewerten, Plan B vorbereiten, Meldungen schicken.
import { evaluate, diff, transferMinutes, changesFV } from "./engine.js";
import { findJourney } from "./openboards.js";
import { connections, resolveConnection, resolveLeg } from "./routing.js";
import { search as searchStationsSync, byEva } from "./stations.js";
import * as db from "./db.js";
import { sendPush } from "./push.js";
import { busLive } from "./buslive.js";
import { makeDue, refreshWindow } from "./routines.js";

const MIN = 60e3;
// Wie oft ein Halt geprüft wird – je näher, desto öfter (Minuten)
export const intervalFor = dist => (dist <= 45 * MIN ? 1 : dist <= 150 * MIN ? 4 : dist <= 6 * 3600e3 ? 15 : null);

// Fällige Abfragen einer Reise
export function dueChecks(trip, now, force = false) {
  const out = [];
  trip.legs.forEach((leg, i) => {
    if (!leg.jid) {
      // Bus/Tram/U-Bahn: über Transitous (tid) bzw. in Berlin/Brandenburg über die VBB-Auskunft, ab 2 Std. vorher
      const inVBB = s => s?.lat != null && s.lat > 51.3 && s.lat < 53.6 && s.lon > 11.2 && s.lon < 14.8;
      if (!leg.tid && !inVBB(leg.from)) return;
      const o = trip.obs?.[i] || {}, effOf = (s, ob) => (ob?.rt ? Date.parse(ob.rt) : Date.parse(s.plan));
      const dEff = effOf(leg.from, o.dep), aEff = effOf(leg.to, o.arr);
      if (aEff < now - 3 * MIN) return;
      const dist = Math.max(0, (dEff > now ? dEff : aEff) - now);
      if (dist > 2 * 3600e3) return;
      const iv = intervalFor(dist) || 15;
      if (!force && o.bt && now - o.bt < iv * MIN - 20e3) return;
      out.push({ trip, i, side: "bus", leg, dist });
      return;
    }
    if (!leg.from.eva || !leg.to.eva) return;
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
    if (c.side === "bus") {
      const r = await busLive(env, c.leg, now, cache).catch(e => { console.log("Bus-Echtzeit:", e.message); return {}; });
      const obs = (c.trip.obs ||= []), o = (obs[c.i] ||= {});
      if (r.dep) o.dep = r.dep;
      if (r.arr) o.arr = r.arr;
      o.bt = now; c.trip._dirty = true;
      return;
    }
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
  // Start/Ziel als Ort: DB-Bahnhof oder – z. B. bei Bus-Haltestellen ohne DB-Nummer – über die Koordinaten
  const finalEva = placeOf(last.to) || nearestEvaByName(last.to.name);
  if (!finalEva) return [];
  const before = now < v.legs[0].dep.rt - MIN;
  const fromEva = before ? placeOf(trip.legs[0].from) : placeOf(trip.legs[k].to);
  if (!fromEva) return [];
  // Vor der Abfahrt auch frühere Abfahrten zulassen (bis 75 Min. vor Plan) – „ein paar Minuten eher los“
  const fromMs = before ? Math.max(now + 2 * MIN, v.legs[0].dep.plan - 75 * MIN) : Math.max(now, t.arrRt + Math.max(own, 3) * MIN);
  const current = trip.legs.slice(before ? 0 : k + 1).map(l => `${l.label}@${Date.parse(l.from.plan)}`).join("|");
  const curArr = v.legs[v.legs.length - 1].arr.rt;
  const curMin = v.transfers.filter(x => x.status !== "DONE").reduce((m, x) => Math.min(m, x.gap), Infinity);
  // Zwei Anfragen: normal und „mit mehr Luft“ – der Planer liefert sonst bei gleicher Ankunft nur die späteste (knappste) Abfahrt
  // Unterwegs zusätzlich: fährt der eigene Zug selbst weiter Richtung Ziel? („Sitzen bleiben“)
  const curLeg = trip.legs[k], curV = v.legs[k];
  const [normal, roomy, stayList] = await Promise.all([
    connections(env, fromEva, finalEva, fromMs, own).catch(() => []),
    connections(env, fromEva, finalEva, fromMs, Math.max(own, 5) + 7).catch(() => []),
    before || !curLeg ? [] : connections(env, fromEva, finalEva, curV.arr.plan - MIN, 0).catch(() => []),
  ]);
  const sameTrain = l => { const n = s => String(s || "").replace(/\D/g, ""); return (n(l.num) && n(l.num) === n(curLeg.label)) || l.label.replace(/\s/g, "") === curLeg.label.replace(/\s/g, ""); };
  const stay = stayList.find(c => c.legs.length && sameTrain(c.legs[0]) && !c.legs.some(l => l.cancelled));
  const seen = new Set(), all = [];
  for (const c of [...roomy, ...normal]) {
    const key = c.legs.map(l => `${l.label}@${Date.parse(l.from.plan)}`).join("|");
    if (key === current || seen.has(key) || c.legs.some(l => l.cancelled)) continue;
    if (stay && sameTrain(c.legs[0])) continue;
    seen.add(key); all.push({ c, arr: rtOf(c.legs[c.legs.length - 1].to), minGap: minGapOf(c.legs) });
  }
  // Zeiten mit Echtzeit (falls bekannt), damit der Vergleich mit „Dein Plan“ fair ist
  const mk = (x, kind) => ({ kind, from: before ? "start" : k, at: before ? v.legs[0].dep.name : t.at, label: x.c.legs.map(l => l.label).join(" → "), transfers: x.c.transfers,
    dep: new Date(rtOf(x.c.legs[0].from)).toISOString(), depPlan: x.c.legs[0].from.plan, depPl: x.c.legs[0].from.track || "",
    arr: new Date(x.arr).toISOString(), arrPlan: x.c.legs[x.c.legs.length - 1].to.plan, minGap: Number.isFinite(x.minGap) ? x.minGap : null,
    toName: (last.to.name || "").replace(/\s*\(tief\)$/i, ""), legs: x.c.legs });
  const out = [];
  // Sitzen bleiben: Ankunft mindestens mit der aktuellen Verspätung des eigenen Zugs
  if (stay) {
    const lastL = stay.legs[stay.legs.length - 1].to, arr = Math.max(rtOf(lastL), Date.parse(lastL.plan) + Math.max(0, curV.arr.delay) * MIN);
    out.push(mk({ c: stay, arr, minGap: minGapOf(stay.legs) }, "stay"));
  }
  // Plan geht nicht mehr (Ausfall/Anschluss weg): einfach die nächsten Möglichkeiten nach Ankunft – ein Vergleich mit dem kaputten Plan wäre irreführend
  if (t.status === "LOST") {
    for (const x of all.filter(x => x.minGap >= Math.max(own, 2) || x.minGap === Infinity).sort((a, b) => a.arr - b.arr).slice(0, 3 - out.length)) out.push(mk(x, "next"));
    const res0 = out.slice(0, 3), replaced0 = before ? trip.legs : trip.legs.slice(k + 1);
    for (const a of res0) a.zb = a.kind === "stay" ? replaced0.some(l => l.label !== curLeg.label && isFVLeg(l)) : changesFV(replaced0, a.legs);
    await watchAlts(env, res0, now, own).catch(e => console.log("Alternativen beobachten:", e.message));
    return res0;
  }
  // Sicherer: gleiche (oder frühere) Ankunft, deutlich mehr Umstiegszeit – möglichst spät los
  const safer = all.filter(x => x.arr <= curArr + 2 * MIN && x.minGap >= Math.max(curMin + 4, own + 3)).sort((a, b) => Date.parse(b.c.dep) - Date.parse(a.c.dep))[0];
  if (safer) out.push(mk(safer, "safer"));
  // Schneller: früher am Ziel
  const faster = all.filter(x => x !== safer && x.arr < curArr - 2 * MIN && (x.minGap >= own || x.minGap === Infinity)).sort((a, b) => a.arr - b.arr)[0];
  if (faster) out.push(mk(faster, "faster"));
  // Später: nächste entspannte Möglichkeit, falls der Plan kippt
  const later = all.filter(x => x !== safer && x !== faster && x.arr > curArr + 2 * MIN).sort((a, b) => a.arr - b.arr)[0];
  if (later) out.push(mk(later, "later"));
  const res = out.slice(0, 3);
  const replaced = before ? trip.legs : trip.legs.slice(k + 1);
  for (const a of res) a.zb = a.kind === "stay" ? replaced.some(l => l.label !== curLeg.label && isFVLeg(l)) : changesFV(replaced, a.legs);
  await watchAlts(env, res, now, own).catch(e => console.log("Alternativen beobachten:", e.message));
  return res;
}

// Alternativen gleichzeitig beobachten: jede Teilstrecke den DB-Echtzeitdaten zuordnen (ab 3 Std. vor Abfahrt)
// und festhalten, ob sie pünktlich ist und ob ihre Umstiege mit Echtzeit noch klappen.
export async function watchAlts(env, alts, now, own = 0, cache = new Map()) {
  for (const a of alts) {
    if (!a.legs?.length || Date.parse(a.depPlan || a.dep) - now > 3 * 3600e3) { a.watch = null; continue; }
    const legs = [];
    for (const l of a.legs) {
      const dPlan = Date.parse(l.from.plan), aPlan = Date.parse(l.to.plan);
      let r = l.rail ? await resolveLeg(env, l, cache).catch(() => null) : null;
      // Bus, Tram, U-Bahn: eigene Echtzeit (Transitous bzw. VBB), ab 2 Std. vor der Abfahrt
      if (!r?.jid && !l.rail && dPlan - now < 2 * 3600e3 && Date.parse(l.to.plan) > now - 3 * MIN) {
        const b = await busLive(env, { ...l, tid: l.tid || l.tripId }, now, cache).catch(() => null);
        if (b?.dep || b?.arr) r = { live: { dep: b.dep && { rt: b.dep.rt, c: b.dep.c, rtKnown: b.dep.live }, arr: b.arr && { rt: b.arr.rt, c: b.arr.c, rtKnown: b.arr.live } } };
      }
      const dRt = Date.parse(r?.live?.dep?.rt || l.from.rt || l.from.plan);
      // „live“ nur mit echter Prognose – sonst wäre „pünktlich“ geraten
      const live = !!(r?.live?.dep?.rtKnown || r?.live?.arr?.rtKnown) || (!r && !!l.live);
      const dDelay = Math.round((dRt - dPlan) / MIN);
      // Ankunft: echte Prognose, sonst die bekannte Abfahrtsverspätung mitnehmen (nie die reine Fahrplanzeit als „pünktlich“ werten)
      const aRt = r?.live?.arr?.rtKnown ? Date.parse(r.live.arr.rt) : Math.max(Date.parse(l.to.rt || l.to.plan), aPlan + Math.max(0, dDelay) * MIN);
      legs.push({ label: l.label, live, liveArr: !!r?.live?.arr?.rtKnown || (!r && !!l.live), dep: dRt, arr: aRt, delay: dDelay, arrDelay: Math.round((aRt - aPlan) / MIN),
        pl: r?.live?.dep?.pl || l.from.track || "", c: !!(l.cancelled || r?.live?.dep?.c || r?.live?.arr?.c) });
    }
    const gaps = legs.slice(1).map((l, i) => Math.round((l.dep - legs[i].arr) / MIN));
    const gi = gaps.length ? gaps.indexOf(Math.min(...gaps)) : -1;
    const point = gi < 0 ? null : { at: String(a.legs[gi].to.name || "").replace(/\s*\(tief\)$/i, ""), arr: new Date(legs[gi].arr).toISOString(), dep: new Date(legs[gi + 1].dep).toISOString(), gap: gaps[gi] };
    const minGap = gaps.length ? Math.min(...gaps) : null, cancelled = legs.some(l => l.c);
    const ok = !cancelled && (minGap == null || minGap >= Math.max(2, Math.min(own || 2, 5)));
    a.watch = { t: now, point, live: legs.some(l => l.live), delay: legs[0].delay, arrDelay: legs[legs.length - 1].arrDelay, cancelled, minGap, ok,
      legs: legs.map(l => ({ label: l.label, delay: l.delay, arrDelay: l.arrDelay, dep: new Date(l.dep).toISOString(), arr: new Date(l.arr).toISOString(), c: l.c, live: l.live })) };
    a.dep = new Date(legs[0].dep).toISOString();
    // Ohne echte Prognose fürs Ziel die bisherige (ggf. höhere) Schätzung nicht unterbieten
    const lastL = legs[legs.length - 1], prevArr = Date.parse(a.arr) || 0;
    a.arr = new Date(lastL.liveArr ? lastL.arr : Math.max(lastL.arr, prevArr)).toISOString();
    a.depPl = legs[0].pl || a.depPl;
  }
  return alts;
}
const rtOf = s => Math.max(Date.parse(s.rt || s.plan) || 0, Date.parse(s.plan) || 0) || Date.parse(s.plan);

// Alternativen ab dem aktuellen Standort (auf Wunsch aus der App): bis zu 3 Verbindungen zum Ziel, live mitgeprüft
// mode "trip": im Zeitraum der Reise (ab ca. 75 Min. vor der geplanten Abfahrt) – "now": ab sofort
export async function planFromHere(env, trip, v, here, now, mode = "trip", missedIdx = 0) {
  const last = trip.legs[trip.legs.length - 1], own = +trip.legs[0]?.minT || 0;
  const ci = Math.max(0, v.current), waiting = mode === "next" && now < v.legs[ci].dep.rt;   // am Umstieg wartend: ab diesem Bahnhof, sofort
  const from = mode === "cancel" ? Math.max(now, v.legs[missedIdx].dep.plan - 60 * MIN) : mode === "now" || mode === "missed" || waiting ? now : mode === "next" ? Math.max(now, v.legs[ci].arr.rt) : Math.max(now, v.legs[0].dep.plan - (mode === "start" ? 60 : 75) * MIN);
  const to = placeOf(last.to) || nearestEvaByName(last.to.name);
  if (!to) return [];
  const [normal, roomy, stayList] = await Promise.all([
    connections(env, here, to, from, own).catch(() => []),
    connections(env, here, to, from, Math.max(own, 5) + 7).catch(() => []),
    // unterwegs: fährt dein Zug selbst weiter? (Suche ab seiner geplanten Ankunft, sonst wäre er schon „weg“)
    mode === "next" && !waiting ? connections(env, here, to, v.legs[ci].arr.plan - MIN, 0).catch(() => []) : [],
  ]);
  const curLbl = trip.legs[ci]?.label.replace(/\s/g, "");
  const stays = stayList.filter(c => c.legs[0]?.label.replace(/\s/g, "") === curLbl).map(c => {
    // Ankunft mindestens mit der aktuellen Verspätung deines Zugs
    const d = Math.max(0, v.legs[ci].arr.delay || 0), last = c.legs[c.legs.length - 1];
    return { ...c, legs: c.legs.map((l, j) => (j === c.legs.length - 1 ? { ...l, to: { ...l.to, rt: new Date(Math.max(rtOf(l.to), Date.parse(l.to.plan) + d * MIN)).toISOString() } } : l)) };
  });
  // „Wie geplant“ nur, wenn es genau deine Bahn-Züge sind (Busse/U-Bahn davor dürfen abweichen)
  const sig = legs => legs.filter(l => l.rail !== false && (l.rail || l.jid)).map(l => l.label.replace(/\s/g, "")).join("|");
  const rest = mode === "next" ? trip.legs.slice(waiting ? ci : ci + 1) : (mode === "missed" || mode === "cancel") ? trip.legs.slice(missedIdx) : trip.legs;     // unterwegs: nur der Rest der Reise zählt
  const planSig = sig(rest);
  const seen = new Set(), all = [];
  for (const c of [...stays, ...normal, ...roomy]) {
    const key = c.legs.map(l => `${l.label}@${Date.parse(l.from.plan)}`).join("|");
    if (seen.has(key) || c.legs.some(l => l.cancelled)) continue;
    // nach „verpasst“: den verpassten Zug selbst nicht wieder anbieten
    if (mode === "missed" || mode === "cancel") { const m = trip.legs[missedIdx];
      if (c.legs.some(l => l.label.replace(/\s/g, "") === m.label.replace(/\s/g, "") && Math.abs(Date.parse(l.from.plan) - Date.parse(m.from.plan)) < 3 * MIN)) continue; }
    seen.add(key); all.push(c);
  }
  const toName = (last.to.name || "").replace(/\s*\(tief\)$/i, "");
  const out = all.sort((a, b) => rtOf(a.legs[a.legs.length - 1].to) - rtOf(b.legs[b.legs.length - 1].to)).slice(0, 3).map(c => ({
    kind: mode === "missed" || mode === "cancel" ? "here" : sig(c.legs) === planSig ? "asplanned" : !changesFV(rest, c.legs) && rest.some(isFVLeg) ? "samefv" : "here",
    // unterwegs: ab dem nächsten Halt ersetzen; fährt der eigene Zug weiter, ist es „Sitzen bleiben“
    from: mode === "next" ? (waiting ? (ci > 0 ? ci - 1 : "start") : ci) : (mode === "missed" || mode === "cancel") && missedIdx > 0 ? missedIdx - 1 : "start", stay: mode === "next" && !waiting && c.legs[0]?.label.replace(/\s/g, "") === trip.legs[ci].label.replace(/\s/g, ""), at: mode === "next" ? trip.legs[ci].to.name : "deinem Standort",
    label: c.legs.map(l => l.label).join(" → "), transfers: c.transfers, walkStart: c.walkStart || 0,
    dep: new Date(rtOf(c.legs[0].from)).toISOString(), depPlan: c.legs[0].from.plan, depPl: c.legs[0].from.track || "", firstStop: c.legs[0].from.name,
    arr: new Date(rtOf(c.legs[c.legs.length - 1].to)).toISOString(), arrPlan: c.legs[c.legs.length - 1].to.plan, minGap: Number.isFinite(minGapOf(c.legs)) ? minGapOf(c.legs) : null,
    toName, legs: c.legs }));
  for (const a of out) a.zb = changesFV(rest, a.legs);
  await watchAlts(env, out, now, own).catch(e => console.log("Standort beobachten:", e.message));
  return out;
}

async function planToMust(env, trip, v, k, mi, now, own) {
  const must = trip.legs[mi], before = now < v.legs[0].dep.rt - MIN;
  const fromEva = before ? placeOf(trip.legs[0].from) : placeOf(trip.legs[k].to);
  if (!fromEva || (fromEva.eva && fromEva.eva === must.from.eva)) return [];
  const deadline = v.legs[mi].dep.rt - Math.max(own, 3) * MIN;             // spätestens hier am Bahnsteig des Pflichtzugs
  const startMs = before ? Math.max(now + 2 * MIN, v.legs[0].dep.plan - 60 * MIN) : Math.max(now, v.transfers[k].arrRt + 3 * MIN);
  const current = trip.legs.slice(before ? 0 : k + 1, mi).map(l => `${l.label}@${Date.parse(l.from.plan)}`).join("|");
  const cs = await connections(env, fromEva, must.from.eva, startMs, own);
  return cs.filter(c => !c.legs.some(l => l.cancelled) && Date.parse(c.legs[c.legs.length - 1].to.rt || c.arr) <= deadline)
    .filter(c => c.legs.map(l => `${l.label}@${Date.parse(l.from.plan)}`).join("|") !== current)
    .sort((x, y) => Date.parse(y.dep) - Date.parse(x.dep)).slice(0, 2)            // möglichst spät los, aber rechtzeitig
    .map(c => ({ kind: "must", minGap: Number.isFinite(minGapOf(c.legs)) ? minGapOf(c.legs) : null, from: before ? "start" : k, until: mi, at: before ? v.legs[0].dep.name : v.transfers[k].at, label: `${c.legs.map(l => l.label).join(" → ")} → ${must.label}`,
      transfers: c.transfers + 1, dep: new Date(rtOf(c.legs[0].from)).toISOString(), depPlan: c.legs[0].from.plan, depPl: c.legs[0].from.track || "", arr: trip.legs[trip.legs.length - 1].to.plan,
      toName: (trip.legs[trip.legs.length - 1].to.name || "").replace(/\s*\(tief\)$/i, ""), reach: `${must.label} in ${must.from.name} erreicht`, legs: c.legs }));
}
const nearestEvaByName = name => searchStationsSync(name)?.[0]?.eva || "";
const isFVLeg = l => /^(ICE|IC|EC|ECE|ICD|RJX?|NJ|EN|TGV|EST|D)\s?\d/i.test(String(l?.label || ""));
const placeOf = s => (s?.eva ? { eva: s.eva, lat: s.lat, lon: s.lon } : s?.lat != null && s?.lon != null ? { lat: s.lat, lon: s.lon } : null);

// Bewertung + Plan B + Meldungen für eine Reise (nach dem Beobachten)
export async function assess(env, trip, now, cache) {
  let v = evaluate(trip, now);
  const prev = { ...(trip.state || {}) }, alt = { ...(prev.alt || {}) }, altAt = { ...(prev.altAt || {}) };
  const firstDep = v.legs[0].dep.rt;
  for (const t of v.transfers) {
    const k = v.transfers.indexOf(t);
    const acute = t.status === "RISK" || t.status === "LOST" || t.status === "WATCH";
    // Schon im Fahrplan knapp: ab 4 Std. vor Reisebeginn Ausweichmöglichkeiten bereithalten und beobachten
    const calm = t.status === "OK" && t.tightPlan && firstDep - now < 4 * 3600e3;
    if (acute || calm) {
      // je näher und je kritischer, desto öfter (Alternativen werden dabei auch mit Echtzeit geprüft)
      const every = t.status === "RISK" || t.status === "LOST" ? 4 : t.arrRt - now < 90 * MIN ? 5 : 12;
      if (!alt[k] || now - (altAt[k] || 0) > every * MIN) { try { alt[k] = await planB(env, trip, v, k, now); altAt[k] = now; } catch (e) { console.log("Plan B:", e.message); } }
    } else if (t.status === "OK" || t.status === "DONE") { delete alt[k]; delete altAt[k]; }
  }
  // Ausfall ohne Umstieg dahinter (z. B. nur ein Zug): selbst die nächsten Möglichkeiten ab dieser Station suchen
  let here = prev.here;
  if (v.legCancel != null && v.phase !== "done" && !v.transfers.some(t => t.reason === "cancel" && alt[v.transfers.indexOf(t)]?.length)) {
    const ci = v.legCancel, fresh = here?.mode === "cancel" && here.idx === ci && now - here.at < 10 * MIN;
    const st = placeOf(trip.legs[ci].from) || (trip.legs[ci].from.lat != null ? { lat: trip.legs[ci].from.lat, lon: trip.legs[ci].from.lon, name: trip.legs[ci].from.name } : null);
    if (!fresh && st) { try { here = { mode: "cancel", idx: ci, at: now, list: await planFromHere(env, trip, v, st, now, "cancel", ci) }; } catch (e) { console.log("Ausfall-Suche:", e.message); } }
  }
  const d0 = diff(trip, v, { ...prev, alt }, now), state = d0.state;
  // „Zug verpasst“: du kümmerst dich gerade selbst darum. Zeitfenster ohne Wahl: noch keine Meldungen (welche Fahrt du nimmst, ist offen)
  const msgs = prev.missed || (prev.win && !prev.win.picked) ? [] : d0.msgs;
  trip.state = { ...prev, ...state, alt, altAt, here, status: v.status, at: now };   // übrige Merker (z. B. undo, geo, bind…) behalten
  const last = v.legs[v.legs.length - 1];
  if ((v.phase === "done" && now > last.arr.rt + 30 * MIN) || now > last.arr.rt + 4 * 3600e3) trip.active = false;
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
    if (r?.jid) { trip.legs[i] = { ...l, jid: r.jid, label: r.label, from: { ...l.from, plan: r.from.plan, platform: r.from.platform }, to: { ...l.to, plan: r.to.plan, platform: r.to.platform, estimated: false } }; changed = true; }
  }
  if (changed) trip._legsDirty = true;
  return changed;
}

// Cron: jede Minute
export async function runMonitor(env, now = Date.now()) {
  // Regelmäßige Fahrten: fällige Reisen anlegen, bevor überwacht wird
  const rMsgs = await makeDue(env, now, (opts, own) => watchAlts(env, opts, now, own || 0)).catch(e => { console.log("Regelmäßig:", e.message); return []; });
  const trips = await db.activeTrips(env), cache = new Map();
  for (const t of trips) await bindLate(env, t, now, cache).catch(() => {});
  const checks = trips.flatMap(t => dueChecks(t, now)).sort((a, b) => a.dist - b.dist).slice(0, 24);
  await observe(env, checks, now, cache);
  const out = new Map();
  for (const t of trips) {
    const before = JSON.stringify(t.state || {});
    if (t.state?.win && !t.state.win.picked) await refreshWindow(env, t, now, opts => watchAlts(env, opts, now, +t.legs[0]?.minT || 0, cache)).catch(e => console.log("Zeitfenster:", e.message));
    if (!t.active) { await saveTrip(env, t).catch(() => {}); continue; }
    const { msgs } = await assess(env, t, now, cache);
    if (t._dirty || t._legsDirty || !t.active || JSON.stringify(t.state) !== before) await saveTrip(env, t).catch(e => console.log("Speichern:", e.message));
    const acc = t.account_id || t.device_id;   // Meldungen gehen an alle Geräte des Kontos
    if (msgs.length) out.set(acc, [...(out.get(acc) || []), ...msgs.slice(0, 4).map(m => ({ ...m, url: `/?trip=${encodeURIComponent(t.id)}` }))]);
  }
  for (const m of rMsgs) { const { acc, ...msg } = m; out.set(acc, [...(out.get(acc) || []), msg]); }
  let sent = 0;
  if (out.size) {
    const devs = await db.devicesOf(env, [...out.keys()], "id,push,account_id");
    for (const d of devs) {
      if (!d.push && env.MOCK === "1") { out.get(d.account_id).forEach(m => console.log("PUSH (kein Abo)", m.title, "–", m.body)); continue; }
      if (!d.push) continue;
      for (const m of out.get(d.account_id)) {
        const st = await deliver(env, d.push, { url: "/", ...m });
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
export async function adopt(env, trip, k, idx, fromHere = false, fromSos = false) {
  const a = fromSos ? trip.state?.sos?.list?.[idx] : fromHere ? trip.state?.here?.list?.[idx] : trip.state?.alt?.[k]?.[idx];
  if ((fromHere || fromSos) && a && a.from !== "start") k = +a.from;
  if (!a?.legs?.length && !a?.cut) throw Object.assign(new Error("Diese Möglichkeit gibt es nicht mehr. Ich habe neu gesucht – bitte noch einmal wählen."), { user: true });
  const st0 = trip.state || {};
  const undo = { legs: trip.legs, obs: trip.obs || [], at: Date.now(), legC: st0.legC || {}, pl: st0.pl || {}, rem: st0.rem || {}, origArr: st0.origArr || null, missed: st0.missed || null, zbAt: st0.zbAt || null };
  // Grund für eine aufgehobene Zugbindung merken – nur wenn sie VOR dem Wechsel schon bestand (Störung), nicht durch den Wechsel selbst
  const zbAt = st0.zbAt || (evaluate(trip, Date.now()).zbLifted ? new Date().toISOString() : null);
  const origArr = st0.origArr || trip.legs[trip.legs.length - 1].to.plan;   // ursprünglich gebuchte Ankunft merken
  const fresh = (a.legs?.length ? await resolveConnection(env, a.legs) : []).map(({ live, ...l }) => ({ ...l, minT: +trip.legs[0]?.minT || 0 }));
  let keep = a.from === "start" ? 0 : k + 1;
  const tail = a.until != null ? trip.legs.slice(a.until) : [], tailObs = a.until != null ? (trip.obs || []).slice(a.until) : [];
  if (a.cut) {
    // SOS: im aktuellen Zug bis zum gewählten Halt fahren, dann weiter mit der neuen Verbindung
    const cur = trip.legs[k], b = byEva(a.cut.eva) || {};
    let head = { ...cur, must: false, to: { eva: a.cut.eva, name: a.cut.name, plan: a.cut.plan, platform: a.cut.platform || "", lat: b.lat ?? null, lon: b.lon ?? null } };
    if (fresh[0] && fresh[0].label.replace(/\s/g, "") === cur.label.replace(/\s/g, "")) head = { ...head, to: fresh.shift().to };   // erst noch im selben Zug weiter
    const o = { ...((trip.obs || [])[k] || {}) };
    const dl = o.arr?.rt ? Date.parse(o.arr.rt) - Date.parse(cur.to.plan) : 0;   // Verspätung mitnehmen, bis es eine neue Prognose gibt
    if (!o.dep?.rt && dl > 0) o.dep = { rt: new Date(Date.parse(cur.from.plan) + dl).toISOString(), live: false, t: o.arr.t, est: true };
    delete o.arr;
    trip.legs = [...trip.legs.slice(0, k), head, ...fresh];
    trip.obs = [...(trip.obs || []).slice(0, k), o, ...fresh.map(() => ({}))];
    keep = k;
  } else if ((a.kind === "stay" || a.stay) && fresh.length) {
    // Im selben Zug weiterfahren: die aktuelle Teilstrecke bis zum neuen Ausstieg verlängern
    const cur = trip.legs[k];
    trip.legs = [...trip.legs.slice(0, k), { ...cur, must: false, to: fresh[0].to }, ...fresh.slice(1)];
    const o = { ...((trip.obs || [])[k] || {}) };
    // Bekannte Verspätung am Umsteigebahnhof mitnehmen, bis es eine neue Prognose fürs Ziel gibt
    const dl = o.arr?.rt ? Date.parse(o.arr.rt) - Date.parse(cur.to.plan) : 0;
    if (!o.dep?.rt && dl > 0) o.dep = { rt: new Date(Date.parse(cur.from.plan) + dl).toISOString(), live: false, t: o.arr.t, est: true };
    delete o.arr;
    trip.obs = [...(trip.obs || []).slice(0, k), o, ...fresh.slice(1).map(() => ({}))];
    keep = k;
  } else {
    trip.legs = [...trip.legs.slice(0, keep), ...fresh, ...tail];
    trip.obs = [...(trip.obs || []).slice(0, keep), ...fresh.map(() => ({})), ...tailObs];
  }
  // Meldungsstand nur für die unveränderten Teilstrecken behalten
  // (beim Sitzenbleiben bleibt die Abfahrt der aktuellen Teilstrecke gleich, nur ihre Ankunft ist neu)
  const depKeep = a.kind === "stay" || a.stay || a.cut ? keep + 1 : keep;
  const low = (obj, n) => Object.fromEntries(Object.entries(obj || {}).filter(([i]) => +String(i).replace(/\D/g, "") < n));
  const st = trip.state || {};
  trip.state = { ...st, tr: [], alt: {}, altAt: {}, here: null, sos: null, rem: low(st.rem, keep), legC: low(st.legC, keep), pl: low(st.pl, depKeep), start: depKeep === 0 ? null : st.start, undo, origArr, zbAt, missed: null };
  trip.ends_at = trip.legs[trip.legs.length - 1].to.plan;
  return trip;
}

// Übernommenen Plan B zurücknehmen
export function undoAdopt(trip) {
  const u = trip.state?.undo;
  if (!u?.legs?.length || Date.now() - (u.at || 0) > 3 * 3600e3) throw Object.assign(new Error("Hier gibt es nichts mehr zurückzunehmen."), { user: true });
  trip.legs = u.legs; trip.obs = u.obs || [];
  const { undo, ...st } = trip.state;
  trip.state = { ...st, tr: [], alt: {}, altAt: {}, legC: u.legC || {}, pl: u.pl || {}, rem: u.rem || {}, origArr: u.origArr || undefined, missed: u.missed || null, zbAt: u.zbAt || null };
  trip.ends_at = trip.legs[trip.legs.length - 1].to.plan;
  return trip;
}
