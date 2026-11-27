// Hilfe: Fragen in eigenen Worten. Die KI antwortet nur aus dem Text der Hilfeseite (eine Quelle für beides).
// Hat die Antwort nicht geholfen, kann man die Frage an Umstiegsheld schicken (gespeichert + Mail, falls eingerichtet).
import { count } from "./stats.js";

const MODEL = env => env.HELP_MODEL || env.IMPORT_MODEL || "claude-haiku-5-5";
let CTX = null, CTX_AT = 0;

// Text der Hilfeseite ohne HTML (5 Min. gemerkt)
export async function helpText(env, origin) {
  if (CTX && Date.now() - CTX_AT < 5 * 60e3) return CTX;
  const r = await env.ASSETS.fetch(new Request(`${origin}/hilfe.html`)).catch(() => null);
  const html = r?.ok ? await r.text() : "";
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<head[\s\S]*?<\/head>/i, "")
    .replace(/<\/(summary|h2|h3|p|li|details)>/gi, "\n").replace(/<summary>/gi, "\n### ").replace(/<h2[^>]*>/gi, "\n## ").replace(/<li>/gi, "- ")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  CTX = body.slice(0, 40000); CTX_AT = Date.now();
  return CTX;
}

const SYSTEM = `Du bist die Hilfe der App Umstiegsheld (umstiegsheld.de). Die App überwacht Fahrten mit Zug, S-/U-Bahn, Tram und Bus, warnt bei Verspätungen und zeigt Plan B. Sie verkauft keine Tickets.
Beantworte die Frage NUR mit dem Wissen aus dem Hilfetext unten. Erfinde keine Funktionen, Knöpfe oder Menüs, die dort nicht stehen.
Schreib auf Deutsch, per du, freundlich und kurz (höchstens etwa 6 Sätze oder eine kurze Schrittliste). Nenne Knöpfe genau so, wie sie im Hilfetext heißen, in „…“.
Wenn der Hilfetext die Frage nicht oder nur teilweise beantwortet, sag das ehrlich in einem Satz und schreib ganz am Ende in eine eigene Zeile genau: [UNKLAR]
Fragen, die nichts mit Umstiegsheld oder Bahnfahren zu tun haben, beantwortest du nicht – sag freundlich, wofür du da bist.

HILFETEXT:
`;

export async function answer(env, origin, q) {
  if (!env.ANTHROPIC_KEY) return { a: "Die Hilfe-Antworten sind gerade nicht verfügbar. Schau unten in die Themen oder schick deine Frage an Umstiegsheld.", unsure: true };
  const ctx = await helpText(env, origin);
  count("ai"); count("help_ask");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", signal: AbortSignal.timeout(25000),
    headers: { "x-api-key": env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL(env), max_tokens: 600, system: SYSTEM + ctx, messages: [{ role: "user", content: q }] }),
  });
  if (!r.ok) throw Object.assign(new Error("Die Hilfe antwortet gerade nicht. Bitte gleich noch einmal versuchen."), { user: true });
  const j = await r.json();
  count("tok_in_help", j.usage?.input_tokens || 0); count("tok_out_help", j.usage?.output_tokens || 0);
  let a = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
  const unsure = /\[UNKLAR\]/.test(a); a = a.replace(/\s*\[UNKLAR\]\s*/g, "").trim();
  return { a: a || "Dazu habe ich leider keine Antwort.", unsure: unsure || !a };
}

// Mail an den Betreiber über Cloudflare Email Routing (Bindung MAIL, Ziel in FEEDBACK_TO). Fehlt beides: nur gespeichert.
const b64 = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
export async function mailOwner(env, subject, text) {
  if (!env.MAIL || !env.FEEDBACK_TO) return false;
  const { EmailMessage } = await import("cloudflare:email");
  const from = env.FEEDBACK_FROM || "hilfe@umstiegsheld.de", to = env.FEEDBACK_TO;
  const body = b64(text).replace(/.{76}/g, "$&\r\n");
  const raw = [`From: Umstiegsheld Hilfe <${from}>`, `To: ${to}`, `Subject: =?UTF-8?B?${b64(subject)}?=`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@umstiegsheld.de>`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", body].join("\r\n");
  await env.MAIL.send(new EmailMessage(from, to, raw));
  return true;
}
