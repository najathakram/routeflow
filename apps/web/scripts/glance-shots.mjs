// Glance-test screenshots for the marketing site (W-1095 / website W0, rf-specs COPY.md section 0).
//
// Shoots one page at 1440 and 390 wide so fresh readers can be shown ONE image and nothing else.
// Before the shot it makes the picture a fair test of "understood in a second":
//   - text under 20 px is blurred by 6 px (nobody reads it in a second, so it must not help),
//   - the product name is swapped for a made-up one (a reader must not lean on a known brand),
//   - the logo is hidden,
//   - motion is off and the shot is taken at first paint, with no click.
//
// No new dependency: it uses the Playwright that apps/web already has.
//
//   node apps/web/scripts/glance-shots.mjs --piece w0 [--url http://localhost:3001] [--path /]
//        [--brand Northbay] [--out local-assets/proofs/website-review/<piece>] [--chrome <path>]
//
// Proofs go to local-assets/proofs/website-review/<piece>/ (gitignored), never into git.
// The runbook is docs/runbooks/glance-test.md.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const VIEWS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];
const BLUR_BELOW_PX = 20;
const BLUR_PX = 6;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const piece = arg("piece", "adhoc");
const baseUrl = arg("url", "http://localhost:3001").replace(/\/$/, "");
const route = arg("path", "/");
const brand = arg("brand", "Northbay");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = path.resolve(
  arg("out", path.join(repoRoot, "local-assets", "proofs", "website-review", piece)),
);
mkdirSync(outDir, { recursive: true });

// Runs in the page, and again whenever React re-renders (a hydration pass can rebuild the text
// nodes this wrapped, so one run is not enough). It is idempotent. Order matters: swap names first,
// hide the logo, then blur what is left small.
function prepare({ brand, blurBelow, blurPx }) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const node of texts) {
    if (node.nodeValue.includes("RouteFlow"))
      node.nodeValue = node.nodeValue.replace(/RouteFlow/g, brand);
  }
  document.title = document.title.replace(/RouteFlow/g, brand);

  for (const el of document.querySelectorAll(
    '[aria-label*="RouteFlow" i], .brand, .brand-mark, header a[href="/"] svg, header a[href="/"] img, footer .brand',
  )) {
    el.style.visibility = "hidden";
  }
  for (const img of document.querySelectorAll("[alt]")) {
    const alt = img.getAttribute("alt");
    if (alt.includes("RouteFlow")) img.setAttribute("alt", alt.replace(/RouteFlow/g, brand));
  }

  // Blur text under the cut-off. Wrap each small text node so a large heading is never blurred by
  // a small parent, and a small label never escapes by sitting inside a large block.
  for (const node of texts) {
    if (!node.nodeValue.trim() || !node.parentElement) continue;
    const parent = node.parentElement;
    if (parent.closest("[data-glance]")) continue;
    if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) continue;
    const size = parseFloat(getComputedStyle(parent).fontSize);
    if (size >= blurBelow) continue;
    const span = document.createElement("span");
    span.dataset.glance = "1";
    span.style.filter = `blur(${blurPx}px)`;
    span.style.display = "inline-block";
    parent.replaceChild(span, node);
    span.appendChild(node);
  }
}

// Runs in the page after prepare(): counts what a reader could still read that they must not.
function audit({ blurBelow }) {
  let readableSmall = 0;
  let brandLeft = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent || !node.nodeValue.trim()) continue;
    if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) continue;
    if (node.nodeValue.includes("RouteFlow")) brandLeft += 1;
    const box = parent.getBoundingClientRect();
    if (box.bottom < 0 || box.top > innerHeight || box.width === 0) continue; // not in the first screen
    if (
      parseFloat(getComputedStyle(parent).fontSize) < blurBelow &&
      !parent.closest("[data-glance]")
    ) {
      readableSmall += 1;
    }
  }
  return { readableSmall, brandLeft };
}

// --chrome <path> (or GLANCE_CHROME) picks a browser binary when the installed Playwright build
// does not match the one on disk.
const executablePath = arg("chrome", process.env.GLANCE_CHROME);
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  for (const view of VIEWS) {
    const context = await browser.newContext({
      viewport: { width: view.width, height: view.height },
      reducedMotion: "reduce",
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle" });
    await page.addStyleTag({
      content:
        "*,*::before,*::after{animation:none!important;transition:none!important}" +
        " nextjs-portal{display:none!important}",
    });
    const opts = { brand, blurBelow: BLUR_BELOW_PX, blurPx: BLUR_PX };
    await page.evaluate(prepare, opts);
    // Re-apply after any re-render, then prove nothing small is still readable. A silent miss would
    // hand the readers an unblurred, branded page, which is not the test.
    let left = { readableSmall: 1, brandLeft: 0 };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await page.waitForTimeout(800);
      await page.evaluate(prepare, opts);
      left = await page.evaluate(audit, opts);
      if (left.readableSmall === 0 && left.brandLeft === 0) break;
    }
    if (left.readableSmall !== 0 || left.brandLeft !== 0) {
      throw new Error(
        `glance-shots: ${view.name} still shows readable small text or the product name: ${JSON.stringify(left)}`,
      );
    }
    const file = path.join(outDir, `${piece}-${view.name}-${view.width}.png`);
    // First screen only: a reader sees what the page shows at first paint, not the whole page.
    await page.screenshot({ path: file, fullPage: false });
    // eslint-disable-next-line no-console -- CLI output
    console.log(`glance-shots: ${file}`);
    await context.close();
  }
} finally {
  await browser.close();
}
