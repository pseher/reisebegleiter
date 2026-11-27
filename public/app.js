// Reisebegleiter – App (Vanilla JS, ohne Pakete)
const $app = document.getElementById("app");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hm = iso => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const MIN = 60e3;
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

// ---------- Eigene Rückfragen statt der Browser-Fenster (kein Popup, wird nicht blockiert) ----------
// ask("Titel\n\nText", { ok, cancel, danger }) → Promise<boolean>; ohne cancel ist es ein reiner Hinweis
// ask("Name", { input: "Vorgabe" }) → Promise<string|null> (Eingabefeld statt Browser-prompt)
function ask(text, { ok = "OK", cancel = "Abbrechen", danger = false, input = null, alt = null } = {}) {
  return new Promise(res => {
    const [title, ...rest] = String(text).split("\n\n"), body = rest.join("\n\n");
    const prev = document.activeElement, wrap = document.createElement("div"), opened = Date.now();
    wrap.className = "dlg-wrap"; wrap.setAttribute("role", "presentation");
    wrap.innerHTML = `<div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlgT"${body ? ' aria-describedby="dlgB"' : ""}>
      <h2 id="dlgT">${esc(title)}</h2>${body ? `<p id="dlgB">${esc(body).replace(/\n/g, "<br>")}</p>` : ""}
      ${input != null ? `<input type="text" class="dlg-in" maxlength="40" value="${esc(input)}" aria-label="${esc(title)}">` : ""}
      <div class="dlg-btns${alt ? " three" : ""}">${cancel ? `<button class="btn mini quiet" data-no>${esc(cancel)}</button>` : ""}${alt ? `<button class="btn sec" data-alt>${esc(alt)}</button>` : ""}<button class="btn ${danger ? "danger-fill" : ""}" data-yes>${esc(ok)}</button></div></div>`;
    const inp = wrap.querySelector(".dlg-in");
    const done = v => { wrap.remove(); SCREEN_AT = Date.now(); document.removeEventListener("keydown", key, true); removeEventListener("popstate", pop); prev?.focus?.(); res(input != null ? (v ? inp.value.trim() : null) : v); };
    const key = e => {
      if (e.key === "Escape") { e.preventDefault(); done(false); }
      else if (e.key === "Enter" && inp && document.activeElement === inp) { e.preventDefault(); done(true); }
      else if (e.key === "Tab") {   // Fokus bleibt im Fenster
        const f = [...wrap.querySelectorAll("button, input")], k = f.indexOf(document.activeElement);
        e.preventDefault(); f[(k + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      }
    };
    const pop = () => done(false);   // Handy-Zurück schließt die Rückfrage
    const fresh = () => Date.now() - opened < 300;   // Doppeltipp vom Knopf darunter nicht als Antwort werten
    wrap.addEventListener("click", e => { if (e.target === wrap && !fresh()) done(false); });
    wrap.querySelector("[data-yes]").onclick = () => { if (!fresh()) done(true); };
    wrap.querySelector("[data-no]")?.addEventListener("click", () => { if (!fresh()) done(false); });
    wrap.querySelector("[data-alt]")?.addEventListener("click", () => { if (!fresh()) done("alt"); });
    document.addEventListener("keydown", key, true); addEventListener("popstate", pop, { once: true });
    document.body.appendChild(wrap);
    (inp || wrap.querySelector("[data-no]") || wrap.querySelector("[data-yes]")).focus();   // sicherer Knopf vorausgewählt
    if (inp) inp.select();
  });
}
const alert = msg => ask(msg, { cancel: null });

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
  catch (e) { if (e?.name === "AbortError") throw new Error("Das hat zu lange gedauert – das Netz ist gerade schwach oder der Dienst hakt. Bitte noch einmal versuchen."); if (e instanceof TypeError) throw new Error("Keine Verbindung zum Internet. Bitte gleich noch einmal versuchen."); throw e; }
}
// Erst anmelden, wenn jemand die App wirklich nutzt (sucht, anlegt …) – bloßes Öffnen, Vorschau-Bots oder Testaufrufe zählen so nicht als Nutzer
const EMPTY = { "/api/trips": [], "/api/routines": [], "/api/favs": [], "/api/prefs": {}, "/api/places": [], "/api/devices": [] };
async function api0(path, { method = "GET", body } = {}, retry = true) {
  if (!AUTH && method === "GET" && path in EMPTY) return structuredClone(EMPTY[path]);
  if (!AUTH) await register();
  const ac = new AbortController(), to = setTimeout(() => ac.abort(), 45000);   // nie endlos warten (z. B. Netz weg, Server hängt)
  const r = await fetch(path, { signal: ac.signal, method, headers: { Authorization: `Bearer ${AUTH.id}.${AUTH.token}`, ...(standalone ? { "X-RB-App": "1" } : {}), "X-RB-Env": `${typeof BNAME === "function" ? BNAME() : ""}|${typeof pushHere === "function" && pushHere() ? 1 : 0}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401 && retry) { AUTH = null; try { localStorage.removeItem("rb_auth"); } catch {} return api0(path, { method, body }, false); }   // Gerät unbekannt (z. B. aufgeräumt): neu anfangen
  const data = await r.json().catch(() => ({})); clearTimeout(to);
  if (!r.ok) throw new Error(data.error || `Fehler ${r.status}`);
  return data;
}

// Eigene Mindest-Umstiegszeit (Minuten, 0 = wie vom Fahrplan geplant)
const MINT_OPTS = [[0, "wie geplant"], [5, "5 Min."], [8, "8 Min."], [10, "10 Min."], [15, "15 Min."]];
let MINT = 5; try { const v = localStorage.getItem("rb_mint"); if (v != null) MINT = +v; } catch {}
const setMinT = (m, sync = true) => { MINT = m; try { localStorage.setItem("rb_mint", String(m)); } catch {} if (sync) api("/api/prefs", { method: "PUT", body: { minT: m } }).catch(() => {}); };
// Einstellungen des Kontos (gleich auf allen verbundenen Geräten)
async function syncPrefs() { try { const p = await api("/api/prefs");
  if (p && Array.isArray(p.places) && JSON.stringify(p.places) !== JSON.stringify(PLACES)) { PLACES = p.places; try { localStorage.setItem("rb_places", JSON.stringify(PLACES)); } catch {} if (view === "add" && W?.step === "route") render(); }
  if (p && Number.isFinite(p.minT) && p.minT !== MINT) { setMinT(p.minT, false); return true; }
  if (p && p.minT == null && AUTH) api("/api/prefs", { method: "PUT", body: { minT: MINT } }).catch(() => {}); } catch {} return false; }
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
const go = v => { view = v; render(); scrollTo(0, 0); if (v === "add") syncFavs(true).then(ch => { if (ch && view === "add") render(); }); };
document.addEventListener("click", e => { const b = e.target.closest("[data-go]"); if (!b) return;
  if (b.dataset.go === "home" && view === "add" && W && (W.legs?.length || W.rFrom || W.imported)) {
    return ask("Eingaben verwerfen?\n\nDu kommst zur Startseite, deine Eingaben gehen verloren.", { ok: "Verwerfen", danger: true }).then(ok => { if (ok) { W = null; go("home"); } }); }
  if (b.dataset.go === "home") W = null; go(b.dataset.go); });

let ROUTINES = [], OFFLINE = null;
try { ROUTINES = JSON.parse(localStorage.getItem("rb_routines_cache") || "[]") || []; } catch {}   // Anzahl stimmt auch im Funkloch
const offlineBox = () => (OFFLINE ? `<div class="banner info small"><b>Keine Verbindung.</b> Du siehst den Stand von ${hm(new Date(OFFLINE).toISOString())} Uhr – Zeiten können sich geändert haben.</div>` : "");
async function loadTrips() {
  api("/api/routines").then(r => { const ch = JSON.stringify(r) !== JSON.stringify(ROUTINES); ROUTINES = r; try { localStorage.setItem("rb_routines_cache", JSON.stringify(r)); } catch {} if (ch && view === "home" && !openId) render(); }).catch(() => {});
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
  timer = setTimeout(async () => { if (document.visibilityState === "visible") syncFavs(true).catch(() => {}); if (view === "home" && document.visibilityState === "visible") { await loadTrips().catch(() => {}); render(); } schedule(); }, 60e3);
}
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") return;
  // Favoriten können auf einem anderen Gerät geändert worden sein
  if (typeof syncFavs === "function") { syncFavs(true).catch(() => {}); syncPrefs(); }   // Liste still erneuern (beim Tippen nicht neu zeichnen)
  if (view === "home" && Date.now() - loadedAt > 30e3) { await loadTrips().catch(() => {}); render(); } });

// ---------- Zurück-Taste (Handy/Browser) ----------
// Solange man nicht auf der Startseite ist, liegt ein Eintrag im Verlauf. „Zurück“ macht dann einen Schritt in der App.
let guard = false, skipPop = false;
// Aufgeklappte Möglichkeiten/Einstellungen zählen als eigener Schritt: „Zurück“ klappt sie erst zu, statt die App zu verlassen
const subOpen = () => !!(BLK || openCmp || sheetId || document.querySelector("[data-pbclose]"));
const atRoot = () => view === "home" && !openId;
function syncHistory() {
  if (!atRoot() && !guard) { history.pushState({ rb: 1 }, ""); guard = true; }
  else if (atRoot() && guard) { guard = false; skipPop = true; history.back(); }
}
addEventListener("popstate", () => {
  if (skipPop) { skipPop = false; return; }
  if (document.querySelector(".dlg-wrap")) { history.pushState({ rb: 1 }, ""); guard = true; return; }   // offene Rückfrage: nur sie schließen
  if (view === "add" && W?.busy) { history.pushState({ rb: 1 }, ""); guard = true; return; }               // wird gerade gespeichert/gesucht: dableiben
  guard = false;
  if (view === "add" && W) { const bk = document.getElementById("wBack"); if (bk) return bk.click(); W = null; return go("home"); }
  if (view !== "home") return go("home");
  if (openId && subOpen()) { const hx = document.querySelector("[data-pbclose]"); if (BLK) { blkLeave().then(ok => ok ? render() : history.pushState({ rb: 1 }, "")); } else if (openCmp || sheetId) { openCmp = null; sheetId = null; render(); } else if (hx) hx.click(); return; }
  if (openId) { openId = null; sheetId = null; }
  render();
});
// Assistent übersteht Neuladen (nur in diesem Tab)
const saveW = () => { try { if (view === "add" && W && !W.busy) sessionStorage.setItem("rb_w", JSON.stringify(W)); else sessionStorage.removeItem("rb_w"); } catch {} };

// ---------- Darstellung ----------
let openId = null, sheetId = null, openLeg = null, flash = "";
function render() { render0(); syncHistory(); saveW(); headerBack(); markScreen(); }
// Schutz vor Doppeltipp: Wechselt der Bildschirm, zählt ein Tipp in den ersten 350 ms nicht (sonst trifft der zweite Tipp den Knopf, der jetzt dort liegt)
let SCREEN_AT = 0, SCREEN_SIG = "";
function markScreen() { const sig = `${view}|${W?.step || ""}|${W?.preDone ? 2 : 1}|${openId || ""}|${sheetId || ""}`; if (sig !== SCREEN_SIG) { SCREEN_SIG = sig; SCREEN_AT = Date.now(); } }
document.addEventListener("click", e => { if (Date.now() - SCREEN_AT < 350 && e.isTrusted && e.target.closest?.("#app button, #app a, #app input, #app label, .top button")) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
// Zurück immer oben links in der Kopfleiste (außer auf der Startseite)
function headerBack() {
  const b = document.getElementById("hdrBack"), brand = document.querySelector(".brand"); if (!b) return;
  const root = atRoot(); b.hidden = root; if (brand) brand.hidden = !root;
}
document.getElementById("hdrBack")?.addEventListener("click", () => { if (guard) history.back(); else { const bk = document.getElementById("wBack"); if (view === "add" && bk) bk.click(); else { openId = null; sheetId = null; go("home"); } } });
const flashBox = () => offlineBox() + flashBox0();
let SHARE_AFTER = null;   // Fahrt gerade geändert: neue Ankunft gleich teilen können
const flashBox0 = () => pushBox() + (() => { if (!flash) return ""; const f = flash, sh = SHARE_AFTER && openId === SHARE_AFTER ? SHARE_AFTER : null; flash = ""; SHARE_AFTER = null;
  return `<div class="banner ok small" role="status">${esc(f)}${sh ? ` <button class="btn sec small-btn share-after" data-share="${esc(sh)}">↗ Neue Ankunft teilen</button>` : ""}</div>`; })();
// Meldung, während die App offen ist: hier oben statt als Benachrichtigung (bleibt 2 Min. oder bis ✕)
let PUSH_NOTE = null;
const pushBox = () => { const n = PUSH_NOTE; if (!n || Date.now() - n.at > 120e3) return "";
  return `<div class="banner push-note${n.urgent ? " urgent" : ""}" role="alert"><button class="pn-x" data-pushx aria-label="Meldung schließen">✕</button>
    <button class="pn-main" data-pushopen><b>${esc(n.title)}</b>${n.body ? `<span>${esc(n.body)}</span>` : ""}</button></div>`; };
document.addEventListener("click", e => {
  if (e.target.closest("[data-pushx]")) { PUSH_NOTE = null; e.target.closest(".push-note")?.remove(); return; }
  if (e.target.closest("[data-pushopen]")) { const id = PUSH_NOTE && tripFromUrl(PUSH_NOTE.url); PUSH_NOTE = null;
    if (id && !(view === "add" && W)) { openId = id; sheetId = null; openLeg = null; go("home"); scrollTo(0, 0); } else render(); }
});
// Umstiegszeit für die Bewertung: in einer Reise deren eigene, sonst die übliche
let CUR_OWN = null, CUR_ZB = false;
const ownMin = () => (CUR_OWN != null ? CUR_OWN : MINT);
function render0() {
  CUR_OWN = null; CUR_ZB = false;
  if (view === "add") { if (!W) startWizard(); return renderWizard(); }
  if (view === "settings") return renderSettings();
  if (view === "routines") return renderRoutines();
  const active = trips.filter(t => t.active !== false);
  if (openId && !active.some(t => t.id === openId)) openId = null;
  if (openId) return renderTrip(active.find(t => t.id === openId), active.length > 1);
  renderList(active);
}

// Überall dieselben Worte: „Anschluss gefährdet“ → „Anschluss klappt wohl nicht“ → „Anschluss klappt nicht“
const KICKER = { OK: "Alles gut", WATCH: "Knapp", RISK: "Anschluss gefährdet", LOST: "Plan B nötig", DONE: "Angekommen" };
// Problem erst bei einem späteren Umstieg: in der Liste direkt sagen, wo es knapp wird
const knappLine = t => { const w = (t.transfers || []).find(x => x.status === "WATCH"); return w ? `Umstieg ${cleanStop(w.at || "")} knapp · ${w.gap} Min.` : t.title; };
const listState = t => {
  const tr = (t.transfers || []).find(x => x.status === t.status);
  if (t.status === "LOST" && stuckOf(t)) return "Heute nicht mehr – bitte wählen";
  if (t.status === "LOST") return t.missed != null ? "Verpasst – Plan B" : t.legCancel != null || tr?.reason === "cancel" ? "Fällt aus – Plan B" : "Anschluss klappt nicht – Plan B";
  if (t.status === "RISK") return tr && tr.gap < 0 ? "Anschluss klappt wohl nicht" : KICKER.RISK;
  if (t.status === "WATCH" && !t.transfers.some(x => x.status === "WATCH") && t.finalDelay >= 3) return `${t.finalDelay} Min. später`;
  if (planOnly(t)) return "Geplant";
  if (t.status === "OK" && t.phase !== "done" && Math.abs(t.finalDelay || 0) >= 3) return t.finalDelay > 0 ? `ca. ${t.finalDelay} Min. später` : `ca. ${-t.finalDelay} Min. früher`;
  return KICKER[t.status] || "";
};
// Vor der Abfahrt ohne Live-Daten nicht „Alles gut“ behaupten – es ist erst der Fahrplan
const planOnly = t => t.status === "OK" && t.phase === "before" && t.legs.every(l => !l.dep.live && !l.arr.live);
const heroKicker = t => (t.phase === "before" ? "Vor der Abfahrt" : t.phase === "done" ? "Fahrt beendet" : "Unterwegs");
const day = iso => new Date(iso).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "Europe/Berlin" });
const inMin = iso => { const m = Math.round((Date.parse(iso) - Date.now()) / MIN);
  if (m >= 18 * 60) return sameDay(Date.parse(iso), Date.now() + 864e5) ? "morgen" : `am ${new Date(iso).toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Berlin" })}`;
  return m <= 0 ? "jetzt" : m < 60 ? `in ${m} Min.` : `in ${Math.floor(m / 60)} Std.${m % 60 ? ` ${m % 60} Min.` : ""}`; };
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
  const now = Date.now(), cur = active.filter(t => t.phase !== "done" && (t.phase === "enroute" || Date.parse(t.legs[0].dep.rt) - now < 6 * 3600e3
      || ((t.status === "LOST" || t.status === "RISK") && Date.parse(t.legs[0].dep.rt) - now < 48 * 3600e3)))   // Ausfall schon heute Abend für morgen früh: gleich oben zeigen
    .sort((a, b) => (a.phase === "enroute" ? -1 : 0) - (b.phase === "enroute" ? -1 : 0) || Date.parse(a.legs[0].dep.rt) - Date.parse(b.legs[0].dep.rt))[0];
  // Mehrere gleichzeitig (Familie, geteiltes Gerät): alle, die gerade laufen oder in 30 Min. starten, oben zeigen – Probleme zuerst
  const RANK = { LOST: 0, RISK: 1, WATCH: 2 };
  const nowList = !cur ? [] : [cur, ...active.filter(t => t !== cur && t.phase !== "done" && (t.phase === "enroute" || Date.parse(t.legs[0].dep.rt) - now < 30 * MIN))]
    .sort((a, b) => (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3) || (a.phase === "enroute" ? -1 : 0) - (b.phase === "enroute" ? -1 : 0) || Date.parse(a.legs[0].dep.rt) - Date.parse(b.legs[0].dep.rt));
  const nowShown = NOW_MORE ? nowList : nowList.slice(0, 3);
  // Nach Kalendertag: Heute · Morgen · Später (jeweils nach Abfahrt sortiert)
  const depOf = t => Date.parse(t.legs[0].dep.plan), rest = active.filter(t => !nowList.includes(t)).sort((a, b) => depOf(a) - depOf(b));
  const isToday = ms => sameDay(ms, now), isTomorrow = ms => sameDay(ms, now + 864e5);
  // Regelmäßige Fahrten, die heute/morgen anstehen, aber erst kurz vorher (1 bzw. 3 Std.) angelegt werden: schon mal zeigen
  const pend = ROUTINES.filter(r => !r.paused && r.next?.at && (isToday(Date.parse(r.next.at)) || isTomorrow(Date.parse(r.next.at)))
      && !active.some(t => t.rname === r.name && sameDay(depOf(t), Date.parse(r.next.at))))
    .map(r => ({ pend: true, r, at: Date.parse(r.next.at) }));
  // Angekommen: kurz noch oben zeigen (15 Min.), danach eingeklappt unter „Erledigt“
  const arrOf = t => Date.parse(t.legs[t.legs.length - 1].arr.rt), gone = t => t.phase === "done" && arrOf(t) < now - 15 * MIN;
  const doneL = rest.filter(gone).map(t => ({ t, at: depOf(t) })).sort((a, b) => b.at - a.at);
  const items = [...rest.filter(t => !gone(t)).map(t => ({ t, at: depOf(t) })), ...pend].sort((a, b) => a.at - b.at);
  // Sichtbar nur, was bald ansteht (≤ 3 Std.), schon Live-Daten hat oder ein Problem – alles andere eingeklappt
  const soonT = t => depOf(t) - now <= 3 * 3600e3 || !planOnly(t) || t.status !== "OK";
  let soon = items.filter(x => !x.pend && soonT(x.t)), later = items.filter(x => !x.pend && !soonT(x.t)), pendL = items.filter(x => x.pend);
  // Die nächste Fahrt ist immer zu sehen – auch wenn sie erst morgen ist (sonst denkt man, sie sei weg)
  if (!soon.length && !nowList.length && later.length) { soon = [later[0]]; later = later.slice(1); }
  const dayHead = x => (isToday(x.at) ? "Heute" : isTomorrow(x.at) ? "Morgen" : day(new Date(x.at).toISOString()));
  const grouped = list => list.map((x, i) => `${!i || dayHead(list[i - 1]) !== dayHead(x) ? `<li class="day-sub">${esc(dayHead(x))}</li>` : ""}${row(x)}`).join("");
  const row = x => x.pend
    ? `<li class="crow-li"><button data-ropenr="${x.r.id}" class="crow pend"><span class="sdot d-pend"></span>
      <span class="tr-main"><b>${x.r.win ? `${esc(x.r.win[0])}–${esc(x.r.win[1])}` : hm(x.r.next.at)} ↻ ${esc(x.r.name)}</b>${x.r.win ? `<span class="muted small">eine Fahrt in diesem Zeitfenster</span>` : ""}</span>
      <span class="tr-state small">${pendText(x.r)}</span></button></li>`
    : `<li class="crow-li"><button data-open="${x.t.id}" class="crow"><span class="sdot d-${planOnly(x.t) ? "PLAN" : x.t.status}"></span>
      <span class="tr-main"><b>${hm(x.t.legs[0].dep.rt)} ${x.t.follow === true ? "👀 " : ""}${x.t.rname ? `↻ ${esc(x.t.rname)}` : `${esc(cleanStop(x.t.legs[0].dep.name))} → ${esc(cleanStop(x.t.legs[x.t.legs.length - 1].arr.name))}`}</b></span>
      <span class="tr-state small">${esc(listState(x.t))}</span></button></li>`;
  // Alte Adresse (…workers.dev): Hinweis auf den Umzug mit Anleitung zum Mitnehmen
  const moved = /workers\.dev$/.test(location.hostname) ? `<section class="card move"><div class="k">Neue Adresse</div>
      <p style="margin:0 0 8px">Umstiegsheld wohnt jetzt unter <b>umstiegsheld.de</b>. So nimmst du deine Fahrten und Favoriten mit:</p>
      <ol class="small" style="margin:0 0 10px;padding-left:20px"><li>Hier: Einstellungen → „Gerät hinzufügen“ → Code anzeigen.</li><li>umstiegsheld.de öffnen → Einstellungen → „Code eingeben“.</li><li>Dort Mitteilungen erlauben und die App neu zum Startbildschirm hinzufügen.</li></ol>
      <div class="row"><button class="btn sec small-btn" data-go="settings">Code anzeigen</button><a class="btn small-btn" href="https://umstiegsheld.de/" target="_blank" rel="noopener">umstiegsheld.de öffnen</a></div></section>` : "";
  $app.innerHTML = `${flashBox()}${moved}
    ${fresh ? `<h1 class="hero-h">Dein Weg. Ich pass auf.</h1><p class="lead">Fällt dein Bus oder Zug aus oder wird der Umstieg knapp, sag ich dir sofort Bescheid – mit Plan B.</p>` : ""}
    ${nowShown.map((t, i) => jetztCard(t, i > 0 || nowList.length > 1)).join("")}
    ${nowList.length > 3 ? `<button class="link small now-more" data-nowmore>${NOW_MORE ? "Weniger zeigen" : `+ ${nowList.length - 3} weitere jetzt`}</button>` : ""}
    ${tiles(cur, nowShown)}
    ${fresh && isIOS ? iosFirst() : ""}
    ${soon.length ? `<div class="sec-row"><span>Demnächst</span></div><ul class="trips compact">${grouped(soon)}</ul>` : ""}
    ${later.length ? `<div class="sec-row"><span>Später · ${later.length} ${later.length === 1 ? "Fahrt" : "Fahrten"}</span><button class="link" data-later>${LATER_OPEN ? "Weniger" : "Zeigen ›"}</button></div>
      ${LATER_OPEN ? `<p class="small muted" style="margin:-4px 2px 6px">Live geprüft wird ab ca. 3 Std. vor der Abfahrt – dann erscheinen sie oben.</p><ul class="trips compact">${grouped(later)}</ul>` : ""}` : ""}
    ${pendL.length ? `<div class="sec-row"><span>Regelmäßige Fahrten demnächst · ${pendL.length}</span><button class="link" data-pendopen>${PEND_OPEN ? "Weniger" : "Zeigen ›"}</button></div>
      ${PEND_OPEN ? `<ul class="trips compact">${grouped(pendL)}</ul>` : ""}` : ""}
    ${fresh && isIOS ? "" : hintCard()}
    ${doneL.length ? `<div class="sec-row"><span>Erledigt · ${doneL.length}</span><button class="link" data-doneopen>${DONE_OPEN ? "Weniger" : "Zeigen ›"}</button></div>
      ${DONE_OPEN ? `<ul class="trips compact">${doneL.map(row).join("")}</ul>` : ""}` : ""}
    ${fresh && !(DEV.list && DEV.list.length > 1) ? `<button class="btn quiet" data-linkjoin>${isIOS && standalone ? "Fahrten schon in Safari angelegt? Code eingeben" : "Schon auf einem anderen Gerät oder Code gesichert? Hier eingeben"}</button>` : ""}`;
  if (fresh && !DEV.list && !DEV.asked) { DEV.asked = true; api("/api/devices").then(l => { DEV.list = l; if (view === "home" && !openId && l.length > 1) render(); }).catch(() => {}); }
  $app.querySelectorAll("[data-open]").forEach(b => b.onclick = () => { openId = b.dataset.open; openLeg = null; render(); scrollTo(0, 0); });
  $app.querySelector("[data-later]")?.addEventListener("click", () => { LATER_OPEN = !LATER_OPEN; render(); });
  $app.querySelector("[data-doneopen]")?.addEventListener("click", () => { DONE_OPEN = !DONE_OPEN; render(); });
  $app.querySelector("[data-nowmore]")?.addEventListener("click", () => { NOW_MORE = !NOW_MORE; render(); });
  $app.querySelector("[data-pendopen]")?.addEventListener("click", () => { PEND_OPEN = !PEND_OPEN; render(); });
  bindTiles(cur);
  bindHints();
  bindRoutines();
  bindCommon();
}

// Regelmäßige Fahrten: verwalten oder neu anlegen
function renderRoutines() {
  $app.innerHTML = `${flashBox()}<h1>Regelmäßige Fahrten</h1>
    <p class="muted small" style="margin-top:0">Z. B. Schulweg oder Arbeitsweg: An jedem Fahrtag lege ich die Fahrt ein paar Stunden vorher an und sag dir Bescheid, wenn etwas nicht klappt.</p>
    ${retCard(RET?.routine)}
    <button class="btn ${ROUTINES.length || RET?.routine ? "sec" : "big-btn"}" data-regstart>＋ Neue regelmäßige Fahrt</button>
    ${ROUTINES.length ? `<div class="sec-row"><span>${ROUTINES.some(r => r.paused) ? `Deine regelmäßigen Fahrten · ${ROUTINES.length}${ROUTINES.filter(r => r.paused).length ? ` (${ROUTINES.filter(r => r.paused).length} pausiert)` : ""}` : `Werden überwacht · ${ROUTINES.length}`}</span></div><div class="card flat rlist">${ROUTINES.map(routineRow).join("")}</div>`
      : `<p class="muted small">Noch keine – leg oben deine erste an.</p>`}`;
  bindRoutines(); bindRet();
  bindCommon();
}

// Die laufende/nächste Fahrt groß – Ampelfarbe, Uhrzeit, Steig/Gleis, ein Satz
// „Wann muss ich los?“ – vom aktuellen Standort, zu Fuß oder mit dem Auto. Gemerkt werden nur Minuten und Art (auf dem Gerät), nie der Standort.
const PARK = 5;   // Auto: Zeit zum Parken und zum Bahnsteig
let ACC = {}; try { ACC = JSON.parse(localStorage.getItem("rb_access") || "{}"); } catch {}
const saveAcc = () => { try { localStorage.setItem("rb_access", JSON.stringify(ACC)); } catch {} };
// Bei regelmäßigen Fahrten gilt das Ergebnis auch für die nächsten Tage (gleicher Start) – Art und Minuten werden gemerkt
const accOf = (t, pick) => (pick ? ACC[`${t.id}:pick`] : ACC[t.id] || (t.routine && ACC[`r:${t.routine}`])) || null;
const BUFS = [2, 4, 7, 10], accBuf = () => (BUFS.includes(ACC._buf) ? ACC._buf : 2);
let ACC_OPEN = null;   // aufgeklappte Einstellungen von „Wann muss ich los?“ (sonst nur eine Zeile)
function accessBox(t, pick = false) {
  const a = accOf(t, pick), dep = pick ? Date.parse(t.legs[t.legs.length - 1].arr.rt) : Date.parse(t.legs[0].dep.rt), pref = t.routine && ACC[`r:${t.routine}`]?.mode, pk = pick ? "|pick" : "";
  if (a?.busy) return `<div class="acc"><div class="spinner"></div></div>`;
  if (!a?.min) { const ch = [["WALK", "🚶 Zu Fuß"], ["CAR", "🚗 Mit dem Auto"]].sort((x, y) => (y[0] === pref) - (x[0] === pref));
    return `<div class="acc"><span class="small"><b>${pick ? "Wann muss ich zum Abholen los?" : "Wann muss ich los?"}</b> Ab deinem Standort${pick ? ` zu ${esc(cleanStop(t.legs[t.legs.length - 1].arr.name))}` : ""}:</span>
    <div class="chips">${ch.map(([m, l]) => `<button class="chip" data-acc="${t.id}|${m}${pk}">${l}</button>`).join("")}</div>${a?.err ? `<div class="small late">${esc(a.err)}</div>` : ""}</div>`; }
  const buf = accBuf(), park = a.mode === "CAR" ? PARK : 0, need = a.min + park + buf, go = dep - need * MIN, left = Math.round((go - Date.now()) / MIN);
  const how = `${a.rough ? "grob " : "ca. "}${a.min} Min. ${a.mode === "CAR" ? "mit dem Auto" : "zu Fuß"}${park ? ` + ${park} Min. Parken` : ""}${buf ? ` + ${buf} Min. Puffer` : ""}`;
  const old = !ACC[t.id] ? ` · wie beim letzten Mal (${day(new Date(a.at).toISOString())})` : "";
  const open = ACC_OPEN === t.id;
  // kompakt: eine Zeile – Details erst auf Tipp
  return `<div class="acc"><button class="acc-line" data-accopen="${t.id}" aria-expanded="${open}"><b class="${left < 0 ? "late" : left <= 10 ? "warn-t" : ""}">${pick ? "Zum Abholen " : ""}${left < 0 ? `los – seit ${-left} Min.` : left <= 1 ? (pick ? "jetzt los!" : "Jetzt los!") : `${pick ? "los" : "Los"} um ${hm(go)}`}</b>
    <span class="small muted">${how.replace(/^(ca\.|grob) /, "")}</span><span class="chev">${open ? "▴" : "▾"}</span></button>
    ${!open ? "" : `<div class="small muted" style="margin-top:4px">${a.rough ? "Grob geschätzt" : "Geschätzt"} ab deinem Standort um ${hm(a.at)}${old}. Der Standort wird nur dafür genutzt und nicht gespeichert.</div>
    <div class="chips"><span class="small muted" style="align-self:center">Puffer:</span>${BUFS.map(v => `<button class="chip sm" data-abuf="${v}" aria-pressed="${buf === v}">${v}</button>`).join("")}<span class="small muted" style="align-self:center">Min.</span></div>
    <div class="chips"><button class="chip" data-acc="${t.id}|${a.mode}${pk}">↻ Neu berechnen</button><button class="chip" data-acc="${t.id}|${a.mode === "CAR" ? "WALK" : "CAR"}${pk}">${a.mode === "CAR" ? "🚶 Lieber zu Fuß" : "🚗 Lieber Auto"}</button>${walkBtn(null, { name: t.legs[0].dep.name, lat: t.legs[0].dep.lat, lon: t.legs[0].dep.lon }, a.mode)}</div>`}</div>`;
}
function bindAccess(t) {
  $app.querySelectorAll("[data-abuf]").forEach(b => b.onclick = () => { ACC._buf = +b.dataset.abuf; saveAcc(); render(); });
  $app.querySelectorAll("[data-accopen]").forEach(b => b.onclick = () => { ACC_OPEN = ACC_OPEN === b.dataset.accopen ? null : b.dataset.accopen; render(); });
  $app.querySelectorAll("[data-acc]").forEach(b => b.onclick = () => {
    const [id, mode, pk] = b.dataset.acc.split("|"), pick = pk === "pick", k = pick ? `${id}:pick` : id;
    if (!navigator.geolocation) { ACC[k] = { err: "Dein Gerät gibt keinen Standort heraus." }; return render(); }
    ACC[k] = { busy: true }; render();
    navigator.geolocation.getCurrentPosition(async pos => {
      try { const r = await api(`/api/trips/${id}/access`, { method: "POST", body: { lat: pos.coords.latitude, lon: pos.coords.longitude, mode, ...(pick ? { to: "arr" } : {}) } });
        ACC[k] = { min: r.min, mode: r.mode, rough: r.rough, at: Date.now() };
        if (t?.routine && !pick) ACC[`r:${t.routine}`] = ACC[k]; ACC_OPEN = null; }   // gilt auch für die nächsten Fahrten dieser Serie
      catch (e) { ACC[k] = { err: e.message }; }
      saveAcc(); render();
    }, () => { ACC[k] = { err: "Ohne Standort kann ich den Weg nicht schätzen. Bitte den Standort für Umstiegsheld erlauben." }; render(); }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 });
  });
}
// Mitverfolgen: aus Sicht der abholenden Person – Ankunft, Gleis, Tag, Abweichung und „Wann muss ich zum Abholen los?“
function followHero(t) {
  const L = t.legs, z = L[L.length - 1].arr, a = L[0].dep, d = t.finalDelay ?? 0, dest = cleanStop(z.name);
  const wd = ms => new Date(ms).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "Europe/Berlin" });
  const tr = (t.transfers || []).find(x => x.status === "RISK" || x.status === "WATCH");
  const state = t.phase === "done" ? `Angekommen um ${hm(z.rt)}.` : t.status === "LOST" ? "Ein Anschluss klappt nicht – die Ankunft ändert sich noch. Ich sage Bescheid, sobald die neue Verbindung steht."
    : planOnly(t) ? "Laut Fahrplan – Live-Zeiten kommen kurz vor der Abfahrt."
    : `${d >= 3 ? `ca. ${d} Min. später als geplant (${hm(z.plan)})` : d <= -3 ? `ca. ${-d} Min. früher als geplant` : "Alles läuft nach Plan"}${tr ? `, Umstieg in ${esc(cleanStop(tr.at))} ist ${tr.status === "RISK" ? "gefährdet" : "knapp"}` : ""}.`;
  const cls = planOnly(t) ? `PLAN${planTight(t) ? " tight" : ""}` : t.status;
  return `<section class="hero s-${cls}"><div class="k">${t.phase === "before" ? `Abfahrt ${wd(Date.parse(a.rt))} ${hm(a.rt)} ab ${esc(cleanStop(a.name))}` : t.phase === "done" ? "Angekommen" : "Unterwegs"}</div>
    <h2>Ankunft ${esc(dest)}: ${hm(z.rt)}</h2>
    <p><b>${wd(Date.parse(z.rt))}${z.platform ? ` · Gleis ${esc(z.platform)}` : ""}</b></p><p>${state}</p>
    ${t.phase !== "done" && t.status !== "LOST" ? accessBox(t, true) : ""}</section>`;
}
function jetztCard(t, slim = false) {
  if (t.follow === true) { const z = t.legs[t.legs.length - 1].arr;   // mitverfolgt: Ankunft statt eigener Schritte
    return `<button class="hero jetzt${slim ? " slim" : ""} s-${planOnly(t) ? `PLAN${planTight(t) ? " tight" : ""}` : t.status}" data-open="${t.id}"><div class="jk"><span>👀 Mitverfolgt · ${esc(cleanStop(t.legs[0].dep.name))} → ${esc(cleanStop(z.name))}</span><span>${esc(listState(t))}</span></div>
      <div class="jt"><b>${hm(z.rt)}</b> <span>Ankunft${z.platform ? ` · Gleis ${esc(z.platform)}` : ""}</span></div></button>`; }
  const n = t.next, lbl = n ? (/^\d/.test(n.label) && n.mode && MODE[n.mode] ? `${MODE[n.mode][0]} ${n.label}` : n.label) : "";
  const when = t.phase === "enroute" ? "unterwegs" : inMin(t.legs[0].dep.rt);
  const what = !n ? "" : n.cancelled ? `<span class="late">${esc(lbl)} fällt aus</span>` : `${esc(lbl)}${n.platform ? ` · ${esc(platWord(n, n.platform))}` : ""}`;
  return `<button class="hero jetzt${slim ? " slim" : ""} s-${planOnly(t) ? `PLAN${planTight(t) ? " tight" : ""}` : t.status}" data-open="${t.id}">
    <div class="jk"><span>${t.rname ? `↻ ${esc(t.rname)}` : `${esc(cleanStop(t.legs[0].dep.name))} → ${esc(cleanStop(t.legs[t.legs.length - 1].arr.name))}`} · ${esc(when)}</span><span>${esc(listState(t))}</span></div>
    ${n ? `<div class="jt"><b>${hm(n.at)}</b> <span>${what}</span></div>` : ""}
    <div class="js">${esc(t.status === "OK" ? (n?.then && !n.then.lost ? `Umstieg ${cleanStop(n.then.station || "")} klappt · ${n.then.gap} Min.` : `${t.phase === "enroute" ? "an" : "Ankunft"} ${hm(t.legs[t.legs.length - 1].arr.rt)} ${cleanStop(t.legs[t.legs.length - 1].arr.name)}`) : t.status === "WATCH" && /^Noch läuft/.test(t.title || "") ? knappLine(t) : t.title === listState(t) ? String(t.sub || "").split(/(?<=\.) /)[0] : t.title)}${t.status === "LOST" ? " – antippen" : ""}</div></button>`;
}

// Angekündigte regelmäßige Fahrt: ab wann sie überwacht wird (überall derselbe Begriff)
const leadMs = r => (r.lead || 180) * MIN, leadTxt = r => ((r.lead || 180) >= 120 ? "ca. 3 Std." : "ca. 1 Std.");
const pendAt = r => Date.parse(r.next.at) - leadMs(r);
const pendText = r => (pendAt(r) > Date.now() ? `Überwachung ab ${hm(new Date(pendAt(r)).toISOString())}` : "Überwachung startet gleich");
// Vier Kacheln: alles, was man starten kann
function tiles(cur, shown = []) {
  const sosTrip = trips.find(t => t.active !== false && sosAvailable(t));
  const redTop = sosTrip && shown.some(x => x.id === sosTrip.id);   // rote Karte steht schon oben -> Kachel nicht auch noch rot
  const empty = !trips.length && !ROUTINES.length;
  const tile = (attr, icon, title, sub, cls = "") => `<button class="tile ${cls}" ${attr}><span class="ti-ic" aria-hidden="true">${icon}</span><b>${title}</b><span>${sub}</span></button>`;
  return `<div class="tiles4">
    ${tile('data-go="add"', "＋", "Neue Fahrt", "Von – nach", empty ? "wide" : "")}
    ${tile('data-go="routines"', `↻${ROUTINES.length ? `<em class="cnt">${ROUTINES.length}</em>` : ""}`, "Regelmäßige Fahrten", ROUTINES.length ? `${ROUTINES.length} ${ROUTINES.length === 1 ? "wird" : "werden"} überwacht` : "Schulweg, Arbeitsweg …")}
    ${tile("data-tticket", "🎫", "Gebuchte Fahrt überwachen", "Ticket, Screenshot oder DB-Link")}
    ${sosTrip && (sosTrip.status === "RISK" || sosTrip.status === "LOST") ? tile(`data-sos="${sosTrip.id}" data-sosopen`, "!", "SOS: Anschluss in Gefahr", "Dein Plan klappt wohl nicht – ich suche sofort eine andere Verbindung", redTop ? "quick" : "sos")
      : sosTrip && sosTrip.status === "WATCH" ? tile(`data-sos="${sosTrip.id}" data-sosopen`, "⇄", "Anschluss wird knapp", "Möglichkeiten ab deinem Zug ansehen", "quick")
      : tile("data-quick", "⌖", "Schnell weg", "Ab hier, jetzt – wohin?", "quick")}
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

// Wann? „heute“ nicht nennen, sonst „morgen“ bzw. Wochentag – damit eine Ankunft am nächsten Tag nicht übersehen wird
const dayPre = iso => { const ms = Date.parse(iso), now = Date.now(); return sameDay(ms, now) ? "" : sameDay(ms, now + 864e5) ? "morgen " : `${new Date(ms).toLocaleDateString("de-DE", { weekday: "short", timeZone: "Europe/Berlin" })} `; };
// Übernachtung: ein langer Halt über die Nacht (≥ 3 Std., Weiterfahrt an einem anderen Tag)
// Übernachtung = mindestens 3 Std. Warten, und 3 Uhr nachts (Berliner Zeit) liegt in der Wartezeit
const berlinMin = ms => { const [h, m] = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms)).split(":").map(Number); return h * 60 + m; };
function nightGap(arr, dep, at) {
  const a = Date.parse(arr), d = Date.parse(dep), g = Math.round((d - a) / MIN);
  if (g < 180) return null;
  const to3 = (180 - berlinMin(a) + 1440) % 1440;   // Minuten bis zum nächsten 3:00 Uhr
  return a + to3 * MIN <= d ? { at, arr, dep, gap: g } : null;
}
const nightOf = a => { const L = a?.legs || []; for (let j = 0; j + 1 < L.length; j++) { const n = nightGap(L[j].to.rt || L[j].to.plan, L[j + 1].from.rt || L[j + 1].from.plan, cleanStop(L[j].to.name)); if (n) return n; } return null; };
// Ziel im Ausland? (Bahnhofsnummern in Deutschland beginnen mit 80)
const abroad = t => { const z = t.legs[t.legs.length - 1].arr; return !/^80\d{5}$/.test(String(z.eva || "")); };
// Plan geht nicht mehr: die Empfehlung gleich im roten Kasten – ein Tipp genügt. Daneben genau ein zweiter Weg: bei der Bahn gegenprüfen.
function bestRec(t) {
  let a = null, data = "", list = null;
  const hl = t.here && (t.here.mode === "cancel" || t.here.mode === "missed") ? t.here.list : null;
  if (hl?.length) { const i = bestIdx(hl); if (i >= 0) { a = hl[i]; data = `${t.id}|0|${i}|here`; list = hl; } }
  if (!a) { const k = t.transfers.findIndex(x => x.status === "LOST" && x.alt?.length); if (k >= 0) { const i = bestIdx(t.transfers[k].alt, t.plan.dep); if (i >= 0) { a = t.transfers[k].alt[i]; data = `${t.id}|${k}|${i}`; list = t.transfers[k].alt; } } }
  return { a, data, list };
}
function heroRec(t) {
  if (t.status !== "LOST" || t.phase === "done") return "";
  const { a, data, list } = bestRec(t);
  const bc = bahnCheck(t);
  const bahnBtn = bc ? `<a class="btn sec small-btn bahn-check" href="${esc(bc.url)}" target="_blank" rel="noopener" data-bahncheck>Bei der Bahn gegenprüfen <span>ab ${esc(bc.from)} ${hm(bc.at)}${bc.cut ? ` · bis ${esc(bc.to)} (Ausland fehlt)` : ""}</span></a>` : "";
  if (!a) return bahnBtn ? `<div class="hero-rec"><div class="small">Ich finde gerade keine passende Möglichkeit und suche weiter.</div>${bahnBtn}</div>` : "";
  const zb = t.ticket === "spar" && !t.zbLifted && a.zb;
  const l0 = a.legs?.[0], pl = a.depPl ? ` · ${platWord(l0 || { label: a.label }, a.depPl)}` : "";
  const night = nightOf(a), dest = cleanStop(t.legs[t.legs.length - 1].arr.name), more = (list?.length || 0) - dupAlts(list, list ? list.indexOf(a) : -1).size > 1;
  const head = night
    ? `<div class="rec-night"><b>Heute kommst du nicht mehr nach ${esc(dest)}.</b> Früheste Ankunft: <b>${esc(dayPre(a.arr))}${hm(a.arr)}</b>, mit Übernachtung in ${esc(night.at)}.</div><div class="small">Empfohlen:</div>`
    : `<div class="small">Empfohlen:</div>`;
  const notes = [
    night ? `🏨 Hotel: Bei durchgehend gebuchtem Ticket zahlt meist die Bahn – frag im Reisezentrum (bei einzeln gebuchten Teilstrecken oft nicht).` : "",
    bc && (night || abroad(t)) ? `Ins Ausland fehlen mir manchmal Züge – prüf das kurz bei der Bahn${night ? ", bevor du ein Hotel nimmst" : ""}.` : "",
  ].filter(Boolean).map(x => `<p class="small rec-note">${x}</p>`).join("");
  return `<div class="hero-rec">${head}<div><b>${esc(a.label)}</b> ab ${hm(a.dep)}${esc(pl)} → an ${esc(dayPre(a.arr))}${hm(a.arr)}</div>
    <button class="btn small-btn" data-adopt="${data}" data-zb="${zb ? "1" : ""}" data-adopt-text="${esc(`${a.label}: ab ${hm(a.dep)}, an ${dayPre(a.arr)}${hm(a.arr)}`)}">Die nehme ich</button>
    ${bahnBtn}${notes}${more ? `<button class="link small" data-optopen="${t.id}" data-optonly>Andere Möglichkeiten ansehen</button>` : ""}</div>`;
}
// ---------- „Heute nicht mehr“: die beste Möglichkeit führt über Nacht. Dann nüchtern sagen, was los ist, und wählen lassen ----------
let STUCK_ORIG = null;          // Fahrt-ID, deren ursprüngliche Fahrt aufgeklappt ist
const STUCK_REQ = new Set();     // pro Sitzung nur einmal automatisch suchen
const destOf = t => cleanStop((([...t.legs].reverse().find(isTrainLeg)) || t.legs[t.legs.length - 1]).arr.name);
function stuckOf(t) {
  if (t.follow === true || t.status !== "LOST" || t.phase === "done") return null;
  const r = bestRec(t), morning = t.here?.mode === "morning";
  const night = r.a ? nightOf(r.a) : null;
  const late = r.a && !sameDay(Date.parse(r.a.arr), Date.parse(t.planArr)) && Date.parse(r.a.arr) - Date.parse(t.planArr) > 3 * 3600e3;
  return night || late || morning ? { ...r, night } : null;
}
async function loadStuck(id) {
  try { const v = await api(`/api/trips/${id}/stuck`, { method: "POST" }); trips = trips.map(x => (x.id === id ? v : x)); }
  catch (e) { trips = trips.map(x => (x.id === id ? { ...x, stuckErr: e.message } : x)); }
  if (openId === id) render();
}
const tile = (icon, title, sub, attrs, extra = "") => `<button class="sk-tile" ${attrs}><span class="sk-i" aria-hidden="true">${icon}</span><span><b>${title}</b><span>${sub}</span>${extra}</span></button>`;
function stuckView(t, sk) {
  const now = Date.now(), dest = esc(destOf(t)), k = t.transfers.findIndex(x => x.status === "LOST");
  const S = k >= 0 ? t.legs[k].arr : t.legs[0].dep, at = esc(cleanStop(S.name)), arrAt = Date.parse(S.rt);
  const ml = t.here?.mode === "morning" ? t.here.list || [] : null;
  if (!ml && !t.stuckErr && !STUCK_REQ.has(t.id)) { STUCK_REQ.add(t.id); setTimeout(() => loadStuck(t.id), 0); }
  const m = ml?.[0] || null;
  const tiles = [];
  // 1. Hier übernachten, morgen früh weiter
  if (m) tiles.push(tile("🛏️", `In ${at} übernachten, morgen früh weiter`, `${esc(dayPre(m.dep))}ab ${hm(m.dep)} → ${dest} an ${sameDay(Date.parse(m.arr), Date.parse(m.dep)) ? "" : esc(dayPre(m.arr))}${hm(m.arr)}`,
    `data-adopt="${t.id}|0|0|here" data-zb="${t.ticket === "spar" && !t.zbLifted && m.zb ? "1" : ""}" data-adopt-text="${esc(`In ${cleanStop(S.name)} übernachten. Weiter ${dayPre(m.dep)}ab ${hm(m.dep)} mit ${m.label}, an ${dayPre(m.arr)}${hm(m.arr)}`)}"`));
  else if (!ml && !t.stuckErr) tiles.push(`<div class="sk-tile pending"><span class="sk-i" aria-hidden="true">🛏️</span><span><b>In ${at} übernachten, morgen früh weiter</b><span>Ich suche die erste Verbindung morgen früh …</span></span></div>`);
  // 2. Heute noch so weit wie möglich – nur, wenn du damit früher ankommst
  const a = sk.a;
  if (a && Date.parse(a.dep) > now - MIN && (!m || Date.parse(a.arr) < Date.parse(m.arr) - 5 * MIN)) {
    const n = sk.night, soon = Date.parse(a.dep) - now < 3 * 3600e3;
    tiles.push(tile("➡️", n ? `Heute noch bis ${esc(n.at)}, dort übernachten` : "Heute noch weiter fahren",
      n ? `ab ${hm(a.dep)}, ${esc(n.at)} an ${hm(n.arr)} · ${esc(dayPre(n.dep))}${hm(n.dep)} weiter → an ${sameDay(Date.parse(a.arr), Date.parse(n.dep)) ? "" : esc(dayPre(a.arr))}${hm(a.arr)}` : `ab ${hm(a.dep)} → ${dest} an ${esc(dayPre(a.arr))}${hm(a.arr)}`,
      `data-adopt="${sk.data}" data-zb="${t.ticket === "spar" && !t.zbLifted && a.zb ? "1" : ""}" data-adopt-text="${esc(`${a.label}: ab ${hm(a.dep)}${n ? `, Übernachtung in ${n.at}` : ""}, an ${dayPre(a.arr)}${hm(a.arr)}`)}"`,
      soon ? `<span class="sk-dl">Nur noch bis ${hm(a.dep)} möglich</span>` : ""));
  }
  // 3. Zurück nach Hause – nur früh in der Fahrt (sucht der Server nur dann)
  const h = t.stuck?.home?.[0], home = esc(cleanStop(t.legs[0].dep.name));
  if (h) tiles.push(tile("🏠", `Fahrt abbrechen, zurück nach ${home}`, `ab ${hm(h.dep)} → ${home} an ${hm(h.arr)}`, `data-gohome="${t.id}"`));
  const none = ml && !tiles.length;
  const bc = bahnCheck(t);
  return `<section class="stuck">
    <h2>Heute kommst du nicht mehr nach ${dest}.</h2>
    <p>${k >= 0 ? `Dein Anschluss in ${at} klappt nicht, und heute fährt nichts Brauchbares mehr dorthin.` : "Heute fährt nichts Brauchbares mehr dorthin."}</p>
    <p class="small muted">${arrAt > now ? `Du bist ab ${hm(S.rt)} in ${at}.` : `Du bist in ${at}.`}</p>
    ${none ? `<p>Ich finde auch morgen früh ab ${at} keine Verbindung. Prüf es bitte bei der Bahn oder frag im Reisezentrum.</p>`
      : t.stuckErr && !tiles.length ? `<p class="small">${esc(t.stuckErr)}</p>` : `<p class="sk-q">Wie möchtest du weiter?</p><div class="sk-tiles">${tiles.join("")}</div>`}
    ${h && tiles.length === 1 ? "" : `<p class="sk-note small">ℹ️ Hotel: Bei durchgehend gebuchtem Ticket zahlt meist die Bahn. Frag im Reisezentrum oder beim Zugpersonal.</p>`}
    ${bc ? `<a class="sk-link" href="${esc(bc.url)}" target="_blank" rel="noopener">↗ Bei der Bahn gegenprüfen <span class="muted">ab ${esc(bc.from)}${bc.cut ? ` · bis ${esc(bc.to)}` : ""}</span></a>` : ""}
    ${abroad(t) ? `<p class="small muted">Ins Ausland fehlen mir manchmal Züge – ein Blick bei der Bahn lohnt sich, bevor du ein Hotel nimmst.</p>` : ""}
    <div class="sk-foot"><button class="link small" data-skorig="${t.id}" aria-expanded="${STUCK_ORIG === t.id}">${STUCK_ORIG === t.id ? "▴ Ursprüngliche Fahrt ausblenden" : "▾ Ursprüngliche Fahrt"}</button>
      <button class="link small muted" data-del="${t.id}" data-end>Fahrt beenden</button></div>
  </section>`;
}

// Zeitfenster: alle Fahrten im Fenster mit Live-Stand, du wählst, welche du nimmst
function windowCard(t) {
  if (!t.win || t.phase === "done") return "";
  if (t.win.picked) return `<div class="banner info small row" style="align-items:center"><span style="flex:3">↻ Du nimmst diese Fahrt (Zeitfenster ${esc(t.win.from)}–${esc(t.win.to)}).</span><button class="chip" data-unpick="${t.id}" style="flex:0 0 auto">Andere wählen</button></div>`;
  const zb0 = t.ticket === "spar" && !t.zbLifted;
  const prev = t.win.prev ? `<div class="banner info small row" style="align-items:center"><span style="flex:3">Die ${hm(t.win.prev.dep)} ist abgefahren – ich überwache jetzt die ${hm(t.legs[0].dep.plan)}.</span><button class="chip" data-winprev="${t.id}" style="flex:0 0 auto">Ich sitze in der ${hm(t.win.prev.dep)}</button></div>` : "";
  if (!(t.win.list || []).length) return prev;
  const rows = (t.win.list || []).map((a, i) => `<div class="cmp-row"><div class="cmp-tag">Später</div><div class="cmp-main">
      ${losZiel(a.dep, a.arr)}${stepsHtml(altSteps(a))}<div class="cmp-live">${liveBadge(a)}${zb0 && a.zb ? ` ${zbBadge}` : ""}</div>
      ${infeasible(a) ? `<div class="small late" style="margin-top:6px">Geht so nicht mehr</div>` : `<div class="row cmp-act"><button class="btn sec small-btn" data-adopt="${t.id}|0|${i}|win">Die nehme ich</button></div>`}</div></div>`).join("");
  return `${prev}<h3 class="sec-h">↻ ${esc(t.rname || "Regelmäßig")} · weitere Fahrten bis ${esc(t.win.to)}</h3>
    <p class="small muted" style="margin:-2px 0 8px">Ich überwache automatisch die nächste. Nimmst du eine spätere, tipp sie an.</p><div class="tiles">${rows}</div>`;
}
// Ticket-Frage nur, wenn Fernverkehr dabei ist (Zugbindung gibt es nur dort) – bei Bus, S-/U-Bahn, Tram, Regionalzug gleich anlegen
const FV_RE_C = /^(ICE|IC|EC|ECE|ICD|RJX?|NJ|EN|TGV|EST|D)\s?\d/i;
const isFVc = l => FV_RE_C.test(String(l?.label || "").trim()) || ["HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL"].includes(l?.mode);
function toTicket() {
  const all = (W.multi || [W.legs]).flat();
  if (W.quick || !all.some(isFVc)) return saveTrip("flex");
  W.step = "ticket"; render();
}
// Zeitfenster aus „Neue regelmäßige Fahrt“: direkt speichern (die Fahrten im Fenster sucht die App an jedem Fahrtag selbst)
async function saveWindowRoutine() {
  const R = W.reg; W.busy = "Wird gespeichert …"; render();
  try {
    const r = await api("/api/routines", { method: "POST", body: { from: W.rFrom, to: W.rTo, name: R.name.trim(), days: R.days, winFrom: R.from, winTo: R.to, ticket: "flex", holidays: R.hol, minT: MINT, replace: W.replaceR || undefined } });
    ROUTINES = await api("/api/routines").catch(() => ROUTINES);
    flash = `Gespeichert: „${r.name}“, ${daysText(r.days)} ${r.win[0]}–${r.win[1]}. Die Fahrt erscheint jeweils ein paar Stunden vorher auf der Startseite.`;
    if (!W.retNo) offerReturn({ routine: r.id, from: W.rFrom, to: W.rTo, reg: { name: r.name, days: r.days, hol: r.holidays, kind: "win", from: "16:00", to: "18:00" } });
    W = null; go("routines");
  } catch (e) { if (!W) return; W.busy = null; W.error = e.message; render(); }
}
// Frage „Fährst du das regelmäßig?“ nur bei einer neuen, einzelnen Reise
const canRegular = () => !!W && !W.editId && !W.multi && !W.quick && W.legs?.length > 0 && (W.regIntent || !ROUTINES.some(r => plainStop(r.from) === plainStop(W.legs[0].from.name) && plainStop(r.to) === plainStop(W.legs[W.legs.length - 1].to.name)));
// ---------- Regelmäßige Fahrten ----------
let NOW_MORE = false, LATER_OPEN = false, PEND_OPEN = false, DONE_OPEN = false, R_OPEN = null, R_LIST_OPEN = false;
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
  const open = R_OPEN === r.id, nx = r.next, tm = r.win ? `${r.win[0]}–${r.win[1]}` : r.dep;
  const nextTxt = nx ? `${dateWord(nx.date)} ${r.win ? tm : hm(nx.at)}` : "";
  const state = r.paused ? `<span class="badge">pausiert</span>` : nx ? `nächste: <b>${esc(nextTxt)}</b>` : "keine Fahrt in den nächsten 3 Wochen";
  const off = !r.paused && r.todayOff && r.todayOff !== "kein Fahrtag" ? ` · heute nicht (${esc(r.todayOff)})` : "";
  const t0 = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  return `<div class="rrow ${open ? "open" : ""}" id="r-${r.id}"><button class="rhead" data-ropen="${r.id}" aria-expanded="${open}">
      <span class="tr-main"><b>↻ ${esc(r.name)}</b><span class="small muted">${daysText(r.days)} · ${esc(tm)} · ${esc(cleanStop(r.from))} → ${esc(cleanStop(r.to))}</span>
      <span class="small">${state}${off}</span></span><span class="chev">${open ? "▴" : "▾"}</span></button>
    ${open ? `<div class="rbody">
      ${nx && !r.paused ? `<p class="small explain">Am Fahrtag lege ich die Fahrt ${leadTxt(r)} vorher selbst an – du musst nichts tun. ${Date.parse(nx.at) - leadMs(r) <= Date.now() ? `Die Fahrt ${esc(nextTxt)} ist schon angelegt, du findest sie auf der Startseite.` : `Nächste: ${esc(nextTxt)}, Überwachung ab ${hm(new Date(Date.parse(nx.at) - leadMs(r)).toISOString())}.`}${r.win ? " Im Zeitfenster schlage ich dir die passenden Fahrten vor; die erste nehme ich, wenn du nichts wählst." : ""}</p>` : ""}
      <p class="small muted" style="margin:0 0 2px">${r.win ? "Zeitfenster (Abfahrt)" : "Verbindung"}</p>
      ${r.win ? `<div class="win-row"><input type="time" id="rwf-${r.id}" data-rwin="${r.id}" value="${esc(r.win[0])}" aria-label="von"><span>bis</span><input type="time" id="rwt-${r.id}" data-rwin="${r.id}" value="${esc(r.win[1])}" aria-label="bis"></div>`
        : `<p class="small" style="margin:0 0 4px">${esc(r.dep)} ab ${esc(cleanStop(r.from))} · ${esc(r.label)}${r.via?.length ? `<br><span class="muted">Umstieg: ${r.via.map(v => `${esc(cleanStop(v.at))}${v.platform ? ` (${esc(platWord(v, v.platform))})` : ""} → ${esc(v.label)}`).join(", ")}</span>` : ""}</p>`}
      <p class="small muted" style="margin:8px 0 0">Fahrtage</p>${dayChips(r.days, `data-rday="${r.id}" data-d`)}
      <label class="small chk"><input type="checkbox" data-rhol="${r.id}" ${r.holidays ? "checked" : ""}> An Feiertagen (Berlin) nicht fahren</label>
      <p class="small muted" style="margin:10px 0 2px">Aussetzen (z. B. Urlaub, Ferien)</p>
      <div class="win-row"><input type="date" id="rsf-${r.id}" min="${t0}" value="${nx ? nx.date : t0}" aria-label="von"><span>bis</span><input type="date" id="rst-${r.id}" min="${t0}" value="${nx ? nx.date : t0}" aria-label="bis"></div>
      <button class="btn sec mini" data-rrange="${r.id}" style="margin:6px 0 0">Diese Tage aussetzen</button>
      ${r.skip.length ? `<p class="small" style="margin:6px 0 0">Ausgesetzt: ${skipChips(r)}</p>` : ""}
      <button class="btn sec" data-rchange="${r.id}" style="margin:14px 0 8px">Zeit oder Strecke ändern</button>
      <div class="mini-row"><button class="btn sec mini" data-rname="${r.id}">Umbenennen</button>
        <button class="btn sec mini" data-rshare="${r.id}">↗ Teilen</button>
        <button class="btn sec mini" data-rpause="${r.id}">${r.paused ? "Wieder überwachen" : "Pausieren"}</button>
        <button class="btn danger mini" data-rdel="${r.id}">Löschen</button></div>
      </div>` : ""}</div>`;
}
// Ausgesetzte Tage: aufeinanderfolgende Tage als Zeitraum zusammenfassen
function skipChips(r) {
  const groups = []; for (const d of [...r.skip].sort()) { const g = groups[groups.length - 1], prev = g && new Date(Date.parse(g[1] + "T12:00:00Z") + 864e5).toISOString().slice(0, 10);
    if (g && prev === d) g[1] = d; else groups.push([d, d]); }
  return groups.map(([a, b]) => `<button class="chip" data-runskip="${r.id}|${a}|${b}" title="Wieder fahren">${a === b ? dateWord(a) : `${dateWord(a)} – ${dateWord(b)}`} ✕</button>`).join(" ");
}
async function rCall(path, opts) { try { const v = await api(path, opts); return v; } catch (e) { alert(e.message); return null; } }
async function reloadRoutines() { ROUTINES = await api("/api/routines").catch(() => ROUTINES); render(); }
function bindRoutines() {
  const R = id => ROUTINES.find(r => r.id === id);
  $app.querySelectorAll("[data-ropen]").forEach(b => b.onclick = () => { R_OPEN = R_OPEN === b.dataset.ropen ? null : b.dataset.ropen; render(); });
  if (R_SCROLL) { document.getElementById(`r-${R_SCROLL}`)?.scrollIntoView({ block: "start" }); R_SCROLL = null; }
  $app.querySelectorAll("[data-rday]").forEach(b => b.onclick = async () => { const r = R(b.dataset.rday), d = +b.dataset.d;
    const days = r.days.includes(d) ? r.days.filter(x => x !== d) : [...r.days, d]; if (!days.length) return alert("Mindestens ein Tag.");
    await rCall(`/api/routines/${r.id}`, { method: "PATCH", body: { days } }); reloadRoutines(); });
  // Zeitfenster speichert sofort (wie Tage und Feiertage)
  $app.querySelectorAll("[data-rwin]").forEach(b => b.onchange = async () => { const id = b.dataset.rwin, f = document.getElementById(`rwf-${id}`).value, t = document.getElementById(`rwt-${id}`).value;
    if (!f || !t || t <= f) return alert("Das Ende des Zeitfensters muss nach dem Beginn liegen.");
    await rCall(`/api/routines/${id}`, { method: "PATCH", body: { winFrom: f, winTo: t } }); flash = "Zeitfenster gespeichert."; reloadRoutines(); });
  $app.querySelectorAll("[data-rrange]").forEach(b => b.onclick = async () => { const id = b.dataset.rrange, f = document.getElementById(`rsf-${id}`).value, t = document.getElementById(`rst-${id}`).value || f;
    if (!f) return; if (t < f) return alert("Das Ende des Zeitraums muss am oder nach dem Anfang liegen.");
    const txt = f === t ? dateWord(f) : `${dateWord(f)} bis ${dateWord(t)}`;
    if (!(await ask(`${txt[0].toUpperCase()}${txt.slice(1)} aussetzen?\n\nIn dieser Zeit lege ich keine Fahrten an und überwache nichts. Danach geht es automatisch weiter.`, { ok: "Aussetzen" }))) return;
    await rCall(`/api/routines/${id}/skip`, { method: "POST", body: { date: f, to: t } }); await loadTrips().catch(() => {}); reloadRoutines(); });
  $app.querySelectorAll("[data-rchange]").forEach(b => b.onclick = () => changeRoutine(R(b.dataset.rchange)));
  $app.querySelectorAll("[data-rhol]").forEach(b => b.onchange = async () => { await rCall(`/api/routines/${b.dataset.rhol}`, { method: "PATCH", body: { holidays: b.checked } }); reloadRoutines(); });
  $app.querySelectorAll("[data-rpause]").forEach(b => b.onclick = async () => { const r = R(b.dataset.rpause); await rCall(`/api/routines/${r.id}`, { method: "PATCH", body: { paused: !r.paused } }); reloadRoutines(); });
  $app.querySelectorAll("[data-rname]").forEach(b => b.onclick = async () => { const r = R(b.dataset.rname), n = await ask("Neuer Name", { input: r.name, ok: "Speichern" }); if (!n) return;
    await rCall(`/api/routines/${r.id}`, { method: "PATCH", body: { name: n } }); reloadRoutines(); });
  $app.querySelectorAll("[data-rskip]").forEach(b => b.onclick = async () => { const [id, date] = b.dataset.rskip.split("|");
    const dw = dateWord(date), when = dw === "heute" || dw === "morgen" ? dw[0].toUpperCase() + dw.slice(1) : `Am ${dw}`;
    if (!(await ask(`${when} nicht fahren?\n\nIch überwache diese Fahrt dann an dem Tag nicht.`, { ok: "Nicht fahren" }))) return;
    await rCall(`/api/routines/${id}/skip`, { method: "POST", body: { date } }); await loadTrips().catch(() => {}); reloadRoutines(); });
  $app.querySelectorAll("[data-runskip]").forEach(b => b.onclick = async () => { const [id, date, to] = b.dataset.runskip.split("|");
    await rCall(`/api/routines/${id}/skip`, { method: "POST", body: { date, to: to || date, on: false } }); reloadRoutines(); });
  $app.querySelectorAll("[data-rshare]").forEach(b => b.onclick = () => shareRoutine(R(b.dataset.rshare), b));
  $app.querySelectorAll("[data-rdel]").forEach(b => b.onclick = async () => { const r = R(b.dataset.rdel);
    if (!(await ask(`„${r.name}“ löschen?\n\nEs werden keine neuen Fahrten mehr angelegt. Schon angelegte Fahrten bleiben, bis sie vorbei sind.`, { ok: "Löschen", danger: true }))) return;
    await rCall(`/api/routines/${r.id}`, { method: "DELETE" }); R_OPEN = null; flash = `„${r.name}“ wird nicht mehr überwacht.`; await loadTrips().catch(() => {}); reloadRoutines(); });
}
function changeRoutine(r) {
  if (!r) return;
  startWizard(); W.regIntent = true; W.step = "regsetup"; W.replaceR = r.id; W.rFrom = r.fromPl; W.rTo = r.toPl;
  const [h, m] = (r.win ? r.win[0] : r.dep).split(":").map(Number), pad = x => String(x).padStart(2, "0");
  W.reg = { name: r.name, days: [...r.days], kind: r.win ? "win" : "fix", at: r.dep, from: r.win ? r.win[0] : r.dep, to: r.win ? r.win[1] : `${pad(Math.min(23, h + 1))}:${pad(m)}`, hol: r.holidays };
  go("add");
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
      <div class="mini-row"><button class="btn sec mini" data-rpause="${r.id}">${r.paused ? "Wieder überwachen" : "Pausieren (z. B. Urlaub)"}</button>
      <button class="btn danger mini" data-rstop="${r.id}">Regelmäßig beenden</button></div></div>`;
  }
  if (t.routine) return "";
  if (t.phase === "done" || t.follow) return "";
  // Tage passend zur Fahrt vorbelegen: Werktag → Mo–Fr, Wochenende → nur dieser Tag
  if (RF.for !== t.id) { const dow = ((new Date(new Date(t.legs[0].dep.plan).toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" }) + "T12:00:00Z").getUTCDay() + 6) % 7) + 1;
    RF.for = t.id; RF.days = dow <= 5 ? [1, 2, 3, 4, 5] : [dow]; }
  return `<div class="rform"><p class="k" style="margin:14px 0 4px">Regelmäßig überwachen</p>
    <p class="small muted" style="margin:0 0 6px">Z. B. für den Weg zur Arbeit: An jedem Fahrtag lege ich diese Verbindung vorher an und überwache sie – mit Fernzug ca. 3 Std., sonst ca. 1 Std. vor der Abfahrt.</p>
    <input class="txt" id="rfName" maxlength="40" placeholder="Name, z. B. Schule oder Arbeit" value="${esc(RF.name)}">
    ${dayChips(RF.days, "data-rfd")}
    <label class="small chk"><input type="checkbox" id="rfHol" ${RF.hol ? "checked" : ""}> An Feiertagen (Berlin) nicht fahren</label>
    <button class="btn sec" id="rfSave">${esc(daysText(RF.days))} um ${hm(t.legs[0].dep.plan)} überwachen</button></div>`;
}
function bindRoutineForm(t) {
  const $ = id => document.getElementById(id);
  bindRoutines();
  $app.querySelectorAll("[data-rstop]").forEach(b => b.onclick = async () => { const r = ROUTINES.find(x => x.id === b.dataset.rstop);
    if (!(await ask(`Regelmäßige Überwachung „${r.name}“ beenden?\n\nEs werden keine neuen Fahrten mehr angelegt. Diese Fahrt bleibt, bis sie vorbei ist – du kannst sie unten auch löschen.`, { ok: "Beenden", danger: true }))) return;
    await rCall(`/api/routines/${r.id}`, { method: "DELETE" }); flash = `„${r.name}“ wird nicht mehr regelmäßig überwacht.`;
    ROUTINES = await api("/api/routines").catch(() => ROUTINES); await loadTrips().catch(() => {}); render(); });
  $("rfName")?.addEventListener("input", e => { RF.name = e.target.value; });
  $app.querySelectorAll("[data-rfd]").forEach(b => b.onclick = () => { const d = +b.dataset.rfd; RF.days = RF.days.includes(d) ? RF.days.filter(x => x !== d) : [...RF.days, d].sort(); render(); });
  $("rfHol")?.addEventListener("change", e => { RF.hol = e.target.checked; });
  $("rfSave")?.addEventListener("click", async () => {
    if (!RF.days.length) return alert("Bitte mindestens einen Tag wählen.");
    const tpl = t.legs.map(l => `${nice(l)} ${hm(l.dep.plan)}`).join(" → ");
    const tight = (t.transfers || []).filter(x => x.status === "WATCH" || x.status === "RISK" || x.tightPlan).map(x => `${cleanStop(x.at || "")} (${Math.round(x.gap)} Min.)`);
    if (!(await ask(`Regelmäßig überwachen?\n\n${daysText(RF.days)} um ${hm(t.legs[0].dep.plan)} gilt diese Verbindung als Muster:\n${tpl}${tight.length ? `\n\nAchtung: Umstieg in ${tight.join(", ")} ist knapp. Wenn du sonst anders fährst, ändere die Fahrt vorher.` : ""}\n\nIch lege die Fahrt an jedem dieser Tage ein paar Stunden vorher selbst an.`, { ok: "Ja, so jeden Tag", cancel: "Vorher ändern" }))) return;
    const r = await rCall("/api/routines", { method: "POST", body: { tripId: t.id, name: RF.name.trim(), days: RF.days, holidays: RF.hol } });
    if (!r) return;
    Object.assign(RF, { days: [1, 2, 3, 4, 5], name: "", hol: true });
    await loadTrips().catch(() => {}); ROUTINES = await api("/api/routines").catch(() => ROUTINES);
    flash = `„${r.name}“ wird jetzt ${daysText(r.days)} um ${r.dep} überwacht.`; sheetId = null; render(); scrollTo(0, 0);
  });
}

// Der nächste Schritt – groß und eindeutig
// Nach dem Aussteigen: klar zeigen, womit es weitergeht – Zug und Ziel, Abfahrt, Gleis, Zeit zum Umsteigen
function thenBox(n, t) {
  const th = n.then, nl = t?.legs?.[n.i + 1], tr = t?.transfers?.[n.i];
  const cls = th.gap < 0 || tr?.status === "RISK" || tr?.status === "LOST" ? "bad" : tr?.status === "WATCH" ? "watch" : "ok";
  const name = esc(/^\d/.test(th.label) && nl?.mode && MODE[nl.mode] ? `${MODE[nl.mode][0]} ${th.label}` : th.label);
  const late = nl ? Math.round((Date.parse(nl.dep.rt) - Date.parse(nl.dep.plan)) / MIN) : 0;
  const fromPl = n.platform, toPl = th.platform;
  return `<div class="then-box">
    <div class="tb-k">Weiter mit</div>
    <div class="tb-main"><b>${name}</b>${nl?.arr?.name ? ` <span class="muted">→ ${esc(cleanStop(nl.arr.name))}</span>` : ""}</div>
    <div class="tb-row"><span class="tb-t">${hm(th.at)}</span>${toPl ? gl(toPl, th) : ""}<span class="muted small">${inMin(th.at)}</span></div>
    ${late >= 2 ? `<div class="small"><span class="late">${late} Min. später</span> · geplant ${hm(nl.dep.plan)}</div>` : ""}
    ${th.platformChanged ? `<div class="small"><span class="late">Gleiswechsel (statt Gleis ${esc(th.platformPlan)})</span></div>` : ""}
    <div class="tb-gap ${cls}">${th.gap >= 0 ? `${dur(th.gap)} zum Umsteigen` : `voraussichtlich ${-th.gap} Min. zu spät`}${fromPl && toPl ? (String(fromPl).trim() === String(toPl).trim() ? ` · am selben Gleis` : ` · Gleis ${esc(fromPl)} → Gleis ${esc(toPl)}`) : ""}</div>
  </div>`;
}
function nextCard(n, t) {
  if (!n) return "";
  if (n.kind === "missed") return `<section class="card next"><div class="k">${vehicleOf(t?.legs?.[n.i]).n} verpasst</div>
      <div><b>${esc(n.label)}</b> ab ${esc(cleanStop(n.station))} hast du nicht bekommen.</div>
      <button class="btn quiet small-btn" data-caught="${t.id}">Doch erwischt – zurück zum Plan</button></section>`;
  // erst nach der Abfahrt sinnvoll – und nur bis 2 Std. danach
  const since = n.depAt ? Date.now() - Date.parse(n.depAt) : -1, leg = t?.legs?.[n.i];
  const missBtn = t && t.follow !== true && n.i != null && (n.kind === "ride-change" || n.kind === "ride-arrive") && since >= 0 && since <= 20 * MIN
    ? `<button class="link small miss" data-missed="${t.id}|${n.i}">Doch nicht eingestiegen? Neu suchen</button>` : "";
  if (n.kind === "lost") return `<section class="card next"><div class="k">${n.cancelled ? "Anschluss fällt aus" : "Anschluss verpasst"}</div>
      <div><b>${esc(n.label)}</b> ${n.cancelled ? "fällt aus" : "ist schon weg"}. Bleib in <b>${esc(n.station)}</b>. Deine Möglichkeiten stehen oben und unter „Plan B“.</div></section>`;
  const head = { board: "Einsteigen", change: "Umsteigen", "ride-change": n.then?.lost ? "Nächster Halt" : "Nächster Halt: umsteigen", "ride-arrive": "Ankunft" }[n.kind];
  const pc = n.platformChanged ? `<span class="late">Gleiswechsel${n.platformPlan ? ` (statt Gleis ${esc(n.platformPlan)})` : ""}</span>` : "";
  let body;
  if ((n.kind === "board" || n.kind === "change") && n.cancelled) body = `<div class="big"><s>${hm(n.at)}</s> <span class="late">fällt aus</span></div>
      <div><b>${esc(n.label)}</b> ab ${esc(n.station)} fährt nicht. Nimm eine der Möglichkeiten darunter.</div>`;
  else if (n.kind === "board" || n.kind === "change") body = `<div class="big">${hm(n.at)} ${gl(n.platform, n)}</div>${pc ? `<div class="small">${pc}</div>` : ""}${lateLine(n.delay, n.plan)}
      <div><b>${esc(/^\d/.test(n.label) && n.mode && MODE[n.mode] ? `${MODE[n.mode][0]} ${n.label}` : n.label)}</b> ab ${esc(n.station)}${n.dest ? ` <span class="muted">→ ${esc(n.dest)}</span>` : ""}</div>
      <div class="muted small">${n.cancelled ? `<span class="late">fällt aus</span>` : inMin(n.at)}</div>
      ${t && n.kind === "board" && t.phase === "before" && (Date.parse(t.legs[0].dep.rt) - Date.now() < 2 * 3600e3 || accOf(t)?.min) ? accessBox(t) : ""}
      ${n.from && !sameStation(n.from.name, n.station) ? `<div class="walk-box">Zu Fuß von ${esc(cleanStop(n.from.name))} zu ${esc(cleanStop(n.station))} ${walkBtn(n.from, { name: n.station, lat: n.lat, lon: n.lon })}</div>` : ""}`;
  else body = `<div class="big">${hm(n.at)} ${gl(n.platform, n)}</div>${lateLine(n.delay, n.plan)}
      <div>${n.kind === "ride-change" ? "Aussteigen in" : "Ankunft in"} <b>${esc(cleanStop(n.station))}</b>${n.platform ? "" : ""}</div>
      ${n.then && n.then.station && !sameStation(n.then.station, n.station) ? `<div class="walk-box">Danach zu Fuß zu ${esc(cleanStop(n.then.station))} ${walkBtn({ name: n.station, lat: n.lat, lon: n.lon }, { name: n.then.station, lat: n.then.lat, lon: n.then.lon })}</div>` : ""}
      ${n.then ? (n.then.lost ? `<div class="muted small">${inMin(n.at)}</div>`
        : thenBox(n, t)) : `<div class="muted small">${inMin(n.at)}</div>`}`;
  return `<section class="card next"><div class="k">${head}</div>${body}${missBtn}</section>`;
}

// Vergleich: pro Option nur das Entscheidende – der knappste Umstieg (an → weiter) und die Ankunft am Ziel.
// Züge, Gleise, Startbahnhof erst auf Antippen.
let openCmp = null;
const sameStation = (a, b) => { const k = x => cleanStop(x).replace(/^Berlin[- ]/, "").replace(/[^a-zäöüß0-9]/gi, "").toLowerCase(); return k(a) === k(b); };
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
  const tag = a => a.from === "start" && Date.parse(a.depPlan || a.dep) < firstPlan - MIN && a.kind !== "later" ? "Früher losfahren" : a.kind === "stay" || (a.legs?.length === 1 && a.label === curLeg.label) ? (a.from === "start" || t.phase === "before" ? `Mit ${esc(a.legs?.[0]?.label || a.label || curLeg.label)} direkt ans Ziel` : `Im ${esc(a.legs?.[0]?.label || a.label || curLeg.label)} sitzen bleiben`) : ({ safer: "Mehr Zeit zum Umsteigen", faster: "Schneller da", later: (a.legs?.length || 1) > 1 ? "Spätere Verbindung" : "Später, direkt ans Ziel", must: "Rechtzeitig zum festen Zug", next: a.transfers ? "Nächste Möglichkeit" : "Nächster Zug direkt ans Ziel" }[a.kind] || "Andere Verbindung");
  const rec = bestIdx(tr.alt, t.plan.dep);
  // Dein Plan: der knappste offene Umstieg mit Echtzeit
  const cur = t.transfers.filter(x => x.status !== "DONE").sort((a, b) => a.gap - b.gap)[0];
  const curNext = t.legs.find(l => Date.parse(l.dep.rt) > Date.now() - MIN) || t.legs[0];
  const curState = curNext.dep.cancelled ? `<span class="badge bad">fällt aus</span>` : tr.status === "LOST" ? `<span class="badge bad">Anschluss in ${esc(cleanStop(tr.at))} klappt nicht</span>`
    : tr.status === "RISK" ? `<span class="badge warn">Anschluss in ${esc(cleanStop(tr.at))} ${tr.gap < 0 ? "klappt wohl nicht" : "gefährdet"}</span>` : curNext.dep.delay >= 3 ? `<span class="badge warn">${esc(nice(curNext))} ${curNext.dep.delay} Min. später</span>` : curNext.live ? `<span class="badge good">pünktlich</span>` : "";
  const curRow = lost ? "" : `<div class="pb-plan"><span class="muted">Dein Plan:</span> an <b>${hm(t.plan.arr)}</b>${curState ? ` · ${curState}` : ""}</div>`;
  const hide = dupAlts(tr.alt, rec);
  // Kandidaten: machbar, keine Doppelten; die empfohlene zuerst, dann früh am Ziel mit genug Zeit zum Umsteigen
  const better = a => betterAlt(a, tr, t);
  const cand = tr.alt.map((a, ai) => ({ a, ai })).filter(x => !hide.has(x.ai) && !infeasible(x.a) && x.a.kind !== "asplanned" && better(x.a));
  const score = x => (x.ai === rec ? -1e15 : 0) + Date.parse(x.a.arr || x.a.dep) - Math.min(gapOf(x.a) ?? 15, 15) * MIN;
  cand.sort((x, y) => score(x) - score(y));
  const all = PB_ALL === t.id, top = all ? cand : cand.slice(0, 3);
  const pg = tr.gap != null ? Math.round(tr.gap) : null;
  // Warum diese Möglichkeit eher klappt als dein Plan – höchstens drei kurze Gründe
  const whyOf = a => { const out = [], n = Math.max(0, (a.legs?.length || 1) - 1), g = gapOf(a), w = a.watch;
    if (a.reach) out.push({ ok: 1, t: esc(a.reach) });
    if (!n) out.push({ ok: 1, t: lost ? "Ohne Umstieg – direkt ans Ziel" : "Ohne Umstieg – kein Anschluss, der platzen kann" });
    else if (g != null) out.push(g < Math.max(need, 3) ? { bad: 1, t: `Umstieg auch knapp: ${g} Min.` }
      : { ok: 1, t: `${g} Min. zum Umsteigen${!lost && pg != null && g > pg ? ` statt ${pg < 0 ? "zu spät" : `nur ${pg} Min.`}` : ""}` });
    if (w?.cancelled) out.push({ bad: 1, t: "Fällt aus" });
    else if (w?.live && w.ok && !w.legs?.some(l => l.delay >= 3)) out.push({ ok: 1, t: "Live geprüft: pünktlich" });
    else if (w?.live && w.ok) { const dl = Math.max(0, ...(w.legs || []).map(l => l.delay || 0)); out.push({ bad: 1, t: n ? `Live: ${dl} Min. verspätet, Umstieg passt trotzdem` : `Live: ${dl} Min. verspätet` }); }
    else out.push({ muted: 1, t: "Nur Fahrplan – noch ohne Live-Daten" });
    if (zbOn && a.zb) out.push({ bad: 1, t: "Sparpreis gilt hier evtl. nicht" });
    return out.slice(0, 3); };
  const ref = Date.parse(lost ? t.planArr || t.plan.arr : t.plan.arr);
  const arrNote = a => { const d = Math.round((Date.parse(a.arr || a.dep) - ref) / MIN);
    return Math.abs(d) < 2 ? "gleich am Ziel" : d < 0 ? `<b class="ok-t">${fmtSpan(-d)} früher am Ziel</b>` : `${fmtSpan(d)} später${lost ? " als geplant" : ""}`; };
  const rows = top.map(({ a, ai }) => { const id = `${t.id}:${k}:${ai}`, isOpen = openCmp === id, r = ai === rec;
    return `<div class="pb-alt${r ? " is-rec" : ""}"><div class="pa-h"><b>${tag(a)}</b>${recTag(r)}</div>
      <div class="pa-t">ab <b>${hm(a.dep)}</b>${a.from === "start" ? "" : ` ${esc(cleanStop(a.at))}`} → an <b>${esc(dayPre(a.arr || a.dep))}${hm(a.arr || a.dep)}</b> <span class="muted">· ${arrNote(a)}</span></div>
      <ul class="pa-why">${whyOf(a).map(w => `<li class="${w.bad ? "bad" : w.muted ? "mut" : "ok"}">${w.t}</li>`).join("")}</ul>
      <div class="pa-act"><button class="btn ${r ? "small-btn" : "sec mini"}" data-adopt="${t.id}|${k}|${ai}" data-zb="${a.zb !== false && a.zb ? "1" : ""}" data-adopt-text="${esc(`${tag(a)}: ab ${hm(a.dep)}, an ${hm(a.arr || a.dep)}\n${a.label}`)}">Diese nehmen</button>
        <button class="link small" data-cmp="${id}" aria-expanded="${isOpen}">${isOpen ? "Züge ausblenden" : "Züge zeigen"}</button></div>
      ${isOpen ? stepsHtml(altSteps(a)) : ""}</div>`; }).join("")
    + (cand.length > 3 ? `<button class="link small pb-more" data-pball="${t.id}">${all ? "Weniger zeigen" : `${cand.length - 3} weitere Möglichkeit${cand.length - 3 > 1 ? "en" : ""}`}</button>` : "")
    || `<p class="small" style="margin:0">Dein Plan ist gerade die beste Möglichkeit – keine andere Verbindung gibt dir mehr Zeit zum Umsteigen. Ich prüfe weiter und melde mich, wenn es nicht mehr reicht.</p>`;
  const zb = zbOn && tr.alt.some(a => a.zb !== false) ? `<p class="small zb-warn tile-note"><b>Sparpreis:</b> Wo „Sparpreis gilt hier evtl. nicht“ steht, fährst du mit einem anderen Fernzug. Das ist erst erlaubt, wenn die Zugbindung aufgehoben ist. Bus, S-/U-Bahn und Regionalzüge darfst du immer frei wählen.</p>` : "";
  const here = `<button class="chip here-chip" data-here="${t.id}">${PIN} Ab meinem Standort suchen</button>`;
  if (calm) {
    // Plan ist knapp, aber gerade in Ordnung: ruhig zeigen, dass es Ausweichmöglichkeiten gibt
    const n = tr.alt.length, good = tr.alt.filter(a => a.watch?.ok && a.watch.live && !a.watch.legs.some(l => l.delay >= 3)).length, liveN = tr.alt.filter(a => a.watch?.live).length, open = openCmp === `calm:${t.id}`;
    const sum = tr.alt.some(a => a.watch) ? `${n} Ausweichmöglichkeit${n > 1 ? "en" : ""} im Blick – ${!liveN ? "noch ohne Live-Daten" : good === n ? (n > 1 ? "alle pünktlich" : "pünktlich") : `${good} davon pünktlich`}.` : `${n} Ausweichmöglichkeit${n > 1 ? "en" : ""} gefunden. Live prüfe ich sie, sobald es eng wird.`;
    return `<section class="card calm"><div class="k">Falls es knapp wird</div><p class="small" style="margin:0">Dein Umstieg in ${esc(cleanStop(tr.at))} ist mit ${tr.planGap} Min. knapp geplant. ${esc(sum)}</p>
      <button class="btn sec mini" data-cmp="calm:${t.id}">${open ? "Möglichkeiten zuklappen" : "Möglichkeiten zeigen"}</button></section>${open ? `<div class="pb-list">${zb}${rows}</div>` : ""}`;
  }
  // im Rahmen wie Plan B, mit ✕ zum Ausblenden (kommt von selbst wieder, wenn es schlimmer wird)
  return `${curRow}${top.length ? `<div class="pb-sub">${lost ? "So kommst du jetzt weiter" : top.length > 1 ? "Diese Möglichkeiten klappen eher" : "Diese Möglichkeit klappt eher"}</div>` : ""}<div class="pb-list">${zb}${rows}</div>`;
}
// Kurz: Umstiege und Übernachtung in einer Zeile, die Züge erst auf Antippen
function altSummary(a, id, isOpen) {
  const n = Math.max(0, (a.legs?.length || 1) - 1), night = nightOf(a);
  const bits = [n ? `${n} Umstieg${n > 1 ? "e" : ""}` : "ohne Umstieg", night ? `🌙 Übernachtung in ${esc(night.at)}` : ""].filter(Boolean).join(" · ");
  return `<div class="alt-sum small">${bits} <button class="link small" data-cmp="${id}" aria-expanded="${isOpen}">${isOpen ? "Züge ausblenden" : "Züge zeigen"}</button></div>`;
}
// Fast gleiche Möglichkeiten nur einmal: dieselben Züge (ohne Bus/Tram/U-Bahn am Ende), es bleibt die empfohlene bzw. die früher ankommende
function dupAlts(list, rec) {
  const key = a => (a.legs || []).filter(l => isTrainLeg(l)).map(l => `${l.label}@${l.from.plan}`).join("|");
  const seen = new Map(), hide = new Set();
  (list || []).forEach((a, i) => { const kk = key(a); if (!kk) return;
    if (!seen.has(kk)) { seen.set(kk, i); return; }
    const j = seen.get(kk), keepI = i === rec || (j !== rec && Date.parse(a.arr || a.dep) < Date.parse(list[j].arr || list[j].dep));
    if (keepI) { hide.add(j); seen.set(kk, i); } else hide.add(i); });
  return hide;
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
  const d0 = steps[0] ? Date.parse(steps[0].dep) : 0;
  const dTag = iso => sameDay(Date.parse(iso), d0) ? "" : `<span class="st-day">${new Date(iso).toLocaleDateString("de-DE", { weekday: "short", timeZone: "Europe/Berlin" })}</span>`;
  return `<ol class="steps-l">${steps.map((x, i) => `<li><span class="st-t">${dTag(x.dep)}${stepTime(x.dep, x.depPlan, x.live)}</span><span class="st-b"><b>${esc(x.label)}</b>${stepLive(x)}${x.pl ? ` <span class="muted">${esc(platWord({ label: x.label, mode: x.mode }, x.pl))}</span>` : ""} ${esc(cleanStop(x.from))} → ${esc(cleanStop(x.to))} <span class="muted">an ${stepTime(x.arr, x.arrPlan, x.live)}</span></span></li>
    ${i < steps.length - 1 ? `<li class="st-x"><span class="st-t"></span><span class="st-b muted">${(() => { const g = Math.round((Date.parse(steps[i + 1].dep) - Date.parse(x.arr)) / MIN);
      const walk = plainStop(x.to) !== plainStop(steps[i + 1].from) && (x.walk == null || x.walk > 0);
      if (g < 0) return `<span class="late">Anschluss klappt wohl nicht – ${-g} Min. zu spät</span>`;
      const walkTxt = walk ? `, zu Fuß zu ${esc(cleanStop(steps[i + 1].from))}${x.walk ? ` (ca. ${x.walk} Min.)` : ""}` : "";
      if (nightGap(x.arr, steps[i + 1].dep)) return `<b class="warn-t">🌙 Übernachtung in ${esc(cleanStop(x.to))}</b> · weiter ${esc(dayPre(steps[i + 1].dep))}${hm(steps[i + 1].dep)}${walkTxt}`;
      if (g >= 60) return `Aufenthalt ${fmtSpan(g)}${walkTxt}`;
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
  const notes = [refDep && w(dd, "früher los", "später los"), refArr && (Math.abs(da) < 2 ? "gleich am Ziel" : da > 0 && !sameDay(Date.parse(arr), Date.parse(refArr)) ? `statt ${sameDay(Date.parse(refArr), Date.now()) ? "heute " : ""}${hm(refArr)}` : da < 0 ? `<b class="ok-t">${fmtSpan(-da)} früher am Ziel</b>` : `${fmtSpan(da)} später am Ziel`)].filter(Boolean);
  const nd = sameDay(Date.parse(arr), Date.parse(dep)) ? "" : `${new Date(arr).toLocaleDateString("de-DE", { weekday: "short", timeZone: "Europe/Berlin" })} `;
  return `<div class="cmp-times">ab <b>${hm(dep)}</b> <span class="muted">→</span> an <b>${nd}${hm(arr)}</b></div>${notes.length ? `<div class="cmp-goal">${notes.join(" · ")}</div>` : ""}`;
}
const fmtSpan = m => (m >= 60 ? `${Math.floor(m / 60)} Std.${m % 60 ? ` ${m % 60} Min.` : ""}` : `${m} Min.`);

// Umstiegszeit für die Suche: eingestellte Zeit, mit „Mehr Puffer“ 10 Min. mehr (mind. 15)
const searchMin = () => { const base = W?.editId ? +W.minT || 0 : MINT; return W?.buf ? Math.max(15, Math.max(base, 5) + 10) : base; };
// Fahrrad, Rollstuhl & Co. sind (noch) nicht berücksichtigt – dezent darauf hinweisen
const SPECIAL = `<p class="small muted special-note">🚲 ♿ Fahrrad, Rollstuhl, Kinderwagen oder großes Gepäck? Das berücksichtige ich noch nicht – bitte bei der Bahn bzw. deinem Verkehrsverbund prüfen. <a href="/hilfe.html">Mehr</a></p>`;
// Knopf „Diese Verbindung nehmen“: nur die empfohlene Möglichkeit gefüllt, nicht machbare ohne Knopf
const infeasible = a => !!(a.watch && (a.watch.cancelled || !a.watch.ok));
// Empfehlung: früheste Ankunft – aber möglichst ohne Umstieg, der rot (zu knapp) angezeigt wird
const gapOf = a => a.watch?.minGap ?? a.minGap;
// Sitzenbleiben/Durchfahren bekommt 5 Min. Vorsprung (kein Umsteigen, kein Rennen); viel früher losfahren zählt als Nachteil.
// Gilt der Sparpreis bei keiner Möglichkeit, wird keine empfohlen.
const bestIdx = (list, refDep) => {
  const ref = refDep ? Date.parse(refDep) : NaN;
  const pick = strict => { let b = -1, best = Infinity; (list || []).forEach((a, i) => { if (infeasible(a) || a.kind === "asplanned") return;
    const g = gapOf(a); if (CUR_ZB && a.zb) return; if (strict && g != null && g < Math.max(ownMin(), 3)) return;   // nicht empfehlen: Sparpreis gilt evtl. nicht / zu knapp
    const early = Number.isFinite(ref) ? Math.max(0, (ref - Date.parse(a.dep)) / MIN - 10) : 0;
    const v = Date.parse(a.arr || a.dep) - ((a.kind === "stay" || a.stayOn || a.stay) ? 5 * MIN : 0) + early * MIN;
    if (v < best) { best = v; b = i; } }); return b; };
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
  if (!w) return `<span class="muted small">nur Fahrplan · live, sobald es eng wird</span>`;
  if (w.cancelled) return `<span class="badge bad">fällt aus</span>`;
  if (!w.ok) return `<span class="badge bad">Anschluss klappt nicht</span>`;
  // Einzelne Verspätungen stehen bei den Teilstrecken – hier nur, was am Ende zählt: die Ankunft
  if (!w.live) return `<span class="muted small">noch ohne Live-Daten</span>`;
  const ad = a.arrPlan && a.arr ? Math.max(w.arrDelay || 0, Math.round((Date.parse(a.arr) - Date.parse(a.arrPlan)) / MIN)) : (w.arrDelay || 0);
  return ad >= 2 ? `<span class="badge warn">verspätet, +${ad} Min.</span>` : `<span class="badge good">pünktlich</span>`;
}

// ---------- SOS: im Zug, Verspätung angesagt → sofort Ausstiege und Alternativen ----------
let sosBusy = null;
// „Ich sitze im …“-Knopf: rot nur, wenn wirklich Gefahr besteht – sonst zurückhaltend
// Plan B: ein zentraler Knopf. Beim Öffnen der Fahrt immer zu; farbig, wenn Plan B gebraucht wird. Ein Tipp öffnet den Kasten.
let OPT_OPEN = null;
const RANK = { OK: 0, PLAN: 0, WATCH: 1, RISK: 2, LOST: 3 };
// Laut Fahrplan schon knapp geplant? (dann die Plan-Kachel nicht grün)
const planTight = t => { const own = +t.minT || 0; return (t.transfers || []).some(x => Math.round(x.gap) < Math.max(own, 5)); };
// „klappt eher“ als dein Plan: ohne Umstieg, mehr Zeit zum Umsteigen, früher am Ziel oder rechtzeitig zum festen Zug – sonst nicht anbieten
function betterAlt(a, tr, t) {
  const pg = tr.gap != null ? Math.round(tr.gap) : null;
  return tr.status === "LOST" || pg == null || pg < 0 || !!a.reach || (a.legs?.length || 1) <= 1 || (gapOf(a) ?? 99) > pg + 1 || Date.parse(a.arr || a.dep) < Date.parse(t.plan.arr) - 2 * MIN;
}
function optionsBlock(t) {
  if (t.phase === "done") return "";
  const busy = t.missed != null || t.sos || sosBusy === t.id || t.here || hereBusy === t.id;
  if (t.win && !t.win.picked && t.phase === "before") return `${sosButton(t)}${windowCard(t)}`;
  // Plan B erst, wenn es live Abweichungen gibt (knapp, gefährdet, verpasst) – vorher passt man die Fahrt über „Ändern“ an
  if (!busy && OPT_OPEN !== t.id && (planOnly(t) || !["WATCH", "RISK", "LOST"].includes(t.status))) return "";
  const st = planOnly(t) ? "OK" : t.status, k = t.transfers.findIndex(x => x.status !== "DONE" && x.alt?.length), nAlt = k >= 0 ? (() => { const L = t.transfers[k].alt, h = dupAlts(L, bestIdx(L, t.plan.dep)); return L.filter((a, i) => !h.has(i) && !infeasible(a) && a.kind !== "asplanned" && betterAlt(a, t.transfers[k], t)).length; })() : 0;
  const tone = st === "LOST" ? "bad" : st === "RISK" ? "risk" : st === "WATCH" ? "watch" : "calm";
  const sub = st === "LOST" ? "Anschluss weg – so kommst du weiter" : st === "RISK" ? "Anschluss gefährdet – Möglichkeiten ansehen" : st === "WATCH" ? (t.transfers.some(x => x.status === "WATCH") ? "Umstieg knapp – Möglichkeiten ansehen" : "Verspätung – Möglichkeiten ansehen") : "Andere Verbindung suchen";
  if (!busy && OPT_OPEN !== t.id) return `<button class="planb-btn ${tone}" data-optopen="${t.id}"><span class="pb-ic">⇄</span><span class="pb-tx"><b>Plan B</b><span>${nAlt && tone !== "calm" && st !== "LOST" ? `${sub.replace(" – Möglichkeiten ansehen", "")} · ${nAlt} ${nAlt > 1 ? "Möglichkeiten" : "Möglichkeit"} ansehen` : sub}</span></span><span class="chev">›</span></button>`;
  const body = t.missed != null ? hereCard(t) : t.sos || sosBusy === t.id ? sosCard(t) : t.here || hereBusy === t.id ? hereCard(t) : planBCard(t) + hereCard(t);
  return `<section class="planb-box ${tone}"><div class="pb-head"><b>Plan B</b><button class="card-x" data-pbclose="${t.id}" aria-label="Plan B schließen">✕</button></div>${body}</section>`;
}
function sosButton(t) {
  if (!sosAvailable(t) || t.sos || sosBusy === t.id || t.missed != null) return "";
  const urgent = t.status === "RISK" || t.status === "LOST";
  return `<button class="btn ${urgent ? "sos-btn" : "sec"} sos-big" data-sos="${t.id}"><b>${urgent ? "Jetzt neu suchen" : "Neue Verbindung suchen"}</b><span>Ich sitze ${vehicleOf(t.legs[ridingLeg(t)]).im} – such mir ab hier eine andere Verbindung</span></button>`;
}
// In welcher Fahrt sitzt du gerade? (auch: Zug steht mit Verspätung noch am Startbahnhof) – sonst -1
function ridingLeg(t) {
  const now = Date.now(), i = t.legs.findIndex(l => now >= Date.parse(l.dep.rt) - MIN && now < Date.parse(l.arr.rt));
  if (i > 0 && t.transfers[i - 1]?.status === "LOST") return -1;   // Anschluss verpasst: du sitzt nicht in diesem Zug, sondern wartest am Umstieg
  if (i >= 0) return i;
  const f = t.legs[0];
  return t.phase === "before" && now >= Date.parse(f.dep.plan) && f.dep.delay >= 3 ? 0 : -1;
}
// Nur sinnvoll, wenn du drin sitzt und danach noch umsteigst – auf der letzten Fahrt direkt zum Ziel bringt Aussteigen nichts
const sosAvailable = t => { const i = ridingLeg(t); return i >= 0 && i < t.legs.length - 1; };
function sosCard(t) {
  const bad = t.status === "RISK" || t.status === "LOST";
  if (sosBusy === t.id) return `<section class="card ${bad ? "sos" : "planb"}"><div class="k">Plan B</div><p style="margin:0">Ich suche, wo du aussteigen kannst und wie du am schnellsten ans Ziel kommst …</p><div class="spinner"></div></section>`;
  const s = t.sos; if (!s) return "";
  const i = s.info || {}, zb0 = t.ticket === "spar" && !t.zbLifted;
  const where = i.onTrain ? `Du sitzt wohl im <b>${esc(i.label)}</b>${i.near ? ` bei ${esc(i.near)}` : ""}` : `Als Nächstes laut Plan: <b>${esc(i.label)}</b>`;
  const exits = (s.exits || []).slice(0, 4).map(x => `${esc(x.name)} ${hm(x.arr)}${x.delay >= 3 ? ` <span class="late">+${x.delay}</span>` : ""}`).join(" · ");
  const ci = Math.max(0, t.current), mine = { ...t, legs: t.legs.slice(ci), transfers: t.transfers.slice(ci) };
  const rec = bestIdx(s.list);
  const plan = `<div class="cmp-row cur"><div class="cmp-tag">${s.plan && !s.plan.ok ? `Dein Plan klappt nicht: ${esc(t.title)}` : "Dein Plan"}</div><div class="cmp-main">${losZiel(mine.legs[0].dep.rt, s.plan?.arr || t.plan.arr)}${stepsHtml(planSteps(mine))}</div></div>`;
  const rows = (s.list || []).map((a, k) => `<div class="cmp-row ${arrTone(a.arr, t.planArr || t.plan.arr, a.watch)}"><div class="cmp-tag">${a.stayOn ? `Im ${esc(i.label)} sitzen bleiben` : `In ${esc(cleanStop(a.at))} aussteigen`}${recTag(k === rec)}</div><div class="cmp-main">
      <div class="small">${a.stayOn ? `Bis ${esc(cleanStop(a.at))}, an ca. <b>${hm(a.exitAt)}</b>` : `Mit ${esc(i.label)} bis ${esc(cleanStop(a.at))}, an <b>${hm(a.exitAt)}</b>`}${a.exitDelay >= 3 ? ` <span class="late">${a.exitDelay} Min. später</span>` : ""}</div>
      ${a.stayOn ? "" : losZiel(a.dep, a.arr, null, t.planArr)}${a.stayOn ? "" : stepsHtml(altSteps(a))}
      <div class="cmp-live">${a.stayOn ? "" : liveBadge(a)}${zb0 && a.zb ? ` ${zbBadge}` : ""}</div>
      ${takeBtn(`${t.id}|${a.from}|${k}|sos`, a, k === rec, a.stayOn ? `Im ${i.label} sitzen bleiben bis ${cleanStop(a.at)}, an ca. ${hm(a.exitAt)}` : `In ${cleanStop(a.at)} aussteigen (an ${hm(a.exitAt)}), dann ${a.label} – Ziel ca. ${hm(a.arr)}`)}
    </div></div>`).join("");
  const ok = !s.plan || s.plan.ok !== false;
  return `<section class="card ${bad ? "sos" : "planb"}">
      <p style="margin:0 0 4px">${where} <span class="small muted">(${i.located && i.near ? "per Standort" : "geschätzt nach Fahrplan"})</span>.</p>
      ${exits ? `<p class="small muted" style="margin:0">Nächste Halte: ${exits}</p>` : ""}
      ${rows ? `<div class="tiles" style="margin-top:8px">${plan}${rows}</div>` : `<p style="margin:8px 0 0"><b>${ok ? "Keine bessere Verbindung – dein Plan klappt." : "Gerade keine andere Verbindung gefunden."}</b> <span class="small muted">Ich behalte ${vehicleOf(t.legs[Math.max(0, t.current)]).dein} im Blick.</span></p>`}
      <div class="seg-info small"><span class="muted">Stand ${hm(new Date(s.at).toISOString())}</span><button class="link" data-sos="${t.id}">↻ Erneut suchen</button></div></section>`;
}

// Möglichkeiten ab dem eigenen Standort (nur auf Knopfdruck)
let hereBusy = null, SELF_OPEN = null, PB_ALL = null;
// Drei gleich große Knöpfe nebeneinander: ab Start (zur Reisezeit) · mein Standort zur Reisezeit · mein Standort jetzt
function searchSeg(t, cur) {
  const enroute = t.phase === "enroute", ns = nextStop(t);
  // Sitzt du drin und steigst danach noch um: „Woanders aussteigen“ sucht Ausstiege entlang der Fahrt (früher der große Knopf „Jetzt neu suchen“)
  const sos = sosAvailable(t) && !t.sos && sosBusy !== t.id && t.missed == null ? [["sos", "Woanders aussteigen", `${vehicleOf(t.legs[ridingLeg(t)]).im} suchen`]] : [];
  const opts = enroute ? [...sos, ["next", `Ab ${cleanStop(ns.name)}`, `ab ${hm(ns.at)}`], ["now", "Mein Standort", "jetzt"]]
    : [["start", `Ab ${cleanStop(t.legs[0].dep.name).replace(/\//g, "/\u200b")}`, "zur Reisezeit"], ["trip", "Mein Standort", "zur Reisezeit"], ["now", "Mein Standort", "jetzt"]];
  return `<div class="seg" role="group" aria-label="Selbst suchen" style="grid-template-columns:repeat(${opts.length},1fr)">${opts.map(([m, a, b]) =>
    m === "sos" ? `<button data-sos="${t.id}"><b>${esc(a)}</b><span>${esc(b)}</span></button>`
    : `<button data-here="${t.id}" data-mode="${m}" aria-pressed="${m === cur}"><b>${m === "trip" || m === "now" ? PIN : ""}${esc(a)}</b><span>${esc(b)}</span></button>`).join("")}</div>`;
}
function hereCard(t) {
  if (t.phase === "done") return "";
  if (hereBusy === t.id) return `<section class="card"><div class="k">Andere Verbindungen</div><div class="spinner"></div></section>`;
  if (!t.here) return SELF_OPEN === t.id ? `<div class="self-search"><div class="k">Selbst suchen</div>${searchSeg(t, null)}</div>`
    : `<div class="self-search"><button class="btn sec mini" data-selfopen="${t.id}">🔎 Selbst suchen</button></div>`;
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
    return `<div class="cmp-row ${arrTone(a.arr, t.planArr || t.plan.arr, a.watch)}"><div class="cmp-tag">${mode === "next" && a.legs?.[0] && a.legs[0].label.replace(/\s/g, "") === t.legs[ci].label.replace(/\s/g, "") ? `Im ${esc(t.legs[ci].label)} sitzen bleiben` : a.kind === "samefv" ? `Zu deinem ${esc(a.legs.find(l => /^(ICE|IC|EC|RJ|NJ|EN|TGV)\b/i.test(l.label))?.label.split(" ")[0] || "Zug")}` : a.transfers ? (Date.parse(a.arr) < ref - MIN ? "Schneller da" : "Andere Verbindung") : "Direkt ans Ziel"}${recTag(i === rec)}</div><div class="cmp-main">
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
  return `<section class="card"><div class="k">Andere Verbindungen</div>
    ${searchSeg(t, mode)}
    <div class="seg-info small muted"><span>${mode === "now" ? "ab sofort" : mode === "next" ? `ab ${esc(cleanStop(ns.name))}, an ${hm(ns.at)}` : `geplante Zeit · ${day(t.legs[0].dep.plan)}`}</span>
      <button class="link" data-here="${t.id}" data-mode="${mode}">↻ Aktualisieren</button></div></section>
    <div class="tiles">${planTile}${rows.trim() || `<div class="cmp-row"><p class="small muted" style="margin:0">Keine andere Verbindung gefunden.</p></div>`}</div>`;
}

// Fußweg-Navigation: iPhone → Apple Karten, sonst Google Maps
// Ziel: genaue Koordinaten des Bahnhofs (sonst Name + „Bahnhof“). Start: Koordinaten der Haltestelle, sonst der eigene Standort.
function walkUrl(a, b, mode) {
  const car = mode === "CAR";
  const has = x => x && x.lat != null && x.lon != null;
  const dest = has(b) ? `${b.lat},${b.lon}` : `${cleanStop(b.name)} Bahnhof`;
  const orig = has(a) ? `${a.lat},${a.lon}` : "";
  if (isIOS) return `https://maps.apple.com/?${orig ? `saddr=${encodeURIComponent(orig)}&` : ""}daddr=${encodeURIComponent(dest)}&dirflg=${car ? "d" : "w"}`;
  return `https://www.google.com/maps/dir/?api=1${orig ? `&origin=${encodeURIComponent(orig)}` : ""}&destination=${encodeURIComponent(dest)}&travelmode=${car ? "driving" : "walking"}`;
}
const walkBtn = (a, b, mode) => `<a class="walk" href="${walkUrl(a, b, mode)}" target="_blank" rel="noopener">Weg zeigen ↗</a>`;

// Verkehrsmittel vor reine Liniennummern schreiben (auch für ältere Reisen)
const MODE = { BUS: ["Bus", "Bus"], COACH: ["Bus", "Bus"], TRAM: ["Tram", "Tram"], FERRY: ["Fähre", "Fähre"], SUBWAY: ["U", "U-Bahn"], METRO: ["U", "U-Bahn"] };
const nice = l => { const m = MODE[l.mode]; return m && /^\d/.test(l.label) ? `${m[0]} ${l.label}` : l.label; };
// Richtiges Wort fürs Verkehrsmittel (wie im Server): Zug, Bus, Tram, U-Bahn, Fähre
const isTrain = l => /RAIL/.test(String(l?.mode || "")) || /^(ICE|IC|EC|ECE|RJX?|NJ|EN|IRE|RE|RB|S|FLX|D|TGV|ES|EST|MEX|ALX|ODEG|HEX)\s*\d/i.test(String(l?.label || "").trim());
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
      <span class="ln"><span class="chip-t">${esc(nice(l))}</span>${l.must ? ` <span class="must">${vehicleOf(l).fest.toLowerCase()}</span>` : ""}${l.live ? "" : ` <span class="muted small">noch ohne Live-Zeit</span>`}${l.dep.cancelled || l.arr.cancelled ? ` <span class="late">fällt aus</span>` : ""}<br>
        <span class="small">${esc(l.dep.name)} → ${esc(l.arr.name)}</span></span>
      <span class="pl small">${esc(platWord(l, l.dep.platform))}</span></button>
      ${open ? `<div class="detail small">
        <div>Ab ${esc(l.dep.name)}: plan ${hm(l.dep.plan)}${l.dep.delay ? `, jetzt ${hm(l.dep.rt)}` : ""}${l.dep.platform ? `, ${esc(platWord(l, l.dep.platform))}` : ""}${!isStreet(l) && l.dep.platformPlan && l.dep.platform !== l.dep.platformPlan ? ` (statt ${esc(l.dep.platformPlan)})` : ""}</div>
        <div>An ${esc(l.arr.name)}: plan ${hm(l.arr.plan)}${l.arr.delay ? `, jetzt ${hm(l.arr.rt)}${l.arr.estimated ? " (geschätzt)" : ""}` : ""}${l.arr.platform ? `, ${esc(platWord(l, l.arr.platform))}` : ""}</div>
        ${[...(l.dep.messages || []), ...(l.arr.messages || [])].slice(0, 3).map(m => `<div class="muted">${esc(m)}</div>`).join("")}
        ${l.live ? "" : `<div class="muted">${l.jid ? (Date.parse(l.dep.rt) < Date.now() ? "Die Bahn liefert zu diesem Zug gerade keine Prognose – angezeigt wird der Fahrplan." : "Noch keine Prognose der Bahn – kommt meist kurz vor der Abfahrt.")
          : isTrain(l) ? "Zu diesem Zug habe ich (noch) keine Live-Daten der Bahn – angezeigt wird der Fahrplan. Ich versuche es weiter."
          : Date.parse(l.dep.rt) < Date.now() ? "Für diese Fahrt liefert der Verkehrsbetrieb keine Live-Zeiten – angezeigt wird der Fahrplan."
          : "Live-Zeiten kommen, sobald der Verkehrsbetrieb sie liefert (meist ab 2 Std. vorher)."}</div>`}
        ${l.abroad && l.jid ? `<div class="muted">${l.abroadLive ? "Ankunft im Ausland: live über Transitous (offene Daten der Nachbarländer)." : "Ankunft im Ausland: geschätzt aus der Verspätung bei der Abfahrt – Live-Daten von dort gibt es für diese Strecke (noch) nicht."}</div>` : ""}
        ${t.legs.length > 1 && Date.parse(l.dep.rt) > Date.now() ? `<button class="chip" style="margin-top:8px" data-must="${t.id}|${l.must ? "" : i}">${l.must ? "Nicht mehr fest einplanen" : `${kindWord(l)} fest einplanen`}</button>` : ""}
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
  if (tr.status === "LOST") return tr.reason === "cancel" ? `<b>Anschluss fällt aus</b>` : `<b>Anschluss klappt nicht</b>${pl}`;
  if (tr.toMust && (tr.status === "RISK" || tr.status === "LOST")) return `<b>${vehicleOf(tr.toLeg).fest} in Gefahr:</b> ${tr.gap >= 0 ? `${tr.gap} Min.` : `Ankunft ${-tr.gap} Min. nach Abfahrt`}${pl}`;
  if (tr.status === "RISK" && tr.own && tr.gap >= 0 && tr.gap < tr.own) return `<b>${tr.gap} Min., zu knapp für dich</b>${pl}`;
  if (tr.status === "WATCH" && tr.own && tr.gap >= 0 && tr.gap < tr.own) return `<b>${tr.gap} Min.</b> – etwas weniger als deine ${tr.own} Min.${pl}`;
  if (tr.status === "RISK") return tr.gap < 0 ? `<b>klappt wohl nicht</b> – Ankunft ${-tr.gap} Min. nach Abfahrt${pl}` : `<b>nur ${tr.gap} Min.</b>${pl}`;
  if (tr.status === "WATCH") return `<b>${tr.gap} Min., knapp</b>${pl}`;
  return `${tr.gap} Min.${pl}`;
}

let TL_OPEN = false;   // „Ganze Reise“ unterwegs aufgeklappt?
// Ticket sichtbar in der Fahrt: Sparpreis = Zugbindung; Deutschlandticket im Fernzug gilt nicht
function ticketNote(t) {
  const fv = t.legs.filter(l => isFVc({ label: l.label, mode: l.mode })).map(l => esc(l.label));
  if (t.ticket === "spar") return ` · Sparpreis${fv.length ? ` (Zugbindung: ${[...new Set(fv)].join(", ")})` : ""}`;
  if (t.ticket === "dticket") return fv.length ? ` · <span class="warn-t">Deutschlandticket gilt nicht im ${[...new Set(fv)].join(", ")}</span>` : " · Deutschlandticket";
  if (t.ticket === "bc100") return " · BahnCard 100";
  return "";
}
function renderTrip(t, many) {
  CUR_OWN = +t.minT || 0; CUR_ZB = t.ticket === "spar" && !t.zbLifted;
  const checked = t.legs.flatMap(l => [l.dep.checked, l.arr.checked]).filter(Boolean), fresh = checked.length ? Math.max(...checked) : null;
  const noLive = t.legs.every(l => !l.dep.live && !l.arr.live);
  const sheet = sheetId === t.id;
  if (BLK?.id === t.id) return renderBlocks(t);   // Fahrt ändern als Bausteine
  if (SCREEN_SIG.split("|")[3] !== String(t.id)) OPT_OPEN = null;   // neu in die Fahrt gekommen: Plan B erst einmal zu
  const SK = stuckOf(t);     // „Heute nicht mehr“: ruhiger Bildschirm statt Alarm
  const hint = "";   // Hinweise zu App/Mitteilungen nur auf der Startseite – in der Fahrt stören sie
  $app.innerHTML = `${flashBox()}
    <div class="trip-head"><h1 class="th-title">${t.rname ? `<span class="th-r">↻ ${esc(t.rname)}</span>` : ""}${route(t)}</h1>
      <div class="th-act">${t.follow === true ? `<button class="chip del-chip" data-del="${t.id}">Nicht mehr mitverfolgen</button></div>` : `<button class="act fav-btn" data-favt="${t.id}" aria-pressed="${isFav(t)}" title="${isFav(t) ? "Favorit entfernen" : "Als Favorit merken"}"><i>${isFav(t) ? "★" : "☆"}</i>Favorit</button>${t.phase !== "done" ? `<button class="act" data-share="${t.id}" title="Ankunft oder Verbindung an andere schicken"><i>↗</i>Teilen</button>` : ""}${showBahn(t) ? `<button class="act" data-bahn="${t.id}" title="Ticket bei der Bahn kaufen"><i>🛒</i>Ticket kaufen</button>` : ""}${t.phase === "before" ? `<button class="act" data-edit="${t.id}"><i>✎</i>Ändern</button>` : ""}${t.phase !== "enroute" ? `<button class="act del-chip" data-del="${t.id}" aria-label="Fahrt löschen"><i>🗑</i>Löschen</button>` : ""}</div>`}<p class="muted small">${day(t.legs[0].dep.plan)} · ${hm(t.legs[0].dep.rt)} – ${t.status === "LOST" ? `<span class="late">Ankunft ${hm(t.planArr || t.plan.arr)} nicht mehr erreichbar</span>` : `${hm(t.legs[t.legs.length - 1].arr.rt)}${sameDay(Date.parse(t.legs[t.legs.length - 1].arr.rt), Date.parse(t.legs[0].dep.plan)) ? "" : ` (${new Date(t.legs[t.legs.length - 1].arr.rt).toLocaleDateString("de-DE", { weekday: "short", timeZone: "Europe/Berlin" })})`}`}${t.legs.length > 1 ? ` · ${t.legs.length - 1} Umstieg${t.legs.length > 2 ? "e" : ""}` : ""}${ticketNote(t)}</p></div>
    ${t.follow === true ? `<p class="small explain">👀 <b>Mitverfolgt.</b> Diese Fahrt hat dir jemand geteilt. Nimmt die reisende Person unterwegs eine andere Verbindung, ziehe ich hier automatisch nach. Die Hinweise sind aus ihrer Sicht geschrieben.</p>`
      : t.follow === "gone" ? `<p class="small explain">👀 Die geteilte Fahrt wurde beim Absender gelöscht – ich überwache diese Verbindung hier einfach weiter.</p>` : ""}
    ${SK ? stuckView(t, SK) : t.follow === true ? followHero(t) : `<section class="hero s-${planOnly(t) ? `PLAN compact${planTight(t) ? " tight" : ""}` : t.status}"><div class="k">${heroKicker(t)}</div><h2>${planOnly(t) ? "Geplant – laut Fahrplan passt alles" : esc(t.title)}</h2>
      ${!planOnly(t) && t.status === "OK" && t.transfers?.some(x => x.status !== "DONE") ? `<p>${t.transfers.filter(x => x.status !== "DONE").length > 1 ? "Alle Umstiege klappen" : "Dein Umstieg klappt"}: ${t.transfers.filter(x => x.status !== "DONE").map(x => `${esc(cleanStop(x.at || ""))} ${Math.round(x.gap)} Min.`).join(" · ")}</p>` : ""}
      ${planOnly(t) ? (() => { const own = +t.minT || 0, tight = (t.transfers || []).filter(x => Math.round(x.gap) < Math.max(own, 5));
        return `<p>${Date.parse(t.legs[0].dep.plan) - Date.now() > 45 * MIN ? "Live-Daten gibt es meist erst kurz vor der Abfahrt. " : ""}Ich melde mich, wenn etwas nicht passt.</p>${tight.length ? `<p class="small warn-t">Umstieg in ${tight.map(x => `${esc(cleanStop(x.at || ""))} (${Math.round(x.gap)} Min.)`).join(", ")} ist schon laut Fahrplan knapp – über „Ändern“ kannst du mehr Puffer wählen.</p>` : ""}`; })() : t.status === "OK" || t.status === "DONE" ? "" : `<p>${esc(t.sub.replace(/ (Plan B|Vorschlag):.*$/, "").replace(" Ich behalte das im Blick.", ""))}</p>`}${heroRec(t)}</section>`}
    ${t.zbLifted && !SK ? `<div class="banner"><b>Dein Sparpreis gilt jetzt voraussichtlich auch in anderen Zügen.</b> Grund: ${esc(t.zbWhy || (t.legs.some(l => l.dep.cancelled || l.arr.cancelled) ? "Zugausfall" : "Verspätung bzw. absehbar verpasster Anschluss"))} (DB-Regeln zur Zugbindung). <a href="https://www.bahn.de/faq/zugbindung-aufgehoben-bedeutung" target="_blank" rel="noopener">Regeln</a></div>` : ""}
    ${t.win?.picked ? windowCard(t) : ""}
    ${t.canUndo ? `<div class="banner info small row" style="align-items:center"><span style="flex:3">Du fährst jetzt mit ${esc(t.legs.map(l => nice(l)).join(" → "))}.${t.ticket === "spar" && !t.zbLifted && t.undoZb ? " Achtung: Dein Sparpreis gilt hier evtl. nicht, solange die Zugbindung nicht aufgehoben ist." : ""}</span><button class="chip" data-undo="${t.id}" style="flex:0 0 auto">Zurück zum alten Plan</button></div>` : ""}
    ${t.rnote ? `<div class="banner info small">↻ ${esc(t.rnote)}</div>` : ""}
    ${t.follow === true || SK ? "" : nextCard(t.next, t)}
    ${t.phase === "before" ? retCard(RET?.tripId === t.id) : ""}
    ${t.follow === true || SK ? "" : optionsBlock(t)}
    ${SK && STUCK_ORIG !== t.id ? "" : `<h3 class="sec-h">${SK ? "Ursprüngliche Fahrt" : t.phase === "enroute" ? "Ganze Fahrt" : "Verlauf"}</h3><div class="card flat">${timeline(t)}</div>`}
    <p class="foot">${fresh ? `Geprüft um ${hm(fresh)}` : "Noch nicht geprüft"}${noLive ? " · nur Fahrplan" : ""} · ohne Gewähr</p>
    <button class="btn sec mini center" data-sheet="${t.id}">${sheet ? "Einstellungen schließen" : "Einstellungen dieser Fahrt"}</button>
    ${sheet ? `<section class="card" id="sheet">
      <p class="small muted">Zeit, die ich mindestens zum Umsteigen brauche</p>
      <div class="chips">${MINT_OPTS.map(([m, l]) => `<button class="chip" data-tmt="${m}" aria-pressed="${(t.minT || 0) === m}">${l}</button>`).join("")}</div>
      <p class="small muted">Ticket (nur für den Hinweis zur Zugbindung)</p>
      <div class="chips">${[["spar", "Sparpreis"], ["flex", "Flexpreis / weiß nicht"], ["dticket", "Deutschlandticket"], ["bc100", "BahnCard 100"]].map(([k, l]) => `<button class="chip" data-tk="${k}" aria-pressed="${t.ticket === k}">${l}</button>`).join("")}</div>
      ${routineForm(t)}
      <div class="danger-zone"><button class="btn danger mini" data-del="${t.id}">Fahrt löschen</button><p class="small muted" style="margin:4px 0 0">Wird nicht mehr überwacht und verschwindet aus der Liste.</p></div></section>` : ""}
    ${hint}
    <button class="btn sec mini center" data-go="add">＋ Weitere Fahrt hinzufügen</button>`;
  $app.querySelector("[data-list]")?.addEventListener("click", () => { openId = null; sheetId = null; render(); scrollTo(0, 0); });
  $app.querySelectorAll("[data-cmp]").forEach(b => b.onclick = () => { openCmp = openCmp === b.dataset.cmp ? null : b.dataset.cmp; render(); });
  $app.querySelectorAll("[data-selfopen]").forEach(b => b.onclick = () => { SELF_OPEN = b.dataset.selfopen; render(); });
  $app.querySelectorAll("[data-pball]").forEach(b => b.onclick = () => { PB_ALL = PB_ALL === b.dataset.pball ? null : b.dataset.pball; render(); });
  $app.querySelectorAll("[data-leg]").forEach(b => b.onclick = () => { openLeg = openLeg === b.dataset.leg ? null : b.dataset.leg; render(); });
  $app.querySelector("[data-sheet]").onclick = () => { sheetId = sheet ? null : t.id; render(); };
  $app.querySelector("[data-tlopen]")?.addEventListener("click", () => { TL_OPEN = !TL_OPEN; render(); });
  $app.querySelector("[data-skorig]")?.addEventListener("click", e => { STUCK_ORIG = STUCK_ORIG === t.id ? null : t.id; render(); });
  $app.querySelector("[data-gohome]")?.addEventListener("click", async e => {
    const b = e.currentTarget, h = t.stuck?.home?.[0], home = cleanStop(t.legs[0].dep.name); if (!h) return;
    if (!(await ask(`Fahrt abbrechen und zurück nach ${home}?\n\n${h.label}: ab ${hm(h.dep)}, an ${hm(h.arr)}\n\nEs wird nichts gebucht. Die Fahrt nach ${destOf(t)} wird beendet, ich überwache dann den Rückweg.`, { ok: "Zurückfahren" }))) return;
    b.disabled = true;
    try {
      const n = await api("/api/trips", { method: "POST", body: { legs: h.legs, ticket: t.ticket } });
      await api(`/api/trips/${t.id}`, { method: "DELETE" }).catch(() => {});
      openId = n.id; flash = `Alles klar – ich überwache jetzt deinen Rückweg nach ${home}.`;
    } catch (err) { alert(err.message); }
    await loadTrips().catch(() => {}); render(); scrollTo(0, 0);
  });
  // Regelmäßige Fahrt: gilt die Änderung nur heute oder für alle Fahrten?
  $app.querySelectorAll("[data-share]").forEach(b => b.onclick = () => shareTrip(t, b));
  $app.querySelectorAll("[data-bahn]").forEach(b => b.onclick = async () => {
    const url = bahnUrl(t), x = bahnUrl.last;
    const show = n => cleanStop(n.replace(/, Berlin$/, ""));
    const ok = await ask(`Weiter zu bahn.de?\n\nDas wird übergeben:\nStart: ${show(x.from)}\nZiel: ${show(x.to)}\nAbfahrt: ${day(x.at)}, ${hm(x.at)}\n1 Person, 2. Klasse${t.legs.filter(isTrainLeg).length > 1 ? `\n\nWähle dort diese Züge: ${t.legs.filter(isTrainLeg).map(l => `${l.label} (${hm(l.dep.plan)})`).join(" → ")}` : ""}${x.cut ? `\n\nIns Ausland kann ich die Fahrt nur bis zum letzten deutschen Bahnhof übergeben. Die Strecke ${show(x.to)} → ${x.cut} ergänzt du bitte bei bahn.de oder buchst sie beim Bahnunternehmen im Ausland.` : ""}\n\nPrüfe bei der Bahn Reisende, Ermäßigung und Verbindung. Gebucht und bezahlt wird nur dort.`, { ok: "Zu bahn.de", cancel: "Abbrechen" });
    if (ok) window.open(url, "_blank", "noopener");
  });
  $app.querySelectorAll("[data-edit]").forEach(b => b.onclick = async () => {
    const r = t.routine && ROUTINES.find(x => x.id === t.routine);
    if (r) { const a = await ask(`Was möchtest du ändern?\n\n„${r.name}“ ist eine regelmäßige Fahrt.`, { ok: `Nur ${dateWord(new Date(t.legs[0].dep.plan).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }))}`, alt: "Alle Fahrten" });
      if (a === "alt") return changeRoutine(r); if (!a) return; }
    openBlocks(t); });
  $app.querySelectorAll("[data-favt]").forEach(b => b.onclick = () => { const was = isFav(t); toggleFav(t); flash = was ? "Aus den Favoriten entfernt." : "Als Favorit gemerkt – du findest ihn unter „Neue Fahrt“."; render(); });
  const patch = async body => { await api(`/api/trips/${t.id}`, { method: "PATCH", body }).catch(e => alert(e.message)); await loadTrips().catch(() => {}); render(); };
  $app.querySelectorAll("[data-tmt]").forEach(b => b.onclick = () => patch({ minT: +b.dataset.tmt }));   // nur diese Reise
  $app.querySelectorAll("[data-tk]").forEach(b => b.onclick = () => patch({ ticket: b.dataset.tk }));
  $app.querySelectorAll("[data-must]").forEach(b => b.onclick = e => { e.stopPropagation(); const v = b.dataset.must.split("|")[1]; patch({ mustLeg: v === "" ? null : +v }); });
  bindRoutineForm(t);
  bindAccess(t); bindRet();
  $app.querySelectorAll("[data-optopen]").forEach(b => b.addEventListener("click", () => { const only = "optonly" in b.dataset; OPT_OPEN = only || OPT_OPEN !== t.id ? t.id : null; render();
    if (only) $app.querySelector(".planb-box")?.scrollIntoView({ behavior: "smooth", block: "start" }); }));
  bindHints();
  bindCommon();
}

// Einstellungen: App installieren und Mitteilungen – immer erreichbar, auch wenn ein Hinweis weggeklickt wurde
function appCard() {
  const ps = pushState(), row = (l, v, c = "") => `<div class="kv"><span>${l}</span><b class="${c}">${v}</b></div>`;
  const pushTxt = { on: "eingeschaltet", off: "noch aus", blocked: "blockiert", none: isIOS && !standalone ? "erst in der App möglich" : "in diesem Browser nicht möglich" }[ps];
  const bShown = BNAME() === "diesem Browser" ? "unbekannt (gibt sich als Chrome aus)" : BROWSER;
  return `<section class="card" id="appcard"><div class="k">App &amp; Mitteilungen</div>
    ${row("Browser", esc(bShown) + (isIOS ? " (iPhone/iPad)" : isAndroid ? " (Android)" : ""))}
    ${row("Als App", standalone ? "installiert" : "nicht installiert – läuft im Browser", standalone ? "ok-t" : "")}
    ${row("Mitteilungen", pushTxt, ps === "on" ? "ok-t" : ps === "off" ? "" : "late")}
    ${standalone ? "" : weakBrowser() ? `<p class="small" style="margin:10px 0 6px">In ${esc(BNAME())} gehen keine Mitteilungen aufs Handy, und „Zum Startbildschirm“ legt nur eine Verknüpfung an. Die App selbst funktioniert – Warnungen siehst du beim Öffnen.
        Mitteilungen gehen z. B. in <b>Firefox</b>, <b>Samsung Internet</b>, <b>Edge</b> oder <b>Chrome</b>. Deine Fahrten nimmst du mit: unten bei „Geräte“ einen Code anzeigen und im anderen Browser eingeben.</p>
        ${isAndroid ? `<div class="chips">${openerBtns("chip")}</div>` : ""}`
      : `<p class="small" style="margin:10px 0 6px"><b>Als App installieren:</b> ${INSTALL ? "Ein Tipp genügt." : installHow()}</p>${INSTALL ? `<button class="btn sec" id="installApp">Als App installieren</button>` : ""}
        ${isIOS ? `<p class="small muted">Die App auf dem iPhone startet leer. Deine Fahrten nimmst du mit: unten bei „Geräte“ einen Code anzeigen und in der App eingeben.</p>` : ""}`}
    ${ps === "on" ? `<button class="btn sec" id="pushTest">Test-Mitteilung senden</button>`
      : ps === "off" ? `<button class="btn" id="pushOn">Mitteilungen einschalten</button>${standalone || isIOS ? "" : `<p class="small muted">Geht auch im Browser – als App ist es aber zuverlässiger.</p>`}`
      : ps === "blocked" ? `<p class="small"><b>So erlaubst du Mitteilungen:</b> ${unblockHow()}</p><button class="btn sec" data-reload>Erledigt – neu prüfen</button>` : ""}
    ${!pushHere() || ps === "on" ? "" : `<p class="small muted" style="margin-top:8px">Kommt nach dem Einschalten keine Test-Mitteilung? Dann sind Mitteilungen für ${standalone ? "die App" : `${esc(BROWSER)}`} evtl. in den Android-/Handy-Einstellungen aus.</p>`}</section>`;
}
function renderSettings() {
  const perm = "Notification" in window ? Notification.permission : "nicht unterstützt";
  const on = perm === "granted" && localStorage.getItem("rb_push") === "1";
  $app.innerHTML = `<h1>Einstellungen</h1>
    <section class="card"><div class="k">Darstellung</div>
      <div class="chips">${[["auto", "Automatisch"], ["light", "Hell"], ["dark", "Dunkel"]].map(([k, l]) => `<button class="chip" data-theme-set="${k}" aria-pressed="${THEME === k}">${l}</button>`).join("")}</div>
      <p class="small muted">Automatisch folgt der Einstellung deines Geräts.</p></section>
    <section class="card"><div class="k">Meine übliche Umstiegszeit</div>${minTChips()}
      <p class="small muted">Gilt für neue Reisen. Bei einer Reise änderst du sie unter „Einstellungen dieser Fahrt“.</p></section>
    ${recoveryCard()}
    ${devicesCard()}
    ${appCard()}
    <p class="foot">Echtzeitdaten: DB InfraGO (OpenBoards) · Verbindungen: Transitous/MOTIS · Angaben ohne Gewähr</p>`;
  $app.querySelectorAll("[data-theme-set]").forEach(b => b.onclick = () => { THEME = b.dataset.themeSet; try { localStorage.setItem("rb_theme", THEME); } catch {} applyTheme(); render(); });
  $app.querySelectorAll("[data-mt]").forEach(b => b.onclick = () => { setMinT(+b.dataset.mt); render(); });
  document.getElementById("pushTest")?.addEventListener("click", () => api("/api/push/test", { method: "POST" }).then(r => alert(r.ok ? "Gesendet – kommt gleich an." : "Konnte nicht gesendet werden.")).catch(e => alert(e.message)));
  bindDevices(); bindRecovery();
  bindHints();
  bindCommon();
}

// ---------- Konto sichern: Wiederherstellungscode (hilft, wenn Browserdaten gelöscht werden oder das Handy weg ist) ----------
const REC = { has: null, asked: false };
const loadRec = () => { if (!AUTH || REC.asked) return; REC.asked = true; api("/api/recovery").then(r => { REC.has = r.has; REC.at = r.at; REC.lost = r.lost; if (view === "settings" || view === "home") render(); }).catch(() => { REC.asked = false; }); };
function recoveryCard() {
  loadRec();
  return `<section class="card" id="recovery"><div class="k">Konto sichern</div>
    <p class="small" style="margin-top:0">Umstiegsheld kennt dich nur über dieses Gerät. Löschst du die Browserdaten oder ist das Handy weg, sind deine Fahrten sonst nicht mehr erreichbar. Mit einem Wiederherstellungscode holst du alles auf jedem Gerät zurück.</p>
    ${REC.lost ? `<p class="small warn-t" style="margin:6px 0"><b>Dein bisheriger Code gilt nicht mehr</b>, weil Geräte verbunden wurden. Bitte einen neuen erstellen.</p>` : ""}
    ${REC.has ? `<p class="small" style="margin:6px 0"><b class="ok-t">✓ Code erstellt</b>${REC.at ? ` am ${dayShort(REC.at).replace(/\.$/, "")}` : ""}. Hast du ihn nicht mehr, erstelle einen neuen – der alte gilt dann nicht mehr.</p>
      <button class="btn sec small-btn" id="recNew">Neuen Code erstellen</button>`
    : `<button class="btn sec small-btn" id="recNew">Wiederherstellungscode erstellen</button>`}
    <p class="small muted" style="margin:6px 0 0">Zurückholen: unten bei „Deine Geräte“ → „Code eingeben“.</p></section>`;
}
async function makeRecovery() {
  if (REC.has && !(await ask("Neuen Code erstellen?\n\nDer bisherige Code gilt danach nicht mehr.", { ok: "Neuen Code erstellen" }))) return;
  let code; try { code = (await api("/api/recovery", { method: "POST" })).code; } catch (e) { return alert(e.message); }
  REC.has = true; REC.lost = false; REC.at = new Date().toISOString();
  const pm = "PasswordCredential" in window;
  const w = document.createElement("div"); w.className = "dlg-wrap";
  w.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-label="Dein Wiederherstellungscode"><h2>Dein Wiederherstellungscode</h2>
    <div class="rec-code">${esc(code)}</div>
    <p class="small">Gut aufheben – z. B. im Passwort-Manager oder als Foto. Ich zeige ihn nur jetzt. Wer ihn hat, sieht deine Fahrten: nicht weitergeben.</p>
    <div class="dlg-btns"><button class="btn sec" data-copy>Kopieren</button><button class="btn sec" data-send>An mich senden</button></div>
    ${pm ? `<div class="dlg-btns" style="margin-top:8px"><button class="btn sec" data-pm>Im Passwort-Manager speichern</button></div>` : ""}
    <div class="dlg-btns" style="margin-top:10px"><button class="btn" data-no>Ich habe ihn gesichert</button></div></div>`;
  w.querySelector("[data-copy]").onclick = async e => { try { await navigator.clipboard.writeText(code); e.target.textContent = "Kopiert ✓"; } catch { e.target.textContent = "Bitte abschreiben"; } };
  // An eine Adresse deiner Wahl: Teilen-Menü (Mail, Notizen, Messenger an dich selbst) – sonst E-Mail ohne Empfänger
  w.querySelector("[data-send]").onclick = async () => {
    const text = `Mein Umstiegsheld-Wiederherstellungscode: ${code}\n\nZurückholen: umstiegsheld.de → Einstellungen → „Deine Geräte“ → „Code eingeben“. Nicht weitergeben.`;
    try { if (navigator.share) return await navigator.share({ title: "Umstiegsheld – Wiederherstellungscode", text }); } catch (e) { if (e?.name === "AbortError") return; }
    location.href = `mailto:?subject=${encodeURIComponent("Umstiegsheld – Wiederherstellungscode")}&body=${encodeURIComponent(text)}`;
  };
  w.querySelector("[data-pm]")?.addEventListener("click", async e => { try { await navigator.credentials.store(new PasswordCredential({ id: "Umstiegsheld", name: "Umstiegsheld – Wiederherstellungscode", password: code })); e.target.textContent = "Gespeichert ✓"; } catch { e.target.textContent = "Ging nicht – bitte kopieren"; } });
  w.querySelector("[data-no]").onclick = () => { w.remove(); render(); };
  document.body.appendChild(w);
}
function bindRecovery() { document.getElementById("recNew")?.addEventListener("click", makeRecovery); }
async function restoreAccount(raw) {
  if (raw.length !== 16) { DEV.err = "Der Wiederherstellungscode hat 16 Zeichen (z. B. ABCD-EFGH-JKMN-PQRS)."; return render(); }
  if (trips.length && !(await ask("Konto zurückholen?\n\nWas du hier schon angelegt hast, kommt dazu.", { ok: "Zurückholen" }))) return;
  DEV.busy = true; DEV.err = ""; render();
  try {
    await api("/api/recovery/restore", { method: "POST", body: { code: raw } });
    Object.assign(DEV, { join: false, input: "", busy: false, list: null }); REC.has = true; REC.asked = false;
    await syncFavs(true); await loadTrips().catch(() => {}); ROUTINES = await api("/api/routines").catch(() => ROUTINES);
    flash = "Willkommen zurück – deine Fahrten, regelmäßigen Fahrten und Favoriten sind wieder da.";
    openId = null; go("home"); checkPush();
  } catch (e) { DEV.busy = false; DEV.err = e.message; render(); }
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
      <p class="small" style="margin:0">Auf dem anderen Gerät Umstiegsheld öffnen → Einstellungen → „Code eingeben“:</p>
      <div class="code-big" aria-label="Code ${esc(DEV.code.split("").join(" "))}">${fmtCode(DEV.code)}</div>
      <p class="small muted" style="margin:0">Gilt bis ${hm(DEV.until)} Uhr. Nur an deine eigenen Geräte weitergeben. Nach dem Verbinden gilt ein vorhandener Wiederherstellungscode nicht mehr – dann bitte einen neuen erstellen.</p>
      <div class="row" style="margin-top:8px"><button class="btn sec small-btn" id="devShare">Als Link schicken</button><button class="btn quiet small-btn" id="devCodeX">Fertig</button></div></div>` : "";
  const joinBox = DEV.join ? `<div class="link-code">
      <label class="small" for="devIn">Code vom anderen Gerät (6 Ziffern) oder dein Wiederherstellungscode</label>
      <input id="devIn" class="code-in" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="24" placeholder="123 456  oder  ABCD-…" value="${esc(DEV.input)}">
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
    const url = `${location.origin}/?link=${DEV.code}`, text = `Umstiegsheld verbinden – Code ${fmtCode(DEV.code)} (gilt bis ${hm(DEV.until)} Uhr)`;
    try { if (navigator.share) await navigator.share({ title: "Umstiegsheld", text, url }); else { await navigator.clipboard.writeText(`${text}\n${url}`); alert("Link kopiert."); } } catch {}
  });
  $("devJoinOpen")?.addEventListener("click", () => { DEV.join = true; DEV.err = ""; render(); setTimeout(() => $("devIn")?.focus(), 50); });
  $("devJoinX")?.addEventListener("click", () => { DEV.join = false; DEV.input = ""; DEV.err = ""; render(); });
  $("devIn")?.addEventListener("input", e => { DEV.input = e.target.value; });
  $("devIn")?.addEventListener("keydown", e => { if (e.key === "Enter") $("devJoin")?.click(); });
  $("devJoin")?.addEventListener("click", () => joinDevice(DEV.input));
  $app.querySelectorAll("[data-devdel]").forEach(b => b.onclick = async () => {
    const d = (DEV.list || []).find(x => x.id === b.dataset.devdel);
    if (!(await ask(`${d?.label || "Gerät"} trennen?\n\nDas Gerät sieht deine Fahrten dann nicht mehr und bekommt keine Mitteilungen mehr.`, { ok: "Trennen", danger: true }))) return;
    await api(`/api/devices/${b.dataset.devdel}`, { method: "DELETE" }).catch(e => alert(e.message));
    DEV.list = null; render();
  });
  $("devLeave")?.addEventListener("click", async () => {
    if (!(await ask("Dieses Gerät trennen?\n\nDeine Fahrten bleiben auf den anderen Geräten. Hier fängst du danach leer an.", { ok: "Trennen", danger: true }))) return;
    const me = (DEV.list || []).find(d => d.me);
    await api(`/api/devices/${me.id}`, { method: "DELETE" }).catch(() => {});
    try { ["rb_auth", "rb_favs", "rb_favs_up", "rb_push"].forEach(k => localStorage.removeItem(k)); } catch {}
    location.replace("/");
  });
}
async function joinDevice(raw) {
  const rec = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/[A-Z]/.test(rec) || rec.length > 6) return restoreAccount(rec);
  const code = String(raw || "").replace(/\D/g, "");
  if (code.length !== 6) { DEV.err = "Der Code vom anderen Gerät hat 6 Ziffern, der Wiederherstellungscode 16 Zeichen."; return render(); }
  if (!(await ask(`Dieses Gerät verbinden?\n\n${trips.length ? "Deine Fahrten und Favoriten von hier kommen dazu – danach" : "Danach"} siehst du auf beiden Geräten dasselbe.\n\nWichtig: Ein vorhandener Wiederherstellungscode gilt danach nicht mehr. Erstelle anschließend unter „Konto sichern“ einen neuen.`, { ok: "Verbinden" }))) return;
  DEV.busy = true; DEV.err = ""; render();
  try {
    const jr = await api("/api/link/join", { method: "POST", body: { code } });
    Object.assign(DEV, { join: false, input: "", busy: false, list: null });
    await syncFavs(true); await loadTrips().catch(() => {});
    REC.has = false; REC.lost = !!jr.recReset; REC.asked = true; try { localStorage.removeItem("rb_later_rec"); } catch {}
    flash = `Verbunden. Du siehst jetzt deine Fahrten und Favoriten von allen Geräten.${jr.recReset ? " Bisherige Wiederherstellungscodes gelten nicht mehr – bitte unter Einstellungen → „Konto sichern“ einen neuen erstellen." : ""}`;
    openId = null; go("home");
  } catch (e) { DEV.busy = false; DEV.err = e.message; render(); }
}
// Favoriten mit dem Konto abgleichen (beim Start; nach dem Verbinden gilt die Liste vom Server)
async function syncFavs(serverWins = false) {
  try {
    const srv = await api("/api/favs");
    // nur beim allerersten Abgleich dieses Geräts die alte, lokal gespeicherte Liste hochladen – danach gilt immer der Server
    let first = false; try { first = !localStorage.getItem("rb_favs_up"); localStorage.setItem("rb_favs_up", "1"); } catch {}
    if (first && !serverWins && !srv.length && FAVS.length) { await api("/api/favs", { method: "PUT", body: FAVS }); return false; }
    const ch = JSON.stringify(srv) !== JSON.stringify(FAVS);
    FAVS = srv; try { localStorage.setItem("rb_favs", JSON.stringify(FAVS)); } catch {}
    return ch;
  } catch {}
}

