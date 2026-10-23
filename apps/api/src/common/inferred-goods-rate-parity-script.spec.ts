import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inferredGoodsFlatRate, NSF_FEE_DESCRIPTION_PREFIX } from "@routeflow/pricing";
import { hydratedLineTax } from "../../../mobile/lib/invoice-edit-tax";

/**
 * #2656 / SA-549 — the three goods-only inferred-rate call sites agree on one fixture set:
 *   - the API's applyPriceAdjustment (invoices.service.ts) — pinned by source to call the shared
 *     helper on the locked invoice's lines;
 *   - mobile's invoice-edit hydration (`hydratedLineTax`) — fills a goods line with the rate when it
 *     verifies, else 0, and never fills an NSF line;
 *   - the b294 backfill's `classifyInvoice` (ESM, evaluated in a child node) — plans that rate.
 * All three must equal `inferredGoodsFlatRate` from @routeflow/pricing on every fixture.
 */
const B294_HREF = pathToFileURL(
  path.resolve(__dirname, "../../scripts/backfill-b294-order-line-taxrate.mjs"),
).href;
const NSF = { systemKind: "NSF_FEE", description: `${NSF_FEE_DESCRIPTION_PREFIX} #1` };
const PREFIX_ONLY = { systemKind: null, description: `${NSF_FEE_DESCRIPTION_PREFIX} #2` };
const goods = (subtotal: number) => ({
  taxRate: 0,
  subtotal,
  systemKind: null,
  description: "Cola",
});

const FIXTURES = [
  { name: "no NSF", subtotal: 100, taxAmount: 7.5, lines: [goods(100)] },
  {
    name: "stamped NSF",
    subtotal: 125,
    taxAmount: 7.5,
    lines: [goods(100), { taxRate: 0, subtotal: 25, ...NSF }],
  },
  {
    name: "prefix-only NSF",
    subtotal: 125,
    taxAmount: 7.5,
    lines: [goods(100), { taxRate: 0, subtotal: 25, ...PREFIX_ONLY }],
  },
  {
    name: "sub-cent fee sum (rounding)",
    subtotal: 137.3,
    taxAmount: 9.94,
    lines: [
      goods(112),
      { taxRate: 0, subtotal: 25.1, ...NSF },
      { taxRate: 0, subtotal: 0.2, ...NSF },
    ],
  },
  {
    name: "two goods lines + NSF",
    subtotal: 285,
    taxAmount: 21.66,
    lines: [goods(150), goods(110), { taxRate: 0, subtotal: 25, ...NSF }],
  },
];

describe("#2656 the three goods-rate call sites agree with @routeflow/pricing", () => {
  const before = "2026-09-01T00:00:00Z"; // before the b294 fix date, so an eligible row plans APPLY
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let b294: any[];
  beforeAll(() => {
    const code = `
      import { classifyInvoice } from "${B294_HREF}";
      const F = ${JSON.stringify(FIXTURES)};
      console.log(JSON.stringify(F.map((f) =>
        classifyInvoice({ subtotal: f.subtotal, taxAmount: f.taxAmount, createdAt: "${before}" }, f.lines))));
    `;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(res.stderr).toBe("");
    b294 = JSON.parse(res.stdout.trim());
  });

  it.each(FIXTURES.map((f, i) => [f.name, i] as const))("%s", (_name, i) => {
    const f = FIXTURES[i];
    const shared = inferredGoodsFlatRate(f);
    expect(shared).not.toBeNull();
    // b294 plans exactly the shared rate.
    expect(b294[i]?.rate).toBe(shared!.rate);
    // mobile fills every goods line with it when it verifies (0 otherwise), and never an NSF line.
    const hydrated = hydratedLineTax({
      subtotal: f.subtotal,
      taxAmount: f.taxAmount,
      items: f.lines,
    });
    f.lines.forEach((l, j) => {
      const isGoods = l.description === "Cola";
      expect(hydrated[j].taxRate).toBe(isGoods && shared!.verified ? shared!.rate : 0);
    });
  });

  it("review MUST-B: the backfill passes the tenant's settings.taxRate as the preferred rate (8.875%: $4.44 on $50.00 -> 0.08875, not 0.0888)", () => {
    const code = `
      import { classifyInvoice, tenantRateFraction } from "${B294_HREF}";
      const inv = { subtotal: 50, taxAmount: 4.44, createdAt: "${before}" };
      const lines = [{ taxRate: 0, categoryTaxAmount: 0 }];
      console.log(JSON.stringify({
        bare: classifyInvoice(inv, lines),
        tenant: classifyInvoice(inv, lines, undefined, tenantRateFraction("8.875")),
        fractions: ["8.875", "0", "abc", "150", null].map((v) => tenantRateFraction(v)),
      }));
    `;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(res.stderr).toBe("");
    const out = JSON.parse(res.stdout.trim());
    expect(out.bare).toMatchObject({ kind: "APPLY", rate: 0.0888 });
    expect(out.tenant).toMatchObject({ kind: "APPLY", rate: 0.08875 }); // master: 0.0888
    expect(out.fractions).toEqual([0.08875, null, null, null, null]);
  });

  it("the API's applyPriceAdjustment reaches the shared helper through the one stored-tax guard", () => {
    const dir = path.resolve(__dirname, "../invoices");
    // SA-814 R5-2: the inference lives in stored-tax-state.ts (the guard), imported from the shared package.
    const guard = readFileSync(path.join(dir, "stored-tax-state.ts"), "utf8");
    expect(guard).toMatch(/inferredGoodsFlatRate\(\s*\{/);
    expect(guard).toMatch(/\binferredGoodsFlatRate,\n[\s\S]*?\} from "@routeflow\/pricing";/);
    // The locked invoice's lines go through it: applyPriceAdjustment's tx and the bulk pre-flight.
    const svc = readFileSync(path.join(dir, "invoices.service.ts"), "utf8");
    expect(svc).toMatch(/priceAdjustmentTaxState\(live,/);
    const ledger = readFileSync(path.join(dir, "price-adjustment-ledger.ts"), "utf8");
    expect(ledger).toMatch(/storedLines: inv\.items/);
  });
});
