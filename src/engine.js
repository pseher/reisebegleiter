// Entscheidungslogik – reine Funktionen, ohne Netz. Wird vom Worker (Überwachung, Anzeige) und von den Tests genutzt.

export const SEV = { DONE: 0, OK: 1, WATCH: 2, RISK: 3, LOST: 4 };
const MIN = 60e3;

// Große Knoten: längere Umstiegszeit (Faustregel, bis offizielle Werte vorliegen)
export const HUBS = new Set(["8011160", "8098160", "8002549", "8000105", "8000207", "8000261", "8000152", "8010205", "8000096",
  "8000284", "8000085", "8000244", "8010101", "8000080", "8000098", "8000191", "8000050", "8000128", "8010159", "8000013"]);

export const hm = ms => new Date(ms).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const T = x => (x ? Date.parse(x) : NaN);
const cleanName = n => String(n || "").replace(/\s*\(tief\)$/i, "");

// Umstiegszeit in Minuten
export function transferMinutes(arrEva, arrPl, depEva, depPl) {
  if (arrEva !== depEva) return HUBS.has(arrEva) ? 10 : 8;        // anderer Bahnhofsteil, z. B. Berlin Hbf oben ↔ tief
  if (arrPl && depPl && arrPl === depPl) return 3;                  // gleiches Gleis
  return HUBS.has(arrEva) ? 8 : 5;
}

// Zusätzlicher Puffer: Verspätungen wachsen eher, als dass sie schrumpfen
export const growthBuffer = minutesUntilArrival => (minutesUntilArrival <= 0 ? 0 : Math.min(10, Math.floor(minutesUntilArrival / 20)));

// Halt (Abfahrt oder Ankunft) einer Teilstrecke mit Echtzeit zusammenführen
function stop(leg, o, side) {
  const s = leg[side], ob = o?.[side === "from" ? "dep" : "arr"] || {};
  const plan = T(s.plan), rt = Number.isFinite(T(ob.rt)) ? T(ob.rt) : plan;
  return { eva: s.eva, name: cleanName(s.name), plan, rt, delay: Math.round((rt - plan) / MIN), platformPlan: s.platform || "",
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
    return { i, label: l.label, jid: l.jid, mode: l.mode || "", live: !!l.jid, dep, arr: carryDelay(dep, stop(l, trip.obs?.[i], "to")) };
  });
  const n = legs.length, first = legs[0], last = legs[n - 1];
  const transfers = [];
  for (let i = 0; i < n - 1; i++) {
    const a = legs[i].arr, d = legs[i + 1].dep;
    const walk = trip.legs[i].walk || 0;                     // Gehzeit aus der Verbindungssuche, falls bekannt
    const gap = Math.round((d.rt - a.rt) / MIN), need = walk ? Math.max(walk + 1, 3) : transferMinutes(a.eva, a.platform, d.eva, d.platform);
    const until = Math.max(0, Math.round((a.rt - now) / MIN)), growth = growthBuffer(until), spare = gap - need;
    let status, reason = "";
    if (d.rt < now - MIN && !d.cancelled && !legs[i].arr.cancelled) status = "DONE";
    else if (a.cancelled || d.cancelled || legs[i].dep.cancelled) { status = "LOST"; reason = "cancel"; }
    else if (gap < 0 && until <= 45) { status = "LOST"; reason = "late"; }
    else if (spare < growth) status = "RISK";
    else if (spare < growth + 4) status = "WATCH";
    else status = "OK";
    transfers.push({ i, at: a.name, eva: a.eva, gap, need, spare, growth, until, status, reason,
      fromLabel: legs[i].label, toLabel: legs[i + 1].label, arrPl: a.platform, depPl: d.platform, depRt: d.rt, arrRt: a.rt });
  }
  const phase = now < first.dep.rt ? "before" : now > last.arr.rt + 2 * MIN ? "done" : "enroute";
  const current = legs.findIndex(l => now < l.arr.rt + MIN);
  const openTransfers = transfers.filter(t => t.status !== "DONE");
  const legCancel = legs.find(l => (l.dep.cancelled || l.arr.cancelled) && l.arr.rt > now - MIN);
  let status = openTransfers.reduce((s, t) => (SEV[t.status] > SEV[s] ? t.status : s), phase === "done" ? "DONE" : "OK");
  if (legCancel && phase !== "done") status = "LOST";
  const lostTransfer = openTransfers.find(t => t.status === "LOST");
  const finalDelay = lostTransfer || legCancel ? null : last.arr.delay;
  const zbLifted = trip.ticket === "spar" && (!!lostTransfer || !!legCancel || (finalDelay ?? 0) >= 20);
  const v = { status, phase, legs, transfers, current, finalDelay, zbLifted, legCancel: legCancel ? legCancel.i : null };
  Object.assign(v, headline(v, trip, now));
  return v;
}

