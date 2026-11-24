// Entscheidungslogik – reine Funktionen, ohne Netz. Wird vom Worker (Überwachung, Anzeige) und von den Tests genutzt.

export const SEV = { DONE: 0, OK: 1, WATCH: 2, RISK: 3, LOST: 4 };
const MIN = 60e3;

// Große Knoten: längere Umstiegszeit (Faustregel, bis offizielle Werte vorliegen)
export const HUBS = new Set(["8011160", "8098160", "8002549", "8000105", "8000207", "8000261", "8000152", "8010205", "8000096",
  "8000284", "8000085", "8000244", "8010101", "8000080", "8000098", "8000191", "8000050", "8000128", "8010159", "8000013"]);

// Zugbindung gilt nur für Fernverkehrszüge (ICE, IC, EC …) – Bus, S-/U-Bahn, Tram und Regionalzüge sind frei
const FV_RE = /^(ICE|IC|EC|ECE|ICD|RJX?|NJ|EN|TGV|EST|D)\s?\d/i;
export const isFV = l => FV_RE.test(String(l?.label || "").trim()) || ["HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL"].includes(l?.mode);
// Derselbe Zug = gleiche Zugnummer am selben Tag – egal, an welchem Bahnhof man zusteigt
const fvKey = l => `${String(l.label).replace(/\s/g, "").toUpperCase()}@${new Date(Date.parse(l.from?.plan || 0) - 4 * 3600e3).toISOString().slice(0, 10)}`;
// Ändert eine Alternative die gebuchten Fernverkehrszüge? (nur dann ist die Zugbindung ein Thema)
export function changesFV(planLegs, altLegs) {
  const a = planLegs.filter(isFV).map(fvKey).sort().join("|"), b = altLegs.filter(isFV).map(fvKey).sort().join("|");
  return a !== b;
}
export const hm = ms => new Date(ms).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const T = x => (x ? Date.parse(x) : NaN);
const cleanName = n => String(n || "").replace(/\s*\(tief\)$/i, "");

// Umstiegszeit in Minuten
// Gleise 1/2, 3/4, 5/6 … liegen meist am selben Bahnsteig (Faustregel)
const islandOf = pl => { const n = parseInt(pl, 10); return Number.isFinite(n) && /^\d+$/.test(String(pl).trim()) ? Math.ceil(n / 2) : null; };
export function transferMinutes(arrEva, arrPl, depEva, depPl) {
  if (arrEva && depEva && arrEva !== depEva) return HUBS.has(arrEva) ? 10 : 8;   // anderer Bahnhofsteil, z. B. Berlin Hbf oben ↔ tief
  if (arrPl && depPl && arrPl === depPl) return 3;                                 // gleiches Gleis
  const a = islandOf(arrPl), d = islandOf(depPl);
  if (a != null && a === d) return HUBS.has(arrEva) ? 4 : 3;                        // vermutlich gleicher Bahnsteig
  return HUBS.has(arrEva) ? 8 : 5;
}

// Zusätzlicher Puffer: Verspätungen wachsen eher, als dass sie schrumpfen
// Ist der Zug schon verspätet, wächst die Verspätung oft weiter → mehr Puffer, je weiter die Ankunft entfernt ist.
// Ohne Verspätung nur ein kleiner Puffer für weit entfernte Umstiege.
export const growthBuffer = (minutesUntilArrival, delay = 0) => (minutesUntilArrival <= 0 ? 0
  : delay >= 3 ? Math.min(10, delay, Math.floor(minutesUntilArrival / 20)) : minutesUntilArrival > 90 ? 1 : 0);

// Halt (Abfahrt oder Ankunft) einer Teilstrecke mit Echtzeit zusammenführen
function stop(leg, o, side) {
  const s = leg[side], ob = o?.[side === "from" ? "dep" : "arr"] || {};
  const plan = T(s.plan), rt = Number.isFinite(T(ob.rt)) ? T(ob.rt) : plan;
  return { eva: s.eva, name: cleanName(s.name), lat: s.lat ?? null, lon: s.lon ?? null, plan, rt, delay: Math.round((rt - plan) / MIN), platformPlan: s.platform || "",
    platform: ob.pl || s.platform || "", cancelled: !!ob.c, live: !!ob.live, checked: ob.t || null, messages: ob.msgs || [] };
}

