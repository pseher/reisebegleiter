// Speicher: Supabase (PlanFlink-Projekt, Tabellen rb_devices / rb_trips) über REST mit dem Secret Key.
// Mit MOCK=1 ein Speicher im Arbeitsspeicher (nur für lokale Tests).

const MEM = { rb_devices: new Map(), rb_trips: new Map(), rb_accounts: new Map(), rb_routines: new Map(), rb_stats: new Map(), rb_guard: new Map(), rb_shares: new Map() };

function hdr(env) {
  const k = env.SUPABASE_SERVICE_KEY;
  return { apikey: k, "Content-Type": "application/json", ...(String(k).startsWith("sb_") ? {} : { Authorization: `Bearer ${k}` }) };
}
async function rest(env, path, init = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) throw new Error("Supabase nicht eingerichtet");
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...hdr(env), ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}
const mem = env => env.MOCK === "1";
const now = () => new Date().toISOString();

export async function insert(env, table, row) {
  if (mem(env)) { const r = { id: crypto.randomUUID(), created_at: now(), ...row }; MEM[table].set(r.id, r); return r; }
  const [r] = await rest(env, table, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
  return r;
}
export async function get(env, table, id) {
  if (mem(env)) return MEM[table].get(id) || null;
  const [r] = await rest(env, `${table}?id=eq.${encodeURIComponent(id)}&limit=1`);
  return r || null;
}
export async function update(env, table, id, patch) {
  if (mem(env)) { const r = MEM[table].get(id); if (r) Object.assign(r, patch); return r; }
  await rest(env, `${table}?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
}
export async function remove(env, table, id) {
  if (mem(env)) return MEM[table].delete(id);
  await rest(env, `${table}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}
// Reisen eines Kontos (alle verbundenen Geräte sehen dieselben)
export async function tripsOf(env, accountId) {
  if (mem(env)) return [...MEM.rb_trips.values()].filter(t => (t.account_id || t.device_id) === accountId && t.active).sort((a, b) => a.created_at < b.created_at ? 1 : -1);
  return rest(env, `rb_trips?account_id=eq.${accountId}&active=eq.true&order=created_at.desc&limit=20`);
}
// Regelmäßige Fahrten
export async function routinesOf(env, accountId) {
  if (mem(env)) return [...MEM.rb_routines.values()].filter(r => r.account_id === accountId).sort((a, b) => a.dep < b.dep ? -1 : 1);
  return rest(env, `rb_routines?account_id=eq.${accountId}&order=dep.asc&limit=20`);
}
export async function activeRoutines(env) {
  if (mem(env)) return [...MEM.rb_routines.values()].filter(r => !r.paused);
  return rest(env, "rb_routines?paused=eq.false&limit=500");
}
// Geräte eines oder mehrerer Konten
export async function devicesOf(env, accountIds, select = "id,push,account_id,label,created_at,last_seen") {
  if (!accountIds.length) return [];
  if (mem(env)) return [...MEM.rb_devices.values()].filter(d => accountIds.includes(d.account_id));
  return rest(env, `rb_devices?account_id=in.(${accountIds.join(",")})&select=${select}&order=created_at.asc`);
}
// Gerät mit diesem (gehashten) Verbindungscode, solange er gilt
export async function deviceByLinkCode(env, hash) {
  const t = new Date().toISOString();
  if (mem(env)) return [...MEM.rb_devices.values()].find(d => d.link_code === hash && d.link_until > t) || null;
  const [r] = await rest(env, `rb_devices?link_code=eq.${encodeURIComponent(hash)}&link_until=gt.${t}&select=id,account_id&limit=1`);
  return r || null;
}
// Alles vom alten Konto ins neue übernehmen (Reisen und Geräte), dann das alte löschen
export async function mergeAccount(env, from, to) {
  if (mem(env)) {
    for (const t of MEM.rb_trips.values()) if ((t.account_id || t.device_id) === from) t.account_id = to;
    for (const d of MEM.rb_devices.values()) if (d.account_id === from) d.account_id = to;
    for (const r of MEM.rb_routines.values()) if (r.account_id === from) r.account_id = to;
    MEM.rb_accounts.delete(from); return;
  }
  await rest(env, `rb_trips?account_id=eq.${from}`, { method: "PATCH", body: JSON.stringify({ account_id: to }) });
  await rest(env, `rb_routines?account_id=eq.${from}`, { method: "PATCH", body: JSON.stringify({ account_id: to }) });
  await rest(env, `rb_devices?account_id=eq.${from}`, { method: "PATCH", body: JSON.stringify({ account_id: to }) });
  await rest(env, `rb_accounts?id=eq.${from}`, { method: "DELETE" });
}
export async function activeTrips(env) {
  if (mem(env)) return [...MEM.rb_trips.values()].filter(t => t.active);
  return rest(env, "rb_trips?active=eq.true&order=created_at.asc&limit=200");
}
export async function devicesByIds(env, ids) {
  if (!ids.length) return [];
  if (mem(env)) return ids.map(id => MEM.rb_devices.get(id)).filter(Boolean);
  return rest(env, `rb_devices?id=in.(${ids.join(",")})&select=id,push,account_id`);
}
// Aufräumen: beendete Reisen nach 24 Std., Geräte ohne Lebenszeichen nach 60 Tagen
export async function cleanup(env) {
  const day = new Date(Date.now() - 864e5).toISOString(), old = new Date(Date.now() - 60 * 864e5).toISOString();
  const h3 = new Date(Date.now() - 3 * 3600e3).toISOString();   // beendete Fahrten: 3 Std. nach Ankunft ganz weg
  if (mem(env)) { for (const [id, t] of MEM.rb_trips) if (!t.active && t.ends_at < h3) MEM.rb_trips.delete(id); return; }
  await rest(env, `rb_trips?active=eq.false&ends_at=lt.${h3}`, { method: "DELETE" });
  await rest(env, `rb_devices?last_seen=lt.${old}`, { method: "DELETE" });
  await rest(env, `rb_guard?t=lt.${day}`, { method: "DELETE" }).catch(() => {});
  await rest(env, `rb_shares?ends_at=lt.${day}`, { method: "DELETE" }).catch(() => {});   // geteilte Links nach der Fahrt weg   // Schutz-Zähler nach einem Tag weg
  // Konten ohne Geräte (alle entfernt oder lange unbenutzt) samt Reisen löschen
  // (zusätzlich hier prüfen, dass wirklich kein Gerät mehr dranhängt)
  const orphans = (await rest(env, "rb_accounts?select=id,recover_hash,orphan_at,rb_devices(id)&rb_devices=is.null&limit=200").catch(() => []) || [])
    .filter(o => Array.isArray(o.rb_devices) && o.rb_devices.length === 0);
  // Mit Wiederherstellungscode: noch ein Jahr aufheben (man kann alles zurückholen), sonst gleich löschen
  const year = Date.now() - 365 * 864e5, gone = orphans.filter(o => !o.recover_hash || (o.orphan_at && Date.parse(o.orphan_at) < year)), mark = orphans.filter(o => o.recover_hash && !o.orphan_at);
  if (gone.length) await rest(env, `rb_accounts?id=in.(${gone.map(o => o.id).join(",")})`, { method: "DELETE" });
  if (mark.length) await rest(env, `rb_accounts?id=in.(${mark.map(o => o.id).join(",")})`, { method: "PATCH", body: JSON.stringify({ orphan_at: new Date().toISOString() }) });
}

// Konto zum Wiederherstellungscode (gespeichert ist nur der Prüfwert)
export async function accountByRecover(env, hash) {
  if (mem(env)) return [...MEM.rb_accounts.values()].find(a => a.recover_hash === hash) || null;
  const [r] = await rest(env, `rb_accounts?recover_hash=eq.${encodeURIComponent(hash)}&limit=1`);
  return r || null;
}

// Konto, dessen früherer Code beim Verbinden ersetzt wurde
export async function accountByOldRec(env, hash) {
  if (mem(env)) return [...MEM.rb_accounts.values()].find(a => (a.prefs?.oldRec || []).includes(hash)) || null;
  const [r] = await rest(env, `rb_accounts?select=id&prefs->oldRec=cs.${encodeURIComponent(JSON.stringify([hash]))}&limit=1`);
  return r || null;
}

// Abfragezähler (stundenweise aufsummiert)
export async function statsAdd(env, x) {
  if (mem(env)) { const o = MEM.rb_stats.get(x.hour) || { hour: x.hour, db: 0, db429: 0, vbb: 0, motis: 0, ai: 0, runs: 0, checks: 0, trips_max: 0, db_max_run: 0 };
    for (const k of ["db", "db429", "vbb", "motis", "ai", "runs", "checks"]) o[k] += x[k] || 0;
    o.trips_max = Math.max(o.trips_max, x.trips || 0); if (x.runs) { o.db_max_run = Math.max(o.db_max_run, x.db || 0); o.last_at = new Date().toISOString(); } MEM.rb_stats.set(x.hour, o); return; }
  await rest(env, "rpc/rb_stats_add", { method: "POST", body: JSON.stringify({ p_hour: x.hour, p_db: x.db || 0, p_db429: x.db429 || 0, p_vbb: x.vbb || 0, p_motis: x.motis || 0, p_ai: x.ai || 0, p_runs: x.runs || 0, p_checks: x.checks || 0, p_trips: x.trips || 0 }) });
}
// Konto wirklich genutzt (erste Fahrt, Favorit, Ort, Mitteilungen …) – für die Zahl „echte Nutzer“
export async function markUsed(env, accountId) {
  if (!accountId) return;
  if (mem(env)) { const a = MEM.rb_accounts.get(accountId); if (a && !a.used_at) a.used_at = new Date().toISOString(); return; }
  await rest(env, `rb_accounts?id=eq.${accountId}&used_at=is.null`, { method: "PATCH", body: JSON.stringify({ used_at: new Date().toISOString() }) }).catch(() => {});
}
export async function statsEv(env, hour, ev) {
  if (mem(env)) { const o = MEM.rb_stats.get(hour) || { hour, db: 0, db429: 0, vbb: 0, motis: 0, ai: 0, runs: 0, checks: 0, trips_max: 0, db_max_run: 0 };
    o.ev = { ...(o.ev || {}) }; for (const [k, v] of Object.entries(ev)) o.ev[k] = (o.ev[k] || 0) + v; MEM.rb_stats.set(hour, o); return; }
  await rest(env, "rpc/rb_stats_ev", { method: "POST", body: JSON.stringify({ p_hour: hour, p_ev: ev }) });
}
export async function statsSince(env, sinceIso) {
  if (mem(env)) return [...MEM.rb_stats.values()].filter(r => r.hour >= sinceIso).sort((a, b) => (a.hour < b.hour ? 1 : -1));
  return rest(env, `rb_stats?hour=gte.${encodeURIComponent(sinceIso)}&order=hour.desc&limit=1000`);
}

// Zähler gegen Durchprobieren: true = erlaubt (höchstens max Versuche je sec Sekunden)
export async function guard(env, key, sec, max) {
  if (mem(env)) { const g = MEM.rb_guard.get(key), t = Date.now();
    const cur = !g || t - g.t > sec * 1000 ? { n: 1, t } : { n: g.n + 1, t: g.t }; MEM.rb_guard.set(key, cur); return cur.n <= max; }
  return (await rest(env, "rpc/rb_guard_hit", { method: "POST", body: JSON.stringify({ p_key: key, p_sec: sec, p_max: max }) })) !== false;
}

// Überblick für die Betreiber-Seite: Nutzer, Geräte, Fahrten, gebremste Versuche
export async function overview(env) {
  if (mem(env)) { const d = [...MEM.rb_devices.values()], wk = Date.now() - 7 * 864e5, tr = [...MEM.rb_trips.values()], ro = [...MEM.rb_routines.values()];
    const seen = ms => d.filter(x => Date.parse(x.last_seen || x.created_at) > Date.now() - ms).length;
    return { accounts: MEM.rb_accounts.size, devices: d.length, devices_7d: d.filter(x => Date.parse(x.last_seen || x.created_at) > wk).length, devices_new_7d: d.filter(x => Date.parse(x.created_at) > wk).length,
      active_1h: seen(75 * 60e3), active_24h: seen(864e5), active_30d: seen(30 * 864e5), multi: 0, acc_active_7d: new Set(d.filter(x => Date.parse(x.last_seen || x.created_at) > wk).map(x => x.account_id)).size,
      devices_new_30d: d.length, ret_base: 0, ret_kept: 0, app: d.filter(x => x.app).length, last_run: [...MEM.rb_stats.values()].map(r => r.last_at).filter(Boolean).sort().pop() || null,
      push: d.filter(x => x.push).length, trips_active: tr.filter(t => t.active).length, trips_all: tr.length, routines: ro.length, routines_active: ro.filter(r => !r.paused).length,
      guard: [...MEM.rb_guard.entries()].filter(([, g]) => g.n > 5).map(([key, g]) => ({ key, n: g.n, t: new Date(g.t).toISOString() })) }; }
  return rest(env, "rpc/rb_overview", { method: "POST", body: "{}" });
}
