// Verbindungssuche, Haltestellen und Fahrtverläufe: eigener MOTIS-Server zuerst, Transitous als Notlösung.
//
// Einstellungen (Cloudflare-Dashboard, Worker „reisebegleiter“):
//   MOTIS_URL      Adresse des eigenen Servers, z. B. https://motis.umstiegsheld.de  (fehlt = nur Transitous wie bisher)
//   MOTIS_ID       Cloudflare-Access Service-Token: Client-ID      (geheim)
//   MOTIS_SECRET   Cloudflare-Access Service-Token: Client-Secret  (geheim)
//   MOTIS_MODE     "test" = Testlauf: Nutzer sehen Transitous, der eigene Server wird nur mitgefragt und verglichen
//                  "on"   = eigener Server ist Hauptquelle (Standard, sobald MOTIS_URL gesetzt ist)
//   OPS_KEY        Kennwort, mit dem der Server seine nächtlichen Importe meldet (geheim)
//   OPS_ACCOUNT    Konto-ID des Betreibers – bekommt Mitteilungen bei Ausfall und Rückkehr
//
// Fällt der eigene Server aus: höchstens OWN_MS warten, dann Transitous. Nach FAILS Fehlern in Folge
// PAUSE_MS lang gar nicht mehr fragen (spart Wartezeit), danach wieder probieren.
import { count } from "./stats.js";
import * as db from "./db.js";

export const PUBLIC = "https://api.transitous.org";
export const UA = "Umstiegsheld/1.0 (+https://umstiegsheld.de; kontakt@umstiegsheld.de)";
const OWN_MS = 4000, FAILS = 3, PAUSE_MS = 5 * 60e3;
const ST = { fails: 0, pauseUntil: 0 };
export const _resetForTests = () => { ST.fails = 0; ST.pauseUntil = 0; };

export const ownOn = env => !!env.MOTIS_URL && env.MOCK !== "1";
const mode = env => (!ownOn(env) ? "off" : env.MOTIS_MODE === "test" ? "test" : "on");
const ownHeaders = env => ({ "User-Agent": UA, Accept: "application/json", ...(env.MOTIS_ID ? { "CF-Access-Client-Id": env.MOTIS_ID, "CF-Access-Client-Secret": env.MOTIS_SECRET || "" } : {}) });
const pubInit = ms => ({ signal: AbortSignal.timeout(ms), headers: { "User-Agent": UA, Accept: "application/json" } });

function failed(why) {
  ST.fails++; count("own_fail"); count(`own_fail_${why}`);
  if (ST.fails >= FAILS) { ST.pauseUntil = Date.now() + PAUSE_MS; ST.fails = 0; count("own_pause"); }
}
async function askOwn(env, pathQs) {
  try {
    const r = await fetch(env.MOTIS_URL.replace(/\/$/, "") + pathQs, { signal: AbortSignal.timeout(OWN_MS), headers: ownHeaders(env) });
    if (r.ok) { ST.fails = 0; count("own_ok"); return r; }
    // 404 = diese Fahrt/Version kennt der eigene Server nicht (andere Kennungen als Transitous) – kein Ausfall
    if (r.status === 404 || r.status === 400) { ST.fails = 0; count("own_miss"); return r; }
    failed(r.status === 401 || r.status === 403 ? "auth" : "http");
  } catch (e) { failed(e?.name === "TimeoutError" || e?.name === "AbortError" ? "slow" : "net"); }
  return null;
}

// Grobe Gleichheit zweier Antworten für den Testlauf (nur Zähler, keine Inhalte)
function sameish(path, a, b) {
  try {
    if (/plan/.test(path)) { const f = x => (x.itineraries || []).map(i => `${i.startTime}|${i.endTime}`); const A = f(a), B = new Set(f(b)); return A.length && A.filter(x => B.has(x)).length >= Math.ceil(A.length / 2); }
    if (/geocode/.test(path)) { const f = x => (Array.isArray(x) ? x : []).slice(0, 3).map(m => m.name); const B = f(b); return f(a).some(n => B.includes(n)); }
    if (/trip/.test(path)) return (a.legs || []).length === (b.legs || []).length;
  } catch {}
  return false;
}