// Ohne eigene Prognose für die Ankunft: Verspätung bei der Abfahrt desselben Zugs mitnehmen
function carryDelay(dep, arr) {
  if (arr.live || dep.delay <= 0) return arr;
  const rt = Math.max(arr.rt, arr.plan + dep.delay * MIN);
  return { ...arr, rt, delay: Math.round((rt - arr.plan) / MIN), estimated: rt !== arr.rt || arr.estimated };
}

export function evaluate(trip, now = Date.now()) {
  const legs = trip.legs.map((l, i) => {
    const dep = stop(l, trip.obs?.[i], "from");
    const ob = trip.obs?.[i] || {};
    return { i, label: l.label, jid: l.jid, mode: l.mode || "", live: !!l.jid || !!ob.dep?.live || !!ob.arr?.live, must: !!l.must, dep, arr: carryDelay(dep, stop(l, trip.obs?.[i], "to")) };
  });
  const n = legs.length, first = legs[0], last = legs[n - 1];
  const transfers = [];
  for (let i = 0; i < n - 1; i++) {
    const a = legs[i].arr, d = legs[i + 1].dep;
    // Gehzeit: die Verbindungssuche rechnet die eigene Umstiegszeit mit ein – deshalb mit der echten Entfernung gegenprüfen
    const km = a.lat != null && d.lat != null ? Math.hypot((a.lat - d.lat) * 111, (a.lon - d.lon) * 111 * Math.cos(a.lat * Math.PI / 180)) : null;
    const byDist = km == null ? null : Math.max(1, Math.round(km * 1000 * 1.3 / 75)) + 1;   // Umweg-Faktor 1,3, 75 m/Min.
    let walk = trip.legs[i].walk || 0;
    if (byDist != null && (walk === 0 ? km > 0.15 : walk > byDist + 2)) walk = km > 0.15 ? byDist : 0;
    const samePlace = (km != null && km < 0.25) || plainName(a.name) === plainName(d.name);
    const gap = Math.round((d.rt - a.rt) / MIN), planGap = Math.round((d.plan - a.plan) / MIN);
    // Vom Fahrplan so geplante Umstiege gelten als machbar: höchstens die geplante Zeit verlangen (mind. 2 Min.)
    // Eigene Mindest-Umstiegszeit des Reisenden (Einstellung) gilt immer
    const own = +trip.legs[i].minT || 0;
    const usual = walk ? Math.max(walk + 1, 3) : transferMinutes(a.eva, a.platform, d.eva, d.platform);
    const need = Math.max(2, own, Math.min(usual, planGap));
    const tightPlan = planGap < Math.max(own, usual) + 3;              // schon im Fahrplan knapp → Ausweichmöglichkeiten bereithalten
    const until = Math.max(0, Math.round((a.rt - now) / MIN)), growth = growthBuffer(until, a.delay), spare = gap - need;
    let status, reason = "";
    const cancel = a.cancelled || d.cancelled || legs[i].dep.cancelled;
    if (d.rt < now - MIN && !cancel && gap >= 0) status = "DONE";                 // geschafft (oder zumindest rechtzeitig angekommen)
    else if (d.rt < now - MIN && !cancel) { status = "LOST"; reason = "late"; }   // Anschluss ist weg – bleibt verpasst
    else if (a.cancelled || d.cancelled || legs[i].dep.cancelled) { status = "LOST"; reason = "cancel"; }
    else if (gap < 0 && until <= 45) { status = "LOST"; reason = "late"; }
    else if (spare < growth) status = "RISK";
    else if (spare < growth + 2) status = "WATCH";
    else status = "OK";
    transfers.push({ i, at: a.name, eva: a.eva, gap, planGap, tightPlan, need, own, spare, growth, until, status, reason, toMust: !!trip.legs[i + 1].must,
      fromLabel: legs[i].label, toLabel: legs[i + 1].label, arrPl: a.platform, depPl: d.platform, depAt: d.name, walk, samePlace,
      fromLeg: { mode: legs[i].mode, label: legs[i].label }, toLeg: { mode: legs[i + 1].mode, label: legs[i + 1].label }, depRt: d.rt, arrRt: a.rt });
  }
  const openTransfers = transfers.filter(t => t.status !== "DONE");
  const lostAny = openTransfers.find(t => t.status === "LOST") || legs.find(l => l.dep.cancelled || l.arr.cancelled);
  // Nach einem verpassten Anschluss ist die Reise nicht „angekommen“, nur weil der verpasste Zug sein Ziel erreicht hat
  const phase = now < first.dep.rt ? "before" : now > last.arr.rt + 2 * MIN && !lostAny ? "done" : "enroute";
  const current = legs.findIndex(l => now < l.arr.rt + MIN);
  const legCancel = legs.find(l => (l.dep.cancelled || l.arr.cancelled) && (l.arr.rt > now - MIN || phase !== "done"));
  let status = openTransfers.reduce((s, t) => (SEV[t.status] > SEV[s] ? t.status : s), phase === "done" ? "DONE" : "OK");
  if (legCancel && phase !== "done") status = "LOST";
  const lostTransfer = openTransfers.find(t => t.status === "LOST");
  const missed = trip.state?.missed && legs[trip.state.missed.i] ? trip.state.missed.i : null;   // vom Reisenden gemeldet: Zug verpasst
  if (missed != null && phase !== "done") status = "LOST";
  const bookedArr = Date.parse(trip.state?.origArr || "") || last.arr.plan;   // nach „Übernehmen“: ursprünglich gebuchte Ankunft
  const finalDelay = lostTransfer || legCancel ? null : Math.round((last.arr.rt - bookedArr) / MIN);
  if (status === "OK" && phase !== "done" && (finalDelay ?? 0) >= 10) status = "WATCH";   // deutlich später am Ziel: nicht grün
  const zbLifted = trip.ticket === "spar" && legs.some(isFV) && (!!lostTransfer || !!legCancel || (finalDelay ?? 0) >= 20);
  const v = { status, phase: missed != null && phase === "done" ? "enroute" : phase, legs, transfers, current, finalDelay: missed != null ? null : finalDelay, bookedArr, zbLifted, legCancel: legCancel ? legCancel.i : null, missed };
  Object.assign(v, headline(v, trip, now));
  v.next = missed != null ? { kind: "missed", label: legs[missed].label, station: legs[missed].dep.name, at: legs[missed].dep.rt, i: missed } : nextStep(v, now);
  return v;
}

