// Reise einlesen: Screenshot, PDF (Ticket, Buchungsbestätigung) oder Text/Link → KI liest Züge, Bahnhöfe, Zeiten
// → jede Bahn-Teilstrecke wird wie bei der Suche der echten DB-Fahrt zugeordnet.
import { search } from "./stations.js";
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
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 2000, system: SYSTEM.replace("{TODAY}", new Date().toISOString().slice(0, 10)),
      tools: [TOOL], tool_choice: { type: "tool", name: "reise" }, messages: [{ role: "user", content }] }),
  });
  if (!r.ok) throw new Error(`KI: HTTP ${r.status}`);
  const j = await r.json();
  return j.content?.find(c => c.type === "tool_use")?.input || { trips: [] };
}

// Ortszeit Berlin (Datum + Uhrzeit) → ISO mit Offset
export function berlinIso(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^\d{1,2}:\d{2}$/.test(time || "")) return null;
  const [h, m] = time.split(":").map(Number), [Y, M, D] = date.split("-").map(Number);
  const guess = Date.UTC(Y, M - 1, D, h, m);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess)).map(x => [x.type, x.value]));
  const off = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - guess;
  return new Date(guess - off).toISOString();
}

const NON_RAIL = /^(bus|sev|str|tram|u\s?\d|u-bahn|fähre|ferry|ast|ruf)/i;
const station = name => { const n = String(name || "").replace(/\s*\((tief|oben|S|S-Bahn)\)\s*$/i, ""); return search(n)[0] || search(n.split(/[,(]/)[0])[0] || null; };

// Erkannte Teilstrecke → Teilstrecke mit DB-Fahrtkennung
export async function resolveExtracted(env, leg, cache) {
  const depIso = berlinIso(leg.dep_date, leg.dep_time);
  let arrIso = berlinIso(leg.arr_date || leg.dep_date, leg.arr_time);
  if (depIso && arrIso && Date.parse(arrIso) < Date.parse(depIso)) arrIso = new Date(Date.parse(arrIso) + 864e5).toISOString();   // über Mitternacht
  if (!depIso) return null;
  const f = station(leg.from), t = station(leg.to), label = String(leg.train || "").replace(/\s+/g, " ").trim();
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
  if (!arrIso) return null;
  const line = label.replace(/\s+/g, "");
  return resolveLeg(env, { rail: rail && !!f && !!t, label, num, line, mode: rail ? "RAIL" : "BUS",
    from: { name: f?.name || leg.from, eva: f?.eva, plan: depIso, track: fromTrack },
    to: { name: t?.name || leg.to, eva: t?.eva, plan: arrIso, track: toTrack } }, cache);
}

export async function importTrip(env, { text = "", files = [] }) {
  let data;
  if (env.MOCK === "1") data = mockExtraction();
  else {
    if (!env.ANTHROPIC_KEY) throw new Error("Import ist auf dem Server noch nicht eingerichtet (ANTHROPIC_KEY fehlt).");
    const content = [];
    for (const f of files.slice(0, 3)) {
      if (f.type === "application/pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } });
      else if (/^image\/(png|jpeg|webp|gif)$/.test(f.type)) content.push({ type: "image", source: { type: "base64", media_type: f.type, data: f.data } });
    }
    content.push({ type: "text", text: text ? `Geteilter Text:\n${String(text).slice(0, 6000)}` : "Lies die Reise aus den Anhängen." });
    data = await ask(env, MODEL(env), content).catch(() => ({ trips: [] }));
    if (!data.trips?.some(t => t.legs?.length)) data = await ask(env, MODEL_STRONG(env), content);
  }
  const cache = new Map(), trips = [];
  for (const t of (data.trips || []).slice(0, 3)) {
    const legs = [];
    for (const l of (t.legs || []).slice(0, 8)) { const r = await resolveExtracted(env, l, cache).catch(e => { console.log("Import-Teilstrecke:", e.message); return null; }); if (r) legs.push(r); }
    if (legs.length) trips.push({ label: t.label || "", legs });
  }
  return { trips, ticket: ["spar", "flex", "dticket", "bc100"].includes(data.ticket) ? data.ticket : null, note: data.note || "" };
}

// Testdaten: Berlin Hbf → Leipzig → München mit den Zügen der nächsten Stunde
function mockExtraction() {
  const d = new Date(Date.now() + 3600e3), h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", hourCycle: "h23" }).format(d));
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(d), hu = new Date(d).getUTCHours();
  const pad = n => String(n).padStart(2, "0"), hh = n => pad(((h + n) % 24 + 24) % 24);
  return { ticket: "spar", trips: [{ label: "Hinfahrt", legs: [
    { train: `ICE ${500 + hu}`, from: "Berlin Hbf", dep_date: date, dep_time: `${hh(0)}:05`, to: "Leipzig Hbf", arr_time: `${hh(1)}:10`, from_platform: "14" },
    { train: `ICE ${1600 + hu}`, from: "Leipzig Hbf", dep_date: date, dep_time: `${hh(1)}:27`, to: "München Hbf", arr_time: `${hh(4)}:20` },
  ] }] };
}
