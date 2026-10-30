/**
 * Row 590 (SA-1000 §2) — structural census of the office-DELIVERED stop check and the stale-run-link release.
 *
 * A class, not an instance: every path that writes an order to DELIVERED, or releases its link to a finished run, must go
 * through the ONE helper. This walks `apps/api/src` (non-spec files) and pins the callers, so a new path that skips the helper,
 * or a second hand-written copy of the 409, fails here instead of reopening the dead-end (a pickup completed at the counter
 * that claims its hand-over and then 409s on every retry).
 */

import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collect(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) {
      out.push(full);
    }
  }
  return out;
}

const FILES = collect(SRC_ROOT).map((full) => ({
  rel: path.relative(SRC_ROOT, full).split(path.sep).join("/"),
  text: fs.readFileSync(full, "utf8"),
}));

/** Files holding a CALL of `name(` (not its declaration, not a comment line). */
function callers(name: string): string[] {
  const call = new RegExp(`(?<!function\\s)\\b${name}\\(`);
  return FILES.filter(({ text }) =>
    text.split("\n").some((line) => {
      const t = line.trim();
      if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return false;
      return (
        call.test(line) && !/\bfunction\s/.test(line) && !/\bexport\s+async\s+function\b/.test(line)
      );
    }),
  )
    .map((f) => f.rel)
    .sort();
}

function callCount(rel: string, name: string): number {
  const file = FILES.find((f) => f.rel === rel);
  if (!file) return 0;
  return file.text.split("\n").filter((l) => {
    const t = l.trim();
    return (
      !t.startsWith("*") &&
      !t.startsWith("//") &&
      !/\bfunction\s/.test(l) &&
      new RegExp(`\\b${name}\\(`).test(l)
    );
  }).length;
}

describe("row 590: the office-DELIVERED stop check and the run-link release have one home", () => {
  it("only office-delivered-route-stop.ts throws ORDER_DELIVERED_ON_ROUTE_STOP", () => {
    const throwers = FILES.filter(
      ({ rel, text }) =>
        rel !== "common/api-error-codes.ts" &&
        /API_ERROR_CODES\.ORDER_DELIVERED_ON_ROUTE_STOP/.test(text),
    ).map((f) => f.rel);
    expect(throwers).toEqual(["orders/office-delivered-route-stop.ts"]);
  });

  it("assertStopDoneForOfficeDelivered is called by the office status change and the counter pickup completion only", () => {
    expect(callers("assertStopDoneForOfficeDelivered")).toEqual([
      "orders/counter-sale/pickup-complete.service.ts",
      "orders/orders.service.ts",
    ]);
  });

  it("the finished-run release is written once and called by the path switch (twice: one write) and the stale-link release", () => {
    expect(callers("releaseFinishedRunLink")).toEqual(["orders/order-lifecycle.ts"]);
    // releaseStaleRunLink + updateFulfillPathImpl's write: two call sites, both in order-lifecycle.ts.
    expect(callCount("orders/order-lifecycle.ts", "releaseFinishedRunLink")).toBe(2);
  });

  it("releaseStaleRunLink is called by the counter pickup completion only, once", () => {
    expect(callers("releaseStaleRunLink")).toEqual([
      "orders/counter-sale/pickup-complete.service.ts",
    ]);
    expect(callCount("orders/counter-sale/pickup-complete.service.ts", "releaseStaleRunLink")).toBe(
      1,
    );
  });
});
