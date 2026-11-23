// Speicher: Supabase (PlanFlink-Projekt, Tabellen rb_devices / rb_trips) über REST mit dem Secret Key.
// Mit MOCK=1 ein Speicher im Arbeitsspeicher (nur für lokale Tests).

const MEM = { rb_devices: new Map(), rb_trips: new Map() };

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
export async function tripsOf(env, deviceId) {
  if (mem(env)) return [...MEM.rb_trips.values()].filter(t => t.device_id === deviceId && t.active).sort((a, b) => a.created_at < b.created_at ? 1 : -1);
  return rest(env, `rb_trips?device_id=eq.${deviceId}&active=eq.true&order=created_at.desc&limit=10`);
}
export async function activeTrips(env) {
  if (mem(env)) return [...MEM.rb_trips.values()].filter(t => t.active);
  return rest(env, "rb_trips?active=eq.true&order=created_at.asc&limit=200");
}
export async function devicesByIds(env, ids) {
  if (!ids.length) return [];
  if (mem(env)) return ids.map(id => MEM.rb_devices.get(id)).filter(Boolean);
  return rest(env, `rb_devices?id=in.(${ids.join(",")})&select=id,push`);
}
// Aufräumen: beendete Reisen nach 24 Std., Geräte ohne Lebenszeichen nach 60 Tagen
export async function cleanup(env) {
  const day = new Date(Date.now() - 864e5).toISOString(), old = new Date(Date.now() - 60 * 864e5).toISOString();
  if (mem(env)) { for (const [id, t] of MEM.rb_trips) if (!t.active && t.ends_at < day) MEM.rb_trips.delete(id); return; }
  await rest(env, `rb_trips?active=eq.false&ends_at=lt.${day}`, { method: "DELETE" });
  await rest(env, `rb_devices?last_seen=lt.${old}`, { method: "DELETE" });
}
