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
});
