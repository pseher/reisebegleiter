// Erzeugt ein VAPID-Schlüsselpaar für Web-Push.
// Aufruf: node tools/vapid.mjs  → die ausgegebene Zeile als Secret VAPID_JWK hinterlegen.
// Alternativ kannst du denselben Wert wie bei PlanFlink verwenden.
const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const jwk = await crypto.subtle.exportKey("jwk", k.privateKey);
console.log(JSON.stringify({ x: jwk.x, y: jwk.y, d: jwk.d }));
