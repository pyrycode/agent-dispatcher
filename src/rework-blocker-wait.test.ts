import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { decideReworkRoutes } from "./pipeline-decisions.js";

describe("a refinement bail on a blocked ticket is a wait (2026-09-23)", () => {
  const columns = new Map([
    ["refiner", "Backlog"],
    ["builder", "In Development"],
    ["verifier", "In Code Review"],
  ]);

  test("builder bail with an open blocker stays in its column and strips only the trigger", () => {
    // pyrycode-mobile #808: the builder's file-overlap check found #804's
    // open branch in the same files, added the blocker and needs-rework:refiner.
    const routes = decideReworkRoutes(columns, new Map([
      ["In Development", [{
        id: "a",
        issueNumber: 808,
        labels: ["needs-rework:refiner", "done:refiner", "rework-count:1"],
        blockedBy: [{ number: 803, state: "CLOSED" as const }, { number: 804, state: "OPEN" as const }],
      }]],
    ]));
    assert.equal(routes.length, 1);
    assert.equal(routes[0].toColumn, "In Development");
    assert.deepStrictEqual(routes[0].labelsToStrip, ["needs-rework:refiner"]);
    assert.deepStrictEqual(routes[0].waitingOn, [804]);
  });

  test("the same bail with only closed blockers is an ordinary rework to Backlog", () => {
    const routes = decideReworkRoutes(columns, new Map([
      ["In Development", [{
        id: "a",
        issueNumber: 808,
        labels: ["needs-rework:refiner", "done:refiner"],
        blockedBy: [{ number: 803, state: "CLOSED" as const }],
      }]],
    ]));
    assert.equal(routes[0].toColumn, "Backlog");
    assert.deepStrictEqual(routes[0].labelsToStrip, ["needs-rework:refiner", "done:refiner"]);
    assert.equal(routes[0].waitingOn, undefined);
  });

  test("a rework to a column past Backlog still routes, blocker or not", () => {
    // A verifier's findings still need the builder once the blocker closes.
    const routes = decideReworkRoutes(columns, new Map([
      ["In Code Review", [{
        id: "a",
        issueNumber: 900,
        labels: ["needs-rework:builder"],
        blockedBy: [{ number: 901, state: "OPEN" as const }],
      }]],
    ]));
    assert.equal(routes[0].toColumn, "In Development");
    assert.equal(routes[0].waitingOn, undefined);
  });

  test("a builder waiting on a fix returns to builder rework in Development", () => {
    const routes = decideReworkRoutes(columns, new Map([
      ["In Development", [{
        id: "a",
        issueNumber: 1277,
        labels: ["needs-rework:builder", "done:builder"],
        blockedBy: [{ number: 1280, state: "OPEN" as const }],
      }]],
    ]));
    assert.equal(routes[0].toColumn, "In Development");
    assert.deepStrictEqual(routes[0].labelsToStrip, ["needs-rework:builder", "done:builder"]);
    assert.deepStrictEqual(routes[0].waitingOn, [1280], "a wait: the caller counts nothing");
  });
});

describe("a builder parked on a blocker in its own column is a wait, not a rework (2026-10-07)", () => {
  const columns = new Map([
    ["refiner", "Backlog"],
    ["builder", "In Development"],
    ["verifier", "In Code Review"],
    ["documentation", "In Documentation"],
  ]);

  test("desktop #1738 at 23:02 UTC on 2026-10-05: waiting on #1796 after one real rework", () => {
    // Exact labels when the route ran: the verifier's FAIL had already been
    // counted (rework-count:1), then the builder returned waiting_on_blocker.
    const routes = decideReworkRoutes(columns, new Map([
      ["In Development", [{
        id: "item-1738",
        issueNumber: 1738,
        labels: ["enhancement", "family-dispatches:8", "needs-rework:builder", "rework-count:1"],
        blockedBy: [{ number: 1796, state: "OPEN" as const }],
      }]],
    ]));
    assert.equal(routes.length, 1);
    assert.equal(routes[0].toColumn, "In Development");
    assert.deepStrictEqual(routes[0].labelsToStrip, ["needs-rework:builder"]);
    assert.deepStrictEqual(routes[0].waitingOn, [1796]);
  });

  test("desktop #1766 at 00:36 UTC on 2026-10-06: first builder run waits on #1785 and strips done:refiner as before", () => {
    const routes = decideReworkRoutes(columns, new Map([
      ["In Development", [{
        id: "item-1766",
        issueNumber: 1766,
        labels: ["security-sensitive", "needs-real-claude", "done:refiner", "family-dispatches:2", "needs-rework:builder"],
        blockedBy: [{ number: 1785, state: "OPEN" as const }],
      }]],
    ]));
    assert.deepStrictEqual(routes[0].labelsToStrip, ["needs-rework:builder", "done:refiner"]);
    assert.deepStrictEqual(routes[0].waitingOn, [1785]);
  });

  test("the same route once the blocker has closed is an ordinary rework again", () => {
    const routes = decideReworkRoutes(columns, new Map([
      ["In Development", [{
        id: "item-1738",
        issueNumber: 1738,
        labels: ["needs-rework:builder", "rework-count:1"],
        blockedBy: [{ number: 1796, state: "CLOSED" as const }],
      }]],
    ]));
    assert.equal(routes[0].waitingOn, undefined);
  });

  test("a verifier FAIL on a blocked ticket still routes to the builder as a rework", () => {
    const routes = decideReworkRoutes(columns, new Map([
      ["In Code Review", [{
        id: "item-1738",
        issueNumber: 1738,
        labels: ["done:builder", "needs-rework:builder", "rework-count:1"],
        blockedBy: [{ number: 1796, state: "OPEN" as const }],
      }]],
    ]));
    assert.equal(routes[0].toColumn, "In Development");
    assert.equal(routes[0].waitingOn, undefined);
  });
});
