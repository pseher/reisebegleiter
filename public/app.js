// Reisebegleiter – App (Vanilla JS, ohne Pakete)
const $app = document.getElementById("app");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hm = iso => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const MIN = 60e3;
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

// ---------- Gerät & Schnittstelle ----------
let AUTH = null;
try { AUTH = JSON.parse(localStorage.getItem("rb_auth") || "null"); } catch {}
// Name fürs Gerät in der Geräteliste („Android-Handy“, „iPhone“, „Windows-PC“ …)
function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "iPad";
  if (/iPhone|iPod/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android-Handy" : "Android-Tablet";
  if (/Windows/.test(ua)) return "Windows-PC";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Linux|CrOS/.test(ua)) return "Computer";
  return "Gerät";
}
async function register() {
  const r = await fetch("/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: deviceLabel() }) });
  if (!r.ok) throw new Error("Anmeldung des Geräts fehlgeschlagen");
  AUTH = await r.json();
  try { localStorage.setItem("rb_auth", JSON.stringify(AUTH)); } catch {}
}
async function api(path, opts = {}, retry = true) {
  try { return await api0(path, opts, retry); }
  catch (e) { if (e instanceof TypeError) throw new Error("Keine Verbindung zum Internet. Bitte gleich noch einmal versuchen."); throw e; }
}
async function api0(path, { method = "GET", body } = {}, retry = true) {
  if (!AUTH) await register();
  const r = await fetch(path, { method, headers: { Authorization: `Bearer ${AUTH.id}.${AUTH.token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401 && retry) { AUTH = null; return api0(path, { method, body }, false); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Fehler ${r.status}`);
  return data;
}

// Eigene Mindest-Umstiegszeit (Minuten, 0 = wie vom Fahrplan geplant)
const MINT_OPTS = [[0, "wie geplant"], [5, "5 Min."], [8, "8 Min."], [10, "10 Min."], [15, "15 Min."]];
let MINT = 5; try { const v = localStorage.getItem("rb_mint"); if (v != null) MINT = +v; } catch {}
const setMinT = (m, sync = true) => { MINT = m; try { localStorage.setItem("rb_mint", String(m)); } catch {} if (sync) api("/api/prefs", { method: "PUT", body: { minT: m } }).catch(() => {}); };
// Einstellungen des Kontos (gleich auf allen verbundenen Geräten)
async function syncPrefs() { try { const p = await api("/api/prefs"); if (p && Number.isFinite(p.minT) && p.minT !== MINT) { setMinT(p.minT, false); return true; }
  if (p && p.minT == null) api("/api/prefs", { method: "PUT", body: { minT: MINT } }).catch(() => {}); } catch {} return false; }
const minTChips = (attr = "data-mt") => `<div class="chips">${MINT_OPTS.map(([m, l]) => `<button class="chip" ${attr}="${m}" aria-pressed="${MINT === m}">${l}</button>`).join("")}</div>`;

// Darstellung: auto | light | dark
let THEME = "auto"; try { THEME = localStorage.getItem("rb_theme") || "auto"; } catch {}
function applyTheme() {
  if (THEME === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", THEME);
  const dark = THEME === "dark" || (THEME === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0b1f2d" : "#0f2a3d");
}
applyTheme();

// ---------- Zustand ----------
let trips = [], loadedAt = 0, view = "home", W = null, timer = null;
const go = v => { view = v; render(); scrollTo(0, 0); };
document.addEventListener("click", e => { const b = e.target.closest("[data-go]"); if (!b) return;
  if (b.dataset.go === "home" && view === "add" && W && (W.legs?.length || W.rFrom || W.imported) && !confirm("Eingaben verwerfen und zur Startseite?")) return;
  if (b.dataset.go === "home") W = null; go(b.dataset.go); });

let ROUTINES = [], OFFLINE = null;
const offlineBox = () => (OFFLINE ? `<div class="banner info small"><b>Keine Verbindung.</b> Du siehst den Stand von ${hm(new Date(OFFLINE).toISOString())} Uhr – Zeiten können sich geändert haben.</div>` : "");
async function loadTrips() {
  api("/api/routines").then(r => { const ch = JSON.stringify(r) !== JSON.stringify(ROUTINES); ROUTINES = r; if (ch && view === "home" && !openId) render(); }).catch(() => {});
  try {
    trips = (await api("/api/trips")).sort((a, b) => Date.parse(a.legs[0].dep.plan) - Date.parse(b.legs[0].dep.plan)); loadedAt = Date.now(); OFFLINE = null;
    try { localStorage.setItem("rb_trips_cache", JSON.stringify({ at: Date.now(), trips })); } catch {}
  } catch (e) {
    // Funkloch: zuletzt bekannten Stand zeigen (mit Uhrzeit), statt einer leeren App
    if (!trips.length) { try { const c = JSON.parse(localStorage.getItem("rb_trips_cache") || "null"); if (c?.trips?.length) { trips = c.trips; OFFLINE = c.at; } } catch {} }
    else OFFLINE = OFFLINE || loadedAt;
    if (!trips.length) throw e;
  }
}
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(async () => { if (view === "home" && document.visibilityState === "visible") { await loadTrips().catch(() => {}); render(); } schedule(); }, 60e3);
}
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") return;
  // Favoriten können auf einem anderen Gerät geändert worden sein
  if (typeof syncFavs === "function" && view !== "add") { syncFavs(true).catch(() => {}); syncPrefs(); }
  if (view === "home" && Date.now() - loadedAt > 30e3) { await loadTrips().catch(() => {}); render(); } });

// ---------- Zurück-Taste (Handy/Browser) ----------
// Solange man nicht auf der Startseite ist, liegt ein Eintrag im Verlauf. „Zurück“ macht dann einen Schritt in der App.
let guard = false, skipPop = false;
// Aufgeklappte Möglichkeiten/Einstellungen zählen als eigener Schritt: „Zurück“ klappt sie erst zu, statt die App zu verlassen
const subOpen = () => !!(openCmp || sheetId || document.querySelector("[data-hide]"));
const atRoot = () => view === "home" && !openId;
function syncHistory() {
  if (!atRoot() && !guard) { history.pushState({ rb: 1 }, ""); guard = true; }
  else if (atRoot() && guard) { guard = false; skipPop = true; history.back(); }
}
addEventListener("popstate", () => {
  if (skipPop) { skipPop = false; return; }
  guard = false;
  if (view === "add" && W) { const bk = document.getElementById("wBack"); if (bk) return bk.click(); W = null; return go("home"); }
  if (view !== "home") return go("home");
  if (openId && subOpen()) { const hx = document.querySelector("[data-hide]"); if (openCmp || sheetId) { openCmp = null; sheetId = null; render(); } else if (hx) hx.click(); return; }
  if (openId) { openId = null; sheetId = null; }
  render();
});
// Assistent übersteht Neuladen (nur in diesem Tab)
const saveW = () => { try { if (view === "add" && W && !W.busy) sessionStorage.setItem("rb_w", JSON.stringify(W)); else sessionStorage.removeItem("rb_w"); } catch {} };

// ---------- Darstellung ----------
let openId = null, sheetId = null, openLeg = null, flash = "";
function render() { render0(); syncHistory(); saveW(); headerBack(); }
// Zurück immer oben links in der Kopfleiste (außer auf der Startseite)
function headerBack() {
  const b = document.getElementById("hdrBack"), brand = document.querySelector(".brand"); if (!b) return;
  const root = atRoot(); b.hidden = root; if (brand) brand.hidden = !root;
}
document.getElementById("hdrBack")?.addEventListener("click", () => { if (guard) history.back(); else { const bk = document.getElementById("wBack"); if (view === "add" && bk) bk.click(); else { openId = null; sheetId = null; go("home"); } } });
const flashBox = () => offlineBox() + flashBox0();
const flashBox0 = () => { if (!flash) return ""; const f = flash; flash = ""; return `<div class="banner ok small" role="status">${esc(f)}</div>`; };
// Umstiegszeit für die Bewertung: in einer Reise deren eigene, sonst die übliche
let CUR_OWN = null, CUR_ZB = false;
const ownMin = () => (CUR_OWN != null ? CUR_OWN : MINT);
function render0() {
  CUR_OWN = null; CUR_ZB = false;
  if (view === "add") { if (!W) startWizard(); return renderWizard(); }
  if (view === "settings") return renderSettings();
  const active = trips.filter(t => t.active !== false);
  if (openId && !active.some(t => t.id === openId)) openId = null;
  if (openId) return renderTrip(active.find(t => t.id === openId), active.length > 1);
  renderList(active);
}

const KICKER = { OK: "Alles im Plan", WATCH: "Knapp", RISK: "Umstieg gefährdet", LOST: "Plan B nötig – öffnen", DONE: "Angekommen" };
const listState = t => (t.status === "WATCH" && !t.transfers.some(x => x.status === "WATCH") && t.finalDelay >= 3 ? `${t.finalDelay} Min. später` : KICKER[t.status] || "");
const heroKicker = t => (t.phase === "before" ? "Vor der Abfahrt" : t.phase === "done" ? "Reise beendet" : "Unterwegs");
const day = iso => new Date(iso).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "Europe/Berlin" });
const inMin = iso => { const m = Math.round((Date.parse(iso) - Date.now()) / MIN);
  if (m >= 18 * 60) return sameDay(Date.parse(iso), Date.now() + 864e5) ? "morgen" : `am ${new Date(iso).toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Berlin" })}`;
  return m <= 0 ? "jetzt" : m < 60 ? `in ${m} Min.` : `in ${Math.floor(m / 60)} Std. ${m % 60} Min.`; };
const lateTag = d => (d >= 1 ? ` <span class="late" title="${d} Min. später">+${d}</span>` : "");
// Im großen „nächster Schritt“: neue Zeit groß, darunter in Worten „13 Min. später, geplant 22:10“
const lateLine = (d, plan) => (d >= 1 ? `<div class="small"><span class="late">${d} Min. später</span> <span class="muted">· geplant ${hm(plan)}</span></div>` : "");
// Bus/Tram/Fähre halten an Steigen, Züge an Gleisen
const isStreet = l => /BUS|TRAM|COACH|FERRY/i.test(l?.mode || "") || /^(Bus|Tram|STR|Fähre|ALT|AST)\b/i.test(String(l?.label || "").trim());
const platWord = (l, p) => (!p ? "" : isStreet(l) ? `Steig ${String(p).replace(/^(Pos\.?|Position|Steig|Bstg\.?)\s*/i, "")}` : `Gleis ${p}`);
const gl = (p, l) => (p ? `<span class="gl">${esc(platWord(l, p))}</span>` : "");
const route = t => `${esc(t.legs[0].dep.name)} → ${esc(t.legs[t.legs.length - 1].arr.name)}`;

// Liste bei mehreren Reisen
function renderList(active) {
  const fresh = !active.length && !ROUTINES.length;
  // „Jetzt“: die laufende oder nächste Fahrt der kommenden Stunden
  const now = Date.now(), cur = active.filter(t => t.phase !== "done" && (t.phase === "enroute" || Date.parse(t.legs[0].dep.rt) - now < 6 * 3600e3))
    .sort((a, b) => (a.phase === "enroute" ? -1 : 0) - (b.phase === "enroute" ? -1 : 0) || Date.parse(a.legs[0].dep.rt) - Date.parse(b.legs[0].dep.rt))[0];
  const soon = now + 18 * 3600e3, today = active.filter(t => t !== cur && Date.parse(t.legs[0].dep.plan) < soon), later = active.filter(t => t !== cur && !today.includes(t));
  const row = t => `<li><button data-open="${t.id}" class="crow"><span class="sdot d-${t.status}"></span>
      <span class="tr-main"><b>${hm(t.legs[0].dep.rt)} ${t.rname ? esc(t.rname) : `${esc(cleanStop(t.legs[0].dep.name))} → ${esc(cleanStop(t.legs[t.legs.length - 1].arr.name))}`}</b>${Date.parse(t.legs[0].dep.plan) > soon ? `<span class="muted small">${day(t.legs[0].dep.plan)}</span>` : ""}</span>
      <span class="tr-state small">${esc(listState(t))}</span></button></li>`;
  const chips = ROUTINES.map(r => `<button class="rchip ${r.paused ? "off" : ""}" data-rgo="${r.id}">↻ ${esc(r.name)} · ${r.paused ? "pausiert" : `${daysText(r.days)} ${r.win ? r.win[0] : r.dep}`}</button>`).join("");
  $app.innerHTML = `${flashBox()}
    ${fresh ? `<h1 class="hero-h">Dein Weg. Ich pass auf.</h1><p class="lead">Fällt dein Bus oder Zug aus oder wird der Umstieg knapp, sag ich dir sofort Bescheid – mit Plan B.</p>` : ""}
    ${cur ? jetztCard(cur) : ""}
    ${tiles(cur)}
    ${fresh ? "" : pushCard()}
    ${today.length ? `<div class="sec-row"><span>Heute</span></div><ul class="trips compact">${today.map(row).join("")}</ul>` : ""}
    ${ROUTINES.length ? `<div class="sec-row"><span>Regelmäßig</span><button class="link" data-rlist>${R_LIST_OPEN ? "Fertig" : "Verwalten ›"}</button></div>
      ${R_LIST_OPEN ? `<div class="card flat rlist">${ROUTINES.map(routineRow).join("")}</div>` : `<div class="rchips">${chips}</div>`}` : ""}
    ${later.length ? `<div class="sec-row"><span>Später · ${later.length} ${later.length === 1 ? "Fahrt" : "Fahrten"}</span><button class="link" data-later>${LATER_OPEN ? "Weniger" : "Zeigen ›"}</button></div>
      ${LATER_OPEN ? `<ul class="trips compact">${later.map(row).join("")}</ul>` : ""}` : ""}
    ${fresh ? `<button class="btn quiet" data-linkjoin>Schon auf einem anderen Gerät? Verbinden</button>` : ""}`;
  $app.querySelectorAll("[data-open]").forEach(b => b.onclick = () => { openId = b.dataset.open; openLeg = null; render(); scrollTo(0, 0); });
  $app.querySelector("[data-later]")?.addEventListener("click", () => { LATER_OPEN = !LATER_OPEN; render(); });
  $app.querySelector("[data-rlist]")?.addEventListener("click", () => { R_LIST_OPEN = !R_LIST_OPEN; R_OPEN = null; render(); });
  $app.querySelectorAll("[data-rgo]").forEach(b => b.onclick = () => { R_LIST_OPEN = true; R_OPEN = b.dataset.rgo; render(); document.querySelector(`[data-ropen="${b.dataset.rgo}"]`)?.scrollIntoView({ block: "center" }); });
  bindTiles(cur);
  bindRoutines();
  bindCommon();
}

// Die laufende/nächste Fahrt groß – Ampelfarbe, Uhrzeit, Steig/Gleis, ein Satz
function jetztCard(t) {
  const n = t.next, lbl = n ? (/^\d/.test(n.label) && n.mode && MODE[n.mode] ? `${MODE[n.mode][0]} ${n.label}` : n.label) : "";
  const when = t.phase === "enroute" ? "unterwegs" : inMin(t.legs[0].dep.rt);
  const what = !n ? "" : n.cancelled ? `<span class="late">${esc(lbl)} fällt aus</span>` : `${esc(lbl)}${n.platform ? ` · ${esc(platWord(n, n.platform))}` : ""}`;
  return `<button class="hero jetzt s-${t.status}" data-open="${t.id}">
    <div class="jk"><span>${t.rname ? `↻ ${esc(t.rname)}` : `${esc(cleanStop(t.legs[0].dep.name))} → ${esc(cleanStop(t.legs[t.legs.length - 1].arr.name))}`} · ${esc(when)}</span><span>${esc(listState(t))}</span></div>
    ${n ? `<div class="jt"><b>${hm(n.at)}</b> <span>${what}</span></div>` : ""}
    <div class="js">${esc(t.status === "OK" ? (n?.then && !n.then.lost ? `Umstieg ${cleanStop(n.then.station || "")} klappt · ${n.then.gap} Min.` : t.title) : t.title)}${t.status === "LOST" ? " – tippen für Plan B" : ""}</div></button>`;
}

