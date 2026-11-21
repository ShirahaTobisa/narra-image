import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { imageBackupExclusions } from "../image-backup-exclusions.mjs";

test("omits the temporary directory and exact pending gallery files, preserving unknown old files", () => {
  const key = "gallery/fixture.png";
  const digest = createHash("sha256").update(key).digest("hex");
  const output = imageBackupExclusions([key, key]);
  assert.deepEqual(output.trim().split("\n"), [`./.image-${digest}.writing`, `./image-${digest}.bin`, "./temporary"]);
  assert.equal(imageBackupExclusions([]), "./temporary\n");
  for (const invalid of [["../secret"], ["a\nb"], [null], {}]) assert.throws(() => imageBackupExclusions(invalid));
});