// Der eine nächste Schritt für den Reisenden: einsteigen, umsteigen, aussteigen
export function nextStep(v, now = Date.now()) {
  const { legs, transfers } = v;
  if (v.phase === "done") return null;
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i], before = transfers[i - 1];
    // Anschluss verpasst oder fällt aus: kein „Umsteigen in …“ mehr, sondern Hinweis auf Alternativen
    if (i > 0 && before?.status === "LOST" && now >= legs[i - 1].arr.rt - MIN) {
      return { kind: "lost", at: before.arrRt, station: before.at, label: before.toLabel, cancelled: before.reason === "cancel", lat: legs[i - 1].arr.lat, lon: legs[i - 1].arr.lon };
    }
    if (now < l.dep.rt - MIN / 2) {                       // noch nicht eingestiegen
      return { i, kind: i === 0 ? "board" : "change", mode: l.mode, at: l.dep.rt, plan: l.dep.plan, delay: l.dep.delay, label: l.label, station: l.dep.name,
        platform: l.dep.platform, platformChanged: !isStreet(l) && !!(l.dep.platformPlan && l.dep.platform && l.dep.platformPlan !== l.dep.platform), platformPlan: l.dep.platformPlan,
        cancelled: l.dep.cancelled, from: i > 0 ? { platform: legs[i - 1].arr.platform, gap: transfers[i - 1]?.gap, name: legs[i - 1].arr.name, lat: legs[i - 1].arr.lat, lon: legs[i - 1].arr.lon } : null,
        dest: l.arr.name, lat: l.dep.lat, lon: l.dep.lon };
    }
    if (now < l.arr.rt + MIN) {                            // unterwegs in diesem Zug
      const t = transfers[i];
      const nx = legs[i + 1];
      return { i, depAt: l.dep.rt, kind: t ? "ride-change" : "ride-arrive", at: l.arr.rt, plan: l.arr.plan, delay: l.arr.delay, label: l.label, station: l.arr.name, lat: l.arr.lat, lon: l.arr.lon,
        platform: l.arr.platform, cancelled: l.arr.cancelled, then: t ? { label: t.toLabel, at: t.depRt, delay: nx.dep.delay, platform: t.depPl, gap: t.gap, station: nx.dep.name, lat: nx.dep.lat, lon: nx.dep.lon,
          platformChanged: !isStreet(nx) && !!(nx.dep.platformPlan && nx.dep.platform && nx.dep.platformPlan !== nx.dep.platform), mode: nx.mode, platformPlan: nx.dep.platformPlan, lost: t.status === "LOST", cancelled: nx.dep.cancelled } : null };
    }
  }
  return null;
}

