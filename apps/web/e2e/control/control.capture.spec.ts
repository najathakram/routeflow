import { expect, test, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

// Start the control server first with the write path switched on (it is off by default, and these
// captures drive Save / Dismiss / Make next):
//   CONTROL_LOCAL=1 CONTROL_WRITEBACK=on CONTROL_FIXTURE=apps/control/test/fixtures/acme CONTROL_PORT=4317 node apps/control/dist/main.js
// Proofs go to the gitignored local-assets/ (never into git); override with CONTROL_PROOF_DIR.
const OUT =
  process.env.CONTROL_PROOF_DIR ??
  path.resolve(__dirname, "../../../../local-assets/proofs/control");
const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
] as const;
const SCHEMES = ["light", "dark"] as const;
const PANEL_ORDER = [
  "lanes",
  "blockers",
  "waste",
  "release",
  "queue",
  "bugs",
  "prs",
  "overlap",
  "piggyback",
  "phases",
  "timeline",
  "sources",
];
const H2 = [
  "Who is doing what",
  "Stuck work",
  "Work at risk of being wasted",
  "Releases",
  "Up next",
  "Bugs",
  "Open pull requests",
  "Lanes touching the same files",
  "Quick wins nearby",
  "Feature progress",
  "Recent activity",
  "Where this data comes from",
];
const PRIO = ["P0", "P1", "P2", "P3"];

fs.mkdirSync(OUT, { recursive: true });

async function watch(page: Page) {
  const errors: string[] = [];
  const failed: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("requestfailed", (r) => {
    if (!r.url().endsWith("/api/stream"))
      failed.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().endsWith("/api/event"))
      failed.push(`${r.status()} ${r.url()}`);
  });
  return { errors, failed };
}

async function open(page: Page) {
  await page.goto("/");
  await expect(page.locator("section[data-panel]")).toHaveCount(12);
  await page.waitForTimeout(500);
}

const firstTask = (page: Page) => page.locator(".tid[data-task]:visible").first();

