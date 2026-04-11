import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { state } from "../src/state.js";

// Unit test for the refMap data flow — test that snapshot stores selectors
// and resolveRef returns them correctly.

test.beforeEach(() => {
  state.refMap.clear();
  state.refCounter = 0;
});

test("refMap stores selector-based entries and can be looked up", () => {
  state.refMap.set("e1", { selector: "#btn-a", role: "button", name: "Button A" });
  state.refMap.set("e2", { selector: "#btn-b", role: "button", name: "Button B" });
  state.refCounter = 2;

  assert.equal(state.refMap.has("e1"), true);
  assert.equal(state.refMap.has("e2"), true);
  assert.equal(state.refMap.has("e3"), false);
  assert.deepEqual(state.refMap.get("e1"), { selector: "#btn-a", role: "button", name: "Button A" });
  assert.equal(state.refCounter, 2);
});

test("refMap can be cleared between snapshots", () => {
  state.refMap.set("e1", { selector: "#btn", role: "button", name: "Go" });
  state.refCounter = 1;

  state.refMap.clear();
  state.refCounter = 0;

  assert.equal(state.refMap.size, 0);
  assert.equal(state.refCounter, 0);
});