const mins = m => (m === 1 ? "1 Min." : `${m} Min.`);
// „S Hohenzollerndamm (Berlin)“ und „Hohenzollerndamm“ sind derselbe Ort
const plainName = n => cleanName(n).replace(/^(S\+U|S|U)\s+/i, "").replace(/\s*\([^)]*\)\s*$/, "").replace(/[^a-zäöüß0-9]/gi, "").toLowerCase();
// Bus/Tram/Fähre halten an Steigen, nicht an Gleisen – und deren Positionswechsel sind keine Meldung wert
export const isStreet = l => /BUS|TRAM|COACH|FERRY/i.test(l?.mode || "") || /^(Bus|Tram|STR|Fähre|ALT|AST)\b/i.test(String(l?.label || "").trim());
export const platWord = (l, p) => (!p ? "" : isStreet(l) ? `Steig ${String(p).replace(/^(Pos\.?|Position|Steig|Bstg\.?)\s*/i, "")}` : `Gleis ${p}`);
// „In Leipzig Hbf nur 4 Min. zum Umsteigen (Gleis 12 → 10).“ bzw. mit Fußweg zu einem anderen Halt
function xferText(t, amount) {
  const other = t.depAt && cleanName(t.depAt) !== t.at && !t.samePlace;
  const a = platWord(t.fromLeg, t.arrPl), d = platWord(t.toLeg, t.depPl);
  const pl = a && d ? ` (${a} → ${d})` : d ? ` (weiter von ${d})` : "";
  return other ? `Von ${t.at} zu ${cleanName(t.depAt)}: ${amount} für Fußweg und Umstieg${t.walk ? `, davon ca. ${mins(t.walk)} zu Fuß` : ""}${pl}.`
    : `In ${t.at} ${amount} zum Umsteigen${pl}.`;
}
const at = (s, ms) => `${hm(ms)}${s.platform ? `, Gleis ${s.platform}` : ""}`;

