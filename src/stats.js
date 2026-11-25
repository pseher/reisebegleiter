// Zähler: externe Abfragen (DB, VBB, Transitous, KI) und Ereignisse (Fahrten, Mitteilungen, Plan B, Import …),
// stundenweise in rb_stats geschrieben. Nur Summen – nichts über einzelne Personen, Strecken oder Orte.
import * as db from "./db.js";

const BASE = ["db", "db429", "vbb", "motis", "ai"];
export const C = { db: 0, db429: 0, vbb: 0, motis: 0, ai: 0 };
let EV = {};
export const count = (k, n = 1) => { if (BASE.includes(k)) C[k] = (C[k] || 0) + n; else EV[k] = (EV[k] || 0) + n; };

// Stand übernehmen und zurücksetzen; run = Daten des Überwachungs-Durchlaufs (Anzahl Prüfungen, Reisen)
export async function flush(env, run = null) {
  const d = { ...C }, ev = EV; for (const k of Object.keys(C)) C[k] = 0; EV = {};
  const hour = new Date(Math.floor(Date.now() / 3600e3) * 3600e3).toISOString();
  if (run || BASE.some(k => d[k])) {
    try { await db.statsAdd(env, { hour, ...d, runs: run ? 1 : 0, checks: run?.checks || 0, trips: run?.trips || 0 }); }
    catch (e) { for (const k of BASE) C[k] += d[k]; console.log("Zähler:", e.message); }   // beim nächsten Mal mitschreiben
  }
  if (Object.keys(ev).length) {
    try { await db.statsEv(env, hour, ev); }
    catch (e) { for (const [k, v] of Object.entries(ev)) EV[k] = (EV[k] || 0) + v; console.log("Ereignisse:", e.message); }
  }
}
