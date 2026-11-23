import { test } from "node:test";
import assert from "node:assert/strict";
import { search } from "../src/stations.js";

const first = q => search(q)[0]?.name;
test("Bahnhofssuche: Teilbegriffe, Hbf zuerst, Umlaute egal", () => {
  assert.equal(first("München"), "München Hbf");
  assert.equal(first("munch"), "München Hbf");
  assert.equal(first("Berlin Hbf"), "Berlin Hbf");
  assert.equal(first("berlin hauptbahnhof"), "Berlin Hbf");
  assert.equal(first("Leipzig"), "Leipzig Hbf");
  assert.equal(first("Frankfurt Main Hbf"), "Frankfurt (Main) Hbf");
  assert.equal(search("Ostkreuz")[0].eva, "8011162");
  assert.ok(search("Ostkreuz")[0].name.includes("Berlin"));
  assert.equal(search("x").length, 0);
});
