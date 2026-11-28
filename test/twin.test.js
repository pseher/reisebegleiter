import test from "node:test";
import assert from "node:assert/strict";
import { tripSig } from "../src/worker.js";

test("Doppelte Fahrt erkennen – auch wenn die Linie anders heißt", () => {
  const leg = (label, f, fp, t, tp) => ({ label, from: { name: f, plan: fp }, to: { name: t, plan: tp } });
  const a = [leg("Tram 1", "Magdeburg, Arndtstr.", "2026-11-28T07:29:00Z", "Magdeburg Hbf", "2026-11-28T07:36:00Z"), leg("IC 2238", "Magdeburg Hbf", "2026-11-28T07:59:00Z", "Rostock Hbf", "2026-11-28T10:56:00Z")];
  const b = [leg("STR 1", "Magdeburg, Arndtstr.", "2026-11-28T07:29:00.000Z", "Magdeburg Hbf", "2026-11-28T07:36:00Z"), leg("IC 2238", "Magdeburg Hbf", "2026-11-28T07:59:00Z", "Rostock Hbf (tief)", "2026-11-28T10:56:00Z")];
  assert.equal(tripSig(a), tripSig(b));
  const c = [leg("Tram 6", "Magdeburg, Arndtstr.", "2026-11-28T07:44:00Z", "Magdeburg Hbf", "2026-11-28T07:50:00Z"), a[1]];
  assert.notEqual(tripSig(a), tripSig(c), "andere Abfahrt = andere Fahrt");
});
