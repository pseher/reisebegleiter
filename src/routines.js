// Regelmäßige Fahrten (z. B. „Arbeit hin“ Mo–Fr 07:40): jeden Fahrtag ca. 3 Std. vorher eine Reise anlegen und überwachen.
// Fahrplanwechsel: Es wird jeden Tag neu gesucht – gleiche Linien zur gleichen Zeit, sonst die nächstpassende Verbindung (mit Hinweis).
import * as db from "./db.js";
import { connections, resolveConnection } from "./routing.js";
import { hm, changesFV } from "./engine.js";

const MIN = 60e3, DAY = 864e5;
export const LEAD = 3 * 3600e3;   // so lange vor der Abfahrt wird die Reise angelegt
const TZ = "Europe/Berlin";

// „2026-11-24“ in Berliner Zeit
export const berlinDate = ms => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(new Date(ms));
export const wallTime = ms => new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
const offset = ms => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000; };
// Ortszeit Berlin „2026-11-24“ + „07:40“ → Zeitpunkt
export function wallToMs(date, hhmm) {
  const [y, m, d] = date.split("-").map(Number), [h, mi] = hhmm.split(":").map(Number), guess = Date.UTC(y, m - 1, d, h, mi);
  let ms = guess - offset(guess); ms = guess - offset(ms); return ms;
}
const addDays = (date, n) => { const [y, m, d] = date.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
export const isoDow = date => { const [y, m, d] = date.split("-").map(Number); return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1; };

// Gesetzliche Feiertage in Berlin
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return new Date(Date.UTC(y, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1)).toISOString().slice(0, 10);
}
const HOL = new Map();
export function holidayName(date) {
  const y = +date.slice(0, 4);
  if (!HOL.has(y)) {
    const e = easter(y);
    HOL.set(y, new Map([[`${y}-01-01`, "Neujahr"], [`${y}-03-08`, "Frauentag"], [addDays(e, -2), "Karfreitag"], [addDays(e, 1), "Ostermontag"], [`${y}-05-01`, "Tag der Arbeit"],
      [addDays(e, 39), "Christi Himmelfahrt"], [addDays(e, 50), "Pfingstmontag"], [`${y}-10-03`, "Tag der Deutschen Einheit"], [`${y}-12-25`, "1. Weihnachtstag"], [`${y}-12-26`, "2. Weihnachtstag"]]));
  }
  return HOL.get(y).get(date) || null;
}

// Fährt die Strecke an diesem Tag? (null = ja, sonst der Grund)
export function offReason(r, date) {
  if (r.paused) return "pausiert";
  if (!(r.days || []).includes(isoDow(date))) return "kein Fahrtag";
  if ((r.skip || []).includes(date)) return "ausgesetzt";
  if (r.holidays !== false) { const h = holidayName(date); if (h) return h; }
  return null;
}
// Nächste Fahrt (ab heute, solange die Abfahrt nicht vorbei ist) – für die Anzeige
export function nextRun(r, now = Date.now()) {
  const today = berlinDate(now);
  for (let i = 0; i < 21; i++) {
    const date = addDays(today, i), at = wallToMs(date, r.dep), end = r.win_to ? wallToMs(date, r.win_to) : at;
    if (end < now - 5 * MIN) continue;   // Zeitfenster: läuft es heute noch, zählt es heute
    if (!offReason(r, date)) return { date, at: new Date(at).toISOString() };
  }
  return null;
}

// Linien vergleichbar machen: „Bus M29“ = „M29“, „S 42“ = „S42“
const lineKey = l => String(l.label || "").replace(/^(Bus|Tram|STR|Fähre)\s+/i, "").replace(/\s/g, "").toUpperCase();
const sig = legs => legs.map(lineKey).join("|");