for (const vp of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`${vp.name} ${scheme}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme });

      test("load", async ({ page }) => {
        const w = await watch(page);
        await open(page);
        const keys = await page
          .locator("section[data-panel]")
          .evaluateAll((s) => s.map((x) => x.getAttribute("data-panel")));
        expect(keys).toEqual(PANEL_ORDER);
        const heads = await page.locator("section[data-panel] > h2").allInnerTexts();
        expect(heads.length).toBe(12);
        H2.forEach((t, i) =>
          expect(heads[i].trim().startsWith(t), `${heads[i]} vs ${t}`).toBe(true),
        );
        const over = await page.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          iw: window.innerWidth,
        }));
        expect(over.sw).toBeLessThanOrEqual(over.iw);
        const tones = await page
          .locator(".lines .line")
          .evaluateAll((ls) => ls.map((l) => l.querySelectorAll("[data-tone]").length));
        tones.forEach((n) => expect(n).toBeLessThanOrEqual(1));
        expect(w.errors).toEqual([]);
        expect(w.failed).toEqual([]);
      });

      test("drawer", async ({ page }) => {
        await open(page);
        const opener = firstTask(page);
        await opener.click();
        const drawer = page.locator("#drawer");
        await expect(drawer).toBeVisible();
        for (let i = 0; i < 14; i++) {
          await page.keyboard.press("Tab");
          expect(await page.evaluate(() => !!document.activeElement?.closest("#drawer"))).toBe(
            true,
          );
        }
        await page.keyboard.press("Shift+Tab");
        expect(await page.evaluate(() => !!document.activeElement?.closest("#drawer"))).toBe(true);
        await page.keyboard.press("Escape");
        await expect(drawer).toBeHidden();
        const same = await opener.evaluate((n) => n === document.activeElement);
        expect(same).toBe(true);
      });

      test("confirmed write + undo", async ({ page }) => {
        await open(page);
        const opener = firstTask(page);
        const id = (await opener.getAttribute("data-task"))!;
        const row = page.locator(`.tid[data-task="${id}"]`).first();
        const old = (await row.getAttribute("data-priority"))!;
        const next = PRIO.find((p) => p !== old)!;
        await opener.click();
        await page.route("**/api/event", async (r) => {
          await new Promise((res) => setTimeout(res, 500));
          await r.continue();
        });
        await page.locator("#f-0").selectOption(next);
        const post = page.waitForResponse((r) => r.url().endsWith("/api/event"));
        await page.locator("#f-0 ~ button").click();
        await page.waitForTimeout(150);
        expect(await row.getAttribute("data-priority")).toBe(old); // not yet confirmed
        expect((await post).status()).toBe(200);
        await expect(row).toHaveAttribute("data-priority", next);
        await page.unroute("**/api/event");
        await page.locator("#toasts .toast button", { hasText: "Undo" }).click();
        await expect(row).toHaveAttribute("data-priority", old);
      });

      test("failure 500", async ({ page }) => {
        await open(page);
        const opener = firstTask(page);
        const id = (await opener.getAttribute("data-task"))!;
        const row = page.locator(`.tid[data-task="${id}"]`).first();
        const old = (await row.getAttribute("data-priority"))!;
        await opener.click();
        await page.route("**/api/event", (r) =>
          r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"x"}' }),
        );
        await page.locator("#f-0").selectOption(PRIO.find((p) => p !== old)!);
        await page.locator("#f-0 ~ button").click();
        await expect(page.locator("#drawer .err")).toBeVisible();
        await page.waitForTimeout(300);
        expect(await row.getAttribute("data-priority")).toBe(old);
      });

      test("conflict 409", async ({ page }) => {
        await open(page);
        const opener = firstTask(page);
        const id = (await opener.getAttribute("data-task"))!;
        const old = (await page
          .locator(`.tid[data-task="${id}"]`)
          .first()
          .getAttribute("data-priority"))!;
        await opener.click();
        await page.route("**/api/event", (r) =>
          r.fulfill({ status: 409, contentType: "application/json", body: '{"error":"conflict"}' }),
        );
        const reload = page.waitForRequest((r) => r.url().includes("/api/state.json"));
        await page.locator("#f-0").selectOption(PRIO.find((p) => p !== old)!);
        await page.locator("#f-0 ~ button").click();
        await reload;
        await expect(page.locator("#toasts .toast.error", { hasText: "refreshed" })).toBeVisible();
      });

      test("a11y basics", async ({ page }) => {
        await open(page);
        const axePkg = "@axe-core/playwright"; // optional dep: variable specifier skips type resolution
        let axeResults: unknown = null;
        try {
          const AxeBuilder = (await import(/* @vite-ignore */ axePkg)).default;
          axeResults = (await new AxeBuilder({ page }).analyze()).violations;
        } catch {
          /* axe not installed: basic checks below */
        }
        const v: string[] = [];
        const r = await page.evaluate(() => {
          const out: string[] = [];
          const q = (s: string) => document.querySelectorAll(s).length;
          if (q("h1") !== 1) out.push(`h1 count ${q("h1")}`);
          for (const s of ["header", "nav", "main", "footer"])
            if (!q(s)) out.push(`missing landmark ${s}`);
          document.querySelectorAll("button, a[href], select, input, textarea").forEach((n) => {
            const el = n as HTMLElement;
            const name =
              el.getAttribute("aria-label") ||
              el.textContent?.trim() ||
              (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent) ||
              "";
            if (!name) out.push(`unnamed ${el.tagName} ${el.className}`);
          });
          return out;
        });
        v.push(...r);
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        const ring = await page.evaluate(() => {
          const s = getComputedStyle(document.activeElement!);
          return { w: s.outlineWidth, st: s.outlineStyle, sh: s.boxShadow };
        });
        if (ring.st === "none" && ring.sh === "none") v.push("no visible focus ring after Tab");
        console.log(
          `A11Y ${vp.name}-${scheme} axe=${axeResults === null ? "n/a" : JSON.stringify(axeResults)} basic=${JSON.stringify(v)}`,
        );
        expect(v).toEqual([]);
      });

      test("capture", async ({ page }) => {
        await open(page);
        await page.screenshot({
          path: path.join(OUT, `control-${vp.name}-${scheme}.png`),
          fullPage: true,
        });
      });
    });
  }
}
