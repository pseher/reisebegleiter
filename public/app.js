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
async function register() {
  const r = await fetch("/api/register", { method: "POST" });
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
const setMinT = m => { MINT = m; try { localStorage.setItem("rb_mint", String(m)); } catch {} };
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
document.addEventListener("click", e => { const b = e.target.closest("[data-go]"); if (b) { if (b.dataset.go === "home") W = null; go(b.dataset.go); } });

async function loadTrips() {
  try { trips = (await api("/api/trips")).sort((a, b) => Date.parse(a.legs[0].dep.plan) - Date.parse(b.legs[0].dep.plan)); loadedAt = Date.now(); } catch (e) { if (!trips.length) throw e; }
}
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(async () => { if (view === "home" && document.visibilityState === "visible") { await loadTrips().catch(() => {}); render(); } schedule(); }, 60e3);
}
document.addEventListener("visibilitychange", async () => { if (document.visibilityState === "visible" && view === "home" && Date.now() - loadedAt > 30e3) { await loadTrips().catch(() => {}); render(); } });

// ---------- Zurück-Taste (Handy/Browser) ----------
// Solange man nicht auf der Startseite ist, liegt ein Eintrag im Verlauf. „Zurück“ macht dann einen Schritt in der App.
let guard = false, skipPop = false;
const atRoot = () => view === "home" && (!openId || trips.filter(t => t.active !== false).length <= 1);
function syncHistory() {
  if (!atRoot() && !guard) { history.pushState({ rb: 1 }, ""); guard = true; }
  else if (atRoot() && guard) { guard = false; skipPop = true; history.back(); }
}
addEventListener("popstate", () => {
  if (skipPop) { skipPop = false; return; }
  guard = false;
  if (view === "add" && W) { const bk = document.getElementById("wBack"); if (bk) return bk.click(); W = null; return go("home"); }
  if (view !== "home") return go("home");
  if (openId) { openId = null; sheetId = null; }
  render();
});
// Assistent übersteht Neuladen (nur in diesem Tab)
const saveW = () => { try { if (view === "add" && W && !W.busy) sessionStorage.setItem("rb_w", JSON.stringify(W)); else sessionStorage.removeItem("rb_w"); } catch {} };

// ---------- Darstellung ----------
let openId = null, sheetId = null, openLeg = null, flash = "";
function render() { render0(); syncHistory(); saveW(); }
const flashBox = () => { if (!flash) return ""; const f = flash; flash = ""; return `<div class="banner ok small" role="status">${esc(f)}</div>`; };
function render0() {
  if (view === "add") { if (!W) startWizard(); return renderWizard(); }
  if (view === "settings") return renderSettings();
  const active = trips.filter(t => t.active !== false);
  if (openId && !active.some(t => t.id === openId)) openId = null;
  if (!openId && active.length === 1) openId = active[0].id;
  if (openId) return renderTrip(active.find(t => t.id === openId), active.length > 1);
  renderList(active);
}

const KICKER = { OK: "Alles im Plan", WATCH: "Knapp", RISK: "Achtung", LOST: "Handeln", DONE: "Angekommen" };
const listState = t => (t.status === "WATCH" && !t.transfers.some(x => x.status === "WATCH") && t.finalDelay >= 3 ? `${t.finalDelay} Min. später` : KICKER[t.status] || "");
const heroKicker = t => (t.phase === "before" ? "Vor der Abfahrt" : t.phase === "done" ? "Reise beendet" : "Unterwegs");
const day = iso => new Date(iso).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "Europe/Berlin" });
const inMin = iso => { const m = Math.round((Date.parse(iso) - Date.now()) / MIN); return m <= 0 ? "jetzt" : m < 60 ? `in ${m} Min.` : `in ${Math.floor(m / 60)} Std. ${m % 60} Min.`; };
const lateTag = d => (d >= 1 ? ` <span class="late" title="${d} Min. später">+${d}</span>` : "");
// Im großen „nächster Schritt“: neue Zeit groß, darunter in Worten „13 Min. später, geplant 22:10“
const lateLine = (d, plan) => (d >= 1 ? `<div class="small"><span class="late">${d} Min. später</span> <span class="muted">· geplant ${hm(plan)}</span></div>` : "");
const gl = p => (p ? `<span class="gl">Gleis ${esc(p)}</span>` : "");
const route = t => `${esc(t.legs[0].dep.name)} → ${esc(t.legs[t.legs.length - 1].arr.name)}`;

// Liste bei mehreren Reisen
function renderList(active) {
  if (!active.length) {
    $app.innerHTML = `<h1>Bahnfahren ohne Stress</h1>
      <p class="muted">Lege deine Reise an. Ich prüfe unterwegs Verspätungen, Gleise und Anschlüsse und melde mich nur, wenn du etwas tun solltest.</p>
      <p class="muted">Wird ein Umstieg knapp, siehst du sofort deinen Plan neben den Möglichkeiten – sitzen bleiben, einen Zug früher oder später – und wann du jeweils ankommst.</p>
      <button class="btn" data-go="add">Reise hinzufügen</button>${pushCard()}`;
    return bindCommon();
  }
  $app.innerHTML = `${flashBox()}<h1>Deine Reisen</h1>
    <ul class="trips">${active.map(t => `<li><button data-open="${t.id}">
      <span class="sdot d-${t.status}"></span>
      <span class="tr-main"><b>${route(t)}</b><span class="muted small">${day(t.legs[0].dep.plan)} · ${hm(t.legs[0].dep.rt)} – ${hm(t.legs[t.legs.length - 1].arr.rt)}</span></span>
      <span class="tr-state small">${esc(listState(t))}</span></button></li>`).join("")}</ul>
    <button class="btn sec" data-go="add">Reise hinzufügen</button>${pushCard()}`;
  $app.querySelectorAll("[data-open]").forEach(b => b.onclick = () => { openId = b.dataset.open; openLeg = null; render(); scrollTo(0, 0); });
  bindCommon();
}