const mins = m => (m === 1 ? "1 Min." : `${m} Min.`);
const at = (s, ms) => `${hm(ms)}${s.platform ? `, Gleis ${s.platform}` : ""}`;

export function headline(v, trip, now = Date.now()) {
  const { legs, transfers, phase } = v, last = legs[legs.length - 1];
  const next = transfers.find(t => t.status !== "DONE");
  const arrive = v.finalDelay == null ? "" : `Ankunft ${last.arr.name} ca. ${hm(last.arr.rt)}${v.finalDelay >= 3 ? ` (+${v.finalDelay})` : ""}.`;
  if (phase === "done") return { title: "Angekommen", sub: `${last.arr.name} um ${hm(last.arr.rt)}.` };
  if (v.legCancel != null) { const l = legs[v.legCancel]; return { title: `${l.label} fällt aus`, sub: `Zwischen ${l.dep.name} und ${l.arr.name}. Prüfe im DB Navigator die nächste Verbindung.` }; }
  if (next?.status === "LOST") return { title: "Anschluss nicht zu schaffen", sub: next.reason === "cancel" ? `${next.toLabel} in ${next.at} fällt aus.` : `${next.fromLabel} kommt in ${next.at} erst ${hm(next.arrRt)} an, ${next.toLabel} fährt ${hm(next.depRt)}.` };
  if (next?.status === "RISK") return { title: "Anschluss gefährdet", sub: `${next.at}: ${next.gap >= 0 ? `nur ${mins(next.gap)} zum Umsteigen` : "Ankunft nach der Abfahrt"} (${next.arrPl || "?"} → ${next.depPl || "?"}). Ich behalte das im Blick.` };
  if (next?.status === "WATCH") return { title: "Umstieg wird knapp", sub: `${next.at}: noch ${mins(next.gap)} Zeit, Gleis ${next.arrPl || "?"} → ${next.depPl || "?"}. Ich behalte das im Blick.` };
  if (phase === "before") { const f = legs[0].dep; return { title: "Alles läuft nach Plan", sub: `Abfahrt ${f.name} ${at(f, f.rt)}${f.delay >= 3 ? ` (+${f.delay})` : ""}. ${next ? `Umstieg in ${next.at} mit ${mins(next.gap)} Zeit.` : arrive}`.trim() }; }
  if (next) return { title: "Alles läuft nach Plan", sub: `Dein Umstieg in ${next.at} klappt, ${mins(next.gap)} Zeit.` };
  return { title: "Alles läuft nach Plan", sub: arrive || `Ziel ${last.arr.name}.` };
}

