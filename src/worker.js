// Reisebegleiter – Worker: Schnittstelle für die App (/api/*) und Überwachung per Cron
import * as db from "./db.js";
import { searchStations } from "./stations.js";
import { connections, resolveConnection } from "./routing.js";
import { board, findJourney, isoBerlin, rawBoard, normalize, WINDOW_MIN } from "./openboards.js";
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
  const ok = s => s && (l.jid ? /^\d{6,9}$/.test(String(s.eva)) : true) && typeof s.name === "string" && !Number.isNaN(Date.parse(s.plan));
  return l && typeof l.jid === "string" && typeof l.label === "string" && ok(l.from) && ok(l.to) && Date.parse(l.to.plan) > Date.parse(l.from.plan);
}
const cleanLeg = l => ({ jid: l.jid, label: l.label.slice(0, 40), mode: String(l.mode || "").slice(0, 20), walk: Math.min(60, Math.max(0, +l.walk || 0)),
  from: { eva: String(l.from.eva), name: l.from.name.slice(0, 80), plan: l.from.plan, platform: String(l.from.platform || "").slice(0, 8) },
  to: { eva: String(l.to.eva), name: l.to.name.slice(0, 80), plan: l.to.plan, platform: String(l.to.platform || "").slice(0, 8) } });

async function api(req, env, url) {
  const p = url.pathname, method = req.method;

  if (p === "/api/config") { const v = await vapid(env).catch(() => null); return json({ vapid: v?.pub || null, mock: env.MOCK === "1" }); }

  // Diagnose (ohne Gerät): Version und eine Testabfrage an OpenBoards – zeigt keine Schlüssel
  if (p === "/api/health") {
    const out = { version: "stationsliste", dbKeys: !!(env.DB_CLIENT_ID && env.DB_API_KEY), supabase: !!env.SUPABASE_SERVICE_KEY, vapid: !!env.VAPID_JWK };
    if (url.searchParams.get("probe") === "1" && out.dbKeys) {
            out.stations = (await searchStations(env, "München")).slice(0, 2).map(x => `${x.name} ${x.eva}`).join(", ");
      try { const d = await rawBoard(env, "dep", "8000261", isoBerlin(Date.now()), 1); out.openboards = `ok: ${(d.departures || []).length} Abfahrten`; }
      catch (e) { out.openboards = e.message; }
    }
    // Verbindungssuche mit echten Daten: ?route=Start>Ziel
    const rq = url.searchParams.get("route");
    if (rq && rq.includes(">")) {
      const [a, b] = rq.split(">"), [sa] = await searchStations(env, a), [sb] = await searchStations(env, b);
      out.route = { from: sa, to: sb };
      try {
        const cs = await connections(env, sa.eva, sb.eva, Date.now());
        out.connections = cs.slice(0, 4).map(c => `${c.dep} ${c.transfers} Umst.: ${c.legs.map(l => `${l.label} [${l.mode}] ${l.from.name}→${l.to.name}`).join(" | ")}`);
        if (cs[0]) out.resolved = (await resolveConnection(env, cs[0].legs)).map(l => `${l.label} jid=${l.jid ? "ok" : "–"} ${l.from.name}(${l.from.eva}) ${l.from.plan} Gl.${l.from.platform} → ${l.to.name}(${l.to.eva}) ${l.to.plan}`);
      } catch (e) { out.routeError = e.message; }
    }
    // Ablauf „Zug wählen → Ankunft am Ausstieg suchen“ mit echten Daten: ?from=Name&to=Name
    const fq = url.searchParams.get("from"), tq = url.searchParams.get("to");
    if (fq && tq && out.dbKeys) {
      const [from] = await searchStations(env, fq), [to] = await searchStations(env, tq);
      out.from = from; out.to = to;
      if (from && to) {
        const deps = await departures(env, from.eva, Date.now());
        const hit = deps.find(e => e.via.some(v => v.eva === to.eva) || e.direction.some(d => d.eva === to.eva));
        const viaNamed = deps.find(e => e.via.some(v => v.name && v.name.toLowerCase().includes(tq.toLowerCase())));
        out.train = hit ? { label: hit.label, jid: hit.jid, plan: hit.plan, via: hit.via.map(v => `${v.name}=${v.eva}`).join(" | ") } : null;
        if (!hit && viaNamed) out.trainByName = { label: viaNamed.label, jid: viaNamed.jid, via: viaNamed.via.map(v => `${v.name}=${v.eva}`).join(" | ") };
        const t = hit || viaNamed;
        if (t) {
          const viaEva = (t.via.find(v => v.eva === to.eva) || t.via.find(v => v.name.toLowerCase().includes(tq.toLowerCase())) || {}).eva || to.eva;
          out.arrEva = viaEva;
          const start = Date.parse(t.plan);
          for (let w = 0; w < 3; w++) {
            const raw = await rawBoard(env, "arr", viaEva, isoBerlin(start + w * 25 * MIN), 2);
            const list = normalize(raw, "arr");
            out[`arr window ${w}`] = { keys: Object.keys(raw).join(","), count: list.length, considered: raw.meta?.consideredStopPlaces?.slice(0, 12),
              match: list.find(x => x.jid === t.jid) ? "JA" : "nein",
              sample: list.filter(x => x.label === t.label).slice(0, 4).map(x => `${x.label} ${x.jid} ${x.plan}`) };
          }
        }
      }
    }
    return json(out);
  }

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

  // Verbindungssuche Von → Nach
  if (p === "/api/connections") {
    const from = url.searchParams.get("from"), to = url.searchParams.get("to");
    if (!/^\d{6,9}$/.test(from || "") || !/^\d{6,9}$/.test(to || "")) return fail(400, "Start oder Ziel fehlt");
    const t = Date.parse((url.searchParams.get("time") || "").replace(" ", "+")) || Date.now();
    return json(await connections(env, from, to, t));
  }
  // Gewählte Verbindung → Teilstrecken mit DB-Fahrtkennungen
  if (p === "/api/resolve" && method === "POST") {
    const b = await req.json().catch(() => ({}));
    if (!Array.isArray(b.legs) || !b.legs.length) return fail(400, "Verbindung fehlt");
    return json(await resolveConnection(env, b.legs));
  }

  // Ankunft eines gewählten Zugs am Ausstiegsbahnhof ermitteln → fertige Teilstrecke
  if (p === "/api/leg" && method === "POST") {
    const b = await req.json().catch(() => ({}));
    if (!b.jid || !/^\d{6,9}$/.test(b.toEva || "") || !b.from?.plan) return fail(400, "Angaben unvollständig");
    const start = Date.parse(b.from.plan) + 10 * MIN;
    const hit = await findJourney(env, "arr", b.toEva, b.jid, start, { windows: 12, label: b.label, after: Date.parse(b.from.plan) });
    if (!hit) return fail(404, b.onRoute === false
      ? `${b.label} hält laut Fahrplan nicht in ${b.toName || "diesem Bahnhof"}. Wähle einen Halt aus der Liste und füge danach einen Umstieg hinzu.`
      : `Die Ankunft von ${b.label} in ${b.toName || "diesem Bahnhof"} wurde nicht gefunden. Bitte einen anderen Halt wählen oder es gleich noch einmal versuchen.`);
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
