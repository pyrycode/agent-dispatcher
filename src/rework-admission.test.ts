import assert from "node:assert/strict";
import { test } from "node:test";
import { selectDispatches } from "./dispatch-selection.js";
import { decideReworkRoutes, shouldSkipDispatch } from "./pipeline-decisions.js";
import { resolveStageSet } from "./stage-sets.js";

const builder = resolveStageSet("builder");
const item = (issueNumber: number, labels: string[] = []) => ({
  id: `i${issueNumber}`, issueNumber, labels,
});

test("3177 restart: pending builder repair cannot be offered to the verifier before routing", () => {
  // The first FAIL finished during drain. At restart reconciliation had not
  // moved the card yet, so selection saw the old review column and this label.
  const candidates = selectDispatches({
    itemsByColumn: new Map([["In Code Review", [item(3177, ["needs-rework:builder"])]]]),
    pollOrder: [...builder.agents].reverse(),
    maxConcurrent: 10,
    deferRoleLimits: true,
  });
  assert.deepEqual(candidates, []);
});

test("fresh launch labels veto a repair requested after candidate selection", () => {
  assert.equal(shouldSkipDispatch([], "verifier"), false);
  assert.equal(shouldSkipDispatch(["needs-rework:builder"], "verifier"), true);
  assert.equal(shouldSkipDispatch(["needs-rework:developer"], "code-review"), true);
  assert.equal(shouldSkipDispatch(["needs-rework:refiner"], "builder"), true);
});

test("a waiting repair does not consume a ready verifier's admission seat", () => {
  const candidates = selectDispatches({
    itemsByColumn: new Map([["In Code Review", [
      item(3177, ["needs-rework:builder"]), item(3184),
    ]]]),
    pollOrder: [...builder.agents].reverse(),
    maxConcurrent: 1,
    deferRoleLimits: true,
  });
  assert.deepEqual(candidates.map(c => [c.agent.name, c.item.issueNumber]), [["verifier", 3184]]);
});

test("ordinary routing removes the repair request and admits the intended builder", () => {
  const failed = item(3177, ["done:builder", "needs-rework:builder"]);
  const [route] = decideReworkRoutes(builder.columnByAgent, new Map([["In Code Review", [failed]]]));
  assert.ok(route);
  assert.equal(route.toColumn, "In Development");
  const routed = { ...failed, labels: failed.labels.filter(l => !route.labelsToStrip.includes(l)) };
  const candidates = selectDispatches({
    itemsByColumn: new Map([[route.toColumn, [routed]]]),
    pollOrder: [...builder.agents].reverse(),
    maxConcurrent: 1,
    deferRoleLimits: true,
  });
  assert.deepEqual(candidates.map(c => [c.agent.name, c.item.issueNumber]), [["builder", 3177]]);
});
