import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { decideReworkRoutes } from "./pipeline-decisions.js";

describe("rework routing leaves in-flight tickets alone (2026-09-22)", () => {
  const columns = new Map([["builder", "In Development"], ["verifier", "In Code Review"]]);

  test("a ticket carrying wip:<agent> is not routed this pass, even with a rework label", () => {
    // With the dispatch pool, routing runs while agents are still working.
    // A verifier that added needs-rework:builder and is finishing its post-run
    // still owns the ticket; routing it now would strip the live wip label
    // and move the column under the run. The wip label goes when the run
    // exits, and the rework label is still there for the next pass.
    const routes = decideReworkRoutes(columns, new Map([
      ["In Code Review", [
        { id: "a", issueNumber: 782, labels: ["needs-rework:builder", "wip:verifier"] },
        { id: "b", issueNumber: 783, labels: ["needs-rework:builder"] },
      ]],
    ]));
    assert.deepStrictEqual(routes.map((r) => r.issueNumber), [783]);
  });

  test("once the wip label is gone the same ticket routes as before", () => {
    const routes = decideReworkRoutes(columns, new Map([
      ["In Code Review", [{ id: "a", issueNumber: 782, labels: ["needs-rework:builder", "done:documentation"] }]],
    ]));
    assert.equal(routes.length, 1);
    assert.equal(routes[0].toColumn, "In Development");
    assert.deepStrictEqual(routes[0].labelsToStrip, ["needs-rework:builder", "done:documentation"]);
  });
});