export function headline(v, trip, now = Date.now()) {
  const { legs, transfers, phase } = v, last = legs[legs.length - 1];
  const next = transfers.find(t => t.status !== "DONE");
  const arrive = v.finalDelay == null ? "" : `Ankunft ${last.arr.name} ca. ${hm(last.arr.rt)}${v.finalDelay >= 3 ? ` (+${v.finalDelay})` : ""}.`;
  if (v.missed != null) { const l = legs[v.missed]; return { title: `${l.label} verpasst`, sub: `Ab ${cleanName(l.dep.name)}. Deine Möglichkeiten stehen unter „So kommst du jetzt weiter“.` }; }
  if (phase === "done") return { title: "Angekommen", sub: `${last.arr.name} um ${hm(last.arr.rt)}.` };
  if (v.legCancel != null) { const l = legs[v.legCancel]; return { title: `${l.label} fällt aus`, sub: `Zwischen ${l.dep.name} und ${l.arr.name}. ${legs.length > 1 ? "Ich suche dir eine andere Verbindung." : "Die nächste Verbindung findest du über „Reise hinzufügen“ oder im DB Navigator."}` }; }
  if (next?.status === "LOST" && next.toMust) return { title: `Fester Zug ${next.toLabel} in Gefahr`, sub: next.reason === "cancel" ? `${next.toLabel} fällt aus.` : `${next.fromLabel} kommt in ${next.at} erst ${hm(next.arrRt)} an, ${next.toLabel} fährt ${hm(next.depRt)}.` };
  if (next?.status === "LOST" && now > next.depRt && next.reason !== "cancel") return { title: `Anschluss in ${next.at} verpasst`, sub: `${next.toLabel} ist schon weg. Deine Möglichkeiten stehen unter „So kommst du jetzt weiter“.` };
  if (next?.status === "LOST") return { title: "Anschluss nicht zu schaffen", sub: next.reason === "cancel" ? `${next.toLabel} in ${next.at} fällt aus.` : `${next.fromLabel} kommt in ${next.at} erst ${hm(next.arrRt)} an, ${next.toLabel} fährt ${hm(next.depRt)}.` };
  if (next?.status === "RISK") return { title: next.toMust ? `Fester Zug ${next.toLabel} gefährdet` : "Anschluss gefährdet", sub: `${xferText(next, next.gap >= 0 ? `nur ${mins(next.gap)}` : "keine Zeit")} Ich behalte das im Blick.` };
  if (next?.status === "WATCH") return { title: "Umstieg wird knapp", sub: `${xferText(next, `noch ${mins(next.gap)}`)} Ich behalte das im Blick.` };
  // Kein Umstiegsproblem – aber ehrlich sagen, wenn es am Ziel später wird
  const d = v.finalDelay ?? 0;
  const title = d >= 10 ? `Ca. ${d} Min. später am Ziel` : d >= 3 ? `Läuft – ca. ${d} Min. später` : d <= -3 ? `Läuft – ca. ${-d} Min. früher am Ziel` : "Alles läuft nach Plan";
  const late = d >= 3 || d <= -3 ? `Ankunft ${last.arr.name} ca. ${hm(last.arr.rt)} statt ${hm(v.bookedArr)}.` : "";
  if (phase === "before") { const f = legs[0].dep; return { title, sub: `Abfahrt ${f.name} ${at(f, f.rt)}${f.delay >= 3 ? ` (${f.delay} Min. später)` : ""}. ${next ? `Umstieg in ${next.at} mit ${mins(next.gap)} Zeit.` : ""} ${late}`.replace(/\s+/g, " ").trim() }; }
  if (next) return { title, sub: `${late} Dein Umstieg in ${next.at} klappt, ${mins(next.gap)} Zeit.`.trim() };
  return { title, sub: late || arrive || `Ziel ${last.arr.name}.` };
}

