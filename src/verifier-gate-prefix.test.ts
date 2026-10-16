import { test } from "node:test";
import assert from "node:assert/strict";
import { gatePrefixKey, retainedGatePrefix, retainableGateEvidence, type GatePrefix } from "./verifier-gate-prefix.js";
import { gateCommandProvenance } from "./gate-output.js";

const now = 1000000;
const logs = new Map([["out", "passed"], ["err", ""]]);
const key = gatePrefixKey("tree", ["vet", "test", "build"], { PATH: "/tools" }, "go1.26\nconsumer-tree");
const prefix: GatePrefix = { key, passedAt: now - 1, gates: [{ gate: "vet", summary: "✓ vet (exit 0)", logs: ["out", "err"], evidence: gatePrefixKey("", [], {}, "passed\u0000") }] };

test("retain only the green prefix, with original log evidence", () => {
  assert.deepEqual(retainedGatePrefix(JSON.stringify(prefix), key, ["vet", "test", "build"], now, p => logs.get(p) ?? null), prefix.gates);
  for (const changed of [gatePrefixKey("other", ["vet", "test", "build"], { PATH: "/tools" }, "go1.26\nconsumer-tree"), gatePrefixKey("tree", ["test", "vet", "build"], { PATH: "/tools" }, "go1.26\nconsumer-tree"), gatePrefixKey("tree", ["vet", "test", "build"], { PATH: "/changed" }, "go1.26\nconsumer-tree"), gatePrefixKey("tree", ["vet", "test", "build"], { PATH: "/tools" }, "go1.27\nconsumer-tree")]) {
    assert.deepEqual(retainedGatePrefix(JSON.stringify(prefix), changed, ["vet", "test", "build"], now, p => logs.get(p) ?? null), []);
  }
});

test("missing, changed, expired and malformed evidence never resumes", () => {
  const read = (p: string) => logs.get(p) ?? null;
  for (const raw of ["", "null", "{}", "[]", JSON.stringify({ ...prefix, passedAt: now + 1 }), JSON.stringify({ ...prefix, passedAt: now - 86400000 }), JSON.stringify({ ...prefix, gates: [{ ...prefix.gates[0], summary: "✗ vet (exit 1)" }] }), JSON.stringify({ ...prefix, gates: [{ ...prefix.gates[0], logs: [] }] })]) {
    assert.deepEqual(retainedGatePrefix(raw, key, ["vet", "test", "build"], now, read), []);
  }
  assert.deepEqual(retainedGatePrefix(JSON.stringify(prefix), key, ["vet", "test", "build"], now, () => null), []);
  assert.deepEqual(retainedGatePrefix(JSON.stringify(prefix), key, ["vet", "test", "build"], now, () => "changed"), []);
});

test("zero, skipped-only, failed and incomplete test output cannot certify a retained step", () => {
  const event = (Action: string, Test?: string) => JSON.stringify({ Action, Package: "p", ...(Test ? { Test } : {}) });
  const complete = (action: string) => [event("start"), event("run", "TestOne"), event(action, "TestOne"), event(action === "fail" ? "fail" : "pass")].join("\n");
  assert.equal(retainableGateEvidence(complete("pass"), "go-json"), true);
  for (const raw of ["", "ok", complete("skip"), complete("fail"), [event("start"), event("run", "TestOne")].join("\n")]) {
    assert.equal(retainableGateEvidence(raw, "go-json"), false);
  }
});

test("only the exact admission wrapper argv exposes a direct test runner", () => {
  assert.deepEqual(gateCommandProvenance("python3 scripts/test-admission.py -- go test -race -json ./..."), { kind: "single", format: "go-json" });
  for (const command of ["python3 other.py -- go test -json ./...", "python3 scripts/test-admission.py -- sh -c 'go test -json ./...'", "python3 scripts/test-admission.py -- go test -json ./... && make e2e"]) {
    assert.notDeepEqual(gateCommandProvenance(command), { kind: "single", format: "go-json" });
  }
});
