#!/usr/bin/env node
// One-shot token swap script for the Apple-style iOS re-skin.
// Replaces the `colors.*` / hard-coded grey tokens with the new `ios.*` tokens
// across the driver + admin screens we're re-skinning. Conservative — only
// swaps well-known token expressions, leaves everything else untouched.
//
// Usage: node scripts/ios-reskin-swap.mjs

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
];

// Order matters — more specific first
const replacements = [
  // Brand palette — map all brand shades to iOS brand tokens
  [/colors\.brand\[(50|100)\]/g, "ios.brandWash"],
  [/colors\.brand\[(200|300|400)\]/g, "ios.brand"],
  [/colors\.brand\[(500|600)\]/g, "ios.brand"],
  [/colors\.brand\[(700|800|900)\]/g, "ios.brandInk"],

  // Semantic palette
  [/colors\.navy\.DEFAULT/g, "ios.label"],
  [/colors\.navy\.light/g, "ios.brand"],
  [/colors\.surface\.raised/g, "ios.bg"],
  [/colors\.surface\.border/g, "ios.separator"],
  [/colors\.surface\.DEFAULT/g, "ios.bgElev"],
  [/colors\.success\.DEFAULT/g, "ios.system.green"],
  [/colors\.success\.bg/g, "ios.system.greenWash"],
  [/colors\.warning\.DEFAULT/g, "ios.system.orange"],
  [/colors\.warning\.bg/g, "ios.system.orangeWash"],
  [/colors\.danger\.DEFAULT/g, "ios.system.red"],
  [/colors\.danger\.bg/g, "ios.system.redWash"],

  // Common inline grays from the legacy blue brand
  [/"#94a3b8"/g, "ios.label2"],
  [/"#cbd5e1"/g, "ios.gray[3]"],
  [/"#64748b"/g, "ios.label2"],
  [/"#1B3A5C"/g, "ios.label"],
  [/"#2563EB"/g, "ios.brand"],
  [/"#0b6e6b"/g, "ios.brand"],
  [/"#0B6E6B"/g, "ios.brand"],

  // Import line — replace single-token imports with named ios import
  [/import\s*\{\s*colors\s*,\s*borderRadius\s*,\s*shadows\s*\}\s*from\s*"@routeflow\/ui\/tokens";/g,
    'import { ios, borderRadius, shadows } from "@routeflow/ui/tokens";'],
  [/import\s*\{\s*colors\s*,\s*borderRadius\s*\}\s*from\s*"@routeflow\/ui\/tokens";/g,
    'import { ios, borderRadius } from "@routeflow/ui/tokens";'],
  [/import\s*\{\s*colors\s*,\s*shadows\s*\}\s*from\s*"@routeflow\/ui\/tokens";/g,
    'import { ios, shadows } from "@routeflow/ui/tokens";'],
  [/import\s*\{\s*colors\s*\}\s*from\s*"@routeflow\/ui\/tokens";/g,
    'import { ios } from "@routeflow/ui/tokens";'],
  // Multi-line variants
  [/import\s*\{\s*borderRadius\s*,\s*colors\s*,\s*shadows\s*\}\s*from\s*"@routeflow\/ui\/tokens";/g,
    'import { ios, borderRadius, shadows } from "@routeflow/ui/tokens";'],
  [/import\s*\{\s*colors\s*,\s*(borderRadius|shadows)\s*\}\s*from\s*"@routeflow\/ui\/tokens";/g,
    (_m, kept) => `import { ios, ${kept} } from "@routeflow/ui/tokens";`],
];

let totalFiles = 0;
let totalReplacements = 0;

for (const rel of FILES) {
  const p = path.resolve(root, rel);
  if (!fs.existsSync(p)) {
    console.warn(`skip (missing): ${rel}`);
    continue;
  }
  const original = fs.readFileSync(p, "utf-8");
  let next = original;
  let perFileCount = 0;
  for (const [pattern, replacement] of replacements) {
    const before = next;
    next = next.replace(pattern, replacement);
    if (before !== next) {
      const occurrences = (before.match(pattern) ?? []).length;
      perFileCount += occurrences;
    }
  }
  if (next !== original) {
    fs.writeFileSync(p, next);
    totalFiles++;
    totalReplacements += perFileCount;
    console.log(`  ${rel} — ${perFileCount} token(s) swapped`);
  } else {
    console.log(`  ${rel} — no changes`);
  }
}

console.log(`\nDone. ${totalReplacements} replacements across ${totalFiles} files.`);
