"use strict";

/**
 * Syntax-checks every JS file in src/, scripts/ and tests/ with `node --check`.
 * Exit code 1 if anything fails. Used by `npm run check`.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIRS = ["src", "scripts", "tests"];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const files = DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));
let failed = 0;

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failed += 1;
    console.error(`SYNTAX ERROR: ${path.relative(ROOT, file)}`);
    console.error(result.stderr || result.stdout);
  }
}

if (failed > 0) {
  console.error(`${failed} file(s) failed syntax check.`);
  process.exit(1);
}
console.log(`OK: ${files.length} file(s) passed syntax check.`);
