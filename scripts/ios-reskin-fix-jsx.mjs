#!/usr/bin/env node
// Fix-up pass — the token-swap script produced invalid JSX for cases like
//   color="#94a3b8"  →  color=ios.label2      (needs to be color={ios.label2})
//   backgroundColor="#fff" colorProp="x"      (needs braces around the ios token)
// This script re-wraps bare `ios.X` tokens when they appear as JSX attribute values.

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\//, ""));

const FILES = [
  "apps/mobile/app/(driver)/route/index.tsx",
  "apps/mobile/app/(driver)/route/map.tsx",
  "apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx",
  "apps/mobile/app/(driver)/route/stop/[stopId]/complete.tsx",
  "apps/mobile/app/(driver)/route/stop/[stopId]/new-order.tsx",
  "apps/mobile/app/(driver)/route/stop/[stopId]/return/index.tsx",
  "apps/mobile/app/(driver)/standing-orders/index.tsx",
  "apps/mobile/app/(driver)/orders/new.tsx",
  "apps/mobile/app/(admin)/dashboard.tsx",
  "apps/mobile/app/(admin)/routes/index.tsx",
  "apps/mobile/app/(admin)/products/index.tsx",
  "apps/mobile/app/(driver)/route/messages.tsx",
];

// Attribute context: <word>=ios.something  → <word>={ios.something}
// Match a JSX attribute where the value is a bare `ios.X[.Y][\[N\]]` expression.
// Must stop at the next attribute boundary (space, tab, newline, />, or >).
const attrTokenPattern =
  /([A-Za-z_][\w-]*)=((?:ios\.[A-Za-z_][\w.]*(?:\[[0-9]+\])?))(?=[\s/>])/g;

let totalFiles = 0;
let totalFixes = 0;

for (const rel of FILES) {
  const p = path.resolve(root, rel);
  if (!fs.existsSync(p)) continue;
  const original = fs.readFileSync(p, "utf-8");
  const next = original.replace(attrTokenPattern, (_m, name, expr) => `${name}={${expr}}`);
  if (next !== original) {
    fs.writeFileSync(p, next);
    const fixes = (original.match(attrTokenPattern) ?? []).length;
    totalFixes += fixes;
    totalFiles++;
    console.log(`  ${rel} — fixed ${fixes} attribute(s)`);
  }
}

console.log(`\nDone. ${totalFixes} fixes across ${totalFiles} files.`);