// Installieren als App (Android/Chrome/Edge): das Angebot des Browsers merken und später dezent anbieten
let INSTALL = null;
addEventListener("beforeinstallprompt", e => { e.preventDefault(); INSTALL = e; if (view === "home" && !openId) render(); });
addEventListener("appinstalled", () => { INSTALL = null; try { localStorage.setItem("rb_installed", "1"); } catch {} render(); });
const later = k => { try { return Date.now() < +(localStorage.getItem(`rb_later_${k}`) || 0); } catch { return false; } };
// Auf der Startseite höchstens EIN Hinweis: erst Mitteilungen, danach „Als App installieren“ – jeweils mit „Später“
// Welcher Browser, was geht dort? (Installieren als App, Mitteilungen) – mit passender Anleitung
const UA = navigator.userAgent, isAndroid = /Android/i.test(UA);
const BRANDS = (navigator.userAgentData?.brands || []).map(b => b.brand).join(" ");
const BROWSER = /DuckDuckGo/i.test(UA + BRANDS) ? "DuckDuckGo" : /SamsungBrowser/i.test(UA) ? "Samsung Internet" : /EdgA?\//.test(UA) ? "Edge" : /OPR\/|Opera/i.test(UA) ? "Opera"
  : /Firefox|FxiOS/i.test(UA) ? "Firefox" : navigator.brave ? "Brave" : /CriOS/.test(UA) ? "Chrome" : /Chrome\//.test(UA) ? "Chrome" : /Safari/.test(UA) ? "Safari" : "Browser";
