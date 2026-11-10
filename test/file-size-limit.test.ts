import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Biome's noExcessiveLinesPerFile skips lines inside template literals; this counts raw lines.
const ROOT = join(import.meta.dir, "..");
const SKIP = new Set(["node_modules", ".git"]);
const MAX_LINES = 800;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

test(`no file is longer than ${MAX_LINES} lines`, () => {
  const tooLong = files(ROOT)
    .map((path) => ({
      path: relative(ROOT, path),
      lines: readFileSync(path, "utf8").split("\n").length,
    }))
    .filter((file) => file.lines > MAX_LINES);
  expect(tooLong).toEqual([]);
});
