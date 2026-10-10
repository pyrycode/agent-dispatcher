import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubProjectClient } from "./github.js";

test("a fresh ticket status query does not reload the whole board", async () => {
  const client = new GitHubProjectClient({ owner: "org", repo: "repo", projectNumber: 1, ownerType: "organization", token: "test" });
  (client as any).projectId = "board";
  let queries = 0;
  (client as any).gql = async (query: string, vars: any) => {
    assert.ok(query.includes("issue(number:")); assert.ok(!query.includes("items(first: 100"));
    assert.equal(vars.number, 12); queries++;
    return { repository: { issue: { projectItems: { nodes: [{ project: { id: "board" }, fieldValueByName: { name: "In Code Review" } }], pageInfo: { hasNextPage: false } } } } };
  };
  assert.equal(await client.getItemStatus(12, { forceRefresh: true }), "In Code Review");
  assert.equal(queries, 1);
});
