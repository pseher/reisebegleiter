import { test } from "node:test";
import assert from "node:assert/strict";
import { nightStop, overnight, destName } from "../src/engine.js";

const L = (lab, f, a, t, b, mode = "HIGHSPEED_RAIL") => ({ label: lab, mode, from: { name: f, plan: a }, to: { name: t, plan: b } });
test("Übernachtung wird erkannt, ein langer Halt am Tag nicht", () => {
  const night = { arr: "2026-11-27T08:55:00Z", legs: [L("ICE 9550", "Frankfurt", "2026-11-26T17:53:00Z", "Paris Est", "2026-11-26T21:52:00Z"), L("EST 9007", "Paris-Nord", "2026-11-27T06:09:00Z", "London", "2026-11-27T08:30:00Z")] };
  const day = { arr: "2026-11-26T18:00:00Z", legs: [L("ICE 1", "A", "2026-11-26T08:00:00Z", "B", "2026-11-26T09:00:00Z"), L("ICE 2", "B", "2026-11-26T13:00:00Z", "C", "2026-11-26T18:00:00Z")] };
  assert.equal(nightStop(night).at, "Paris Est");
  assert.equal(nightStop(day), null);
  assert.equal(overnight([night], Date.parse("2026-11-26T22:21:00Z")), true);
  assert.equal(overnight([night, day], Date.parse("2026-11-26T22:21:00Z")), false);
  assert.equal(overnight([], Date.parse("2026-11-26T22:21:00Z")), false);
});
test("Ziel im Satz ist die Ankunft des letzten Zugs", () => {
  assert.equal(destName([{ label: "EST 9167", arr: { name: "London St Pancras" } }, { label: "U Victoria", mode: "SUBWAY", arr: { name: "Victoria Underground Station" } }]), "London St Pancras");
});