// Vier Kacheln: alles, was man starten kann
function tiles(cur) {
  const sosTrip = trips.find(t => t.active !== false && sosAvailable(t));
  const tile = (attr, icon, title, sub, cls = "") => `<button class="tile ${cls}" ${attr}><span class="ti-ic" aria-hidden="true">${icon}</span><b>${title}</b><span>${sub}</span></button>`;
  return `<div class="tiles4">
    ${tile('data-go="add"', "＋", "Neue Fahrt", "Von – nach")}
    ${tile("data-regstart", "↻", "Mein Weg", "Regelmäßig überwachen")}
    ${tile("data-tticket", "🎫", "Ticket einfügen", "Foto, PDF, DB-Link")}
    ${sosTrip ? tile(`data-sos="${sosTrip.id}" data-sosopen`, "!", "SOS", `Ich sitze ${vehicleOf(sosTrip.legs[ridingLeg(sosTrip)]).im}`, "sos") : tile("data-quick", "⌖", "Schnell weg", "Ab hier, jetzt", "quick")}
  </div>`;
}
function bindTiles() {
  $app.querySelectorAll("[data-tticket]").forEach(b => b.onclick = () => { startWizard(); W.impOpen = true; go("add"); });
  $app.querySelectorAll("[data-sosopen]").forEach(b => b.addEventListener("click", () => { openId = b.dataset.sos; }, true));
  $app.querySelectorAll("[data-quick]").forEach(b => b.onclick = quickAway);
}
// „Schnell weg von hier“: Start = Standort, ab jetzt, Ziel aus deinen Wegen/Favoriten oder eintippen
function quickAway() {
  startWizard(); W.quick = true; W.when = Date.now();
  if (!navigator.geolocation) { go("add"); return; }
  go("add");
  navigator.geolocation.getCurrentPosition(pos => { if (!W?.quick) return; W.rFrom = { eva: "", name: "Mein Standort", area: "genau hier", lat: pos.coords.latitude, lon: pos.coords.longitude, stop: true, here: true }; render(); },
    () => {}, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}

// Plan geht nicht mehr: die Empfehlung gleich im roten Kasten – ein Tipp genügt
function heroRec(t) {
  if (t.status !== "LOST" || t.phase === "done") return "";
  let a = null, data = "";
  const hl = t.here && (t.here.mode === "cancel" || t.here.mode === "missed") ? t.here.list : null;
  if (hl?.length) { const i = bestIdx(hl); if (i >= 0) { a = hl[i]; data = `${t.id}|0|${i}|here`; } }
  if (!a) { const k = t.transfers.findIndex(x => x.status === "LOST" && x.alt?.length); if (k >= 0) { const i = bestIdx(t.transfers[k].alt); if (i >= 0) { a = t.transfers[k].alt[i]; data = `${t.id}|${k}|${i}`; } } }
  if (!a) return "";
  const zb = t.ticket === "spar" && !t.zbLifted && a.zb;
  const l0 = a.legs?.[0], pl = a.depPl ? ` · ${platWord(l0 || { label: a.label }, a.depPl)}` : "";
  return `<div class="hero-rec"><div class="small">Empfohlen:</div><div><b>${esc(a.label)}</b> ab ${hm(a.dep)}${esc(pl)} → an ${hm(a.arr)}</div>
    <button class="btn small-btn" data-adopt="${data}" data-zb="${zb ? "1" : ""}" data-adopt-text="${esc(`${a.label}: ab ${hm(a.dep)}, an ${hm(a.arr)}`)}">Die nehme ich</button></div>`;
}
// Zeitfenster: alle Fahrten im Fenster mit Live-Stand, du wählst, welche du nimmst
function windowCard(t) {
  if (!t.win || t.phase === "done") return "";
  if (t.win.picked) return `<div class="banner info small row" style="align-items:center"><span style="flex:3">↻ Du nimmst diese Fahrt (Zeitfenster ${esc(t.win.from)}–${esc(t.win.to)}).</span><button class="chip" data-unpick="${t.id}" style="flex:0 0 auto">Andere wählen</button></div>`;
  const zb0 = t.ticket === "spar" && !t.zbLifted;
  if (!(t.win.list || []).length) return "";
  const rows = (t.win.list || []).map((a, i) => `<div class="cmp-row"><div class="cmp-tag">Später</div><div class="cmp-main">
      ${losZiel(a.dep, a.arr)}${stepsHtml(altSteps(a))}<div class="cmp-live">${liveBadge(a)}${zb0 && a.zb ? ` ${zbBadge}` : ""}</div>
      ${infeasible(a) ? `<div class="small late" style="margin-top:6px">Geht so nicht mehr</div>` : `<div class="row cmp-act"><button class="btn sec small-btn" data-adopt="${t.id}|0|${i}|win">Die nehme ich</button></div>`}</div></div>`).join("");
  return `<h3 class="sec-h">↻ ${esc(t.rname || "Regelmäßig")} · weitere Fahrten bis ${esc(t.win.to)}</h3>
    <p class="small muted" style="margin:-2px 0 8px">Ich überwache automatisch die nächste. Nimmst du eine spätere, tipp sie an.</p><div class="tiles">${rows}</div>`;
}
// Ticket-Frage nur, wenn Fernverkehr dabei ist (Zugbindung gibt es nur dort) – bei Bus, S-/U-Bahn, Tram, Regionalzug gleich anlegen
const FV_RE_C = /^(ICE|IC|EC|ECE|ICD|RJX?|NJ|EN|TGV|EST|D)\s?\d/i;
const isFVc = l => FV_RE_C.test(String(l?.label || "").trim()) || ["HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL"].includes(l?.mode);
function toTicket() {
  const all = (W.multi || [W.legs]).flat();
  if (!all.some(isFVc)) return saveTrip("flex");
  W.step = "ticket"; render();
}
// Frage „Fährst du das regelmäßig?“ nur bei einer neuen, einzelnen Reise
const canRegular = () => !!W && !W.editId && !W.multi && !W.quick && W.legs?.length > 0 && !ROUTINES.some(r => plainStop(r.from) === plainStop(W.legs[0].from.name) && plainStop(r.to) === plainStop(W.legs[W.legs.length - 1].to.name));
// In der Verbindungssuche: Strecke regelmäßig überwachen (Tage + Zeitfenster), danach läuft es im Hintergrund
const REG = { open: false, name: "", days: [1, 2, 3, 4, 5], from: "", to: "", hol: true, ticket: "dticket", busy: false };
function regularBox() {
  if (!REG.open) return `<button class="btn quiet small-btn reg-open" id="regOpen">↻ Diese Strecke regelmäßig überwachen …</button>`;
  if (!REG.from) { const d = new Date(W.when), p = x => String(x).padStart(2, "0"), hh = +d.toLocaleString("de-DE", { hour: "2-digit", hour12: false, timeZone: "Europe/Berlin" });
    REG.from = `${p(hh)}:00`; REG.to = `${p(Math.min(23, hh + 1))}:${hh >= 23 ? "59" : "00"}`; }
  return `<section class="card reg"><div class="card-h"><div class="k">Regelmäßig überwachen</div><button class="card-x" id="regX" aria-label="Schließen">✕</button></div>
    <p class="small muted" style="margin:0 0 8px">An jedem Fahrtag beobachte ich alle Fahrten ${esc(cleanStop(W.rFrom.name))} → ${esc(cleanStop(W.rTo.name))} in deinem Zeitfenster. Du tippst an, welche du nimmst – sonst läuft alles im Hintergrund.</p>
    <input class="txt" id="regName" maxlength="40" placeholder="Name, z. B. Schule oder Arbeit" value="${esc(REG.name)}">
    <p class="small muted" style="margin:4px 0 0">An welchen Tagen?</p>${dayChips(REG.days, "data-regd")}
    <p class="small muted" style="margin:4px 0 0">Abfahrt zwischen</p>
    <div class="win-row"><input type="time" id="regFrom" value="${esc(REG.from)}"><span>und</span><input type="time" id="regTo" value="${esc(REG.to)}"></div>
    <p class="small muted" style="margin:8px 0 0">Ticket</p>
    <div class="chips">${[["dticket", "Deutschlandticket"], ["flex", "Flexpreis"], ["spar", "Sparpreis"], ["bc100", "BahnCard 100"]].map(([k, l]) => `<button class="chip" data-regt="${k}" aria-pressed="${REG.ticket === k}">${l}</button>`).join("")}</div>
    <label class="small chk"><input type="checkbox" id="regHol" ${REG.hol ? "checked" : ""}> An Feiertagen (Berlin) nicht fahren</label>
    <button class="btn" id="regSave" ${REG.busy ? "disabled" : ""}>${REG.busy ? "Speichere …" : `${esc(daysText(REG.days))}, ${esc(REG.from)}–${esc(REG.to)} überwachen`}</button></section>`;
}
function bindRegular() {
  const $ = id => document.getElementById(id), keep = () => { REG.name = $("regName")?.value ?? REG.name; REG.from = $("regFrom")?.value || REG.from; REG.to = $("regTo")?.value || REG.to; };
  $("regOpen")?.addEventListener("click", () => { REG.open = true; render(); });
  $("regX")?.addEventListener("click", () => { REG.open = false; render(); });
  $app.querySelectorAll("[data-regd]").forEach(b => b.onclick = () => { keep(); const d = +b.dataset.regd; REG.days = REG.days.includes(d) ? REG.days.filter(x => x !== d) : [...REG.days, d].sort(); render(); });
  $app.querySelectorAll("[data-regt]").forEach(b => b.onclick = () => { keep(); REG.ticket = b.dataset.regt; render(); });
  ["regFrom", "regTo"].forEach(id => $(id)?.addEventListener("change", () => { keep(); render(); }));
  $("regHol")?.addEventListener("change", e => { REG.hol = e.target.checked; });
  $("regSave")?.addEventListener("click", async () => {
    keep();
    if (!REG.days.length) return alert("Bitte mindestens einen Tag wählen.");
    if (!(REG.to > REG.from)) return alert("Das Ende des Zeitfensters muss nach dem Beginn liegen.");
    REG.busy = true; render();
    const r = await rCall("/api/routines", { method: "POST", body: { from: W.rFrom, to: W.rTo, name: REG.name.trim(), days: REG.days, winFrom: REG.from, winTo: REG.to, ticket: REG.ticket, holidays: REG.hol, minT: MINT } });
    REG.busy = false;
    if (!r) return render();
    Object.assign(REG, { open: false, name: "", days: [1, 2, 3, 4, 5], from: "", to: "", hol: true });
    ROUTINES = await api("/api/routines").catch(() => ROUTINES);
    W = null; flash = `„${r.name}“: ${daysText(r.days)} zwischen ${r.win[0]} und ${r.win[1]} – läuft jetzt im Hintergrund. Die Fahrt erscheint jeweils ca. 3 Std. vorher unter „Heute“.`;
    openId = null; go("home");
  });
}

// ---------- Regelmäßige Fahrten ----------
let LATER_OPEN = false, R_OPEN = null, R_LIST_OPEN = false;
try { R_LIST_OPEN = localStorage.getItem("rb_rlist") === "1"; } catch {}
const DOW = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
// [1,2,3,4,5] → „Mo–Fr“, alle → „täglich“, sonst „Mo, Mi, Fr“ (Folgen ab 3 Tagen zusammengefasst)
function daysText(d) {
  const s = [...d].sort();
  if (s.length === 7) return "täglich";
  const runs = []; for (const x of s) { const r = runs[runs.length - 1]; if (r && x === r[1] + 1) r[1] = x; else runs.push([x, x]); }
  return runs.map(([a, b]) => (b - a >= 2 ? `${DOW[a - 1]}–${DOW[b - 1]}` : a === b ? DOW[a - 1] : `${DOW[a - 1]}, ${DOW[b - 1]}`)).join(", ");
}
const dateWord = date => { const d = new Date(`${date}T12:00:00Z`), t = new Date(), f = x => x.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  const tm = new Date(Date.now() + 864e5); return date === f(t) ? "heute" : date === f(tm) ? "morgen" : d.toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: "UTC" }); };
const dayChips = (sel, attr) => `<div class="chips days">${DOW.map((n, i) => `<button class="chip" ${attr}="${i + 1}" aria-pressed="${sel.includes(i + 1)}">${n}</button>`).join("")}</div>`;
function routineRow(r) {
  const open = R_OPEN === r.id, nx = r.next;
  const state = r.paused ? `<span class="badge">pausiert</span>` : nx ? `nächste: <b>${dateWord(nx.date)}</b>` : "keine Fahrt in den nächsten 3 Wochen";
  const off = !r.paused && r.todayOff && r.todayOff !== "kein Fahrtag" ? ` · heute nicht (${esc(r.todayOff)})` : "";
  return `<div class="rrow ${open ? "open" : ""}"><button class="rhead" data-ropen="${r.id}" aria-expanded="${open}">
      <span class="tr-main"><b>↻ ${esc(r.name)}</b><span class="small muted">${daysText(r.days)} · ${r.win ? `${esc(r.win[0])}–${esc(r.win[1])}` : esc(r.dep)} · ${esc(cleanStop(r.from))} → ${esc(cleanStop(r.to))}</span>
      <span class="small">${state}${off}</span></span><span class="chev">${open ? "▴" : "▾"}</span></button>
    ${open ? `<div class="rbody">
      <p class="small muted" style="margin:0 0 6px">${esc(r.label)}</p>
      <p class="small muted" style="margin:0">Fahrtage</p>${dayChips(r.days, `data-rday="${r.id}" data-d`)}
      ${r.win ? `<p class="small muted" style="margin:6px 0 0">Zeitfenster (Abfahrt)</p><div class="win-row"><input type="time" id="rwf-${r.id}" value="${esc(r.win[0])}"><span>bis</span><input type="time" id="rwt-${r.id}" value="${esc(r.win[1])}"><button class="chip" data-rwin="${r.id}">Speichern</button></div>` : ""}
      <label class="small chk"><input type="checkbox" data-rhol="${r.id}" ${r.holidays ? "checked" : ""}> An Feiertagen (Berlin) nicht fahren</label>
      ${nx && !r.paused ? `<button class="btn sec small-btn" data-rskip="${r.id}|${nx.date}">${dateWord(nx.date) === "heute" || dateWord(nx.date) === "morgen" ? `${dateWord(nx.date)[0].toUpperCase()}${dateWord(nx.date).slice(1)}` : `Am ${dateWord(nx.date)}`} nicht fahren</button>` : ""}
      ${r.skip.length ? `<p class="small" style="margin:8px 0 0">Ausgesetzt: ${r.skip.map(d => `<button class="chip" data-runskip="${r.id}|${d}" title="Wieder fahren">${dateWord(d)} ✕</button>`).join(" ")}</p>` : ""}
      <div class="rbtns"><button class="btn sec small-btn" data-rpause="${r.id}">${r.paused ? "Wieder überwachen" : "Pausieren"}</button>
        <button class="btn quiet small-btn" data-rname="${r.id}">Umbenennen</button></div>
      <button class="btn danger small-btn" data-rdel="${r.id}">Regelmäßige Überwachung beenden</button></div>` : ""}</div>`;
}
async function rCall(path, opts) { try { const v = await api(path, opts); return v; } catch (e) { alert(e.message); return null; } }
async function reloadRoutines() { ROUTINES = await api("/api/routines").catch(() => ROUTINES); render(); }
function bindRoutines() {
  const R = id => ROUTINES.find(r => r.id === id);
  $app.querySelectorAll("[data-ropen]").forEach(b => b.onclick = () => { R_OPEN = R_OPEN === b.dataset.ropen ? null : b.dataset.ropen; render(); });
  $app.querySelectorAll("[data-rday]").forEach(b => b.onclick = async () => { const r = R(b.dataset.rday), d = +b.dataset.d;
    const days = r.days.includes(d) ? r.days.filter(x => x !== d) : [...r.days, d]; if (!days.length) return alert("Mindestens ein Tag.");
    await rCall(`/api/routines/${r.id}`, { method: "PATCH", body: { days } }); reloadRoutines(); });
  $app.querySelectorAll("[data-rwin]").forEach(b => b.onclick = async () => { const id = b.dataset.rwin;
    await rCall(`/api/routines/${id}`, { method: "PATCH", body: { winFrom: document.getElementById(`rwf-${id}`).value, winTo: document.getElementById(`rwt-${id}`).value } }); reloadRoutines(); });
  $app.querySelectorAll("[data-rhol]").forEach(b => b.onchange = async () => { await rCall(`/api/routines/${b.dataset.rhol}`, { method: "PATCH", body: { holidays: b.checked } }); reloadRoutines(); });
  $app.querySelectorAll("[data-rpause]").forEach(b => b.onclick = async () => { const r = R(b.dataset.rpause); await rCall(`/api/routines/${r.id}`, { method: "PATCH", body: { paused: !r.paused } }); reloadRoutines(); });
  $app.querySelectorAll("[data-rname]").forEach(b => b.onclick = async () => { const r = R(b.dataset.rname), n = prompt("Name der Fahrt", r.name); if (!n) return;
    await rCall(`/api/routines/${r.id}`, { method: "PATCH", body: { name: n } }); reloadRoutines(); });
  $app.querySelectorAll("[data-rskip]").forEach(b => b.onclick = async () => { const [id, date] = b.dataset.rskip.split("|");
    const dw = dateWord(date), when = dw === "heute" || dw === "morgen" ? dw[0].toUpperCase() + dw.slice(1) : `Am ${dw}`;
    if (!confirm(`${when} nicht fahren?\n\nIch überwache diese Fahrt dann an dem Tag nicht.`)) return;
    await rCall(`/api/routines/${id}/skip`, { method: "POST", body: { date } }); await loadTrips().catch(() => {}); reloadRoutines(); });
  $app.querySelectorAll("[data-runskip]").forEach(b => b.onclick = async () => { const [id, date] = b.dataset.runskip.split("|");
    await rCall(`/api/routines/${id}/skip`, { method: "POST", body: { date, on: false } }); reloadRoutines(); });
  $app.querySelectorAll("[data-rdel]").forEach(b => b.onclick = async () => { const r = R(b.dataset.rdel);
    if (!confirm(`Regelmäßige Überwachung „${r.name}“ beenden?\n\nEs werden keine neuen Fahrten mehr angelegt. Schon angelegte Fahrten bleiben, bis sie vorbei sind.`)) return;
    await rCall(`/api/routines/${r.id}`, { method: "DELETE" }); R_OPEN = null; await loadTrips().catch(() => {}); reloadRoutines(); });
}
// In den Einstellungen einer Reise: „Regelmäßig überwachen“
const RF = { days: [1, 2, 3, 4, 5], name: "", hol: true };
function routineForm(t) {
  const r = t.routine && ROUTINES.find(x => x.id === t.routine);
  if (r) {
    const date = new Date(t.legs[0].dep.plan).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }), dw = dateWord(date);
    return `<div class="rform"><p class="k" style="margin:14px 0 4px">Regelmäßig: ${esc(r.name)}</p>
      <p class="small muted" style="margin:0 0 6px">${daysText(r.days)} · ${r.win ? `${esc(r.win[0])}–${esc(r.win[1])}` : esc(r.dep)} · ${r.paused ? "pausiert" : "wird überwacht"}</p>
      ${t.phase === "before" ? `<button class="btn sec small-btn" data-rskip="${r.id}|${date}">${dw === "heute" || dw === "morgen" ? `${dw[0].toUpperCase()}${dw.slice(1)}` : `Am ${dw}`} nicht fahren</button>` : ""}
      <button class="btn sec small-btn" data-rpause="${r.id}">${r.paused ? "Wieder überwachen" : "Pausieren (z. B. Urlaub)"}</button>
      <button class="btn danger small-btn" data-rstop="${r.id}">Regelmäßige Überwachung beenden</button></div>`;
  }
  if (t.routine) return "";
  if (t.phase === "done") return "";
  return `<div class="rform"><p class="k" style="margin:14px 0 4px">Regelmäßig überwachen</p>
    <p class="small muted" style="margin:0 0 6px">Z. B. für den Weg zur Arbeit: An jedem Fahrtag lege ich diese Verbindung ca. 3 Std. vorher an und überwache sie.</p>
    <input class="txt" id="rfName" maxlength="40" placeholder="Name, z. B. Schule oder Arbeit" value="${esc(RF.name)}">
    ${dayChips(RF.days, "data-rfd")}
    <label class="small chk"><input type="checkbox" id="rfHol" ${RF.hol ? "checked" : ""}> An Feiertagen (Berlin) nicht fahren</label>
    <button class="btn sec" id="rfSave">${esc(daysText(RF.days))} um ${hm(t.legs[0].dep.plan)} überwachen</button></div>`;
}
function bindRoutineForm(t) {
  const $ = id => document.getElementById(id);
  bindRoutines();
  $app.querySelectorAll("[data-rstop]").forEach(b => b.onclick = async () => { const r = ROUTINES.find(x => x.id === b.dataset.rstop);
    if (!confirm(`Regelmäßige Überwachung „${r.name}“ beenden?\n\nEs werden keine neuen Fahrten mehr angelegt. Diese Fahrt bleibt, bis sie vorbei ist – du kannst sie unten auch beenden.`)) return;
    await rCall(`/api/routines/${r.id}`, { method: "DELETE" }); flash = `„${r.name}“ wird nicht mehr regelmäßig überwacht.`;
    ROUTINES = await api("/api/routines").catch(() => ROUTINES); await loadTrips().catch(() => {}); render(); });
  $("rfName")?.addEventListener("input", e => { RF.name = e.target.value; });
  $app.querySelectorAll("[data-rfd]").forEach(b => b.onclick = () => { const d = +b.dataset.rfd; RF.days = RF.days.includes(d) ? RF.days.filter(x => x !== d) : [...RF.days, d].sort(); render(); });
  $("rfHol")?.addEventListener("change", e => { RF.hol = e.target.checked; });
  $("rfSave")?.addEventListener("click", async () => {
    if (!RF.days.length) return alert("Bitte mindestens einen Tag wählen.");
    const r = await rCall("/api/routines", { method: "POST", body: { tripId: t.id, name: RF.name.trim(), days: RF.days, holidays: RF.hol } });
    if (!r) return;
    Object.assign(RF, { days: [1, 2, 3, 4, 5], name: "", hol: true });
    await loadTrips().catch(() => {}); ROUTINES = await api("/api/routines").catch(() => ROUTINES);
    flash = `„${r.name}“ wird jetzt ${daysText(r.days)} um ${r.dep} überwacht.`; sheetId = null; render(); scrollTo(0, 0);
  });
}

