import { count } from "./stats.js";
// Reise einlesen: Screenshot, PDF (Ticket, Buchungsbestätigung) oder Text/Link → KI liest Züge, Bahnhöfe, Zeiten
// → jede Bahn-Teilstrecke wird wie bei der Suche der echten DB-Fahrt zugeordnet.
import { search, byEva as byEvaSt } from "./stations.js";
import { resolveLeg, connections } from "./routing.js";

const MODEL = env => env.IMPORT_MODEL || "claude-haiku-5-5";
const MODEL_STRONG = env => env.IMPORT_MODEL_STRONG || "claude-sonnet-5-5";

const TOOL = {
  name: "reise",
  description: "Gibt die erkannten Bahnverbindungen strukturiert zurück.",
  input_schema: {
    type: "object",
    properties: {
      trips: { type: "array", description: "Eine Verbindung je Fahrtrichtung (z. B. Hinfahrt, Rückfahrt).", items: {
        type: "object",
        properties: {
          label: { type: "string", description: "z. B. Hinfahrt, Rückfahrt" },
          legs: { type: "array", items: { type: "object", properties: {
            train: { type: "string", description: "Zugbezeichnung wie gedruckt, z. B. 'ICE 840', 'RE 1', 'S 2', 'Bus 100'" },
            from: { type: "string", description: "Abfahrtsbahnhof, vollständiger Name" },
            dep_date: { type: "string", description: "YYYY-MM-DD" },
            dep_time: { type: "string", description: "HH:MM (Planzeit)" },
            from_platform: { type: "string" },
            to: { type: "string", description: "Ankunftsbahnhof" },
            arr_date: { type: "string", description: "YYYY-MM-DD" },
            arr_time: { type: "string", description: "HH:MM (Planzeit). Leer lassen, wenn nicht angegeben (z. B. auf Tickets)." },
            to_platform: { type: "string" },
          }, required: ["train", "from", "dep_date", "dep_time", "to"] } },
        },
        required: ["legs"],
      } },
      ticket: { type: "string", enum: ["spar", "flex", "dticket", "bc100", "unbekannt"], description: "Super Sparpreis/Sparpreis → spar; Flexpreis → flex; Deutschlandticket → dticket; BahnCard 100 → bc100" },
      note: { type: "string", description: "Kurzer Hinweis, falls etwas unklar ist (deutsch)" },
    },
    required: ["trips"],
  },
};

const SYSTEM = `Du liest Bahnreisen aus Screenshots, Tickets, Buchungsbestätigungen oder geteilten Texten der Deutschen Bahn.
Gib nur die tatsächliche Verbindung zurück: jede Teilstrecke mit Zug, Abfahrt, Ankunft und Gleis, so wie gedruckt.
Fußwege weglassen. Steht keine Ankunftszeit da (typisch bei Tickets), lass arr_time leer – nicht raten. Fehlt das Jahr, nimm das nächste passende Datum ab heute. Erfinde nichts: lieber eine Teilstrecke weglassen und im Feld note erklären.
Heute ist {TODAY} (Europe/Berlin).`;