// Passende Verbindung für diesen Tag suchen: gleiche Linien zur gleichen Zeit, sonst die nächstgelegene
export async function findForDay(env, r, date) {
  const at = wallToMs(date, r.dep), tpl = r.tpl, from = tpl[0].from, to = tpl[tpl.length - 1].to;
  const list = await connections(env, from, to, at - 10 * MIN, r.min_t || 0);
  const want = sig(tpl);
  const same = list.find(c => sig(c.legs) === want && Math.abs(Date.parse(c.legs[0].from.plan) - at) <= 3 * MIN);
  if (same) return { c: same, changed: false };
  const near = list.filter(c => Date.parse(c.legs[0].from.plan) >= at - 15 * MIN).sort((a, b) => Math.abs(Date.parse(a.legs[0].from.plan) - at) - Math.abs(Date.parse(b.legs[0].from.plan) - at))[0];
  return near ? { c: near, changed: true } : null;
}

// ---------- Zeitfenster („zwischen 07:00 und 08:00“): alle Fahrten im Fenster beobachten, du wählst, welche du nimmst ----------
const asOption = (c, toName) => ({ kind: "window", from: "start", label: c.legs.map(l => l.label).join(" → "), transfers: c.transfers, walkStart: c.walkStart || 0,
  dep: c.legs[0].from.rt || c.legs[0].from.plan, depPlan: c.legs[0].from.plan, depPl: c.legs[0].from.track || "", firstStop: c.legs[0].from.name,
  arr: c.legs[c.legs.length - 1].to.rt || c.legs[c.legs.length - 1].to.plan, arrPlan: c.legs[c.legs.length - 1].to.plan, toName, legs: c.legs });
// Fahrten im Fenster ab „ab“ (Abfahrt zwischen Fensterbeginn und -ende)
export async function windowConns(env, r, date, fromMs) {
  const a = wallToMs(date, r.win_from || r.dep), b = wallToMs(date, r.win_to), start = Math.max(a, fromMs || a), tpl = r.tpl;
  const seen = new Set(), out = [];
  for (let t = start - 2 * MIN, k = 0; t <= b && k < 3; k++) {   // Fenster ggf. in mehreren Suchen abdecken
    const list = await connections(env, tpl[0].from, tpl[tpl.length - 1].to, t, r.min_t || 0).catch(() => []);
    for (const c of list) { const d = Date.parse(c.legs[0].from.plan), key = c.legs.map(l => `${l.label}@${l.from.plan}`).join("|");
      if (d >= start - MIN && d <= b && !seen.has(key)) { seen.add(key); out.push(c); } }
    const last = list.length ? Date.parse(list[list.length - 1].legs[0].from.plan) : b;
    if (!list.length || last >= b) break;
    t = last + MIN;
  }
  // je Abfahrtszeit nur die schnellste Verbindung, höchstens 6
  return out.sort((x, y) => Date.parse(x.legs[0].from.plan) - Date.parse(y.legs[0].from.plan) || Date.parse(x.arr) - Date.parse(y.arr))
    .filter((c, i, arr) => i === 0 || c.legs[0].from.plan !== arr[i - 1].legs[0].from.plan).slice(0, 6);
}
const toLegs = async (env, c, minT) => (await resolveConnection(env, c.legs)).map(({ live, ...l }) => ({ ...l, minT: minT || 0 }));
// Reise im Fenster aktuell halten: verpasste Abfahrt → nächste Fahrt im Fenster, Liste der übrigen erneuern (alle 5 Min.)
export async function refreshWindow(env, t, now, watch) {
  const w = t.state?.win; if (!w || w.picked) return false;
  const dep0 = Date.parse(t.legs[0].from.plan), stale = !w.at || now - w.at > 5 * MIN, gone = now > dep0 + MIN;
  if (!stale && !gone) return false;
  const r = { tpl: [{ from: w.from0 || t.legs[0].from, to: w.to0 || t.legs[t.legs.length - 1].to }], win_from: w.from, win_to: w.to, min_t: +t.legs[0].minT || 0 };
  const list = await windowConns(env, r, w.date, now - MIN);
  if (gone) {
    const next = list.find(c => Date.parse(c.legs[0].from.plan) > now);
    if (!next) { t.active = false; t.state = { ...t.state, win: { ...w, at: now, list: [] } }; return true; }   // Fenster vorbei, keine Wahl getroffen
    // die abgefahrene merken: sitzt du doch drin, kannst du mit einem Tipp zu ihr zurück
    const prev = { legs: t.legs, dep: t.legs[0].from.plan, arr: t.legs[t.legs.length - 1].to.plan, label: t.legs.map(l => l.label).join(" → ") };
    t.legs = await toLegs(env, next, +t.legs[0].minT); t.obs = []; t._legsDirty = true; t.ends_at = t.legs[t.legs.length - 1].to.plan;
    t.state = { ...t.state, tr: [], alt: {}, altAt: {}, rem: {}, legC: {}, pl: {}, win: { ...t.state.win, prev } };
  }
  const cur = t.legs.map(l => `${l.label}@${Date.parse(l.from.plan)}`).join("|"), toName = t.legs[t.legs.length - 1].to.name;
  const opts = list.filter(c => c.legs.map(l => `${l.label}@${Date.parse(l.from.plan)}`).join("|") !== cur && Date.parse(c.legs[0].from.plan) > now).slice(0, 5).map(c => asOption(c, toName));
  if (watch) await watch(opts).catch(() => {});
  for (const o of opts) o.zb = changesFV(t.legs, o.legs);
  t.state = { ...t.state, win: { ...w, prev: t.state.win?.prev ?? w.prev, at: now, list: opts } };
  return true;
}

