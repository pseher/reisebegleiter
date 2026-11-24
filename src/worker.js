import { flush } from "./stats.js";
// Reisebegleiter – Worker: Schnittstelle für die App (/api/*) und Überwachung per Cron
import * as db from "./db.js";
import { searchStations, byEva, nearby } from "./stations.js";
import { connections, resolveConnection, geocodeStop, searchStops, stopsNear, stopDepartures, tripStops } from "./routing.js";
import { importTrip } from "./importer.js";
import { board, findJourney, isoBerlin, rawBoard, normalize, WINDOW_MIN } from "./openboards.js";
import { evaluate, changesFV, isFV } from "./engine.js";
import { runMonitor, dueChecks, observe, assess, deliver, adopt, undoAdopt, planFromHere } from "./monitor.js";
import { sos } from "./sos.js";
import { vapid, b64u } from "./push.js";
import { routineView, berlinDate, wallTime, offReason } from "./routines.js";

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
  // Geräte von vor den Konten: eigenes Konto mit gleicher ID nachträglich anlegen
  if (!d.account_id) { await db.insert(env, "rb_accounts", { id: d.id }).catch(() => {}); await db.update(env, "rb_devices", d.id, { account_id: d.id }); d.account_id = d.id; }
  return d;
}

// Reise gehört zum Konto dieses Geräts (alle verbundenen Geräte dürfen sie sehen und ändern)
const ownTrip = async (env, dev, id) => { const t = await db.get(env, "rb_trips", id); return t && (t.account_id || t.device_id) === dev.account_id ? t : null; };
const LABEL = s => String(s || "").replace(/[^\p{L}\p{N} .\-]/gu, "").slice(0, 30) || null;
const CODE_MIN = 10;
const cleanDays = d => [...new Set((Array.isArray(d) ? d : []).map(Number).filter(x => x >= 1 && x <= 7))].sort();
const cleanName = s => String(s || "").replace(/[<>]/g, "").trim().slice(0, 40);   // Verbindungscode gilt 10 Minuten

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
  const undoZb = canUndo && changesFV(st.undo.legs, trip.legs);       // nur dann betrifft die Änderung die Zugbindung
  // Zugbindung je Möglichkeit immer frisch bewerten (auch für früher gespeicherte Ergebnisse)
  const hasFV = trip.legs.some(isFV);
  const hereRaw = st.here && now - st.here.at < (st.here.mode === "missed" || st.here.mode === "cancel" ? 3 * 3600e3 : 30 * MIN) ? st.here : null;          // Standort-Ergebnisse sind nur kurz gültig
  const restLegs = hereRaw?.mode === "next" ? trip.legs.slice(Math.max(0, v.current) + 1) : hereRaw?.mode === "missed" ? trip.legs.slice(st.missed?.i || 0) : hereRaw?.mode === "cancel" ? trip.legs.slice(hereRaw.idx || 0) : trip.legs, restFV = restLegs.some(isFV);
  const here = hereRaw ? { ...hereRaw, list: (hereRaw.list || []).map(a => { const zb = restFV && changesFV(restLegs, a.legs || []);
    return { ...a, zb, kind: a.kind === "asplanned" && hereRaw.mode !== "missed" ? a.kind : restFV && !zb ? "samefv" : "here" }; }) } : null;
  const altZb = (a, k) => { if (!hasFV || !a.legs) return false;
    const replaced = a.from === "start" ? trip.legs : trip.legs.slice(k + 1);
    return a.kind === "stay" ? replaced.some(l => isFV(l) && l.label !== trip.legs[k]?.label) : changesFV(replaced, a.legs); };
  const sosV = st.sos && now - st.sos.at < 45 * MIN ? { ...st.sos, list: (st.sos.list || []).map(a => ({ ...a, zb: hasFV && changesFV(trip.legs.slice((a.from ?? 0) + 1), a.legs || []) })) } : null;
  const win = st.win ? { from: st.win.from, to: st.win.to, picked: !!st.win.picked, prev: st.win.prev && Date.parse(st.win.prev.arr) > now ? { dep: st.win.prev.dep, label: st.win.prev.label } : null, list: (st.win.list || []).map(a => ({ ...a, zb: hasFV && changesFV(trip.legs, a.legs || []) })) } : null;
  return { id: trip.id, routine: st.routine || null, rname: st.rname || null, rnote: st.rnote || null, win, ticket: trip.ticket, plan: current, canUndo, undoZb, here, sos: sosV, missed: v.missed, planArr: iso(v.legs[v.legs.length - 1].arr.plan), minT: +trip.legs[0]?.minT || 0, created_at: trip.created_at, active: trip.active, checkedAt: st.at || null,
    status: v.status, phase: v.phase, title: v.title, sub: v.sub, next: v.next ? { ...v.next, at: iso(v.next.at), plan: iso(v.next.plan), depAt: iso(v.next.depAt), then: v.next.then ? { ...v.next.then, at: iso(v.next.then.at) } : null } : null, zbLifted: v.zbLifted, zbWhy: v.zbWhy, finalDelay: v.finalDelay, current: v.current,
    legs: v.legs.map(l => ({ ...l, dep: { ...l.dep, plan: iso(l.dep.plan), rt: iso(l.dep.rt) }, arr: { ...l.arr, plan: iso(l.arr.plan), rt: iso(l.arr.rt) } })),
    transfers: v.transfers.map((t, k) => ({ ...t, arrRt: iso(t.arrRt), depRt: iso(t.depRt), alt: (st.alt?.[k] || []).map(a => ({ ...a, zb: altZb(a, k) })), altChecked: !!st.altAt?.[k] })) };
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
const sid = s => (s.stopId ? { stopId: String(s.stopId).slice(0, 120) } : {});
const cleanLeg = l => ({ jid: l.jid, ...(l.tid ? { tid: String(l.tid).slice(0, 200) } : {}), label: l.label.slice(0, 40), mode: String(l.mode || "").slice(0, 20), walk: Math.min(60, Math.max(0, +l.walk || 0)), minT: Math.min(30, Math.max(0, +l.minT || 0)),
  from: { eva: String(l.from.eva || ""), name: l.from.name.slice(0, 80), plan: l.from.plan, platform: String(l.from.platform || "").slice(0, 8), ...coord(l.from), ...sid(l.from) },
  to: { eva: String(l.to.eva || ""), name: l.to.name.slice(0, 80), plan: l.to.plan, platform: String(l.to.platform || "").slice(0, 8), ...coord(l.to), ...sid(l.to), ...(l.to.estimated ? { estimated: true } : {}) }, ...(l.must ? { must: true } : {}) });

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
    const b = await req.json().catch(() => ({}));
    const acc = await db.insert(env, "rb_accounts", { favs: [] });
    const d = await db.insert(env, "rb_devices", { token_hash: await sha(token), account_id: acc.id, label: LABEL(b.label) });
    return json({ id: d.id, token });
  }

  // Nur lokal: Cron sofort auslösen
  // plus=N verschiebt auch die Testdaten (Verspätungen/Ausfälle gelten dann für diese Uhrzeit)
  if (p === "/api/mock/tick" && env.MOCK === "1") { const sh = (+url.searchParams.get("plus") || 0) * MIN; globalThis.RB_MOCK_SHIFT = sh; return json(await runMonitor(env, Date.now() + sh)); }

  const dev = await device(env, req);
  if (!dev) return fail(401, "Gerät unbekannt");

  if (p === "/api/stations") {
    const q = url.searchParams.get("q") || "", st = await searchStations(env, q);
    if (url.searchParams.get("stops") !== "1") return json(st);
    // zusätzlich Bus-/Tram-/U-Bahn-Haltestellen; Bahnhöfe zuerst, Haltestellen nahe einem Bahnhof gleichen Namens weglassen
    const stops = await searchStops(env, q).catch(() => []);
    const near = (a, b) => b.lat != null && Math.hypot((a.lat - b.lat) * 111, (a.lon - b.lon) * 68) < 0.4;
    const coords = st.map(s => ({ ...s, ...(byEva(s.eva) || {}) }));
    return json([...st.slice(0, 6), ...stops.filter(x => !coords.some(s => near(x, s)))].slice(0, 10));
  }
  // Bahnhöfe in der Nähe (für „Von: mein Standort“) – der Standort wird nicht gespeichert
  if (p === "/api/stations/near") {
    const lat = +url.searchParams.get("lat"), lon = +url.searchParams.get("lon");
    if (!(lat > 45 && lat < 56 && lon > 4 && lon < 18)) return fail(400, "Standort liegt außerhalb des Suchgebiets.");
    const stops = url.searchParams.get("stops") === "1" ? await stopsNear(env, lat, lon).catch(() => []) : [];
    const st = env.MOCK === "1" ? [{ eva: "8011160", name: "Berlin Hbf", dist: 800 }, { eva: "8010205", name: "Leipzig Hbf", dist: 2400 }] : nearby(lat, lon);
    return json([...stops, ...st].sort((a, b) => a.dist - b.dist).slice(0, 6));
  }

  // Haltestellen ohne DB-Nummer: Abfahrten und Fahrtverlauf über Transitous
  if (p === "/api/stopdepartures") {
    const id = url.searchParams.get("id") || "", t = Date.parse(url.searchParams.get("time") || "") || Date.now();
    if (!id) return fail(400, "Haltestelle fehlt");
    return json(await stopDepartures(env, { id }, t));
  }
  if (p === "/api/tripstops") {
    const id = url.searchParams.get("trip") || "", after = Date.parse(url.searchParams.get("after") || "") || Date.now();
    if (!id) return fail(400, "Fahrt fehlt");
    return json(await tripStops(env, id, after));
  }
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
    const day = new Date().toISOString().slice(0, 10), use = dev.usage?.day === day ? dev.usage.n : 0, limit = +(env.IMPORT_DAILY_LIMIT || 10);
    if (use >= limit) return fail(429, `Heute schon ${limit} Reisen eingelesen. Morgen geht es weiter – oder die Verbindung über „Von / Nach“ suchen.`);
    // Gesamt-Deckel für alle zusammen (Kostenbremse), Standard 150 Einlesungen am Tag
    const all = +(env.IMPORT_GLOBAL_LIMIT || 150), since = new Date(Date.parse(day + "T00:00:00Z")).toISOString();
    const usedAll = (await db.statsSince(env, since).catch(() => [])).reduce((a, x) => a + (x.ai || 0), 0);
    if (usedAll >= all) return fail(429, "Das Einlesen ist für heute ausgelastet. Bitte die Verbindung über „Von / Nach“ suchen – das geht genauso.");
    await db.update(env, "rb_devices", dev.id, { usage: { day, n: use + 1 } }).catch(() => {});
    return json(await importTrip(env, { text, files }));
  }

  // Verbindungssuche Von → Nach
  if (p === "/api/connections") {
    // Start/Ziel: DB-Bahnhofsnummer oder „@lat,lon“ (Haltestelle)
    const pt = v => { const m = /^@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)$/.exec(v || ""); return m ? { lat: +m[1], lon: +m[2] } : /^\d{6,9}$/.test(v || "") ? v : null; };
    const from = pt(url.searchParams.get("from")), to = pt(url.searchParams.get("to"));
    if (!from || !to) return fail(400, "Start oder Ziel fehlt");
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
    const now = Date.now(), trips = await db.tripsOf(env, dev.account_id), cache = new Map();
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
    const trip = await db.insert(env, "rb_trips", { device_id: dev.id, account_id: dev.account_id, ticket, legs: clean, obs: [], state: {}, active: true, ends_at: clean[clean.length - 1].to.plan });
    const now = Date.now(), cache = new Map();
    await observe(env, dueChecks(trip, now, true).slice(0, 8), now, cache);
    await assess(env, trip, now, cache);
    // Meldungen beginnen mit dem ersten Cron-Lauf – auch für Gleiswechsel oder Zugbindung, die schon beim Anlegen bestehen
    trip.state = { ...trip.state, rem: {}, start: null, pl: {}, zb: false };
    await db.update(env, "rb_trips", trip.id, { obs: trip.obs, state: trip.state });
    return json(view(trip, now), 201);
  }

  // SOS: Zug zuordnen (Standort optional), Ausstiege vor dir, Verbindungen zum Ziel – alles sofort
  const ms = /^\/api\/trips\/([0-9a-f-]{36})\/sos$/i.exec(p);
  if (ms && (method === "POST" || method === "DELETE")) {
    const t = await ownTrip(env, dev, ms[1]);
    if (!t) return fail(404, "Reise nicht gefunden");
    const now = Date.now();
    if (method === "DELETE") { t.state = { ...(t.state || {}), sos: null }; await db.update(env, "rb_trips", t.id, { state: t.state }); return json(view(t, now)); }
    const b = await req.json().catch(() => ({}));
    const lat = +b.lat, lon = +b.lon, here = lat > 45 && lat < 56 && lon > 4 && lon < 18 ? { lat, lon } : null;   // Standort nur für diese Suche
    t.state = { ...(t.state || {}), sos: await sos(env, t, here, now) };
    await db.update(env, "rb_trips", t.id, { state: t.state });
    return json(view(t, now));
  }

  // „Zug verpasst / nicht eingestiegen“: sofort ab dem Abfahrtsbahnhof dieses Zugs suchen (ab jetzt)
  const mm = /^\/api\/trips\/([0-9a-f-]{36})\/missed$/i.exec(p);
  if (mm && (method === "POST" || method === "DELETE")) {
    const t = await ownTrip(env, dev, mm[1]);
    if (!t) return fail(404, "Reise nicht gefunden");
    const now = Date.now();
    if (method === "DELETE") { t.state = { ...(t.state || {}), missed: null, here: null }; await db.update(env, "rb_trips", t.id, { state: t.state }); return json(view(t, now)); }
    const b = await req.json().catch(() => ({}));
    const i = Math.max(0, Math.min(t.legs.length - 1, +b.i || 0));
    const f = withCoords(t.legs[i].from);
    if (f.lat == null && !f.eva) return fail(400, "Für diesen Halt kenne ich keinen Ort.");
    const place = f.eva ? { eva: f.eva, lat: f.lat, lon: f.lon } : { lat: f.lat, lon: f.lon };
    t.state = { ...(t.state || {}), missed: { i, at: now } };
    const list = await planFromHere(env, t, evaluate(t, now), place, now, "missed", i);
    t.state = { ...t.state, here: { at: now, mode: "missed", list } };
    await db.update(env, "rb_trips", t.id, { state: t.state });
    return json(view(t, now));
  }

  // Alternativen ab dem aktuellen Standort (Koordinaten kommen nur auf Knopfdruck aus der App, werden nicht dauerhaft gespeichert)
  const mh = /^\/api\/trips\/([0-9a-f-]{36})\/here$/i.exec(p);
  if (mh && method === "DELETE") {
    const t = await ownTrip(env, dev, mh[1]);
    if (!t) return fail(404, "Reise nicht gefunden");
    await db.update(env, "rb_trips", t.id, { state: { ...(t.state || {}), here: null } });
    return json({ ok: true });
  }
  if (mh && method === "POST") {
    const t = await ownTrip(env, dev, mh[1]);
    if (!t) return fail(404, "Reise nicht gefunden");
    const b = await req.json().catch(() => ({}));
    const now = Date.now(), mode = ["now", "start", "next"].includes(b.mode) ? b.mode : "trip";
    let here;
    if (mode === "start" || mode === "next") {
      // Ohne Standort: ab dem Start der Reise (zur Reisezeit) bzw. unterwegs ab dem nächsten Halt (zur Ankunftszeit dort)
      const v0 = evaluate(t, now), ci = Math.max(0, v0.current), waiting = now < v0.legs[ci].dep.rt;   // wartest du gerade am Umstieg?
      const f = withCoords(mode === "next" ? (waiting ? t.legs[ci].from : t.legs[ci].to) : t.legs[0].from);
      if (f.lat == null && !f.eva) return fail(400, "Für den Start der Reise kenne ich keinen Ort.");
      here = f.eva ? { eva: f.eva, lat: f.lat, lon: f.lon } : { lat: f.lat, lon: f.lon };
    } else {
      const lat = +b.lat, lon = +b.lon;
      if (!(lat > 45 && lat < 56 && lon > 4 && lon < 18)) return fail(400, "Standort liegt außerhalb des Suchgebiets.");
      here = { lat: +lat.toFixed(4), lon: +lon.toFixed(4) };
    }
    const list = await planFromHere(env, t, evaluate(t, now), here, now, mode);
    t.state = { ...(t.state || {}), here: { at: now, mode, list } };
    await db.update(env, "rb_trips", t.id, { state: t.state });
    return json(view(t, now));
  }

  // Plan B übernehmen / zurücknehmen
  const ma = /^\/api\/trips\/([0-9a-f-]{36})\/(adopt|undo)$/i.exec(p);
  if (ma && method === "POST") {
    const t = await ownTrip(env, dev, ma[1]);
    if (!t) return fail(404, "Reise nicht gefunden");
    const b = await req.json().catch(() => ({}));
    const nat = x => x == null || (Number.isInteger(+x) && +x >= 0 && +x < 50);
    if (ma[2] === "adopt" && (!nat(b.idx) || !nat(b.k))) return fail(400, "Ungültige Auswahl");
    if (ma[2] === "undo") undoAdopt(t);
    else if (b.win) {
      // Zeitfenster: diese Fahrt nehmen → ab jetzt normal überwachen (mit Meldungen)
      const w = t.state?.win; if (!w?.list?.[+b.idx]) return fail(400, "Diese Fahrt gibt es nicht mehr. Bitte neu wählen.");
      t.state = { ...t.state, here: { list: w.list, mode: "start", at: Date.now() } };
      await adopt(env, t, 0, +b.idx || 0, true, false);
      // frei gewählt: Maßstab ist die gewählte Fahrt (nicht „später als geplant“)
      t.state = { ...t.state, here: null, undo: null, origArr: null, zbAt: null, win: { ...w, picked: true, list: [] } };
    } else await adopt(env, t, +b.k || 0, +b.idx || 0, !!b.here, !!b.sos);
    const now = Date.now(), cache = new Map();
    await observe(env, dueChecks(t, now, true).slice(0, 8), now, cache);
    await assess(env, t, now, cache);
    await db.update(env, "rb_trips", t.id, { legs: t.legs, obs: t.obs, state: t.state, ends_at: t.ends_at, active: true, updated_at: new Date().toISOString() });
    return json(view(t, now));
  }

  // Zeitfenster: „Die nehme ich“ für die aktuell überwachte Fahrt bzw. wieder offen lassen
  const mp = /^\/api\/trips\/([0-9a-f-]{36})\/pick$/i.exec(p);
  if (mp && (method === "POST" || method === "DELETE")) {
    const t = await ownTrip(env, dev, mp[1]);
    if (!t?.state?.win) return fail(404, "Reise nicht gefunden");
    const bp = method === "POST" ? await req.json().catch(() => ({})) : {}, pv = t.state.win.prev;
    if (bp.prev && pv?.legs?.length) {   // „Ich sitze doch in der 07:05“: zurück zur abgefahrenen Fahrt
      t.legs = pv.legs; t.obs = []; t.ends_at = pv.arr;
      t.state = { ...t.state, tr: [], alt: {}, altAt: {}, rem: {}, legC: {}, pl: {}, win: { ...t.state.win, prev: null, picked: true, list: [] } };
    } else t.state = { ...t.state, win: { ...t.state.win, picked: method === "POST", at: method === "POST" ? t.state.win.at : 0 } };
    if (method === "DELETE") { const { refreshWindow } = await import("./routines.js"); await refreshWindow(env, t, Date.now()).catch(() => {}); }
    await db.update(env, "rb_trips", t.id, { state: t.state, legs: t.legs, obs: t.obs || [], active: t.active, ends_at: t.ends_at });
    return json(view(t, Date.now()));
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
      // Zugehörigkeit zu einer regelmäßigen Fahrt bleibt beim Ändern erhalten (das Zeitfenster ist nach einer festen Wahl erledigt)
      const st0 = t.state || {}, keepSt = Object.fromEntries(["routine", "rname"].filter(k => st0[k]).map(k => [k, st0[k]]));
      if (st0.win) keepSt.win = { ...st0.win, picked: true, list: [] };
      t.obs = []; t.state = keepSt; t.active = true; t.ends_at = t.legs[t.legs.length - 1].to.plan;
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

  // ---------- Regelmäßige Fahrten ----------
  if (p === "/api/routines" && method === "GET") return json((await db.routinesOf(env, dev.account_id)).map(r => routineView(r)));
  if (p === "/api/routines" && method === "POST") {
    // aus einer angelegten Reise: gleiche Strecke, gleiche Abfahrtszeit, gewählte Tage
    const b = await req.json().catch(() => ({}));
    const days = cleanDays(b.days); if (!days.length) return fail(400, "Bitte mindestens einen Tag wählen.");
    const mineR = await db.routinesOf(env, dev.account_id);
    if (mineR.length >= 12) return fail(400, "Höchstens 12 regelmäßige Fahrten.");
    // Gleiche Strecke zur gleichen Zeit gibt es schon? Dann keine zweite (sonst doppelte Mitteilungen)
    const pn = n => String(n || "").replace(/\s*\([^)]*\)\s*$/, "").replace(/^(S\+U|S|U)\s+/i, "").replace(/[^a-zäöüß0-9]/gi, "").toLowerCase();
    const dupOf = (fromN, toN, dep) => mineR.find(r => pn(r.tpl[0].from.name) === pn(fromN) && pn(r.tpl[r.tpl.length - 1].to.name) === pn(toN) && r.dep === dep);
    const dupMsg = r => `Diese Strecke zu dieser Zeit wird schon überwacht („${r.name}“). Du findest sie unter „Regelmäßige Fahrten“.`;
    if (b.from && b.to) {
      // direkt aus der Verbindungssuche: Start, Ziel, Tage und Zeitfenster
      const hhmm = s => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s)) ? String(s) : null), wf = hhmm(b.winFrom), wt = hhmm(b.winTo);
      if (!wf || !wt || wt <= wf) return fail(400, "Bitte ein Zeitfenster wählen (bis muss nach von liegen).");
      const pl = s => ({ name: String(s.name || "").slice(0, 80), eva: /^\d{6,9}$/.test(String(s.eva || "")) ? String(s.eva) : "", ...coord(s), ...sid(s) });
      const from = pl(b.from), to = pl(b.to);
      if (!from.name || !to.name || (!from.eva && from.lat == null) || (!to.eva && to.lat == null)) return fail(400, "Start oder Ziel unbekannt.");
      { const d = dupOf(from.name, to.name, wf); if (d) return fail(409, dupMsg(d)); }
      // aus einer gerade angelegten Reise: deren Tag gilt als erledigt, die Reise gehört dazu
      const t0 = b.tripId ? await ownTrip(env, dev, String(b.tripId)) : null, made = t0 ? [berlinDate(Date.parse(t0.legs[0].from.plan))] : [];
      const r = await db.insert(env, "rb_routines", { account_id: dev.account_id, name: cleanName(b.name) || `Nach ${to.name}`, days, dep: wf, win_from: wf, win_to: wt,
        tpl: [{ jid: "", label: "", from, to }], ticket: ["spar", "flex", "dticket", "bc100"].includes(b.ticket) ? b.ticket : "flex", min_t: Math.min(30, Math.max(0, +b.minT || 0)), holidays: b.holidays !== false, paused: false, skip: [], made });
      if (t0) await db.update(env, "rb_trips", t0.id, { state: { ...(t0.state || {}), routine: r.id, rname: r.name } });
      return json(routineView(r), 201);
    }
    const t = await ownTrip(env, dev, String(b.tripId || ""));
    if (!t) return fail(404, "Reise nicht gefunden");
    const legs = (t.state?.undo?.legs && b.original ? t.state.undo.legs : t.legs), dep0 = Date.parse(legs[0].from.plan);
    { const d = dupOf(legs[0].from.name, legs[legs.length - 1].to.name, wallTime(dep0)); if (d) return fail(409, dupMsg(d)); }
    const r = await db.insert(env, "rb_routines", { account_id: dev.account_id, name: cleanName(b.name) || `Nach ${legs[legs.length - 1].to.name}`, days, dep: wallTime(dep0),
      tpl: legs.map(({ jid, tid, ...l }) => ({ ...l, jid: "" })), ticket: t.ticket, min_t: +legs[0].minT || 0, holidays: b.holidays !== false, paused: false, skip: [], made: [berlinDate(dep0)] });
    await db.update(env, "rb_trips", t.id, { state: { ...(t.state || {}), routine: r.id, rname: r.name } });
    return json(routineView(r), 201);
  }
  const mr = /^\/api\/routines\/([0-9a-f-]{36})(\/skip)?$/.exec(p);
  if (mr) {
    const r = await db.get(env, "rb_routines", mr[1]);
    if (!r || r.account_id !== dev.account_id) return fail(404, "Regelmäßige Fahrt nicht gefunden");
    if (mr[2] && method === "POST") {
      // einen Tag aussetzen bzw. wieder fahren; ist die Reise für den Tag schon angelegt, wird sie beendet
      const b = await req.json().catch(() => ({})), date = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : null;
      if (!date) return fail(400, "Datum fehlt");
      const real = new Date(date + "T12:00:00Z"), today0 = berlinDate(Date.now());
      if (isNaN(real) || real.toISOString().slice(0, 10) !== date) return fail(400, "Ungültiges Datum");
      if (b.on !== false && (date < today0 || Date.parse(date) - Date.parse(today0) > 366 * 864e5)) return fail(400, "Das Datum liegt nicht in der Zukunft.");
      const skip = b.on === false ? (r.skip || []).filter(d => d !== date) : [...new Set([...(r.skip || []), date])].filter(d => d >= berlinDate(Date.now())).slice(-30);
      // wieder fahren: Tag als „noch nicht angelegt“ markieren, damit die Fahrt neu erscheint (falls es sie nicht mehr gibt)
      let made = r.made || [];
      if (b.on === false && !(await db.tripsOf(env, dev.account_id)).some(t => t.state?.routine === r.id && berlinDate(Date.parse(t.legs[0].from.plan)) === date)) made = made.filter(d => d !== date);
      await db.update(env, "rb_routines", r.id, { skip, made });
      if (b.on === false) { const { makeDue } = await import("./routines.js"); await makeDue(env, Date.now()).catch(() => {}); }
      if (b.on !== false) for (const t of await db.tripsOf(env, dev.account_id)) if (t.state?.routine === r.id && berlinDate(Date.parse(t.legs[0].from.plan)) === date) await db.remove(env, "rb_trips", t.id);
      return json(routineView({ ...r, skip }));
    }
    if (method === "PATCH") {
      const b = await req.json().catch(() => ({})), patch = {};
      if (b.name != null) patch.name = cleanName(b.name) || r.name;
      if (b.days != null) { const d = cleanDays(b.days); if (!d.length) return fail(400, "Bitte mindestens einen Tag wählen."); patch.days = d; }
      if (b.holidays != null) patch.holidays = !!b.holidays;
      if (b.winFrom && b.winTo && r.win_to) {
        const ok = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));
        if (!ok(b.winFrom) || !ok(b.winTo) || b.winTo <= b.winFrom) return fail(400, "Bitte ein gültiges Zeitfenster wählen.");
        Object.assign(patch, { win_from: b.winFrom, win_to: b.winTo, dep: b.winFrom });
      }
      if (b.paused != null) patch.paused = !!b.paused;
      if (b.ticket && ["spar", "flex", "dticket", "bc100"].includes(b.ticket)) patch.ticket = b.ticket;
      await db.update(env, "rb_routines", r.id, patch);
      return json(routineView({ ...r, ...patch }));
    }
    if (method === "DELETE") {
      // Überwachung beenden: keine neuen Fahrten mehr. Schon angelegte bleiben als normale Reisen (ohne Verweis), auf Wunsch ganz weg.
      const b = await req.json().catch(() => ({}));
      await db.remove(env, "rb_routines", r.id);
      for (const t of await db.tripsOf(env, dev.account_id)) {
        if (t.state?.routine !== r.id) continue;
        if (b.endTrips) { await db.remove(env, "rb_trips", t.id); continue; }
        const { routine, rname, rnote, win, ...st } = t.state;
        await db.update(env, "rb_trips", t.id, { state: { ...st, ...(win ? { win: { ...win, picked: true, list: [] } } : {}) } });
      }
      return json({ ok: true });
    }
  }

  // ---------- Geräte verbinden (ohne Anmeldung): Code auf dem einen Gerät zeigen, auf dem anderen eingeben ----------
  if (p === "/api/devices" && method === "GET") {
    const list = await db.devicesOf(env, [dev.account_id]);
    return json(list.map(d => ({ id: d.id, label: d.label || "Gerät", me: d.id === dev.id, push: !!d.push, since: d.created_at, seen: d.last_seen })));
  }
  if (p === "/api/devices/label" && method === "POST") {
    const b = await req.json().catch(() => ({}));
    await db.update(env, "rb_devices", dev.id, { label: LABEL(b.label) });
    return json({ ok: true });
  }
  if (p.startsWith("/api/devices/") && method === "DELETE") {
    // Gerät trennen: es verliert den Zugang und fängt beim nächsten Öffnen leer an
    const id = p.split("/")[3], d = await db.get(env, "rb_devices", id);
    if (!d || d.account_id !== dev.account_id) return fail(404, "Gerät nicht gefunden");
    await db.remove(env, "rb_devices", id);
    return json({ ok: true, me: id === dev.id });
  }
  if (p === "/api/link/start" && method === "POST") {
    const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    const until = new Date(Date.now() + CODE_MIN * MIN).toISOString();
    await db.update(env, "rb_devices", dev.id, { link_code: await sha(`rb-link|${code}`), link_until: until });
    return json({ code, until });
  }
  if (p === "/api/link/join" && method === "POST") {
    const b = await req.json().catch(() => ({})), code = String(b.code || "").replace(/\D/g, "");
    // Schutz vor Raten: höchstens 5 Fehlversuche je Viertelstunde
    const now = Date.now(), tr = dev.link_tries && now - Date.parse(dev.link_tries.t) < 15 * MIN ? dev.link_tries : { t: new Date(now).toISOString(), n: 0 };
    if (tr.n >= 5) return fail(429, "Zu viele Versuche. Bitte in 15 Minuten noch einmal – oder auf dem anderen Gerät einen neuen Code holen.");
    const src = code.length === 6 ? await db.deviceByLinkCode(env, await sha(`rb-link|${code}`)) : null;
    if (!src) { await db.update(env, "rb_devices", dev.id, { link_tries: { ...tr, n: tr.n + 1 } }).catch(() => {}); return fail(400, "Der Code stimmt nicht oder ist abgelaufen. Bitte auf dem anderen Gerät einen neuen Code holen."); }
    if (src.account_id === dev.account_id) return fail(400, "Die beiden Geräte sind schon verbunden.");
    // Favoriten zusammenführen, dann Reisen und Geräte dieses Kontos ins andere übernehmen
    const [mine, theirs] = await Promise.all([db.get(env, "rb_accounts", dev.account_id), db.get(env, "rb_accounts", src.account_id)]);
    const favs = [...(theirs?.favs || []), ...(mine?.favs || [])].filter((f, i, a) => f?.id && a.findIndex(x => x.id === f.id) === i).slice(0, 24);
    await db.update(env, "rb_accounts", src.account_id, { favs });
    await db.mergeAccount(env, dev.account_id, src.account_id);
    await db.update(env, "rb_devices", src.id, { link_code: null, link_until: null });
    await db.update(env, "rb_devices", dev.id, { link_tries: null });
    return json({ ok: true });
  }
  // Einstellungen des Kontos (z. B. übliche Umstiegszeit) – gleich auf allen Geräten
  if (p === "/api/prefs" && method === "GET") { const a = await db.get(env, "rb_accounts", dev.account_id); return json(a?.prefs || {}); }
  if (p === "/api/prefs" && method === "PUT") {
    const b = await req.json().catch(() => ({})), a = await db.get(env, "rb_accounts", dev.account_id), prefs = { ...(a?.prefs || {}) };
    if (b.minT != null) prefs.minT = Math.min(30, Math.max(0, Math.round(+b.minT) || 0));
    await db.update(env, "rb_accounts", dev.account_id, { prefs });
    return json(prefs);
  }
  // Favoriten gehören zum Konto, damit sie auf allen Geräten gleich sind
  if (p === "/api/favs" && method === "GET") { const a = await db.get(env, "rb_accounts", dev.account_id); return json(a?.favs || []); }
  if (p === "/api/favs" && method === "PUT") {
    const b = await req.json().catch(() => null);
    if (!Array.isArray(b) || JSON.stringify(b).length > 60000) return fail(400, "Favoriten ungültig");
    await db.update(env, "rb_accounts", dev.account_id, { favs: b.slice(0, 24) });
    return json({ ok: true });
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
    const st = await deliver(env, dev.push, { title: "🔔 Test von Umstiegsheld", body: "So sehen deine Meldungen unterwegs aus.", tag: "test", url: "/", urgent: true });
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

// Nur für den Betreiber: Abfragezähler. Schlüssel ADMIN_KEY (mind. 16 Zeichen) im Cloudflare-Dashboard hinterlegen.
async function adminStats(req, env) {
  const key = req.headers.get("X-Admin-Key") || "", want = String(env.ADMIN_KEY || "");
  let diff = key.length ^ want.length; for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ (key.charCodeAt(i) || 0);
  if (want.length < 16 || diff) { await new Promise(r => setTimeout(r, 400)); return fail(403, "Kein Zugriff"); }
  await flush(env).catch(() => {});
  const rows = await db.statsSince(env, new Date(Date.now() - 14 * 864e5).toISOString());
  return new Response(JSON.stringify({ now: new Date().toISOString(), rows }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/api/admin/stats") return adminStats(req, env);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(req, env, url); }
      catch (e) { console.log("API-Fehler:", e.stack || e.message); return fail(502, e.user ? e.message : "Da ist gerade etwas schiefgelaufen. Bitte gleich noch einmal versuchen."); }
      finally { ctx?.waitUntil?.(flush(env).catch(() => {})); }   // Abfragen dieser Anfrage mitzählen
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runMonitor(env).then(r => console.log("Lauf:", JSON.stringify(r))).catch(e => console.log("Cron-Fehler:", e.stack || e.message)));
  },
};
