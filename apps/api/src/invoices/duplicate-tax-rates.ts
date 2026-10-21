/**
 * Row 588 (SA-814c confirmation 3, P2): `duplicate()` must not copy a legacy 0 or a 4-dp-rounded line rate into a
 * new invoice. The copy re-totals from its own lines (B1043), so a copied 0 gives a $0-tax copy and a copied
 * 0.0888 gives 8.88% on a tenant that charges 8.875%: self-consistent, but at the wrong rate.
 *
 * The rule (SA-814c): the duplicate re-takes the VERIFIED inferred rate, or else the tenant's configured rate.
 *   1. Legacy 0: every goods line of the source is at 0 while its regular tax is above 0 (the B294 shape).
 *      `inferredGoodsFlatRate` is the ONE inference (@routeflow/pricing); its verified rate is stamped on the
 *      rate-0 goods lines, otherwise the tenant rate is (when the tenant has one).
 *   2. Rounded: a goods line whose rate equals the tenant rate at the legacy 4-dp precision (0.0888 for 8.875%,
 *      `sameRateAtLegacyPrecision`) but not exactly takes the tenant rate. Any other positive rate is a deliberate per-line rate and is copied as it is.
 * The NSF fee line is never taxed (#2656); an exempt customer's copy is $0 regular tax by construction.
 * The tenant rate is read lazily, only on the paths that need it.
 */
import { inferredGoodsFlatRate, isNsfLine, sameRateAtLegacyPrecision } from "@routeflow/pricing";

const EPS = 1e-9;
const to6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

type SourceLine = { taxRate?: unknown; categoryTaxAmount?: unknown } & Record<string, any>;

/** Stamps `copyLines[i].taxRate` (index-aligned with `sourceLines`) per the rule above. */
export async function retakeDuplicateTaxRates(
  source: { subtotal: unknown; taxAmount: unknown; isTaxExempt: boolean },
  sourceLines: ReadonlyArray<SourceLine>,
  copyLines: Array<{ taxRate: unknown }>,
  tenantFraction: () => Promise<number>,
): Promise<void> {
  if (source.isTaxExempt) return;
  const goods = (i: number) => !isNsfLine(sourceLines[i] as never);
  const inferred = inferredGoodsFlatRate({
    subtotal: source.subtotal,
    taxAmount: source.taxAmount,
    lines: sourceLines as never,
  });
  if (inferred) {
    const rate = inferred.verified ? inferred.rate : to6(await tenantFraction());
    if (!(rate > 0)) return;
    sourceLines.forEach((l, i) => {
      if (goods(i) && Number(l.taxRate ?? 0) === 0) copyLines[i].taxRate = rate;
    });
    return;
  }
  const candidates = sourceLines.filter((l, i) => goods(i) && Number(l.taxRate ?? 0) > 0);
  if (candidates.length === 0) return;
  const tenant = to6(await tenantFraction());
  if (!(tenant > 0)) return;
  sourceLines.forEach((l, i) => {
    const r = Number(l.taxRate ?? 0);
    // the ONE legacy-precision comparison (tax-precision.ts), shared with the receipt wording; equal rates are left as they are
    if (goods(i) && r > 0 && Math.abs(r - tenant) > EPS && sameRateAtLegacyPrecision(r, tenant))
      copyLines[i].taxRate = tenant;
  });
}
