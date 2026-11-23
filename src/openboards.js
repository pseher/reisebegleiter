// DB OpenBoards – Abfahrts- und Ankunftstafeln (nur Eisenbahn, inkl. S-Bahn und Ersatzverkehr)
// Free-Plan: 10 Anfragen/Sek. Eine Anfrage liefert ein 30-Minuten-Fenster ab timeStart.
// Standardmäßig erweitert die API auf den ganzen Umsteigebereich (z. B. Berlin Hbf oben/tief/S-Bahn).
import { mockBoard } from "./mock.js";

const OB = "https://apis.deutschebahn.com/db-api-marketplace/apis/open-boards/v1";
export const WINDOW_MIN = 30;
const FV = new Set(["ICE", "IC", "EC", "ECE", "ICD", "RJ", "RJX", "NJ", "EN", "FLX", "TGV", "EST", "IR", "D", "WB"]);

export class BoardError extends Error {}

// Drosselung: höchstens etwa 6 Anfragen pro Sekunde je Worker-Instanz (Limit der DB: 10/Sek. je Anwendung, geteilt mit PlanFlink)
let nextSlot = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function slot() { const now = Date.now(), t = Math.max(now, nextSlot); nextSlot = t + 170; if (t > now) await sleep(t - now); }

async function post(env, kind, body) {
  if (env.MOCK === "1") return mockBoard(kind, body);
  if (!env.DB_CLIENT_ID || !env.DB_API_KEY) throw new BoardError("DB-Schlüssel fehlen");
  for (let attempt = 0; ; attempt++) {
    await slot();
    const r = await fetch(`${OB}/${kind === "arr" ? "arrivals" : "departures"}`, {
      method: "POST", body: JSON.stringify(body),
      headers: { "DB-Client-Id": env.DB_CLIENT_ID, "DB-Api-Key": env.DB_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
    }).catch(e => { throw new BoardError(`Netzwerk: ${e.message}`); });
    if (r.status === 429 && attempt < 3) { await sleep(1000 * (attempt + 1)); continue; }   // zu viele Anfragen: kurz warten, erneut
    if (r.status === 429) throw new BoardError("Die DB-Schnittstelle ist gerade ausgelastet. Bitte in einer Minute noch einmal versuchen.");
    if (!r.ok) throw new BoardError(`OpenBoards HTTP ${r.status}`);
    return r.json();
  }
}

// Rohabfrage (für die Fehlersuche)
export const rawBoard = (env, kind, eva, timeStart, maxVia = 3) =>
  post(env, kind, { stopPlaceOrStation: { evaNumbers: [String(eva)] }, timeWindow: { timeStart }, maxViaStops: maxVia, maxEntriesPerTransportType: 50, languages: ["deu"] });

const nameOf = p => { const n = p?.localizedNames || []; return (n.find(x => x.language === "deu") || n[0])?.name || ""; };

export function trainLabel(t = {}) {
  const cat = t.category || "", num = t.journeyNumber ?? t.operationalJourneyNumber ?? "", line = t.line?.name || "";
  if (t.replacementTransport) return `${line || cat} (Ersatzverkehr)`.trim();
  if (FV.has(cat)) return `${cat} ${num}`.trim();
  if (line && !/^\d+$/.test(line)) return /^\D+\d/.test(line) && !/\s/.test(line) ? line.replace(/^(\D+)(\d.*)$/, "$1 $2") : line;
  return `${cat} ${line || num}`.trim();
}

// Meldungstexte zu einem Eintrag (ohne reine Ausstattungsmerkmale wie Fahrradmitnahme)
function messageTexts(data, ids) {
  const out = [];
  for (const [group, list] of Object.entries(data.messages || {})) {
    if (group === "attributes" || !Array.isArray(list)) continue;
    for (const m of list) {
      if (ids && Array.isArray(ids) && m.messageID != null && !ids.includes(m.messageID)) continue;
      const d = m.descriptions || m.texts || [];
      const txt = (d.find?.(x => x.language === "deu") || d[0])?.text || m.text;
      if (txt && !out.includes(txt)) out.push(txt);
    }
  }
  return out;
}

const isCancelled = e => [e.canceled, e.cancelled, e.isCanceled, e.isCancelled].some(v => v === true)
  || ["CANCELED", "CANCELLED"].includes(e.timeType) || ["CANCELED", "CANCELLED"].includes(e.status);

// Antwort → einheitliche Einträge
export function normalize(data, kind) {
  const names = {};
  for (const p of data.stopPlaces || []) if (p.evaNumber) names[String(p.evaNumber)] = nameOf(p);
  const list = data[kind === "arr" ? "arrivals" : "departures"] || data.departures || data.arrivals || [];
  return list.map(e => {
    const t = e.transport || e.journeyInfo?.transportAtStart || {};
    const plan = e.timeSchedule || e.time, rt = e.time || e.timeSchedule;
    return {
      jid: e.journeyId || "", eva: String(e.evaNumber || ""), name: names[String(e.evaNumber)] || "",
      plan, rt, realtime: e.timeType ? e.timeType !== "SCHEDULE" : false,
      platformPlan: e.platformSchedule?.name || "", platform: e.platform?.name || e.platformSchedule?.name || "",
      cancelled: isCancelled(e),
      label: trainLabel(t), cat: t.category || "", num: t.journeyNumber ?? null, line: t.line?.name || "",
      replacement: !!t.replacementTransport,
      direction: (t.direction?.stopPlaces || []).map(p => ({ eva: String(p.evaNumber), name: names[String(p.evaNumber)] || "" })),
      origin: e.journeyInfo?.origin?.evaNumber ? String(e.journeyInfo.origin.evaNumber) : "",
      via: [...(t.via || [])].sort((a, b) => (a.displayPriority ?? 0) - (b.displayPriority ?? 0))
        .map(v => ({ eva: String(v.evaNumber), name: names[String(v.evaNumber)] || "", cancelled: isCancelled(v), extra: !!v.additional })),
      messages: messageTexts(data, e.messages),
    };
  }).filter(x => x.plan);
}

// Ein Fenster abrufen (mit Zwischenspeicher pro Durchlauf)
export async function board(env, kind, eva, timeStart, { maxVia = 3, cache } = {}) {
  const key = `${kind}|${eva}|${timeStart}|${maxVia}`;
  if (cache?.has(key)) return cache.get(key);
  const p = rawBoard(env, kind, eva, timeStart, maxVia).then(d => normalize(d, kind));
  cache?.set(key, p);
  return p;
}

// ISO mit Berliner Offset, auf 5 Minuten abgerundet (bessere Wiederverwendung im Zwischenspeicher)
export function isoBerlin(ms, roundMin = 5) {
  const d = new Date(Math.floor(ms / (roundMin * 60e3)) * roundMin * 60e3);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).map(x => [x.type, x.value]));
  const off = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - d.getTime()) / 60e3);
  const sg = off >= 0 ? "+" : "-", a = Math.abs(off);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sg}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

