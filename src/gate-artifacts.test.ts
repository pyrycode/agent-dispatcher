import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  DEFAULT_GATE_EVIDENCE_RETENTION,
  GATE_RUNS_DIR,
  gateEvidenceEnv,
  gateEvidenceRetentionFromEnv,
  gateRunEvidenceDir,
  prepareGateRunEvidence,
  pruneGateEvidence,
  type GateEvidenceRetention,
} from "./gate-artifacts.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-14T12:00:00Z");

function stampAt(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, "-");
}

function logsDir(): string {
  return mkdtempSync(resolve(tmpdir(), "gate-artifacts-"));
}

/** A run folder holding `bytes` bytes, stamped and modified at `ms`. */
function makeRun(logs: string, issue: number, ms: number, bytes = 10): string {
  const dir = gateRunEvidenceDir(logs, issue, stampAt(ms));
  mkdirSync(resolve(dir, "main"), { recursive: true });
  writeFileSync(resolve(dir, "main", "dispatcher.xml"), "x".repeat(bytes));
  utimesSync(dir, new Date(ms), new Date(ms));
  return dir;
}

const roomy: GateEvidenceRetention = { keepPerTicket: 5, maxAgeDays: 30, maxTotalBytes: 1 << 30 };

describe("gate evidence folders", () => {
  test("a run folder is scoped to the ticket and the run, under the logs", () => {
    assert.equal(gateRunEvidenceDir("/a/logs", 1977, "2026-10-14T08-12-13-141Z"),
      "/a/logs/evidence/1977/gate-runs/2026-10-14T08-12-13-141Z");
  });

  test("prepare makes an owner-only folder and returns it", () => {
    const logs = logsDir();
    const dir = prepareGateRunEvidence(logs, 2137, stampAt(Date.now()), {});
    assert.ok(dir !== null && existsSync(dir));
    assert.equal(statSync(dir!).mode & 0o777, 0o700);
  });

  test("prepare returns null instead of throwing when the folder cannot be made", () => {
    const logs = logsDir();
    writeFileSync(resolve(logs, "evidence"), "a file where the folder should be");
    assert.equal(prepareGateRunEvidence(logs, 2137, stampAt(Date.now()), {}), null);
  });

  test("each part gets its own folder and the variable names it", () => {
    const logs = logsDir();
    const run = gateRunEvidenceDir(logs, 1, stampAt(NOW));
    const env = gateEvidenceEnv(run, "rerun");
    assert.equal(env.PYRY_GATE_EVIDENCE_DIR, resolve(run, "rerun"));
    assert.ok(existsSync(resolve(run, "rerun")));
    assert.deepEqual(gateEvidenceEnv(null, "main"), {});
    assert.deepEqual(gateEvidenceEnv(run, "main", () => { throw new Error("EACCES"); }), {});
  });
});