// Der nächste Schritt – groß und eindeutig
function nextCard(n, t) {
  if (!n) return "";
  if (n.kind === "missed") return `<section class="card next"><div class="k">${vehicleOf(t?.legs?.[n.i]).n} verpasst</div>
      <div><b>${esc(n.label)}</b> ab ${esc(cleanStop(n.station))} hast du nicht bekommen.</div>
      <button class="btn quiet small-btn" data-caught="${t.id}">Doch erwischt – zurück zum Plan</button></section>`;
  // erst nach der Abfahrt sinnvoll – und nur bis 2 Std. danach
  const since = n.depAt ? Date.now() - Date.parse(n.depAt) : -1, leg = t?.legs?.[n.i];
  const missBtn = t && n.i != null && (n.kind === "ride-change" || n.kind === "ride-arrive") && since >= 0 && since <= 120 * MIN
    ? `<button class="btn sec small-btn miss" data-missed="${t.id}|${n.i}">Nicht eingestiegen – neu suchen</button>` : "";
  if (n.kind === "lost") return `<section class="card next"><div class="k">${n.cancelled ? "Anschluss fällt aus" : "Anschluss verpasst"}</div>
      <div><b>${esc(n.label)}</b> ${n.cancelled ? "fällt aus" : "ist schon weg"}. Bleib in <b>${esc(n.station)}</b>. Deine Möglichkeiten stehen unter „So kommst du jetzt weiter“.</div></section>`;
  const head = { board: "Einsteigen", change: "Umsteigen", "ride-change": n.then?.lost ? "Nächster Halt" : "Nächster Halt: umsteigen", "ride-arrive": "Ankunft" }[n.kind];
  const pc = n.platformChanged ? `<span class="late">Gleiswechsel${n.platformPlan ? ` (statt Gleis ${esc(n.platformPlan)})` : ""}</span>` : "";
  let body;
  if ((n.kind === "board" || n.kind === "change") && n.cancelled) body = `<div class="big"><s>${hm(n.at)}</s> <span class="late">fällt aus</span></div>
      <div><b>${esc(n.label)}</b> ab ${esc(n.station)} fährt nicht. Nimm eine der Möglichkeiten darunter.</div>`;
  else if (n.kind === "board" || n.kind === "change") body = `<div class="big">${hm(n.at)} ${gl(n.platform, n)}</div>${pc ? `<div class="small">${pc}</div>` : ""}${lateLine(n.delay, n.plan)}
      <div><b>${esc(/^\d/.test(n.label) && n.mode && MODE[n.mode] ? `${MODE[n.mode][0]} ${n.label}` : n.label)}</b> ab ${esc(n.station)}${n.dest ? ` <span class="muted">→ ${esc(n.dest)}</span>` : ""}</div>
      <div class="muted small">${n.cancelled ? `<span class="late">fällt aus</span>` : inMin(n.at)}</div>
      ${n.from && cleanStop(n.from.name) !== cleanStop(n.station) ? `<div class="walk-box">Zu Fuß von ${esc(cleanStop(n.from.name))} zu ${esc(cleanStop(n.station))} ${walkBtn(n.from, { name: n.station, lat: n.lat, lon: n.lon })}</div>` : ""}`;
  else body = `<div class="big">${hm(n.at)} ${gl(n.platform, n)}</div>${lateLine(n.delay, n.plan)}
      <div>${n.kind === "ride-change" ? "Aussteigen in" : "Ankunft in"} <b>${esc(n.station)}</b></div>
      ${n.then && n.then.station && cleanStop(n.then.station) !== cleanStop(n.station) ? `<div class="walk-box">Danach zu Fuß zu ${esc(cleanStop(n.then.station))} ${walkBtn({ name: n.station, lat: n.lat, lon: n.lon }, { name: n.then.station, lat: n.then.lat, lon: n.then.lon })}</div>` : ""}
      ${n.then ? (n.then.lost ? `<div class="small"><span class="late">Anschluss ${esc(n.then.label)} ${n.then.cancelled ? "fällt aus" : "nicht zu schaffen"}</span></div>`
        : `<div class="then">Dann <b>${esc(n.then.label)}</b> um ${hm(n.then.at)}${n.then.platform ? `, ${esc(platWord(n.then, n.then.platform))}` : ""}${n.then.platformChanged ? ` <span class="late">Gleiswechsel (statt ${esc(n.then.platformPlan)})</span>` : ""} · ${n.then.gap >= 0 ? `${n.then.gap} Min. Zeit` : `<span class="late">voraussichtlich ${-n.then.gap} Min. zu spät</span>`}</div>`) : `<div class="muted small">${inMin(n.at)}</div>`}`;
  return `<section class="card next"><div class="k">${head}</div>${body}${missBtn}</section>`;
}

// Vergleich: pro Option nur das Entscheidende – der knappste Umstieg (an → weiter) und die Ankunft am Ziel.
// Züge, Gleise, Startbahnhof erst auf Antippen.
let openCmp = null;
const cleanStop = n => String(n || "").replace(/^(S\+U|S|U)\s+/, "").replace(/\s+Bhf\b/, "").replace(/\s*\((Berlin|tief)\)/g, "").trim();
function tightest(legs) {   // aus Plan-B-Teilstrecken (MOTIS)
  let best = null;
  for (let j = 0; j + 1 < legs.length; j++) {
    const arr = legs[j].to.plan, dep = legs[j + 1].from.plan, gap = Math.round((Date.parse(dep) - Date.parse(arr)) / MIN);
    if (!best || gap < best.gap) best = { at: cleanStop(legs[j].to.name), arr, dep, gap };
  }
  return best;
}
function planBCard(t) {
  const k = t.transfers.findIndex(x => x.status !== "DONE" && x.alt?.length);
  const calm = k >= 0 && t.transfers[k].status === "OK";
  const open = t.transfers.find(x => (x.status === "RISK" || x.status === "LOST") && !x.alt?.length);
  if (k < 0) return !open ? "" : `<section class="card"><div class="k">Möglichkeiten</div><p class="muted small">${open.altChecked
    ? (open.toMust ? `Ich finde keinen Weg, der dich rechtzeitig zu ${esc(open.toLabel)} bringt. Ich prüfe weiter.` : "Gerade keine bessere Möglichkeit. Ich prüfe weiter.")
    : "Ich suche Möglichkeiten …"}</p></section>`;
  const tr = t.transfers[k], lost = tr.status === "LOST", need = t.minT || 3, zbOn = t.ticket === "spar" && !t.zbLifted;
  const before = Date.now() < Date.parse(t.legs[0].dep.rt), curLeg = before ? t.legs[0] : t.legs[k];
  const curArr = Date.parse(t.plan.arr);
  const tone = g => (g < need ? "late" : g < need + 3 ? "warn-t" : "ok-t");
  const point = p => p ? `<div class="cmp-point">${esc(p.at)}: an <b>${hm(p.arr)}</b> → weiter <b>${hm(p.dep)}</b> · <span class="${tone(p.gap)}"><b>${p.gap} Min.</b></span></div>`
    : `<div class="cmp-point">ohne Umstieg</div>`;
  const goal = (arr, d) => `<div class="cmp-goal">Ziel <b>${hm(arr)}</b>${d}</div>`;
  const delta = a => { const d = Math.round((Date.parse(a.arr) - curArr) / MIN); return lost ? "" : d < -1 ? ` · <b class="ok-t">${-d} Min. früher</b>` : d > 1 ? ` · ${d} Min. später` : " · gleich"; };
  const firstPlan = Date.parse(t.legs[0].dep.plan);
  // Titel = was du tust; die Wirkung steht in der Zeile darunter
  const tag = a => a.from === "start" && Date.parse(a.depPlan || a.dep) < firstPlan - MIN && a.kind !== "later" ? "Früher losfahren" : a.kind === "stay" || (a.legs?.length === 1 && a.label === curLeg.label) ? (a.from === "start" || t.phase === "before" ? `Mit ${esc(curLeg.label)} durchfahren, ohne Umstieg` : `Im ${esc(curLeg.label)} sitzen bleiben`) : ({ safer: "Mehr Zeit zum Umsteigen", faster: "Schneller da", later: a.transfers ? "Später, mit Luft" : "Später, ohne Umstieg", must: "Rechtzeitig zum festen Zug", next: a.transfers ? "Nächste Möglichkeit" : "Nächste Möglichkeit, ohne Umstieg" }[a.kind] || "Andere Verbindung");
  const rec = bestIdx(tr.alt);
  // Dein Plan: der knappste offene Umstieg mit Echtzeit
  const cur = t.transfers.filter(x => x.status !== "DONE").sort((a, b) => a.gap - b.gap)[0];
  const curNext = t.legs.find(l => Date.parse(l.dep.rt) > Date.now() - MIN) || t.legs[0];
  const curState = curNext.dep.cancelled ? `<span class="badge bad">fällt aus</span>` : tr.status === "LOST" ? `<span class="badge bad">Umstieg in ${esc(cleanStop(tr.at))} klappt nicht</span>`
    : tr.status === "RISK" ? `<span class="badge warn">Umstieg in ${esc(cleanStop(tr.at))} ${tr.gap < 0 ? "wohl zu spät" : "gefährdet"}</span>` : curNext.dep.delay >= 3 ? `<span class="badge warn">${esc(nice(curNext))} ${curNext.dep.delay} Min. später</span>` : curNext.live ? `<span class="badge good">pünktlich</span>` : "";
  const curRow = lost ? "" : `<div class="cmp-row cur"><div class="cmp-tag">Dein Plan</div><div class="cmp-main">
      ${losZiel(t.plan.dep, t.plan.arr)}${stepsHtml(planSteps(t))}${curState ? `<div class="cmp-live">${curState}</div>` : ""}</div></div>`;
  const liveOf = liveBadge;
  const rows = tr.alt.map((a, ai) => {
    const id = `${t.id}:${k}:${ai}`, isOpen = openCmp === id;
    return `<div class="cmp-row ${a.reach ? "arr-ok" : arrTone(a.arr || a.dep, t.planArr || t.plan.arr, a.watch)}"><div class="cmp-tag">${tag(a)}${recTag(ai === rec)}</div><div class="cmp-main">
      ${a.reach ? `<div class="cmp-point"><b class="ok-t">${esc(a.reach)}</b></div>` : ""}
      ${a.from === "start" ? losZiel(a.dep, a.arr || a.dep, t.plan.dep, lost ? null : t.plan.arr) : losZiel(a.dep, a.arr || a.dep, null, lost ? null : t.plan.arr).replace("ab <b>", `ab ${esc(cleanStop(a.at))} <b>`)}
      ${stepsHtml(altSteps(a))}
      <div class="cmp-live">${liveOf(a)}${zbOn && a.zb ? ` ${zbBadge}` : ""}</div>
      ${takeBtn(`${t.id}|${k}|${ai}`, { ...a, zb: a.zb !== false }, ai === rec, `${tag(a)}: ab ${hm(a.dep)}, an ${hm(a.arr || a.dep)}\n${a.label}`)}
    </div></div>`; }).join("");
  const zb = zbOn && tr.alt.some(a => a.zb !== false) ? `<p class="small zb-warn tile-note"><b>Sparpreis:</b> Wo „Sparpreis gilt hier evtl. nicht“ steht, fährst du mit einem anderen Fernzug. Das ist erst erlaubt, wenn die Zugbindung aufgehoben ist. Bus, S-/U-Bahn und Regionalzüge darfst du immer frei wählen.</p>` : "";
  const here = `<button class="chip here-chip" data-here="${t.id}">${PIN} Ab meinem Standort suchen</button>`;
  if (calm) {
    // Plan ist knapp, aber gerade in Ordnung: ruhig zeigen, dass es Ausweichmöglichkeiten gibt
    const n = tr.alt.length, good = tr.alt.filter(a => a.watch?.ok && a.watch.live && !a.watch.legs.some(l => l.delay >= 3)).length, liveN = tr.alt.filter(a => a.watch?.live).length, open = openCmp === `calm:${t.id}`;
    const sum = tr.alt.some(a => a.watch) ? `${n} Ausweichmöglichkeit${n > 1 ? "en" : ""} im Blick – ${!liveN ? "noch ohne Live-Daten" : good === n ? (n > 1 ? "alle pünktlich" : "pünktlich") : `${good} davon pünktlich`}.` : `${n} Ausweichmöglichkeit${n > 1 ? "en" : ""} gefunden. Ich prüfe sie ab 3 Std. vor der Abfahrt live mit.`;
    return `<section class="card calm"><div class="k">Falls es knapp wird</div><p class="small" style="margin:0">Dein Umstieg in ${esc(cleanStop(tr.at))} ist mit ${tr.planGap} Min. knapp geplant. ${esc(sum)}</p>
      <button class="btn sec small-btn" data-cmp="calm:${t.id}">${open ? "Möglichkeiten zuklappen" : "Möglichkeiten zeigen"}</button></section>${open ? `<div class="tiles">${zb}${curRow}${rows}</div>` : ""}`;
  }
  return `<h3 class="sec-h">${lost ? "So kommst du jetzt weiter" : "Deine Möglichkeiten"}</h3><div class="tiles">${zb}${curRow}${rows}</div>`;
}

// „S Hohenzollerndamm (Berlin)“ = „Hohenzollerndamm“
const plainStop = n => cleanStop(n).replace(/^(S\+U|S|U)\s+/i, "").replace(/\s*\([^)]*\)\s*$/, "").replace(/[^a-zäöüß0-9]/gi, "").toLowerCase();
// Kompakte Übersicht einer Verbindung: je Zug eine Zeile „16:51 Bus M19 S Halensee → U Adenauerplatz 16:56“, dazwischen der Umstieg
// Echtzeit je Teilstrecke: „pünktlich“, „+4 Min.“ oder „fällt aus“ – ohne Prognose nichts behaupten
function stepLive(x) {
  if (x.c) return ` <span class="badge bad">fällt aus</span>`;
  if (!x.live) return "";   // „noch ohne Live-Daten“ steht einmal unter der Verbindung
  return (x.delay || 0) >= 2 ? ` <span class="badge warn">${x.delay} Min. später</span>` : ` <span class="badge good">pünktlich</span>`;
}
const stepTime = (rt, plan, live) => { const d = plan ? Math.round((Date.parse(rt) - Date.parse(plan)) / MIN) : 0;
  return live && d >= 2 ? `<s class="muted">${hm(plan)}</s> <b class="late">${hm(rt)}</b>` : hm(rt); };
function stepsHtml(steps) {
  return `<ol class="steps-l">${steps.map((x, i) => `<li><span class="st-t">${stepTime(x.dep, x.depPlan, x.live)}</span><span class="st-b"><b>${esc(x.label)}</b>${stepLive(x)}${x.pl ? ` <span class="muted">${esc(platWord({ label: x.label, mode: x.mode }, x.pl))}</span>` : ""} ${esc(cleanStop(x.from))} → ${esc(cleanStop(x.to))} <span class="muted">an ${stepTime(x.arr, x.arrPlan, x.live)}</span></span></li>
    ${i < steps.length - 1 ? `<li class="st-x"><span class="st-t"></span><span class="st-b muted">${(() => { const g = Math.round((Date.parse(steps[i + 1].dep) - Date.parse(x.arr)) / MIN);
      const walk = plainStop(x.to) !== plainStop(steps[i + 1].from) && (x.walk == null || x.walk > 0);
      if (g < 0) return `<span class="late">Umstieg geht nicht – ${-g} Min. zu spät</span>`;
      return `<span class="${g < 3 ? "late" : (ownMin() ? g < ownMin() : g < 6) ? "warn-t" : ""}">Umstieg ${g} Min.</span>${walk ? `, zu Fuß zu ${esc(cleanStop(steps[i + 1].from))}${x.walk ? ` (ca. ${x.walk} Min.)` : ""}` : ""}`; })()}</span></li>` : ""}`).join("")}</ol>`;
}
// Teilstrecken einer Möglichkeit (MOTIS) mit Echtzeit aus der Beobachtung
const altSteps = a => (a.legs || []).map((l, i) => { const w = a.watch?.legs?.[i], d = w?.delay || 0, shift = ms => new Date(Date.parse(ms) + Math.max(0, d) * MIN).toISOString();
  const dep = w?.dep || l.from.rt || shift(l.from.plan), arr = w?.arr || l.to.rt || shift(l.to.plan);
  const live = !!w?.live;
  return { label: l.label, mode: l.mode, from: l.from.name, to: l.to.name, pl: l.from.track || "", walk: l.walk || 0, dep, arr, depPlan: l.from.plan, arrPlan: l.to.plan,
    live, watched: !!w, c: !!(w?.c || l.cancelled), delay: Math.max(Math.round((Date.parse(dep) - Date.parse(l.from.plan)) / MIN), Math.round((Date.parse(arr) - Date.parse(l.to.plan)) / MIN)) }; });
// Deine Reise in derselben Form
const planSteps = t => t.legs.map((l, i) => ({ mode: l.mode, label: nice(l), from: l.dep.name, to: l.arr.name, pl: l.dep.platform, walk: t.transfers[i]?.walk || 0,
  dep: l.dep.rt, arr: l.arr.rt, depPlan: l.dep.plan, arrPlan: l.arr.plan, live: !!(l.dep.live || l.arr.live), c: !!(l.dep.cancelled || l.arr.cancelled), delay: Math.max(l.dep.delay || 0, l.arr.delay || 0) }));
// „Los 16:51 → Ziel 18:50“ mit Unterschied zu deinem Plan
function losZiel(dep, arr, refDep, refArr) {
  const dd = refDep ? Math.round((Date.parse(dep) - Date.parse(refDep)) / MIN) : 0, da = refArr ? Math.round((Date.parse(arr) - Date.parse(refArr)) / MIN) : 0;
  const w = (m, a, b) => (Math.abs(m) < 2 ? "" : m < 0 ? `${fmtSpan(-m)} ${a}` : `${fmtSpan(m)} ${b}`);
  const notes = [refDep && w(dd, "früher los", "später los"), refArr && (Math.abs(da) < 2 ? "gleich am Ziel" : da < 0 ? `<b class="ok-t">${fmtSpan(-da)} früher am Ziel</b>` : `${fmtSpan(da)} später am Ziel`)].filter(Boolean);
  return `<div class="cmp-times">ab <b>${hm(dep)}</b> <span class="muted">→</span> an <b>${hm(arr)}</b></div>${notes.length ? `<div class="cmp-goal">${notes.join(" · ")}</div>` : ""}`;
}
const fmtSpan = m => (m >= 120 ? `${Math.floor(m / 60)} Std.${m % 60 ? ` ${m % 60} Min.` : ""}` : `${m} Min.`);

// Knopf „Diese Verbindung nehmen“: nur die empfohlene Möglichkeit gefüllt, nicht machbare ohne Knopf
const infeasible = a => !!(a.watch && (a.watch.cancelled || !a.watch.ok));
// Empfehlung: früheste Ankunft – aber möglichst ohne Umstieg, der rot (zu knapp) angezeigt wird
const gapOf = a => a.watch?.minGap ?? a.minGap;
const bestIdx = list => {
  const pick = strict => { let b = -1, best = Infinity; (list || []).forEach((a, i) => { if (infeasible(a) || a.kind === "asplanned") return;
    const g = gapOf(a); if (strict && ((g != null && g < Math.max(ownMin(), 3)) || (CUR_ZB && a.zb))) return;   // nicht empfehlen: zu knapp oder Sparpreis gilt evtl. nicht
    const v = Date.parse(a.arr || a.dep); if (v < best) { best = v; b = i; } }); return b; };
  const s = pick(true); return s >= 0 ? s : pick(false); };
function takeBtn(data, a, rec, text) {
  if (infeasible(a)) return `<div class="small late" style="margin-top:6px">Geht so nicht mehr – nicht wählbar</div>`;
  return `<div class="row cmp-act"><button class="btn ${rec ? "" : "sec"} small-btn" data-adopt="${data}" data-zb="${a.zb ? "1" : ""}" data-adopt-text="${esc(text)}">Diese Verbindung nehmen</button></div>`;
}
const recTag = rec => (rec ? ` <span class="rec">empfohlen</span>` : "");
const zbBadge = `<span class="badge warn">Sparpreis gilt hier evtl. nicht</span>`;
// „Ab nächstem Halt“: wartest du gerade am Umstieg, ist es dieser Bahnhof, sonst der Ausstieg des aktuellen Zugs
function nextStop(t) {
  const ci = Math.max(0, t.current), l = t.legs[ci] || t.legs[0], waiting = Date.now() < Date.parse(l.dep.rt);
  return waiting ? { name: l.dep.name, at: l.dep.rt, fromIdx: ci } : { name: l.arr.name, at: l.arr.rt, fromIdx: Math.min(ci + 1, t.legs.length - 1) };
}

// Dezente Farbe je Möglichkeit: kommt sie (laut Plan bzw. Echtzeit) rechtzeitig an oder später als deine gebuchte Ankunft?
const arrTone = (arr, planArr, w) => { if (w && (w.cancelled || !w.ok)) return "arr-much"; const d = Math.round((Date.parse(arr) - Date.parse(planArr)) / MIN);
  return !Number.isFinite(d) ? "" : d <= 2 ? "arr-ok" : d <= 20 ? "arr-late" : "arr-much"; };

// Live-Zustand einer Möglichkeit (wird ab 3 Std. vor Abfahrt mitbeobachtet)
function liveBadge(a) {
  const w = a.watch;
  if (!w) return `<span class="muted small">nur Fahrplan · live ab 3 Std. vorher</span>`;
  if (w.cancelled) return `<span class="badge bad">fällt aus</span>`;
  if (!w.ok) return `<span class="badge bad">Umstieg geht nicht mehr</span>`;
  // Einzelne Verspätungen stehen bei den Teilstrecken – hier nur, was am Ende zählt: die Ankunft
  if (!w.live) return `<span class="muted small">noch ohne Live-Daten</span>`;
  const ad = a.arrPlan && a.arr ? Math.max(w.arrDelay || 0, Math.round((Date.parse(a.arr) - Date.parse(a.arrPlan)) / MIN)) : (w.arrDelay || 0);
  return ad >= 2 ? `<span class="badge warn">Ankunft ca. ${ad} Min. später als im Fahrplan</span>` : `<span class="badge good">Ankunft pünktlich</span>`;
}

