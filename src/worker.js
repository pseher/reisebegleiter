// Reisebegleiter – Worker: Schnittstelle für die App (/api/*) und Überwachung per Cron
import * as db from "./db.js";
import { searchStations } from "./stations.js";
import { board, findJourney, isoBerlin, rawBoard, WINDOW_MIN } from "./openboards.js";
import { evaluate, altText } from "./engine.js";
import { runMonitor, dueChecks, observe, assess, deliver } from "./monitor.js";
import { vapid, b64u } from "./push.js";

const MIN = 60e3;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const fail = (status, error) => json({ error }, status);
const sha = async s => b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

// Gerät per „Bearer <id>.<schlüssel>“ prüfen
async function device(env, req) {
  const m = /^Bearer ([0-9a-f-]{36})\.([\w-]{20,})$/i.exec(req.headers.get("Authorization") || "");
  if (!m) return null;
  const d = await db.get(env, "rb_devices", m[1]);
  if (!d || d.token_hash !== await sha(m[2])) return null;
  return d;
}

const ownTrip = async (env, dev, id) => { const t = await db.get(env, "rb_trips", id); return t && t.device_id === dev.id ? t : null; };

// Anzeige-Daten einer Reise
function view(trip, now = Date.now()) {
  const v = evaluate(trip, now), st = trip.state || {};
  const nextK = v.transfers.findIndex(t => t.status === "RISK" || t.status === "LOST");
  if (nextK >= 0 && st.alt?.[nextK]?.length) v.sub = v.sub.replace(" Ich behalte das im Blick.", "") + altText(st.alt[nextK]);
  return { id: trip.id, ticket: trip.ticket, created_at: trip.created_at, active: trip.active, checkedAt: st.at || null,
    status: v.status, phase: v.phase, title: v.title, sub: v.sub, zbLifted: v.zbLifted, finalDelay: v.finalDelay, current: v.current,
    legs: v.legs.map(l => ({ ...l, dep: { ...l.dep, plan: iso(l.dep.plan), rt: iso(l.dep.rt) }, arr: { ...l.arr, plan: iso(l.arr.plan), rt: iso(l.arr.rt) } })),
    transfers: v.transfers.map((t, k) => ({ ...t, arrRt: iso(t.arrRt), depRt: iso(t.depRt), alt: st.alt?.[k] || [] })) };
}
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// Abfahrten an einem Bahnhof (für die Zugauswahl), zwei 30-Min.-Fenster
async function departures(env, eva, fromMs) {
  const cache = new Map(), seen = new Set(), out = [];
  for (let w = 0; w < 2; w++) {
    const list = await board(env, "dep", eva, isoBerlin(fromMs + w * WINDOW_MIN * MIN), { maxVia: 40, cache });
    for (const e of list) {
      if (seen.has(e.jid) || Date.parse(e.rt) < fromMs - 2 * MIN) continue;
      seen.add(e.jid); out.push(e);
    }
  }
  return out.sort((a, b) => Date.parse(a.rt) - Date.parse(b.rt));
}

function validLeg(l) {
  const ok = s => s && /^\d{6,9}$/.test(String(s.eva)) && typeof s.name === "string" && !Number.isNaN(Date.parse(s.plan));
  return l && typeof l.jid === "string" && l.jid && typeof l.label === "string" && ok(l.from) && ok(l.to) && Date.parse(l.to.plan) > Date.parse(l.from.plan);
}
const cleanLeg = l => ({ jid: l.jid, label: l.label.slice(0, 40),
  from: { eva: String(l.from.eva), name: l.from.name.slice(0, 80), plan: l.from.plan, platform: String(l.from.platform || "").slice(0, 8) },
  to: { eva: String(l.to.eva), name: l.to.name.slice(0, 80), plan: l.to.plan, platform: String(l.to.platform || "").slice(0, 8) } });

