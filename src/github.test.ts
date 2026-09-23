// Tests for combining the board listing with the open-issue read, and for
// the edge-triggered stale-listing report. Both are pure; the GraphQL reads
// that feed them live in GitHubProjectClient.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { decideListingGapReport, mergeListingWithOpenIssues, type ListingGaps } from "./github.js";

type Item = { issueNumber: number; status: string; labels: string[] };
const item = (issueNumber: number, status: string, labels: string[] = []): Item => ({ issueNumber, status, labels });
const numbers = (items: Item[]) => items.map((i) => i.issueNumber);
const column = (items: Item[], status: string) => numbers(items.filter((i) => i.status === status));

describe("mergeListingWithOpenIssues", () => {
  test("a healthy listing comes back unchanged, with no gaps", () => {
    const listing = [item(5, "Backlog"), item(2, "Backlog"), item(9, "In Development")];
    const open = [item(2, "Backlog"), item(5, "Backlog"), item(9, "In Development")];
    const { items, gaps } = mergeListingWithOpenIssues(listing, open);
    assert.deepEqual(numbers(items), [5, 2, 9], "the listing's order, not the read's");
    assert.deepEqual(gaps, { missing: [], moved: [] });
  });

  test("open issues the listing lacks go to the bottom of their column, lowest number first", () => {
    const listing = [item(5, "Backlog"), item(2, "Backlog"), item(9, "In Development")];
    const open = [item(912, "Backlog"), item(2, "Backlog"), item(891, "Backlog"), item(5, "Backlog"), item(9, "In Development")];
    const { items, gaps } = mergeListingWithOpenIssues(listing, open);
    assert.deepEqual(column(items, "Backlog"), [5, 2, 891, 912]);
    assert.deepEqual(gaps.missing, [891, 912]);
    assert.deepEqual(gaps.moved, []);
  });

  test("a ticket the listing shows in a stale column takes the issue's column and keeps its position", () => {
    const listing = [item(5, "Backlog"), item(2, "Backlog"), item(7, "Backlog")];
    const open = [item(5, "Backlog"), item(2, "In Development"), item(7, "Backlog")];
    const { items, gaps } = mergeListingWithOpenIssues(listing, open);
    assert.deepEqual(column(items, "Backlog"), [5, 7]);
    assert.deepEqual(column(items, "In Development"), [2]);
    assert.deepEqual(numbers(items), [5, 2, 7]);
    assert.deepEqual(gaps.moved, [{ issueNumber: 2, listed: "Backlog", actual: "In Development" }]);
  });

  test("labels and every other field come from the issue read", () => {
    const listing = [item(5, "Backlog", ["done:refiner"])];
    const open = [item(5, "Backlog", ["done:refiner", "wip:builder"])];
    const { items } = mergeListingWithOpenIssues(listing, open);
    assert.deepEqual(items[0].labels, ["done:refiner", "wip:builder"]);
  });

  test("listing items the read does not cover pass through untouched", () => {
    // A closed issue in Done, and an open card from another repository.
    const closed = item(3, "Done");
    const foreign = item(40, "Backlog");
    const listing = [closed, item(5, "Backlog"), foreign];
    const { items, gaps } = mergeListingWithOpenIssues(listing, [item(5, "Backlog")]);
    assert.equal(items[0], closed);
    assert.equal(items[2], foreign);
    assert.deepEqual(gaps, { missing: [], moved: [] });
  });

  test("an empty listing still yields every open issue", () => {
    const { items, gaps } = mergeListingWithOpenIssues([], [item(8, "Backlog"), item(4, "Inbox")]);
    assert.deepEqual(numbers(items), [4, 8]);
    assert.deepEqual(gaps.missing, [4, 8]);
  });
});

describe("decideListingGapReport", () => {
  const none: ListingGaps = { missing: [], moved: [] };
  const stale: ListingGaps = { missing: [891, 912], moved: [{ issueNumber: 2, listed: "Backlog", actual: "In Development" }] };

  test("stays quiet while the listing is healthy", () => {
    assert.deepEqual(decideListingGapReport(false, none, "pyrycode-mobile"), { active: false });
  });

  test("notifies once when the listing first goes stale, naming the tickets", () => {
    const r = decideListingGapReport(false, stale, "pyrycode-mobile");
    assert.equal(r.active, true);
    assert.match(r.notify ?? "", /pyrycode-mobile/);
    assert.match(r.notify ?? "", /#891, #912/);
    assert.match(r.notify ?? "", /#2/);
    assert.equal(r.log, undefined);
  });

  test("only logs while it stays stale", () => {
    const r = decideListingGapReport(true, stale, "pyrycode-mobile");
    assert.equal(r.active, true);
    assert.equal(r.notify, undefined);
    assert.match(r.log ?? "", /2 missing, 1 in another column/);
  });

  test("logs once when the listing catches up", () => {
    const r = decideListingGapReport(true, none, "pyrycode-mobile");
    assert.equal(r.active, false);
    assert.equal(r.notify, undefined);
    assert.match(r.log ?? "", /caught up/);
  });

  test("caps the named tickets at ten", () => {
    const many: ListingGaps = { missing: Array.from({ length: 14 }, (_, i) => 900 + i), moved: [] };
    const r = decideListingGapReport(false, many, "pyrycode-mobile");
    assert.match(r.notify ?? "", /#909 and 4 more/);
    assert.doesNotMatch(r.notify ?? "", /#910/);
  });
});
