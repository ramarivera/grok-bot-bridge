import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Biome's noExcessiveLinesPerFile skips lines inside template literals; this counts raw lines.
// The whole repo is covered, not only the deployed app: the template and the film are source too.
const ROOT = join(import.meta.dir, "..", "..");
const SKIP = new Set(["node_modules", ".git", ".hyperframes"]);
const TEXT = /\.(ts|js|json|md|sql|html|css)$/;
const MAX_LINES = 800;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return TEXT.test(entry.name) ? [path] : [];
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
