#!/usr/bin/env node
/**
 * #2338: writes local-assets/proofs/<PARITY_DATE>/native-parity/<role>/index.html, one row per
 * (screen, state) in screens.json order, with the web, iPhone and iPad captures side by side and a
 * visible "missing" cell where a capture is absent (so a reviewer never mistakes a gap for parity).
 *
 *   node scripts/native-parity/build-index.mjs --role buyer
 *   node scripts/native-parity/build-index.mjs --self-test
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { roleDir, parityDate } = require("./paths.cjs");

export const SURFACES = ["web", "ios", "ipad"];
const FILE = /^(.+)-(loaded|empty|loading|error)-(web|ios|ipad)\.png$/;

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/** Pure: rows in manifest order; each row lists which surfaces have a file. */
export function rows(manifestRows, files) {
  const have = new Set(files.filter((f) => FILE.test(f)));
  return manifestRows.flatMap((s) =>
    s.states.map((state) => ({
      screen: s.id,
      state,
      web: s.web,
      native: s.native,
      files: Object.fromEntries(
        SURFACES.map((surface) => {
          const f = `${s.id}-${state}-${surface}.png`;
          return [surface, have.has(f) ? f : null];
        }),
      ),
    })),
  );
}

/** Pure: the index page. */
export function renderIndex(role, date, rowList) {
  const cell = (f, label) =>
    f
      ? `<figure><img src="${escapeHtml(f)}" alt="${escapeHtml(label)}" loading="lazy"><figcaption>${escapeHtml(label)}</figcaption></figure>`
      : `<figure class="missing"><div>missing</div><figcaption>${escapeHtml(label)}</figcaption></figure>`;
  const body = rowList
    .map(
      (r) => `<section><h2>${escapeHtml(r.screen)} · ${escapeHtml(r.state)}</h2>
<p><code>${escapeHtml(r.web)}</code> ↔ <code>${escapeHtml(r.native)}</code></p>
<div class="grid">${SURFACES.map((s) => cell(r.files[s], s)).join("")}</div></section>`,
    )
    .join("\n");
  const missing = rowList.reduce((n, r) => n + SURFACES.filter((s) => !r.files[s]).length, 0);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Native parity · ${escapeHtml(role)} · ${escapeHtml(date)}</title>
<style>
body{font:14px/1.4 system-ui,sans-serif;margin:24px;background:#f7f9fc;color:#0f1b2d}
section{background:#fff;border:1px solid #e3e8ef;border-radius:10px;padding:16px;margin:0 0 16px}
h2{margin:0 0 4px;font-size:16px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
figure{margin:0}img{width:100%;height:auto;border:1px solid #e3e8ef;border-radius:6px}
.missing div{aspect-ratio:390/844;display:grid;place-items:center;border:2px dashed #c0392b;color:#c0392b;border-radius:6px}
figcaption{text-align:center;color:#5b6b80;margin-top:4px}
</style></head><body>
<h1>Native parity · ${escapeHtml(role)} · ${escapeHtml(date)}</h1>
<p>${rowList.length} screen-states · ${missing} missing capture(s). Review each pair against the gap note, not taste.</p>
${body}
</body></html>
`;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function selfTest() {
  const manifest = [
    { id: "home", web: "/w", native: "/n", states: ["loaded", "empty"] },
    { id: "cart", web: "/c", native: "/nc", states: ["empty"] },
  ];
  const r = rows(manifest, [
    "home-loaded-web.png",
    "home-loaded-ios.png",
    "cart-empty-ipad.png",
    "notes.txt",
  ]);
  const html = renderIndex("buyer", "2026-09-27", r);
  const cases = [
    [
      "3 screen-states in manifest order",
      r.map((x) => `${x.screen}-${x.state}`).join(","),
      "home-loaded,home-empty,cart-empty",
    ],
    [
      "present files found",
      `${r[0].files.web},${r[0].files.ios},${r[0].files.ipad}`,
      "home-loaded-web.png,home-loaded-ios.png,null",
    ],
    ["missing count in the header", /6 missing capture/.test(html) ? "yes" : "no", "yes"],
    ["html is escaped", renderIndex("<x>", "d", []).includes("&lt;x&gt;") ? "yes" : "no", "yes"],
  ];
  let ok = true;
  for (const [name, got, want] of cases) {
    const pass = got === want;
    ok &&= pass;
    console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : ` (got ${got})`}`);
  }
  process.exit(ok ? 0 : 1);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const role = arg("--role", "buyer");
  const manifest = JSON.parse(readFileSync(join(here, "screens.json"), "utf8"));
  const dir = roleDir(role);
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const out = join(dir, "index.html");
  writeFileSync(out, renderIndex(role, parityDate(), rows(manifest[role] ?? [], files)));
  console.log(`index: ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
