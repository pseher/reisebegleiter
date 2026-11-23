// Bahnhofssuche. Vorerst über die Timetables-API (/station/{Muster}), die PlanFlink schon nutzt.
// Timetables ist als „deprecated“ markiert → später auf OpenStation umstellen (nur diese Datei ändern).
import { MOCK_STATIONS } from "./mock.js";

const TT = "https://apis.deutschebahn.com/db-api-marketplace/apis/timetables/v1";
const attrs = tag => Object.fromEntries([...String(tag).matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)]
  .map(m => [m[1], (m[2] ?? m[3] ?? "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'")]));
const fold = s => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss");

export async function searchStations(env, q) {
  q = String(q || "").trim();
  if (q.length < 2) return [];
  if (env.MOCK === "1") return MOCK_STATIONS.filter(s => fold(s.name).includes(fold(q))).slice(0, 8);
  if (!env.DB_CLIENT_ID || !env.DB_API_KEY) throw new Error("DB-Schlüssel fehlen");
  const found = [];
  for (const pattern of [q, `${q}*`]) {
    const r = await fetch(`${TT}/station/${encodeURIComponent(pattern)}`, {
      headers: { "DB-Client-Id": env.DB_CLIENT_ID, "DB-Api-Key": env.DB_API_KEY, Accept: "application/xml" },
    }).catch(() => null);
    if (!r || !r.ok) continue;
    const xml = await r.text();
    for (const m of xml.matchAll(/<station\b([^>]*?)\/?>/g)) {
      const a = attrs(m[1]);
      if (a.eva && !found.some(f => f.eva === a.eva)) found.push({ eva: a.eva, name: a.name || a.eva });
    }
    if (found.length >= 3) break;
  }
  // Hauptbahnhöfe und exakte Treffer zuerst
  const f = fold(q);
  const score = s => (fold(s.name) === f ? 0 : fold(s.name).startsWith(f) ? 1 : 2) + (/\bhbf\b/i.test(s.name) ? -0.5 : 0);
  return found.sort((a, b) => score(a) - score(b)).slice(0, 8);
}
