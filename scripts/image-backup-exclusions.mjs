#!/usr/bin/env node
// Feed rows from the documented read-only ledger query after pausing all writers.
// Output is a tar --anchored --no-wildcards --exclude-from file (archive root '.').
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function imageBackupExclusions(keys) {
  if (!Array.isArray(keys)) throw new Error("Expected a JSON array of temporary object keys");
  const exclusions = new Set(["./temporary"]);
  for (const key of keys) {
    if (typeof key !== "string" || !key || key.length > 512 || !key.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(part))) {
      throw new Error("Invalid image object key");
    }
    const digest = createHash("sha256").update(key, "utf8").digest("hex");
    exclusions.add(`./image-${digest}.bin`);
    exclusions.add(`./.image-${digest}.writing`);
  }
  return [...exclusions].sort().join("\n") + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(imageBackupExclusions(JSON.parse(readFileSync(0, "utf8"))));
}