// Der nächste Schritt – groß und eindeutig
function nextCard(n) {
  if (!n) return "";
  if (n.kind === "lost") return `<section class="card next"><div class="k">${n.cancelled ? "Anschluss fällt aus" : "Anschluss verpasst"}</div>
      <div><b>${esc(n.label)}</b> ${n.cancelled ? "fällt aus" : "ist schon weg"}. Bleib in <b>${esc(n.station)}</b> – oben siehst du, wie du weiterkommst.</div></section>`;
  const head = { board: "Einsteigen", change: "Umsteigen", "ride-change": n.then?.lost ? "Nächster Halt" : "Nächster Halt: umsteigen", "ride-arrive": "Ankunft" }[n.kind];
  const pc = n.platformChanged ? ` <span class="late">Gleiswechsel</span>` : "";
  let body;
  if (n.kind === "board" || n.kind === "change") body = `<div class="big">${hm(n.at)} ${gl(n.platform)}${pc}</div>${lateLine(n.delay, n.plan)}
      <div><b>${esc(/^\d/.test(n.label) && n.mode && MODE[n.mode] ? `${MODE[n.mode][0]} ${n.label}` : n.label)}</b> ab ${esc(n.station)}${n.dest ? ` <span class="muted">→ ${esc(n.dest)}</span>` : ""}</div>
      <div class="muted small">${n.cancelled ? `<span class="late">fällt aus</span>` : inMin(n.at)}</div>
      ${n.from && cleanStop(n.from.name) !== cleanStop(n.station) ? `<div class="walk-box">Zu Fuß von ${esc(cleanStop(n.from.name))} zu ${esc(cleanStop(n.station))} ${walkBtn(n.from, { name: n.station, lat: n.lat, lon: n.lon })}</div>` : ""}`;
  else body = `<div class="big">${hm(n.at)} ${gl(n.platform)}</div>${lateLine(n.delay, n.plan)}
      <div>${n.kind === "ride-change" ? "Aussteigen in" : "Ankunft in"} <b>${esc(n.station)}</b></div>
      ${n.then && n.then.station && cleanStop(n.then.station) !== cleanStop(n.station) ? `<div class="walk-box">Danach zu Fuß zu ${esc(cleanStop(n.then.station))} ${walkBtn({ name: n.station, lat: n.lat, lon: n.lon }, { name: n.then.station, lat: n.then.lat, lon: n.then.lon })}</div>` : ""}
      ${n.then ? (n.then.lost ? `<div class="small"><span class="late">Anschluss ${esc(n.then.label)} ${n.then.cancelled ? "fällt aus" : "nicht zu schaffen"}</span></div>`
        : `<div class="then">Dann <b>${esc(n.then.label)}</b> um ${hm(n.then.at)}${n.then.platform ? `, Gleis ${esc(n.then.platform)}` : ""}${n.then.platformChanged ? ` <span class="late">Gleiswechsel (statt ${esc(n.then.platformPlan)})</span>` : ""} · ${Math.max(0, n.then.gap)} Min. Zeit</div>`) : `<div class="muted small">${inMin(n.at)}</div>`}`;
  return `<section class="card next"><div class="k">${head}</div>${body}</section>`;
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
  const tr = t.transfers[k], lost = tr.status === "LOST", need = t.minT || 3;
  const before = Date.now() < Date.parse(t.legs[0].dep.rt), curLeg = before ? t.legs[0] : t.legs[k];
  const curArr = Date.parse(t.plan.arr);
  const tone = g => (g < need ? "late" : g < need + 3 ? "warn-t" : "ok-t");
  const point = p => p ? `<div class="cmp-point">${esc(p.at)}: an <b>${hm(p.arr)}</b> → weiter <b>${hm(p.dep)}</b> · <span class="${tone(p.gap)}"><b>${p.gap} Min.</b></span></div>`
    : `<div class="cmp-point">ohne Umstieg</div>`;
  const goal = (arr, d) => `<div class="cmp-goal">Ziel <b>${hm(arr)}</b>${d}</div>`;
  const delta = a => { const d = Math.round((Date.parse(a.arr) - curArr) / MIN); return lost ? "" : d < -1 ? ` · <b class="ok-t">${-d} Min. früher</b>` : d > 1 ? ` · ${d} Min. später` : " · gleich"; };
  const firstPlan = Date.parse(t.legs[0].dep.plan);
  const tag = a => a.from === "start" && Date.parse(a.depPlan || a.dep) < firstPlan - MIN && a.kind !== "later" ? "Früher los" : a.kind === "stay" || (a.legs?.length === 1 && a.label === curLeg.label) ? (a.from === "start" ? "Ohne Umstieg" : "Sitzen bleiben") : ({ safer: "Sicherer", faster: "Schneller", later: "Später", must: "Rechtzeitig" }[a.kind] || "Möglichkeit");
  // Dein Plan: der knappste offene Umstieg mit Echtzeit
  const cur = t.transfers.filter(x => x.status !== "DONE").sort((a, b) => a.gap - b.gap)[0];
  const curNext = t.legs.find(l => Date.parse(l.dep.rt) > Date.now() - MIN) || t.legs[0];
  const curState = curNext.dep.cancelled ? `<span class="badge bad">fällt aus</span>` : curNext.dep.delay >= 3 ? `<span class="badge warn">${esc(nice(curNext))} +${curNext.dep.delay}</span>` : curNext.live ? `<span class="badge good">pünktlich</span>` : "";
  const curRow = lost ? "" : `<div class="cmp-row cur"><div class="cmp-tag">Dein Plan</div><div class="cmp-main">
      ${cur ? point({ at: cur.at, arr: cur.arrRt, dep: cur.depRt, gap: cur.gap }) : point(null)}${goal(t.plan.arr, "")}${curState ? `<div class="cmp-live">${curState}</div>` : ""}</div></div>`;
  // Live-Zustand einer Möglichkeit (wird ab 3 Std. vor Abfahrt mitbeobachtet)
  const liveOf = a => { const w = a.watch;
    if (!w) return `<span class="muted small">wird ab 3 Std. vorher live geprüft</span>`;
    if (w.cancelled) return `<span class="badge bad">fällt aus</span>`;
    if (!w.ok) return `<span class="badge bad">Umstieg geht nicht mehr</span>`;
    const late = w.legs.filter(l => l.delay >= 3);
    return late.length ? late.map(l => `<span class="badge warn">${esc(l.label)} +${l.delay}</span>`).join(" ") : `<span class="badge ${w.live ? "good" : ""}">${w.live ? "pünktlich" : "nur Fahrplan"}</span>`; };
  const rows = tr.alt.map((a, ai) => {
    const id = `${t.id}:${k}:${ai}`, isOpen = openCmp === id;
    return `<div class="cmp-row"><div class="cmp-tag">${tag(a)}</div><div class="cmp-main">
      ${a.reach ? `<div class="cmp-point"><b class="ok-t">${esc(a.reach)}</b></div>` : point(a.watch?.point || tightest(a.legs || []))}
      ${goal(a.arr || a.dep, a.reach ? "" : delta(a))}
      <div class="cmp-live">${a.kind === "stay" ? "" : `<span class="small muted">ab ${hm(a.dep)}${a.depPl ? `, Gleis ${esc(a.depPl)}` : ""} · </span>`}${liveOf(a)}</div>
      ${isOpen ? `<div class="small muted cmp-more">Abfahrt ${hm(a.dep)} in ${esc(a.at)}${a.depPl ? `, Gleis ${esc(a.depPl)}` : ""}<br>${esc(a.label)}</div>` : ""}
      <div class="row cmp-act"><button class="btn sec small-btn" data-adopt="${t.id}|${k}|${ai}" data-adopt-text="${esc(tag(a))}: ${esc(a.label)}, Ziel ca. ${hm(a.arr || a.dep)}">Übernehmen</button>
        <button class="btn quiet small-btn" data-cmp="${id}">${isOpen ? "Weniger" : "Details"}</button></div>
    </div></div>`; }).join("");
  const zb = t.ticket === "spar" && !t.zbLifted ? `<p class="small zb-warn"><b>Sparpreis:</b> Er gilt nur für deine gebuchten Züge. Einen anderen Zug darfst du erst nehmen, wenn die Zugbindung aufgehoben ist – sonst kann ein neues Ticket fällig werden.</p>` : "";
  if (calm) {
    // Plan ist knapp, aber gerade in Ordnung: ruhig zeigen, dass es Ausweichmöglichkeiten gibt
    const n = tr.alt.length, good = tr.alt.filter(a => a.watch?.ok && !a.watch.legs.some(l => l.delay >= 3)).length, open = openCmp === `calm:${t.id}`;
    const sum = tr.alt.some(a => a.watch) ? `${n} Ausweichmöglichkeit${n > 1 ? "en" : ""} im Blick – ${good === n ? (n > 1 ? "alle pünktlich" : "pünktlich") : `${good} davon pünktlich`}.` : `${n} Ausweichmöglichkeit${n > 1 ? "en" : ""} gefunden. Ich prüfe sie ab 3 Std. vor der Abfahrt live mit.`;
    return `<section class="card calm"><div class="k">Falls es knapp wird</div><p class="small" style="margin:0">Dein Umstieg in ${esc(cleanStop(tr.at))} ist mit ${tr.planGap} Min. knapp geplant. ${esc(sum)}</p>
      ${open ? `${zb}${curRow}${rows}` : ""}<button class="btn quiet small-btn" data-cmp="calm:${t.id}">${open ? "Weniger" : "Möglichkeiten zeigen"}</button></section>`;
  }
  return `<section class="card planb"><div class="k">${lost ? "So kommst du jetzt weiter" : "Vergleich"}</div>${zb}${curRow}${rows}</section>`;
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
const kindWord = l => (MODE[l.mode] ? (MODE[l.mode][1] === "U-Bahn" ? "Diese U-Bahn" : MODE[l.mode][1] === "Tram" ? "Diese Tram" : MODE[l.mode][1] === "Fähre" ? "Diese Fähre" : "Diesen Bus") : "Diesen Zug");

// Kompakter Verlauf: eine Zeile pro Zug, Umstiege als schmale Zeile, Details auf Antippen
function timeline(t) {
  const rows = [];
  t.legs.forEach((l, i) => {
    const past = Date.parse(l.arr.rt) < Date.now(), open = openLeg === `${t.id}:${i}`;
    rows.push(`<li class="leg-row ${past ? "past" : ""}"><button data-leg="${t.id}:${i}" aria-expanded="${open}">
      <span class="tm">${hm(l.dep.rt)}${lateTag(l.dep.delay)}<br><span class="muted">${hm(l.arr.rt)}${lateTag(l.arr.delay)}</span></span>
      <span class="ln"><span class="chip-t">${esc(nice(l))}</span>${l.must ? ` <span class="must">Pflichtzug</span>` : ""}${l.live ? "" : ` <span class="muted small">ohne Live-Daten</span>`}${l.dep.cancelled || l.arr.cancelled ? ` <span class="late">fällt aus</span>` : ""}<br>
        <span class="small">${esc(l.dep.name)} → ${esc(l.arr.name)}</span></span>
      <span class="pl small">${l.dep.platform ? `Gleis ${esc(l.dep.platform)}` : ""}</span></button>
      ${open ? `<div class="detail small">
        <div>Ab ${esc(l.dep.name)}: plan ${hm(l.dep.plan)}${l.dep.delay ? `, jetzt ${hm(l.dep.rt)}` : ""}${l.dep.platform ? `, Gleis ${esc(l.dep.platform)}` : ""}${l.dep.platformPlan && l.dep.platform !== l.dep.platformPlan ? ` (statt ${esc(l.dep.platformPlan)})` : ""}</div>
        <div>An ${esc(l.arr.name)}: plan ${hm(l.arr.plan)}${l.arr.delay ? `, jetzt ${hm(l.arr.rt)}${l.arr.estimated ? " (geschätzt)" : ""}` : ""}${l.arr.platform ? `, Gleis ${esc(l.arr.platform)}` : ""}</div>
        ${[...(l.dep.messages || []), ...(l.arr.messages || [])].slice(0, 3).map(m => `<div class="muted">${esc(m)}</div>`).join("")}
        ${l.live ? "" : `<div class="muted">Für dieses Verkehrsmittel gibt es noch keine Echtzeit.</div>`}
        ${t.legs.length > 1 ? `<button class="chip" style="margin-top:8px" data-must="${t.id}|${l.must ? "" : i}">${l.must ? "Nicht mehr Pflicht" : `${kindWord(l)} muss ich bekommen`}</button>` : ""}
      </div>` : ""}</li>`);
    const tr = t.transfers[i];
    if (tr) { const nx = t.legs[i + 1], walk = cleanStop(l.arr.name) !== cleanStop(nx.dep.name);
      rows.push(`<li class="xfer"><span class="sdot d-${tr.status === "DONE" ? "OK" : tr.status}"></span>
      <span class="small">Umstieg ${esc(cleanStop(l.arr.name))}${walk ? ` → ${esc(cleanStop(nx.dep.name))} (Fußweg)` : ""} · ${transferText(tr)}</span>
      ${walk && tr.status !== "DONE" ? walkBtn(l.arr, nx.dep) : ""}</li>`); }
  });
  return `<ol class="tl2">${rows.join("")}</ol>`;
}

function transferText(tr) {
  const pl = tr.arrPl && tr.depPl ? ` · Gleis ${esc(tr.arrPl)} → ${esc(tr.depPl)}` : tr.depPl ? ` · weiter von Gleis ${esc(tr.depPl)}` : "";
  if (tr.status === "DONE") return `erledigt`;
  if (tr.status === "LOST") return tr.reason === "cancel" ? `<b>Anschluss fällt aus</b>` : `<b>nicht zu schaffen</b>${pl}`;
  if (tr.toMust && (tr.status === "RISK" || tr.status === "LOST")) return `<b>Pflichtzug in Gefahr:</b> ${tr.gap >= 0 ? `${tr.gap} Min.` : `Ankunft ${-tr.gap} Min. nach Abfahrt`}${pl}`;
  if (tr.status === "RISK" && tr.own && tr.gap >= 0 && tr.gap < tr.own) return `<b>${tr.gap} Min., zu knapp für dich</b>${pl}`;
  if (tr.status === "RISK") return tr.gap < 0 ? `<b>Ankunft ${-tr.gap} Min. nach Abfahrt</b>${pl}` : `<b>nur ${tr.gap} Min.</b>${pl}`;
  if (tr.status === "WATCH") return `<b>${tr.gap} Min., knapp</b>${pl}`;
  return `${tr.gap} Min.${pl}`;
}

function renderTrip(t, many) {
  const checked = t.legs.flatMap(l => [l.dep.checked, l.arr.checked]).filter(Boolean), fresh = checked.length ? Math.max(...checked) : null;
  const noLive = t.legs.every(l => !l.dep.live && !l.arr.live);
  const sheet = sheetId === t.id;
  $app.innerHTML = `${flashBox()}
    ${many ? `<button class="back" data-list>← Alle Reisen</button>` : ""}
    <div class="trip-head"><h1>${route(t)}</h1><p class="muted small">${day(t.legs[0].dep.plan)} · ${hm(t.legs[0].dep.rt)} – ${hm(t.legs[t.legs.length - 1].arr.rt)}${t.legs.length > 1 ? ` · ${t.legs.length - 1} Umstieg${t.legs.length > 2 ? "e" : ""}` : ""}</p></div>
    <section class="hero s-${t.status}"><div class="k">${heroKicker(t)}</div><h2>${esc(t.title)}</h2>
      ${t.status === "OK" || t.status === "DONE" ? "" : `<p>${esc(t.sub.replace(/ (Plan B|Vorschlag):.*$/, "").replace(" Ich behalte das im Blick.", ""))}</p>`}</section>
    ${t.canUndo ? `<div class="banner info small row" style="align-items:center"><span style="flex:3">Du hast eine andere Verbindung übernommen.${t.ticket === "spar" && !t.zbLifted ? " Achtung: Dein Sparpreis gilt nur für die gebuchten Züge, solange die Zugbindung nicht aufgehoben ist." : ""}</span><button class="chip" data-undo="${t.id}" style="flex:0 0 auto">Rückgängig</button></div>` : ""}
    ${t.status === "WATCH" || t.status === "OK" ? nextCard(t.next) + planBCard(t) : planBCard(t) + nextCard(t.next)}
    ${t.zbLifted ? `<div class="banner"><b>Zugbindung voraussichtlich aufgehoben.</b> Du darfst nach den DB-Regeln einen anderen Zug nehmen. <a href="https://www.bahn.de/faq/zugbindung-aufgehoben-bedeutung" target="_blank" rel="noopener">Regeln</a></div>` : ""}
    <h3 class="sec-h">Verlauf</h3>
    <div class="card flat">${timeline(t)}</div>
    <p class="foot">${fresh ? `Geprüft um ${hm(fresh)}` : "Noch nicht geprüft"}${noLive ? " · noch keine DB-Prognose" : ""} · ohne Gewähr</p>
    <button class="btn quiet" data-sheet="${t.id}">${sheet ? "Einstellungen schließen" : "Einstellungen dieser Reise"}</button>
    ${sheet ? `<section class="card">
      <p class="small muted">Zeit, die ich mindestens zum Umsteigen brauche</p>
      <div class="chips">${MINT_OPTS.map(([m, l]) => `<button class="chip" data-tmt="${m}" aria-pressed="${(t.minT || 0) === m}">${l}</button>`).join("")}</div>
      <p class="small muted">Ticket (nur für den Hinweis zur Zugbindung)</p>
      <div class="chips">${[["spar", "Sparpreis"], ["flex", "Flexpreis"], ["dticket", "Deutschlandticket"], ["bc100", "BahnCard 100"]].map(([k, l]) => `<button class="chip" data-tk="${k}" aria-pressed="${t.ticket === k}">${l}</button>`).join("")}</div>
      <button class="btn quiet" data-del="${t.id}">Reise beenden</button></section>` : ""}
    ${pushCard()}
    <button class="btn sec" data-go="add">Weitere Reise hinzufügen</button>`;
  $app.querySelector("[data-list]")?.addEventListener("click", () => { openId = null; sheetId = null; render(); scrollTo(0, 0); });
  $app.querySelectorAll("[data-cmp]").forEach(b => b.onclick = () => { openCmp = openCmp === b.dataset.cmp ? null : b.dataset.cmp; render(); });
  $app.querySelectorAll("[data-leg]").forEach(b => b.onclick = () => { openLeg = openLeg === b.dataset.leg ? null : b.dataset.leg; render(); });
  $app.querySelector("[data-sheet]").onclick = () => { sheetId = sheet ? null : t.id; render(); };
  const patch = async body => { await api(`/api/trips/${t.id}`, { method: "PATCH", body }).catch(e => alert(e.message)); await loadTrips().catch(() => {}); render(); };
  $app.querySelectorAll("[data-tmt]").forEach(b => b.onclick = () => patch({ minT: +b.dataset.tmt }));   // nur diese Reise
  $app.querySelectorAll("[data-tk]").forEach(b => b.onclick = () => patch({ ticket: b.dataset.tk }));
  $app.querySelectorAll("[data-must]").forEach(b => b.onclick = e => { e.stopPropagation(); const v = b.dataset.must.split("|")[1]; patch({ mustLeg: v === "" ? null : +v }); });
  bindCommon();
}

function renderSettings() {
  const perm = "Notification" in window ? Notification.permission : "nicht unterstützt";
  const on = perm === "granted" && localStorage.getItem("rb_push") === "1";
  $app.innerHTML = `<button class="back" data-go="home">← Zurück</button><h1>Einstellungen</h1>
    <section class="card"><div class="k">Darstellung</div>
      <div class="chips">${[["auto", "Automatisch"], ["light", "Hell"], ["dark", "Dunkel"]].map(([k, l]) => `<button class="chip" data-theme-set="${k}" aria-pressed="${THEME === k}">${l}</button>`).join("")}</div>
      <p class="small muted">Automatisch folgt der Einstellung deines Handys.</p></section>
    <section class="card"><div class="k">Meine übliche Umstiegszeit</div>${minTChips()}
      <p class="small muted">Gilt für neue Reisen. Bei einer Reise änderst du sie unter „Einstellungen dieser Reise“.</p></section>
    <section class="card"><div class="k">Mitteilungen</div>
      <p class="small">${on ? "Eingeschaltet auf diesem Gerät." : perm === "denied" ? "Im Browser blockiert." : "Noch nicht eingeschaltet."}</p>
      ${on ? `<button class="btn sec" id="pushTest">Test-Mitteilung senden</button>` : perm === "denied" ? "" : `<button class="btn" id="pushOn">Mitteilungen erlauben</button>`}
      ${isIOS && !standalone ? `<p class="small muted">iPhone: erst „Teilen“ → „Zum Home-Bildschirm“, dann von dort öffnen.</p>` : ""}</section>
    <p class="foot">Echtzeitdaten: DB InfraGO (OpenBoards) · Verbindungen: Transitous/MOTIS · Angaben ohne Gewähr</p>`;
  $app.querySelectorAll("[data-theme-set]").forEach(b => b.onclick = () => { THEME = b.dataset.themeSet; try { localStorage.setItem("rb_theme", THEME); } catch {} applyTheme(); render(); });
  $app.querySelectorAll("[data-mt]").forEach(b => b.onclick = () => { setMinT(+b.dataset.mt); render(); });
  document.getElementById("pushTest")?.addEventListener("click", () => api("/api/push/test", { method: "POST" }).then(r => alert(r.ok ? "Gesendet – kommt gleich an." : "Konnte nicht gesendet werden.")).catch(e => alert(e.message)));
  bindCommon();
}

function pushCard() {
  if (!("serviceWorker" in navigator)) return "";
  const perm = "Notification" in window ? Notification.permission : "default";
  if (perm === "granted" && localStorage.getItem("rb_push") === "1") return "";
  if (isIOS && !standalone) return `<div class="banner info small"><b>Für Meldungen unterwegs:</b> In Safari „Teilen“ → „Zum Home-Bildschirm“, dann von dort öffnen.</div>`;
  if (perm === "denied") return `<div class="banner info small">Mitteilungen sind blockiert. Du kannst sie in den Browser-Einstellungen erlauben.</div>`;
  return `<div class="banner info small row" style="align-items:center"><span style="flex:3">Melde mich, wenn du etwas tun solltest.</span><button class="chip" id="pushOn" style="flex:0 0 auto">Mitteilungen an</button></div>`;
}

function bindCommon() {
  $app.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    if (!confirm("Reise beenden und nicht mehr überwachen?")) return;
    await api(`/api/trips/${b.dataset.del}`, { method: "DELETE" }).catch(e => alert(e.message));
    openId = null; sheetId = null; await loadTrips().catch(() => {}); render();
  });
  $app.querySelectorAll("[data-adopt]").forEach(b => b.onclick = async () => {
    const [id, k, idx] = b.dataset.adopt.split("|"), t = trips.find(x => x.id === id);
    const zbWarn = t && t.ticket === "spar" && !t.zbLifted ? "\n\nAchtung Sparpreis: Die Zugbindung ist noch nicht aufgehoben. Mit einem anderen Zug kann ein neues Ticket fällig werden." : "";
    if (!confirm(`Diese Verbindung übernehmen?\n\n${b.dataset.adoptText}${zbWarn}\n\nIch überwache dann die neue Verbindung. Du kannst das rückgängig machen.`)) return;
    b.disabled = true; b.textContent = "Wird umgestellt …";
    await api(`/api/trips/${id}/adopt`, { method: "POST", body: { k: +k, idx: +idx } }).catch(e => alert(e.message));
    await loadTrips().catch(() => {}); render();
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
function startWizard() { W = { step: "route", mode: "route", legs: [], station: null, from: Date.now(), list: null, rFrom: null, rTo: null, when: Date.now(), conns: null }; }
const dur = m => (m >= 60 ? `${Math.floor(m / 60)} Std. ${m % 60} Min.` : `${m} Min.`);
const localInput = ms => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60e3); return d.toISOString().slice(0, 16); };