// ---------- Meldungen: Unterschied zwischen letztem bestätigtem Zustand und jetzt ----------
// state (gespeichert): { tr: [{ conf, pend, pn, sent }], legC: {i: true}, pl: {key: platform}, start: delay, rem: {i: true}, zb, alt: {i: [...]} }
export function diff(trip, v, prev = {}, now = Date.now()) {
  const st = { tr: [], legC: { ...(prev.legC || {}) }, pl: { ...(prev.pl || {}) }, start: prev.start ?? null, rem: { ...(prev.rem || {}) }, zb: !!prev.zb, alt: prev.alt || {} };
  const msgs = [], tag = k => `${trip.id}-${k}`;
  const ref = v.legs[v.legs.length - 1].arr.rt, spar = trip.ticket === "spar" && !v.zbLifted;
  // Zugbindung höchstens einmal erwähnen – zusammen mit dem Grund
  const zbNote = () => (trip.ticket === "spar" && v.zbLifted && !st.zb ? ((st.zb = true), " Deine Zugbindung ist damit voraussichtlich aufgehoben.") : "");
  const lostK = v.transfers.findIndex(t => t.status === "LOST");

  // Ausfall einer Teilstrecke – sofort
  v.legs.forEach(l => {
    if ((l.dep.cancelled || l.arr.cancelled) && !st.legC[l.i] && l.arr.rt > now - 5 * MIN) {
      st.legC[l.i] = true;
      const alt = altText(st.alt[l.i] || st.alt[l.i - 1], ref, spar, v.legs[Math.max(0, v.current)]?.label);
      const none = v.legs.length > 1 ? " Ich suche eine andere Verbindung – schau gleich in die App." : " Die nächste Verbindung findest du in der App unter „Reise hinzufügen“ oder im DB Navigator.";
      msgs.push({ title: `❌ ${l.label} fällt aus`, body: `${l.dep.name} → ${l.arr.name}.${alt || none}${zbNote()}`, tag: tag(`c${l.i}`), urgent: true });
    }
  });

  // Umstiege mit Hysterese: Verschlechterung/Verbesserung erst nach zwei gleichen Messungen (Ausfall sofort)
  v.transfers.forEach((t, k) => {
    const p = prev.tr?.[k] || { conf: "OK", pend: null, pn: 0, sent: null };
    let s = { ...p };
    if (t.status === "DONE") s = { ...p, conf: "DONE", pend: null, pn: 0 };
    else if (t.status === p.conf) s.pend = null, s.pn = 0;
    else if (t.reason === "cancel" || (t.status === p.pend && p.pn + 1 >= 2)) s.conf = t.status, s.pend = null, s.pn = 0;
    else s.pend = t.status, s.pn = t.status === p.pend ? p.pn + 1 : 1;
    if (s.conf !== p.conf && s.conf !== "DONE") {
      const alt = altText(st.alt[k], ref, spar, now < v.legs[0].dep.rt ? v.legs[0].label : v.legs[k].label);
      if ((s.conf === "RISK" || s.conf === "LOST") && s.sent !== s.conf && !(s.conf === "LOST" && t.reason === "cancel" && (st.legC[k] || st.legC[k + 1]))) {
        msgs.push(s.conf === "LOST"
          ? { title: t.toMust ? `❌ Fester Zug ${t.toLabel} nicht mehr erreichbar` : `❌ Anschluss in ${t.at} nicht zu schaffen`, body: `${t.reason === "cancel" ? `${t.toLabel} fällt aus.` : `${t.fromLabel} kommt erst ${hm(t.arrRt)} an, ${t.toLabel} fährt schon ${hm(t.depRt)}.`}${alt || " Ich suche eine andere Verbindung."}${zbNote()}`, tag: tag(`t${k}`), urgent: true }
          : { title: t.toMust ? `⚠️ Fester Zug ${t.toLabel} gefährdet` : `⚠️ Anschluss in ${t.at} gefährdet`, body: `${t.gap >= 0 ? `Nur noch ${mins(t.gap)} zum Umsteigen` : "Keine Zeit zum Umsteigen"}${t.arrPl && t.depPl ? ` (Gleis ${t.arrPl} → ${t.depPl})` : ""}.${alt || " Ich behalte das im Blick."}`, tag: tag(`t${k}`), urgent: true });
        s.sent = s.conf;
      } else if ((s.conf === "OK" || s.conf === "WATCH") && (p.sent === "RISK" || p.sent === "LOST")) {
        msgs.push({ title: `✅ Anschluss in ${t.at} klappt wieder`, body: `${mins(t.gap)} zum Umsteigen: weiter mit ${t.toLabel} um ${hm(t.depRt)}${t.depPl ? ` von ${platWord(t.toLeg, t.depPl)}` : ""}. Du musst nichts tun.`, tag: tag(`t${k}`) });
        s.sent = null;
      }
    }
    st.tr[k] = s;
  });

  // Gleiswechsel beim Einsteigen – erst, wenn die Abfahrt weniger als 90 Min. entfernt ist
  v.legs.forEach(l => {
    const d = l.dep, key = `d${l.i}`, known = st.pl[key] ?? d.platformPlan;
    if (!d.platform || d.cancelled || d.rt < now || d.rt - now > 90 * MIN) return;
    if (known && d.platform !== known && !isStreet(l)) msgs.push({ title: `🔀 Gleiswechsel: ${l.label}`, body: `In ${d.name} jetzt Gleis ${d.platform} (statt ${known}), Abfahrt ${hm(d.rt)}.`, tag: tag(key), urgent: true });
    st.pl[key] = d.platform;
  });

  // Verspätete Abfahrt vor Reisebeginn
  const f = v.legs[0].dep;
  if (v.phase === "before" && !f.cancelled && f.rt - now < 3 * 3600e3) {
    const d = f.delay, last = st.start ?? 0;
    if ((d >= 10 && Math.abs(d - last) >= 10) || (last >= 10 && d < 5)) {
      msgs.push(d >= 10
        ? { title: `🚆 ${v.legs[0].label} startet später`, body: `Abfahrt ${f.name} ca. ${hm(f.rt)} statt ${hm(f.plan)} (+${d})${f.platform ? `, Gleis ${f.platform}` : ""}.`, tag: tag("start") }
        : { title: `🚆 ${v.legs[0].label} wieder fast pünktlich`, body: `Abfahrt ${f.name} ca. ${hm(f.rt)}.`, tag: tag("start") });
      st.start = d;
    }
  }

  // Erinnerung kurz vor dem Aussteigen
  v.legs.forEach((l, i) => {
    const left = l.arr.rt - now;
    if (st.rem[i] || l.arr.cancelled || left > 6 * MIN || left < -2 * MIN || now < l.dep.rt) return;
    if (lostK >= 0 && i > lostK) return;                          // Teilstrecken nach einem verpassten Anschluss fährst du nicht
    st.rem[i] = true;
    const t = v.transfers[i];
    msgs.push(t?.status === "LOST"
      ? { title: `Gleich ${l.arr.name}`, body: `${t.reason === "cancel" ? `Dein Anschluss ${t.toLabel} fällt aus.` : `Dein Anschluss ${t.toLabel} ist nicht zu schaffen.`} In der App siehst du, wie du weiterkommst.`, tag: tag(`r${i}`) }
      : t
      ? { title: `Gleich ${l.arr.name} – umsteigen`, body: `Weiter mit ${t.toLabel}${t.depPl ? ` von ${platWord(t.toLeg, t.depPl)}` : ""} um ${hm(t.depRt)} – ${mins(Math.max(0, t.gap))} Zeit.`, tag: tag(`r${i}`) }
      : { title: `Gleich ${l.arr.name}`, body: `Ankunft ca. ${hm(l.arr.rt)}${l.arr.platform ? `, Gleis ${l.arr.platform}` : ""}. Bitte aussteigen.`, tag: tag(`r${i}`) });
  });

  // Zugbindung (nur Sparpreise), einmal
  if (v.zbLifted && !st.zb && lostK < 0 && v.legCancel == null) {
    st.zb = true;
    msgs.push({ title: "🎫 Zugbindung voraussichtlich aufgehoben", body: `Du kommst voraussichtlich ${v.finalDelay} Min. später an. Nach den DB-Regeln darfst du dann auch einen anderen Zug nehmen. Angaben ohne Gewähr.`, tag: tag("zb") });
  }
  return { state: st, msgs: msgs.map(m => ({ ...m, body: m.body.replace(/\.\./g, ".") })) };
}