// ---------- SOS: im Zug, Verspätung angesagt → sofort Ausstiege und Alternativen ----------
let sosBusy = null;
// „Ich sitze im …“-Knopf: rot nur, wenn wirklich Gefahr besteht – sonst zurückhaltend
function sosButton(t) {
  if (!sosAvailable(t) || t.sos || sosBusy === t.id || t.missed != null) return "";
  const urgent = t.status === "RISK" || t.status === "LOST";
  return `<button class="btn ${urgent ? "sos-btn" : "sec"}" data-sos="${t.id}">Ich sitze ${vehicleOf(t.legs[ridingLeg(t)]).im} – andere Wege</button>`;
}
// In welcher Fahrt sitzt du gerade? (auch: Zug steht mit Verspätung noch am Startbahnhof) – sonst -1
function ridingLeg(t) {
  const now = Date.now(), i = t.legs.findIndex(l => now >= Date.parse(l.dep.rt) - MIN && now < Date.parse(l.arr.rt));
  if (i >= 0) return i;
  const f = t.legs[0];
  return t.phase === "before" && now >= Date.parse(f.dep.plan) && f.dep.delay >= 3 ? 0 : -1;
}
// Nur sinnvoll, wenn du drin sitzt und danach noch umsteigst – auf der letzten Fahrt direkt zum Ziel bringt Aussteigen nichts
const sosAvailable = t => { const i = ridingLeg(t); return i >= 0 && i < t.legs.length - 1; };
function sosCard(t) {
  if (sosBusy === t.id) return `<section class="card sos"><div class="k">Andere Wege ab hier</div><p style="margin:0">Ich suche, wo du aussteigen kannst und wie du am schnellsten ans Ziel kommst …</p><div class="spinner"></div></section>`;
  const s = t.sos; if (!s) return "";
  const i = s.info || {}, zb0 = t.ticket === "spar" && !t.zbLifted;
  const where = i.onTrain ? `Du bist vermutlich in <b>${esc(i.label)}</b>${i.near ? ` bei ${esc(i.near)}` : ""}.` : `Als Nächstes laut Plan: <b>${esc(i.label)}</b>.`;
  const exits = (s.exits || []).slice(0, 4).map(x => `${esc(x.name)} ${hm(x.arr)}${x.delay >= 3 ? ` <span class="late">+${x.delay}</span>` : ""}`).join(" · ");
  const ci = Math.max(0, t.current), mine = { ...t, legs: t.legs.slice(ci), transfers: t.transfers.slice(ci) };
  const rec = bestIdx(s.list);
  const plan = `<div class="cmp-row cur"><div class="cmp-tag">${s.plan && !s.plan.ok ? `Dein Plan klappt nicht: ${esc(t.title)}` : "Dein Plan"}</div><div class="cmp-main">${losZiel(mine.legs[0].dep.rt, s.plan?.arr || t.plan.arr, null, t.planArr)}${stepsHtml(planSteps(mine))}</div></div>`;
  const rows = (s.list || []).map((a, k) => `<div class="cmp-row ${arrTone(a.arr, t.planArr || t.plan.arr, a.watch)}"><div class="cmp-tag">${a.stayOn ? `Im ${esc(i.label)} sitzen bleiben` : `In ${esc(cleanStop(a.at))} aussteigen`}${recTag(k === rec)}</div><div class="cmp-main">
      <div class="small">${a.stayOn ? `Bis ${esc(cleanStop(a.at))}, an ca. <b>${hm(a.exitAt)}</b>` : `Mit ${esc(i.label)} bis ${esc(cleanStop(a.at))}, an <b>${hm(a.exitAt)}</b>`}${a.exitDelay >= 3 ? ` <span class="late">${a.exitDelay} Min. später</span>` : ""}</div>
      ${a.stayOn ? "" : losZiel(a.dep, a.arr, null, t.planArr)}${a.stayOn ? "" : stepsHtml(altSteps(a))}
      <div class="cmp-live">${a.stayOn ? "" : liveBadge(a)}${zb0 && a.zb ? ` ${zbBadge}` : ""}</div>
      ${takeBtn(`${t.id}|${a.from}|${k}|sos`, a, k === rec, a.stayOn ? `Im ${i.label} sitzen bleiben bis ${cleanStop(a.at)}, an ca. ${hm(a.exitAt)}` : `In ${cleanStop(a.at)} aussteigen (an ${hm(a.exitAt)}), dann ${a.label} – Ziel ca. ${hm(a.arr)}`)}
    </div></div>`).join("");
  return `<section class="card sos"><div class="card-h"><div class="k">Andere Wege ab hier · Stand ${hm(new Date(s.at).toISOString())}</div><button class="card-x" data-sosx="${t.id}" aria-label="Schließen">✕</button></div>
      <p style="margin:0 0 4px">${where}${i.located ? "" : ` <span class="small muted">(ohne Standort)</span>`}</p>
      ${exits ? `<p class="small muted" style="margin:0">Nächste Halte: ${exits}</p>` : ""}
      <div class="seg-info small"><span></span><button class="link" data-sos="${t.id}">↻ Aktualisieren</button></div></section>
    <div class="tiles">${plan}${rows || `<div class="cmp-row"><p class="small muted" style="margin:0">Gerade keine andere Verbindung gefunden. Ich behalte ${vehicleOf(t.legs[Math.max(0, t.current)]).dein} im Blick.</p></div>`}</div>`;
}

// Möglichkeiten ab dem eigenen Standort (nur auf Knopfdruck)
let hereBusy = null;
// Drei gleich große Knöpfe nebeneinander: ab Start (zur Reisezeit) · mein Standort zur Reisezeit · mein Standort jetzt
function searchSeg(t, cur) {
  const enroute = t.phase === "enroute", ns = nextStop(t);
  const opts = enroute ? [["next", `Ab ${cleanStop(ns.name)}`, "bei Ankunft dort"], ["now", "Mein Standort", "jetzt"]]
    : [["start", `Ab ${cleanStop(t.legs[0].dep.name).replace(/\//g, "/\u200b")}`, "zur Reisezeit"], ["trip", "Mein Standort", "zur Reisezeit"], ["now", "Mein Standort", "jetzt"]];
  return `<div class="seg" role="group" aria-label="Andere Verbindungen suchen" style="grid-template-columns:repeat(${opts.length},1fr)">${opts.map(([m, a, b]) =>
    `<button data-here="${t.id}" data-mode="${m}" aria-pressed="${m === cur}"><b>${m === "trip" || m === "now" ? PIN : ""}${esc(a)}</b><span>${esc(b)}</span></button>`).join("")}</div>`;
}
function hereCard(t) {
  if (t.phase === "done") return "";
  if (hereBusy === t.id) return `<section class="card"><div class="k">Andere Verbindungen</div><div class="spinner"></div></section>`;
  if (!t.here) return `<section class="card"><div class="k">Andere Verbindungen suchen</div>${searchSeg(t, null)}</section>`;
  const ref = Date.parse(t.plan.arr), zb0 = t.ticket === "spar" && !t.zbLifted;
  const span = m => (m >= 120 ? `${Math.floor(m / 60)} Std. ${m % 60 ? `${m % 60} Min.` : ""}`.trim() : `${m} Min.`);
  const mode = t.here.mode || "trip";
  // unterwegs: dein Plan ab dem nächsten Halt (der Zug, in dem du sitzt, ist schon gesetzt)
  const ci = Math.max(0, t.current), ns = nextStop(t), fromIdx = mode === "next" ? ns.fromIdx : 0;
  const mine = { ...t, legs: t.legs.slice(fromIdx), transfers: t.transfers.slice(fromIdx) };
  const isMissed = mode === "missed" || mode === "cancel";
  const planTile = isMissed ? "" : `<div class="cmp-row cur"><div class="cmp-tag">Dein Plan</div><div class="cmp-main">${losZiel(mine.legs[0].dep.rt, t.plan.arr)}${stepsHtml(planSteps(mine))}</div></div>`;
  const rec = bestIdx(t.here.list);
  const rows = t.here.list.map((a, i) => { if (a.kind === "asplanned") return "";
    const d = Math.round((Date.parse(a.arr) - ref) / MIN);
    return `<div class="cmp-row ${arrTone(a.arr, t.planArr || t.plan.arr, a.watch)}"><div class="cmp-tag">${mode === "next" && a.legs?.[0] && a.legs[0].label.replace(/\s/g, "") === t.legs[ci].label.replace(/\s/g, "") ? `Im ${esc(t.legs[ci].label)} sitzen bleiben` : a.kind === "samefv" ? `Zu deinem ${esc(a.legs.find(l => /^(ICE|IC|EC|RJ|NJ|EN|TGV)\b/i.test(l.label))?.label.split(" ")[0] || "Zug")}` : a.transfers ? (Date.parse(a.arr) < ref - MIN ? "Schneller da" : "Andere Verbindung") : "Direkt, ohne Umstieg"}${recTag(i === rec)}</div><div class="cmp-main">
      ${losZiel(a.dep, a.arr, mode === "now" || isMissed ? null : mine.legs[0].dep.rt, isMissed ? t.planArr : t.plan.arr)}
      ${a.walkStart > 2 && mode !== "start" && mode !== "next" ? `<div class="small muted">Vorher ${a.walkStart} Min. zu Fuß zu ${esc(cleanStop(a.firstStop))}</div>` : ""}
      ${stepsHtml(altSteps(a))}
      <div class="cmp-live">${liveBadge(a)}</div>
      ${zb0 && a.zb ? `<div class="cmp-live">${zbBadge}</div>` : ""}
      ${takeBtn(`${t.id}|0|${i}|here`, a, i === rec, `${a.label}: ab ${hm(a.dep)}, an ${hm(a.arr)}`)}
    </div></div>`; }).join("");
  const title = mode === "start" ? `Ab ${esc(cleanStop(t.legs[0].dep.name))} · zur Reisezeit (${day(t.legs[0].dep.plan)})` : mode === "now" ? "Ab deinem Standort · ab jetzt" : `Ab deinem Standort · zur Reisezeit (${day(t.legs[0].dep.plan)})`;
  // Auswahl der Suche oben, darunter die Ergebnisse
  if (isMissed) return `<h3 class="sec-h">So kommst du jetzt weiter</h3>
    <div class="seg-info small muted"><span>ab ${esc(cleanStop(t.legs[mode === "cancel" ? t.here.idx ?? 0 : t.missed ?? 0].dep.name))}${mode === "cancel" ? " · ich aktualisiere das laufend" : " · sofort"}</span>${mode === "cancel" ? "" : `<button class="link" data-missed="${t.id}|${t.missed ?? 0}">↻ Aktualisieren</button>`}</div>
    <div class="tiles">${rows.trim() || `<div class="cmp-row"><p class="small muted" style="margin:0">Gerade keine Verbindung gefunden.</p></div>`}</div>`;
  return `<section class="card"><div class="card-h"><div class="k">Andere Verbindungen</div><button class="card-x" data-hide="${t.id}" aria-label="Schließen">✕</button></div>
    ${searchSeg(t, mode)}
    <div class="seg-info small muted"><span>${mode === "now" ? "ab sofort" : mode === "next" ? `ab ${esc(cleanStop(ns.name))}, an ${hm(ns.at)}` : `geplante Zeit · ${day(t.legs[0].dep.plan)}`}</span>
      <button class="link" data-here="${t.id}" data-mode="${mode}">↻ Aktualisieren</button></div></section>
    <div class="tiles">${planTile}${rows.trim() || `<div class="cmp-row"><p class="small muted" style="margin:0">Keine andere Verbindung gefunden.</p></div>`}</div>`;
}

// Fußweg-Navigation: iPhone → Apple Karten, sonst Google Maps
// Ziel: genaue Koordinaten des Bahnhofs (sonst Name + „Bahnhof“). Start: Koordinaten der Haltestelle, sonst der eigene Standort.
function walkUrl(a, b) {
  const has = x => x && x.lat != null && x.lon != null;
  const dest = has(b) ? `${b.lat},${b.lon}` : `${cleanStop(b.name)} Bahnhof`;
  const orig = has(a) ? `${a.lat},${a.lon}` : "";
  if (isIOS) return `https://maps.apple.com/?${orig ? `saddr=${encodeURIComponent(orig)}&` : ""}daddr=${encodeURIComponent(dest)}&dirflg=w`;
  return `https://www.google.com/maps/dir/?api=1${orig ? `&origin=${encodeURIComponent(orig)}` : ""}&destination=${encodeURIComponent(dest)}&travelmode=walking`;
}
const walkBtn = (a, b) => `<a class="walk" href="${walkUrl(a, b)}" target="_blank" rel="noopener">Weg zeigen ↗</a>`;

// Verkehrsmittel vor reine Liniennummern schreiben (auch für ältere Reisen)
const MODE = { BUS: ["Bus", "Bus"], COACH: ["Bus", "Bus"], TRAM: ["Tram", "Tram"], FERRY: ["Fähre", "Fähre"], SUBWAY: ["U", "U-Bahn"], METRO: ["U", "U-Bahn"] };
const nice = l => { const m = MODE[l.mode]; return m && /^\d/.test(l.label) ? `${m[0]} ${l.label}` : l.label; };
// Richtiges Wort fürs Verkehrsmittel (wie im Server): Zug, Bus, Tram, U-Bahn, Fähre
const vehicleOf = l => { const m = String(l?.mode || ""), lb = String(l?.label || "").trim();
  if (/FERRY/i.test(m) || /^Fähre\b/i.test(lb)) return { n: "Fähre", fest: "Feste Fähre", dein: "deine Fähre", im: "auf der Fähre" };
  if (/TRAM/i.test(m) || /^(Tram|STR)\b/i.test(lb)) return { n: "Tram", fest: "Feste Tram", dein: "deine Tram", im: "in der Tram" };
  if (/SUBWAY|METRO/i.test(m) || /^U\s?\d/i.test(lb)) return { n: "U-Bahn", fest: "Feste U-Bahn", dein: "deine U-Bahn", im: "in der U-Bahn" };
  if (/BUS|COACH/i.test(m) || /^(Bus|ALT|AST)\b/i.test(lb)) return { n: "Bus", fest: "Fester Bus", dein: "deinen Bus", im: "im Bus" };
  return { n: "Zug", fest: "Fester Zug", dein: "deinen Zug", im: "im Zug" }; };
const kindWord = l => (MODE[l.mode] ? (MODE[l.mode][1] === "U-Bahn" ? "Diese U-Bahn" : MODE[l.mode][1] === "Tram" ? "Diese Tram" : MODE[l.mode][1] === "Fähre" ? "Diese Fähre" : "Diesen Bus") : "Diesen Zug");

// Kompakter Verlauf: eine Zeile pro Zug, Umstiege als schmale Zeile, Details auf Antippen
function timeline(t) {
  const rows = [];
  t.legs.forEach((l, i) => {
    const past = Date.parse(l.arr.rt) < Date.now(), open = openLeg === `${t.id}:${i}`;
    rows.push(`<li class="leg-row ${past ? "past" : ""}"><button data-leg="${t.id}:${i}" aria-expanded="${open}">
      <span class="tm">${l.dep.delay >= 1 ? `<s class="muted small">${hm(l.dep.plan)}</s><br><b class="late">${hm(l.dep.rt)}</b>` : hm(l.dep.rt)}<br><span class="muted">${l.arr.delay >= 1 ? `<s class="small">${hm(l.arr.plan)}</s> <span class="late">${hm(l.arr.rt)}</span>` : hm(l.arr.rt)}</span></span>
      <span class="ln"><span class="chip-t">${esc(nice(l))}</span>${l.must ? ` <span class="must">${vehicleOf(l).fest.toLowerCase()}</span>` : ""}${l.live ? "" : ` <span class="muted small">nur Fahrplan</span>`}${l.dep.cancelled || l.arr.cancelled ? ` <span class="late">fällt aus</span>` : ""}<br>
        <span class="small">${esc(l.dep.name)} → ${esc(l.arr.name)}</span></span>
      <span class="pl small">${esc(platWord(l, l.dep.platform))}</span></button>
      ${open ? `<div class="detail small">
        <div>Ab ${esc(l.dep.name)}: plan ${hm(l.dep.plan)}${l.dep.delay ? `, jetzt ${hm(l.dep.rt)}` : ""}${l.dep.platform ? `, ${esc(platWord(l, l.dep.platform))}` : ""}${!isStreet(l) && l.dep.platformPlan && l.dep.platform !== l.dep.platformPlan ? ` (statt ${esc(l.dep.platformPlan)})` : ""}</div>
        <div>An ${esc(l.arr.name)}: plan ${hm(l.arr.plan)}${l.arr.delay ? `, jetzt ${hm(l.arr.rt)}${l.arr.estimated ? " (geschätzt)" : ""}` : ""}${l.arr.platform ? `, ${esc(platWord(l, l.arr.platform))}` : ""}</div>
        ${[...(l.dep.messages || []), ...(l.arr.messages || [])].slice(0, 3).map(m => `<div class="muted">${esc(m)}</div>`).join("")}
        ${l.live ? "" : `<div class="muted">${l.jid ? "Noch keine Prognose der Bahn – kommt meist kurz vor der Abfahrt." : "Live-Zeiten kommen, sobald der Verkehrsbetrieb sie liefert (meist ab 2 Std. vorher)."}</div>`}
        ${t.legs.length > 1 ? `<button class="chip" style="margin-top:8px" data-must="${t.id}|${l.must ? "" : i}">${l.must ? "Nicht mehr fest einplanen" : `${kindWord(l)} fest einplanen`}</button>` : ""}
      </div>` : ""}</li>`);
    const tr = t.transfers[i];
    if (tr) { const nx = t.legs[i + 1], moved = l.arr.eva && nx.dep.eva ? l.arr.eva !== nx.dep.eva : cleanStop(l.arr.name) !== cleanStop(nx.dep.name);
      const same = tr.samePlace || plainStop(l.arr.name) === plainStop(nx.dep.name), walk = moved && !same;
      rows.push(`<li class="xfer"><span class="sdot d-${tr.status === "DONE" ? "OK" : tr.status}"></span>
      <span class="small">Umstieg ${esc(cleanStop(l.arr.name))}${walk ? ` → ${esc(cleanStop(nx.dep.name))} (Fußweg)` : moved && tr.walk ? ` (kurzer Fußweg, ca. ${tr.walk} Min.)` : ""} · ${transferText(tr)}</span>
      ${moved && tr.status !== "DONE" ? walkBtn(l.arr, nx.dep) : ""}</li>`); }
  });
  return `<ol class="tl2">${rows.join("")}</ol>`;
}

function transferText(tr) {
  const a = platWord(tr.fromLeg, tr.arrPl), d = platWord(tr.toLeg, tr.depPl);
  const pl = a && d ? ` · ${esc(a)} → ${esc(d)}` : d ? ` · weiter von ${esc(d)}` : "";
  if (tr.status === "DONE") return `erledigt`;
  if (tr.status === "LOST") return tr.reason === "cancel" ? `<b>Anschluss fällt aus</b>` : `<b>nicht zu schaffen</b>${pl}`;
  if (tr.toMust && (tr.status === "RISK" || tr.status === "LOST")) return `<b>${vehicleOf(tr.toLeg).fest} in Gefahr:</b> ${tr.gap >= 0 ? `${tr.gap} Min.` : `Ankunft ${-tr.gap} Min. nach Abfahrt`}${pl}`;
  if (tr.status === "RISK" && tr.own && tr.gap >= 0 && tr.gap < tr.own) return `<b>${tr.gap} Min., zu knapp für dich</b>${pl}`;
  if (tr.status === "WATCH" && tr.own && tr.gap >= 0 && tr.gap < tr.own) return `<b>${tr.gap} Min.</b> – etwas weniger als deine ${tr.own} Min.${pl}`;
  if (tr.status === "RISK") return tr.gap < 0 ? `<b>Ankunft ${-tr.gap} Min. nach Abfahrt</b>${pl}` : `<b>nur ${tr.gap} Min.</b>${pl}`;
  if (tr.status === "WATCH") return `<b>${tr.gap} Min., knapp</b>${pl}`;
  return `${tr.gap} Min.${pl}`;
}