// Eine bestimmte Fahrt an einem Bahnhof finden: erst um die Prognose herum, dann um die Sollzeit, dann weitere Fenster
export async function findJourney(env, kind, eva, jid, aroundMs, { planMs, windows = 2, cache, maxVia = 3, label, after } = {}) {
  const starts = [];
  const add = ms => { const s = isoBerlin(ms - 10 * 60e3); if (!starts.includes(s)) starts.push(s); };
  add(aroundMs);
  if (planMs && Math.abs(planMs - aroundMs) > 15 * 60e3) add(planMs);
  for (let i = 1; starts.length < windows + (planMs ? 1 : 0) && i < 20; i++) add(aroundMs + i * (WINDOW_MIN - 5) * 60e3);
  let twin = null;
  for (const s of starts) {
    const list = await board(env, kind, eva, s, { cache, maxVia });
    const hit = list.find(x => x.jid === jid);
    if (hit) return hit;
    // Rückfall: gleiche Linie, erste passende Zeit nach der Abfahrt (z. B. gekoppelte S-Bahn-Zugteile mit eigener Kennung)
    if (!twin && label && after) twin = list.filter(x => x.label === label && Date.parse(x.plan) > after).sort((a, b) => Date.parse(a.plan) - Date.parse(b.plan))[0] || null;
  }
  return twin ? { ...twin, jid, twin: true } : null;
}