async function api(req, env, url) {
  const p = url.pathname, method = req.method;

  if (p === "/api/config") { const v = await vapid(env).catch(() => null); return json({ vapid: v?.pub || null, mock: env.MOCK === "1" }); }

  if (p === "/api/register" && method === "POST") {
    const token = b64u(crypto.getRandomValues(new Uint8Array(24)));
    const d = await db.insert(env, "rb_devices", { token_hash: await sha(token) });
    return json({ id: d.id, token });
  }

  // Nur lokal: Cron sofort auslösen
  if (p === "/api/mock/tick" && env.MOCK === "1") return json(await runMonitor(env, Date.now() + (+url.searchParams.get("plus") || 0) * MIN));

  const dev = await device(env, req);
  if (!dev) return fail(401, "Gerät unbekannt");

  if (p === "/api/stations") return json(await searchStations(env, url.searchParams.get("q")));

  if (p === "/api/departures") {
    const eva = url.searchParams.get("eva"), t = Date.parse(url.searchParams.get("time") || "") || Date.now();
    if (!/^\d{6,9}$/.test(eva || "")) return fail(400, "Bahnhof fehlt");
    return json(await departures(env, eva, t));
  }

  // Ankunft eines gewählten Zugs am Ausstiegsbahnhof ermitteln → fertige Teilstrecke
  if (p === "/api/leg" && method === "POST") {
    const b = await req.json().catch(() => ({}));
    if (!b.jid || !/^\d{6,9}$/.test(b.toEva || "") || !b.from?.plan) return fail(400, "Angaben unvollständig");
    const start = Date.parse(b.from.plan) + 10 * MIN;
    const hit = await findJourney(env, "arr", b.toEva, b.jid, start, { windows: 12 });
    if (!hit) return fail(404, "Ankunft dieses Zugs am gewählten Bahnhof nicht gefunden");
    return json({ jid: b.jid, label: b.label, from: b.from,
      to: { eva: b.toEva, name: hit.name || b.toName || "", plan: hit.plan, platform: hit.platformPlan || hit.platform } });
  }

  if (p === "/api/trips" && method === "GET") {
    const now = Date.now(), trips = await db.tripsOf(env, dev.id), cache = new Map();
    // Nur fällige Abfragen nachholen, damit die Anzeige frisch ist (Meldungen verschickt nur der Cron)
    const checks = trips.flatMap(t => dueChecks(t, now)).slice(0, 6);
    if (checks.length) { await observe(env, checks, now, cache); for (const t of trips) if (t._dirty) await db.update(env, "rb_trips", t.id, { obs: t.obs, updated_at: new Date().toISOString() }); }
    if (Date.parse(dev.last_seen || 0) < now - 3600e3) await db.update(env, "rb_devices", dev.id, { last_seen: new Date().toISOString() }).catch(() => {});
    return json(trips.map(t => view(t, now)));
  }

  if (p === "/api/trips" && method === "POST") {
    const b = await req.json().catch(() => ({}));
    const legs = Array.isArray(b.legs) ? b.legs : [];
    if (!legs.length || legs.length > 6 || !legs.every(validLeg)) return fail(400, "Reise ungültig");
    if (legs.some((l, i) => i > 0 && Date.parse(l.from.plan) < Date.parse(legs[i - 1].to.plan) - MIN)) return fail(400, "Anschluss fährt vor der Ankunft ab");
    const ticket = ["spar", "flex", "dticket", "bc100"].includes(b.ticket) ? b.ticket : "flex";
    const clean = legs.map(cleanLeg);
    const trip = await db.insert(env, "rb_trips", { device_id: dev.id, ticket, legs: clean, obs: [], state: {}, active: true, ends_at: clean[clean.length - 1].to.plan });
    const now = Date.now(), cache = new Map();
    await observe(env, dueChecks(trip, now, true).slice(0, 8), now, cache);
    await assess(env, trip, now, cache);
    trip.state = { ...trip.state, rem: {}, start: null };          // Meldungen beginnen mit dem ersten Cron-Lauf
    await db.update(env, "rb_trips", trip.id, { obs: trip.obs, state: trip.state });
    return json(view(trip, now), 201);
  }

  const m = /^\/api\/trips\/([0-9a-f-]{36})$/i.exec(p);
  if (m) {
    const t = await ownTrip(env, dev, m[1]);
    if (!t) return fail(404, "Reise nicht gefunden");
    if (method === "DELETE") { await db.remove(env, "rb_trips", t.id); return json({ ok: true }); }
    if (method === "PATCH") {
      const b = await req.json().catch(() => ({}));
      if (["spar", "flex", "dticket", "bc100"].includes(b.ticket)) await db.update(env, "rb_trips", t.id, { ticket: b.ticket });
      return json({ ok: true });
    }
  }

  if (p === "/api/push" && method === "POST") {
    const b = await req.json().catch(() => ({}));
    if (!b?.endpoint || !/^https:\/\//.test(b.endpoint) || !b.keys?.p256dh || !b.keys?.auth) return fail(400, "Abo ungültig");
    await db.update(env, "rb_devices", dev.id, { push: { endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth } } });
    return json({ ok: true });
  }
  if (p === "/api/push" && method === "DELETE") { await db.update(env, "rb_devices", dev.id, { push: null }); return json({ ok: true }); }
  if (p === "/api/push/test" && method === "POST") {
    if (!dev.push) return fail(400, "Mitteilungen auf diesem Gerät nicht eingeschaltet");
    const st = await deliver(env, dev.push, { title: "🔔 Test vom Reisebegleiter", body: "So sehen deine Meldungen unterwegs aus.", tag: "test", url: "/", urgent: true });
    return json({ ok: st >= 200 && st < 300, status: st });
  }

  // Fehlersuche: Rohantwort von OpenBoards ansehen
  if (p === "/api/debug/board") {
    const eva = url.searchParams.get("eva"), kind = url.searchParams.get("kind") === "arr" ? "arr" : "dep";
    if (!/^\d{6,9}$/.test(eva || "")) return fail(400, "eva fehlt");
    return json(await rawBoard(env, kind, eva, isoBerlin(Date.parse(url.searchParams.get("time") || "") || Date.now()), 10));
  }

  return fail(404, "Unbekannte Adresse");
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(req, env, url); }
      catch (e) { console.log("API-Fehler:", e.stack || e.message); return fail(502, e.message || "Fehler"); }
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runMonitor(env).then(r => console.log("Lauf:", JSON.stringify(r))).catch(e => console.log("Cron-Fehler:", e.stack || e.message)));
  },
};