// Fällige Reisen anlegen (vom Cron jede Minute aufgerufen). Gibt Meldungen je Konto zurück.
// gleiche Strecke? („S Halensee (Berlin)“ = „Halensee“)
const plain = n => String(n || "").replace(/\s*\([^)]*\)\s*$/, "").replace(/^(S\+U|S|U)\s+/i, "").replace(/[^a-zäöüß0-9]/gi, "").toLowerCase();
export async function makeDue(env, now = Date.now(), watch = null) {
  const list = await db.activeRoutines(env).catch(() => []), msgs = [], tripsCache = new Map();
  for (const r of list) {
    for (const date of [berlinDate(now), berlinDate(now + DAY)]) {
      if (offReason(r, date)) continue;
      const at = wallToMs(date, r.dep);
      const until = r.win_to ? wallToMs(date, r.win_to) : at + 5 * MIN;   // ein angefangenes Zeitfenster wird trotzdem noch angelegt
      if (now < at - LEAD || now > until) continue;
      if (!tripsCache.has(r.account_id)) tripsCache.set(r.account_id, await db.tripsOf(env, r.account_id).catch(() => []));
      // Schon angelegt? Normalerweise ja – fehlt die Fahrt aber (z. B. Fehler beim Anlegen), einmal neu anlegen
      const made = r.made || [], hasTrip = tripsCache.get(r.account_id).some(t => t.state?.routine === r.id && berlinDate(Date.parse(t.legs?.[0]?.from?.plan)) === date);
      if (made.includes(date) && (hasTrip || made.includes(`${date}!`))) continue;
      r.made = [...made.filter(d => d !== date), made.includes(date) ? `${date}!` : date].slice(-14);
      if (made.includes(date)) r.made.push(date);
      await db.update(env, "rb_routines", r.id, { made: r.made });   // zuerst merken: nie doppelt anlegen
      // Hast du für diese Strecke an dem Tag schon selbst eine Reise angelegt? Dann diese nehmen statt einer zweiten
      const end = r.win_to ? wallToMs(date, r.win_to) : at + 60 * MIN, start = r.win_to ? at : at - 60 * MIN;
      const mine = tripsCache.get(r.account_id), keep = t => (mine.push(t), t);
      const own = mine.find(t => t.legs?.length && (!t.state?.routine || t.state.routine === r.id) && plain(t.legs[0].from.name) === plain(r.tpl[0].from.name) && plain(t.legs[t.legs.length - 1].to.name) === plain(r.tpl[r.tpl.length - 1].to.name)
        && Date.parse(t.legs[0].from.plan) >= start - 5 * MIN && Date.parse(t.legs[0].from.plan) <= end + 5 * MIN);
      if (own) { if (!own.state?.routine) await db.update(env, "rb_trips", own.id, { state: { ...(own.state || {}), routine: r.id, rname: r.name } }); continue; }
      if (r.win_to) {   // Zeitfenster: erste Fahrt im Fenster überwachen, die übrigen zur Auswahl
        const list = await windowConns(env, r, date, now - MIN).catch(e => { console.log("Zeitfenster:", e.message); return []; });
        if (!list.length) { msgs.push({ acc: r.account_id, title: `↻ ${r.name}: keine Verbindung`, body: `Zwischen ${r.win_from} und ${r.win_to} habe ich keine Verbindung gefunden. Bitte selbst prüfen.`, tag: `r-${r.id}` }); continue; }
        const legs = await toLegs(env, list[0], r.min_t), toName = legs[legs.length - 1].to.name, opts = list.slice(1, 6).map(c => asOption(c, toName));
        if (watch) await watch(opts, r.min_t).catch(() => {});
        keep(await db.insert(env, "rb_trips", { account_id: r.account_id, device_id: null, ticket: r.ticket, legs, obs: [], active: true, ends_at: legs[legs.length - 1].to.plan,
          state: { routine: r.id, rname: r.name, win: { from: r.win_from, to: r.win_to, date, picked: false, at: now, from0: r.tpl[0].from, to0: r.tpl[r.tpl.length - 1].to,
            list: opts } } }));
        continue;
      }
      const hit = await findForDay(env, r, date).catch(e => { console.log("Regelmäßig:", e.message); return null; });
      if (!hit) { msgs.push({ acc: r.account_id, title: `↻ ${r.name}: keine Verbindung gefunden`, body: `Für heute ${r.dep} habe ich keine passende Verbindung gefunden. Bitte selbst prüfen.`, tag: `r-${r.id}` }); continue; }
      const legs = (await resolveConnection(env, hit.c.legs)).map(({ live, ...l }) => ({ ...l, minT: r.min_t || 0 }));
      const dep = Date.parse(legs[0].from.plan), label = legs.map(l => l.label).join(" → ");
      const note = hit.changed ? `Heute andere Verbindung: ${label}, ab ${hm(dep)} (sonst ${r.dep}).` : null;
      const trip = keep(await db.insert(env, "rb_trips", { account_id: r.account_id, device_id: null, ticket: r.ticket, legs, obs: [], active: true,
        state: { routine: r.id, rname: r.name, ...(note ? { rnote: note } : {}) }, ends_at: legs[legs.length - 1].to.plan }));
      if (note) msgs.push({ acc: r.account_id, title: `↻ ${r.name}: Fahrplan geändert`, body: `${note} Ich überwache diese.`, tag: `r-${r.id}`, url: `/?trip=${encodeURIComponent(trip.id)}` });
    }
  }
  return msgs;
}

// Anzeige in der App
export function routineView(r, now = Date.now()) {
  const n = nextRun(r, now), today = berlinDate(now);
  return { id: r.id, name: r.name, days: r.days, dep: r.dep, win: r.win_to ? [r.win_from, r.win_to] : null, holidays: r.holidays !== false, paused: !!r.paused, ticket: r.ticket,
    from: r.tpl[0].from.name, to: r.tpl[r.tpl.length - 1].to.name, label: r.win_to ? `alle Fahrten zwischen ${r.win_from} und ${r.win_to}` : r.tpl.map(l => l.label).join(" → "),
    next: n, today, todayOff: offReason({ ...r, paused: false }, today), skip: (r.skip || []).filter(d => d >= today) };
}