function stationField(id, label, val) {
  return val
    ? `<p class="small muted" style="margin:14px 0 4px">${label}</p><div class="row" style="align-items:center"><b style="flex:4">${esc(val.name)}</b><button class="chip" data-clear="${id}" style="flex:0 0 auto">ändern</button></div>`
    : `<p class="small muted" style="margin:14px 0 4px">${label}</p><input type="search" id="${id}" placeholder="Bahnhof" autocomplete="off" enterkeyhint="search" value="${esc(W?.typed?.[id] || "")}"><ul class="list" id="${id}Res"></ul>`;
}

function connList(list) {
  if (!list.length) return `<p class="muted">Keine Verbindung gefunden. Probier eine andere Zeit.</p>`;
  return `<ul class="list">${list.map((c, i) => {
    const late = Math.round((Date.parse(c.legs[0].from.rt || c.dep) - Date.parse(c.legs[0].from.plan)) / MIN);
    return `<li><button data-c="${i}"><div class="train" style="grid-template-columns:1fr auto">
      <span class="t">${hm(c.legs[0].from.rt || c.legs[0].from.plan)}${late >= 1 ? ` <span class="late">+${late}</span>` : ""} → ${hm(c.legs[c.legs.length - 1].to.rt || c.legs[c.legs.length - 1].to.plan)}</span>
      <span class="pl">${dur(c.minutes)}</span>
      <span class="d" style="grid-column:1/3">${c.transfers ? `${c.transfers} Umstieg${c.transfers > 1 ? "e" : ""} · ` : "direkt · "}${c.legs.map(l => esc(l.label)).join(" → ")}${c.legs.some(l => l.cancelled) ? ` <span class="late">Ausfall</span>` : ""}</span>
    </div></button></li>`; }).join("")}</ul>`;
}