// ---------- Meldungen: Unterschied zwischen letztem bestätigtem Zustand und jetzt ----------
// state (gespeichert): { tr: [{ conf, pend, pn, sent }], legC: {i: true}, pl: {key: platform}, start: delay, rem: {i: true}, zb, alt: {i: [...]} }
export function diff(trip, v, prev = {}, now = Date.now()) {
  const st = { tr: [], legC: { ...(prev.legC || {}) }, pl: { ...(prev.pl || {}) }, start: prev.start ?? null, rem: { ...(prev.rem || {}) }, zb: !!prev.zb, alt: prev.alt || {} };
  const msgs = [], tag = k => `${trip.id}-${k}`;

  // Ausfall einer Teilstrecke – sofort
  v.legs.forEach(l => {
    if ((l.dep.cancelled || l.arr.cancelled) && !st.legC[l.i] && l.arr.rt > now - 5 * MIN) {
      st.legC[l.i] = true;
      msgs.push({ title: `❌ ${l.label} fällt aus`, body: `${l.dep.name} → ${l.arr.name}. Prüfe die nächste Verbindung.${trip.ticket === "spar" ? " Die Zugbindung ist damit voraussichtlich aufgehoben." : ""}`, tag: tag(`c${l.i}`), urgent: true });
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
      const alt = altText(st.alt[k]);
      if ((s.conf === "RISK" || s.conf === "LOST") && s.sent !== s.conf && !(s.conf === "LOST" && t.reason === "cancel" && (st.legC[k] || st.legC[k + 1]))) {
        msgs.push(s.conf === "LOST"
          ? { title: `❌ Anschluss in ${t.at} nicht zu schaffen`, body: `${t.toLabel} ${t.reason === "cancel" ? "fällt aus" : `fährt ${hm(t.depRt)}, ${t.fromLabel} kommt erst ${hm(t.arrRt)} an`}.${alt}${trip.ticket === "spar" ? " Zugbindung voraussichtlich aufgehoben." : ""}`, tag: tag(`t${k}`), urgent: true }
          : { title: `⚠️ Anschluss in ${t.at} gefährdet`, body: `${t.fromLabel} an ca. ${hm(t.arrRt)}${t.arrPl ? ` (Gl. ${t.arrPl})` : ""}, ${t.toLabel} ab ${hm(t.depRt)}${t.depPl ? ` (Gl. ${t.depPl})` : ""}: ${t.gap >= 0 ? `nur ${mins(t.gap)}` : "keine Zeit"}.${alt}`, tag: tag(`t${k}`), urgent: true });
        s.sent = s.conf;
      } else if ((s.conf === "OK" || s.conf === "WATCH") && (p.sent === "RISK" || p.sent === "LOST")) {
        msgs.push({ title: `✅ Anschluss in ${t.at} klappt wieder`, body: `${t.fromLabel} an ca. ${hm(t.arrRt)}, ${t.toLabel} ab ${hm(t.depRt)}${t.depPl ? ` (Gl. ${t.depPl})` : ""}: ${mins(t.gap)} zum Umsteigen.`, tag: tag(`t${k}`) });
        s.sent = null;
      }
    }
    st.tr[k] = s;
  });

  // Gleiswechsel beim Einsteigen – erst, wenn die Abfahrt weniger als 90 Min. entfernt ist
  v.legs.forEach(l => {
    const d = l.dep, key = `d${l.i}`, known = st.pl[key] ?? d.platformPlan;
    if (!d.platform || d.cancelled || d.rt < now || d.rt - now > 90 * MIN) return;
    if (known && d.platform !== known) msgs.push({ title: `🔀 Gleiswechsel: ${l.label}`, body: `In ${d.name} jetzt Gleis ${d.platform} (statt ${known}), Abfahrt ${hm(d.rt)}.`, tag: tag(key), urgent: true });
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
    st.rem[i] = true;
    const t = v.transfers[i];
    msgs.push(t
      ? { title: `Gleich ${l.arr.name} – umsteigen`, body: `Weiter mit ${t.toLabel}${t.depPl ? ` von Gleis ${t.depPl}` : ""} um ${hm(t.depRt)} (${mins(Math.max(0, t.gap))} Zeit).`, tag: tag(`r${i}`) }
      : { title: `Gleich ${l.arr.name}`, body: `Ankunft ca. ${hm(l.arr.rt)}${l.arr.platform ? `, Gleis ${l.arr.platform}` : ""}. Bitte aussteigen.`, tag: tag(`r${i}`) });
  });

  // Zugbindung (nur Sparpreise), einmal
  if (v.zbLifted && !st.zb) {
    st.zb = true;
    if (!msgs.some(m => /Zugbindung/.test(m.body)))
      msgs.push({ title: "🎫 Zugbindung voraussichtlich aufgehoben", body: `Erwartet: mind. 20 Min. Verspätung am Ziel oder ein verpasster Anschluss. Nach den DB-Regeln darfst du dann einen anderen Zug nehmen. Angaben ohne Gewähr.`, tag: tag("zb") });
  }
  return { state: st, msgs };
}

export function altText(alts) {
  if (!alts?.length) return "";
  const a = alts[0];
  return ` Plan B: ${a.label} ab ${hm(T(a.dep))}${a.depPl ? ` (Gl. ${a.depPl})` : ""}${a.arr ? `, an ${a.toName} ${hm(T(a.arr))}` : ""}.`;
}
