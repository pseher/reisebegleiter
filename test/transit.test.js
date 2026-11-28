import test from "node:test";
import assert from "node:assert/strict";
import { transitFetch, PUBLIC, _resetForTests } from "../src/transit.js";
import * as stats from "../src/stats.js";

const env = { MOTIS_URL: "https://own.example", MOTIS_ID: "id", MOTIS_SECRET: "sec" };
const ok = body => new Response(JSON.stringify(body), { status: 200 });

test("eigener Server zuerst; bei Ausfall Transitous; nach 3 Fehlern Pause", async () => {
  const calls = [], orig = globalThis.fetch;
  let ownDown = false;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).startsWith("https://own.example")) {
      assert.equal(init.headers["CF-Access-Client-Id"], "id");
      if (ownDown) throw Object.assign(new Error("weg"), { name: "TimeoutError" });
      return ok({ from: "own" });
    }
    return ok({ from: "pub" });
  };
  try {
    assert.equal((await (await transitFetch(env, "/api/v5/plan?x=1")).json()).from, "own");
    ownDown = true;
    for (let i = 0; i < 3; i++) assert.equal((await (await transitFetch(env, "/api/v5/plan?x=1")).json()).from, "pub");
    calls.length = 0;
    assert.equal((await (await transitFetch(env, "/api/v5/plan?x=1")).json()).from, "pub");
    assert.deepEqual(calls, [`${PUBLIC}/api/v5/plan?x=1`], "in der Pause wird der eigene Server gar nicht gefragt");
  } finally { globalThis.fetch = orig; }
});

test("unbekannte Fahrt (404) beim eigenen Server: Transitous fragen, kein Ausfall", async () => {
  const orig = globalThis.fetch;
  _resetForTests(); let own = 0;
  globalThis.fetch = async url => String(url).startsWith("https://own2.example") && ++own ? new Response("nicht da", { status: 404 }) : ok({ legs: [1] });
  try { assert.deepEqual(await (await transitFetch({ ...env, MOTIS_URL: "https://own2.example" }, "/api/v5/trip?tripId=abc")).json(), { legs: [1] }); assert.equal(own, 1, "eigener Server wurde gefragt"); }
  finally { globalThis.fetch = orig; }
});

test("Testlauf: Nutzer bekommen Transitous, eigener Server wird nur verglichen", async () => {
  const orig = globalThis.fetch;
  _resetForTests();
  globalThis.fetch = async url => ok({ itineraries: [{ startTime: "a", endTime: String(url).includes("own3") ? "b" : "b" }] });
  try {
    const r = await transitFetch({ ...env, MOTIS_URL: "https://own3.example", MOTIS_MODE: "test" }, "/api/v5/plan?y=2");
    assert.equal((await r.json()).itineraries.length, 1);
  } finally { globalThis.fetch = orig; }
});

test("ohne MOTIS_URL alles wie bisher über Transitous", async () => {
  const orig = globalThis.fetch, seen = [];
  globalThis.fetch = async url => { seen.push(String(url)); return ok({}); };
  try { await transitFetch({}, "/api/v1/geocode?text=x"); assert.deepEqual(seen, [`${PUBLIC}/api/v1/geocode?text=x`]); }
  finally { globalThis.fetch = orig; }
});
