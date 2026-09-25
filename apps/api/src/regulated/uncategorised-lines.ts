import {
  activeRuleWhere,
  resolveGoverningState,
  ruleStates,
} from "../selling-restrictions/selling-restrictions.core";
import { ADDRESS_SELECT } from "../selling-restrictions/selling-restrictions.service";
import type { ReportWarning } from "./report-types";

/**
 * F-05 (#2093, owner ruling 2026-09-25) — the "uncategorised lines" row. Custom (productless) lines are EXEMPT
 * from the ban check, so a tenant that sells a restricted item as a custom line is invisible to it. This is the
 * standing review list: every invoice line with NO catalog product, on a non-draft, non-void invoice issued in
 * the range, whose customer sits in a jurisdiction with an active selling rule. A tenant that wants such a line
 * checked adds it to the catalog.
 *
 * A customer is listed when a FEDERAL rule is active, when an active STATE rule names their governing state,
 * when a STATE rule is unreadable (it blocks everywhere, fail closed), or when their governing state cannot be
 * resolved (unknown is never assumed safe). Read-only; nothing here blocks or changes an invoice. Only runs
 * when the tenant has the engine switched ON.
 */
export async function uncategorisedLineWarnings(
  db: { sellingRestriction: any; invoiceItem: any },
  policy: { enabled: boolean; addressPrecedence: "BILLING_FIRST" | "SHIPPING_FIRST" },
  range: { from: Date; toExclusive: Date },
  now: Date = new Date(),
): Promise<ReportWarning[]> {
  if (!policy.enabled) return [];
  const rules: { jurisdiction: string; states: string[] }[] = await db.sellingRestriction.findMany({
    where: activeRuleWhere(now),
    select: { jurisdiction: true, states: true },
  });
  if (rules.length === 0) return [];
  const everywhere = rules.some(
    (r) =>
      r.jurisdiction === "FEDERAL" ||
      (r.states.some((s) => s.trim() !== "") && ruleStates(r as never).length === 0) ||
      r.states.length === 0,
  );
  const ruleStateSet = new Set(rules.flatMap((r) => ruleStates(r as never)));

  const items: {
    invoiceId: string;
    invoice: {
      invoiceNumber: string | null;
      customer: {
        businessName: string | null;
        addresses: {
          isDefault: boolean;
          addressType: string;
          stateCode: string | null;
          stateNeedsReview: boolean;
        }[];
      } | null;
    };
  }[] = await db.invoiceItem.findMany({
    where: {
      productId: null,
      invoice: {
        status: { notIn: ["DRAFT", "VOID"] },
        issueDate: { gte: range.from, lt: range.toExclusive },
      },
    },
    select: {
      invoiceId: true,
      invoice: {
        select: {
          invoiceNumber: true,
          customer: { select: { businessName: true, addresses: { select: ADDRESS_SELECT } } },
        },
      },
    },
  });

  const seen = new Set<string>();
  const out: ReportWarning[] = [];
  for (const it of items) {
    if (seen.has(it.invoiceId)) continue;
    seen.add(it.invoiceId);
    const customer = it.invoice.customer;
    const governing = resolveGoverningState(
      (customer?.addresses ?? []) as never,
      policy.addressPrecedence,
    );
    const listed = everywhere || !governing.resolved || ruleStateSet.has(governing.state);
    if (!listed) continue;
    const where = governing.resolved ? `in ${governing.state}` : "in an unknown state";
    out.push({
      code: "UNCATEGORISED_LINE_IN_RULE_STATE",
      message: `Invoice ${it.invoice.invoiceNumber ?? it.invoiceId} for ${customer?.businessName ?? "a customer"} (${where}) has a custom line with no catalog product, and a selling restriction is active there — review it. Add the item to the catalog to have it checked.`,
      invoiceId: it.invoiceId,
      ...(customer?.businessName ? { customerName: customer.businessName } : {}),
    });
  }
  return out;
}