const pushPossible = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const BNAME = () => (BROWSER === "Chrome" && !pushPossible() ? "diesem Browser" : BROWSER);   // z. B. DuckDuckGo gibt sich als Chrome aus
// Andere Browser zum Öffnen (Android): Firefox, Samsung Internet, Edge, Chrome – wer kein Chrome will, hat Auswahl
const OPENERS = [["Firefox", "org.mozilla.firefox"], ["Samsung Internet", "com.sec.android.app.sbrowser"], ["Edge", "com.microsoft.emmx"], ["Chrome", "com.android.chrome"]];
const openIn = pkg => `intent://${location.host}/#Intent;scheme=https;package=${pkg};S.browser_fallback_url=${encodeURIComponent(`https://play.google.com/store/apps/details?id=${pkg}`)};end`;
const openerBtns = cls => (isAndroid ? OPENERS.filter(([n]) => n !== BNAME()).map(([n, pkg]) => `<a class="${cls}" href="${openIn(pkg)}" style="text-decoration:none">${n}</a>`).join("") : "");
// iPhone: Mitteilungen nur in der installierten App; sonst geht es, wenn der Browser Push kann
const pushHere = () => (isIOS ? standalone && pushPossible() : pushPossible() && !(BROWSER === "DuckDuckGo" && !standalone));
const pushState = () => (!pushHere() ? "none" : Notification.permission === "granted" && localStorage.getItem("rb_push") === "1" ? "on" : Notification.permission === "denied" ? "blocked" : "off");
// ohne Push und ohne echte App-Installation (z. B. DuckDuckGo auf Android): lieber in Chrome öffnen
const weakBrowser = () => !isIOS && !standalone && (!pushPossible() || BROWSER === "DuckDuckGo");
function installHow() {
  if (isIOS) return `${BROWSER === "Safari" ? "Unten" : "Im Browser"} auf „Teilen“ <span aria-hidden="true">⬆︎</span> tippen → „Zum Home-Bildschirm“ → „Hinzufügen“. Danach Umstiegsheld über das neue Symbol öffnen.`;
  if (BROWSER === "Samsung Internet") return "Unten auf das Menü ☰ tippen → „Seite hinzufügen zu“ → „Startbildschirm“ (oder das ⬇︎-Symbol in der Adresszeile). Danach über das neue Symbol öffnen.";
  if (BROWSER === "Firefox") return "Oben rechts auf ⋮ tippen → „Installieren“ bzw. „Zum Startbildschirm hinzufügen“. Danach über das neue Symbol öffnen.";
  if (isAndroid) return "Oben rechts auf ⋮ tippen → „App installieren“ bzw. „Zum Startbildschirm hinzufügen“. Danach über das neue Symbol öffnen.";
  return "In der Adresszeile rechts auf das Symbol „App installieren“ (Monitor mit Pfeil) klicken – oder im Menü ⋮ → „Umstiegsheld installieren“.";
}
function unblockHow() {
  if (isIOS) return "iPhone-Einstellungen → „Mitteilungen“ → „Umstiegsheld“ → „Mitteilungen erlauben“ einschalten.";
  if (standalone && isAndroid) return "Lange auf das Umstiegsheld-Symbol drücken → „App-Info“ (ⓘ) → „Benachrichtigungen“ → einschalten.";
  if (BROWSER === "Samsung Internet") return "Menü ☰ → „Einstellungen“ → „Websites und Downloads“ bzw. „Berechtigungen“ → „Benachrichtigungen“ → umstiegsheld.de erlauben.";
  if (BROWSER === "Firefox") return "Auf das Schloss links in der Adresszeile tippen → „Berechtigungen“ → „Benachrichtigungen“ → erlauben.";
  return "Auf das Schloss bzw. Regler-Symbol links in der Adresszeile tippen → „Berechtigungen“ bzw. „Website-Einstellungen“ → „Benachrichtigungen“ → „Zulassen“. Danach die Seite neu laden.";
}
// Hinweise zu Mitteilungen erst, wenn es etwas zu überwachen gibt (Fahrt, regelmäßige Fahrt, übernommener Link)
const hasSomething = () => trips.length > 0 || ROUTINES.length > 0;
const recHint = () => `<section class="card hint-card"><div class="k">${REC.lost ? "Neuen Code erstellen" : "Fahrten absichern"}</div>
  <p>${REC.lost ? "Weil Geräte verbunden wurden, gilt dein bisheriger Wiederherstellungscode nicht mehr. Erstelle bitte einen neuen." : "Löschst du die Browserdaten oder geht das Handy verloren, wären deine Fahrten weg. Ein Wiederherstellungscode holt alles zurück."}</p>
  <button class="btn small-btn" id="recHint" style="width:auto;margin:10px 0 0">Code erstellen</button><div class="hint-foot"><button class="link small" data-later-hint="rec">Nicht jetzt</button></div></section>`;