// Kurzer Vorschlag für Meldungen: was tun, wann am Ziel, Unterschied zum Plan
export function altText(alts, refArr, spar = false, curLabel = "") {
  if (!alts?.length) return "";
  const a = alts.find(x => x.watch?.ok !== false) || alts[0], d = Number.isFinite(refArr) && a.arr ? Math.round((T(a.arr) - refArr) / MIN) : null;
  const delta = d == null ? "" : d <= -2 ? ` – ${d * -1} Min. früher` : d >= 2 ? ` – ${d} Min. später` : " – etwa gleich";
  // Sitzt man schon im vorgeschlagenen Zug (gleicher Zug, nur weiter), heißt es „sitzen bleiben“
  const same = curLabel && a.legs?.length === 1 && String(a.legs[0].label || a.label).replace(/\s/g, "") === String(curLabel).replace(/\s/g, "");
  const what = a.kind === "stay" || same ? `im ${a.label} sitzen bleiben bis ${a.toName || "zum Ziel"}` : a.reach ? `ab ${a.at} ${hm(T(a.dep))} mit ${a.label.split(" → ")[0]}, so erreichst du ${a.label.split(" → ").pop()}`
    : `ab ${a.at} ${hm(T(a.dep))}${a.depPl ? ` (Gleis ${a.depPl})` : ""} mit ${a.label}`;
  return ` Vorschlag: ${what}${a.arr && !a.reach ? `, Ziel ca. ${hm(T(a.arr))}${delta}` : ""}.${spar && a.zb !== false ? " Achtung Sparpreis: Das ist ein anderer Fernzug – er gilt erst, wenn die Zugbindung aufgehoben ist." : ""}`;
}
