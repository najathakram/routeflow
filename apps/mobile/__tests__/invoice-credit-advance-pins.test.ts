/**
 * B421 (R8) — source-text pins that both mobile invoice detail screens read
 * the new `creditApplied`/`advanceApplied` fields. Nothing renders under
 * mobile Jest (`jest.config.js` — `testEnvironment: "node"`), so this reads
 * each screen as text and pins the wiring, never a rendered tree, mirroring
 * `scan-affordance-siblings.test.ts`'s established style.
 *
 * Both screens already read the server's `paidAmount`/`balanceDue` with NO
 * local re-derivation from a `payments` array, so those two fields needed no
 * code change for B421 — the server now sends the corrected values. This
 * file pins the ADDITIVE part: the two new fields are typed AND surfaced.
 */
import { readFileSync } from "fs";
import { join } from "path";

describe("(customer)/invoices/[id].tsx reads creditApplied/advanceApplied (B421)", () => {
  const SCREEN_PATH = join(__dirname, "..", "app", "(customer)", "invoices", "[id].tsx");
  const source = readFileSync(SCREEN_PATH, "utf8");

  it("reads both new fields off the invoice, defaulting to 0", () => {
    expect(source).toMatch(/invoice\.creditApplied \?\? 0/);
    expect(source).toMatch(/invoice\.advanceApplied \?\? 0/);
  });

  it("renders a Credit issued / Advance applied row only when the confirmed amount is > 0", () => {
    expect(source).toMatch(/showCredit \? \(\s*<DetailRow[\s\S]{0,80}label="Credit issued"/);
    expect(source).toMatch(/showAdvance \? \(\s*<DetailRow[\s\S]{0,80}label="Advance applied"/);
  });
});

describe("(operator)/(tabs)/invoices/[id].tsx reads creditApplied/advanceApplied (B421)", () => {
  const SCREEN_PATH = join(__dirname, "..", "app", "(operator)", "(tabs)", "invoices", "[id].tsx");
  const source = readFileSync(SCREEN_PATH, "utf8");

  it("reads both new fields off the invoice, defaulting to 0", () => {
    expect(source).toMatch(/invoice\.creditApplied \?\? 0/);
    expect(source).toMatch(/invoice\.advanceApplied \?\? 0/);
  });

  it("surfaces both figures in the paid/balance summary line, neutral wording (operator surface)", () => {
    expect(source).toMatch(/Credits applied/);
    expect(source).toMatch(/Advance applied/);
  });
});

describe("BuyerInvoice / AdminInvoice types declare the new fields (B421)", () => {
  it("lib/api/buyer.ts BuyerInvoice has creditApplied/advanceApplied", () => {
    const source = readFileSync(join(__dirname, "..", "lib", "api", "buyer.ts"), "utf8");
    const iface = (source.match(/export interface BuyerInvoice \{[\s\S]*?\n\}/) ?? [""])[0];
    expect(iface).toMatch(/creditApplied\?: number/);
    expect(iface).toMatch(/advanceApplied\?: number/);
  });

  it("lib/api/admin.ts AdminInvoice has creditApplied/advanceApplied", () => {
    const source = readFileSync(join(__dirname, "..", "lib", "api", "admin.ts"), "utf8");
    const iface = (source.match(/export interface AdminInvoice \{[\s\S]*?\n\}/) ?? [""])[0];
    expect(iface).toMatch(/creditApplied\?: number/);
    expect(iface).toMatch(/advanceApplied\?: number/);
  });
});
