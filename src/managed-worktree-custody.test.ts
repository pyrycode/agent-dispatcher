import assert from "node:assert/strict";
import { test } from "node:test";
import { constants, linkSync, lstatSync, mkdtempSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManagedCustody, writeManagedCustody } from "./managed-worktree-custody.js";

const io = { readFileSync, writeFileSync };

test("custody absence requires lstat, and a subsequent ENOENT read remains a refusal", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "custody-absence-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "record.json"), target = join(root, "missing.json");
  assert.equal(readManagedCustody(file, io), undefined);
  symlinkSync(target, file);
  assert.throws(() => readManagedCustody(file, io), /unaliased regular file/);
  assert.equal(readlinkSync(file), target);
  assert.throws(() => lstatSync(target), { code: "ENOENT" });
  const regular = join(root, "regular.json");
  writeFileSync(regular, "original");
  assert.throws(() => readManagedCustody(regular, { ...io, openSync: () => {
    throw Object.assign(new Error("unavailable after lstat"), { code: "ENOENT" });
  } }), { code: "ENOENT" });
  assert.equal(readFileSync(regular, "utf8"), "original");
});

for (const alias of ["symlink", "hardlink", "replacement"]) {
  test(`custody update refuses a ${alias} introduced at open without truncating either inode`, t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "custody-write-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, "record.json"), saved = join(root, "saved.json"), target = join(root, "target.json");
    writeFileSync(file, "prior custody"); writeFileSync(target, "independent evidence");
    assert.throws(() => writeManagedCustody(file, "successor custody", { ...io,
      openSync: ((path: any, flags: any, mode: any) => {
        if (path === file && (flags & constants.O_WRONLY)) {
          renameSync(file, saved);
          if (alias === "symlink") symlinkSync(target, file);
          else if (alias === "hardlink") linkSync(target, file);
          else writeFileSync(file, "replacement evidence");
        }
        return openSync(path, flags, mode);
      }) as typeof openSync,
    }, true));
    assert.equal(readFileSync(saved, "utf8"), "prior custody");
    assert.equal(readFileSync(target, "utf8"), "independent evidence");
    if (alias === "symlink") assert.equal(readlinkSync(file), target);
    else assert.equal(readFileSync(file, "utf8"), alias === "hardlink" ? "independent evidence" : "replacement evidence");
  });
}