// Eine Abfrage an MOTIS (Pfad samt Version und Query, z. B. "/api/v5/plan?…"). Liefert eine Response oder null.
export async function transitFetch(env, pathQs, ms = 12000) {
  const m = mode(env);
  if (m === "on" && Date.now() >= ST.pauseUntil) {
    const r = await askOwn(env, pathQs);
    if (r && r.ok) return r;
    count("own_fallback");   // nicht erreichbar oder Fahrt dort unbekannt → Transitous
  } else if (m === "on") count("own_paused");
  if (m === "test" && Date.now() >= ST.pauseUntil) {
    const [pub, own] = await Promise.all([fetch(PUBLIC + pathQs, pubInit(ms)).catch(() => null), askOwn(env, pathQs)]);
    if (pub?.ok && own?.ok) {
      const [a, b] = await Promise.all([pub.clone().json().catch(() => null), own.json().catch(() => null)]);
      if (a && b) count(sameish(pathQs.split("?")[0], a, b) ? "cmp_same" : "cmp_diff");
    } else if (pub?.ok) count("cmp_ownmiss");
    return pub;
  }
  return fetch(PUBLIC + pathQs, pubInit(ms)).catch(() => null);
}

// ---------- Betriebszustand (Tabelle rb_ops, Schlüssel "motis") ----------
const opsGet = env => db.opsGet(env, "motis"), opsSet = (env, v) => db.opsSet(env, "motis", v);
export const opsState = env => opsGet(env).catch(() => ({}));

// Jede Minute aus dem Prüflauf: antwortet der eigene Server? Nach 5 Min. Ausfall eine Mitteilung, bei Rückkehr wieder.
// notify(title, body) schickt an den Betreiber (OPS_ACCOUNT); fehlt das, wird nur gezählt.
export async function healthCheck(env, notify, now = Date.now()) {
  if (!ownOn(env)) return null;
  let ok = false, ms = 0;
  const t0 = Date.now();
  try { const r = await fetch(env.MOTIS_URL.replace(/\/$/, "") + `/api/v1/geocode?text=${encodeURIComponent("Berlin Hbf")}&type=STOP`, { signal: AbortSignal.timeout(8000), headers: ownHeaders(env) }); ok = r.ok; } catch {}
  ms = Date.now() - t0; count(ok ? "own_up" : "own_down");
  const s = await opsGet(env), was = s.up !== false;
  const next = { ...s, mode: mode(env), checkedAt: new Date(now).toISOString(), ms };
  if (ok) {
    if (!was && s.downNotified) await notify("✅ Eigener Server wieder da", `Der MOTIS-Server antwortet wieder (nach ${Math.round((now - Date.parse(s.downSince)) / 60e3)} Min.).`).catch(() => {});
    Object.assign(next, { up: true, lastOk: next.checkedAt, downSince: null, downNotified: false });
  } else {
    const since = was ? next.checkedAt : s.downSince || next.checkedAt;
    Object.assign(next, { up: false, downSince: since });
    if (!s.downNotified && now - Date.parse(since) >= 5 * 60e3) {
      await notify("⚠️ Eigener Server antwortet nicht", "Seit über 5 Minuten keine Antwort vom MOTIS-Server. Die App weicht auf Transitous aus – Nutzer merken nichts. Ein Neustart über das OVH-Kundenportal hilft meist.").catch(() => {});
      next.downNotified = true;
    }
  }
  await opsSet(env, next);
  return next;
}

// Meldung des Servers nach einem Import (POST /api/ops/motis mit OPS_KEY)
export async function importReport(env, b) {
  const s = await opsGet(env);
  const imp = { at: new Date().toISOString(), ok: !!b.ok, what: String(b.what || "fahrplan").slice(0, 20), feed: String(b.feed || "").slice(0, 40), secs: +b.secs || 0, msg: String(b.msg || "").slice(0, 200) };
  await opsSet(env, { ...s, lastImport: imp, ...(imp.ok ? { [`ok_${imp.what}`]: imp.at } : {}) });
  count(imp.ok ? "own_import_ok" : "own_import_fail");
  return imp;
}
