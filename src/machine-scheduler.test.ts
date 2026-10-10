import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleMachine, type WorkOffer } from "./machine-scheduler.js";
import type { FleetSnapshot } from "./fleet-store.js";

const offer = (project: string, n: number, resource: "heavy" | "light" = "heavy"): WorkOffer => ({
  project, ticket: `${project}#${n}`, role: resource === "light" ? "refiner" : "builder", resource, locks: [], key: `${n}`, order: n,
});
const empty: FleetSnapshot = { claims: [], runs: [] };
const select = (offers: WorkOffer[], state = empty, limit = 1) => scheduleMachine({
  machine: "mac", limit, projects: ["org/core", "org/mobile"], offers, state,
});

test("ready local claims override project priorities", () => {
  const state = { ...empty, claims: [{ ticket: "org/mobile#2", machine: "mac", generation: "g", created: 1 }] };
  assert.deepEqual(select([offer("org/core", 1), offer("org/mobile", 2)], state).map(o => o.ticket), ["org/mobile#2"]);
});
test("blocked claims absent from offers do not stop fallback and take priority when ready", () => {
  const state = { ...empty, claims: [{ ticket: "org/mobile#2", machine: "mac", generation: "g", created: 1 }] };
  assert.equal(select([offer("org/core", 1)], state)[0].ticket, "org/core#1");
});
test("light jobs start at full heavy capacity with no artificial cap", () => {
  const state: FleetSnapshot = { ...empty, runs: [{ ...offer("org/core", 99), id: "r", machine: "mac", session: "s", generation: "g", created: 1 }] };
  const offers = [offer("org/core", 1), ...Array.from({ length: 20 }, (_, i) => offer("org/mobile", i + 1, "light"))];
  assert.equal(select(offers, state).length, 20);
});
test("foreign owners and existing runs never enter the local queue", () => {
  const state = { ...empty, claims: [{ ticket: "org/core#1", machine: "linux", generation: "g", created: 1 }] };
  assert.equal(select([offer("org/core", 1), offer("org/mobile", 2)], state)[0].ticket, "org/mobile#2");
});
test("one ticket and exclusive operation get at most one grant per selection", () => {
  const a = { ...offer("org/core", 1, "light"), locks: ["org/core:docs"] };
  const b = { ...offer("org/core", 2, "light"), locks: a.locks };
  assert.equal(select([a, b, { ...a, key: "another-stage" }], empty, 2).length, 1);
});
