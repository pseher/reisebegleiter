// Reisebegleiter – Worker: Schnittstelle für die App (/api/*) und Überwachung per Cron
import * as db from "./db.js";
import { searchStations, byEva } from "./stations.js";
import { connections, resolveConnection, geocodeStop } from "./routing.js";
import { importTrip } from "./importer.js";
import { board, findJourney, isoBerlin, rawBoard, normalize, WINDOW_MIN } from "./openboards.js";
import { evaluate } from "./engine.js";
import { runMonitor, dueChecks, observe, assess, deliver, adopt, undoAdopt, planFromHere } from "./monitor.js";
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

// Fehlende Koordinaten von DB-Bahnhöfen aus der Stationsliste ergänzen (auch für ältere Reisen)
const withCoords = s => { if (s.lat != null || !s.eva) return s; const b = byEva(s.eva); return b ? { ...s, lat: b.lat, lon: b.lon } : s; };
// Anzeige-Daten einer Reise
function view(trip, now = Date.now()) {
  trip = { ...trip, legs: trip.legs.map(l => ({ ...l, from: withCoords(l.from), to: withCoords(l.to) })) };
  const v = evaluate(trip, now), st = trip.state || {};
  const open = v.transfers.filter(t => t.status !== "DONE");
  const current = { dep: iso(v.legs[0].dep.rt), arr: iso(v.legs[v.legs.length - 1].arr.rt), transfers: v.transfers.length,
    minGap: open.length ? Math.min(...open.map(t => t.gap)) : null, label: v.legs.map(l => l.label).join(" → ") };
  const canUndo = !!st.undo?.legs?.length && now - (st.undo.at || 0) < 3 * 3600e3 && v.phase !== "done";
  const here = st.here && now - st.here.at < 30 * MIN ? st.here : null;          // Standort-Ergebnisse sind nur kurz gültig
  return { id: trip.id, ticket: trip.ticket, plan: current, canUndo, here, planArr: iso(v.legs[v.legs.length - 1].arr.plan), minT: +trip.legs[0]?.minT || 0, created_at: trip.created_at, active: trip.active, checkedAt: st.at || null,
    status: v.status, phase: v.phase, title: v.title, sub: v.sub, next: v.next ? { ...v.next, at: iso(v.next.at), plan: iso(v.next.plan), then: v.next.then ? { ...v.next.then, at: iso(v.next.then.at) } : null } : null, zbLifted: v.zbLifted, finalDelay: v.finalDelay, current: v.current,
    legs: v.legs.map(l => ({ ...l, dep: { ...l.dep, plan: iso(l.dep.plan), rt: iso(l.dep.rt) }, arr: { ...l.arr, plan: iso(l.arr.plan), rt: iso(l.arr.rt) } })),
    transfers: v.transfers.map((t, k) => ({ ...t, arrRt: iso(t.arrRt), depRt: iso(t.depRt), alt: st.alt?.[k] || [], altChecked: !!st.altAt?.[k] })) };
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
const coord = s => (Number.isFinite(+s.lat) && Number.isFinite(+s.lon) && s.lat != null ? { lat: +(+s.lat).toFixed(5), lon: +(+s.lon).toFixed(5) } : {});
const cleanLeg = l => ({ jid: l.jid, label: l.label.slice(0, 40), mode: String(l.mode || "").slice(0, 20), walk: Math.min(60, Math.max(0, +l.walk || 0)), minT: Math.min(30, Math.max(0, +l.minT || 0)),
  from: { eva: String(l.from.eva || ""), name: l.from.name.slice(0, 80), plan: l.from.plan, platform: String(l.from.platform || "").slice(0, 8), ...coord(l.from) },
  to: { eva: String(l.to.eva || ""), name: l.to.name.slice(0, 80), plan: l.to.plan, platform: String(l.to.platform || "").slice(0, 8), ...coord(l.to), ...(l.to.estimated ? { estimated: true } : {}) }, ...(l.must ? { must: true } : {}) });

// Prüfung neuer Teilstrecken (Anlegen und Ändern)
function checkLegs(legs) {
  if (!legs.length || legs.length > 6 || !legs.every(validLeg)) return "Reise ungültig";
  if (legs.some((l, i) => i > 0 && Date.parse(l.from.plan) < Date.parse(legs[i - 1].to.plan) - MIN)) return "Anschluss fährt vor der Ankunft ab";
  if (Date.parse(legs[legs.length - 1].to.plan) < Date.now() - 30 * MIN) return "Diese Fahrt ist schon vorbei. Bitte prüfe Datum und Uhrzeit.";
  return "";
}

async function api(req, env, url) {
  const p = url.pathname, method = req.method;

  if (p === "/api/config") { const v = await vapid(env).catch(() => null); return json({ vapid: v?.pub || null, mock: env.MOCK === "1" }); }

  // Diagnose (ohne Gerät): Version und eine Testabfrage an OpenBoards – zeigt keine Schlüssel
  if (p === "/api/health") {
    const diag = env.MOCK === "1" || (env.DIAG_KEY && url.searchParams.get("key") === env.DIAG_KEY);
    if (!diag) return json({ ok: true });
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
  // plus=N verschiebt auch die Testdaten (Verspätungen/Ausfälle gelten dann für diese Uhrzeit)
  if (p === "/api/mock/tick" && env.MOCK === "1") { const sh = (+url.searchParams.get("plus") || 0) * MIN; globalThis.RB_MOCK_SHIFT = sh; return json(await runMonitor(env, Date.now() + sh)); }

  const dev = await device(env, req);
  if (!dev) return fail(401, "Gerät unbekannt");

  if (p === "/api/stations") return json(await searchStations(env, url.searchParams.get("q")));

  if (p === "/api/departures") {
    const eva = url.searchParams.get("eva"), t = Date.parse(url.searchParams.get("time") || "") || Date.now();
    if (!/^\d{6,9}$/.test(eva || "")) return fail(400, "Bahnhof fehlt");
    return json(await departures(env, eva, t));
  }

  // Reise einlesen (Screenshot, PDF, Text/Link) – mit Tageslimit pro Gerät
  if (p === "/api/import" && method === "POST") {
    const b = await req.json().catch(() => ({}));
    const files = (Array.isArray(b.files) ? b.files : []).filter(f => f && typeof f.data === "string" && f.data.length < 7e6).slice(0, 3);
    const text = String(b.text || "").slice(0, 8000);
    if (!files.length && text.trim().length < 10) return fail(400, "Bitte einen Screenshot, ein PDF oder einen Text mit der Verbindung einfügen.");
    const day = new Date().toISOString().slice(0, 10), use = dev.usage?.day === day ? dev.usage.n : 0, limit = +(env.IMPORT_DAILY_LIMIT || 15);
    if (use >= limit) return fail(429, `Heute schon ${limit} Reisen eingelesen. Morgen geht es weiter – oder die Verbindung über „Von / Nach“ suchen.`);
    await db.update(env, "rb_devices", dev.id, { usage: { day, n: use + 1 } }).catch(() => {});   // ohne Spalte „usage“: kein Limit
    return json(await importTrip(env, { text, files }));
  }

  // Verbindungssuche Von → Nach
  if (p === "/api/connections") {
    const from = url.searchParams.get("from"), to = url.searchParams.get("to");
    if (!/^\d{6,9}$/.test(from || "") || !/^\d{6,9}$/.test(to || "")) return fail(400, "Start oder Ziel fehlt");
    const t = Date.parse((url.searchParams.get("time") || "").replace(" ", "+")) || Date.now();
    return json(await connections(env, from, to, t, +url.searchParams.get("min") || 0));
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
    // Halt nicht auf der Strecke des Zugs: gar nicht erst suchen
    if (b.onRoute === false) return fail(400, `${b.label} hält laut Fahrplan nicht in ${b.toName || "diesem Bahnhof"}. Wähle einen Halt aus der Liste – oder suche die ganze Verbindung über „Neue Reise → Von / Nach“.`);
    const start = Date.parse(b.from.plan) + 10 * MIN;
    const hit = await findJourney(env, "arr", b.toEva, b.jid, start, { windows: 14, label: b.label, after: Date.parse(b.from.plan) });   // bis ca. 6 Std. Fahrzeit
    if (!hit) return fail(404, b.onRoute === false
      ? `${b.label} hält laut Fahrplan nicht in ${b.toName || "diesem Bahnhof"}. Wähle einen Halt aus der Liste und füge danach einen Umstieg hinzu.`
      : `Die Ankunft von ${b.label} in ${b.toName || "diesem Bahnhof"} wurde nicht gefunden. Bitte einen anderen Halt wählen oder es gleich noch einmal versuchen.`);
    return json({ jid: b.jid, label: b.label, from: b.from,
      to: { eva: b.toEva, name: hit.name || b.toName || "", plan: hit.plan, platform: hit.platformPlan || hit.platform } });
  }

  if (p === "/api/trips" && method === "GET") {
    const now = Date.now(), trips = await db.tripsOf(env, dev.id), cache = new Map();
    // Einmalig: fehlende Koordinaten von Haltestellen ohne DB-Nummer (Bus/Tram) nachschlagen – für die Fußweg-Navigation
    for (const t of trips) {
      if (t.state?.geo) continue;
      let changed = false;
      for (let i = 0; i < t.legs.length; i++) for (const side of ["from", "to"]) {
        const st = t.legs[i][side];
        if (st.lat != null || (st.eva && byEva(st.eva))) continue;
        const other = withCoords(side === "to" ? (t.legs[i + 1]?.from || t.legs[i].from) : (t.legs[i - 1]?.to || t.legs[i].to));
        const c = await geocodeStop(env, st.name, other.lat != null ? other : null).catch(() => null);
        if (c) { t.legs[i][side] = { ...st, ...c }; changed = true; }
      }
      t.state = { ...(t.state || {}), geo: true };
      await db.update(env, "rb_trips", t.id, { legs: t.legs, state: t.state }).catch(() => {});
    }
    // Nur fällige Abfragen nachholen, damit die Anzeige frisch ist (Meldungen verschickt nur der Cron)
    const checks = trips.flatMap(t => dueChecks(t, now)).slice(0, 6);
    if (checks.length) { await observe(env, checks, now, cache); for (const t of trips) if (t._dirty) await db.update(env, "rb_trips", t.id, { obs: t.obs, updated_at: new Date().toISOString() }); }
    if (Date.parse(dev.last_seen || 0) < now - 3600e3) await db.update(env, "rb_devices", dev.id, { last_seen: new Date().toISOString() }).catch(() => {});
    return json(trips.map(t => view(t, now)));
  }

  if (p === "/api/trips" && method === "POST") {
    const b = await req.json().catch(() => ({}));
    const legs = Array.isArray(b.legs) ? b.legs : [];
    const bad = checkLegs(legs); if (bad) return fail(400, bad);
    const ticket = ["spar", "flex", "dticket", "bc100"].includes(b.ticket) ? b.ticket : "flex";
    const clean = legs.map(cleanLeg);
    const trip = await db.insert(env, "rb_trips", { device_id: dev.id, ticket, legs: clean, obs: [], state: {}, active: true, ends_at: clean[clean.length - 1].to.plan });
    const now = Date.now(), cache = new Map();
    await observe(env, dueChecks(trip, now, true).slice(0, 8), now, cache);
    await assess(env, trip, now, cache);
    // Meldungen beginnen mit dem ersten Cron-Lauf – auch für Gleiswechsel oder Zugbindung, die schon beim Anlegen bestehen
    trip.state = { ...trip.state, rem: {}, start: null, pl: {}, zb: false };
    await db.update(env, "rb_trips", trip.id, { obs: trip.obs, state: trip.state });
    return json(view(trip, now), 201);
  }

  // Alternativen ab dem aktuellen Standort (Koordinaten kommen nur auf Knopfdruck aus der App, werden nicht dauerhaft gespeichert)
  const mh = /^\/api\/trips\/([0-9a-f-]{36})\/here$/i.exec(p);
  if (mh && method === "POST") {
    const t = await ownTrip(env, dev, mh[1]);
    if (!t) return fail(404, "Reise nicht gefunden");
    const b = await req.json().catch(() => ({}));
    const lat = +b.lat, lon = +b.lon;
    if (!(lat > 45 && lat < 56 && lon > 4 && lon < 18)) return fail(400, "Standort liegt außerhalb des Suchgebiets.");
    const now = Date.now(), here = { lat: +lat.toFixed(4), lon: +lon.toFixed(4) };
    const list = await planFromHere(env, t, evaluate(t, now), here, now);
    t.state = { ...(t.state || {}), here: { at: now, list } };
    await db.update(env, "rb_trips", t.id, { state: t.state });
    return json(view(t, now));
  }

  // Plan B übernehmen / zurücknehmen
  const ma = /^\/api\/trips\/([0-9a-f-]{36})\/(adopt|undo)$/i.exec(p);
  if (ma && method === "POST") {
    const t = await ownTrip(env, dev, ma[1]);
    if (!t) return fail(404, "Reise nicht gefunden");
    const b = await req.json().catch(() => ({}));
    if (ma[2] === "undo") undoAdopt(t); else await adopt(env, t, +b.k || 0, +b.idx || 0, !!b.here);
    const now = Date.now(), cache = new Map();
    await observe(env, dueChecks(t, now, true).slice(0, 8), now, cache);
    await assess(env, t, now, cache);
    await db.update(env, "rb_trips", t.id, { legs: t.legs, obs: t.obs, state: t.state, ends_at: t.ends_at, active: true, updated_at: new Date().toISOString() });
    return json(view(t, now));
  }

  const m = /^\/api\/trips\/([0-9a-f-]{36})$/i.exec(p);
  if (m) {
    const t = await ownTrip(env, dev, m[1]);
    if (!t) return fail(404, "Reise nicht gefunden");
    if (method === "DELETE") { await db.remove(env, "rb_trips", t.id); return json({ ok: true }); }
    // Reise ändern: neue Verbindung (andere Zeit, anderer Start/Ziel) – Ticket bleibt, Überwachung beginnt neu
    if (method === "PUT") {
      const b = await req.json().catch(() => ({}));
      const legs = Array.isArray(b.legs) ? b.legs : [];
      const bad = checkLegs(legs); if (bad) return fail(400, bad);
      const minT = +t.legs[0]?.minT || 0;
      t.legs = legs.map(l => cleanLeg({ ...l, minT: l.minT ?? minT }));
      t.obs = []; t.state = {}; t.active = true; t.ends_at = t.legs[t.legs.length - 1].to.plan;
      if (["spar", "flex", "dticket", "bc100"].includes(b.ticket)) t.ticket = b.ticket;
      const now = Date.now(), cache = new Map();
      await observe(env, dueChecks(t, now, true).slice(0, 8), now, cache);
      await assess(env, t, now, cache);
      t.state = { ...t.state, rem: {}, start: null, pl: {}, zb: false };
      await db.update(env, "rb_trips", t.id, { legs: t.legs, obs: t.obs, state: t.state, ticket: t.ticket, active: true, ends_at: t.ends_at, updated_at: new Date().toISOString() });
      return json(view(t, now));
    }
    if (method === "PATCH") {
      const b = await req.json().catch(() => ({}));
      if (["spar", "flex", "dticket", "bc100"].includes(b.ticket)) await db.update(env, "rb_trips", t.id, { ticket: b.ticket });
      if ("mustLeg" in b) { const mi = b.mustLeg == null ? -1 : +b.mustLeg; await db.update(env, "rb_trips", t.id, { legs: t.legs.map((l, i) => ({ ...l, must: i === mi })), state: { ...(t.state || {}), alt: {}, altAt: {} } }); }
      if (b.minT != null) { const m = Math.min(30, Math.max(0, +b.minT || 0)); await db.update(env, "rb_trips", t.id, { legs: t.legs.map(l => ({ ...l, minT: m })) }); }
      // Pflichtzug oder Umstiegszeit geändert: gleich neu bewerten, damit Möglichkeiten sofort da sind
      if ("mustLeg" in b || b.minT != null) {
        const u = await db.get(env, "rb_trips", t.id), now = Date.now();
        await assess(env, u, now, new Map()).catch(e => console.log("Neu bewerten:", e.message));
        await db.update(env, "rb_trips", u.id, { state: u.state });
      }
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
  if (p === "/api/debug/board" && (env.MOCK === "1" || (env.DIAG_KEY && url.searchParams.get("key") === env.DIAG_KEY))) {
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
      catch (e) { console.log("API-Fehler:", e.stack || e.message); return fail(502, e.user ? e.message : "Da ist gerade etwas schiefgelaufen. Bitte gleich noch einmal versuchen."); }
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runMonitor(env).then(r => console.log("Lauf:", JSON.stringify(r))).catch(e => console.log("Cron-Fehler:", e.stack || e.message)));
  },
};