// Andere Browser als ordentliches Raster (Android: öffnet Umstiegsheld direkt dort)
const browserGrid = () => (isAndroid ? `<div class="br-grid">${openerBtns("btn sec small-btn")}</div>` : `<p class="small" style="margin:6px 0 0">Zum Beispiel in Firefox, Edge oder Chrome.</p>`);
function hintCard() {
  if (!hasSomething()) return "";
  const recOr = () => { loadRec(); return REC.has === false && (REC.lost || !later("rec")) ? recHint() : ""; };   // danach: Konto sichern
  if (pushState() === "on") return recOr();
  const foot = k => `<div class="hint-foot"><button class="link small" data-later-hint="${k}">Nicht jetzt</button></div>`;
  // Browser ohne Mitteilungen (z. B. DuckDuckGo): klar sagen, was geht, und andere Browser anbieten
  if (weakBrowser()) return later("weak") ? recOr() : `<section class="card hint-card"><div class="k">Mitteilungen</div>
    <p><b>${esc(BNAME() === "diesem Browser" ? "Dieser Browser" : BNAME())} kann keine Mitteilungen anzeigen.</b> Warnungen siehst du hier, sobald du Umstiegsheld öffnest.</p>
    <p class="small muted" style="margin:8px 0 6px">Für Mitteilungen aufs Handy Umstiegsheld in einem dieser Browser öffnen:</p>${browserGrid()}${foot("weak")}</section>`;
  // im Browser: zuerst als App installieren (danach dort die Mitteilungen)
  if (!standalone && !later("install") && (INSTALL || isIOS || isAndroid)) return `<section class="card hint-card"><div class="k">Als App installieren</div>
    <p>Dann liegt Umstiegsheld auf dem Startbildschirm${isIOS ? " – und nur so bekommst du auf dem iPhone Mitteilungen" : ""}. Danach dort die Mitteilungen einschalten.</p>
    ${INSTALL ? `<button class="btn small-btn" id="installApp">Installieren</button>` : `<p class="small muted" style="margin:6px 0 0">${installHow()}</p>`}${foot("install")}</section>`;
  const push = pushCard();
  return push && !later("push") ? push.replace(/<\/div>$/, `${foot("push")}</div>`) : recOr();
}
// iPhone in Safari, noch nichts angelegt: zuerst installieren – sonst landen die Fahrten in Safari statt in der App
const iosFirst = () => (isIOS && !standalone && !later("iosfirst") ? `<div class="banner info hint row" style="align-items:center"><span><b>Tipp fürs iPhone:</b> Erst auf den Home-Bildschirm legen – Safari „Teilen“ <span aria-hidden="true">⬆︎</span> → „Zum Home-Bildschirm“ – und Umstiegsheld von dort öffnen.
  Nur dann bekommst du Mitteilungen, und deine Fahrten liegen gleich in der App.</span><button class="link small hint-later" data-later-hint="iosfirst">Nicht jetzt</button></div>` : "");
