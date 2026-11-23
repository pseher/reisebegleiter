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
async function api(path, { method = "GET", body } = {}, retry = true) {
  if (!AUTH) await register();
  const r = await fetch(path, { method, headers: { Authorization: `Bearer ${AUTH.id}.${AUTH.token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401 && retry) { AUTH = null; return api(path, { method, body }, false); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Fehler ${r.status}`);
  return data;
}

// ---------- Zustand ----------
let trips = [], loadedAt = 0, view = "home", W = null, timer = null;
const go = v => { view = v; render(); scrollTo(0, 0); };
document.addEventListener("click", e => { const b = e.target.closest("[data-go]"); if (b) { if (b.dataset.go === "home") W = null; go(b.dataset.go); } });

async function loadTrips() {
  try { trips = await api("/api/trips"); loadedAt = Date.now(); } catch (e) { if (!trips.length) throw e; }
}
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(async () => { if (view === "home" && document.visibilityState === "visible") { await loadTrips().catch(() => {}); render(); } schedule(); }, 60e3);
}
document.addEventListener("visibilitychange", async () => { if (document.visibilityState === "visible" && view === "home" && Date.now() - loadedAt > 30e3) { await loadTrips().catch(() => {}); render(); } });

// ---------- Darstellung ----------
function render() {
  if (view === "add") return renderWizard();
  renderHome();
}

const KICKER = { OK: "Alles im Plan", WATCH: "Beobachten", RISK: "Achtung", LOST: "Handeln", DONE: "Angekommen" };

function delay(stop) { return stop.delay >= 1 ? ` <span class="late">+${stop.delay}</span>` : ""; }
function when(stop) {
  if (stop.cancelled) return `<span class="strike">${hm(stop.plan)}</span> <span class="late">fällt aus</span>`;
  if (stop.delay >= 1) return `<span class="strike">${hm(stop.plan)}</span> <b>${hm(stop.rt)}</b>${delay(stop)}`;
  return `<b>${hm(stop.rt)}</b>`;
}
function platform(stop) {
  if (!stop.platform) return "";
  if (stop.platformPlan && stop.platform !== stop.platformPlan) return ` · <span class="late">Gleis ${esc(stop.platform)}</span> <span class="strike">${esc(stop.platformPlan)}</span>`;
  return ` · Gleis ${esc(stop.platform)}`;
}

function tripCard(t) {
  const now = Date.now(), legs = t.legs, last = legs[legs.length - 1];
  const items = [];
  legs.forEach((l, i) => {
    if (i === 0) items.push(`<li class="${Date.parse(l.dep.rt) < now ? "past" : ""}"><span class="dot"></span>
      <div class="stop">${esc(l.dep.name)}</div><div class="when">ab ${when(l.dep)}${platform(l.dep)}</div>
      <div class="leg">${esc(l.label)}${l.live ? "" : " · nur Fahrplan"}${l.dep.messages?.length ? ` · ${esc(l.dep.messages[0])}` : ""}</div></li>`);
    const tr = t.transfers[i];
    if (tr) {
      const n = legs[i + 1], alt = tr.alt?.[0];
      items.push(`<li class="${Date.parse(n.dep.rt) < now ? "past" : ""}"><span class="dot"></span>
        <div class="stop">${esc(l.arr.name)} · Umstieg</div>
        <div class="when">an ${when(l.arr)}${platform(l.arr)}</div>
        <div class="when">ab ${when(n.dep)}${platform(n.dep)}</div>
        ${tr.status !== "DONE" ? `<div class="tr s-${tr.status}">${transferText(tr)}${alt ? `<div class="alt"><b>Plan B:</b> ${esc(alt.label)} um ${hm(alt.dep)}${alt.depPl ? `, Gleis ${esc(alt.depPl)}` : ""}${alt.arr ? ` – an ${esc(alt.toName)} ${hm(alt.arr)}` : ""}</div>` : ""}</div>` : ""}
        <div class="leg">${esc(n.label)}${n.live ? "" : " · nur Fahrplan"}</div></li>`);
    }
  });
  items.push(`<li class="${t.phase === "done" ? "past" : ""}"><span class="dot"></span><div class="stop">${esc(last.arr.name)}</div>
    <div class="when">an ${when(last.arr)}${platform(last.arr)}</div></li>`);

  const checked = t.legs.flatMap(l => [l.dep.checked, l.arr.checked]).filter(Boolean);
  const fresh = checked.length ? Math.max(...checked) : null;
  const noLive = t.legs.every(l => !l.dep.live && !l.arr.live);
  return `
    <section class="hero s-${t.status}">
      <div class="k">${KICKER[t.status] || ""}</div>
      <h1>${esc(t.title)}</h1>
      <p>${esc(t.sub)}</p>
    </section>
    ${t.zbLifted ? `<div class="banner"><b>Zugbindung voraussichtlich aufgehoben.</b> Nach den DB-Regeln darfst du einen anderen Zug nehmen. <a href="https://www.bahn.de/faq/zugbindung-aufgehoben-bedeutung" target="_blank" rel="noopener">Regeln der DB</a></div>` : ""}
    <div class="card">
      <ol class="tl">${items.join("")}</ol>
    </div>
    <p class="foot">${fresh ? `Geprüft um ${hm(fresh)}` : "Noch nicht geprüft"}${noLive ? " · noch keine Prognose der DB, Fahrplanzeiten" : ""} · Angaben ohne Gewähr</p>
    <button class="btn quiet" data-del="${t.id}">Reise beenden</button>`;
}

function transferText(tr) {
  const pl = tr.arrPl || tr.depPl ? ` · Gleis ${esc(tr.arrPl || "?")} → ${esc(tr.depPl || "?")}` : "";
  if (tr.status === "LOST") return tr.reason === "cancel" ? `<b>Anschluss fällt aus.</b>` : `<b>Nicht zu schaffen:</b> ${tr.gap} Min.${pl}`;
  if (tr.status === "RISK") return tr.gap < 0 ? `<b>Gefährdet:</b> Ankunft ${-tr.gap} Min. nach der Abfahrt${pl}` : `<b>Gefährdet:</b> ${tr.gap} Min. zum Umsteigen${pl}`;
  if (tr.status === "WATCH") return `<b>Knapp:</b> ${tr.gap} Min. zum Umsteigen${pl}`;
  return `${tr.gap} Min. zum Umsteigen${pl}`;
}

function pushCard() {
  if (!("serviceWorker" in navigator)) return "";
  const perm = "Notification" in window ? Notification.permission : "default";
  if (perm === "granted" && localStorage.getItem("rb_push") === "1") return "";
  if (isIOS && !standalone) return `<div class="banner info"><b>Für Meldungen unterwegs:</b> Tippe in Safari auf „Teilen“ → „Zum Home-Bildschirm“ und öffne den Reisebegleiter von dort. Nur so kann das iPhone dich benachrichtigen.</div>`;
  if (perm === "denied") return `<div class="banner info">Mitteilungen sind für diese Seite blockiert. Du kannst sie in den Browser-Einstellungen wieder erlauben.</div>`;
  return `<div class="card"><b>Mitteilungen einschalten</b><p class="small muted">Nur wenn du etwas tun solltest: Anschluss gefährdet, Gleiswechsel, Ausfall, gleich aussteigen.</p>
    <button class="btn" id="pushOn">Mitteilungen erlauben</button></div>`;
}

function renderHome() {
  if (!trips.length) {
    $app.innerHTML = `
      <h1>Bahnfahren ohne Stress</h1>
      <p class="muted">Lege deine Reise an. Ich prüfe unterwegs Verspätungen, Gleise und Anschlüsse und melde mich nur, wenn du etwas tun solltest.</p>
      <button class="btn" data-go="add">Reise hinzufügen</button>
      ${pushCard()}`;
  } else {
    $app.innerHTML = trips.map(tripCard).join(`<hr style="border:0;border-top:1px solid var(--line);margin:24px 0">`) + pushCard() +
      `<button class="btn sec" data-go="add">Weitere Reise hinzufügen</button>`;
  }
  bindHome();
}
function bindHome() {
  $app.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    if (!confirm("Reise beenden und nicht mehr überwachen?")) return;
    await api(`/api/trips/${b.dataset.del}`, { method: "DELETE" }).catch(e => alert(e.message));
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
    : `<p class="small muted" style="margin:14px 0 4px">${label}</p><input type="search" id="${id}" placeholder="Bahnhof" autocomplete="off" enterkeyhint="search"><ul class="list" id="${id}Res"></ul>`;
}

function connList(list) {
  if (!list.length) return `<p class="muted">Keine Verbindung gefunden. Probier eine andere Zeit.</p>`;
  return `<ul class="list">${list.map((c, i) => {
    const late = Math.round((Date.parse(c.legs[0].from.rt || c.dep) - Date.parse(c.legs[0].from.plan)) / MIN);
    return `<li><button data-c="${i}"><div class="train" style="grid-template-columns:1fr auto">
      <span class="t">${hm(c.legs[0].from.plan)} → ${hm(c.legs[c.legs.length - 1].to.plan)}${late >= 1 ? ` <span class="late">+${late}</span>` : ""}</span>
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
    $app.innerHTML = `<p class="steps">Neue Reise</p><h1>Wohin geht es?</h1>
      ${stationField("rf", "Von", W.rFrom)}${stationField("rt", "Nach", W.rTo)}
      <p class="small muted" style="margin:14px 0 4px">Abfahrt</p>
      <div class="chips">${chips.map(([m, l]) => `<button class="chip" data-w="${m}" aria-pressed="${Math.abs(W.when - (Date.now() + m * MIN)) < 2 * MIN}">${l}</button>`).join("")}</div>
      <input type="datetime-local" id="whenIn" value="${localInput(W.when)}">
      ${err}<button class="btn" id="go" ${W.rFrom && W.rTo ? "" : "disabled"}>Verbindungen suchen</button>
      <button class="btn quiet" id="byTrain">Ich sitze schon im Zug / Zug für Zug anlegen</button>${back}`;
    for (const [id, k] of [["rf", "rFrom"], ["rt", "rTo"]]) {
      const inp = document.getElementById(id); if (!inp) continue; let t;
      inp.oninput = () => { clearTimeout(t); t = setTimeout(() => searchInto(inp.value, `${id}Res`, st => { W[k] = st; render(); }), 250); };
    }
    if (!W.rFrom) document.getElementById("rf")?.focus(); else if (!W.rTo) document.getElementById("rt")?.focus();
    $app.querySelectorAll("[data-clear]").forEach(b => b.onclick = () => { W[b.dataset.clear === "rf" ? "rFrom" : "rTo"] = null; render(); });
    $app.querySelectorAll("[data-w]").forEach(b => b.onclick = () => { W.when = Date.now() + +b.dataset.w * MIN; render(); });
    document.getElementById("whenIn").onchange = e => { const v = Date.parse(e.target.value); if (v) W.when = v; };
    document.getElementById("go").onclick = () => { W.conns = null; W.error = ""; W.step = "conns"; render(); };
    document.getElementById("byTrain").onclick = () => { W.mode = "train"; W.step = "station"; W.error = ""; render(); };
  }

  else if (W.step === "conns") {
    $app.innerHTML = `${head}<h1>${esc(W.rFrom.name)} → ${esc(W.rTo.name)}</h1><p class="muted small">ab ${new Date(W.when).toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" })}</p>
      ${err}<div>${W.conns ? connList(W.conns) : `<div class="spinner"></div>`}</div>
      ${W.conns?.length ? `<button class="btn sec" id="laterC">Spätere Verbindungen</button>` : ""}${back}`;
    if (!W.conns) api(`/api/connections?from=${W.rFrom.eva}&to=${W.rTo.eva}&time=${encodeURIComponent(new Date(W.when).toISOString())}`)
      .then(c => { W.conns = c; W.error = ""; }).catch(e => { W.conns = []; W.error = e.message; }).then(render);
    const lc = document.getElementById("laterC");
    if (lc) lc.onclick = () => { W.when = Date.parse(W.conns[W.conns.length - 1].legs[0].from.plan) + MIN; W.conns = null; render(); };
    $app.querySelectorAll("[data-c]").forEach(b => b.onclick = () => pickConnection(W.conns[+b.dataset.c]));
  }

  else if (W.step === "station") {
    $app.innerHTML = `${head}<h1>Wo steigst du ein?</h1>
      <input type="search" id="q" placeholder="Bahnhof, z. B. Berlin Hbf" autocomplete="off" enterkeyhint="search" value="${esc(W.q || "")}">
      ${err}<ul class="list" id="res"></ul>${back}`;
    const q = document.getElementById("q"); q.focus();
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
    $app.innerHTML = `${head.replace(/Teilstrecke \d+|Neue Reise/, "Deine Reise")}<h1>Passt das so?</h1>
      <div class="card"><ol class="tl">${W.legs.map(l => `<li><span class="dot"></span><div class="stop">${esc(l.from.name)} → ${esc(l.to.name)}</div>
        <div class="when">${esc(l.label)} · ab ${hm(l.from.plan)}${l.from.platform ? ` Gl. ${esc(l.from.platform)}` : ""} · an ${hm(l.to.plan)}${l.to.platform ? ` Gl. ${esc(l.to.platform)}` : ""}</div>
        ${l.jid ? "" : `<div class="small muted">${l.mode && !/RAIL|SUBURBAN|LONG/.test(l.mode) ? "Bus/U-Bahn/Tram: " : ""}ohne Echtzeit, nur Fahrplan</div>`}</li>`).join("")}</ol></div>
      <button class="btn" id="done">Fertig – weiter</button>
      ${W.mode === "route" ? "" : `<button class="btn sec" id="more">Umstieg in ${esc(W.legs[n - 1].to.name)} hinzufügen</button>`}
      ${W.mode === "route" ? `<button class="btn quiet" id="undo">Andere Verbindung wählen</button>` : `<button class="btn quiet" id="undo">Letzte Teilstrecke entfernen</button>`}`;
    document.getElementById("done").onclick = () => { W.step = "ticket"; render(); };
    if (document.getElementById("more")) document.getElementById("more").onclick = () => { const l = W.legs[n - 1]; W.station = { eva: l.to.eva, name: l.to.name }; W.from = Date.parse(l.to.plan); W.list = null; W.step = "trains"; render(); };
    document.getElementById("undo").onclick = () => { if (W.mode === "route") { W.legs = []; W.step = "conns"; } else { W.legs.pop(); W.step = W.legs.length ? "leg" : "station"; } render(); };
    return;
  }

  else if (W.step === "ticket") {
    const opts = [["spar", "Sparpreis / Super Sparpreis", "Mit Zugbindung – ich sage dir, wann sie voraussichtlich aufgehoben ist."],
      ["flex", "Flexpreis", "Freie Zugwahl auf der Strecke."], ["dticket", "Deutschlandticket", "Nur Nahverkehr."], ["bc100", "BahnCard 100", "Freie Zugwahl."]];
    $app.innerHTML = `<p class="steps">Fast fertig</p><h1>Welches Ticket hast du?</h1><p class="muted small">Nur für den Hinweis zur Zugbindung. Es wird nichts gekauft oder gebucht.</p>
      ${err}<ul class="list">${opts.map(([k, t, d]) => `<li><button data-t="${k}"><b>${t}</b><br><span class="small muted">${d}</span></button></li>`).join("")}</ul>${back}`;
    $app.querySelectorAll("[data-t]").forEach(b => b.onclick = () => saveTrip(b.dataset.t));
  }

  const bk = document.getElementById("wBack");
  if (bk) bk.onclick = () => {
    W.error = "";
    if (W.step === "route") {
    const chips = [[0, "Jetzt"], [30, "+30 Min."], [60, "+1 Std."], [120, "+2 Std."]];
    $app.innerHTML = `<p class="steps">Neue Reise</p><h1>Wohin geht es?</h1>
      ${stationField("rf", "Von", W.rFrom)}${stationField("rt", "Nach", W.rTo)}
      <p class="small muted" style="margin:14px 0 4px">Abfahrt</p>
      <div class="chips">${chips.map(([m, l]) => `<button class="chip" data-w="${m}" aria-pressed="${Math.abs(W.when - (Date.now() + m * MIN)) < 2 * MIN}">${l}</button>`).join("")}</div>
      <input type="datetime-local" id="whenIn" value="${localInput(W.when)}">
      ${err}<button class="btn" id="go" ${W.rFrom && W.rTo ? "" : "disabled"}>Verbindungen suchen</button>
      <button class="btn quiet" id="byTrain">Ich sitze schon im Zug / Zug für Zug anlegen</button>${back}`;
    for (const [id, k] of [["rf", "rFrom"], ["rt", "rTo"]]) {
      const inp = document.getElementById(id); if (!inp) continue; let t;
      inp.oninput = () => { clearTimeout(t); t = setTimeout(() => searchInto(inp.value, `${id}Res`, st => { W[k] = st; render(); }), 250); };
    }
    if (!W.rFrom) document.getElementById("rf")?.focus(); else if (!W.rTo) document.getElementById("rt")?.focus();
    $app.querySelectorAll("[data-clear]").forEach(b => b.onclick = () => { W[b.dataset.clear === "rf" ? "rFrom" : "rTo"] = null; render(); });
    $app.querySelectorAll("[data-w]").forEach(b => b.onclick = () => { W.when = Date.now() + +b.dataset.w * MIN; render(); });
    document.getElementById("whenIn").onchange = e => { const v = Date.parse(e.target.value); if (v) W.when = v; };
    document.getElementById("go").onclick = () => { W.conns = null; W.error = ""; W.step = "conns"; render(); };
    document.getElementById("byTrain").onclick = () => { W.mode = "train"; W.step = "station"; W.error = ""; render(); };
  }

  else if (W.step === "conns") {
    $app.innerHTML = `${head}<h1>${esc(W.rFrom.name)} → ${esc(W.rTo.name)}</h1><p class="muted small">ab ${new Date(W.when).toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" })}</p>
      ${err}<div>${W.conns ? connList(W.conns) : `<div class="spinner"></div>`}</div>
      ${W.conns?.length ? `<button class="btn sec" id="laterC">Spätere Verbindungen</button>` : ""}${back}`;
    if (!W.conns) api(`/api/connections?from=${W.rFrom.eva}&to=${W.rTo.eva}&time=${encodeURIComponent(new Date(W.when).toISOString())}`)
      .then(c => { W.conns = c; W.error = ""; }).catch(e => { W.conns = []; W.error = e.message; }).then(render);
    const lc = document.getElementById("laterC");
    if (lc) lc.onclick = () => { W.when = Date.parse(W.conns[W.conns.length - 1].legs[0].from.plan) + MIN; W.conns = null; render(); };
    $app.querySelectorAll("[data-c]").forEach(b => b.onclick = () => pickConnection(W.conns[+b.dataset.c]));
  }

  else if (W.step === "station") { W = null; go("home"); }
    else if (W.step === "conns") W.step = "route";
    else if (W.step === "trains") W.step = W.legs.length ? "leg" : "station";
    else if (W.step === "exit") W.step = "trains";
    else if (W.step === "ticket") W.step = "leg";
    else if (W.step === "leg" && W.mode === "route") { W.legs = []; W.step = "conns"; }
    render();
  };
}

function trainList(list) {
  if (!list.length) return `<p class="muted">Keine Abfahrten in diesem Zeitraum gefunden.</p>`;
  return `<ul class="list">${list.map((e, i) => `<li><button data-j="${i}" ${e.cancelled ? "disabled" : ""}><div class="train">
    <span class="t">${hm(e.rt)}</span><span class="l">${esc(e.label)}${e.cancelled ? ` <span class="late">fällt aus</span>` : ""}</span>
    <span class="pl">${e.platform ? `Gl. ${esc(e.platform)}` : ""}</span>
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
    await api("/api/trips", { method: "POST", body: { legs: W.legs, ticket } });
    W = null; await loadTrips(); go("home");
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
loadTrips().catch(e => { $app.innerHTML = `<p class="err">${esc(e.message)}</p>`; throw e; }).then(() => { render(); schedule(); });
