import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { selectDispatches } from "./dispatch-selection.js";
import { decideAutoAdvance, AUTO_ADVANCE_RULES } from "./pipeline-decisions.js";
import { AGENTS } from "./types.js";
import { ticketPriority } from "./ticket-priority.js";

const pollOrder = [...AGENTS].reverse();
const item = (n: number, labels: string[] = []) => ({ id: `item-${n}`, issueNumber: n, labels });
const picks = (itemsByColumn: Map<string, ReturnType<typeof item>[]>, maxConcurrent = 10) =>
  selectDispatches({ itemsByColumn, pollOrder, maxConcurrent }).map(c => c.item.issueNumber);

describe("priority labels decide dispatch order", () => {
  test("high Backlog precedes unmarked Development with one free seat", () => {
    assert.deepEqual(picks(new Map([
      ["In Development", [item(2)]],
      ["Backlog", [item(1, ["priority:high"])]],
    ]), 1), [1]);
  });

  test("every higher rank beats column position", () => {
    const ranks = [["priority:high"], ["priority:normal"], [], ["priority:low"]];
    for (let higher = 0; higher < ranks.length; higher++) {
      for (let lower = higher + 1; lower < ranks.length; lower++) {
        assert.deepEqual(picks(new Map([
          ["In Documentation", [item(2, ranks[lower])]],
          ["Backlog", [item(1, ranks[higher])]],
        ]), 1), [1]);
      }
    }
  });

  test("priority overrides card order, leaving input untouched", () => {
    const cards = [item(1, ["priority:low"]), item(2), item(3, ["priority:normal"]), item(4, ["priority:high"])];
    assert.deepEqual(picks(new Map([["Backlog", cards]])), [4, 3, 2, 1]);
    assert.deepEqual(cards.map(i => i.issueNumber), [1, 2, 3, 4]);
  });

  test("equal priorities retain finish-first column order and manual card order", () => {
    for (const labels of [[], ["priority:high"], ["priority:normal"], ["priority:low"]]) {
      assert.deepEqual(picks(new Map([
        ["Backlog", [item(30, labels), item(10, labels)]],
        ["In Development", [item(20, labels), item(5, labels)]],
      ])), [20, 5, 30, 10]);
    }
  });

  test("serial caps are spent on the highest priority eligible ticket", () => {
    const documentation = pollOrder.find(a => a.name === "documentation")!;
    const candidates = selectDispatches({
      itemsByColumn: new Map([[documentation.column, [item(1), item(2, ["priority:high"]), item(3, ["priority:high"])]]]),
      pollOrder: [{ ...documentation, serial: true }],
      maxConcurrent: 3,
    });
    assert.deepEqual(candidates.map(c => c.item.issueNumber), [2]);
  });

  test("priority does not bypass in-flight caps or ticket and family holds", () => {
    const documentation = pollOrder.find(a => a.name === "documentation")!;
    const blocked = { ...item(2, ["priority:high"]), blockedBy: [{ number: 99, state: "OPEN" as const }] };
    const familyHeld = { ...item(3, ["priority:high"]), parentNumber: 100 };
    const candidates = selectDispatches({
      itemsByColumn: new Map([
        ["Backlog", [item(1, ["priority:high", "error:po"]), blocked, familyHeld, item(4), item(5, ["priority:high", "wip:po"])]],
        [documentation.column, [item(6, ["priority:high"]), item(7, ["wip:documentation"])]],
      ]),
      pollOrder: pollOrder.map(a => a.name === "documentation" ? { ...a, serial: true } : a),
      rootLabelsByIssue: new Map([[100, ["error:family-breaker"]]]),
      maxConcurrent: 3,
    });
    assert.deepEqual(candidates.map(c => c.item.issueNumber), [4]);
  });

  test("unknown labels are unmarked and conflicting labels use the highest rank", () => {
    assert.equal(ticketPriority(["priority:unknown"]), ticketPriority([]));
    assert.equal(ticketPriority(["priority:low", "priority:high"]), ticketPriority(["priority:high"]));
    assert.equal(ticketPriority(["priority:low", "priority:normal"]), ticketPriority(["priority:normal"]));
  });
});

describe("priority labels decide Backlog promotion", () => {
  test("high advances before cards above it and low stays behind unmarked", () => {
    const decision = decideAutoAdvance(AUTO_ADVANCE_RULES, new Set(), new Map([
      ["Backlog", [item(1, ["done:po", "priority:low"]), item(2, ["done:po"]), item(3, ["done:po", "priority:high"])]],
    ]), 0, 2);
    assert.deepEqual(decision.advances.map(a => a.issueNumber), [3, 2]);
    assert.deepEqual(decision.backlogHeld, [1]);
  });
});
