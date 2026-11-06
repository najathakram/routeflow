import * as fs from "node:fs";
import * as path from "node:path";
import { API_SRC_ROOT, codeOnly } from "../testing/source-scan";

/**
 * L-353 class guard. `BillingService.createCheckoutSession` plans its anchor from `new Date()` and refuses
 * ("Checkout is paused around the start of the month.") from 10:29Z to 12:00Z on the 1st. A spec that calls the
 * REAL method on the wall clock therefore goes red for 91 minutes every month with no commit to blame. Every such
 * spec pins the clock (`pinWallClock`, or its own fake timers); a spec that reaches the method only through a mock
 * is not a caller and is not scanned.
 */

const REAL_SERVICE = /from\s+["']\.\/billing\.service["']/;
const CALLS_CHECKOUT = /\.createCheckoutSession\(/;
const PINS_CLOCK = /\bpinWallClock\(|\bjest\.useFakeTimers\(|\.setSystemTime\(/;

/** Specs that import the real service, call the method, and are clock-free by construction (reason beside each). */
const CLOCK_FREE: Record<string, string> = {
  // Refuses with PAYMENT_OVERDUE before the anchor is planned (billing.service.ts checks dunning first).
  "billing/dunning-wiring.billing.spec.ts": "refused before planCheckoutAnchor runs",
};

function specFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "dist") specFiles(full, out);
    } else if (/\.spec\.ts$/.test(e.name)) out.push(full);
  }
  return out;
}

/** Specs that call a real `createCheckoutSession` and do not pin the clock. */
export function unpinnedCheckoutCallers(files: Array<{ rel: string; text: string }>): string[] {
  return files
    .filter(({ text }) => {
      const code = codeOnly(text);
      return REAL_SERVICE.test(code) && CALLS_CHECKOUT.test(code) && !PINS_CLOCK.test(code);
    })
    .map(({ rel }) => rel);
}

describe("checkout specs pin the wall clock (L-353)", () => {
  it("detector: flags a real-service caller with no pin, passes a pinned one, ignores a mock-only spec", () => {
    const real =
      'import { BillingService } from "./billing.service";\nawait b.createCheckoutSession("t");';
    expect(unpinnedCheckoutCallers([{ rel: "a.spec.ts", text: real }])).toEqual(["a.spec.ts"]);
    expect(
      unpinnedCheckoutCallers([
        { rel: "b.spec.ts", text: `${real}\nbeforeEach(() => pinWallClock());` },
      ]),
    ).toEqual([]);
    expect(
      unpinnedCheckoutCallers([
        { rel: "c.spec.ts", text: `${real}\njest.useFakeTimers({ now: new Date("2026-11-15") });` },
      ]),
    ).toEqual([]);
    expect(
      unpinnedCheckoutCallers([
        {
          rel: "d.spec.ts",
          text: 'const billing = { createCheckoutSession: jest.fn() };\nbilling.createCheckoutSession("t");',
        },
      ]),
    ).toEqual([]);
    // a pin that exists only in a comment does not count
    expect(
      unpinnedCheckoutCallers([{ rel: "e.spec.ts", text: `${real}\n// pinWallClock() later` }]),
    ).toEqual(["e.spec.ts"]);
  });

  it("every spec that calls the real createCheckoutSession pins the clock (or is listed clock-free)", () => {
    const files = specFiles(API_SRC_ROOT).map((full) => ({
      rel: path.relative(API_SRC_ROOT, full).split(path.sep).join("/"),
      text: fs.readFileSync(full, "utf8"),
    }));
    // an empty scan must never report green: the two specs this guard was written for are in it
    const rels = files.map((f) => f.rel);
    expect(rels).toEqual(
      expect.arrayContaining([
        "billing/billing.checkout-anchor.spec.ts",
        "billing/trial-addon-checkout.spec.ts",
      ]),
    );
    const offenders = unpinnedCheckoutCallers(files).filter((rel) => !(rel in CLOCK_FREE));
    expect(offenders).toEqual([]);
  });

  it("the clock-free list names real files that still call the method", () => {
    for (const rel of Object.keys(CLOCK_FREE)) {
      const text = codeOnly(fs.readFileSync(path.join(API_SRC_ROOT, rel), "utf8"));
      expect(REAL_SERVICE.test(text) && CALLS_CHECKOUT.test(text)).toBe(true);
    }
  });
});