function bindHints() {
  document.getElementById("recHint")?.addEventListener("click", makeRecovery);
  $app.querySelectorAll("[data-later-hint]").forEach(b => b.onclick = () => { try { localStorage.setItem(`rb_later_${b.dataset.laterHint}`, String(Date.now() + 3 * 864e5)); } catch {} render(); });
  document.getElementById("installApp")?.addEventListener("click", async () => { const e = INSTALL; if (!e) return; INSTALL = null;
    e.prompt(); const r = await e.userChoice.catch(() => null); if (r?.outcome !== "accepted") { try { localStorage.setItem("rb_later_install", String(Date.now() + 7 * 864e5)); } catch {} } render(); });
}

function pushCard() {
  const ps = pushState();
  if (ps === "on" || (ps === "none" && !isIOS)) return "";
  const perm = "Notification" in window ? Notification.permission : "default";
  if (isIOS && !standalone) return `<div class="banner info hint small row" style="align-items:center"><span><b>Für Mitteilungen unterwegs:</b> In Safari „Teilen“ → „Zum Home-Bildschirm“, dann Umstiegsheld von dort öffnen.
    Die App startet leer – deine Fahrten nimmst du so mit: hier unter Einstellungen „Gerät hinzufügen“, in der App „Code eingeben“.</span><button class="btn sec small-btn" data-go="settings" style="flex:0 0 auto;width:auto;margin:0">Code anzeigen</button></div>`;
  if (perm === "denied") return `<div class="banner info small"><b>Mitteilungen sind blockiert.</b> So erlaubst du sie: ${unblockHow()}</div>`;
  return `<div class="banner info push-ask row" style="align-items:center"><span style="flex:3"><b>Bescheid bekommen,</b> wenn dein Bus oder Zug ausfällt oder sich verspätet?</span><button class="btn small-btn" id="pushOn" style="flex:0 0 auto;width:auto;margin:0">Einschalten</button></div>`;
}

