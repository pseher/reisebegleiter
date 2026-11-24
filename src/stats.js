// Abfragezähler: zählt externe Abfragen (DB, VBB, Transitous, KI) und schreibt sie stundenweise in rb_stats.
import * as db from "./db.js";

export const C = { db: 0, db429: 0, vbb: 0, motis: 0, ai: 0 };
export const count = (k, n = 1) => { C[k] = (C[k] || 0) + n; };

// Stand übernehmen und zurücksetzen; run = Daten des Überwachungs-Durchlaufs (Anzahl Prüfungen, Reisen)
export async function flush(env, run = null) {
  const d = { ...C }; for (const k of Object.keys(C)) C[k] = 0;
  if (!run && !d.db && !d.db429 && !d.vbb && !d.motis && !d.ai) return;
  const hour = new Date(Math.floor(Date.now() / 3600e3) * 3600e3).toISOString();
  try { await db.statsAdd(env, { hour, ...d, runs: run ? 1 : 0, checks: run?.checks || 0, trips: run?.trips || 0 }); }
  catch (e) { for (const k of Object.keys(d)) C[k] += d[k]; console.log("Zähler:", e.message); }   // beim nächsten Mal mitschreiben
}
