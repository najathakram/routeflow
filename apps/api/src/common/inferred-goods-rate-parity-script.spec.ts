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

  it("the API's applyPriceAdjustment calls the shared helper on the locked invoice's lines", () => {
    const src = readFileSync(path.resolve(__dirname, "../invoices/invoices.service.ts"), "utf8");
    expect(src).toMatch(/inferredGoodsFlatRate\(\{ \.\.\.live, lines: live\.items \}\)/);
    // Imported from the shared package; later names in the same import list do not matter.
    expect(src).toMatch(/inferredGoodsFlatRate,\n(?:\s+\w+,\n)*\} from "@routeflow\/pricing";/);
  });
});
