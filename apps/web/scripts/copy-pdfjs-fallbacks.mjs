#!/usr/bin/env node
/**
 * W-1064 (SA-1074 A-1): pdf.js decodes JBIG2 and JPX scans with these two JavaScript files when wasm is off. Without them a
 * scanned page draws white with no error, so `prebuild` and `predev` copy them from the installed package to `public/pdfjs/`,
 * which is gitignored: they follow the exact pin and stay out of git. A missing file exits non-zero, so a build fails instead
 * of shipping white pages. `--from` and `--to` are for the test.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILES = ["jbig2_nowasm_fallback.js", "openjpeg_nowasm_fallback.js"];

const argValue = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const packageDir = () =>
  path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

const from = argValue("--from") ?? path.join(packageDir(), "wasm");
const to =
  argValue("--to") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/pdfjs");

const missing = FILES.filter((file) => !existsSync(path.join(from, file)));
if (missing.length > 0) {
  console.error(`copy-pdfjs-fallbacks: ${missing.join(", ")} not found in ${from}`);
  process.exit(1);
}
mkdirSync(to, { recursive: true });
for (const file of FILES) copyFileSync(path.join(from, file), path.join(to, file));
