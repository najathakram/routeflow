// SA-744r2: the read-only census script cannot import the API's TypeScript, so
// scripts/lib/rf-calendar-windows.cjs mirrors calendar-windows.ts. This pins the two equal over random
// inputs (a change on one side alone is a red build), and runs the census script's own --self-test.
import { spawnSync } from "node:child_process";
import path from "node:path";
import * as ts from "./calendar-windows";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cjs = require("../../../scripts/lib/rf-calendar-windows.cjs");

const API_DIR = path.resolve(__dirname, "../../..");
const DAY = 24 * 60 * 60 * 1000;

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

describe("rf-calendar-windows.cjs mirrors calendar-windows.ts", () => {
  const rand = rng(7441);
  const instants: Date[] = [];
  for (let i = 0; i < 1500; i++) {
    instants.push(new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 4 * 365 * DAY)));
  }
  for (const off of [-48, -25, -24, -23, 0, 23, 24, 25, 48]) {
    instants.push(new Date(ts.boundary(2027, 1).getTime() + off * 3600 * 1000));
  }

  it("snap / aligned / next boundary agree", () => {
    for (const d of instants) {
      expect(cjs.isAligned(d)).toBe(ts.isAligned(d));
      expect(cjs.snapToBoundary(d).getTime()).toBe(ts.snapToBoundary(d).getTime());
      expect(cjs.nextBoundaryAfter(d).getTime()).toBe(ts.nextBoundaryAfter(d).getTime());
    }
  });

  it.each(["MONTHLY", "ANNUAL"] as const)(
    "nextBillingWindow agrees (%s), start AND end",
    (cycle) => {
      for (const d of instants) {
        const a = cjs.nextBillingWindow(d, cycle);
        const b = ts.nextBillingWindow(d, cycle);
        expect([a.periodStart.getTime(), a.periodEnd.getTime()]).toEqual([
          b.periodStart.getTime(),
          b.periodEnd.getTime(),
        ]);
      }
    },
  );

  it("effectiveCycle agrees on both sides of the 360-day line and for a null window", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    for (const days of [30, 90, 300, 359, 360, 364, 365, 400]) {
      const end = new Date(start.getTime() + days * DAY);
      for (const label of ["MONTHLY", "ANNUAL"]) {
        expect(cjs.effectiveCycle(label, start, end)).toBe(ts.effectiveCycle(label, start, end));
      }
    }
    expect(cjs.effectiveCycle("ANNUAL", null, null)).toBe(ts.effectiveCycle("ANNUAL", null, null));
  });

  it("alignFraction agrees with alignPart", () => {
    for (const d of instants.slice(0, 300)) {
      const b1 = ts.nextBoundaryAfter(d);
      const part = ts.alignPart(d, b1);
      const frac = cjs.alignFraction(d, b1);
      if (part.kind !== "ALIGN") throw new Error("alignPart must return an ALIGN part");
      expect(frac.daysRemaining).toBe(part.daysRemaining);
      expect(frac.daysInCycle).toBe(part.daysInCycle);
    }
  });
});

describe("report-rf-invoice-calendar-census.mjs", () => {
  it("--self-test passes with no database and exits 0", () => {
    const r = spawnSync(
      process.execPath,
      ["scripts/report-rf-invoice-calendar-census.mjs", "--self-test"],
      { cwd: API_DIR, encoding: "utf8", timeout: 60_000 },
    );
    expect(r.stderr).not.toMatch(/Error/);
    expect(r.stdout.trim()).toBe("self-test ok");
    expect(r.status).toBe(0);
  });

  it("is read-only: the session opens BEGIN READ ONLY and the file holds no write statement", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = require("node:fs").readFileSync(
      path.join(API_DIR, "scripts/report-rf-invoice-calendar-census.mjs"),
      "utf8",
    ) as string;
    expect(src).toContain('"BEGIN READ ONLY"');
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\s/);
  });
});