function renderTrip(t, many) {
  CUR_OWN = +t.minT || 0; CUR_ZB = t.ticket === "spar" && !t.zbLifted;
  const checked = t.legs.flatMap(l => [l.dep.checked, l.arr.checked]).filter(Boolean), fresh = checked.length ? Math.max(...checked) : null;
  const noLive = t.legs.every(l => !l.dep.live && !l.arr.live);
  const sheet = sheetId === t.id;
  $app.innerHTML = `${flashBox()}
    <div class="trip-head"><div class="row" style="align-items:flex-start"><h1 style="flex:1">${route(t)}</h1><button class="chip fav-btn" data-favt="${t.id}" aria-pressed="${isFav(t)}" title="${isFav(t) ? "Favorit entfernen" : "Als Favorit merken"}" style="flex:0 0 auto;margin-top:10px">${isFav(t) ? "★" : "☆"}</button>${t.phase !== "done" ? `<button class="chip" data-edit="${t.id}" style="flex:0 0 auto;margin-top:10px">Ändern</button>` : ""}</div><p class="muted small">${day(t.legs[0].dep.plan)} · ${hm(t.legs[0].dep.rt)} – ${hm(t.legs[t.legs.length - 1].arr.rt)}${t.legs.length > 1 ? ` · ${t.legs.length - 1} Umstieg${t.legs.length > 2 ? "e" : ""}` : ""}</p></div>
    ${`<section class="hero s-${t.status}"><div class="k">${heroKicker(t)}</div><h2>${esc(t.title)}</h2>
      ${t.status === "OK" || t.status === "DONE" ? "" : `<p>${esc(t.sub.replace(/ (Plan B|Vorschlag):.*$/, "").replace(" Ich behalte das im Blick.", ""))}</p>`}${heroRec(t)}</section>`}
    ${t.win?.picked ? windowCard(t) : ""}
    ${t.canUndo ? `<div class="banner info small row" style="align-items:center"><span style="flex:3">Du fährst jetzt mit ${esc(t.legs.map(l => nice(l)).join(" → "))}.${t.ticket === "spar" && !t.zbLifted && t.undoZb ? " Achtung: Dein Sparpreis gilt hier evtl. nicht, solange die Zugbindung nicht aufgehoben ist." : ""}</span><button class="chip" data-undo="${t.id}" style="flex:0 0 auto">Zurück zum alten Plan</button></div>` : ""}
    ${t.rnote ? `<div class="banner info small">↻ ${esc(t.rnote)}</div>` : ""}
    ${nextCard(t.next, t)}
    ${sosButton(t)}
    ${t.win && !t.win.picked && t.phase === "before" ? windowCard(t) : t.missed != null ? hereCard(t) : t.sos || sosBusy === t.id ? sosCard(t) + hereCard({ ...t, here: null }) : t.here || hereBusy === t.id ? hereCard(t) : planBCard(t) + hereCard(t)}
    ${t.zbLifted ? `<div class="banner"><b>Dein Sparpreis gilt jetzt voraussichtlich auch in anderen Zügen.</b> Grund: ${t.legs.some(l => l.dep.cancelled || l.arr.cancelled) ? "Zugausfall" : "Verspätung bzw. absehbar verpasster Anschluss"} (DB-Regeln zur Zugbindung). <a href="https://www.bahn.de/faq/zugbindung-aufgehoben-bedeutung" target="_blank" rel="noopener">Regeln</a></div>` : ""}
    <h3 class="sec-h">Verlauf</h3>
    <div class="card flat">${timeline(t)}</div>
    <p class="foot">${fresh ? `Geprüft um ${hm(fresh)}` : "Noch nicht geprüft"}${noLive ? " · nur Fahrplan" : ""} · ohne Gewähr</p>
    <button class="btn quiet" data-sheet="${t.id}">${sheet ? "Einstellungen schließen" : "Einstellungen dieser Reise"}</button>
    ${sheet ? `<section class="card" id="sheet">
      ${t.phase !== "done" ? `<button class="btn sec" data-edit="${t.id}">Reise ändern (Zeit, Strecke, Verbindung)</button>` : ""}
      <p class="small muted">Zeit, die ich mindestens zum Umsteigen brauche</p>
      <div class="chips">${MINT_OPTS.map(([m, l]) => `<button class="chip" data-tmt="${m}" aria-pressed="${(t.minT || 0) === m}">${l}</button>`).join("")}</div>
      <p class="small muted">Ticket (nur für den Hinweis zur Zugbindung)</p>
      <div class="chips">${[["spar", "Sparpreis"], ["flex", "Flexpreis"], ["dticket", "Deutschlandticket"], ["bc100", "BahnCard 100"]].map(([k, l]) => `<button class="chip" data-tk="${k}" aria-pressed="${t.ticket === k}">${l}</button>`).join("")}</div>
      ${routineForm(t)}
      <div class="danger-zone"><button class="btn danger" data-del="${t.id}">Fahrt löschen</button><p class="small muted" style="margin:4px 0 0">Wird nicht mehr überwacht und verschwindet aus der Liste.</p></div></section>` : ""}
    ${pushCard()}
    <button class="btn sec" data-go="add">Weitere Reise hinzufügen</button>`;
  $app.querySelector("[data-list]")?.addEventListener("click", () => { openId = null; sheetId = null; render(); scrollTo(0, 0); });
  $app.querySelectorAll("[data-cmp]").forEach(b => b.onclick = () => { openCmp = openCmp === b.dataset.cmp ? null : b.dataset.cmp; render(); });
  $app.querySelectorAll("[data-leg]").forEach(b => b.onclick = () => { openLeg = openLeg === b.dataset.leg ? null : b.dataset.leg; render(); });
  $app.querySelector("[data-sheet]").onclick = () => { sheetId = sheet ? null : t.id; render(); };
  $app.querySelectorAll("[data-edit]").forEach(b => b.onclick = async () => { b.disabled = true; await startEdit(t); });
  $app.querySelectorAll("[data-favt]").forEach(b => b.onclick = () => { const was = isFav(t); toggleFav(t); flash = was ? "Aus den Favoriten entfernt." : "Als Favorit gemerkt – du findest ihn unter „Reise hinzufügen“."; render(); });
  const patch = async body => { await api(`/api/trips/${t.id}`, { method: "PATCH", body }).catch(e => alert(e.message)); await loadTrips().catch(() => {}); render(); };
  $app.querySelectorAll("[data-tmt]").forEach(b => b.onclick = () => patch({ minT: +b.dataset.tmt }));   // nur diese Reise
  $app.querySelectorAll("[data-tk]").forEach(b => b.onclick = () => patch({ ticket: b.dataset.tk }));
  $app.querySelectorAll("[data-must]").forEach(b => b.onclick = e => { e.stopPropagation(); const v = b.dataset.must.split("|")[1]; patch({ mustLeg: v === "" ? null : +v }); });
  bindRoutineForm(t);
  bindCommon();
}

function renderSettings() {
  const perm = "Notification" in window ? Notification.permission : "nicht unterstützt";
  const on = perm === "granted" && localStorage.getItem("rb_push") === "1";
  $app.innerHTML = `<h1>Einstellungen</h1>
    <section class="card"><div class="k">Darstellung</div>
      <div class="chips">${[["auto", "Automatisch"], ["light", "Hell"], ["dark", "Dunkel"]].map(([k, l]) => `<button class="chip" data-theme-set="${k}" aria-pressed="${THEME === k}">${l}</button>`).join("")}</div>
      <p class="small muted">Automatisch folgt der Einstellung deines Geräts.</p></section>
    <section class="card"><div class="k">Meine übliche Umstiegszeit</div>${minTChips()}
      <p class="small muted">Gilt für neue Reisen. Bei einer Reise änderst du sie unter „Einstellungen dieser Reise“.</p></section>
    ${devicesCard()}
    <section class="card"><div class="k">Mitteilungen</div>
      <p class="small">${on ? "Eingeschaltet auf diesem Gerät." : perm === "denied" ? "Im Browser blockiert." : "Noch nicht eingeschaltet."}</p>
      ${on ? `<button class="btn sec" id="pushTest">Test-Mitteilung senden</button>` : perm === "denied" ? "" : `<button class="btn" id="pushOn">Mitteilungen erlauben</button>`}
      ${isIOS && !standalone ? `<p class="small muted">iPhone: erst „Teilen“ → „Zum Home-Bildschirm“, dann von dort öffnen.</p>` : ""}</section>
    <p class="foot">Echtzeitdaten: DB InfraGO (OpenBoards) · Verbindungen: Transitous/MOTIS · Angaben ohne Gewähr</p>`;
  $app.querySelectorAll("[data-theme-set]").forEach(b => b.onclick = () => { THEME = b.dataset.themeSet; try { localStorage.setItem("rb_theme", THEME); } catch {} applyTheme(); render(); });
  $app.querySelectorAll("[data-mt]").forEach(b => b.onclick = () => { setMinT(+b.dataset.mt); render(); });
  document.getElementById("pushTest")?.addEventListener("click", () => api("/api/push/test", { method: "POST" }).then(r => alert(r.ok ? "Gesendet – kommt gleich an." : "Konnte nicht gesendet werden.")).catch(e => alert(e.message)));
  bindDevices();
  bindCommon();
}

// ---------- Geräte verbinden: gleiche Reisen und Favoriten auf Handy, Tablet und Computer – ohne Anmeldung ----------
const DEV = { list: null, code: null, until: null, join: false, input: "", err: "", busy: false };
const fmtCode = c => `${c.slice(0, 3)} ${c.slice(3)}`;
const dayShort = iso => new Date(iso).toLocaleDateString("de-DE", { day: "numeric", month: "numeric", timeZone: "Europe/Berlin" });
function devicesCard() {
  if (!DEV.list) { api("/api/devices").then(l => { DEV.list = l; if (view === "settings") render(); }).catch(() => {}); }
  const list = DEV.list || [], others = list.filter(d => !d.me);
  const rows = list.map(d => `<li class="dev-row"><span><b>${esc(d.label)}</b>${d.me ? ` <span class="muted">(dieses Gerät)</span>` : ""}<br>
      <span class="small muted">${d.me ? "" : `zuletzt ${sameDay(Date.parse(d.seen), Date.now()) ? "heute" : `am ${dayShort(d.seen)}`} · `}Mitteilungen ${d.push ? "an" : "aus"}</span></span>
      ${d.me ? "" : `<button class="chip" data-devdel="${d.id}">Trennen</button>`}</li>`).join("");
  const codeBox = DEV.code && Date.parse(DEV.until) > Date.now() ? `<div class="link-code">
      <p class="small" style="margin:0">Auf dem anderen Gerät den Reisebegleiter öffnen → Einstellungen → „Code eingeben“:</p>
      <div class="code-big" aria-label="Code ${esc(DEV.code.split("").join(" "))}">${fmtCode(DEV.code)}</div>
      <p class="small muted" style="margin:0">Gilt bis ${hm(DEV.until)} Uhr. Nur an deine eigenen Geräte weitergeben.</p>
      <div class="row" style="margin-top:8px"><button class="btn sec small-btn" id="devShare">Als Link schicken</button><button class="btn quiet small-btn" id="devCodeX">Fertig</button></div></div>` : "";
  const joinBox = DEV.join ? `<div class="link-code">
      <label class="small" for="devIn">Code vom anderen Gerät</label>
      <input id="devIn" class="code-in" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123 456" value="${esc(DEV.input)}">
      ${DEV.err ? `<p class="small late" style="margin:4px 0 0">${esc(DEV.err)}</p>` : ""}
      <div class="row" style="margin-top:8px"><button class="btn small-btn" id="devJoin" ${DEV.busy ? "disabled" : ""}>${DEV.busy ? "Verbinde …" : "Verbinden"}</button><button class="btn quiet small-btn" id="devJoinX">Abbrechen</button></div></div>` : "";
  return `<section class="card" id="devices"><div class="k">Deine Geräte</div>
    <p class="small" style="margin-top:0">Verbundene Geräte zeigen dieselben Reisen und Favoriten – ohne Anmeldung, ohne E-Mail. Mitteilungen schaltest du auf jedem Gerät selbst ein.</p>
    ${list.length ? `<ul class="dev-list">${rows}</ul>` : ""}
    ${codeBox || joinBox || `<div class="seg seg2"><button id="devCode"><b>Gerät hinzufügen</b><span>Code hier anzeigen</span></button><button id="devJoinOpen"><b>Code eingeben</b><span>von anderem Gerät</span></button></div>`}
    ${others.length ? `<button class="btn quiet small-btn" id="devLeave">Dieses Gerät trennen</button>` : ""}</section>`;
}
function bindDevices() {
  const $ = id => document.getElementById(id);
  $("devCode")?.addEventListener("click", async () => { try { const r = await api("/api/link/start", { method: "POST" }); DEV.code = r.code; DEV.until = r.until; render(); } catch (e) { alert(e.message); } });
  $("devCodeX")?.addEventListener("click", () => { DEV.code = null; DEV.list = null; render(); });
  $("devShare")?.addEventListener("click", async () => {
    const url = `${location.origin}/?link=${DEV.code}`, text = `Reisebegleiter verbinden – Code ${fmtCode(DEV.code)} (gilt bis ${hm(DEV.until)} Uhr)`;
    try { if (navigator.share) await navigator.share({ title: "Reisebegleiter", text, url }); else { await navigator.clipboard.writeText(`${text}\n${url}`); alert("Link kopiert."); } } catch {}
  });
  $("devJoinOpen")?.addEventListener("click", () => { DEV.join = true; DEV.err = ""; render(); setTimeout(() => $("devIn")?.focus(), 50); });
  $("devJoinX")?.addEventListener("click", () => { DEV.join = false; DEV.input = ""; DEV.err = ""; render(); });
  $("devIn")?.addEventListener("input", e => { DEV.input = e.target.value; });
  $("devIn")?.addEventListener("keydown", e => { if (e.key === "Enter") $("devJoin")?.click(); });
  $("devJoin")?.addEventListener("click", () => joinDevice(DEV.input));
  $app.querySelectorAll("[data-devdel]").forEach(b => b.onclick = async () => {
    const d = (DEV.list || []).find(x => x.id === b.dataset.devdel);
    if (!confirm(`${d?.label || "Gerät"} trennen?\n\nDas Gerät sieht deine Reisen dann nicht mehr und bekommt keine Mitteilungen mehr.`)) return;
    await api(`/api/devices/${b.dataset.devdel}`, { method: "DELETE" }).catch(e => alert(e.message));
    DEV.list = null; render();
  });
  $("devLeave")?.addEventListener("click", async () => {
    if (!confirm("Dieses Gerät trennen?\n\nDeine Reisen bleiben auf den anderen Geräten. Hier fängst du danach leer an.")) return;
    const me = (DEV.list || []).find(d => d.me);
    await api(`/api/devices/${me.id}`, { method: "DELETE" }).catch(() => {});
    try { ["rb_auth", "rb_favs", "rb_push"].forEach(k => localStorage.removeItem(k)); } catch {}
    location.replace("/");
  });
}
async function joinDevice(raw) {
  const code = String(raw || "").replace(/\D/g, "");
  if (code.length !== 6) { DEV.err = "Der Code hat 6 Ziffern."; return render(); }
  if (trips.length && !confirm("Dieses Gerät verbinden?\n\nDeine Reisen und Favoriten von hier kommen dazu – danach siehst du auf beiden Geräten dasselbe.")) return;
  DEV.busy = true; DEV.err = ""; render();
  try {
    await api("/api/link/join", { method: "POST", body: { code } });
    Object.assign(DEV, { join: false, input: "", busy: false, list: null });
    await syncFavs(true); await loadTrips().catch(() => {});
    flash = "Verbunden. Du siehst jetzt deine Reisen und Favoriten von allen Geräten.";
    openId = null; go("home");
  } catch (e) { DEV.busy = false; DEV.err = e.message; render(); }
}
// Favoriten mit dem Konto abgleichen (beim Start; nach dem Verbinden gilt die Liste vom Server)
let favSyncT = null;
async function syncFavs(serverWins = false) {
  try {
    const srv = await api("/api/favs");
    if (!serverWins && !srv.length && FAVS.length) { await api("/api/favs", { method: "PUT", body: FAVS }); return; }   // einmalig vom Gerät hochladen
    FAVS = srv; try { localStorage.setItem("rb_favs", JSON.stringify(FAVS)); } catch {}
  } catch {}
}

function pushCard() {
  if (!("serviceWorker" in navigator)) return "";
  const perm = "Notification" in window ? Notification.permission : "default";
  if (perm === "granted" && localStorage.getItem("rb_push") === "1") return "";
  if (isIOS && !standalone) return `<div class="banner info small"><b>Für Mitteilungen unterwegs:</b> In Safari „Teilen“ → „Zum Home-Bildschirm“, dann von dort öffnen.</div>`;
  if (perm === "denied") return `<div class="banner info small">Mitteilungen sind blockiert. Du kannst sie in den Browser-Einstellungen erlauben.</div>`;
  return `<div class="banner info push-ask row" style="align-items:center"><span style="flex:3"><b>Bescheid bekommen,</b> wenn dein Bus oder Zug ausfällt oder sich verspätet?</span><button class="btn small-btn" id="pushOn" style="flex:0 0 auto;width:auto;margin:0">Einschalten</button></div>`;
}

