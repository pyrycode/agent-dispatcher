import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { buildBaselineCommand, buildBaselineJSONFilter } from "./gate-output.js";

test("JSON selection reaches a runner as one exact argument for real Kotlin method names", () => {
  const names = ["p.A#with spaces", "p.A#comma,inside", "p.A#user's message", "p.A#literal $HOME `whoami` $(true)"];
  const filter = buildBaselineJSONFilter(names)!;
  const command = buildBaselineCommand("python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' {{TESTS_JSON}}", filter)!;
  const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(result.stdout);
  assert.equal(args.length, 1);
  assert.deepEqual(JSON.parse(args[0]), names);
});

test("empty names and ambiguous JSON templates never widen selection", () => {
  for (const names of [[], [""], ["a\u0000b"]]) assert.equal(buildBaselineJSONFilter(names), null);
  for (const template of ["run {{TESTS_JSON}} {{TESTS}}", "run {{TESTS_JSON}} {{TESTS_JSON}}", "run"]) {
    assert.equal(buildBaselineCommand(template, "'[]'"), null);
  }
});
