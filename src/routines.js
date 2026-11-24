// Regelmäßige Fahrten (z. B. „Arbeit hin“ Mo–Fr 07:40): jeden Fahrtag ca. 3 Std. vorher eine Reise anlegen und überwachen.
// Fahrplanwechsel: Es wird jeden Tag neu gesucht – gleiche Linien zur gleichen Zeit, sonst die nächstpassende Verbindung (mit Hinweis).
import * as db from "./db.js";
import { connections, resolveConnection } from "./routing.js";
import { hm } from "./engine.js";

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
    const date = addDays(today, i), at = wallToMs(date, r.dep);
    if (at < now - 5 * MIN) continue;
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

// Fällige Reisen anlegen (vom Cron jede Minute aufgerufen). Gibt Meldungen je Konto zurück.
export async function makeDue(env, now = Date.now()) {
  const list = await db.activeRoutines(env).catch(() => []), msgs = [];
  for (const r of list) {
    for (const date of [berlinDate(now), berlinDate(now + DAY)]) {
      if ((r.made || []).includes(date) || offReason(r, date)) continue;
      const at = wallToMs(date, r.dep);
      if (now < at - LEAD || now > at + 5 * MIN) continue;
      r.made = [...(r.made || []), date].slice(-14);
      await db.update(env, "rb_routines", r.id, { made: r.made });   // zuerst merken: nie doppelt anlegen
      const hit = await findForDay(env, r, date).catch(e => { console.log("Regelmäßig:", e.message); return null; });
      if (!hit) { msgs.push({ acc: r.account_id, title: `↻ ${r.name}: keine Verbindung gefunden`, body: `Für heute ${r.dep} habe ich keine passende Verbindung gefunden. Bitte selbst prüfen.`, tag: `r-${r.id}` }); continue; }
      const legs = (await resolveConnection(env, hit.c.legs)).map(({ live, ...l }) => ({ ...l, minT: r.min_t || 0 }));
      const dep = Date.parse(legs[0].from.plan), label = legs.map(l => l.label).join(" → ");
      const note = hit.changed ? `Heute andere Verbindung: ${label}, ab ${hm(dep)} (sonst ${r.dep}).` : null;
      const trip = await db.insert(env, "rb_trips", { account_id: r.account_id, device_id: null, ticket: r.ticket, legs, obs: [], active: true,
        state: { routine: r.id, rname: r.name, ...(note ? { rnote: note } : {}) }, ends_at: legs[legs.length - 1].to.plan });
      if (note) msgs.push({ acc: r.account_id, title: `↻ ${r.name}: Fahrplan geändert`, body: `${note} Ich überwache diese.`, tag: `r-${r.id}`, url: `/?trip=${encodeURIComponent(trip.id)}` });
    }
  }
  return msgs;
}

// Anzeige in der App
export function routineView(r, now = Date.now()) {
  const n = nextRun(r, now), today = berlinDate(now);
  return { id: r.id, name: r.name, days: r.days, dep: r.dep, holidays: r.holidays !== false, paused: !!r.paused, ticket: r.ticket,
    from: r.tpl[0].from.name, to: r.tpl[r.tpl.length - 1].to.name, label: r.tpl.map(l => l.label).join(" → "),
    next: n, today, todayOff: offReason({ ...r, paused: false }, today), skip: (r.skip || []).filter(d => d >= today) };
}