function renderWizard() {
  if (!W) startWizard();
  const n = W.legs.length, head = `<p class="steps">${n ? `Teilstrecke ${n + 1}` : "Neue Reise"}</p>`;
  const back = `<button class="btn quiet" id="wBack">Zurück</button>`;
  if (W.busy) { $app.innerHTML = `${head}<h1>${esc(W.busy)}</h1><div class="spinner"></div>`; return; }
  const err = W.error ? `<p class="err">${esc(W.error)}</p>` : "";

  if (W.step === "route") {
    const chips = [[0, "Jetzt"], [30, "+30 Min."], [60, "+1 Std."], [120, "+2 Std."]];
    $app.innerHTML = `<p class="steps">Neue Reise</p>
      <section class="card import">
        <div class="k">Schnell: Reise einfügen</div>
        <p class="small muted" style="margin-top:0">Screenshot aus dem DB Navigator, Ticket-PDF oder geteilter Text – ich lese die Züge selbst heraus.</p>
        <div class="row"><label class="btn" style="margin:4px 0">Foto, Screenshot oder PDF<input type="file" id="impFile" accept="image/*,application/pdf" multiple hidden></label>
          <button class="btn sec" id="impTextBtn" style="margin:4px 0">Text einfügen</button></div>
        ${W.showText ? `<textarea id="impText" rows="5" placeholder="Hier den geteilten Text oder die Buchungsbestätigung einfügen">${esc(W.impText || "")}</textarea>
          <div class="row"><button class="btn sec" id="impPaste" style="margin:4px 0">Aus Zwischenablage</button><button class="btn" id="impGo" style="margin:4px 0">Einlesen</button></div>` : ""}
      </section>
      <h1 style="margin-top:22px">Oder: Wohin geht es?</h1>
      ${stationField("rf", "Von", W.rFrom)}${stationField("rt", "Nach", W.rTo)}
      <p class="small muted" style="margin:14px 0 4px">Abfahrt</p>
      <div class="chips">${chips.map(([m, l]) => `<button class="chip" data-w="${m}" aria-pressed="${Math.abs(W.when - (Date.now() + m * MIN)) < 2 * MIN}">${l}</button>`).join("")}</div>
      <input type="datetime-local" id="whenIn" value="${localInput(W.when)}">
      <p class="small muted" style="margin:14px 0 4px">Zeit, die ich mindestens zum Umsteigen brauche</p>${minTChips()}
      ${err}<button class="btn" id="go" ${W.rFrom && W.rTo ? "" : "disabled"}>Verbindungen suchen</button>
      <button class="btn quiet" id="byTrain">Zug direkt aus der Abfahrtstafel wählen</button>${back}`;
    for (const [id, k] of [["rf", "rFrom"], ["rt", "rTo"]]) {
      const inp = document.getElementById(id); if (!inp) continue; let t;
      const find = () => searchInto(inp.value, `${id}Res`, st => { W[k] = st; if (W.typed) delete W.typed[id]; render(); });
      inp.oninput = () => { (W.typed ||= {})[id] = inp.value; saveW(); clearTimeout(t); t = setTimeout(find, 250); };
      if (inp.value.trim().length >= 2) find();          // nach dem Neuzeichnen die Treffer wieder zeigen
    }
    $app.querySelectorAll("[data-clear]").forEach(b => b.onclick = () => { W[b.dataset.clear === "rf" ? "rFrom" : "rTo"] = null; render(); });
    $app.querySelectorAll("[data-w]").forEach(b => b.onclick = () => { W.when = Date.now() + +b.dataset.w * MIN; render(); });
    $app.querySelectorAll("[data-mt]").forEach(b => b.onclick = () => { setMinT(+b.dataset.mt); render(); });
    document.getElementById("whenIn").onchange = e => { const v = Date.parse(e.target.value); if (v) W.when = v; };
    document.getElementById("go").onclick = () => { W.conns = null; W.error = ""; W.step = "conns"; render(); };
    document.getElementById("byTrain").onclick = () => { W.mode = "train"; W.step = "station"; W.error = ""; render(); };
    document.getElementById("impFile").onchange = e => importFiles([...e.target.files]);
    document.getElementById("impTextBtn").onclick = () => { W.showText = !W.showText; render(); };
    const it = document.getElementById("impText"); if (it) it.oninput = () => { W.impText = it.value; };
    const ip = document.getElementById("impPaste");
    if (ip) ip.onclick = async () => { try { W.impText = await navigator.clipboard.readText(); render(); } catch { alert("Einfügen bitte per langem Tippen ins Textfeld."); } };
    const ig = document.getElementById("impGo"); if (ig) ig.onclick = () => runImport({ text: W.impText || "" });
  }

  else if (W.step === "conns") {
    $app.innerHTML = `${head}<h1>${esc(W.rFrom.name)} → ${esc(W.rTo.name)}</h1><p class="muted small">${MINT ? `Umstiege mind. ${MINT} Min. · ` : ""}ab ${new Date(W.when).toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" })}</p>
      ${err}<div>${W.conns ? connList(W.conns) : `<div class="spinner"></div>`}</div>
      ${W.conns?.length ? `<button class="btn sec" id="laterC">Spätere Verbindungen</button>` : ""}${back}`;
    if (!W.conns) api(`/api/connections?from=${W.rFrom.eva}&to=${W.rTo.eva}&min=${MINT}&time=${encodeURIComponent(new Date(W.when).toISOString())}`)
      .then(c => { W.conns = c; W.error = ""; }).catch(e => { W.conns = []; W.error = e.message; }).then(render);
    const lc = document.getElementById("laterC");
    if (lc) lc.onclick = () => { W.when = Date.parse(W.conns[W.conns.length - 1].legs[0].from.plan) + MIN; W.conns = null; render(); };
    $app.querySelectorAll("[data-c]").forEach(b => b.onclick = () => pickConnection(W.conns[+b.dataset.c]));
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
    if (at) at.onclick = () => { W.multi = future.map(t => t.legs); W.legs = W.multi[0]; W.step = "ticket"; render(); };
  }

  else if (W.step === "station") {
    $app.innerHTML = `${head}<h1>Von welchem Bahnhof fährt dein Zug?</h1><p class="small muted">Du wählst danach den Zug aus der Abfahrtstafel und deinen Ausstieg. Weitere Umstiege kannst du anhängen.</p>
      <input type="search" id="q" placeholder="Bahnhof, z. B. Berlin Hbf" autocomplete="off" enterkeyhint="search" value="${esc(W.q || "")}">
      ${err}<ul class="list" id="res"></ul>${back}`;
    const q = document.getElementById("q");
    let t; q.oninput = () => { clearTimeout(t); W.q = q.value; t = setTimeout(() => searchInto(q.value, "res", s => { W.station = s; W.from = Date.now(); W.step = "trains"; W.list = null; render(); }), 250); };
    if (W.q) q.oninput();
  }

  else if (W.step === "trains") {
    const chips = [[0, "Jetzt"], [30, "+30 Min."], [60, "+1 Std."], [120, "+2 Std."]];
    const base = W.legs.length ? Date.parse(W.legs[n - 1].to.plan) : Date.now();
    $app.innerHTML = `${head}<h1>Welcher Zug ab ${esc(W.station.name)}?</h1>
      ${W.legs.length ? `<p class="muted small">Ankunft dort laut Plan ${hm(W.legs[n - 1].to.plan)}.</p>` : `<div class="chips">${chips.map(([m, l]) => `<button class="chip" data-m="${m}" aria-pressed="${Math.abs(W.from - (Date.now() + m * MIN)) < 2 * MIN}">${l}</button>`).join("")}</div>`}
      ${err}<div id="trains">${W.list ? trainList(W.list) : `<div class="spinner"></div>`}</div>
      ${W.list ? `<button class="btn sec" id="later">Spätere Züge</button>` : ""}${back}`;
    $app.querySelectorAll("[data-m]").forEach(b => b.onclick = () => { W.from = Date.now() + +b.dataset.m * MIN; W.list = null; render(); });
    const later = document.getElementById("later");
    if (later) later.onclick = () => { const l = W.list[W.list.length - 1]; W.from = l ? Date.parse(l.rt) + MIN : W.from + 60 * MIN; W.list = null; render(); };
    if (!W.list) {
      const from = W.legs.length ? Math.max(W.from, base) : W.from;
      api(`/api/departures?eva=${W.station.eva}&time=${encodeURIComponent(new Date(from).toISOString())}`)
        .then(l => { W.list = l; W.error = ""; }).catch(e => { W.list = []; W.error = e.message; }).then(render);
    }
    $app.querySelectorAll("[data-j]").forEach(b => b.onclick = () => { W.train = W.list[+b.dataset.j]; W.step = "exit"; render(); });
  }

  else if (W.step === "exit") {
    const tr = W.train, stops = [...tr.via.filter(v => v.name), ...tr.direction.filter(d => d.name && !tr.via.some(v => v.eva === d.eva))];
    $app.innerHTML = `${head}<h1>Wo steigst du aus?</h1><p class="muted">${esc(tr.label)} ab ${hm(tr.rt)}${tr.platform ? `, Gleis ${esc(tr.platform)}` : ""}</p>
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
        <div class="when">${esc(l.label)} · ab ${hm(l.from.plan)}${l.from.platform ? ` Gl. ${esc(l.from.platform)}` : ""} · an ${l.to.estimated ? "≈" : ""}${hm(l.to.plan)}${l.to.platform ? ` Gl. ${esc(l.to.platform)}` : ""}</div>
        ${l.jid ? "" : `<div class="small muted">${l.mode && !/RAIL|SUBURBAN|LONG/.test(l.mode) ? "Bus/U-Bahn/Tram: " : ""}ohne Echtzeit, nur Fahrplan</div>`}</li>`).join("")}</ol></div>
      <button class="btn" id="done">Fertig – weiter</button>
      ${W.mode !== "train" ? "" : `<button class="btn sec" id="more">Umstieg in ${esc(W.legs[n - 1].to.name)} hinzufügen</button>`}
      ${W.mode === "import" ? `<button class="btn quiet" id="undo">Nicht anlegen</button>` : W.mode === "route" ? `<button class="btn quiet" id="undo">Andere Verbindung wählen</button>` : `<button class="btn quiet" id="undo">Letzte Teilstrecke entfernen</button>`}`;
    document.getElementById("done").onclick = () => { W.step = "ticket"; render(); };
    if (document.getElementById("more")) document.getElementById("more").onclick = () => { const l = W.legs[n - 1]; W.station = { eva: l.to.eva, name: l.to.name }; W.from = Date.parse(l.to.plan); W.list = null; W.step = "trains"; render(); };
    document.getElementById("undo").onclick = () => { if (W.mode === "import") { W.legs = []; W.step = W.imported?.length > 1 ? "pickTrip" : "route"; } else if (W.mode === "route") { W.legs = []; W.step = "conns"; } else { W.legs.pop(); W.step = W.legs.length ? "leg" : "station"; } render(); };
    return;
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
    else if (W.step === "ticket") W.step = W.multi ? "pickTrip" : "leg";
    else if (W.step === "leg" && W.mode === "route") { W.legs = []; W.step = "conns"; }
    else if (W.step === "leg" && W.mode === "import") { W.legs = []; W.step = W.imported?.length > 1 ? "pickTrip" : "route"; }
    else if (W.step === "pickTrip") W.step = "route";
    render();
  };
}

function trainList(list) {
  if (!list.length) return `<p class="muted">Keine Abfahrten in diesem Zeitraum gefunden.</p>`;
  return `<ul class="list">${list.map((e, i) => `<li><button data-j="${i}" ${e.cancelled ? "disabled" : ""}><div class="train">
    <span class="t">${hm(e.rt)}</span><span class="l">${esc(e.label)}${e.cancelled ? ` <span class="late">fällt aus</span>` : ""}</span>
    <span class="pl">${e.platform ? `Gleis ${esc(e.platform)}` : ""}</span>
    <span class="d">${e.rt !== e.plan && Date.parse(e.rt) - Date.parse(e.plan) >= MIN ? `<span class="late">+${Math.round((Date.parse(e.rt) - Date.parse(e.plan)) / MIN)}</span> · ` : ""}nach ${esc(e.direction.map(d => d.name).filter(Boolean).join(" / ") || "?")}</span>
  </div></button></li>`).join("")}</ul>`;
}

async function searchInto(q, id, onPick) {
  const el = document.getElementById(id); if (!el) return;
  if (q.trim().length < 2) { el.innerHTML = ""; return; }
  try {
    const res = await api(`/api/stations?q=${encodeURIComponent(q)}`);
    el.innerHTML = res.length ? res.map((s, i) => `<li><button data-i="${i}">${esc(s.name)}</button></li>`).join("") : `<li><p class="muted small">Kein Bahnhof gefunden.</p></li>`;
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
  W.busy = "Reise wird angelegt …"; render();
  try {
    for (const legs of W.multi || [W.legs]) await api("/api/trips", { method: "POST", body: { legs: legs.map(l => ({ ...l, minT: MINT })), ticket } });
    if (W.mode === "import" && !W.multi && W.imported?.length > 1 && W.pickedIdx != null) {
      const done = W.imported[W.pickedIdx];
      W.savedOne = done.label || "Die Fahrt";
      W.imported = W.imported.filter((_, i) => i !== W.pickedIdx);
      W.pickedIdx = null; W.ticketGuess = ticket; W.busy = null; W.step = "pickTrip";
      await loadTrips().catch(() => {}); return render();
    }
    const n = (W.multi || [W.legs]).length;
    flash = n > 1 ? `${n} Reisen angelegt. Ich melde mich, wenn du etwas tun solltest.` : "Reise angelegt. Ich melde mich, wenn du etwas tun solltest.";
    W = null; await loadTrips(); openId = n > 1 ? null : trips[0]?.id || null; go("home");
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
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
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
    startWizard(); view = "add";
    const text = [meta.title, meta.text, meta.url].filter(Boolean).join("\n");
    if (files.length) { W.impText = text; importFiles(files); } else if (text) runImport({ text });
  } catch {}
}
try { const w = JSON.parse(sessionStorage.getItem("rb_w") || "null"); if (w?.step) { W = w; view = "add"; } } catch {}
loadTrips().catch(e => { $app.innerHTML = `<p class="err">${esc(e.message)}</p><button class="btn sec" onclick="location.reload()">Noch einmal versuchen</button>`; throw e; }).then(() => { render(); schedule(); takeShared(); });
