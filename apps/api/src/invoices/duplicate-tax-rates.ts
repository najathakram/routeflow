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
 *   3. Untaxed source (lead ruling, review of cfe158c25): every goods line at 0 AND no regular tax on the source (for
 *      example it was issued while the customer was exempt), but the CURRENT customer is taxable: the copy follows the
 *      current customer, so the tenant rate is stamped (when the tenant has one).
 * The NSF fee line is never taxed (#2656); an exempt CURRENT customer's copy is $0 regular tax by construction (the
 * exemption is read from the current customer: a duplicate is a new invoice). The tenant rate is read lazily, only on
 * the paths that need it, and is the `preferredRate` of the inference (it wins when it reproduces the stored tax).
 */
import { isNsfLine, roundMoney, sameRateAtLegacyPrecision } from "@routeflow/pricing";
import { inferredGoodsRateForCopy } from "./stored-tax-state";

const EPS = 1e-9;
const to6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

type SourceLine = { taxRate?: unknown; categoryTaxAmount?: unknown } & Record<string, any>;

/** Stamps `copyLines[i].taxRate` (index-aligned with `fromLines`) per the rule above. */
export async function retakeDuplicateTaxRates(
  source: { subtotal: unknown; taxAmount: unknown; isTaxExempt: boolean },
  fromLines: ReadonlyArray<SourceLine>,
  copyLines: Array<{ taxRate: unknown }>,
  tenantFraction: () => Promise<number>,
): Promise<void> {
  if (source.isTaxExempt) return;
  const goods = (i: number) => !isNsfLine(fromLines[i] as never);
  const infer = (preferredRate?: number) =>
    inferredGoodsRateForCopy(
      { subtotal: source.subtotal, taxAmount: source.taxAmount, lines: fromLines },
      { preferredRate },
    );
  const stampZero = (rate: number) =>
    fromLines.forEach((l, i) => {
      if (goods(i) && Number(l.taxRate ?? 0) === 0) copyLines[i].taxRate = rate;
    });
  if (infer()) {
    const tenant = to6(await tenantFraction());
    const inferred = infer(tenant > 0 ? tenant : undefined)!;
    const rate = inferred.verified ? inferred.rate : tenant;
    if (rate > 0) stampZero(rate);
    return;
  }
  const goodsRates = fromLines.filter((_, i) => goods(i)).map((l) => Number(l.taxRate ?? 0));
  if (goodsRates.length > 0 && goodsRates.every((r) => r === 0)) {
    // all goods at 0 and nothing to infer: only an UNTAXED source (no regular tax) takes the current customer's rate
    const levy = fromLines.reduce((s, l) => s + Number(l.categoryTaxAmount ?? 0), 0);
    if (roundMoney(Number(source.taxAmount ?? 0) - levy) > 0) return;
    const tenant = to6(await tenantFraction());
    if (tenant > 0) stampZero(tenant);
    return;
  }
  if (goodsRates.every((r) => !(r > 0))) return;
  const tenant = to6(await tenantFraction());
  if (!(tenant > 0)) return;
  fromLines.forEach((l, i) => {
    const r = Number(l.taxRate ?? 0);
    // the ONE legacy-precision comparison (tax-precision.ts), shared with the receipt wording; equal rates are left as they are
    if (goods(i) && r > 0 && Math.abs(r - tenant) > EPS && sameRateAtLegacyPrecision(r, tenant))
      copyLines[i].taxRate = tenant;
  });
}