async function ask(env, model, content) {
  count("ai"); const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 2000, system: SYSTEM.replace("{TODAY}", new Date().toISOString().slice(0, 10)),
      tools: [TOOL], tool_choice: { type: "tool", name: "reise" }, messages: [{ role: "user", content }] }),
  });
  if (!r.ok) throw new Error(`KI: HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const j = await r.json(), strong = model === MODEL_STRONG(env) ? "strong" : "fast";
  count(`tok_in_${strong}`, j.usage?.input_tokens || 0); count(`tok_out_${strong}`, j.usage?.output_tokens || 0);
  return j.content?.find(c => c.type === "tool_use")?.input || { trips: [] };
}

// Ortszeit Berlin (Datum + Uhrzeit) → ISO mit Offset
export function berlinIso(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^\d{1,2}:\d{2}$/.test(time || "")) return null;
  const [h, m] = time.split(":").map(Number), [Y, M, D] = date.split("-").map(Number);
  const guess = Date.UTC(Y, M - 1, D, h, m);
  const offAt = ms => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - ms; };
  // Zweimal rechnen: der Versatz muss zur Zielzeit passen, nicht zur geratenen (Zeitumstellung in der Nacht)
  const off1 = offAt(guess), off2 = offAt(guess - off1);
  return new Date(guess - off2).toISOString();
}

const NON_RAIL = /^(bus|sev|str|tram|u\s?\d|u-bahn|fähre|ferry|ast|ruf)/i;
// Haltestellen wie „Bahnhof, Nauen“ (Haltestelle, Ort) oder „Nauen, Bahnhof“: allgemeine Wörter allein ergeben keinen Treffer
const GENERIC = /^(bahnhof|bf\.?|hbf\.?|hauptbahnhof|busbahnhof|zob|bahnhofsvorplatz|bahnhofstr(\.|aße)?)$/i;
const fold = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/ß/g, "ss");
const words = s => fold(s).split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !GENERIC.test(w) && !["berlin"].includes(w) || /^\d+$/.test(w));
// Passt der gefundene Bahnhof wirklich zum Namen? (mindestens ein gemeinsames, nicht allgemeines Wort)
const fits = (hit, q) => { if (GENERIC.test(String(q).trim())) return false; const qw = words(q); if (!qw.length) return true; const hw = fold(hit.name); return qw.some(w => hw.includes(w)); };
export function station(name) {
  const n = String(name || "").replace(/\s*\((tief|oben|S|S-Bahn)\)\s*$/i, "").trim();
  const m = /^([^,]+),\s*([^,]+)$/.exec(n);
  if (m) {
    const [a, b] = [m[1].trim(), m[2].trim()];
    if (GENERIC.test(a)) return search(b).find(x => fits(x, b)) || null;          // „Bahnhof, Nauen“ → Nauen
    if (GENERIC.test(b)) return search(a).find(x => fits(x, a)) || null;          // „Nauen, Bahnhof“ → Nauen
    // „Markt, Nauen“: Bushaltestelle im Ort – nur ein Bahnhof, der wirklich in diesem Ort liegt und so heißt
    const hit = search(`${b} ${a}`).find(x => fits(x, b) && fits(x, a)) || search(n).find(x => fits(x, b) && fits(x, a));
    return hit || null;
  }
  for (const q of [n, n.split(/[,(]/)[0].trim(), m ? `${m[2].trim()} ${m[1].trim()}` : null].filter(Boolean)) {
    const hit = search(q).find(x => fits(x, q)); if (hit) return hit;
  }
  return null;
}

// Erkannte Teilstrecke → Teilstrecke mit DB-Fahrtkennung
export async function resolveExtracted(env, leg, cache, prevTo = null) {
  const depIso = berlinIso(leg.dep_date, leg.dep_time);
  let arrIso = berlinIso(leg.arr_date || leg.dep_date, leg.arr_time);
  if (depIso && arrIso && Date.parse(arrIso) < Date.parse(depIso)) arrIso = new Date(Date.parse(arrIso) + 864e5).toISOString();   // über Mitternacht
  if (!depIso) return null;
  let f = station(leg.from); const t = station(leg.to), label = String(leg.train || "").replace(/\s+/g, " ").trim();
  // Umstieg: der Start dieser Teilstrecke liegt beim Ziel der vorigen (z. B. Bus ab „Bahnhof, Nauen“ nach Zug bis Nauen)
  const km = (a, b) => (a?.lat != null && b?.lat != null ? Math.hypot((a.lat - b.lat) * 111, (a.lon - b.lon) * 68) : null);
  if (prevTo && prevTo.eva && (!f || (km(f, prevTo) ?? 0) > 5)) { const pv = byEvaSt(prevTo.eva); if (pv) f = pv; }
  const rail = !NON_RAIL.test(label);
  const num = (label.match(/(\d{2,6})\s*$/) || [])[1] || "";
  // Keine Ankunftszeit (Ticket)? Beim Verbindungsplaner nachsehen: gleicher Zug, gleiche Abfahrt
  let toTrack = leg.to_platform || "", fromTrack = leg.from_platform || "";
  if (!arrIso && f && t) {
    const cs = await connections(env, f.eva, t.eva, Date.parse(depIso) - 60e3).catch(() => []);
    const hit = cs.find(c => c.legs.length === 1 && Math.abs(Date.parse(c.legs[0].from.plan) - Date.parse(depIso)) <= 2 * 60e3 && (!num || String(c.legs[0].num).replace(/\D/g, "") === num || c.legs[0].label.endsWith(num)))
      || cs.find(c => Math.abs(Date.parse(c.legs[0].from.plan) - Date.parse(depIso)) <= 2 * 60e3 && c.legs.length === 1);
    if (hit) { arrIso = hit.legs[0].to.plan; toTrack ||= hit.legs[0].to.track; fromTrack ||= hit.legs[0].from.track; }
  }
  // Immer noch unbekannt: aus der Entfernung schätzen (ca. 90 km/h Reisegeschwindigkeit, mind. 15 Min.) – wird später durch DB-Daten ersetzt
  let estimated = false;
  if (!arrIso && f && t) {
    const km = Math.hypot((f.lat - t.lat) * 111, (f.lon - t.lon) * 68) * 1.25;
    arrIso = new Date(Date.parse(depIso) + Math.max(15, Math.round(km / 90 * 60)) * 60e3).toISOString();
    estimated = true;
  }
  if (!arrIso) return null;
  const line = label.replace(/\s+/g, "");
  const r = await resolveLeg(env, { rail: rail && !!f && !!t, label, num, line, mode: rail ? "RAIL" : "BUS",
    from: { name: f?.name || leg.from, eva: f?.eva, plan: depIso, track: fromTrack },
    to: { name: t?.name || leg.to, eva: t?.eva, plan: arrIso, track: toTrack } }, cache);
  // Hat OpenBoards die echte Ankunft gefunden, ist sie nicht mehr geschätzt
  if (estimated && r && r.to.plan === arrIso) r.to.estimated = true;
  return r;
}

const userErr = msg => Object.assign(new Error(msg), { user: true });
// Nur ein Buchungs-/Teilen-Link von bahn.de (…?vbid=…) ohne weiteren Text: darin steht die Verbindung nicht drin
export const onlyBahnLink = text => { const t = String(text || "").trim();
  return /^https?:\/\/(www\.)?(bahn\.de|int\.bahn\.de)\/\S*$/i.test(t) && !/\d{1,2}:\d{2}/.test(t); };

export async function importTrip(env, { text = "", files = [] }) {
  let data;
  if (!files.length && onlyBahnLink(text))
    throw userErr("In diesem Link steht die Verbindung selbst nicht drin – die Bahn speichert sie nur auf ihrer Seite. So klappt es: in der DB-App bei der Verbindung „Teilen“ → „Text kopieren“ und hier einfügen, oder einfach einen Screenshot der Reiseübersicht.");
  if (env.MOCK === "1") data = mockExtraction(text);
  else {
    if (!env.ANTHROPIC_KEY) { console.log("Import: ANTHROPIC_KEY fehlt"); throw userErr("Das Einlesen ist gerade nicht verfügbar. Bitte die Verbindung über „Von / Nach“ suchen."); }
    const content = [];
    for (const f of files.slice(0, 3)) {
      if (f.type === "application/pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } });
      else if (/^image\/(png|jpeg|webp|gif)$/.test(f.type)) content.push({ type: "image", source: { type: "base64", media_type: f.type, data: f.data } });
    }
    content.push({ type: "text", text: text ? `Geteilter Text:\n${String(text).slice(0, 6000)}` : "Lies die Reise aus den Anhängen." });
    let fail = null;
    data = await ask(env, MODEL(env), content).catch(e => { fail = e; console.log("Import (schnell):", e.message); return { trips: [] }; });
    if (!data.trips?.some(t => t.legs?.length)) {
      count("imp_strong");
      const d2 = await ask(env, MODEL_STRONG(env), content).catch(e => { console.log("Import (stark):", e.message); return null; });
      if (d2) data = d2;
      else if (fail) throw userErr("Das Einlesen klappt gerade nicht. Bitte gleich noch einmal versuchen – oder die Verbindung über „Von / Nach“ suchen.");
    }
  }
  const cache = new Map(), trips = [], skipped = [];
  for (const t of (data.trips || []).slice(0, 3)) {
    const legs = [];
    for (const l of (t.legs || []).slice(0, 8)) {
      const r = await resolveExtracted(env, l, cache, legs[legs.length - 1]?.to || null).catch(e => { console.log("Import-Teilstrecke:", e.message); return null; });
      if (r) legs.push(r); else skipped.push(`${l.train || "?"} ${l.from || ""} → ${l.to || ""}`.trim());
    }
    if (legs.length) trips.push({ label: t.label || "", legs, estimated: legs.some(x => x.to.estimated) });
  }
  const note = [skipped.length ? `Nicht übernommen: ${skipped.join(", ")} (Bahnhof oder Zeit nicht erkannt).` : "",
    trips.some(t => t.estimated) ? "Ankunftszeiten mit ≈ sind geschätzt und werden vor der Fahrt mit den DB-Daten ersetzt." : ""].filter(Boolean).join(" ");
  count(trips.length ? "imp_ok" : "imp_none");
  return { trips, ticket: ["spar", "flex", "dticket", "bc100"].includes(data.ticket) ? data.ticket : null, note };
}

// Testdaten: Berlin Hbf → Leipzig → München mit den Zügen der nächsten Stunde
function mockExtraction(text = "") {
  const d = new Date(Date.now() + 3600e3), hu = new Date(d).getUTCHours();
  // Datum und Uhrzeit je Versatz in Stunden (über Mitternacht hinweg korrekt)
  const at = n => { const x = new Date(d.getTime() + n * 3600e3);
    return { date: new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(x),
      hh: new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", hourCycle: "h23" }).format(x) }; };
  return { ticket: "spar", trips: [{ label: "Hinfahrt", legs: [
    { train: `ICE ${500 + hu}`, from: "Berlin Hbf", dep_date: at(0).date, dep_time: `${at(0).hh}:05`, to: "Leipzig Hbf", arr_time: `${at(1).hh}:10`, from_platform: "14" },
    { train: `ICE ${1600 + hu}`, from: "Leipzig Hbf", dep_date: at(1).date, dep_time: `${at(1).hh}:27`, to: "München Hbf", arr_time: `${at(4).hh}:20` },
  ] }, ...(/zwei/i.test(text) ? [{ label: "Rückfahrt", legs: [
    { train: `ICE ${1601 + hu}`, from: "Leipzig Hbf", dep_date: at(2).date, dep_time: `${at(2).hh}:27`, to: "München Hbf" },
  ] }] : [])] };
}