describe("pruneGateEvidence", () => {
  test("removes run folders older than the age limit", () => {
    const logs = logsDir();
    const old = makeRun(logs, 1, NOW - 31 * DAY);
    const fresh = makeRun(logs, 1, NOW - 29 * DAY);
    assert.deepEqual(pruneGateEvidence(logs, roomy, NOW), [old]);
    assert.ok(existsSync(fresh));
  });

  test("keeps only the newest runs of each ticket", () => {
    const logs = logsDir();
    const a = [1, 2, 3].map(h => makeRun(logs, 7, NOW - h * 3600_000));
    const b = makeRun(logs, 8, NOW - 10 * 3600_000);
    const removed = pruneGateEvidence(logs, { ...roomy, keepPerTicket: 2 }, NOW);
    assert.deepEqual(removed, [a[2]], "the oldest of ticket 7 only");
    assert.ok(existsSync(a[0]) && existsSync(a[1]) && existsSync(b));
  });

  test("removes the oldest across tickets until the total fits", () => {
    const logs = logsDir();
    const oldest = makeRun(logs, 1, NOW - 3 * 3600_000, 600);
    const middle = makeRun(logs, 2, NOW - 2 * 3600_000, 600);
    const newest = makeRun(logs, 1, NOW - 1 * 3600_000, 600);
    const removed = pruneGateEvidence(logs, { ...roomy, maxTotalBytes: 1300 }, NOW);
    assert.deepEqual(removed, [oldest]);
    assert.ok(existsSync(middle) && existsSync(newest));
  });

  test("never removes the protected run, the one about to start", () => {
    const logs = logsDir();
    const current = makeRun(logs, 1, NOW - 40 * DAY);
    assert.deepEqual(pruneGateEvidence(logs, roomy, NOW, new Set([current])), []);
    assert.ok(existsSync(current));
  });

  test("touches nothing it did not make: other evidence, odd names, symbolic links", () => {
    const logs = logsDir();
    const ev = resolve(logs, "evidence");
    // A builder's own retained captures and the mobile harness's folders.
    mkdirSync(resolve(ev, "2153", "suite-green"), { recursive: true });
    mkdirSync(resolve(ev, "harness", GATE_RUNS_DIR, stampAt(NOW - 90 * DAY)), { recursive: true });
    mkdirSync(resolve(ev, "2153", "gate-runs", "notes"), { recursive: true });
    const target = mkdtempSync(resolve(tmpdir(), "gate-artifacts-target-"));
    writeFileSync(resolve(target, "keep.txt"), "outside");
    symlinkSync(target, resolve(ev, "2153", "gate-runs", stampAt(NOW - 91 * DAY)));
    const old = makeRun(logs, 2153, NOW - 90 * DAY);
    assert.deepEqual(pruneGateEvidence(logs, roomy, NOW), [old]);
    assert.ok(existsSync(resolve(ev, "2153", "suite-green")));
    assert.ok(existsSync(resolve(ev, "harness")));
    assert.ok(existsSync(resolve(ev, "2153", "gate-runs", "notes")));
    assert.ok(existsSync(resolve(target, "keep.txt")), "a link is never followed");
  });

  test("a missing evidence folder is nothing to do, not an error", () => {
    assert.deepEqual(pruneGateEvidence(resolve(logsDir(), "absent"), roomy, NOW), []);
  });

  test("prepare prunes the others after making its own folder", () => {
    const logs = logsDir();
    const stale = makeRun(logs, 5, Date.now() - 60 * DAY);
    const dir = prepareGateRunEvidence(logs, 5, stampAt(Date.now()), {});
    assert.ok(dir !== null && existsSync(dir));
    assert.ok(!existsSync(stale));
    assert.deepEqual(readdirSync(resolve(logs, "evidence", "5", "gate-runs")).length, 1);
  });
});

describe("gateEvidenceRetentionFromEnv", () => {
  test("defaults: five runs per ticket, thirty days, 2048 MB", () => {
    assert.deepEqual(gateEvidenceRetentionFromEnv({}), DEFAULT_GATE_EVIDENCE_RETENTION);
    assert.deepEqual(DEFAULT_GATE_EVIDENCE_RETENTION, { keepPerTicket: 5, maxAgeDays: 30, maxTotalBytes: 2048 * 1024 * 1024 });
  });

  test("reads the three settings and ignores invalid ones", () => {
    assert.deepEqual(
      gateEvidenceRetentionFromEnv({ PYRY_GATE_EVIDENCE_KEEP: "2", PYRY_GATE_EVIDENCE_DAYS: "7", PYRY_GATE_EVIDENCE_MAX_MB: "100" }),
      { keepPerTicket: 2, maxAgeDays: 7, maxTotalBytes: 100 * 1024 * 1024 });
    assert.deepEqual(
      gateEvidenceRetentionFromEnv({ PYRY_GATE_EVIDENCE_KEEP: "0", PYRY_GATE_EVIDENCE_DAYS: "-1", PYRY_GATE_EVIDENCE_MAX_MB: "lots" }),
      DEFAULT_GATE_EVIDENCE_RETENTION);
  });
});
