#!/usr/bin/env node
// Self-test for scripts/link-node-modules.mjs (temp dirs only). Junctions are removed with unlinkSync, never recursively.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { linkOne, main } from "./link-node-modules.mjs";

let failures = 0;
let passed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++;
  else failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
};
const throws = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return String(e.message).replace(/ [^ ]*(tree|host|out)[^ ]*/g, " <p>");
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "link-nm-"));
const [tree, host] = ["tree", "host"].map((n) => path.join(root, n));
for (const d of ["node_modules", "apps/api/node_modules", "apps/web/node_modules"])
  fs.mkdirSync(path.join(host, d), { recursive: true });
for (const d of ["apps/api", "apps/web", "apps/mobile", "packages/ui"])
  fs.mkdirSync(path.join(tree, d), { recursive: true });

const lines = [];
const code = main([tree, host], (m) => lines.push(m));
const linked = (d) => fs.lstatSync(path.join(tree, d, "node_modules")).isSymbolicLink();
check(
  "N1 links the root and each workspace the host has, none the host lacks; prints each pair",
  [
    code,
    linked(""),
    linked("apps/api"),
    linked("apps/web"),
    fs.existsSync(path.join(tree, "apps/mobile/node_modules")),
    lines.length,
  ],
  [0, true, true, true, false, 3],
);
check(
  "N2 a second run overwrites nothing",
  [main([tree, host], (m) => lines.push(m)), lines.at(-1).endsWith("exists")],
  [0, true],
);
check(
  "N3 a link path outside the tree is refused and nothing is created",
  [
    throws(() => linkOne(tree, path.join(root, "out", "node_modules"), host)),
    fs.existsSync(path.join(root, "out")),
  ],
  ["refusing: link <p> is not inside <p>", false],
);
check(
  "N4 a missing target is refused",
  throws(() => linkOne(tree, path.join(tree, "packages/ui/node_modules"), path.join(host, "nope"))),
  "refusing: target <p> does not exist",
);
check(
  "N5 the host's own node_modules is untouched (no apps or packages folder inside)",
  fs.readdirSync(path.join(host, "node_modules")),
  [],
);

for (const d of ["", "apps/api", "apps/web"]) fs.unlinkSync(path.join(tree, d, "node_modules"));
fs.rmSync(root, { recursive: true, force: true });
console.log(`link-node-modules self-test: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
