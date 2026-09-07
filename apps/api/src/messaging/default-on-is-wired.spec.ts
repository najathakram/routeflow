/**
 * F23 / B180 (T5) — static guard: every `DEFAULT_ON` key in `messaging-config.service.ts` must
 * have a firing site — a `NotificationEvent.<KEY>` reference — somewhere in `apps/api/src`
 * OUTSIDE the `messaging/` module and outside `*.spec.ts` files. A key seeded ON with no trigger
 * anywhere is a notification the tenant is told is live but that will never fire
 * (cause-ruling.md §1, B180). This walks the tree instead of asserting per-event, so a NEW
 * unwired key added to `DEFAULT_ON` later fails here rather than shipping silently.
 *
 * Precedent: `apps/api/src/common/no-bare-cron.spec.ts` (walk-the-tree static guard).
 */

import * as fs from "fs";
import * as path from "path";
import { DEFAULT_ON } from "./messaging-config.service";

const SRC_ROOT = path.resolve(__dirname, "..");
const MESSAGING_DIR = path.resolve(__dirname);

/**
 * Events allowed to stay unwired despite having no firing site today, with the reason recorded
 * here. Deliberately EMPTY (cause-ruling.md §2): the fix drops every currently-unwired
 * `DEFAULT_ON` key instead of allowlisting it — FAILED_DELIVERY specifically stays out because
 * B146/F11 reconciles a skipped stop but never emits the event (S3 check on 12cdc26a).
 */
const ALLOWLIST: string[] = [];

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      if (full === MESSAGING_DIR) continue; // the messaging module itself never counts as a trigger
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

const FILES = collectSourceFiles(SRC_ROOT);
const SOURCES = FILES.map((file) => fs.readFileSync(file, "utf8"));

/** The distinct NotificationEvent keys DEFAULT_ON currently seeds ON (channel suffix stripped). */
const DEFAULT_ON_EVENTS = [...new Set([...DEFAULT_ON].map((key) => key.split(":")[0]))];

function hasFiringSite(eventKey: string): boolean {
  const needle = `NotificationEvent.${eventKey}`;
  return SOURCES.some((text) => text.includes(needle));
}

/**
 * Harness-integrity pins for the scanner above. These assert behavior that ALREADY holds today,
 * so they can never be red — they exist only to stop an empty/broken walk from reporting green.
 * They live in their own describe, with no REG-B token in the name, so the red gate
 * (`-t "REG-B(...)"`) does not collect them.
 */
describe("default-on-is-wired — scanner harness integrity (pin; outside the red gate)", () => {
  it("walks a non-trivial number of source files (guards against an empty scan reporting green)", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it("sees at least one already-wired DEFAULT_ON event (parser sanity: OUT_FOR_DELIVERY fires from orders.service.ts)", () => {
    expect(hasFiringSite("OUT_FOR_DELIVERY")).toBe(true);
  });

  it("does NOT see a firing site for a known-unwired event (negative control; re-point at another unwired key if LOW_STOCK ever gains a trigger)", () => {
    expect(hasFiringSite("LOW_STOCK")).toBe(false);
  });
});

describe("DEFAULT_ON keys are all wired to a firing site (F23 / T5)", () => {
  it("REG-B180: has zero DEFAULT_ON keys with no firing site outside messaging/ and outside an explicit (empty) allowlist", () => {
    const unwired = DEFAULT_ON_EVENTS.filter(
      (eventKey) => !hasFiringSite(eventKey) && !ALLOWLIST.includes(eventKey),
    );

    expect(unwired).toEqual([]);
  });
});