function bindCommon() {
  $app.querySelectorAll("[data-regstart]").forEach(b => b.onclick = () => { startWizard(); W.regIntent = true; go("add"); });
  $app.querySelectorAll("[data-pick]").forEach(b => b.onclick = async () => { b.disabled = true;
    await api(`/api/trips/${b.dataset.pick}/pick`, { method: "POST" }).catch(e => alert(e.message));
    flash = "Alles klar – ich überwache diese Fahrt und melde mich, wenn etwas nicht klappt."; await loadTrips().catch(() => {}); render(); scrollTo(0, 0); });
  $app.querySelectorAll("[data-unpick]").forEach(b => b.onclick = async () => { b.disabled = true;
    await api(`/api/trips/${b.dataset.unpick}/pick`, { method: "DELETE" }).catch(e => alert(e.message)); await loadTrips().catch(() => {}); render(); });
  $app.querySelectorAll("[data-linkjoin]").forEach(b => b.onclick = () => { DEV.join = true; DEV.err = ""; go("settings"); setTimeout(() => { document.getElementById("devices")?.scrollIntoView({ block: "center" }); document.getElementById("devIn")?.focus(); }, 80); });
  $app.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    if (!confirm("Fahrt löschen und nicht mehr überwachen?")) return;
    await api(`/api/trips/${b.dataset.del}`, { method: "DELETE" }).catch(e => alert(e.message));
    openId = null; sheetId = null; await loadTrips().catch(() => {}); render();
  });
  $app.querySelectorAll("[data-adopt]").forEach(b => b.onclick = async () => {
    const [id, k, idx, src] = b.dataset.adopt.split("|"), t = trips.find(x => x.id === id);
    if (src === "win") {   // Zeitfenster: einfach wählen, ohne Rückfrage
      b.disabled = true; b.textContent = "Wird übernommen …";
      await api(`/api/trips/${id}/adopt`, { method: "POST", body: { win: true, idx: +idx } }).catch(e => alert(e.message));
      flash = "Alles klar – ich überwache diese Fahrt und melde mich, wenn etwas nicht klappt."; await loadTrips().catch(() => {}); render(); scrollTo(0, 0); return;
    }
    const zbWarn = t && t.ticket === "spar" && !t.zbLifted && b.dataset.zb ? "\n\nAchtung Sparpreis: Das ist ein anderer Fernzug. Er gilt erst, wenn die Zugbindung aufgehoben ist – sonst kann ein neues Ticket fällig werden." : "";
    if (!confirm(`Diese Verbindung nehmen?\n\n${b.dataset.adoptText}${zbWarn}\n\nEs wird nichts gebucht. Ich überwache dann diese Verbindung – du kannst jederzeit zurück zum alten Plan.`)) return;
    b.disabled = true; b.textContent = "Wird umgestellt …";
    await api(`/api/trips/${id}/adopt`, { method: "POST", body: { k: +k, idx: +idx, here: src === "here", sos: src === "sos" } }).catch(e => alert(e.message));
    await loadTrips().catch(() => {}); render();
  });
  $app.querySelectorAll("[data-missed]").forEach(b => b.onclick = async () => {
    const [id, i] = b.dataset.missed.split("|");
    if (!b.closest(".seg-info") && !confirm("Nicht eingestiegen?\n\nIch suche dir sofort die nächsten Verbindungen ab deiner Einstiegs-Haltestelle.")) return;
    hereBusy = id; render();
    try { const v = await api(`/api/trips/${id}/missed`, { method: "POST", body: { i: +i } }); trips = trips.map(x => (x.id === id ? v : x)); } catch (e) { alert(e.message); }
    hereBusy = null; render(); scrollTo(0, 0);
  });
  $app.querySelectorAll("[data-caught]").forEach(b => b.onclick = async () => {
    const id = b.dataset.caught; b.disabled = true;
    try { const v = await api(`/api/trips/${id}/missed`, { method: "DELETE" }); trips = trips.map(x => (x.id === id ? v : x)); } catch (e) { alert(e.message); }
    render();
  });
  // SOS: Standort versuchen (höchstens 8 Sek.), sonst ohne – Suche läuft so oder so
  $app.querySelectorAll("[data-sos]").forEach(b => b.onclick = () => {
    const id = b.dataset.sos; sosBusy = id; render(); scrollTo(0, 0);
    const go = async pos => {
      try { const v = await api(`/api/trips/${id}/sos`, { method: "POST", body: pos ? { lat: pos.coords.latitude, lon: pos.coords.longitude } : {} }); trips = trips.map(x => (x.id === id ? v : x)); }
      catch (e) { alert(e.message); }
      sosBusy = null; render();
    };
    if (!navigator.geolocation) return go(null);
    navigator.geolocation.getCurrentPosition(go, () => go(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  });
  $app.querySelectorAll("[data-sosx]").forEach(b => b.onclick = async () => {
    const id = b.dataset.sosx; trips = trips.map(x => (x.id === id ? { ...x, sos: null } : x)); render();
    await api(`/api/trips/${id}/sos`, { method: "DELETE" }).catch(() => {});
  });
  $app.querySelectorAll("[data-hide]").forEach(b => b.onclick = async () => {
    const id = b.dataset.hide; trips = trips.map(x => (x.id === id ? { ...x, here: null } : x)); render();
    await api(`/api/trips/${id}/here`, { method: "DELETE" }).catch(() => {});
  });
  $app.querySelectorAll("[data-here]").forEach(b => b.onclick = async () => {
    const id = b.dataset.here;
    if (b.dataset.mode === "start" || b.dataset.mode === "next") {     // ab dem Start der Reise – ohne Standort
      hereBusy = id; render();
      try { const v = await api(`/api/trips/${id}/here`, { method: "POST", body: { mode: b.dataset.mode } }); trips = trips.map(x => (x.id === id ? v : x)); } catch (e) { alert(e.message); }
      hereBusy = null; return render();
    }
    if (!navigator.geolocation) return alert("Dein Gerät gibt keinen Standort heraus.");
    hereBusy = id; render();
    navigator.geolocation.getCurrentPosition(async pos => {
      try { const v = await api(`/api/trips/${id}/here`, { method: "POST", body: { lat: pos.coords.latitude, lon: pos.coords.longitude, mode: b.dataset.mode || "trip" } }); trips = trips.map(x => (x.id === id ? v : x)); }
      catch (e) { alert(e.message); }
      hereBusy = null; render();
    }, err => { hereBusy = null; render(); alert(err.code === 1 ? "Ohne Erlaubnis für den Standort kann ich nicht ab hier suchen. Du kannst sie in den Browser-Einstellungen erteilen." : "Standort gerade nicht verfügbar. Bitte gleich noch einmal versuchen."); },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });
  $app.querySelectorAll("[data-undo]").forEach(b => b.onclick = async () => {
    b.disabled = true;
    await api(`/api/trips/${b.dataset.undo}/undo`, { method: "POST" }).catch(e => alert(e.message));
    await loadTrips().catch(() => {}); render();
  });
  const p = document.getElementById("pushOn");
  if (p) p.onclick = () => enablePush().then(render).catch(e => alert(e.message));
}

// ---------- Reise anlegen (Assistent) ----------
// W = { step, legs: [], station, from (Zeit), list, train, error }
// Bestehende Reise ändern: Assistent mit Start, Ziel und Zeit der Reise vorbelegt
async function startEdit(t) {
  const first = t.legs[0].dep, last = t.legs[t.legs.length - 1].arr;
  const st = async s => s.eva ? { eva: s.eva, name: s.name } : s.lat != null ? { eva: "", name: s.name, lat: s.lat, lon: s.lon, stop: true } : (await api(`/api/stations?q=${encodeURIComponent(cleanStop(s.name))}`).catch(() => []))[0] || null;
  const [rFrom, rTo] = await Promise.all([st(first), st(last)]);
  W = { step: "route", mode: "route", legs: [], station: null, from: Date.now(), list: null, rFrom, rTo, when: Math.max(Date.now(), Date.parse(first.plan)), conns: null,
    editId: t.id, editTicket: t.ticket, minT: t.minT || 0 };
  go("add");
}
function startWizard() { W = { step: "route", mode: "route", legs: [], station: null, from: Date.now(), list: null, rFrom: null, rTo: null, when: Date.now(), conns: null }; }
const dur = m => (m >= 60 ? `${Math.floor(m / 60)} Std. ${m % 60} Min.` : `${m} Min.`);
// ---------- Datum & Uhrzeit: Schnellwahl + Monatskalender + Uhrzeit ----------
// key: Feld in W ("when" für Von–Nach, "from" für die Abfahrtstafel). W.cal = offener Kalender, W.calM = angezeigter Monat.
const PIN = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true" style="vertical-align:-2px;margin-right:4px"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>`;
const CAL_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" style="vertical-align:-3px;margin-right:8px"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`;
const startOfDay = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const sameDay = (a, b) => startOfDay(a) === startOfDay(b);
const hhmm = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
function whenPicker(key) {
  const v = W[key], now = Date.now();
  const label = sameDay(v, now) ? "Heute" : sameDay(v, now + 864e5) ? "Morgen" : new Date(v).toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short" });
  const quick = [[0, "Jetzt"], [30, "+30 Min."], [60, "+1 Std."], [120, "+2 Std."]];   // kurze Schnellwahl
  let cal = "";
  if (W.cal === key) {
    const m0 = new Date(W.calM || startOfDay(v)); m0.setDate(1); m0.setHours(0, 0, 0, 0);
    const first = (m0.getDay() + 6) % 7, days = new Date(m0.getFullYear(), m0.getMonth() + 1, 0).getDate(), today = startOfDay(now);
    const canPrev = m0.getTime() > today - 31 * 864e5 && new Date(m0.getFullYear(), m0.getMonth(), 0).getTime() >= today;
    const cells = [];
    for (let i = 0; i < first; i++) cells.push(`<span></span>`);
    for (let d = 1; d <= days; d++) {
      const ms = new Date(m0.getFullYear(), m0.getMonth(), d).getTime();
      cells.push(`<button class="cal-d${ms === today ? " today" : ""}${sameDay(ms, v) ? " sel" : ""}" data-day="${ms}" ${ms < today ? "disabled" : ""} aria-label="${new Date(ms).toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" })}">${d}</button>`);
    }
    cal = `<div class="cal" role="group" aria-label="Kalender">
      <div class="cal-h"><button class="cal-nav" data-calm="-1" ${canPrev ? "" : "disabled"} aria-label="Voriger Monat">‹</button>
        <b>${m0.toLocaleDateString("de-DE", { month: "long", year: "numeric" })}</b>
        <button class="cal-nav" data-calm="1" aria-label="Nächster Monat">›</button></div>
      <div class="cal-g">${["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map(x => `<span class="cal-w">${x}</span>`).join("")}${cells.join("")}</div></div>`;
  }
  return `<div class="chips">${quick.map(([m, l]) => `<button class="chip" data-q="${m}" aria-pressed="${Math.abs(v - (now + m * MIN)) < 2 * MIN}">${l}</button>`).join("")}</div>
    <div class="when-row"><button class="when-day" data-cal aria-expanded="${W.cal === key}">${CAL_ICON}${esc(label)}</button>
      <span class="when-time"><select id="whenH" aria-label="Stunde">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${new Date(v).getHours() === h ? "selected" : ""}>${String(h).padStart(2, "0")}</option>`).join("")}</select>
      <b>:</b><select id="whenM" aria-label="Minute">${Array.from({ length: 12 }, (_, i) => i * 5).map(m => `<option value="${m}" ${Math.floor(new Date(v).getMinutes() / 5) * 5 === m ? "selected" : ""}>${String(m).padStart(2, "0")}</option>`).join("")}</select>
</span></div>${cal}`;
}
function bindWhen(key, changed) {
  const set = ms => { W[key] = ms; changed(); render(); };
  $app.querySelectorAll("[data-q]").forEach(b => b.onclick = () => { W.cal = null; set(Date.now() + +b.dataset.q * MIN); });
  $app.querySelector("[data-cal]")?.addEventListener("click", () => { W.cal = W.cal === key ? null : key; W.calM = startOfDay(W[key]); render(); });
  const own = sel => [...$app.querySelectorAll(sel)].filter(b => !b.closest(".fav-days"));   // Kalender der Favoriten hat eigene Knöpfe
  own("[data-calm]").forEach(b => b.onclick = () => { const d = new Date(W.calM); d.setDate(1); d.setMonth(d.getMonth() + +b.dataset.calm); W.calM = d.getTime(); render(); });
  own("[data-day]").forEach(b => b.onclick = () => {
    const d = new Date(+b.dataset.day), t = new Date(W[key]); d.setHours(t.getHours(), t.getMinutes());
    W.cal = null; set(Math.max(d.getTime(), Date.now()));
  });
  const hs = document.getElementById("whenH"), ms = document.getElementById("whenM");
  const onT = () => { const d = new Date(W[key]); d.setHours(+hs.value, +ms.value, 0, 0); set(d.getTime()); };
  if (hs) { hs.onchange = onT; ms.onchange = onT; }
}
const localInput = ms => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60e3); return d.toISOString().slice(0, 16); };

const placeParam = s => (s.eva ? s.eva : `@${(+s.lat).toFixed(5)},${(+s.lon).toFixed(5)}`);
function stationField(id, label, val) {
  return val
    ? `<p class="small muted" style="margin:14px 0 4px">${label}</p><div class="row" style="align-items:center"><b style="flex:4">${esc(val.name)}${val.here ? ` <span class="small muted" style="font-weight:400">genau hier</span>` : val.stop ? ` <span class="small muted" style="font-weight:400">Haltestelle${val.area ? ` · ${esc(val.area)}` : ""}</span>` : ""}</b><button class="chip" data-clear="${id}" style="flex:0 0 auto">ändern</button></div>`
    : `<p class="small muted" style="margin:14px 0 4px">${label}</p><input type="search" id="${id}" placeholder="Bahnhof oder Haltestelle" autocomplete="off" enterkeyhint="search" value="${esc(W?.typed?.[id] || "")}">
      ${id === "rf" ? `<button class="chip here-chip" data-near="${id}">${PIN} Mein Standort</button>` : ""}<ul class="list" id="${id}Res"></ul>`;
}

// ---------- Favoriten: häufige Verbindungen (auf diesem Gerät gespeichert, ohne Anmeldung) ----------
let FAVS = []; try { FAVS = JSON.parse(localStorage.getItem("rb_favs") || "[]"); } catch {}
let FAV_OPEN = false; try { FAV_OPEN = localStorage.getItem("rb_favs_open") === "1"; } catch {}   // eingeklappt, bis man sie öffnet (wird gemerkt)
const saveFavs = () => { try { localStorage.setItem("rb_favs", JSON.stringify(FAVS)); } catch {}
  clearTimeout(favSyncT); favSyncT = setTimeout(() => api("/api/favs", { method: "PUT", body: FAVS }).catch(() => {}), 400); };
const berlinHM = iso => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const placeOfStop = s => (s.eva ? { eva: s.eva, name: s.name, lat: s.lat, lon: s.lon } : { eva: "", name: s.name, lat: s.lat, lon: s.lon, stop: true });
const favKey = (from, to, time) => `${from.eva || `${(+from.lat).toFixed(3)},${(+from.lon).toFixed(3)}`}>${to.eva || `${(+to.lat).toFixed(3)},${(+to.lon).toFixed(3)}`}@${time}`;
function favOfTrip(t) {
  const a = t.legs[0].dep, b = t.legs[t.legs.length - 1].arr, time = berlinHM(a.plan);
  return { id: favKey(a, b, time), from: placeOfStop(a), to: placeOfStop(b), time, trains: t.legs.map(l => nice(l)) };
}
const isFav = t => { const f = favOfTrip(t); return FAVS.some(x => x.id === f.id); };
function toggleFav(t) { const f = favOfTrip(t); FAVS = isFav(t) ? FAVS.filter(x => x.id !== f.id) : [f, ...FAVS].slice(0, 12); saveFavs(); }
// nächster Termin zur Lieblingsuhrzeit: heute, falls noch nicht vorbei, sonst morgen
// Tagauswahl für einen Favoriten: die nächsten 7 Tage als Knöpfe, sonst Kalender
function favDays(f) {
  const [h, m] = f.time.split(":").map(Number), days = [];
  for (let k = 0; k < 8 && days.length < 7; k++) { const d = new Date(); d.setDate(d.getDate() + k); d.setHours(h, m, 0, 0); if (d.getTime() > Date.now() - 2 * MIN) days.push(d.getTime()); }
  const lbl = ms => sameDay(ms, Date.now()) ? "Heute" : sameDay(ms, Date.now() + 864e5) ? "Morgen" : new Date(ms).toLocaleDateString("de-DE", { weekday: "short", day: "numeric" }).replace(",", "");
  return `<div class="fav-days"><p class="small muted" style="margin:6px 0">An welchem Tag? Ich suche die Fahrt um ${esc(f.time)}.</p><div class="day-grid">${days.map(ms => `<button class="chip" data-favday="${ms}">${lbl(ms)}</button>`).join("")}
      <button class="chip" data-favcal aria-pressed="${W.cal === "favwhen"}">${CAL_ICON.replace("margin-right:8px", "margin-right:3px")}Mehr</button></div>
    ${W.cal === "favwhen" ? whenPicker("favwhen").replace(/^[\s\S]*?<\/div>\s*<div class="when-row">[\s\S]*?<\/div>/, "") : ""}</div>`;
}
function nextAt(time) { const [h, m] = time.split(":").map(Number), d = new Date(); d.setHours(h, m, 0, 0); if (d.getTime() < Date.now() - 2 * MIN) d.setDate(d.getDate() + 1); return d.getTime(); }
const sameTrains = (c, fav) => fav && c.legs.map(l => l.label.replace(/\s/g, "")).join(">") === fav.trains.map(x => x.replace(/\s/g, "")).join(">")
  && Math.abs((Date.parse(c.legs[0].from.plan) - new Date(c.legs[0].from.plan).setHours(...fav.time.split(":").map(Number), 0, 0)) / MIN) <= 5;

function connList(list) {
  if (!list.length) return `<p class="muted">Keine Verbindung gefunden.</p><button class="btn sec" id="otherTime">Andere Zeit wählen</button>`;
  return `<ul class="list">${list.map((c, i) => {
    const late = Math.round((Date.parse(c.legs[0].from.rt || c.dep) - Date.parse(c.legs[0].from.plan)) / MIN), mine = sameTrains(c, W?.fav);
    return `<li><button data-c="${i}" class="${mine ? "fav-hit" : ""}">${mine ? `<span class="small fav-tag">★ Deine übliche Verbindung</span>` : ""}<div class="train" style="grid-template-columns:1fr auto">
      <span class="t">${hm(c.legs[0].from.rt || c.legs[0].from.plan)} → ${hm(c.legs[c.legs.length - 1].to.rt || c.legs[c.legs.length - 1].to.plan)}</span>
      <span class="pl">${dur(c.minutes)}</span>
      <span class="d" style="grid-column:1/3">${c.transfers ? `${c.transfers} Umstieg${c.transfers > 1 ? "e" : ""} · ` : "direkt · "}${c.legs.map(l => esc(l.label)).join(" → ")}${c.legs.some(l => l.cancelled) ? ` <span class="late">fällt aus</span>` : ""}</span>
      ${late >= 2 ? `<span class="small late" style="grid-column:1/3">${late} Min. später (geplant ${hm(c.legs[0].from.plan)})</span>` : ""}
      ${(() => { const own = W?.editId ? W.minT : MINT, bad = c.legs.slice(1).map((l, k) => ({ at: c.legs[k].to.name, g: Math.round((Date.parse(l.from.rt || l.from.plan) - Date.parse(c.legs[k].to.rt || c.legs[k].to.plan)) / MIN) }))
        .filter(x => x.g < Math.max(own, 2)).sort((a, b) => a.g - b.g)[0];
        return bad ? `<span class="small ${bad.g < 3 ? "late" : "warn-t"}" style="grid-column:1/3">${bad.g < 0 ? `Umstieg in ${esc(cleanStop(bad.at))} geht nicht` : `Umstieg in ${esc(cleanStop(bad.at))} ${bad.g} Min.${own > bad.g ? ` – weniger als deine ${own} Min.` : ""}`}</span>` : ""; })()}
    </div></button></li>`; }).join("")}</ul>`;
}

function renderWizard() {
  if (!W) startWizard();
  const n = W.legs.length, head = `<p class="steps">${W.editId ? "Reise ändern" : n ? `Teilstrecke ${n + 1}` : "Neue Reise"}</p>`;
  const back = `<button id="wBack" hidden aria-hidden="true"></button>`;   // Zurück steht oben in der Kopfleiste
  if (W.busy) { $app.innerHTML = `${head}<h1>${esc(W.busy)}</h1><div class="spinner"></div>`; return; }
  const err = W.error ? `<p class="err">${esc(W.error)}</p>` : "";

  if (W.step === "route") {
    // Schnell weg: Ziele, die du schon kennst, zum Antippen
    const dests = []; if (W.quick) for (const d of [...trips.filter(t => t.active !== false).map(t => t.legs[t.legs.length - 1].arr), ...FAVS.map(f => f.to)])
      if (d && (d.eva || d.lat != null) && !dests.some(x => plainStop(x.name) === plainStop(d.name)) && dests.length < 6) dests.push({ eva: d.eva || "", name: d.name, lat: d.lat, lon: d.lon });
    $app.innerHTML = `<p class="steps">${W.editId ? "Reise ändern" : W.quick ? "Schnell weg von hier" : W.regIntent ? "Arbeits- oder Schulweg" : "Neue Fahrt"}</p>
      ${W.quick ? `<h1>Wohin?</h1>${dests.length ? `<div class="rchips">${dests.map((d, i) => `<button class="rchip" data-qd="${i}">${esc(cleanStop(d.name))}</button>`).join("")}</div>` : ""}` : ""}
      ${!W.editId && FAVS.length ? `<section class="card favs"><button class="fav-head" data-favtoggle aria-expanded="${FAV_OPEN}"><span class="k" style="margin:0">★ Favoriten · ${FAVS.length}</span><span class="chev">${FAV_OPEN ? "▴" : "▾"}</span></button>${!FAV_OPEN ? "" : `<ul class="fav-list">${FAVS.map((f, i) => (i >= 3 && !W.favAll && W.favOpen !== i) ? "" : `<li class="fav-row ${W.favOpen === i ? "open" : ""}"><button data-fav="${i}" aria-expanded="${W.favOpen === i}">
        <span class="fav-time">${esc(f.time)}</span><span class="fav-main"><b>${esc(cleanStop(f.from.name))} → ${esc(cleanStop(f.to.name))}</b><span class="fav-sub">${esc(f.trains.join(" → "))}</span></span></button><button class="fav-del" data-favdel="${i}" aria-label="Favorit entfernen">✕</button></li>${W.favOpen === i ? `<li class="fav-days-li">${favDays(f)}</li>` : ""}`).join("")}</ul>
        ${FAVS.length > 3 && !W.favAll ? `<button class="link small" data-favall>Alle ${FAVS.length} Favoriten zeigen</button>` : ""}`}

</section>` : ""}
      ${W.quick ? "" : W.editId ? `<h1>Neue Verbindung für deine Reise</h1><p class="small muted">Ändere Uhrzeit, Datum, Start oder Ziel und wähle dann die passende Verbindung. Ticket und Umstiegszeit bleiben.</p>` : !W.impOpen ? `<h1>Wohin geht es?</h1>` : `<section class="card import">
        <div class="k">Schnell: Reise einfügen</div>
        <p class="small muted" style="margin-top:0">Screenshot aus dem DB Navigator, Ticket-PDF oder geteilter Text – ich lese die Züge selbst heraus.</p>
        <div class="row"><label class="btn" style="margin:4px 0">Foto, Screenshot oder PDF<input type="file" id="impFile" accept="image/*,application/pdf" multiple hidden></label>
          <button class="btn sec" id="impTextBtn" style="margin:4px 0">Text einfügen</button></div>
        ${W.showText ? `<textarea id="impText" rows="5" placeholder="Hier den geteilten Text oder die Buchungsbestätigung einfügen">${esc(W.impText || "")}</textarea>
          <div class="row"><button class="btn sec" id="impPaste" style="margin:4px 0">Aus Zwischenablage</button><button class="btn" id="impGo" style="margin:4px 0">Einlesen</button></div>` : ""}
      </section>
      <h1 style="margin-top:22px">Oder: Wohin geht es?</h1>`}

      ${stationField("rf", "Von", W.rFrom)}${stationField("rt", "Nach", W.rTo)}
      <p class="small muted" style="margin:14px 0 4px">Abfahrt</p>
      ${whenPicker("when")}
      ${W.editId || W.quick ? "" : `<p class="small muted" style="margin:14px 0 4px">Zeit, die ich mindestens zum Umsteigen brauche</p>${minTChips()}`}
      ${err}<button class="btn" id="go" ${W.rFrom && W.rTo ? "" : "disabled"}>Verbindungen suchen</button>
      <button class="btn quiet" id="byTrain">Direkt aus der Abfahrtstafel wählen</button>
      ${W.editId || W.impOpen || W.regIntent || W.quick ? "" : `<button class="btn quiet" id="impOpen">Ticket schon gebucht? Foto oder Text einfügen …</button>`}${back}`;
    document.getElementById("impOpen")?.addEventListener("click", () => { W.impOpen = true; render(); scrollTo(0, 0); });
    $app.querySelectorAll("[data-qd]").forEach(b => b.onclick = () => { W.rTo = dests[+b.dataset.qd]; W.when = Date.now(); if (W.rFrom) { W.conns = null; W.step = "conns"; } render(); });
    for (const [id, k] of [["rf", "rFrom"], ["rt", "rTo"]]) {
      const inp = document.getElementById(id); if (!inp) continue; let t;
      const find = () => searchInto(inp.value, `${id}Res`, st => { W[k] = st; if (W.typed) delete W.typed[id]; render(); }, true);
      inp.oninput = () => { (W.typed ||= {})[id] = inp.value; saveW(); clearTimeout(t); t = setTimeout(find, 250); };
      if (inp.value.trim().length >= 2) find();          // nach dem Neuzeichnen die Treffer wieder zeigen
    }
    // Von: Bahnhöfe in der Nähe des Standorts zur Auswahl
    $app.querySelectorAll("[data-near]").forEach(b => b.onclick = () => {
      if (!navigator.geolocation) return alert("Dein Gerät gibt keinen Standort heraus.");
      const ul = document.getElementById(`${b.dataset.near}Res`); ul.innerHTML = `<li><div class="spinner"></div></li>`;
      navigator.geolocation.getCurrentPosition(async pos => {
        try {
          const list = [{ eva: "", name: "Mein Standort", area: "genau hier", lat: pos.coords.latitude, lon: pos.coords.longitude, stop: true, dist: 0, here: true },
            ...await api(`/api/stations/near?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}`)];
          ul.innerHTML = list.length ? list.map((st, i) => `<li><button data-ns="${i}"><b>${esc(st.name)}</b><br><span class="small muted">${st.here ? "genau hier – mit Fußweg zur nächsten Haltestelle" : `ca. ${st.dist < 1000 ? `${Math.round(st.dist / 10) * 10} m` : `${(st.dist / 1000).toFixed(1).replace(".", ",")} km`} entfernt`}</span></button></li>`).join("")
            : `<li class="muted small">Kein Bahnhof in der Nähe gefunden – bitte Namen eingeben.</li>`;
          ul.querySelectorAll("[data-ns]").forEach(x => x.onclick = () => { W.rFrom = list[+x.dataset.ns]; if (W.typed) delete W.typed.rf; render(); });
        } catch (e) { ul.innerHTML = `<li class="err">${esc(e.message)}</li>`; }
      }, err => { ul.innerHTML = ""; alert(err.code === 1 ? "Ohne Erlaubnis für den Standort geht das nicht. Du kannst sie in den Browser-Einstellungen erteilen." : "Standort gerade nicht verfügbar."); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    });
    $app.querySelectorAll("[data-clear]").forEach(b => b.onclick = () => { W[b.dataset.clear === "rf" ? "rFrom" : "rTo"] = null; render(); });
    bindWhen("when", () => {});
    $app.querySelectorAll("[data-mt]").forEach(b => b.onclick = () => { setMinT(+b.dataset.mt); render(); });
    document.getElementById("go").onclick = () => { W.conns = null; W.error = ""; W.fav = null; W.step = "conns"; render(); };
    // Favorit antippen → Tag wählen → suchen (etwas vor der üblichen Uhrzeit, damit sie sicher dabei ist)
    const favSearch = (f, ms) => { W.when = Math.max(Date.now(), ms - 15 * MIN); W.rFrom = f.from; W.rTo = f.to; W.fav = f; W.favOpen = null; W.cal = null; W.conns = null; W.error = ""; W.step = "conns"; render(); };
    $app.querySelectorAll("[data-fav]").forEach(b => b.onclick = () => { const i = +b.dataset.fav; W.favOpen = W.favOpen === i ? null : i; W.cal = null; render(); });
    $app.querySelectorAll("[data-favday]").forEach(b => b.onclick = () => favSearch(FAVS[W.favOpen], +b.dataset.favday));
    $app.querySelector("[data-favcal]")?.addEventListener("click", () => { const f = FAVS[W.favOpen]; W.favwhen = nextAt(f.time); W.calM = W.favwhen; W.cal = W.cal === "favwhen" ? null : "favwhen"; render(); });
    // Tag im Kalender → gleich suchen
    $app.querySelectorAll(".fav-days [data-day]").forEach(b => b.onclick = () => {
      const f = FAVS[W.favOpen], [h, m] = f.time.split(":").map(Number), d = new Date(+b.dataset.day); d.setHours(h, m, 0, 0); favSearch(f, d.getTime()); });
    $app.querySelectorAll(".fav-days [data-calm]").forEach(b => b.onclick = () => { const d = new Date(W.calM); d.setDate(1); d.setMonth(d.getMonth() + +b.dataset.calm); W.calM = d.getTime(); render(); });
    $app.querySelector("[data-favtoggle]")?.addEventListener("click", () => { FAV_OPEN = !FAV_OPEN; W.favOpen = null; try { localStorage.setItem("rb_favs_open", FAV_OPEN ? "1" : "0"); } catch {} render(); });
    $app.querySelector("[data-favall]")?.addEventListener("click", () => { W.favAll = true; render(); });
    $app.querySelectorAll("[data-favdel]").forEach(b => b.onclick = () => { if (!confirm("Favorit entfernen?")) return; FAVS.splice(+b.dataset.favdel, 1); saveFavs(); render(); });
    document.getElementById("byTrain").onclick = () => { W.mode = "train"; W.step = "station"; W.error = ""; render(); };
    document.getElementById("impFile")?.addEventListener("change", e => importFiles([...e.target.files]));
    document.getElementById("impTextBtn")?.addEventListener("click", () => { W.showText = !W.showText; render(); });
    const it = document.getElementById("impText"); if (it) it.oninput = () => { W.impText = it.value; };
    const ip = document.getElementById("impPaste");
    if (ip) ip.onclick = async () => { try { W.impText = await navigator.clipboard.readText(); render(); } catch { alert("Einfügen bitte per langem Tippen ins Textfeld."); } };
    const ig = document.getElementById("impGo"); if (ig) ig.onclick = () => runImport({ text: W.impText || "" });
  }

  else if (W.step === "conns") {
    $app.innerHTML = `${head}<h1>${esc(W.rFrom.name)} → ${esc(W.rTo.name)}</h1><p class="muted small">${(W.editId ? W.minT : MINT) ? `Umstiege mind. ${W.editId ? W.minT : MINT} Min. · ` : ""}ab ${new Date(W.when).toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" })}</p>
      ${err}${W.conns && W.when > Date.now() + 5 * MIN ? `<button class="btn sec" id="earlierC">↑ Frühere Verbindungen</button>` : ""}
      <div>${W.conns ? connList(W.conns) : `<div class="spinner"></div>`}</div>
      ${W.conns?.length ? `<button class="btn sec" id="laterC">↓ Spätere Verbindungen</button>` : ""}${back}`;
    if (!W.conns) api(`/api/connections?from=${placeParam(W.rFrom)}&to=${placeParam(W.rTo)}&min=${W.editId ? W.minT : MINT}&time=${encodeURIComponent(new Date(W.when).toISOString())}`)
      .then(c => { W.conns = W.fav ? [...c.filter(x => sameTrains(x, W.fav)), ...c.filter(x => !sameTrains(x, W.fav))] : c; W.error = ""; }).catch(e => { W.conns = []; W.error = e.message; }).then(render);
    // eine Stunde früher suchen (nicht vor jetzt)
    const ec = document.getElementById("earlierC");
    if (ec) ec.onclick = () => { const first = W.conns[0] ? Date.parse(W.conns[0].legs[0].from.plan) : W.when; W.when = Math.max(Date.now(), Math.min(W.when, first) - 60 * MIN); W.conns = null; render(); };
    const lc = document.getElementById("laterC");
    if (lc) lc.onclick = () => { W.when = Date.parse(W.conns[W.conns.length - 1].legs[0].from.plan) + MIN; W.conns = null; render(); };
    $app.querySelectorAll("[data-c]").forEach(b => b.onclick = () => pickConnection(W.conns[+b.dataset.c]));
    document.getElementById("otherTime")?.addEventListener("click", () => { W.step = "route"; W.conns = null; render(); });
  }

  else if (W.step === "pickTrip") {
    const past = t => Date.parse(t.legs[t.legs.length - 1].to.plan) < Date.now();
    const future = W.imported.filter(t => !past(t));
    $app.innerHTML = `<p class="steps">Eingelesen</p><h1>${W.savedOne ? `${esc(W.savedOne)} ist angelegt. Auch die ${W.imported.length === 1 ? "andere Fahrt" : "anderen Fahrten"}?` : "Welche Fahrt?"}</h1>${W.note && !W.savedOne ? `<p class="small muted">${esc(W.note)}</p>` : ""}
      <ul class="list">${W.imported.map((t, i) => `<li><button data-it="${i}" ${past(t) ? "disabled" : ""}><b>${esc(t.label || `Fahrt ${i + 1}`)}</b>${past(t) ? ` <span class="late">schon vorbei</span>` : ""}<br>
        <span class="small muted">${esc(t.legs[0].from.name)} → ${esc(t.legs[t.legs.length - 1].to.name)} · ${new Date(t.legs[0].from.plan).toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" })}</span></button></li>`).join("")}</ul>
      ${future.length > 1 || (W.savedOne && future.length) ? `<button class="btn" id="allTrips">${future.length === 1 ? "Auch anlegen" : `Alle ${future.length} anlegen`}</button>` : ""}
      ${W.savedOne ? `<button class="btn quiet" id="doneImp">Nein, fertig</button>` : back}`;
    document.getElementById("doneImp")?.addEventListener("click", () => { W = null; go("home"); });
    $app.querySelectorAll("[data-it]").forEach(b => b.onclick = () => { W.multi = null; W.pickedIdx = +b.dataset.it; W.legs = W.imported[W.pickedIdx].legs; W.step = "leg"; render(); });
    const at = document.getElementById("allTrips");
    if (at) at.onclick = () => { W.multi = future.map(t => t.legs); W.legs = W.multi[0]; toTicket(); };
  }

  else if (W.step === "station") {
    $app.innerHTML = `${head}<h1>Wo steigst du ein?</h1><p class="small muted">Bahnhof oder Haltestelle (Bus, Tram, U-Bahn). Du wählst danach das Verkehrsmittel aus der Abfahrtstafel und deinen Ausstieg. Weitere Umstiege kannst du anhängen.</p>
      <input type="search" id="q" placeholder="Bahnhof oder Haltestelle" autocomplete="off" enterkeyhint="search" value="${esc(W.q || "")}">
      <button class="chip here-chip" data-nearst>${PIN} Mein Standort</button>
      ${err}<ul class="list" id="res"></ul>${back}`;
    const q = document.getElementById("q");
    const choose = s => { W.station = s; W.from = Date.now(); W.step = "trains"; W.list = null; render(); };
    let t; q.oninput = () => { clearTimeout(t); W.q = q.value; t = setTimeout(() => searchInto(q.value, "res", choose, true), 250); };
    // Haltestellen und Bahnhöfe in der Nähe
    $app.querySelector("[data-nearst]").onclick = () => {
      if (!navigator.geolocation) return alert("Dein Gerät gibt keinen Standort heraus.");
      const ul = document.getElementById("res"); ul.innerHTML = `<li><div class="spinner"></div></li>`;
      navigator.geolocation.getCurrentPosition(async pos => {
        try {
          const list = await api(`/api/stations/near?stops=1&lat=${pos.coords.latitude}&lon=${pos.coords.longitude}`);
          ul.innerHTML = list.length ? list.map((x, i) => `<li><button data-ns="${i}"><b>${esc(x.name)}</b><br><span class="small muted">${x.stop ? "Haltestelle · " : ""}ca. ${x.dist < 1000 ? `${Math.round(x.dist / 10) * 10} m` : `${(x.dist / 1000).toFixed(1).replace(".", ",")} km`}</span></button></li>`).join("") : `<li class="muted small">Nichts in der Nähe gefunden.</li>`;
          ul.querySelectorAll("[data-ns]").forEach(b => b.onclick = () => choose(list[+b.dataset.ns]));
        } catch (e) { ul.innerHTML = `<li class="err">${esc(e.message)}</li>`; }
      }, err => { ul.innerHTML = ""; alert(err.code === 1 ? "Ohne Erlaubnis für den Standort geht das nicht." : "Standort gerade nicht verfügbar."); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    };
    if (W.q) q.oninput();
  }

  else if (W.step === "trains") {
    const base = W.legs.length ? Date.parse(W.legs[n - 1].to.plan) : Date.now();
    $app.innerHTML = `${head}<h1>${W.station.eva ? "Welcher Zug" : "Was fährst du"} ab ${esc(W.station.name)}?</h1>
      ${W.legs.length ? `<p class="muted small">Ankunft dort laut Plan ${hm(W.legs[n - 1].to.plan)}.</p>` : whenPicker("from")}
      ${err}${W.list && W.from > Date.now() + 5 * MIN && !W.legs.length ? `<button class="btn sec" id="earlier">↑ Frühere Züge</button>` : ""}
      <div id="trains">${W.list ? trainList(W.list) : `<div class="spinner"></div>`}</div>
      ${W.list ? `<button class="btn sec" id="later">↓ Spätere Fahrten</button>` : ""}${back}`;
    if (!W.legs.length) bindWhen("from", () => { W.list = null; });
    const earlier = document.getElementById("earlier");
    if (earlier) earlier.onclick = () => { W.from = Math.max(Date.now(), W.from - 60 * MIN); W.list = null; render(); };
    const later = document.getElementById("later");
    if (later) later.onclick = () => { const l = W.list[W.list.length - 1]; W.from = l ? Date.parse(l.rt) + MIN : W.from + 60 * MIN; W.list = null; render(); };
    if (!W.list) {
      const from = W.legs.length ? Math.max(W.from, base) : W.from;
      const time = encodeURIComponent(new Date(from).toISOString());
      (async () => {
        const st = W.station;
        if (st.eva) return api(`/api/departures?eva=${st.eva}&time=${time}`);
        // Haltestelle ohne Kennung (z. B. Ausstieg der vorigen Fahrt): nächste Haltestelle am Ort nachschlagen
        if (!st.id && st.lat != null) { const n = (await api(`/api/stations/near?stops=1&lat=${st.lat}&lon=${st.lon}`)).find(x => x.stop || x.eva); if (n?.eva) { W.station = { ...st, eva: n.eva }; return api(`/api/departures?eva=${n.eva}&time=${time}`); } if (n) st.id = n.id; }
        if (!st.id) throw new Error("Für diese Haltestelle finde ich keine Abfahrten.");
        return api(`/api/stopdepartures?id=${encodeURIComponent(st.id)}&time=${time}`);
      })().then(l => { W.list = l; W.error = ""; }).catch(e => { W.list = []; W.error = e.message; }).then(render);
    }
    $app.querySelectorAll("[data-j]").forEach(b => b.onclick = () => { W.train = W.list[+b.dataset.j]; W.tripStops = null; W.step = "exit"; render(); });
  }

  else if (W.step === "exit" && W.train.tripId) {
    const tr = W.train;
    $app.innerHTML = `${head}<h1>Wo steigst du aus?</h1><p class="muted">${esc(tr.label)} ab ${hm(tr.rt)}${tr.platform ? ` · ${esc(tr.platform)}` : ""}</p>
      ${err}<div>${W.tripStops ? `<ul class="list">${W.tripStops.map((s, i) => `<li><button data-ts="${i}"><b>${esc(s.name)}</b> <span class="small muted">an ${hm(s.plan)}</span></button></li>`).join("") || `<li><p class="muted">Keine Halte bekannt.</p></li>`}</ul>` : `<div class="spinner"></div>`}</div>${back}`;
    if (!W.tripStops) api(`/api/tripstops?trip=${encodeURIComponent(tr.tripId)}&after=${encodeURIComponent(tr.plan)}`)
      .then(l => { W.tripStops = l; }).catch(e => { W.tripStops = []; W.error = e.message; }).then(render);
    $app.querySelectorAll("[data-ts]").forEach(b => b.onclick = () => {
      const s = W.tripStops[+b.dataset.ts], st = W.station;
      W.legs.push({ jid: "", tid: tr.tripId, label: tr.label, mode: tr.mode || "",
        from: { eva: st.eva || "", name: st.name, plan: tr.plan, platform: tr.platform || "", lat: st.lat, lon: st.lon, stopId: tr.stopId || st.id || "" },
        to: { eva: s.eva || "", name: s.name, plan: s.plan, platform: s.track || "", lat: s.lat, lon: s.lon, stopId: s.stopId || "" } });
      W.tripStops = null; W.step = "leg"; W.error = ""; render();
    });
  }

  else if (W.step === "exit") {
    const tr = W.train, stops = [...tr.via.filter(v => v.name), ...tr.direction.filter(d => d.name && !tr.via.some(v => v.eva === d.eva))];
    $app.innerHTML = `${head}<h1>Wo steigst du aus?</h1><p class="muted">${esc(tr.label)} ab ${hm(tr.rt)}${tr.platform ? `, ${esc(platWord(tr, tr.platform))}` : ""}</p>
      ${err}<ul class="list">${stops.map((s, i) => `<li><button data-s="${i}">${esc(s.name)}</button></li>`).join("") || `<li><p class="muted">Keine Halte bekannt.</p></li>`}</ul>
      <p class="small muted">Dein Bahnhof fehlt? Suche ihn:</p>
      <input type="search" id="q2" placeholder="Ausstiegsbahnhof" autocomplete="off"><ul class="list" id="res2"></ul>${back}`;
    const pick = s => resolveLeg(s, stops.some(x => x.eva === s.eva));
    $app.querySelectorAll("[data-s]").forEach(b => b.onclick = () => pick(stops[+b.dataset.s]));
    const q2 = document.getElementById("q2"); let t;
    q2.oninput = () => { clearTimeout(t); t = setTimeout(() => searchInto(q2.value, "res2", pick), 250); };
  }

  else if (W.step === "leg") {
    const tight = W.legs.slice(1).map((l, i) => ({ at: W.legs[i].to.name, gap: Math.round((Date.parse(l.from.plan) - Date.parse(W.legs[i].to.plan)) / MIN) }))
      .filter(x => x.gap < Math.max(MINT, 5) + 3).sort((a, b) => a.gap - b.gap)[0];
    $app.innerHTML = `${head.replace(/Teilstrecke \d+|Neue Reise/, "Deine Reise")}<h1>Passt das so?</h1>
      <p class="muted small">${new Date(W.legs[0].from.plan).toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Berlin" })}</p>${W.note ? `<p class="small muted">${esc(W.note)}</p>` : ""}
      ${tight ? `<div class="banner info small"><b>Knapper Umstieg in ${esc(cleanStop(tight.at))}: ${Math.max(0, tight.gap)} Min.</b> Nach dem Anlegen zeige ich dir Verbindungen, die etwas früher losfahren oder mehr Luft haben, und beobachte sie mit.</div>` : ""}
      <div class="card"><ol class="tl">${W.legs.map(l => `<li><span class="dot"></span><div class="stop">${esc(l.from.name)} → ${esc(l.to.name)}</div>
        <div class="when">${esc(l.label)} · ab ${hm(l.from.plan)}${l.from.platform ? ` · ${esc(platWord(l, l.from.platform))}` : ""} · an ${l.to.estimated ? "≈" : ""}${hm(l.to.plan)}${l.to.platform ? ` · ${esc(platWord(l, l.to.platform))}` : ""}</div>
        ${l.jid || l.tid ? "" : `<div class="small muted">Live-Zeiten, soweit der Verkehrsbetrieb sie liefert</div>`}</li>`).join("")}</ol></div>
      <button class="btn" id="done">${W.editId ? "Reise so ändern" : "Fertig – weiter"}</button>
      ${W.mode !== "train" ? "" : `<button class="btn sec" id="more">Umstieg in ${esc(W.legs[n - 1].to.name)} hinzufügen</button>`}
      ${W.mode === "import" ? `<button class="btn quiet" id="undo">Nicht anlegen</button>` : W.mode === "route" ? `<button class="btn quiet" id="undo">Andere Verbindung wählen</button>` : `<button class="btn quiet" id="undo">Letzte Teilstrecke entfernen</button>`}${back}`;
    document.getElementById("done").onclick = () => { if (W.editId) return saveTrip(W.editTicket); if (canRegular()) { W.step = "regular"; render(); } else toTicket(); };
    if (document.getElementById("more")) document.getElementById("more").onclick = () => { const l = W.legs[n - 1]; W.station = { eva: l.to.eva, name: l.to.name, lat: l.to.lat, lon: l.to.lon }; W.from = Date.parse(l.to.plan); W.list = null; W.step = "trains"; render(); };
    document.getElementById("undo").onclick = () => { if (W.mode === "import") { W.legs = []; W.step = W.imported?.length > 1 ? "pickTrip" : "route"; } else if (W.mode === "route") { W.legs = []; W.step = "conns"; } else { W.legs.pop(); W.step = W.legs.length ? "leg" : "station"; } render(); };
    return;
  }

  else if (W.step === "regular") {
    // Vor dem Ticket: regelmäßig überwachen? (z. B. Arbeitsweg) – mit Tagen und genauer Abfahrt oder Zeitfenster
    const l0 = W.legs[0], dep = Date.parse(l0.from.plan), depHm = hm(dep), dow = ((new Date(new Date(dep).toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" }) + "T12:00:00Z").getUTCDay() + 6) % 7) + 1;
    if (!W.reg) {
      const wk = dow <= 5, quick = wk ? "Mo–Fr" : DOW[dow - 1];
      // Über „Mein Weg“ gekommen: es ist schon klar, dass es regelmäßig ist – nur noch die Tage
      $app.innerHTML = `<p class="steps">${W.regIntent ? "Mein Weg" : "Deine Fahrt"}</p><h1>${W.regIntent ? "An welchen Tagen?" : "Fährst du das öfter?"}</h1>
        <p class="muted small">${esc(cleanStop(l0.from.name))} → ${esc(cleanStop(W.legs[W.legs.length - 1].to.name))}, ab ${depHm}</p>
        <button class="btn big-btn" id="regQuick">${W.regIntent ? `${quick} um ${depHm}` : `Ja, ${quick} überwachen`}</button>
        ${W.regIntent ? "" : `<button class="btn sec" id="regNo">Nur dieses Mal</button>`}
        <button class="btn quiet" id="regYes">Andere Tage oder Zeitfenster …</button>${back}`;
      document.getElementById("regNo")?.addEventListener("click", () => { W.reg = null; toTicket(); });
      document.getElementById("regQuick").onclick = () => { W.reg = { name: "", days: wk ? [1, 2, 3, 4, 5] : [dow], kind: "fix", from: "", to: "", hol: true }; toTicket(); };
      document.getElementById("regYes").onclick = () => {
        const p = x => String(x).padStart(2, "0"), d = new Date(dep), mins = +depHm.slice(0, 2) * 60 + +depHm.slice(3), a = Math.max(0, Math.floor((mins - 15) / 15) * 15), b = Math.min(23 * 60 + 59, a + 60);
        W.reg = { name: "", days: dow <= 5 ? [1, 2, 3, 4, 5] : [dow], kind: "fix", from: `${p(Math.floor(a / 60))}:${p(a % 60)}`, to: `${p(Math.floor(b / 60))}:${p(b % 60)}`, hol: true };
        render(); };
    } else {
      const R = W.reg;
      $app.innerHTML = `<p class="steps">Deine Reise</p><h1>Regelmäßig überwachen</h1>
        <p class="muted small">${esc(cleanStop(l0.from.name))} → ${esc(cleanStop(W.legs[W.legs.length - 1].to.name))}</p>${err}
        <label class="small" for="wrName">Name</label>
        <input class="txt" id="wrName" maxlength="40" placeholder="z. B. Schule oder Arbeit" value="${esc(R.name)}">
        <p class="small" style="margin:6px 0 0">An welchen Tagen?</p>${dayChips(R.days, "data-wrd")}
        <p class="small" style="margin:8px 0 4px">Welche Abfahrt?</p>
        <ul class="list"><li><button data-wrk="fix" aria-pressed="${R.kind === "fix"}"><b>${R.kind === "fix" ? "● " : "○ "}Genau diese: ${depHm}</b><br><span class="small muted">Immer dieselbe Verbindung</span></button></li>
          <li><button data-wrk="win" aria-pressed="${R.kind === "win"}"><b>${R.kind === "win" ? "● " : "○ "}In einem Zeitfenster</b><br><span class="small muted">Ich zeige dir alle Fahrten darin – du tippst an, welche du nimmst</span></button></li></ul>
        ${R.kind === "win" ? `<div class="win-row"><input type="time" id="wrFrom" value="${esc(R.from)}"><span>bis</span><input type="time" id="wrTo" value="${esc(R.to)}"></div>` : ""}
        <label class="small chk"><input type="checkbox" id="wrHol" ${R.hol ? "checked" : ""}> An Feiertagen (Berlin) nicht fahren</label>
        <button class="btn" id="wrNext">Weiter</button>
        <button class="btn quiet" id="wrCancel">Doch nicht regelmäßig</button>${back}`;
      const keep = () => { R.name = document.getElementById("wrName").value; R.from = document.getElementById("wrFrom")?.value || R.from; R.to = document.getElementById("wrTo")?.value || R.to; R.hol = document.getElementById("wrHol").checked; };
      $app.querySelectorAll("[data-wrd]").forEach(b => b.onclick = () => { keep(); const d = +b.dataset.wrd; R.days = R.days.includes(d) ? R.days.filter(x => x !== d) : [...R.days, d].sort(); render(); });
      $app.querySelectorAll("[data-wrk]").forEach(b => b.onclick = () => { keep(); R.kind = b.dataset.wrk; render(); });
      document.getElementById("wrCancel").onclick = () => { W.reg = null; toTicket(); };
      document.getElementById("wrNext").onclick = () => { keep();
        if (!R.days.length) { W.error = "Bitte mindestens einen Tag wählen."; return render(); }
        if (R.kind === "win" && !(R.to > R.from)) { W.error = "Das Ende des Zeitfensters muss nach dem Beginn liegen."; return render(); }
        W.error = ""; toTicket(); };
    }
  }

  else if (W.step === "ticket") {
    const opts = [["spar", "Sparpreis / Super Sparpreis", "Mit Zugbindung – ich sage dir, wann sie voraussichtlich aufgehoben ist."],
      ["flex", "Flexpreis", "Freie Zugwahl auf der Strecke."], ["dticket", "Deutschlandticket", "Nur Nahverkehr."], ["bc100", "BahnCard 100", "Freie Zugwahl."]];
    $app.innerHTML = `<p class="steps">Fast fertig</p><h1>Welches Ticket hast du?</h1><p class="muted small">Nur für den Hinweis zur Zugbindung. Es wird nichts gekauft oder gebucht.</p>
      ${err}<ul class="list">${opts.map(([k, t, d]) => `<li><button data-t="${k}"><b>${t}</b>${W.ticketGuess === k ? ` <span class="chip-t">erkannt</span>` : ""}<br><span class="small muted">${d}</span></button></li>`).join("")}</ul>${back}`;
    $app.querySelectorAll("[data-t]").forEach(b => b.onclick = () => saveTrip(b.dataset.t));
  }

  const bk = document.getElementById("wBack");
  if (bk) bk.onclick = () => {
    W.error = "";
    if (W.step === "route") { W = null; return go("home"); }
    if (W.step === "station") { if (W.mode === "train" && !W.legs.length) W.step = "route"; else { W = null; return go("home"); } }
    else if (W.step === "conns") W.step = "route";
    else if (W.step === "trains") W.step = W.legs.length ? "leg" : "station";
    else if (W.step === "exit") W.step = "trains";
    else if (W.step === "ticket") W.step = W.multi ? "pickTrip" : canRegular() ? "regular" : "leg";
    else if (W.step === "regular") { if (W.reg) W.reg = null; else W.step = "leg"; }   // Formular → Frage → Verbindung
    else if (W.step === "leg" && W.mode === "route") { W.legs = []; W.step = "conns"; }
    else if (W.step === "leg" && W.mode === "import") { W.legs = []; W.step = W.imported?.length > 1 ? "pickTrip" : "route"; }
    else if (W.step === "leg") { W.legs.pop(); W.list = null; W.step = "trains"; }   // Zug aus der Abfahrtstafel: diese Teilstrecke neu wählen
    else if (W.step === "pickTrip") W.step = "route";
    render();
  };
}

function trainList(list) {
  if (!list.length) return `<p class="muted">Keine Abfahrten in diesem Zeitraum gefunden.</p>`;
  return `<ul class="list">${list.map((e, i) => `<li><button data-j="${i}" ${e.cancelled ? "disabled" : ""}><div class="train">
    <span class="t">${hm(e.rt)}</span><span class="l">${esc(e.label)}${e.cancelled ? ` <span class="late">fällt aus</span>` : ""}</span>
    <span class="pl">${esc(platWord(e, e.platform))}</span>
    <span class="d">${e.rt !== e.plan && Date.parse(e.rt) - Date.parse(e.plan) >= MIN ? `<span class="late">+${Math.round((Date.parse(e.rt) - Date.parse(e.plan)) / MIN)}</span> · ` : ""}nach ${esc(e.direction.map(d => d.name).filter(Boolean).join(" / ") || "?")}</span>
  </div></button></li>`).join("")}</ul>`;
}

// stops: auch Bus-/Tram-/U-Bahn-Haltestellen anbieten (nur bei „Von – Nach“; die Abfahrtstafel braucht einen DB-Bahnhof)
async function searchInto(q, id, onPick, stops = false) {
  const el = document.getElementById(id); if (!el) return;
  if (q.trim().length < 2) { el.innerHTML = ""; return; }
  try {
    const res = await api(`/api/stations?q=${encodeURIComponent(q)}${stops ? "&stops=1" : ""}`);
    el.innerHTML = res.length ? res.map((s, i) => `<li><button data-i="${i}">${esc(s.name)}${s.stop ? `<br><span class="small muted">Haltestelle${s.area ? ` · ${esc(s.area)}` : ""}</span>` : ""}</button></li>`).join("")
      : `<li><p class="muted small">${stops ? "Nichts gefunden." : "Kein Bahnhof gefunden."}</p></li>`;
    el.querySelectorAll("[data-i]").forEach(b => b.onclick = () => onPick(res[+b.dataset.i]));
  } catch (e) { el.innerHTML = `<li><p class="err">${esc(e.message)}</p></li>`; }
}

// Bild verkleinern (spart Zeit und KI-Kosten), PDF unverändert
function fileToPayload(f) {
  return new Promise((ok, no) => {
    if (f.type === "application/pdf") {
      if (f.size > 5e6) return no(new Error("PDF ist zu groß (max. 5 MB)."));
      const r = new FileReader(); r.onload = () => ok({ type: f.type, data: String(r.result).split(",")[1] }); r.onerror = () => no(new Error("PDF nicht lesbar")); r.readAsDataURL(f); return;
    }
    const img = new Image(), url = URL.createObjectURL(f);
    img.onload = () => { const k = Math.min(1, 1800 / Math.max(img.width, img.height)), c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); ok({ type: "image/jpeg", data: c.toDataURL("image/jpeg", 0.85).split(",")[1] }); };
    img.onerror = () => no(new Error("Bild nicht lesbar")); img.src = url;
  });
}
async function importFiles(files) {
  try { runImport({ files: await Promise.all(files.slice(0, 3).map(fileToPayload)), text: W.impText || "" }); }
  catch (e) { W.error = e.message; render(); }
}
async function runImport(body) {
  W.busy = "Ich lese deine Reise …"; W.error = ""; render();
  try {
    const r = await api("/api/import", { method: "POST", body });
    W.ticketGuess = r.ticket; W.note = r.note; W.mode = "import"; W.imported = r.trips;
    if (!r.trips.length) W.error = `Ich konnte darin keine Verbindung erkennen.${r.note ? " " + r.note : ""} Versuch einen Screenshot der Reiseübersicht.`;
    else if (r.trips.length === 1) { W.legs = r.trips[0].legs; W.step = "leg"; }
    else W.step = "pickTrip";
  } catch (e) { W.error = e.message; }
  W.busy = null; render();
}

async function pickConnection(c) {
  W.busy = "Verbindung wird vorbereitet …"; render();
  try { W.legs = await api("/api/resolve", { method: "POST", body: { legs: c.legs } }); W.step = "leg"; W.error = ""; }
  catch (e) { W.error = e.message; }
  W.busy = null; render();
}

async function resolveLeg(stop, onRoute = true) {
  const tr = W.train;
  W.busy = `Suche die Ankunft in ${stop.name} …`; render();
  try {
    const leg = await api("/api/leg", { method: "POST", body: { jid: tr.jid, label: tr.label, toEva: stop.eva, toName: stop.name, onRoute,
      from: { eva: tr.eva || W.station.eva, name: W.station.name, plan: tr.plan, platform: tr.platformPlan || tr.platform } } });
    if (!leg.to.name) leg.to.name = stop.name;
    W.legs.push(leg); W.step = "leg"; W.error = "";
  } catch (e) { W.error = e.message; }
  W.busy = null; render();
}

async function saveTrip(ticket) {
  if (W.editId) {
    const id = W.editId, minT = W.minT;
    W.busy = "Reise wird geändert …"; render();
    try {
      await api(`/api/trips/${id}`, { method: "PUT", body: { legs: W.legs.map(l => ({ ...l, minT })), ticket } });
      flash = "Reise geändert. Ich überwache jetzt die neue Verbindung.";
      W = null; await loadTrips(); openId = id; sheetId = null; return go("home");
    } catch (e) { W.busy = null; W.error = e.message; return render(); }
  }
  W.busy = "Reise wird angelegt …"; render();
  try {
    let newId = null;
    for (const legs of W.multi || [W.legs]) newId = (await api("/api/trips", { method: "POST", body: { legs: legs.map(l => ({ ...l, minT: MINT })), ticket } })).id || newId;
    if (W.reg && newId && !W.multi) {
      // gleich regelmäßig: genaue Abfahrt (aus dieser Reise) oder Zeitfenster (Start/Ziel dieser Reise)
      const R = W.reg, f = W.legs[0].from, t = W.legs[W.legs.length - 1].to;
      const r = await api("/api/routines", { method: "POST", body: R.kind === "win"
        ? { tripId: newId, from: f, to: t, name: R.name.trim(), days: R.days, winFrom: R.from, winTo: R.to, ticket, holidays: R.hol, minT: MINT }
        : { tripId: newId, name: R.name.trim(), days: R.days, holidays: R.hol } }).catch(e => { alert(`Die Reise ist angelegt, aber regelmäßig ging nicht: ${e.message}`); return null; });
      if (r) {
        ROUTINES = await api("/api/routines").catch(() => ROUTINES);
        flash = `Gespeichert: „${r.name}“, ${daysText(r.days)} ${r.win ? `${r.win[0]}–${r.win[1]}` : r.dep}. Die Fahrt erscheint jeweils ein paar Stunden vorher hier.`;
        W = null; await loadTrips(); openId = null; return go("home");
      }
    }
    if (W.mode === "import" && !W.multi && W.imported?.length > 1 && W.pickedIdx != null) {
      const done = W.imported[W.pickedIdx];
      W.savedOne = done.label || "Die Fahrt";
      W.imported = W.imported.filter((_, i) => i !== W.pickedIdx);
      W.pickedIdx = null; W.ticketGuess = ticket; W.busy = null; W.step = "pickTrip";
      await loadTrips().catch(() => {}); return render();
    }
    const n = (W.multi || [W.legs]).length;
    flash = n > 1 ? `${n} Reisen angelegt. Ich melde mich, wenn du etwas tun solltest.` : "Reise angelegt. Ich melde mich, wenn du etwas tun solltest.";
    W = null; await loadTrips(); openId = n > 1 ? null : newId; go("home");
  } catch (e) { W.busy = null; W.error = e.message; render(); }
}

// ---------- Mitteilungen ----------
const unb64u = s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
async function enablePush() {
  const cfg = await api("/api/config");
  if (!cfg.vapid) throw new Error("Mitteilungen sind auf dem Server noch nicht eingerichtet.");
  if (await Notification.requestPermission() !== "granted") throw new Error("Ohne Erlaubnis kann ich dich unterwegs nicht benachrichtigen.");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(cfg.vapid) });
  await api("/api/push", { method: "POST", body: sub.toJSON() });
  localStorage.setItem("rb_push", "1");
  await api("/api/push/test", { method: "POST" }).catch(() => {});
}

// ---------- Start ----------
// Neue Version automatisch laden: beim Zurückkehren in die App nach Updates schauen; übernimmt der neue Service Worker, Seite neu laden
if ("serviceWorker" in navigator) {
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("/sw.js").then(reg => {
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
    setInterval(() => reg.update().catch(() => {}), 30 * MIN);
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (!had || reloading || W?.busy) return; reloading = true; location.reload(); });
}
document.addEventListener("click", e => { if (e.target.closest('[data-go="add"]')) { startWizard(); } }, true);
$app.innerHTML = `<div class="spinner"></div>`;
async function takeShared() {
  if (!new URLSearchParams(location.search).has("share")) return;
  history.replaceState(null, "", "/");
  try {
    const c = await caches.open("rb-share"), meta = await (await c.match("/share-meta"))?.json().catch(() => null);
    if (!meta) return;
    const files = [];
    for (const k of meta.files || []) { const r = await c.match(k); if (r) files.push(new File([await r.blob()], "geteilt", { type: r.headers.get("Content-Type") || "image/jpeg" })); }
    await caches.delete("rb-share");
    startWizard(); W.impOpen = true; view = "add";
    const text = [meta.title, meta.text, meta.url].filter(Boolean).join("\n");
    if (files.length) { W.impText = text; importFiles(files); } else if (text) runImport({ text });
  } catch {}
}
try { const w = JSON.parse(sessionStorage.getItem("rb_w") || "null"); if (w?.step) { W = w; view = "add"; } } catch {}
// Aus einer Meldung geöffnet: gleich die betroffene Reise zeigen
const tripFromUrl = u => { try { return new URL(u, location.origin).searchParams.get("trip"); } catch { return null; } };
const startTrip = tripFromUrl(location.href);
if (startTrip) { openId = startTrip; sheetId = null; openLeg = null; if (view !== "add") view = "home"; history.replaceState(null, "", "/"); }
navigator.serviceWorker?.addEventListener("message", async e => {
  const id = e.data?.open && tripFromUrl(e.data.open);
  if (!id) return;
  if (view === "add" && W && (W.legs?.length || W.rFrom || W.imported)) return;   // laufende Eingabe nicht verwerfen
  W = null; openId = id; sheetId = null; openLeg = null;
  await loadTrips().catch(() => {});
  go("home");
});
// Link „/?link=123456“ von einem anderen Gerät: gleich zum Verbinden
const linkCode = new URLSearchParams(location.search).get("link");
if (linkCode) { history.replaceState(null, "", "/"); view = "settings"; DEV.join = true; DEV.input = linkCode; }
loadTrips().then(() => { render(); schedule(); takeShared(); syncFavs().then(() => { if (view === "add") render(); }); syncPrefs().then(ch => { if (ch) render(); });
  if (linkCode) setTimeout(() => joinDevice(linkCode), 300); },
  e => { $app.innerHTML = `<p class="err">${esc(e.message)}</p><button class="btn sec" onclick="location.reload()">Noch einmal versuchen</button>`; });
