// Bahnhofssuche über eine eingebaute Liste aller DB-Stationen (EVA-Nummer, Name, Gewicht, ggf. Ort).
// Quelle: DB Station Data (StaDa, CC BY 4.0) über das npm-Paket db-stations 5.0.2 (ISC).
// Keine Abfrage bei der DB nötig – schnell, findet Teilbegriffe und hängt nicht an der abgekündigten Timetables-API.
import DATA from "./stations-data.json" with { type: "json" };
import { MOCK_STATIONS } from "./mock.js";

export const fold = s => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss")
  .replace(/hauptbahnhof/g, "hbf").replace(/[()\-.,/]/g, " ").replace(/\s+/g, " ").trim();

let INDEX = null;
function index() {
  if (!INDEX) INDEX = DATA.map(([eva, name, weight, lat, lon, city]) => {
    const n = fold(name), all = city ? `${n} ${fold(city)}` : n;
    return { eva, name: name.replace(/\s*Hauptbahnhof$/, " Hbf"), city: city || "", weight, lat, lon, n, words: all.split(" ") };
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
    .map(({ s }) => ({ eva: s.eva, name: displayName(s), lat: s.lat, lon: s.lon }));
}
const displayName = s => (s.city && !s.name.includes(s.city) ? `${s.name} (${s.city})` : s.name);

export const byEva = eva => { const s = index().find(x => x.eva === String(eva)); return s ? { eva: s.eva, name: displayName(s), lat: s.lat, lon: s.lon } : null; };

// Nächster DB-Bahnhof zu Koordinaten (für Haltestellen aus der Verbindungssuche)
export function nearest(lat, lon, maxM = 600) {
  let best = null, bd = Infinity;
  const kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110540;
  for (const s of index()) {
    const dx = (s.lon - lon) * kx, dy = (s.lat - lat) * ky, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = s; }
  }
  return best && Math.sqrt(bd) <= maxM ? { eva: best.eva, name: displayName(best), dist: Math.round(Math.sqrt(bd)) } : null;
}

// Bahnhöfe in der Nähe eines Standorts (nächste zuerst)
export function nearby(lat, lon, maxM = 2500, limit = 4) {
  const kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110540;
  return index().map(s => ({ s, d: Math.hypot((s.lon - lon) * kx, (s.lat - lat) * ky) })).filter(x => x.d <= maxM)
    .sort((a, b) => a.d - b.d).slice(0, limit).map(({ s, d }) => ({ eva: s.eva, name: displayName(s), dist: Math.round(d) }));
}

export async function searchStations(env, q) {
  if (env.MOCK === "1") { const f = fold(q); return MOCK_STATIONS.filter(s => fold(s.name).includes(f)).slice(0, 8); }
  return search(q);
}
