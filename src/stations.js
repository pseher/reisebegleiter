// Bahnhofssuche über eine eingebaute Liste aller DB-Stationen (EVA-Nummer, Name, Gewicht, ggf. Ort).
// Quelle: DB Station Data (StaDa, CC BY 4.0) über das npm-Paket db-stations 5.0.2 (ISC).
// Keine Abfrage bei der DB nötig – schnell, findet Teilbegriffe und hängt nicht an der abgekündigten Timetables-API.
import DATA from "./stations-data.json" with { type: "json" };
import { MOCK_STATIONS } from "./mock.js";

export const fold = s => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss")
  .replace(/hauptbahnhof/g, "hbf").replace(/[()\-.,/]/g, " ").replace(/\s+/g, " ").trim();

let INDEX = null;
function index() {
  if (!INDEX) INDEX = DATA.map(([eva, name, weight, city]) => {
    const n = fold(name), all = city ? `${n} ${fold(city)}` : n;
    return { eva, name: name.replace(/\s*Hauptbahnhof$/, " Hbf"), city: city || "", weight, n, words: all.split(" ") };
  });
  return INDEX;
}

export function search(q, list = index(), limit = 8) {
  const f = fold(q), toks = f.split(" ").filter(Boolean);
  if (!toks.length || f.length < 2) return [];
  const hits = [];
  for (const s of list) {
    if (!toks.every(t => s.words.some(w => w.startsWith(t)))) continue;
    const score = (s.n === f ? 3000 : 0) + (s.n.startsWith(f) ? 1500 : 0) + (s.words[0].startsWith(toks[0]) ? 500 : 0) + (/\bhbf\b/.test(s.n) ? 300 : 0) + s.weight;
    hits.push({ s, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
    .map(({ s }) => ({ eva: s.eva, name: s.city && !s.name.includes(s.city) ? `${s.name} (${s.city})` : s.name }));
}

export async function searchStations(env, q) {
  if (env.MOCK === "1") { const f = fold(q); return MOCK_STATIONS.filter(s => fold(s.name).includes(f)).slice(0, 8); }
  return search(q);
}