let R_SCROLL = null;
function bindCommon() {
  $app.querySelector("[data-reload]")?.addEventListener("click", () => location.reload());
  // angekündigte regelmäßige Fahrt antippen: Serie aufgeklappt mit Erklärung
  $app.querySelectorAll("[data-ropenr]").forEach(b => b.onclick = () => { R_OPEN = R_SCROLL = b.dataset.ropenr; go("routines"); });
  $app.querySelectorAll("[data-regstart]").forEach(b => b.onclick = () => { startWizard(); W.regIntent = true; W.step = "regsetup";
    W.reg = { name: "", days: [1, 2, 3, 4, 5], kind: "fix", at: "07:30", from: "07:00", to: "08:00", hol: true }; go("add"); });
  $app.querySelectorAll("[data-pick]").forEach(b => b.onclick = async () => { b.disabled = true;
    await api(`/api/trips/${b.dataset.pick}/pick`, { method: "POST" }).catch(e => alert(e.message));
    flash = "Alles klar – ich überwache diese Fahrt und melde mich, wenn etwas nicht klappt."; await loadTrips().catch(() => {}); render(); scrollTo(0, 0); });
  $app.querySelectorAll("[data-unpick]").forEach(b => b.onclick = async () => { b.disabled = true;
    await api(`/api/trips/${b.dataset.unpick}/pick`, { method: "DELETE" }).catch(e => alert(e.message)); await loadTrips().catch(() => {}); render(); });
  $app.querySelectorAll("[data-winprev]").forEach(b => b.onclick = async () => { b.disabled = true;
    await api(`/api/trips/${b.dataset.winprev}/pick`, { method: "POST", body: { prev: true } }).catch(e => alert(e.message)); flash = "Alles klar – ich überwache wieder die Fahrt, in der du sitzt."; await loadTrips().catch(() => {}); render(); });
  $app.querySelectorAll("[data-linkjoin]").forEach(b => b.onclick = () => { DEV.join = true; DEV.err = ""; go("settings"); setTimeout(() => { document.getElementById("devices")?.scrollIntoView({ block: "center" }); document.getElementById("devIn")?.focus(); }, 80); });
  $app.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    const tt = trips.find(x => x.id === b.dataset.del), r = tt?.routine && ROUTINES.find(x => x.id === tt.routine);
    if (r) {   // regelmäßige Fahrt: nur diese oder die ganze Serie?
      const a = await ask(`Was möchtest du löschen?\n\n„${r.name}“ ist eine regelmäßige Fahrt. „Nur diese Fahrt“ setzt diesen Tag aus, danach geht es normal weiter.`, { ok: "Nur diese Fahrt", alt: "Alle Fahrten", danger: false });
      if (!a) return;
      if (a === "alt") { if (!(await ask(`„${r.name}“ ganz löschen?\n\nEs werden keine neuen Fahrten mehr angelegt.`, { ok: "Alle löschen", danger: true }))) return;
        await api(`/api/routines/${r.id}`, { method: "DELETE", body: { endTrips: true } }).catch(e => alert(e.message)); ROUTINES = await api("/api/routines").catch(() => ROUTINES);
        flash = `„${r.name}“ gelöscht.`; openId = null; sheetId = null; await loadTrips().catch(() => {}); render(); scrollTo(0, 0); return; }
    } else if (tt?.follow === true) { if (!(await ask("Nicht mehr mitverfolgen?\n\nDu bekommst zu dieser Fahrt keine Mitteilungen mehr. Die reisende Person merkt davon nichts.", { ok: "Nicht mehr mitverfolgen", danger: true }))) return; }
    else if ("end" in b.dataset) { if (!(await ask("Fahrt beenden?\n\nIch überwache sie dann nicht mehr. Wie du weiterkommst, klärst du selbst.", { ok: "Beenden" }))) return; }
    else if (!(await ask("Fahrt löschen?\n\nSie wird nicht mehr überwacht und verschwindet aus der Liste.", { ok: "Löschen", danger: true }))) return;
    let okDel = true; await api(`/api/trips/${b.dataset.del}`, { method: "DELETE" }).catch(e => { okDel = false; alert(e.message); });
    if (okDel) flash = tt?.follow === true ? "Du verfolgst die Fahrt nicht mehr mit." : "end" in b.dataset ? "Fahrt beendet." : "Fahrt gelöscht.";
    openId = null; sheetId = null; await loadTrips().catch(() => {}); render(); scrollTo(0, 0);
  });
  $app.querySelectorAll("[data-adopt]").forEach(b => b.onclick = async () => {
    const [id, k, idx, src] = b.dataset.adopt.split("|"), t = trips.find(x => x.id === id);
    if (src === "win") {   // Zeitfenster: einfach wählen, ohne Rückfrage
      b.disabled = true; b.textContent = "Wird übernommen …";
      await api(`/api/trips/${id}/adopt`, { method: "POST", body: { win: true, idx: +idx } }).catch(e => alert(e.message));
      flash = "Alles klar – ich überwache diese Fahrt und melde mich, wenn etwas nicht klappt."; await loadTrips().catch(() => {}); render(); scrollTo(0, 0); return;
    }
    const zbWarn = t && t.ticket === "spar" && !t.zbLifted && b.dataset.zb ? "\n\nAchtung Sparpreis: Das ist ein anderer Fernzug. Er gilt erst, wenn die Zugbindung aufgehoben ist – sonst kann ein neues Ticket fällig werden." : "";
    if (!(await ask(`Diese Verbindung nehmen?\n\n${b.dataset.adoptText}${zbWarn}\n\nEs wird nichts gebucht. Ich überwache dann diese Verbindung – du kannst jederzeit zurück zum alten Plan.`, { ok: "Nehmen" }))) return;
    b.disabled = true; b.textContent = "Wird umgestellt …";
    const ok = await api(`/api/trips/${id}/adopt`, { method: "POST", body: { k: +k, idx: +idx, here: src === "here", sos: src === "sos" } }).then(() => true).catch(e => { alert(e.message); return false; });
    // gewählt: aufgeklappte Möglichkeiten schließen und oben die neue Verbindung zeigen
    if (ok) { openCmp = null; flash = "Alles klar – ich überwache jetzt diese Verbindung."; if (src === "here") trips = trips.map(x => (x.id === id ? { ...x, here: null } : x)); }
    await loadTrips().catch(() => {}); render(); if (ok) scrollTo(0, 0);
  });
  $app.querySelectorAll("[data-missed]").forEach(b => b.onclick = async () => {
    const [id, i] = b.dataset.missed.split("|");
    if (!b.closest(".seg-info") && !(await ask("Nicht eingestiegen?\n\nIch suche dir sofort die nächsten Verbindungen ab deiner Einstiegs-Haltestelle.", { ok: "Neu suchen" }))) return;
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
  $app.querySelectorAll("[data-optx]").forEach(b => b.onclick = () => { OPT_OPEN = null; render(); });
  $app.querySelectorAll("[data-pbclose]").forEach(b => b.onclick = async () => {   // ein ✕ schließt alles: Plan B, Suche ab Zug, eigene Suche
    const id = b.dataset.pbclose, x = trips.find(y => y.id === id); OPT_OPEN = null;
    trips = trips.map(y => (y.id === id ? { ...y, sos: null, here: null } : y)); render();
    if (x?.sos) api(`/api/trips/${id}/sos`, { method: "DELETE" }).catch(() => {});
    if (x?.here) api(`/api/trips/${id}/here`, { method: "DELETE" }).catch(() => {});
  });
  $app.querySelectorAll("[data-sosx]").forEach(b => b.onclick = async () => {
    const id = b.dataset.sosx; OPT_OPEN = null;
    trips = trips.map(x => (x.id === id ? { ...x, sos: null } : x)); render();
    await api(`/api/trips/${id}/sos`, { method: "DELETE" }).catch(() => {});
  });
  $app.querySelectorAll("[data-hide]").forEach(b => b.onclick = async () => {
    const id = b.dataset.hide; OPT_OPEN = null;
    trips = trips.map(x => (x.id === id ? { ...x, here: null } : x)); render();
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
// ---------- Fahrt ändern als Bausteine: jede Teilstrecke einzeln früher oder später, auch andere Linien ----------
// Geladen wird erst beim ersten Tippen auf ‹ oder › (Abfahrts- und Ankunftstafel), danach wird nur noch geblättert.
let BLK = null;
let REGIONAL = false; try { REGIONAL = localStorage.getItem("rb_regional") === "1"; } catch {}   // „Nur Nahverkehr“ (gemerkt)
// Verlassen: gewählte Änderungen nicht stillschweigend verwerfen
async function blkLeave() {
  if (!BLK) return true;
  if (Object.values(BLK.sel).some(v => v != null) && !(await ask("Änderungen verwerfen?\n\nDeine Auswahl wird nicht übernommen.", { ok: "Verwerfen", cancel: "Weiter ändern" }))) return false;
  BLK = null; return true;
}
function openBlocks(t) { BLK = { id: t.id, sel: {}, lists: {}, err: {}, note: {}, loading: null }; scrollTo(0, 0); render(); }
const lk = s => String(s || "").replace(/^(Bus|Tram|STR|Fähre)\s+/i, "").replace(/\s/g, "").toUpperCase();
function bCur(t, i) {
  const L = BLK.lists[i], k = BLK.sel[i], l = t.legs[i];
  if (L && k != null && L[k]) { const o = L[k]; return { label: o.label, mode: o.mode, dep: o.from.plan, arr: o.to.plan, from: o.from.name, to: o.to.name, walk: o.walk || 0, opt: o, changed: true }; }
  return { label: nice(l), mode: l.mode, dep: l.dep.plan, arr: l.arr.plan, from: l.dep.name, to: l.arr.name, walk: t.transfers?.[i]?.walk ?? l.walk ?? 0, changed: false };   // Fußweg wie in der Fahrtansicht
}
const isOrig = (t, i, o) => lk(o.label) === lk(t.legs[i].label) && Math.abs(Date.parse(o.from.plan) - Date.parse(t.legs[i].dep.plan)) < 90e3;
async function bStep(t, i, dir) {
  if (!BLK.lists[i]) {
    BLK.loading = i; BLK.err[i] = ""; render();
    try { BLK.lists[i] = ((await api(`/api/trips/${t.id}/segment`, { method: "POST", body: { i } })).list || []).sort((a, b) => Date.parse(a.from.plan) - Date.parse(b.from.plan)); }
    catch (e) { BLK.err[i] = e.message; }
    if (!BLK) return; BLK.loading = null;
    if (!BLK.lists[i]) return render();
  }
  const L = BLK.lists[i], d = Date.parse(bCur(t, i).dep);
  let p = BLK.sel[i] != null ? BLK.sel[i] : L.findIndex(o => isOrig(t, i, o)), j;
  if (p >= 0) j = p + dir;
  else j = dir > 0 ? L.findIndex(o => Date.parse(o.from.plan) >= d) : L.map(o => Date.parse(o.from.plan) <= d).lastIndexOf(true);
  BLK.note[i] = "";
  if ((j < 0 || j >= L.length) && !BLK.more?.[`${i}${dir}`]) {   // am Rand: eine weitere Seite holen (einmal je Richtung und Stück)
    BLK.more = { ...(BLK.more || {}), [`${i}${dir}`]: true };
    const edge = dir > 0 ? Math.max(...L.map(o => Date.parse(o.from.plan)), d) + MIN : Math.min(...L.map(o => Date.parse(o.from.plan)), d) - 45 * MIN;
    const keep = BLK.sel[i] != null ? L[BLK.sel[i]] : null;
    BLK.loading = i; render();
    try { const add = (await api(`/api/trips/${t.id}/segment`, { method: "POST", body: { i, at: edge } })).list || [];
      const k = o => `${o.label}@${o.from.plan}`, seen = new Set(L.map(k));
      const fresh = add.filter(o => !seen.has(k(o)) && (dir > 0 ? Date.parse(o.from.plan) > d : Date.parse(o.from.plan) < d));
      BLK.lists[i] = [...L, ...fresh].sort((a, b) => Date.parse(a.from.plan) - Date.parse(b.from.plan));
      if (keep) BLK.sel[i] = BLK.lists[i].findIndex(o => k(o) === k(keep));
      BLK.more[`${i}${dir}`] = fresh.length === 0;   // nichts Neues in dieser Richtung: nicht noch einmal fragen
    } catch (e) { BLK.err[i] = e.message; }
    if (!BLK) return; BLK.loading = null;
    return bStep(t, i, dir);
  }
  if (j < 0 || j >= L.length) BLK.note[i] = dir > 0 ? "Später finde ich hier gerade keine Fahrt." : "Früher finde ich hier keine Fahrt mehr.";
  else BLK.sel[i] = isOrig(t, i, L[j]) ? null : j;
  render();
}
function bGap(t, i) {
  // Gleiche Maßstäbe wie die Überwachung: Umstiegszeit gesamt gegen deine eigene Umstiegszeit bzw. die übliche Zeit an diesem Bahnhof (+2 Min.)
  const a = bCur(t, i), b = bCur(t, i + 1), tot = Math.round((Date.parse(b.dep) - Date.parse(a.arr)) / MIN), walk = a.walk || 0, g = tot - walk;
  const own = +t.minT || 0, need = t.transfers?.[i]?.need ?? walk + 3;
  const tight = own ? tot < own : tot < need + 2;
  return { g, tot, walk, own, need, cls: g < 0 ? "bad" : tight ? "warn" : "ok", a, b };
}
function renderBlocks(t) {
  const n = t.legs.length, now = Date.now();
  const rows = t.legs.map((l, i) => {
    const c = bCur(t, i), past = Date.parse(l.dep.plan) < now - MIN && !c.changed, busy = BLK.loading === i;
    const dm = Math.round((Date.parse(c.dep) - Date.parse(l.dep.plan)) / MIN);
    const delta = !c.changed ? "wie bisher" : dm === 0 ? "andere Fahrt, gleiche Zeit" : `${Math.abs(dm)} Min. ${dm < 0 ? "früher" : "später"} als bisher`;
    const other = c.changed && cleanStop(c.to) !== cleanStop(l.arr.name) ? ` · aussteigen: ${esc(cleanStop(c.to))}` : "";
    const fv = c.changed && t.ticket === "spar" && isFVc({ label: c.label, mode: c.mode }) ? `<span class="blk-w">Sparpreis gilt nur im gebuchten Zug</span>` : "";
    const msg = BLK.err[i] ? `<span class="blk-w">${esc(BLK.err[i])}</span>` : BLK.note[i] ? `<span class="blk-n">${esc(BLK.note[i])}</span>` : "";
    const arrow = (dir, sym, lab) => past ? `<span class="blk-a"></span>` : `<button class="blk-a" data-bstep="${i}" data-dir="${dir}" aria-label="${lab}"${busy ? " disabled" : ""}>${busy ? `<span class="spinner sm"></span>` : sym}</button>`;
    const block = `<div class="blk-b${c.changed ? " ch" : ""}${past ? " past" : ""}">${arrow(-1, "‹", "früher")}<div class="blk-m"><b>${esc(c.label)} · ${hm(c.dep)}</b><span>${esc(cleanStop(c.from))} → ${esc(cleanStop(c.to))} · an ${hm(c.arr)}</span><span class="blk-d">${past ? "schon gefahren" : delta}${other}</span>${fv}${msg}</div>${arrow(1, "›", "später")}</div>`;
    if (i === n - 1) return block;
    const G = bGap(t, i);
    // gleiche Form wie in der Fahrtansicht: Umstiegszeit gesamt, davon Fußweg, übrig bleibt der Puffer
    const head = `Umstieg ${G.tot} Min.${G.walk ? `, davon ${G.walk} zu Fuß` : ""}`;
    const txt = G.g < 0 ? `${head} – verpasst ${esc(G.b.label)} (${-G.g} Min. zu spät)`
      : G.cls === "warn" ? `${head} – ${G.own ? `weniger als deine Umstiegszeit (${G.own} Min.)` : "knapp"}`
      : head;
    return `${block}<div class="blk-g ${G.cls}"><i aria-hidden="true"></i>${txt}</div>`;
  }).join("");
  const changed = Object.keys(BLK.sel).filter(i => BLK.sel[i] != null);
  const first = bCur(t, 0), last = bCur(t, n - 1), da = Math.round((Date.parse(last.arr) - Date.parse(t.legs[n - 1].arr.plan)) / MIN);
  const miss = t.legs.slice(0, -1).map((_, i) => bGap(t, i)).find(G => G.g < 0);
  const sum = !changed.length ? "" : miss ? `<div class="blk-s bad"><b>So geht es nicht</b><span>Du verpasst den ${esc(miss.b.label)}. Nimm für das rot markierte Stück eine frühere Fahrt – oder verschiebe auch den ${esc(miss.b.label)} mit ›.</span></div>`
    : `<div class="blk-s"><b>Neu: ab ${hm(first.dep)} → an ${hm(last.arr)}</b><span>${da === 0 ? "Ankunft unverändert" : `Ankunft ${Math.abs(da)} Min. ${da < 0 ? "früher" : "später"}`}</span></div>`;
  $app.innerHTML = `${flashBox()}<section class="blk">
    <div class="blk-h"><div><div class="k">Fahrt ändern</div><h2>${esc(cleanStop(t.legs[0].dep.name))} → ${esc(cleanStop(t.legs[n - 1].arr.name))}</h2></div><button class="card-x" data-blkx aria-label="Ändern schließen">✕</button></div>
    <p class="small muted">Oder tippe ‹ oder ›, um ein Stück früher oder später zu nehmen – auch mit einer anderen Linie. Der Rest bleibt, wie er ist.</p>
    <div class="blk-l">${rows}</div>
    ${sum}
    <button class="btn" data-bsave${changed.length && !miss ? "" : ` aria-disabled="true"`}>${!changed.length ? "Noch nichts geändert" : miss ? "Anschluss verpasst – so nicht möglich" : "So übernehmen"}</button>
    <div class="mini-row center"><button class="btn sec mini" data-bstart>📍 Ich starte woanders</button><button class="btn sec mini" data-bfull>Ganz neu suchen</button></div>
  </section>`;
  $app.querySelector("[data-blkx]").onclick = async () => { if (await blkLeave()) render(); };
  $app.querySelector("[data-bstart]").onclick = async e => { e.currentTarget.disabled = true; BLK = null; await startEdit(t, "start"); };
  $app.querySelectorAll("[data-bstep]").forEach(b => b.onclick = () => bStep(t, +b.dataset.bstep, +b.dataset.dir));
  $app.querySelector("[data-bfull]").onclick = async e => { e.currentTarget.disabled = true; BLK = null; await startEdit(t); };
  $app.querySelector("[data-bsave]").onclick = async e => {
    const btn = e.currentTarget;   // vor dem ersten await merken (danach ist currentTarget leer)
    const ch = Object.keys(BLK.sel).filter(i => BLK.sel[i] != null).map(Number);
    if (!ch.length) return;
    if (t.legs.slice(0, -1).some((_, i) => bGap(t, i).g < 0)) return alert("Mit dieser Wahl erreichst du einen Anschluss nicht.\n\nWähl bitte für das rot markierte Stück eine andere Fahrt.");
    const tight = t.legs.slice(0, -1).map((_, i) => bGap(t, i)).filter(G => G.cls === "warn");
    if (tight.length && !(await ask(`Knapper Umstieg\n\n${tight.map(G => `Zum ${G.b.label} hast du nur ${G.tot} Min.${G.walk ? `, davon ${G.walk} zu Fuß` : ""}${G.own ? ` – deine Umstiegszeit ist ${G.own} Min.` : ""}`).join("\n")}\n\nTrotzdem so übernehmen?`, { ok: "Trotzdem übernehmen", cancel: "Andere Fahrt wählen" }))) return;
    const fv = ch.map(i => bCur(t, i)).filter(c => t.ticket === "spar" && isFVc({ label: c.label, mode: c.mode }));
    if (fv.length && !(await ask(`Achtung Sparpreis\n\nDein Ticket gilt nur für die gebuchten Züge. ${fv.map(c => c.label).join(", ")} geht nur, wenn die Zugbindung aufgehoben ist – sonst brauchst du dafür ein anderes Ticket.`, { ok: "Trotzdem ändern" }))) return;
    const b = btn; b.disabled = true; b.textContent = "Wird geändert …";
    try {
      await api(`/api/trips/${t.id}`, { method: "PUT", body: { replace: Object.fromEntries(ch.map(i => [i, BLK.lists[i][BLK.sel[i]]])), ticket: t.ticket } });
      SHARE_AFTER = t.id;
      flash = t.routine ? "Nur heute geändert – deine regelmäßige Fahrt bleibt, wie sie ist. Ich überwache jetzt die neue Verbindung." : "Fahrt geändert. Ich überwache jetzt die neue Verbindung.";
      BLK = null; await loadTrips().catch(() => {}); render(); scrollTo(0, 0);
    } catch (err) { alert(err.message); b.disabled = false; b.textContent = "So übernehmen"; }
  };
}
async function startEdit(t, mode) {
  const first = t.legs[0].dep, last = t.legs[t.legs.length - 1].arr;
  const st = async s => s.eva ? { eva: s.eva, name: s.name } : s.lat != null ? { eva: "", name: s.name, lat: s.lat, lon: s.lon, stop: true } : (await api(`/api/stations?q=${encodeURIComponent(cleanStop(s.name))}`).catch(() => []))[0] || null;
  const [rFrom, rTo] = await Promise.all([st(first), st(last)]);
  // Meist will man nur ein, zwei Busse früher fahren: gleich die Verbindungen ab ca. 40 Min. vor der bisherigen Abfahrt zeigen
  const ok = rFrom && rTo;
  W = { step: ok ? "conns" : "route", mode: "route", legs: [], station: null, from: Date.now(), list: null, rFrom, rTo, when: Math.max(Date.now(), Date.parse(first.plan) - 40 * MIN), conns: null,
    editId: t.id, editTicket: t.ticket, minT: t.minT || 0, ref: { dep: first.plan, arr: last.plan, trains: t.legs.map(lineKey).join(">"), legs: t.legs.map(l => ({ label: nice(l), lk: lineKey(l), dep: l.dep.plan, arr: l.arr.plan, to: l.arr.name, pl: l.dep.platform || "", apl: l.arr.platform || "", mode: l.mode, at: { eva: l.dep.eva || "", name: l.dep.name, lat: l.dep.lat, lon: l.dep.lon }, arrAt: { eva: l.arr.eva || "", name: l.arr.name, lat: l.arr.lat, lon: l.arr.lon } })) },
    keepSet: (() => { const k = t.legs.findIndex(l => l.must); return k >= 0 && Date.parse(t.legs[k].dep.plan) > Date.now() ? [k] : []; })() };
  // „Ich starte woanders“: gleich zur Eingabe von Start/Ziel, Ziel bleibt; kurzfristig (in den nächsten 3 Std.) ab jetzt
  if (mode === "start") { W.step = "route"; W.rFrom = null; W.keepSet = []; W.startNew = true;
    W.when = Date.parse(first.plan) - Date.now() < 3 * 3600e3 ? Date.now() : Date.parse(first.plan); }
  go("add");
}
function startWizard() { W = { step: "route", mode: "route", legs: [], station: null, from: Date.now(), list: null, rFrom: null, rTo: null, when: Date.now(), conns: null }; }
const dur = m => (m >= 60 ? `${Math.floor(m / 60)} Std.${m % 60 ? ` ${m % 60} Min.` : ""}` : `${m} Min.`);
// ---------- Datum & Uhrzeit: Schnellwahl + Monatskalender + Uhrzeit ----------
// key: Feld in W ("when" für Von–Nach, "from" für die Abfahrtstafel). W.cal = offener Kalender, W.calM = angezeigter Monat.
const PIN = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true" style="vertical-align:-2px;margin-right:4px"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>`;
const CAL_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" style="vertical-align:-3px;margin-right:8px"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`;
const startOfDay = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const sameDay = (a, b) => startOfDay(a) === startOfDay(b);
const hhmm = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
function whenPicker(key) {
  const v = W[key], now = Date.now();
  const tn = W.timeNote ? `<p class="small warn-t" style="margin:4px 2px 0">${esc(W.timeNote)}</p>` : "";
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
</span></div>${tn}${cal}`;
}
function bindWhen(key, changed) {
  const set = ms => { W[key] = ms; changed(); render(); };
  $app.querySelectorAll("[data-q]").forEach(b => b.onclick = () => { W.cal = null; W.timeNote = ""; set(Date.now() + +b.dataset.q * MIN); });
  $app.querySelectorAll("[data-tmode]").forEach(b => b.onclick = () => { W.byArr = b.dataset.tmode === "arr"; W.conns = null; render(); });
  const reg = document.getElementById("onlyReg"); if (reg) reg.onchange = () => { REGIONAL = reg.checked; try { localStorage.setItem("rb_regional", REGIONAL ? "1" : "0"); } catch {} W.conns = null; };
  $app.querySelector("[data-cal]")?.addEventListener("click", () => { W.cal = W.cal === key ? null : key; W.calM = startOfDay(W[key]); render(); });
  const own = sel => [...$app.querySelectorAll(sel)].filter(b => !b.closest(".fav-days"));   // Kalender der Favoriten hat eigene Knöpfe
  own("[data-calm]").forEach(b => b.onclick = () => { const d = new Date(W.calM); d.setDate(1); d.setMonth(d.getMonth() + +b.dataset.calm); W.calM = d.getTime(); render(); });
  own("[data-day]").forEach(b => b.onclick = () => {
    const d = new Date(+b.dataset.day), t = new Date(W[key]); d.setHours(t.getHours(), t.getMinutes());
    W.cal = null; set(Math.max(d.getTime(), Date.now()));
  });
  const hs = document.getElementById("whenH"), ms = document.getElementById("whenM");
  // Uhrzeit heute schon vorbei (z. B. 07:15 um 22:30)? Dann ist morgen gemeint – und das sage ich dazu
  const onT = () => { const d = new Date(W[key]); d.setHours(+hs.value, +ms.value, 0, 0);
    if (d.getTime() < Date.now() - 5 * MIN && sameDay(d.getTime(), Date.now())) { d.setDate(d.getDate() + 1); W.timeNote = `${hhmm(d.getTime())} ist heute schon vorbei – ich nehme morgen.`; } else W.timeNote = "";
    set(d.getTime()); };
  if (hs) { hs.onchange = onT; ms.onchange = onT; }
}
const localInput = ms => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60e3); return d.toISOString().slice(0, 16); };

const placeParam = s => (s.eva ? s.eva : `@${(+s.lat).toFixed(5)},${(+s.lon).toFixed(5)}`);
function stationField(id, label, val) {
  return val
    ? `<p class="small muted" style="margin:14px 0 4px">${label}</p><div class="row" style="align-items:center"><b style="flex:4">${esc(val.name)}${val.myPlace ? ` <span class="small muted" style="font-weight:400">${esc(val.area)}</span>` : val.here ? ` <span class="small muted" style="font-weight:400">genau hier</span>` : val.stop ? ` <span class="small muted" style="font-weight:400">Haltestelle${val.area ? ` · ${esc(val.area)}` : ""}</span>` : ""}</b><button class="chip" data-clear="${id}" style="flex:0 0 auto">ändern</button></div>`
    : `<p class="small muted" style="margin:14px 0 4px">${label}</p><input type="search" id="${id}" placeholder="Bahnhof oder Haltestelle" autocomplete="off" enterkeyhint="search" value="${esc(W?.typed?.[id] || "")}">
      ${id === "rf" || (PLACES.length && !W?.quick) ? `<div class="rchips" style="margin-top:6px">${id === "rf" ? `<button class="chip here-chip" data-near="${id}">${PIN} Mein Standort</button>` : ""}${(W?.quick ? [] : PLACES).map((pl, i) => `<button class="rchip pl" data-plf="${id}|${i}">${esc(pl.icon)} ${esc(pl.name)}</button>`).join("")}</div>` : ""}<ul class="list" id="${id}Res"></ul>`;
}

// ---------- Meine Orte: Zuhause, Arbeit, Arzt … (am Konto gespeichert, wie Favoriten) ----------
let PLACES = []; try { PLACES = JSON.parse(localStorage.getItem("rb_places") || "[]"); } catch {}
const PL_PRESETS = [["🏠", "Zuhause"], ["💼", "Arbeit"], ["🩺", "Arzt"], ["🏃", "Sport"], ["🛒", "Einkaufen"], ["👪", "Familie"], ["🎓", "Schule/Uni"]];
async function savePlaces(list) {
  PLACES = list; try { localStorage.setItem("rb_places", JSON.stringify(PLACES)); } catch {}
  try { PLACES = await api("/api/places", { method: "PUT", body: list }); localStorage.setItem("rb_places", JSON.stringify(PLACES)); } catch (e) { alert(`Konnte nicht gespeichert werden: ${e.message}`); }
}
// als Start/Ziel: Anzeige mit Symbol, darunter die Adresse
const placeObj = pl => ({ ...pl.place, name: `${pl.icon} ${pl.name}`, area: pl.place.name + (pl.place.area ? `, ${pl.place.area}` : ""), myPlace: true });
const placeChips = attr => PLACES.map((pl, i) => `<button class="rchip pl" ${attr}="${i}">${esc(pl.icon)} ${esc(pl.name)}</button>`).join("");
function startPlace(i = null) {
  const pl = i != null ? PLACES[i] : null;
  W.plBack = W.step; W.pl = pl ? { ...pl, place: { ...pl.place } } : { id: `p${Date.now().toString(36)}`, icon: "🏠", name: PLACES.some(x => x.name === "Zuhause") ? "" : "Zuhause", place: null };
  W.plIdx = i; W.step = "place"; render(); scrollTo(0, 0);
}
// ---------- Favoriten: häufige Verbindungen (auf diesem Gerät gespeichert, ohne Anmeldung) ----------
let FAVS = []; try { FAVS = JSON.parse(localStorage.getItem("rb_favs") || "[]"); } catch {}
let FAV_OPEN = false; try { FAV_OPEN = localStorage.getItem("rb_favs_open") === "1"; } catch {}   // eingeklappt, bis man sie öffnet (wird gemerkt)
// Änderung immer auf den aktuellen Stand vom Server anwenden – sonst schreibt ein Gerät mit alter Liste gelöschte Favoriten zurück
let favQ = Promise.resolve();
const changeFavs = fn => { FAVS = fn(FAVS); try { localStorage.setItem("rb_favs", JSON.stringify(FAVS)); } catch {}
  favQ = favQ.then(async () => {
    let srv = null; try { srv = await api("/api/favs"); } catch { return; }
    FAVS = fn(srv); try { localStorage.setItem("rb_favs", JSON.stringify(FAVS)); } catch {}
    await api("/api/favs", { method: "PUT", body: FAVS }).catch(() => {});
  }); return favQ; };
const berlinHM = iso => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const placeOfStop = s => (s.eva ? { eva: s.eva, name: s.name, lat: s.lat, lon: s.lon } : { eva: "", name: s.name, lat: s.lat, lon: s.lon, stop: true });
const favKey = (from, to, time) => `${from.eva || `${(+from.lat).toFixed(3)},${(+from.lon).toFixed(3)}`}>${to.eva || `${(+to.lat).toFixed(3)},${(+to.lon).toFixed(3)}`}@${time}`;
function favOfTrip(t) {
  const a = t.legs[0].dep, b = t.legs[t.legs.length - 1].arr, time = berlinHM(a.plan);
  return { id: favKey(a, b, time), from: placeOfStop(a), to: placeOfStop(b), time, trains: t.legs.map(l => nice(l)) };
}
const isFav = t => { const f = favOfTrip(t); return FAVS.some(x => x.id === f.id); };
function toggleFav(t) { const f = favOfTrip(t), on = isFav(t); changeFavs(L => (on ? L.filter(x => x.id !== f.id) : [f, ...L.filter(x => x.id !== f.id)].slice(0, 12))); }
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

// Reise ändern mit festen Zügen: ein zusammenhängender Block bleibt, davor und/oder danach wird neu gesucht
const keepInfo = () => {
  if (!W?.editId || !W.keepSet?.length) return null;
  const L = W.ref.legs, a = W.keepSet[0], b = W.keepSet[W.keepSet.length - 1], m = Math.max(2, +W.minT || 0) * MIN;
  if (!L[a] || !L[b]) return null;
  return { a, b, pre: a > 0, post: b < L.length - 1, first: L[a], last: L[b], latest: Date.parse(L[a].dep) - m, earliest: Date.parse(L[b].arr) + m,
    k: a, label: L[a].label, dep: L[a].dep, at: L[a].at };   // k/label/dep/at: der erste feste Zug
};
// Welcher Teil wird gerade gesucht? „pre“ = bis zum ersten festen Zug, „post“ = ab dem letzten festen Zug
const keepPhase = () => { const K = keepInfo(); if (!K) return null; return K.pre && !W.preDone ? "pre" : K.post ? "post" : "none"; };
// feste Züge als Teilstrecken zum Anzeigen (werden beim Speichern vom Server aus der bisherigen Reise genommen)
const keptLegs = K => W.ref.legs.slice(K.a, K.b + 1).map(x => ({ kept: true, jid: "", label: x.label, mode: x.mode, from: { name: x.at.name, plan: x.dep, platform: x.pl }, to: { name: x.to, plan: x.arr, platform: x.apl || "" } }));
function keepTail() { return ""; }
function toggleKeep(i) {
  const n = W.ref.legs.length, cur = W.keepSet || [];
  let a = cur.length ? cur[0] : i, b = cur.length ? cur[cur.length - 1] : i;
  if (!cur.length) { a = b = i; }
  else if (i < a) a = i; else if (i > b) b = i;              // erweitern: alles dazwischen bleibt mit
  else if (i === a && i === b) { W.keepSet = []; return; }    // einziger fester Zug: wieder frei
  else if (i === a) a++; else if (i === b) b--;              // am Rand abwählen
  else b = i - 1;                                            // in der Mitte abwählen: ab hier wieder frei
  W.keepSet = []; for (let k = a; k <= b && k < n; k++) W.keepSet.push(k);
}
function keepPicker() {
  if (!W.editId || !(W.ref.legs?.length > 1)) return W.editId ? `<p class="small muted" style="margin:0 2px 8px">Tippe eine frühere oder spätere Verbindung an. Ticket bleibt.</p>` : "";
  const K = keepInfo(), set = W.keepSet || [];
  // Start geändert: nur Teile ab dem neuen Start anbieten (liegt er nicht auf der Strecke, gibt es nichts zu behalten)
  const s0 = W.rFrom && !sameStation(W.rFrom.name || "", W.ref.legs[0].at.name) ? W.ref.legs.findIndex(x => sameStation(x.at.name, W.rFrom.name || "")) : 0;
  if (s0 < 0) return `<p class="small muted" style="margin:0 2px 8px">Neuer Start – ich suche die ganze Fahrt ab dort neu.</p>`;
  const opts = W.ref.legs.map((x, i) => (i >= s0 && Date.parse(x.dep) > Date.now() ? `<button class="kp-c" data-keep="${i}" aria-pressed="${set.includes(i)}">${esc(x.label)} ${hm(x.dep)}</button>` : "")).join("");
  const where = x => esc(cleanStop(x.at.name)), whereTo = x => esc(cleanStop(x.to || ""));
  const txt = !K ? "Ich suche die ganze Fahrt neu. Tippe Züge an, die bleiben sollen."
    : !K.pre && !K.post ? "Alle Züge bleiben – nichts neu zu suchen."
    : K.pre && K.post ? `Neu: bis ${where(K.first)} und ab ${whereTo(K.last)}.`
    : K.pre ? `Neu: bis zum ${esc(K.first.label)} in ${where(K.first)}, danach wie bisher.`
    : `Bis ${whereTo(K.last)} wie bisher, danach neu.`;
  const mt = `<div class="kp-row"><span class="kp-l">Umstiegszeit</span><div class="kp-sc">${MINT_OPTS.map(([m, l]) => `<button class="kp-c" data-emt="${m}" aria-pressed="${(+W.minT || 0) === m}">${m ? `${m} Min.` : "wie geplant"}</button>`).join("")}</div></div>`;
  return `<div class="keep-card kp"><div class="kp-row"><span class="kp-l">Welche Teile willst du behalten?</span><div class="kp-sc"><button class="kp-c" data-keep="" aria-pressed="${!K}">Alles neu</button>${opts}</div></div>
    ${mt}<p class="kp-t">${txt}</p></div>`;
}
// gleiche Fahrt wie die bisherige Reise? (gleiche Linien, gleiche Abfahrt)
const lineKey = l => String(l.label || "").replace(/^(Bus|Tram|STR|Fähre)\s+/i, "").replace(/\s/g, "").toUpperCase();
const isRef = (c, R) => { const K = keepInfo(), ph = keepPhase();
  const part = !K ? R.legs : ph === "post" ? R.legs.slice(K.b + 1) : R.legs.slice(0, K.a);
  if (!part.length) return false;
  return c.legs.map(lineKey).join(">") === part.map(x => x.lk).join(">") && Math.abs(Date.parse(c.legs[0].from.plan) - Date.parse(part[0].dep)) <= MIN; };
// Ampel für den Umstieg: nur hier gibt es Farbe (rot = geht nicht/zu knapp, orange = knapp, grün = entspannt)
const gapTag = (g, own, at, sit) => { const ownM = Math.max(+own || 0, 2), where = at ? ` in ${esc(cleanStop(at))}` : "";
  if (sit) return `<span class="ok-t">${where ? `In ${esc(cleanStop(at))}` : "Hier"} im selben Zug sitzen bleiben</span>`;
  if (g < 0) return `<span class="late">Umstieg${where} geht nicht</span>`;
  if (g < ownM) return `<span class="late">Umstieg${where} ${g} Min. – zu knapp${own > g ? ` (du brauchst ${own})` : ""}</span>`;
  if (g < Math.max(ownM + 5, 8)) return `<span class="warn-t">Umstieg${where} ${g} Min. – knapp</span>`;
  return `<span class="ok-t">Umstieg${where} ${dur(g)} – entspannt</span>`; };
// „Einmal oder öfter?“ als kleine Auswahl unter der Verbindung (Standard: nur diesmal)
function repInfo() {
  const dep = Date.parse(W.legs[0].from.plan), dow = ((new Date(new Date(dep).toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" }) + "T12:00:00Z").getUTCDay() + 6) % 7) + 1, wk = dow <= 5;
  return { dep, depHm: hm(dep), dow, days: wk ? [1, 2, 3, 4, 5] : [dow], quick: wk ? "Mo–Fr" : DOW[dow - 1] };
}
function repeatBlock() {
  if (!canRegular() || W.regPreset || W.regIntent || W.multi) return "";
  const r = repInfo(), q = W.reg && W.reg.kind === "fix" && !W.reg.custom;
  return `<p class="small" style="margin:12px 2px 4px"><b>Öfter so fahren?</b></p><div class="chips">
    <button class="chip" data-rep="once" aria-pressed="${!W.reg}">Nur diesmal</button>
    <button class="chip" data-rep="quick" aria-pressed="${!!q}">Jeden ${r.quick} um ${r.depHm}</button>
    <button class="chip" data-rep="more" aria-pressed="${!!(W.reg && !q)}">${W.reg && !q ? `${esc(daysText(W.reg.days))}${W.reg.kind === "win" ? ` ${W.reg.from}–${W.reg.to}` : ""} ✎` : "Andere Tage …"}</button></div>
    ${W.reg ? `<p class="small muted" style="margin:4px 2px 0">Ich lege die Fahrt dann an jedem dieser Tage automatisch an und überwache sie. Jederzeit unter „Regelmäßige Fahrten“ abschaltbar.</p>` : ""}`;
}
// Mitteilungen gleich beim Anlegen mit erlauben (nur wo das ohne Umweg geht)
function pushTick() {
  if (W.editId || !("Notification" in window) || !("serviceWorker" in navigator) || (isIOS && !standalone)) return "";
  if (Notification.permission !== "default") return "";
  return `<label class="small chk" style="margin:12px 2px 0"><input type="checkbox" id="pushTick" ${W.pushNo ? "" : "checked"}> <span>Mir aufs Handy Bescheid geben, wenn etwas nicht klappt</span></label>`;
}
function connList(list) {
  if (!list.length) return `<p class="muted">Keine Verbindung gefunden.</p><button class="btn sec" id="otherTime">Andere Zeit wählen</button>`;
  const own = W?.editId ? W.minT : MINT, R = W?.editId && W.ref, K = keepInfo(), ph = keepPhase();
  const same = (a, b) => String(a || "").replace(/\s/g, "").toUpperCase() === String(b || "").replace(/\s/g, "").toUpperCase();
  return `<ul class="list">${list.map((c, i) => {
    // Überall Fahrplanzeiten (wie bei „Passt das so?“ und in der Fahrt) – Verspätungen stehen extra darunter
    const L = c.legs, first = L[0], lastL = L[L.length - 1], dep = first.from.plan;
    const late = Math.round((Date.parse(first.from.rt || c.dep || first.from.plan) - Date.parse(first.from.plan)) / MIN), arrLate = Math.round((Date.parse(lastL.to.rt || lastL.to.plan) - Date.parse(lastL.to.plan)) / MIN);
    const mine = sameTrains(c, W?.fav), cur = R && isRef(c, R);
    const gaps = L.slice(1).map((l, k) => ({ at: L[k].to.name, g: Math.round((Date.parse(l.from.plan) - Date.parse(L[k].to.plan)) / MIN), sit: same(l.label, L[k].label) }));
    if (K && ph === "pre") gaps.push({ at: K.first.at.name, g: Math.round((Date.parse(K.first.dep) - Date.parse(lastL.to.plan)) / MIN), sit: same(lastL.label, K.first.label) });
    if (K && ph === "post") gaps.push({ at: K.last.to, g: Math.round((Date.parse(first.from.plan) - Date.parse(K.last.arr)) / MIN), sit: same(first.label, K.last.label) });
    const real = gaps.filter(x => !x.sit), tight = real.sort((a, b) => a.g - b.g)[0], sitG = gaps.find(x => x.sit);
    // ganze Fahrt zeigen – mit den festen Zügen (wie bisher) und dem schon gewählten Teil
    const keptL = K ? R.legs.slice(K.a, K.b + 1).map(x => esc(x.label)) : [];
    const before = ph === "post" ? (W.preLegs ? W.preLegs.map(l => esc(l.label)) : R.legs.slice(0, K.a).map(x => esc(x.label))) : [];
    let labels = ph === "pre" ? [...L.map(l => esc(l.label)), ...keptL, ...(K.post ? ["…"] : [])] : ph === "post" ? [...before, ...keptL, ...L.map(l => esc(l.label))] : L.map(l => esc(l.label));
    labels = labels.filter((x, k) => k === 0 || !same(x, labels[k - 1]));   // im selben Zug sitzen bleiben: nur einmal nennen
    const nT = labels.filter(x => x !== "…").length - 1;
    const tripDep = ph === "post" ? (W.preLegs ? W.preLegs[0].from.plan : R.legs[0].dep) : dep;
    const arr = ph === "pre" ? (K.post ? K.last.arr : R.arr) : lastL.to.plan;
    const mins = Math.round((Date.parse(arr) - Date.parse(tripDep)) / MIN);
    const vs = R && !cur ? (() => { const dd = Math.round((Date.parse(tripDep) - Date.parse(R.dep)) / MIN), da = Math.round((Date.parse(arr) - Date.parse(ph === "pre" && K.post ? K.last.arr : R.arr)) / MIN);
      const moved = W.rFrom && R.legs?.[0] && !sameStation(W.rFrom.name || "", R.legs[0].at.name);   // anderer Start: Abfahrt nicht vergleichbar
      return [moved ? "" : Math.abs(dd) < 1 ? "gleiche Abfahrt" : dd < 0 ? `${fmtSpan(-dd)} früher los` : `${fmtSpan(dd)} später los`, Math.abs(da) < 2 ? "gleich am Ziel" : da < 0 ? `${fmtSpan(-da)} früher am Ziel` : `${fmtSpan(da)} später am Ziel`].filter(Boolean).join(" · "); })() : "";
    const nextDay = !sameDay(Date.parse(arr), Date.parse(tripDep)) ? ` <span class="small muted">(${new Date(arr).toLocaleDateString("de-DE", { weekday: "short", timeZone: "Europe/Berlin" })})</span>` : "";
    const liveLine = late >= 2 || arrLate >= 2 ? `Aktuell: ${late >= 2 ? `ab ${hm(first.from.rt || c.dep)} (+${late})` : ""}${late >= 2 && arrLate >= 2 ? " · " : ""}${arrLate >= 2 ? `an ${hm(lastL.to.rt)} (+${arrLate})` : ""}` : "";
    return `<li><button data-c="${i}" class="${mine || cur ? "fav-hit" : ""}">${cur ? `<span class="small fav-tag">● Deine bisherige Fahrt</span>` : mine ? `<span class="small fav-tag">★ Deine übliche Verbindung</span>` : ""}<div class="train" style="grid-template-columns:1fr auto">
      <span class="t">${hm(tripDep)} → ${hm(arr)}${nextDay}${ph === "pre" && K.post ? ` <span class="small muted">in ${esc(cleanStop(K.last.to || ""))}</span>` : ""}</span>
      <span class="pl">${dur(mins)}</span>
      <span class="d" style="grid-column:1/3">${nT ? `${nT} Umstieg${nT > 1 ? "e" : ""} · ` : "direkt · "}${labels.join(" → ")}${L.some(l => l.cancelled) ? ` <span class="late">fällt aus</span>` : ""}</span>
      ${sitG && !tight ? `<span class="small" style="grid-column:1/3">${gapTag(0, own, sitG.at, true)}</span>` : tight ? `<span class="small" style="grid-column:1/3">${gapTag(tight.g, own, tight.at)}${real.length > 1 ? ` <span class="muted">(knappster)</span>` : ""}</span>` : ""}
      ${vs ? `<span class="small muted" style="grid-column:1/3">${vs}</span>` : ""}
      ${liveLine ? `<span class="small late" style="grid-column:1/3">${liveLine}</span>` : ""}
    </div></button></li>`; }).join("")}</ul>`;
}

function renderWizard() {
  if (!W) startWizard();
  const n = W.legs.length, head = `<p class="steps">${W.editId ? "Fahrt ändern" : W.regIntent ? "Neue regelmäßige Fahrt" : n ? `Teilstrecke ${n + 1}` : "Neue Fahrt"}</p>`;
  const back = `<button id="wBack" hidden aria-hidden="true"></button>`;   // Zurück steht oben in der Kopfleiste
  if (W.busy) { $app.innerHTML = `<p class="steps">${W.editId ? "Fahrt ändern" : W.regIntent ? "Neue regelmäßige Fahrt" : "Neue Fahrt"}</p><h1>${esc(W.busy)}</h1><div class="spinner"></div>`; return; }
  const err = W.error ? `<p class="err">${esc(W.error)}</p>` : "";

  if (W.step === "regsetup") {
    // Neue regelmäßige Fahrt: zuerst Titel, Tage und Zeit – dann die Haltestellen
    const R = W.reg;
    $app.innerHTML = `<p class="steps">${W.replaceR ? "Regelmäßige Fahrt ändern" : "Neue regelmäßige Fahrt"}</p>
      ${W.replaceR ? `<p class="small muted" style="margin:0 0 8px">Ändere, was du möchtest – beim Speichern ersetzt das die bisherige Fassung (gilt für alle künftigen Fahrten).</p>` : ""}
      <label class="k" for="rsName">Titel</label>
      <input class="txt" id="rsName" maxlength="40" placeholder="z. B. Schule oder Arbeit" value="${esc(R.name)}">
      <p class="k" style="margin:14px 0 4px">An welchen Tagen?</p>${dayChips(R.days, "data-rsd")}
      <p class="k" style="margin:14px 0 4px">Wann?</p>
      <div class="seg seg2"><button data-rsk="fix" aria-pressed="${R.kind === "fix"}"><b>Feste Abfahrt</b><span>immer dieselbe Verbindung</span></button>
        <button data-rsk="win" aria-pressed="${R.kind === "win"}"><b>Zeitfenster</b><span>alle Fahrten von–bis</span></button></div>
      ${R.kind === "win" ? `<div class="win-row"><input type="time" id="rsFrom" value="${esc(R.from)}"><span>bis</span><input type="time" id="rsTo" value="${esc(R.to)}"></div>`
        : `<div class="win-row"><span>ab ca.</span><input type="time" id="rsAt" value="${esc(R.at)}"></div>`}
      <label class="small chk"><input type="checkbox" id="rsHol" ${R.hol ? "checked" : ""}> An Feiertagen (Berlin) nicht fahren</label>
      ${err}<button class="btn big-btn" id="rsNext">Weiter: Haltestellen wählen</button>${back}`;
    const keep = () => { R.name = document.getElementById("rsName").value; R.at = document.getElementById("rsAt")?.value || R.at;
      R.from = document.getElementById("rsFrom")?.value || R.from; R.to = document.getElementById("rsTo")?.value || R.to; R.hol = document.getElementById("rsHol").checked; };
    $app.querySelectorAll("[data-rsd]").forEach(b => b.onclick = () => { keep(); const d = +b.dataset.rsd; R.days = R.days.includes(d) ? R.days.filter(x => x !== d) : [...R.days, d].sort(); render(); });
    $app.querySelectorAll("[data-rsk]").forEach(b => b.onclick = () => { keep(); R.kind = b.dataset.rsk; render(); });
    document.getElementById("rsNext").onclick = () => { keep();
      if (!R.days.length) { W.error = "Bitte mindestens einen Tag wählen."; return render(); }
      if (R.kind === "win" && !(R.to > R.from)) { W.error = "Das Ende des Zeitfensters muss nach dem Beginn liegen."; return render(); }
      // Suche am nächsten Fahrtag zur gewählten Zeit (ein paar Minuten vorher, damit die Verbindung sicher dabei ist)
      const hhmm = R.kind === "win" ? R.from : R.at, [h, m] = hhmm.split(":").map(Number);
      for (let i = 0; i < 8; i++) { const d = new Date(); d.setDate(d.getDate() + i); d.setHours(h, m, 0, 0); const dow = ((d.getDay() + 6) % 7) + 1;
        if (R.days.includes(dow) && d.getTime() > Date.now() + 5 * MIN) { W.when = d.getTime() - 10 * MIN; break; } }
      W.regPreset = true; W.error = ""; W.step = "route"; render(); };
  }

  else if (W.step === "place") {
    const P = W.pl, edit = W.plIdx != null;
    $app.innerHTML = `<p class="steps">Meine Orte</p><h1>${edit ? "Ort bearbeiten" : "Ort speichern"}</h1>
      <p class="small muted" style="margin:0 0 4px">Name</p>
      <div class="rchips">${PL_PRESETS.map(([ic, nm]) => `<button class="rchip" data-plp="${ic}|${nm}" aria-pressed="${P.name === nm}">${ic} ${nm}</button>`).join("")}</div>
      <div class="row" style="margin-top:8px;align-items:center"><input class="txt" id="plIcon" maxlength="4" value="${esc(P.icon)}" style="flex:0 0 3.2em;text-align:center" aria-label="Symbol"><input class="txt" id="plName" maxlength="30" placeholder="eigener Name, z. B. Oma" value="${esc(P.name)}" style="flex:1"></div>
      <p class="small muted" style="margin:16px 0 4px">Wo?</p>
      ${P.place ? `<div class="row" style="align-items:center"><b style="flex:4">${esc(P.place.name)}${P.place.area ? ` <span class="small muted" style="font-weight:400">${esc(P.place.area)}</span>` : ""}</b><button class="chip" data-plclear style="flex:0 0 auto">ändern</button></div>`
        : `<input type="search" id="plq" placeholder="Adresse, Haltestelle oder Ort" autocomplete="off" value="${esc(W.plq || "")}">
      <div class="rchips" style="margin-top:6px"><button class="chip here-chip" data-plhere>${PIN} Hier, wo ich gerade bin</button></div><ul class="list" id="plRes"></ul>`}
      <p class="small muted" style="margin:14px 0 0">Deine Orte werden wie die Favoriten mit deinem Konto gespeichert, damit sie auf all deinen verbundenen Geräten da sind. Löschen kannst du sie jederzeit.</p>
      ${err}<button class="btn big-btn" id="plSave">${edit ? "Speichern" : "Ort speichern"}</button>
      ${edit ? `<button class="btn danger" id="plDel">Ort löschen</button>` : ""}${back}`;
    const keep = () => { P.icon = document.getElementById("plIcon").value.trim() || "📍"; P.name = document.getElementById("plName").value.trim(); };
    $app.querySelectorAll("[data-plp]").forEach(b => b.onclick = () => { keep(); [P.icon, P.name] = b.dataset.plp.split("|"); render(); });
    $app.querySelector("[data-plclear]")?.addEventListener("click", () => { keep(); P.place = null; render(); });
    const q = document.getElementById("plq");
    if (q) { let tm; const find = async () => { const ul = document.getElementById("plRes"); if (!ul) return; if (q.value.trim().length < 3) { ul.innerHTML = ""; return; }
        try { const res = await api(`/api/places/search?q=${encodeURIComponent(q.value)}`);
          ul.innerHTML = res.length ? res.map((x, i) => `<li><button data-plr="${i}"><b>${esc(x.name)}</b><br><span class="small muted">${x.stop ? "Haltestelle" : "Adresse/Ort"}${x.area ? ` · ${esc(x.area)}` : ""}</span></button></li>`).join("") : `<li class="muted small">Nichts gefunden – mit Hausnummer und Ort versuchen.</li>`;
          ul.querySelectorAll("[data-plr]").forEach(b => b.onclick = () => { keep(); P.place = res[+b.dataset.plr]; W.plq = ""; render(); });
        } catch (e) { ul.innerHTML = `<li class="err">${esc(e.message)}</li>`; } };
      q.oninput = () => { W.plq = q.value; clearTimeout(tm); tm = setTimeout(find, 300); }; if (q.value.trim().length >= 3) find(); }
    $app.querySelector("[data-plhere]")?.addEventListener("click", () => { keep();
      if (!navigator.geolocation) return alert("Dein Gerät gibt keinen Standort heraus.");
      navigator.geolocation.getCurrentPosition(pos => { P.place = { eva: "", name: "Gespeicherter Standort", area: `vom ${day(new Date().toISOString())}`, lat: +pos.coords.latitude.toFixed(5), lon: +pos.coords.longitude.toFixed(5) }; render(); },
        err => alert(err.code === 1 ? "Ohne Erlaubnis für den Standort geht das nicht." : "Standort gerade nicht verfügbar."), { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }); });
    document.getElementById("plSave").onclick = async () => { keep();
      if (!P.name) { W.error = "Bitte einen Namen wählen."; return render(); }
      if (!P.place) { W.error = "Bitte eine Adresse, Haltestelle oder „Hier“ wählen."; return render(); }
      if (PLACES.some((x, i) => i !== W.plIdx && x.name.toLowerCase() === P.name.toLowerCase())) { W.error = `„${P.name}“ gibt es schon.`; return render(); }
      const list = edit ? PLACES.map((x, i) => (i === W.plIdx ? P : x)) : [...PLACES, P];
      W.error = ""; await savePlaces(list); W.step = W.plBack || "route"; W.pl = null; W.plEdit = false; render(); };
    document.getElementById("plDel")?.addEventListener("click", async () => {
      if (!(await ask(`„${P.name}“ löschen?`, { ok: "Löschen", danger: true }))) return;
      await savePlaces(PLACES.filter((_, i) => i !== W.plIdx)); W.step = W.plBack || "route"; W.pl = null; render(); });
  }

  else if (W.step === "route") {
    // Schnell weg: Ziele, die du schon kennst, zum Antippen
    const dests = []; if (W.quick) for (const d of [...trips.filter(t => t.active !== false).map(t => t.legs[t.legs.length - 1].arr), ...FAVS.map(f => f.to)])
      if (d && (d.eva || d.lat != null) && !dests.some(x => plainStop(x.name) === plainStop(d.name)) && dests.length < 6) dests.push({ eva: d.eva || "", name: d.name, lat: d.lat, lon: d.lon });
    $app.innerHTML = `<p class="steps">${W.editId ? "Fahrt ändern" : W.quick ? "Schnell weg von hier" : W.regIntent ? "Neue regelmäßige Fahrt" : "Neue Fahrt"}</p>
      ${W.quick ? `<h1>Wohin?</h1>
        <div class="pl-head"><span class="small muted">Meine Orte</span>${PLACES.length ? `<button class="link small" data-pledit>${W.plEdit ? "Fertig" : "Bearbeiten"}</button>` : ""}</div>
        <div class="rchips">${PLACES.map((pl, i) => `<button class="rchip pl" ${W.plEdit ? "data-plmod" : "data-pl"}="${i}">${esc(pl.icon)} ${esc(pl.name)}${W.plEdit ? " ✎" : ""}</button>`).join("")}<button class="rchip add" data-pladd>＋ ${PLACES.length ? "Ort" : "Zuhause, Arbeit … speichern"}</button></div>
        ${dests.length ? `<p class="small muted" style="margin:10px 0 4px">Zuletzt</p><div class="rchips">${dests.map((d, i) => `<button class="rchip" data-qd="${i}">${esc(cleanStop(d.name))}</button>`).join("")}</div>` : ""}` : ""}
      ${!W.editId && !W.quick && FAVS.length ? `<section class="card favs"><button class="fav-head" data-favtoggle aria-expanded="${FAV_OPEN}"><span class="k" style="margin:0">★ Favoriten · ${FAVS.length}</span><span class="chev">${FAV_OPEN ? "▴" : "▾"}</span></button>${!FAV_OPEN ? "" : `<ul class="fav-list">${FAVS.map((f, i) => (i >= 3 && !W.favAll && W.favOpen !== i) ? "" : `<li class="fav-row ${W.favOpen === i ? "open" : ""}"><button data-fav="${i}" aria-expanded="${W.favOpen === i}">
        <span class="fav-time">${esc(f.time)}</span><span class="fav-main"><b>${esc(cleanStop(f.from.name))} → ${esc(cleanStop(f.to.name))}</b><span class="fav-sub">${esc(f.trains.join(" → "))}</span></span></button><button class="fav-del" data-favdel="${i}" aria-label="Favorit entfernen">✕</button></li>${W.favOpen === i ? `<li class="fav-days-li">${favDays(f)}</li>` : ""}`).join("")}</ul>
        ${FAVS.length > 3 && !W.favAll ? `<button class="link small" data-favall>Alle ${FAVS.length} Favoriten zeigen</button>` : ""}`}

</section>` : ""}
      ${W.quick ? "" : W.editId ? (W.startNew ? `<h1>Von wo startest du?</h1><p class="small muted">Ziel bleibt ${esc(cleanStop(W.rTo?.name || ""))}. Ticket und Umstiegszeit bleiben.</p>` : `<h1>Neue Verbindung für deine Fahrt</h1><p class="small muted">Ändere Uhrzeit, Datum, Start oder Ziel und wähle dann die passende Verbindung. Ticket und Umstiegszeit bleiben.</p>`) : !W.impOpen ? `<h1>${W.regIntent ? "Von wo nach wo?" : "Wohin geht es?"}</h1>` : `<section class="card import">
        <h1 style="margin-top:0">Gebuchte Fahrt überwachen</h1>
        <p class="small muted" style="margin-top:0">Gib mir dein Ticket (PDF), einen Screenshot aus dem DB Navigator oder den geteilten Link/Text. Ich lese die Verbindung heraus und überwache sie für dich.</p>
        <p class="small muted" style="margin-top:-4px">Das Auslesen macht eine KI (Claude). Bitte prüf das Ergebnis kurz. <a href="/datenschutz.html#ki">Mehr dazu</a></p>
        <div class="row"><label class="btn" style="margin:4px 0">Foto, Screenshot oder PDF<input type="file" id="impFile" accept="image/*,application/pdf" multiple hidden></label>
          <button class="btn sec" id="impTextBtn" style="margin:4px 0">Link oder Text einfügen</button></div>
        ${W.showText ? `<textarea id="impText" rows="5" placeholder="Hier den geteilten Text oder die Buchungsbestätigung einfügen">${esc(W.impText || "")}</textarea>
          <div class="row"><button class="btn sec" id="impPaste" style="margin:4px 0">Aus Zwischenablage</button><button class="btn" id="impGo" style="margin:4px 0">Einlesen</button></div>` : ""}
      </section>
      <h3 class="sec-h" style="margin-top:22px">Oder selbst suchen: von wo nach wo?</h3>`}

      ${W.regIntent && W.reg ? `<div class="reg-sum"><span>↻ <b>${esc(W.reg.name || "Neue regelmäßige Fahrt")}</b> · ${esc(daysText(W.reg.days))} · ${W.reg.kind === "win" ? `${esc(W.reg.from)}–${esc(W.reg.to)}` : `ab ${esc(W.reg.at)}`}</span><button class="link" id="regEdit">ändern</button></div>` : ""}
      ${W.retNote ? `<p class="small warn-t" style="margin:6px 2px 0">${esc(W.retNote)}</p>` : ""}
      ${stationField("rf", "Von", W.rFrom)}${W.rFrom && W.rTo ? `<button class="chip swap-chip" data-swap aria-label="Start und Ziel tauschen">⇅ Tauschen (Rückfahrt)</button>` : ""}${stationField("rt", "Nach", W.rTo)}
      ${(W.regIntent && W.reg) || W.quick ? "" : `<div class="seg tmode" role="group" aria-label="Zeit gilt für" style="margin:14px 0 6px;grid-template-columns:1fr 1fr"><button data-tmode="dep" aria-pressed="${!W.byArr}"><b>Abfahrt ab</b></button><button data-tmode="arr" aria-pressed="${!!W.byArr}"><b>Ankunft bis</b></button></div>${whenPicker("when")}
      <label class="small chk" style="margin-top:8px"><input type="checkbox" id="onlyReg" ${REGIONAL ? "checked" : ""}> Nur Nahverkehr (z. B. mit Deutschlandticket – ohne ICE/IC)</label>`}
      ${W.editId || W.quick ? "" : `<p class="small muted" style="margin:14px 0 4px">Zeit, die ich mindestens zum Umsteigen brauche</p>${minTChips()}`}
      ${err}<button class="btn" id="go" ${W.rFrom && W.rTo ? "" : "disabled"}>${W.regIntent && W.reg?.kind === "win" ? "Speichern" : W.regIntent ? "Verbindung wählen" : "Verbindungen suchen"}</button>
      ${W.regIntent || W.quick ? "" : `<button class="btn quiet" id="byTrain">Direkt aus der Abfahrtstafel wählen</button>`}
      ${W.editId || W.impOpen || W.regIntent || W.quick ? "" : `<button class="btn quiet" id="impOpen">Ticket schon gebucht? Foto oder Text einfügen …</button>`}${back}`;
    document.getElementById("impOpen")?.addEventListener("click", () => { W.impOpen = true; render(); scrollTo(0, 0); });
    $app.querySelectorAll("[data-qd]").forEach(b => b.onclick = () => { W.rTo = dests[+b.dataset.qd]; W.when = Date.now(); if (W.rFrom) { W.conns = null; W.step = "conns"; } render(); });
    $app.querySelectorAll("[data-pl]").forEach(b => b.onclick = () => { W.rTo = placeObj(PLACES[+b.dataset.pl]); W.when = Date.now(); if (W.rFrom) { W.conns = null; W.step = "conns"; } render(); });
    $app.querySelectorAll("[data-plf]").forEach(b => b.onclick = () => { const [f, i] = b.dataset.plf.split("|"); W[f === "rf" ? "rFrom" : "rTo"] = placeObj(PLACES[+i]); if (W.typed) delete W.typed[f]; render(); });
    $app.querySelector("[data-pladd]")?.addEventListener("click", () => startPlace());
    $app.querySelector("[data-pledit]")?.addEventListener("click", () => { W.plEdit = !W.plEdit; render(); });
    $app.querySelectorAll("[data-plmod]").forEach(b => b.onclick = () => startPlace(+b.dataset.plmod));
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
    $app.querySelector("[data-swap]")?.addEventListener("click", () => { [W.rFrom, W.rTo] = [W.rTo, W.rFrom]; W.retNote = ""; render(); });
    bindWhen("when", () => {});
    $app.querySelectorAll("[data-mt]").forEach(b => b.onclick = () => { setMinT(+b.dataset.mt); render(); });
    document.getElementById("regEdit")?.addEventListener("click", () => { W.step = "regsetup"; render(); });
    document.getElementById("go").onclick = () => {
      if (W.regIntent && W.reg?.kind === "win") return saveWindowRoutine();   // Zeitfenster: keine einzelne Verbindung nötig
      if (W.quick) W.when = Date.now();
      W.conns = null; W.error = ""; W.fav = null; W.step = "conns"; render(); };
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
    $app.querySelectorAll("[data-favdel]").forEach(b => b.onclick = async () => { if (!(await ask("Favorit entfernen?", { ok: "Entfernen", danger: true }))) return; const id = FAVS[+b.dataset.favdel]?.id; changeFavs(L => L.filter(x => x.id !== id)); render(); });
    document.getElementById("byTrain") && (document.getElementById("byTrain").onclick = () => { W.mode = "train"; W.step = "station"; W.error = ""; render(); });
    document.getElementById("impFile")?.addEventListener("change", e => importFiles([...e.target.files]));
    document.getElementById("impTextBtn")?.addEventListener("click", () => { W.showText = !W.showText; render(); });
    const it = document.getElementById("impText"); if (it) it.oninput = () => { W.impText = it.value; };
    const ip = document.getElementById("impPaste");
    if (ip) ip.onclick = async () => { try { W.impText = await navigator.clipboard.readText(); render(); } catch { alert("Einfügen bitte per langem Tippen ins Textfeld."); } };
    const ig = document.getElementById("impGo"); if (ig) ig.onclick = () => runImport({ text: W.impText || "" });
  }

  else if (W.step === "conns") {
    const K = keepInfo(), ph = keepPhase();
    const fullDate = ms => new Date(ms).toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
    // Was wird gesucht? ganze Fahrt · bis zum ersten festen Zug · ab dem letzten festen Zug
    const sFrom = ph === "post" ? K.last.arrAt : W.rFrom, sTo = ph === "pre" ? K.first.at : W.rTo;
    const sub = !K ? `${W.byArr ? "Ankunft bis" : "Abfahrt ab"} ${fullDate(W.when)}${REGIONAL ? " · nur Nahverkehr" : ""}` : ph === "pre" ? `zum ${esc(K.first.label)} um ${hm(K.first.dep)}` : ph === "post" ? `ab ${fullDate(W.postWhen || K.earliest)}` : "";
    const stepNote = K && K.pre && K.post ? `<p class="small" style="margin:0 2px 6px"><b>${ph === "pre" ? "Teil 1 von 2" : "Teil 2 von 2"}:</b> ${ph === "pre" ? `bis ${esc(cleanStop(K.first.at.name))}` : `ab ${esc(cleanStop(K.last.to || ""))}`}</p>` : "";
    const title = ph === "none" ? `${esc(W.rFrom.name)} → ${esc(W.rTo.name)}` : `${esc(sFrom.name)} → ${esc(sTo.name)}`;
    $app.innerHTML = `${head}<h1>${title}</h1><p class="muted small">${(W.editId ? W.minT : MINT) ? `Umstiege mind. ${W.editId ? W.minT : MINT} Min. · ` : ""}${sub}</p>
      ${ph === "post" && K.pre ? "" : keepPicker()}${stepNote}
      ${ph === "none" ? "" : `${err}${W.conns && (ph === "pre" ? true : !K && W.when > Date.now() + 5 * MIN) ? `<button class="btn sec mini" id="earlierC">↑ Frühere Verbindungen</button>` : ""}
      ${W.conns && !W.editId ? `<button class="chip buf-chip sm-chip" id="bufC" aria-pressed="${!!W.buf}">${W.buf ? `✓ Mehr Puffer (mind. ${searchMin()} Min.)` : "⏱ Mehr Puffer beim Umsteigen"}</button>
        ${W.buf ? `<p class="small muted" style="margin:4px 2px 10px">Oft dieselbe Ankunft, nur früher los. Deine eingestellte Umstiegszeit für die Überwachung bleibt.</p>` : ""}` : ""}
      <div>${!W.conns ? `<div class="spinner"></div>` : ph === "pre" && !W.conns.length ? `<p class="muted">${W.depMin ? `Später erreichst du den ${esc(K.first.label)} um ${hm(K.first.dep)} nicht mehr.` : "Keine passende Verbindung gefunden."}</p>` : !W.conns.length ? `<p class="muted">Keine passende Verbindung gefunden.${REGIONAL ? " „Nur Nahverkehr“ ist an – vielleicht fährt hier nur ein Fernzug." : W.byArr ? " Probier eine spätere Ankunftszeit." : ""}</p>` : connList(W.conns)}</div>
      ${W.conns && (W.conns.length || K) ? `${ph === "pre" && (!W.conns.length || W.conns.length < 4) && W.depMin ? "" : ph === "pre" && !W.conns.length ? "" : `<button class="btn sec mini" id="laterC">↓ Spätere Verbindungen</button>`}` : ""}`}
      ${ph === "post" && K.pre ? `<button class="btn quiet" id="backPre">Zurück zu Teil 1</button>` : ""}
      ${W.conns || ph === "none" ? (W.editId ? `<button class="btn quiet" id="otherRoute">Anderer Tag, Start oder Ziel …</button>` : SPECIAL) : ""}${back}`;
    if (!W.conns && ph !== "none") api(ph === "pre" && W.depMin ? `/api/connections?from=${placeParam(sFrom)}&to=${placeParam(sTo)}&min=${searchMin()}&time=${encodeURIComponent(new Date(W.depMin).toISOString())}`
      : ph === "pre" ? `/api/connections?from=${placeParam(sFrom)}&to=${placeParam(sTo)}&min=${searchMin()}&arrive=1&time=${encodeURIComponent(new Date(W.arrBy || K.latest).toISOString())}`
      : `/api/connections?from=${placeParam(sFrom)}&to=${placeParam(sTo)}&min=${searchMin()}${!K && W.byArr ? "&arrive=1" : ""}${REGIONAL ? "&regional=1" : ""}&time=${encodeURIComponent(new Date(ph === "post" ? (W.postWhen || Date.parse(K.last.arr) - MIN) : W.when).toISOString())}`)
      .then(c => { if (ph === "pre" && W.depMin) c = c.filter(x => Date.parse(x.legs[x.legs.length - 1].to.plan) <= K.latest + MIN && Date.parse(x.legs[0].from.plan) >= W.depMin).slice(0, 4);   // spätere, die den festen Zug noch erreichen
        else if (!K && W.byArr) c = c.filter(x => Date.parse(x.legs[x.legs.length - 1].to.plan) <= W.when + MIN && Date.parse(x.legs[0].from.plan) > Date.now() - MIN).slice(-6);   // Ankunft bis: die spätesten passenden
        if (REGIONAL) c = c.filter(x => !x.legs.some(l => isFVc(l)));
        if (ph === "pre" && !W.depMin) {   // alle, die den festen Zug noch erreichen – früher UND später als bisher, die nächstgelegenen zur bisherigen Abfahrt
          const ref = Date.parse(W.ref.dep), max = W.depMax || Infinity;
          c = c.filter(x => Date.parse(x.legs[x.legs.length - 1].to.plan) <= K.latest + MIN && Date.parse(x.legs[0].from.plan) <= max && Date.parse(x.legs[0].from.plan) > Date.now())
            .sort((a, b) => Math.abs(Date.parse(a.legs[0].from.plan) - ref) - Math.abs(Date.parse(b.legs[0].from.plan) - ref)).slice(0, 6)
            .sort((a, b) => Date.parse(a.legs[0].from.plan) - Date.parse(b.legs[0].from.plan)); }
        else if (ph === "post") { const k = s => String(s || "").replace(/\s/g, "").toUpperCase(), sit = x => k(x.legs[0].label) === k(K.last.label);
          c = c.filter(x => sit(x) || Date.parse(x.legs[0].from.plan) >= K.earliest - MIN).sort((a, b) => (sit(b) - sit(a)) || (Date.parse(a.legs[0].from.plan) - Date.parse(b.legs[0].from.plan))); }   // im festen Zug sitzen bleiben zuerst, sonst erst nach Ankunft + Umstiegszeit
        W.conns = W.fav ? [...c.filter(x => sameTrains(x, W.fav)), ...c.filter(x => !sameTrains(x, W.fav))] : c; W.error = ""; }).catch(e => { W.conns = []; W.error = e.message; }).then(render);
    const ec = document.getElementById("earlierC");
    if (ec && ph === "pre") ec.onclick = () => { const a = Math.min(...W.conns.map(c => Date.parse(c.legs[c.legs.length - 1].to.plan))), d = Math.min(...W.conns.map(c => Date.parse(c.legs[0].from.plan)));
      if (Number.isFinite(d)) { W.arrBy = a - MIN; W.depMax = d - MIN; } else { W.arrBy = null; W.depMax = W.depMin ? W.depMin - MIN : null; }
      W.depMin = null; W.conns = null; render(); };
    else if (ec) ec.onclick = () => { const first = W.conns[0] ? Date.parse(W.conns[0].legs[0].from.plan) : W.when; W.when = Math.max(Date.now(), Math.min(W.when, first) - 60 * MIN); W.conns = null; render(); };
    document.getElementById("bufC")?.addEventListener("click", () => { W.buf = !W.buf; W.conns = null; render(); });
    const lc = document.getElementById("laterC");
    if (lc && ph === "pre") lc.onclick = () => { const d = Math.max(...W.conns.map(c => Date.parse(c.legs[0].from.plan))); W.depMin = (Number.isFinite(d) ? d : Date.parse(W.ref.dep)) + MIN; W.arrBy = null; W.depMax = null; W.conns = null; render(); };
    else if (lc && ph === "post") lc.onclick = () => { W.postWhen = Date.parse(W.conns[W.conns.length - 1].legs[0].from.plan) + MIN; W.conns = null; render(); };
    else if (lc) lc.onclick = () => { W.when = Date.parse(W.conns[W.conns.length - 1].legs[0].from.plan) + MIN; W.conns = null; render(); };
    $app.querySelectorAll("[data-c]").forEach(b => b.onclick = () => pickConnection(W.conns[+b.dataset.c]));
    document.getElementById("otherTime")?.addEventListener("click", () => { W.step = "route"; W.conns = null; render(); });
    const reset = () => { W.arrBy = null; W.depMax = null; W.depMin = null; W.postWhen = null; W.preDone = false; W.preLegs = null; W.postLegs = null; W.conns = null; };
    $app.querySelectorAll("[data-keep]").forEach(b => b.onclick = () => { const v = b.dataset.keep; if (v === "") W.keepSet = []; else toggleKeep(+v); reset(); render(); });
    $app.querySelectorAll("[data-emt]").forEach(b => b.onclick = () => { W.minT = +b.dataset.emt; W.conns = null; W.arrBy = null; W.depMax = null; W.depMin = null; W.postWhen = null; render(); });
    document.getElementById("backPre")?.addEventListener("click", () => { reset(); render(); });
    document.getElementById("otherRoute")?.addEventListener("click", () => { W.step = "route"; W.keepSet = []; reset(); W.when = Math.max(Date.now(), Date.parse(W.ref.dep)); render(); });
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
      ${err}${W.list && W.from > Date.now() + 5 * MIN && !W.legs.length ? `<button class="btn sec" id="earlier">↑ Frühere Fahrten</button>` : ""}
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
    $app.innerHTML = `${head}<h1>Wo steigst du aus?</h1><p class="muted">${esc(tr.label)} ab ${hm(tr.rt)}${tr.stop ? ` · ${esc(cleanStop(tr.stop.name))}` : ""}${tr.platform ? ` · ${esc(platWord(tr, tr.platform))}` : ""}</p>
      ${err}<div>${W.tripStops ? `<ul class="list">${W.tripStops.map((s, i) => `<li><button data-ts="${i}"><b>${esc(s.name)}</b> <span class="small muted">an ${hm(s.plan)}</span></button></li>`).join("") || `<li><p class="muted">Keine Halte bekannt.</p></li>`}</ul>` : `<div class="spinner"></div>`}</div>${back}`;
    if (!W.tripStops) api(`/api/tripstops?trip=${encodeURIComponent(tr.tripId)}&after=${encodeURIComponent(tr.plan)}`)
      .then(l => { W.tripStops = l; }).catch(e => { W.tripStops = []; W.error = e.message; }).then(render);
    $app.querySelectorAll("[data-ts]").forEach(b => b.onclick = () => {
      const s = W.tripStops[+b.dataset.ts], st = W.station;
      W.legs.push({ jid: "", tid: tr.tripId, label: tr.label, mode: tr.mode || "",
        from: tr.stop ? { eva: "", name: tr.stop.name, plan: tr.plan, platform: tr.platform || "", lat: tr.stop.lat, lon: tr.stop.lon, stopId: tr.stopId || tr.stop.id }
          : { eva: st.eva || "", name: st.name, plan: tr.plan, platform: tr.platform || "", lat: st.lat, lon: st.lon, stopId: tr.stopId || st.id || "" },
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
      .filter(x => (MINT > 0 ? x.gap < MINT : x.gap < 5)).sort((a, b) => a.gap - b.gap)[0];
    $app.innerHTML = `${head.replace(/Teilstrecke \d+|Neue Reise/, "Deine Fahrt")}<h1>Passt das so?</h1>
      <p class="muted small">${new Date(W.legs[0].from.plan).toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Berlin" })}</p>${W.note ? `<p class="small muted">${esc(W.note)}</p>` : ""}
      ${tight ? `<div class="banner info small"><b>Knapper Umstieg in ${esc(cleanStop(tight.at))}: ${Math.max(0, tight.gap)} Min.</b> Nach dem Anlegen zeige ich dir Verbindungen, die etwas früher losfahren oder mehr Luft haben, und beobachte sie mit.</div>` : ""}
      <div class="card"><ol class="tl">${W.legs.map((l, i) => `${i ? `<li class="xfer-note small">${gapTag(Math.round((Date.parse(l.from.plan) - Date.parse(W.legs[i - 1].to.plan)) / MIN), W.editId ? W.minT : MINT, W.legs[i - 1].to.name)}</li>` : ""}<li><span class="dot"></span><div class="stop">${esc(l.from.name)} → ${esc(l.to.name)}</div>
        <div class="when">${esc(l.label)} · ab ${hm(l.from.plan)}${l.from.platform ? ` · ${esc(platWord(l, l.from.platform))}` : ""} · an ${l.to.estimated ? "≈" : ""}${hm(l.to.plan)}${l.to.platform ? ` · ${esc(platWord(l, l.to.platform))}` : ""}</div>
        ${l.kept ? `<div class="small"><b>wie bisher</b></div>` : l.jid || l.tid ? "" : `<div class="small muted">Live-Zeiten, soweit der Verkehrsbetrieb sie liefert</div>`}</li>`).join("")}</ol></div>
      ${repeatBlock()}${pushTick()}
      <button class="btn" id="done">${W.editId ? "Fahrt so ändern" : W.multi || (W.legs.some(isFVc) && !W.quick) ? "Weiter" : W.reg ? "Regelmäßig anlegen" : "Fahrt anlegen"}</button>
      ${W.mode !== "train" ? "" : `<button class="btn sec" id="more">Umstieg in ${esc(W.legs[n - 1].to.name)} hinzufügen</button>`}
      ${W.mode === "import" ? `<button class="btn quiet" id="undo">Nicht anlegen</button>` : W.mode === "route" ? `<button class="btn quiet" id="undo">Andere Verbindung wählen</button>` : `<button class="btn quiet" id="undo">Letzte Teilstrecke entfernen</button>`}${back}`;
    // Pendler: „einmal oder regelmäßig“ und Mitteilungen direkt hier – kein eigener Schritt mehr
    $app.querySelectorAll("[data-rep]").forEach(b => b.onclick = () => { const v = b.dataset.rep, r = repInfo();
      if (v === "once") W.reg = null;
      else if (v === "quick") W.reg = { name: "", days: r.days, kind: "fix", from: "", to: "", hol: true };
      else { W.reg = null; W.step = "regular"; W.regMore = true; }
      render(); });
    document.getElementById("pushTick")?.addEventListener("change", e => { W.pushNo = !e.target.checked; });
    document.getElementById("done").onclick = () => {
      if (!W.editId && !W.pushNo && document.getElementById("pushTick")) W.pushAsk = Notification.requestPermission().catch(() => "default");   // im selben Tipp fragen (sonst blockt der Browser)
      if (W.editId) return saveTrip(W.editTicket);
      if (W.regIntent && !W.regPreset && !W.reg) { W.step = "regular"; render(); } else toTicket(); };
    if (document.getElementById("more")) document.getElementById("more").onclick = () => { const l = W.legs[n - 1]; W.station = { eva: l.to.eva, name: l.to.name, lat: l.to.lat, lon: l.to.lon }; W.from = Date.parse(l.to.plan); W.list = null; W.step = "trains"; render(); };
    document.getElementById("undo").onclick = () => { if (W.mode === "import") { W.legs = []; W.step = W.imported?.length > 1 ? "pickTrip" : "route"; } else if (W.mode === "route") { W.legs = []; W.step = "conns"; W.preDone = false; W.preLegs = null; W.postLegs = null; W.conns = null; } else { W.legs.pop(); W.step = W.legs.length ? "leg" : "station"; } render(); };
  }

  else if (W.step === "regular") {
    // Vor dem Ticket: regelmäßig überwachen? (z. B. Arbeitsweg) – mit Tagen und genauer Abfahrt oder Zeitfenster
    const l0 = W.legs[0], dep = Date.parse(l0.from.plan), depHm = hm(dep), dow = ((new Date(new Date(dep).toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" }) + "T12:00:00Z").getUTCDay() + 6) % 7) + 1;
    if (!W.reg && W.regMore) {   // aus „Andere Tage …“ unter der Verbindung: gleich das Formular
      const p = x => String(x).padStart(2, "0"), mins = +depHm.slice(0, 2) * 60 + +depHm.slice(3), a = Math.max(0, Math.floor((mins - 15) / 15) * 15), b = Math.min(23 * 60 + 59, a + 60);
      W.reg = { name: "", days: dow <= 5 ? [1, 2, 3, 4, 5] : [dow], kind: "fix", from: `${p(Math.floor(a / 60))}:${p(a % 60)}`, to: `${p(Math.floor(b / 60))}:${p(b % 60)}`, hol: true, custom: true };
    }
    if (!W.reg) {
      const wk = dow <= 5, quick = wk ? "Mo–Fr" : DOW[dow - 1];
      // Über „Mein Weg“ gekommen: es ist schon klar, dass es regelmäßig ist – nur noch die Tage
      $app.innerHTML = `<p class="steps">${W.regIntent ? "Neue regelmäßige Fahrt" : "Deine Fahrt"}</p><h1>${W.regIntent ? "An welchen Tagen?" : "Einmal oder öfter?"}</h1>
        <p class="muted small">${esc(cleanStop(l0.from.name))} → ${esc(cleanStop(W.legs[W.legs.length - 1].to.name))}, ab ${depHm}</p>${err}
        ${W.regIntent ? `<button class="btn big-btn" id="regQuick">Jeden ${quick} um ${depHm}</button>`
          : `<button class="btn big-btn" id="regNo">Nur diese Fahrt</button><button class="btn sec" id="regQuick">Regelmäßig: jeden ${quick} um ${depHm}</button>`}
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
        <button class="btn" id="wrNext">${W.regMore ? "Übernehmen" : "Weiter"}</button>
        <button class="btn quiet" id="wrCancel">${W.regMore ? "Doch nur diesmal" : "Doch nicht regelmäßig"}</button>${back}`;
      const keep = () => { R.name = document.getElementById("wrName").value; R.from = document.getElementById("wrFrom")?.value || R.from; R.to = document.getElementById("wrTo")?.value || R.to; R.hol = document.getElementById("wrHol").checked; };
      $app.querySelectorAll("[data-wrd]").forEach(b => b.onclick = () => { keep(); const d = +b.dataset.wrd; R.days = R.days.includes(d) ? R.days.filter(x => x !== d) : [...R.days, d].sort(); render(); });
      $app.querySelectorAll("[data-wrk]").forEach(b => b.onclick = () => { keep(); R.kind = b.dataset.wrk; render(); });
      document.getElementById("wrCancel").onclick = () => { W.reg = null; if (W.regMore) { W.regMore = false; W.step = "leg"; return render(); } toTicket(); };
      document.getElementById("wrNext").onclick = () => { keep();
        if (!R.days.length) { W.error = "Bitte mindestens einen Tag wählen."; return render(); }
        if (R.kind === "win" && !(R.to > R.from)) { W.error = "Das Ende des Zeitfensters muss nach dem Beginn liegen."; return render(); }
        W.error = ""; if (W.regMore) { R.custom = true; W.regMore = false; W.step = "leg"; return render(); } toTicket(); };
    }
  }

  else if (W.step === "ticket") {
    const O = { spar: ["spar", "Sparpreis / Super Sparpreis", "Mit Zugbindung – ich sage dir, wann sie voraussichtlich aufgehoben ist."],
      flex: ["flex", "Flexpreis", "Freie Zugwahl auf der Strecke."], dticket: ["dticket", "Deutschlandticket", "Auch Schüler- oder Jobticket. Gilt nur im Nahverkehr."], bc100: ["bc100", "BahnCard 100", "Freie Zugwahl."],
      none: ["flex", "Weiß ich nicht", "Kein Problem – dann gibt es keine Hinweise zur Zugbindung."] };
    // überall dieselbe Reihenfolge
    const opts = ["spar", "flex", "dticket", "bc100", "none"].map(k => O[k]);
    $app.innerHTML = `<p class="steps">Fast fertig</p><h1>Welches Ticket hast du?</h1><p class="muted small">Nur für den Hinweis zur Zugbindung. Es wird nichts gekauft oder gebucht.</p>
      ${err}<ul class="list">${opts.map(([k, t, d]) => `<li><button data-t="${k}"><b>${t}</b>${W.ticketGuess === k && t !== "Weiß ich nicht" ? ` <span class="chip-t">erkannt</span>` : ""}<br><span class="small muted">${d}</span></button></li>`).join("")}</ul>${back}`;
    $app.querySelectorAll("[data-t]").forEach(b => b.onclick = async () => {
      // Deutschlandticket + Fernzug: ehrlich warnen (im ICE/IC gilt es nicht)
      const fv = W.legs.filter(isFVc).map(l => l.label);
      if (b.dataset.t === "dticket" && fv.length && (await ask(`Deutschlandticket gilt nicht im ${fv[0]}\n\nIm Fernverkehr (${[...new Set(fv)].join(", ")}) brauchst du ein anderes Ticket.`, { ok: "Anderes Ticket wählen", alt: "Trotzdem so überwachen", cancel: null })) !== "alt") return;
      saveTrip(b.dataset.t); });
  }

  const bk = document.getElementById("wBack");
  if (bk) bk.onclick = () => {
    W.error = "";
    if (W.step === "regsetup") { W = null; return go("routines"); }
    if (W.step === "place") { W.step = W.plBack || "route"; W.pl = null; return render(); }
    if (W.step === "route") { if (W.regIntent && W.reg) { W.step = "regsetup"; return render(); } W = null; return go("home"); }
    if (W.step === "station") { if (W.mode === "train" && !W.legs.length) W.step = "route"; else { W = null; return go("home"); } }
    else if (W.step === "conns") W.step = "route";
    else if (W.step === "trains") W.step = W.legs.length ? "leg" : "station";
    else if (W.step === "exit") W.step = "trains";
    else if (W.step === "ticket") W.step = W.multi ? "pickTrip" : W.regIntent && !W.regPreset ? "regular" : "leg";
    else if (W.step === "regular" && W.regMore) { W.reg = null; W.regMore = false; W.step = "leg"; }   // „Andere Tage …“ abgebrochen
    else if (W.step === "regular") { if (W.reg) W.reg = null; else W.step = "leg"; }   // Formular → Frage → Verbindung
    else if (W.step === "leg" && W.mode === "route") { W.legs = []; W.step = "conns"; }
    else if (W.step === "leg" && W.mode === "import") { W.legs = []; W.step = W.imported?.length > 1 ? "pickTrip" : "route"; }
    else if (W.step === "leg") { W.legs.pop(); W.list = null; W.step = "trains"; }   // Zug aus der Abfahrtstafel: diese Teilstrecke neu wählen
    else if (W.step === "pickTrip") W.step = "route";
    render();
  };
}

// Richtung einer Abfahrt; die Ringbahn hat kein Ziel
function dirText(e) {
  const d = (e.direction || []).map(x => x.name).filter(Boolean).join(" / "), lb = String(e.label || "").replace(/\s+/g, "");
  if (/^S41$/i.test(lb) && (!d || /ring/i.test(d) || cleanStop(d) === cleanStop(W.station?.name || ""))) return "Ring im Uhrzeigersinn";
  if (/^S42$/i.test(lb) && (!d || /ring/i.test(d) || cleanStop(d) === cleanStop(W.station?.name || ""))) return "Ring gegen den Uhrzeigersinn";
  return d ? `nach ${esc(d)}` : "";
}
function trainList(list) {
  if (!list.length) return `<p class="muted">Keine Abfahrten in diesem Zeitraum gefunden.</p>`;
  return `<ul class="list">${list.map((e, i) => `<li><button data-j="${i}" ${e.cancelled ? "disabled" : ""}><div class="train">
    <span class="t">${hm(e.rt)}</span><span class="l">${esc(e.label)}${e.cancelled ? ` <span class="late">fällt aus</span>` : ""}</span>
    <span class="pl">${esc(platWord(e, e.platform))}</span>
    <span class="d">${e.rt !== e.plan && Date.parse(e.rt) - Date.parse(e.plan) >= MIN ? `<span class="late">+${Math.round((Date.parse(e.rt) - Date.parse(e.plan)) / MIN)}</span> · ` : ""}${dirText(e)}${e.stop && cleanStop(e.stop.name) !== cleanStop(W.station?.name || "") ? `<br><span class="small muted">ab ${esc(cleanStop(e.stop.name))}</span>` : ""}</span>
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
  W.busy = "Ich lese deine Fahrt …"; W.error = ""; render();
  try {
    const r = await api("/api/import", { method: "POST", body });
    W.ticketGuess = r.ticket; W.note = r.note; W.mode = "import"; W.imported = r.trips;
    if (!r.trips.length) W.error = `Ich konnte darin keine Verbindung erkennen.${r.note ? " " + r.note : ""} Versuch einen Screenshot der Reiseübersicht.`;
    else if (r.trips.length === 1) { W.legs = r.trips[0].legs; W.step = "leg"; }
    else W.step = "pickTrip";
  } catch (e) { if (W) W.error = e.message; }
  if (!W) return; W.busy = null; render();
}

async function pickConnection(c) {
  const lastArr = Date.parse(c.legs[c.legs.length - 1].to.rt || c.legs[c.legs.length - 1].to.plan);
  if (lastArr < Date.now()) return alert("Diese Verbindung ist schon vorbei\n\nBitte eine spätere wählen – oder oben einen anderen Tag.");
  W.busy = "Verbindung wird vorbereitet …"; render();
  let legs = null, err = "";
  try { legs = await api("/api/resolve", { method: "POST", body: { legs: c.legs } }); } catch (e) { err = e.message; }
  if (!W) return;
  const K = keepInfo(), ph = keepPhase();
  if (legs && K && ph === "pre" && K.post) { W.preLegs = legs; W.preDone = true; W.conns = null; W.error = err; W.busy = null; return render(); }   // weiter mit Teil 2
  if (legs && K) { if (ph === "pre") W.preLegs = legs; else W.postLegs = legs;
    const all = [...(W.preLegs || []), ...keptLegs(K), ...(W.postLegs || [])], key = x => String(x || "").replace(/\s/g, "").toUpperCase();
    W.legs = all.reduce((o, l) => { const p = o[o.length - 1]; if (p && key(p.label) === key(l.label)) o[o.length - 1] = { ...p, to: l.to, kept: p.kept && l.kept }; else o.push(l); return o; }, []);
    W.step = "leg"; }
  else if (legs) { W.legs = legs; W.step = "leg"; } W.error = err;
  W.busy = null; render();
}

async function resolveLeg(stop, onRoute = true) {
  const tr = W.train;
  W.busy = `Suche die Ankunft in ${stop.name} …`; render();
  try {
    const leg = await api("/api/leg", { method: "POST", body: { jid: tr.jid, label: tr.label, toEva: stop.eva, toName: stop.name, onRoute,
      from: { eva: tr.eva || W.station.eva, name: W.station.name, plan: tr.plan, platform: tr.platformPlan || tr.platform } } });
    if (!leg.to.name) leg.to.name = stop.name;
    if (!W) return;
    // derselbe Zug wie eben (an der nächsten Station „wieder eingestiegen“): sitzen bleiben, kein Umstieg
    const prev = W.legs[W.legs.length - 1], key = x => String(x || "").replace(/\s/g, "").toUpperCase();
    if (prev && ((prev.jid && prev.jid === leg.jid) || (key(prev.label) === key(leg.label) && /\d/.test(prev.label) && Math.abs(Date.parse(leg.from.plan) - Date.parse(prev.to.plan)) <= 20 * MIN))) {
      prev.to = leg.to; W.note = `Du bleibst im ${prev.label} sitzen – das ist kein Umstieg.`;
    } else W.legs.push(leg);
    W.step = "leg"; W.error = "";
  } catch (e) { if (W) W.error = e.message; }
  if (!W) return; W.busy = null; render();
}

async function saveTrip(ticket) {
  if (W.editId) {
    const id = W.editId, minT = W.minT;
    const key = x => String(x || "").replace(/\s/g, "").toUpperCase();
    // gebunden ist der Sparpreis an den Zug zu seiner Zeit: gleiche Nummer zu anderer Zeit ist ein anderer Zug
    const tk = (lab, ms) => `${key(lab)}@${Math.round(Date.parse(ms) / 60e3)}`;
    const oldFV = [...new Set(W.ref.legs.filter(isFVc).map(x => tk(x.label, x.dep)))], newFV = [...new Set(W.legs.filter(isFVc).map(x => tk(x.label, x.from?.plan || x.dep)))];
    if ((ticket || W.editTicket) === "spar" && newFV.some(x => !oldFV.includes(x))) {
      const nw = W.legs.filter(isFVc).filter(l => !oldFV.includes(key(l.label))).map(l => l.label);
      if (!(await ask(`Achtung Sparpreis\n\nDein Ticket gilt nur für die gebuchten Züge${oldFV.length ? ` (${W.ref.legs.filter(isFVc).map(x => x.label).join(", ")})` : ""}. Mit der neuen Verbindung fährst du ${[...new Set(nw)].join(", ")} – das geht nur, wenn die Zugbindung aufgehoben ist. Sonst brauchst du ein neues Ticket.`, { ok: "Trotzdem ändern", cancel: "Abbrechen" }))) return;
    }
    W.busy = "Fahrt wird geändert …"; render();
    try {
      const K = keepInfo();
      await api(`/api/trips/${id}`, { method: "PUT", body: K ? { keep: { a: K.a, b: K.b }, pre: (W.preLegs || []).map(l => ({ ...l, minT })), post: (W.postLegs || []).map(l => ({ ...l, minT })), minT, ticket }
        : { legs: W.legs.map(l => ({ ...l, minT })), minT, ticket } });
      flash = "Fahrt geändert. Ich überwache jetzt die neue Verbindung."; SHARE_AFTER = id;
      W = null; await loadTrips(); openId = id; sheetId = null; return go("home");
    } catch (e) { if (!W) return; W.busy = null; W.error = e.message; return render(); }
  }
  if (W.saving) return; W.saving = true;   // doppeltes Tippen: nur einmal anlegen
  W.busy = "Fahrt wird angelegt …"; render();
  try {
    let newId = null;
    for (const legs of W.multi || [W.legs]) newId = (await api("/api/trips", { method: "POST", body: { legs: legs.map(l => ({ ...l, minT: MINT })), ticket, src: W.mode === "import" ? "import" : W.mode === "train" ? "board" : W.quick ? "quick" : W.fav ? "fav" : "search" } })).id || newId;
    if (W.reg && newId && !W.multi) {
      // gleich regelmäßig: genaue Abfahrt (aus dieser Reise) oder Zeitfenster (Start/Ziel dieser Reise)
      const R = W.reg, f = W.legs[0].from, t = W.legs[W.legs.length - 1].to;
      const r = await api("/api/routines", { method: "POST", body: R.kind === "win"
        ? { tripId: newId, from: f, to: t, name: R.name.trim(), days: R.days, winFrom: R.from, winTo: R.to, ticket, holidays: R.hol, minT: MINT, replace: W.replaceR || undefined }
        : { tripId: newId, name: R.name.trim(), days: R.days, holidays: R.hol, replace: W.replaceR || undefined } }).catch(e => { alert(`Die Fahrt ist angelegt, aber regelmäßig ging nicht: ${e.message}`); return null; });
      if (r) {
        ROUTINES = await api("/api/routines").catch(() => ROUTINES);
        flash = `Gespeichert: „${r.name}“, ${daysText(r.days)} ${r.win ? `${r.win[0]}–${r.win[1]}` : r.dep}. Die Fahrt erscheint jeweils ein paar Stunden vorher hier.`;
        if (W.pushAsk) W.pushAsk.then(x => (x === "granted" ? enablePush() : null)).catch(() => {});
        const fromReg = W.regIntent, optOut = W.pushNo, lg = W.legs;
        if (!W.retNo) offerReturn({ routine: r.id, from: W.rFrom || placeOfStop(lg[0].from), to: W.rTo || placeOfStop(lg[lg.length - 1].to), reg: { name: r.name, days: r.days, hol: r.holidays, kind: "fix", at: "17:00" } });
        W = null; await loadTrips(); openId = null; go("routines"); if (!optOut) askPushSoon(); return;
      }
    }
    if (W.mode === "import" && !W.multi && W.imported?.length > 1 && W.pickedIdx != null) {
      const done = W.imported[W.pickedIdx];
      W.savedOne = done.label || "Die Fahrt";
      W.imported = W.imported.filter((_, i) => i !== W.pickedIdx);
      W.pickedIdx = null; W.ticketGuess = ticket; W.busy = null; W.saving = false; W.step = "pickTrip";
      await loadTrips().catch(() => {}); return render();
    }
    if (W.pushAsk) { const ask0 = W.pushAsk; ask0.then(r => (r === "granted" ? enablePush().then(() => render()) : null)).catch(() => {}); }
    const n = (W.multi || [W.legs]).length;
    const tell = pushState() === "on" ? "Ich melde mich, wenn du etwas tun solltest." : "Schalte Mitteilungen ein, damit ich dich unterwegs warnen kann.";
    flash = n > 1 ? `${n} Fahrten angelegt. ${tell}` : `Fahrt angelegt. ${tell}`;
    const optOut = W.pushNo, lg = W.legs || [];
    if (n === 1 && lg.length && !W.retNo && !W.quick) offerReturn({ tripId: newId, from: W.rFrom || placeOfStop(lg[0].from), to: W.rTo || placeOfStop(lg[lg.length - 1].to), after: Date.parse(lg[lg.length - 1].to.plan) });
    W = null; await loadTrips().catch(() => {}); openId = n > 1 ? null : newId; go("home"); if (!optOut) askPushSoon();
  } catch (e) { if (!W) return; W.busy = null; W.saving = false; W.error = e.message; render(); if (!$app.querySelector(".err")) alert(`Das hat nicht geklappt\n\n${e.message}`); }
}

// ---------- Mitteilungen ----------
// Beim Öffnen und Zurückkehren prüfen, ob Mitteilungen wirklich an sind (z. B. Abo verloren, in den Einstellungen erlaubt) – ohne Rückfrage
async function checkPush() {
  if (!AUTH || !pushHere()) return;
  const was = localStorage.getItem("rb_push") === "1";
  try {
    if (Notification.permission === "granted") { const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription(); if (!sub || !was) await enablePush(true); }
    else if (was) localStorage.removeItem("rb_push");
  } catch {}
  if (was !== (localStorage.getItem("rb_push") === "1") && !W) render();
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkPush(); });
// Nach dem Anlegen (Fahrt, regelmäßige Fahrt, übernommener Link): sind Mitteilungen aus, einmal höflich fragen – „Jetzt nicht“ gilt einen Tag
async function askPush() {
  const ps = pushState();
  if (ps === "on" || later("pushask") || (ps === "off" && Notification.permission === "granted")) return;
  const notNow = () => { try { localStorage.setItem("rb_later_pushask", String(Date.now() + 864e5)); } catch {} };
  if (ps === "off") {
    const ok = await ask("Soll ich dir Bescheid geben?\n\nFällt etwas aus, verspätet sich oder wird ein Umstieg knapp, schicke ich dir eine Mitteilung aufs Handy. Du kannst das jederzeit wieder ausschalten.", { ok: "Ja, gern", cancel: "Jetzt nicht" });
    if (!ok) return notNow();
    try { await enablePush(); flash = "Mitteilungen sind an – ich melde mich, wenn etwas nicht klappt."; } catch (e) { notNow(); alert(`Mitteilungen gehen gerade nicht\n\n${e.message}`); }
    return render();
  }
  notNow();
  if (ps === "blocked") return alert(`Mitteilungen sind blockiert\n\nDamit ich dir Bescheid geben kann: ${unblockHow()}`);
  if (isIOS) return alert(`Mitteilungen auf dem iPhone\n\nDie gibt es nur in der installierten App: ${installHow()}`);
  return infoDlg("Mitteilungen in diesem Browser nicht möglich", `<p>${esc(BNAME() === "diesem Browser" ? "Dieser Browser" : BNAME())} kann keine Mitteilungen anzeigen. Warnungen siehst du, sobald du Umstiegsheld öffnest.</p>
    <p class="small muted" style="margin:8px 0 6px">Für Mitteilungen aufs Handy hier öffnen – deine Fahrten nimmst du über „Gerät hinzufügen“ mit:</p>${browserGrid()}`);
}
// Schlichtes Fenster mit eigenem Inhalt (z. B. Browser-Knöpfe)
function infoDlg(title, html) {
  return new Promise(res => {
    const w = document.createElement("div"); w.className = "dlg-wrap";
    w.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h2>${esc(title)}</h2>${html}<div class="dlg-btns" style="margin-top:12px"><button class="btn sec" data-no>Schließen</button></div></div>`;
    const done = () => { w.remove(); res(); };
    w.addEventListener("click", e => { if (e.target === w || e.target.closest("[data-no]")) done(); });
    document.body.appendChild(w); w.querySelector("[data-no]").focus();
  });
}
const askPushSoon = () => setTimeout(() => askPush().catch(() => {}), 700);
const unb64u = s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
async function enablePush(quiet = false) {
  const cfg = await api("/api/config");
  if (!cfg.vapid) throw new Error("Mitteilungen sind auf dem Server noch nicht eingerichtet.");
  if (await Notification.requestPermission() !== "granted") throw new Error("Ohne Erlaubnis kann ich dich unterwegs nicht benachrichtigen.");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(cfg.vapid) });
  await api("/api/push", { method: "POST", body: sub.toJSON() });
  localStorage.setItem("rb_push", "1");
  if (!quiet) await api("/api/push/test", { method: "POST" }).catch(() => {});
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
// ---------- Rückfahrt: nach dem Anlegen anbieten (Start und Ziel getauscht) ----------
let RET = null;   // { tripId?, routine?, from, to, after, reg? }
function offerReturn(o) { if (o.from && o.to && plainStop(o.from.name) !== plainStop(o.to.name)) RET = o; }
const retCard = (match) => !RET || !match ? "" : `<section class="card ret-card"><div class="k">Rückfahrt</div>
  <p style="margin:0 0 8px">${RET.reg ? "Auch den Rückweg regelmäßig überwachen?" : "Auch die Rückfahrt überwachen?"} <span class="muted">${esc(cleanStop(RET.to.name))} → ${esc(cleanStop(RET.from.name))}</span></p>
  <div class="row"><button class="btn ${RET.reg ? "" : "sec "}small-btn" data-retgo>${RET.reg ? "Rückweg anlegen" : "Rückfahrt suchen"}</button><button class="btn quiet small-btn" data-retno>Nein danke</button></div></section>`;
function bindRet() {
  $app.querySelector("[data-retno]")?.addEventListener("click", () => { RET = null; render(); });
  $app.querySelector("[data-retgo]")?.addEventListener("click", () => {
    const o = RET; RET = null; startWizard(); W.rFrom = o.to; W.rTo = o.from;
    if (o.reg) { W.regIntent = true; W.reg = { name: o.reg.name ? `${o.reg.name} zurück` : "", days: o.reg.days, kind: o.reg.kind || "fix", at: o.reg.at || "17:00", from: o.reg.from || "16:00", to: o.reg.to || "18:00", hol: o.reg.hol !== false }; W.step = "regsetup"; }
    else { W.when = Math.max(Date.now(), (o.after || Date.now()) + 2 * 3600e3); W.step = "route"; W.retNote = "Start und Ziel sind getauscht – wähle noch die Uhrzeit."; }
    go("add"); });
}
// ---------- Verbindung teilen: kurzer Link, andere übernehmen sie mit einem Tipp in ihr Umstiegsheld ----------
const legLine = l => { const f = l.from || l.dep, e = l.to || l.arr; return `${hm(f.plan)} ${l.label} ${cleanStop(f.name || "")} → ${cleanStop(e.name || "")}`; };   // gespeicherte (from/to) und angezeigte (dep/arr) Teilstrecken
const tripLines = legs => { const a = legs[0], z = legs[legs.length - 1], f = l => l.from || l.dep, e = l => l.to || l.arr;
  return { head: `${cleanStop(f(a).name)} → ${cleanStop(e(z).name)}`, when: `${day(f(a).plan)} · ${hm(f(a).plan)} – ${hm(e(z).plan)}${legs.length > 1 ? ` · ${legs.length - 1} Umstieg${legs.length > 2 ? "e" : ""}` : ""}` }; };
// Nur „richtige“ Züge (Regional- und Fernverkehr) – S-Bahn, U-Bahn, Tram und Bus bucht man nicht bei der Bahn
const isTrainLeg = l => !/^(SUBURBAN|SUBWAY|METRO|TRAM|BUS|COACH|FERRY)$/.test(l.mode || "") && !/^(S|U|STR|Tram|Bus|Fähre)\s?\d*\b/i.test(String(l.label || ""))
  && (/RAIL|HIGHSPEED|LONG_DISTANCE|NIGHT/.test(l.mode || "") || /^(ICE|IC|EC|ECE|ICD|IRE|RE|RB|MEX|RJX?|NJ|EN|D|TGV|EST|FEX)\s?\d/i.test(String(l.label || "")));
const showBahn = t => t.phase === "before" && !["dticket", "spar", "bc100"].includes(t.ticket) && !t.follow && t.legs.some(isTrainLeg);   // Sparpreis/BahnCard 100: Ticket ist schon da
// Suche auf bahn.de vorbelegt (Start, Ziel, Abfahrt) – auf dem Handy öffnet sich ggf. der DB Navigator
// Ziel für die Bahn-Übergabe: Ankunft des letzten Zugs an einem deutschen Bahnhof (Bahnhofsnummer 80…).
// Ins Ausland findet die Bahn-Suche mit unseren Daten oft keine Verbindung – dann bis zum letzten deutschen Bahnhof übergeben.
const deStop = s => /^80\d{5}$/.test(String(s?.eva || ""));
function bahnDest(legs) {
  const trains = legs.filter(isTrainLeg), last = trains[trains.length - 1] || legs[legs.length - 1];
  if (deStop(last.arr)) return { stop: last.arr };
  const de = [...trains].reverse().find(l => deStop(l.arr)) || [...trains].reverse().find(l => deStop(l.dep));
  if (!de) return { stop: last.arr };
  const stop = deStop(de.arr) ? de.arr : de.dep;
  return { stop, cut: cleanStop(last.arr.name) };
}
function bahnUrl(t) {
  const L = t.legs, d = bahnDest(L);
  // Start = deine erste Haltestelle (auch Bus/Tram), Ziel = Ankunft des letzten Zugs (in Deutschland); Abfahrt = Abfahrt an der ersten Haltestelle
  const url = bahnLink(L[0].dep, d.stop, L[0].dep.plan);
  bahnUrl.last.cut = d.cut || "";
  return url;
}
// Format wie die Links, die bahn.de selbst erzeugt: soid/zoid = „A=1@O=Name@X=Länge·10⁶@Y=Breite·10⁶@U=80@L=Bahnhofsnummer@“
function bahnLink(a, z, at) {
  // Haltestellen ohne Bahnhofsnummer heißen bei der Bahn „Roseneck, Berlin“ statt „Roseneck (Berlin)“
  const nm = s => /^\d{6,9}$/.test(String(s.eva || "")) ? String(s.name || "").replace(/\s*\(Berlin\)$/, "") : String(s.name || "").replace(/\s*\(([^)]+)\)\s*$/, ", $1");
  const loc = s => { const ok = /^\d{6,9}$/.test(String(s.eva || ""));
    return `A=1@O=${nm(s)}@${s.lat != null ? `X=${Math.round(s.lon * 1e6)}@Y=${Math.round(s.lat * 1e6)}@` : ""}${ok ? `U=80@L=${s.eva}@` : ""}`; };
  const hd = new Date(at).toLocaleString("sv-SE", { timeZone: "Europe/Berlin" }).replace(" ", "T").slice(0, 19);
  const q = new URLSearchParams({ sts: "true", so: nm(a), zo: nm(z), kl: "2", r: "13:16:KLASSENLOS:1", soid: loc(a), zoid: loc(z), sot: "ST", zot: "ST", hd, hza: "D" });
  bahnUrl.last = { from: nm(a), to: nm(z), at };
  return `https://www.bahn.de/buchung/fahrplan/suche#${q.toString().replace(/\+/g, "%20")}`;
}
// Plan B bei der Bahn gegenprüfen: ab dem Bahnhof, an dem der Anschluss platzt (bzw. wo du gerade bist), zur echten Ankunftszeit dort
function bahnCheck(t) {
  if (t.phase === "done" || !t.legs.some(isTrainLeg)) return null;
  const now = Date.now(), L = t.legs;
  const k = t.transfers.findIndex(x => x.status === "LOST" || x.status === "RISK");
  let from, at, next;   // next = erste Fahrt ab dort
  if (k >= 0 && Date.parse(L[k].arr.rt) > now - 30 * MIN) { from = L[k].arr; at = L[k].arr.rt; next = k + 1; }   // Ankunft am Umstieg (noch unterwegs oder gerade da)
  else { const i = Math.max(0, L.findIndex(l => Date.parse(l.dep.rt) > now - MIN)); from = L[i].dep; at = new Date(Math.max(now, Date.parse(L[i].dep.rt))).toISOString(); next = i; }
  const last = [...L.slice(next)].reverse().find(isTrainLeg);
  if (!last || sameStation(from.name, last.arr.name)) return null;   // danach fährt kein Zug mehr
  const d = bahnDest(L.slice(next));
  if (sameStation(from.name, d.stop.name)) return null;
  return { url: bahnLink(from, d.stop, at), from: cleanStop(from.name), at, to: cleanStop(d.stop.name), cut: d.cut || "" };
}
// Kurz-Nachricht zum aktuellen Stand – passt zu jeder Lage (vor der Fahrt, unterwegs, Plan B, angekommen)
function statusText(t) {
  const L = t.legs, a = L[0], z = L[L.length - 1], dest = cleanStop(z.arr.name), late = Math.round((Date.parse(z.arr.rt) - Date.parse(z.arr.plan)) / MIN);
  const eta = `${hm(z.arr.rt)}${late >= 3 ? ` (ca. ${late} Min. später)` : ""}`;
  if (t.phase === "done") return `Bin in ${dest} angekommen (${hm(z.arr.rt)}).`;
  if (t.status === "LOST") return `Mein Anschluss klappt nicht – ich suche gerade eine neue Verbindung nach ${dest} und melde mich.`;
  const tr = (t.transfers || []).find(x => x.status === "RISK" || x.status === "WATCH");
  const warn = tr ? ` Der Umstieg in ${cleanStop(tr.at)} wird ${tr.status === "RISK" ? "eng" : "knapp"}.` : "";
  const changed = t.canUndo ? " Neue Verbindung:" + L.filter((l, i) => i >= Math.max(0, t.current)).map(l => ` ${l.label} ${hm(l.dep.rt)}`).join(",") + "." : "";
  const dayTxt = ms => { const d = new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }); const w = dateWord(d); return /^(heute|morgen)$/.test(w) ? w : `am ${w}`; };
  const arrDay = sameDay(Date.parse(z.arr.rt), Date.parse(a.dep.rt)) ? "" : ` (${new Date(z.arr.rt).toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: "Europe/Berlin" })})`;
  if (t.phase === "before") return `Ich fahre ${dayTxt(Date.parse(a.dep.rt))} um ${hm(a.dep.rt)} in ${cleanStop(a.dep.name)} los und bin ca. ${eta}${arrDay} in ${dest}${z.arr.platform ? `, Gleis ${z.arr.platform}` : ""}.${warn}`;
  return `Bin unterwegs nach ${dest}, Ankunft ca. ${eta}${arrDay}${z.arr.platform ? `, Gleis ${z.arr.platform}` : ""}.${changed}${warn}`;
}
async function shareTrip(t, btn) {
  const pick = await ask(`Was möchtest du schicken?\n\nAnkunft & Live-Link: Kurze Nachricht mit deiner Ankunftszeit. Über den Link sieht man jederzeit den aktuellen Stand – gut fürs Abholen.\n\nVerbindung: Andere können genau diese Fahrt in ihr Umstiegsheld übernehmen.`, { ok: "Ankunft & Live-Link", alt: "Verbindung zum Übernehmen", cancel: "Abbrechen" });
  if (!pick) return;
  return pick === true ? shareLive(t, btn) : shareConn(t, btn);
}
async function sendText(title, text, url) {
  if (navigator.share) { try { await navigator.share({ title, text, url }); } catch (e) { if (e?.name !== "AbortError") throw e; } }
  else { await navigator.clipboard.writeText(`${text}\n${url}`); flash = "Text kopiert – du kannst ihn jetzt z. B. in WhatsApp einfügen."; render(); }
}
async function shareLive(t, btn) {
  if (btn) btn.disabled = true;
  try {
    const { url } = await api(`/api/trips/${t.id}/live`, { method: "POST" });
    await sendText("Meine Fahrt – live", `${statusText(t)}\n\nLive verfolgen:`, url);
  } catch (e) { alert(`Teilen ging nicht\n\n${e.message}`); }
  finally { if (btn) btn.disabled = false; }
}
async function shareConn(t, btn) {
  if (btn) btn.disabled = true;
  try {
    const { url } = await api(`/api/trips/${t.id}/share`, { method: "POST" });
    const L = tripLines(t.legs), text = `${L.head}\n${L.when}\n${t.legs.map(legLine).join("\n")}\n\nIn Umstiegsheld übernehmen und überwachen lassen:`;
    await sendText(L.head, text, url);
  } catch (e) { alert(`Teilen ging nicht\n\n${e.message}`); }
  finally { if (btn) btn.disabled = false; }
}
const routineWhen = (R, legs) => `${daysText(R.days)} · ${R.win_to ? `alle Fahrten ${R.win_from}–${R.win_to}` : `ab ${R.dep}`}${R.holidays ? " · nicht an Feiertagen" : ""}`;
async function shareRoutine(r, btn) {
  if (!r) return; if (btn) btn.disabled = true;
  try {
    const { url } = await api(`/api/routines/${r.id}/share`, { method: "POST" });
    const head = `${cleanStop(r.from)} → ${cleanStop(r.to)}`;
    const text = `Regelmäßige Fahrt: ${head}\n${daysText(r.days)} · ${r.win ? `alle Fahrten ${r.win[0]}–${r.win[1]}` : `ab ${r.dep} · ${r.label}`}\n\nIn Umstiegsheld übernehmen – dann wirst du an jedem Fahrtag gewarnt, wenn etwas nicht klappt:`;
    if (navigator.share) { try { await navigator.share({ title: head, text, url }); } catch (e) { if (e?.name !== "AbortError") throw e; } }
    else { await navigator.clipboard.writeText(`${text}\n${url}`); flash = "Link kopiert – du kannst ihn jetzt z. B. in WhatsApp einfügen."; render(); }
  } catch (e) { alert(`Teilen ging nicht\n\n${e.message}`); }
  finally { if (btn) btn.disabled = false; }
}
async function takeSharedRoutine(code, sh) {
  const R = sh.routine, legs = sh.legs, head = `${cleanStop(legs[0].from.name)} → ${cleanStop(legs[legs.length - 1].to.name)}`;
  const via = R.win_to ? "" : `\n\n${legs.map(l => `${l.label} ${cleanStop(l.from.name)} → ${cleanStop(l.to.name)}`).join("\n")}`;
  const yes = await ask(`Regelmäßige Fahrt übernehmen?\n\n${head}\n${routineWhen(R)}${via}\n\nJemand hat dir diese Strecke geschickt. An jedem Fahrtag lege ich die Fahrt ein paar Stunden vorher für dich an und melde mich, wenn etwas nicht klappt. Tage und Zeit kannst du danach ändern.`, { ok: "Bei mir überwachen", cancel: "Nein danke" });
  if (!yes) return;
  try {
    const r = await api("/api/routines", { method: "POST", body: { share: code, days: R.days } });
    ROUTINES = await api("/api/routines").catch(() => ROUTINES); R_OPEN = r.id;
    flash = `Übernommen: „${r.name}“. Du kannst sie unter „Umbenennen“ anders nennen.`;
    await loadTrips().catch(() => {}); go("routines"); askPushSoon();
  } catch (e) { alert(/schon überwacht/.test(e.message) ? `Schon vorhanden\n\n${e.message}` : `Übernehmen ging nicht\n\n${e.message}`); }
}
// Vom Live-Link: Fahrt mitverfolgen – erscheint wie eine eigene, gleicht sich aber mit dem Original ab
async function followTrip(code) {
  try {
    const r = await api("/api/follow", { method: "POST", body: { id: code } });
    flash = r.own ? "Das ist deine eigene Fahrt." : r.existed ? "Diese Fahrt verfolgst du schon mit." : "Du verfolgst diese Fahrt jetzt mit. Erlaube Mitteilungen, dann melde ich mich, wenn sie sich verspätet oder geändert wird.";
    await loadTrips(); openId = r.id; sheetId = null; go("home"); askPushSoon();
  } catch (e) { alert(`Mitverfolgen ging nicht\n\n${e.message}`); }
}
// Link „/?v=…“ geöffnet: Verbindung zeigen und auf Wunsch bei sich überwachen
async function takeSharedTrip(code) {
  let sh;
  try { const r = await fetch(`/api/shared/${encodeURIComponent(code)}`); sh = await r.json().catch(() => ({})); if (!r.ok) throw new Error(sh.error || "Link nicht gefunden"); }
  catch (e) { return alert(`Geteilte Verbindung\n\n${e.message}`); }
  if (sh.kind === "routine") return takeSharedRoutine(code, sh);
  // schon in deinen Fahrten (z. B. eigener Link oder zweimal geöffnet)? Dann gleich öffnen statt nochmal fragen
  const sig = L0 => L0.map(l => `${String(l.label).replace(/\s/g, "")}@${Date.parse((l.from || l.dep).plan)}`).join("|");
  const have = trips.find(t => sig(t.legs) === sig(sh.legs));
  if (have) { flash = "Diese Verbindung ist schon in deinen Fahrten."; openId = have.id; sheetId = null; return go("home"); }
  const L = tripLines(sh.legs);
  const yes = await ask(`Verbindung übernehmen?\n\n${L.head}\n${L.when}\n\n${sh.legs.map(legLine).join("\n")}\n\nJemand hat dir diese Verbindung geschickt. Ich überwache sie dann auch für dich und melde mich, wenn etwas nicht klappt.`, { ok: "Bei mir überwachen", cancel: "Nein danke" });
  if (!yes) return;
  try {
    const r = await api("/api/trips", { method: "POST", body: { legs: sh.legs.map(l => ({ ...l, minT: MINT })), ticket: "flex", src: "share" } });
    flash = r.existed ? "Diese Verbindung überwachst du schon." : "Übernommen – ich überwache die Verbindung jetzt für dich.";
    await loadTrips(); openId = r.id; sheetId = null; go("home"); askPushSoon();
  } catch (e) { alert(/schon überwacht/.test(e.message) ? `Schon vorhanden\n\n${e.message}` : `Übernehmen ging nicht\n\n${e.message}`); }
}
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
  if (e.data?.push) {   // Meldung kam, während die App offen ist
    PUSH_NOTE = { ...e.data.push, at: Date.now() };
    if (e.data.push.urgent) navigator.vibrate?.(200);
    await loadTrips().catch(() => {});
    if (!(view === "add" && W)) render();   // laufende Eingabe nicht stören
    return;
  }
  const id = e.data?.open && tripFromUrl(e.data.open);
  if (!id) return;
  if (view === "add" && W && (W.legs?.length || W.rFrom || W.imported)) return;   // laufende Eingabe nicht verwerfen
  W = null; openId = id; sheetId = null; openLeg = null;
  await loadTrips().catch(() => {});
  go("home");
});
// Link „/?link=123456“ von einem anderen Gerät: gleich zum Verbinden
const followCode = new URLSearchParams(location.search).get("f");
if (followCode) history.replaceState(null, "", "/");
const shareCode = new URLSearchParams(location.search).get("v");
if (shareCode) history.replaceState(null, "", "/");
const linkCode = new URLSearchParams(location.search).get("link");
if (linkCode) { history.replaceState(null, "", "/"); view = "settings"; DEV.join = true; DEV.input = linkCode; }
// Sofort den letzten Stand zeigen (aus dem Gerät), dann im Hintergrund frisch laden
try { const c = JSON.parse(localStorage.getItem("rb_trips_cache") || "null"); if (c?.trips?.length && Date.now() - c.at < 12 * 3600e3) { trips = c.trips; render(); } } catch {}
loadTrips().then(() => { render(); schedule(); takeShared(); checkPush(); syncFavs().then(() => { if (view === "add") render(); }); syncPrefs().then(ch => { if (ch) render(); });
  if (linkCode) setTimeout(() => joinDevice(linkCode), 300);
  if (shareCode) setTimeout(() => takeSharedTrip(shareCode), 300);
  if (followCode) setTimeout(() => followTrip(followCode), 100); },
  e => { $app.innerHTML = `<p class="err">${esc(e.message)}</p><button class="btn sec" onclick="location.reload()">Noch einmal versuchen</button>`; });
