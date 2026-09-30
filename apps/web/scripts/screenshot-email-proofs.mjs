#!/usr/bin/env node
/**
 * Brand restyle proof (2026-09-17) — screenshots each rendered email proof HTML file
 * (`apps/api/scripts/render-email-brand-proofs.ts` writes them) at 600px (desktop email
 * client width) and 375px (phone) so the restyle can be reviewed visually. No dev server,
 * no docker — opens each `file://` URL directly in headless Chromium.
 *
 * Run from the repo root (after the render script has written the *.html proofs):
 *   node apps/web/scripts/screenshot-email-proofs.mjs
 */
import { chromium } from "@playwright/test";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = path.resolve(__dirname, "../../../local-assets/proofs/2026-09-17/email-brand");

const VIEWPORTS = [
  { name: "600", width: 600, height: 900 },
  { name: "375", width: 375, height: 900 },
];

async function main() {
  const files = readdirSync(PROOF_DIR).filter((f) => f.endsWith(".html"));
  if (files.length === 0) {
    console.error(
      `No *.html proofs found in ${PROOF_DIR} — run apps/api/scripts/render-email-brand-proofs.ts first.`,
    );
    process.exit(1);
  }

  const browser = await chromium.launch();
  try {
    for (const file of files) {
      const name = file.replace(/\.html$/, "");
      const url = pathToFileURL(path.join(PROOF_DIR, file)).href;
      for (const vp of VIEWPORTS) {
        const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
        await page.goto(url);
        // Full-page so the screenshot captures the whole email, not just the first viewport.
        const outPath = path.join(PROOF_DIR, `${name}-${vp.name}px.png`);
        await page.screenshot({ path: outPath, fullPage: true });
        console.log(`wrote ${outPath}`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
