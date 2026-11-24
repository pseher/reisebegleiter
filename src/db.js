// Speicher: Supabase (PlanFlink-Projekt, Tabellen rb_devices / rb_trips) über REST mit dem Secret Key.
// Mit MOCK=1 ein Speicher im Arbeitsspeicher (nur für lokale Tests).

const MEM = { rb_devices: new Map(), rb_trips: new Map(), rb_accounts: new Map() };

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
    MEM.rb_accounts.delete(from); return;
  }
  await rest(env, `rb_trips?account_id=eq.${from}`, { method: "PATCH", body: JSON.stringify({ account_id: to }) });
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
  if (mem(env)) { for (const [id, t] of MEM.rb_trips) if (!t.active && t.ends_at < day) MEM.rb_trips.delete(id); return; }
  await rest(env, `rb_trips?active=eq.false&ends_at=lt.${day}`, { method: "DELETE" });
  await rest(env, `rb_devices?last_seen=lt.${old}`, { method: "DELETE" });
  // Konten ohne Geräte (alle entfernt oder lange unbenutzt) samt Reisen löschen
  // (zusätzlich hier prüfen, dass wirklich kein Gerät mehr dranhängt)
  const orphans = (await rest(env, "rb_accounts?select=id,rb_devices(id)&rb_devices=is.null&limit=200").catch(() => []) || [])
    .filter(o => Array.isArray(o.rb_devices) && o.rb_devices.length === 0);
  if (orphans.length) await rest(env, `rb_accounts?id=in.(${orphans.map(o => o.id).join(",")})`, { method: "DELETE" });
}
