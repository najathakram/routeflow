import {
  resolveGoverningState,
  ruleIsActive,
  ruleStates,
} from "../selling-restrictions/selling-restrictions.core";
import { ADDRESS_SELECT } from "../selling-restrictions/selling-restrictions.service";
import { NSF_FEE_DESCRIPTION_PREFIX } from "../sales-agents/commission-math";
import type { ReportWarning } from "./report-types";

/**
 * F-05 (#2093, owner ruling 2026-09-25) — the "uncategorised lines" row. Custom (productless) lines are EXEMPT
 * from the ban check, so a tenant that sells a restricted item as a custom line is invisible to it. This is the
 * standing review list: every invoice with a line that has NO catalog product, non-draft and non-void, issued in
 * the range, whose customer sat in a jurisdiction with a selling rule active WHEN THE INVOICE WAS ISSUED (a rule
 * lifted later still flags the period it covered). A tenant that wants such a line
 * checked adds it to the catalog.
 *
 * A customer is listed when a FEDERAL rule was active, when an active STATE rule names their governing state,
 * when a STATE rule is unreadable or blank or of an unrecognised jurisdiction (it blocks everywhere, fail
 * closed), or when their governing state cannot be resolved (unknown is never assumed safe). Read-only; nothing here blocks or changes an invoice. Only runs
 * when the tenant has the engine switched ON.
 */
export async function uncategorisedLineWarnings(
  db: { sellingRestriction: any; invoice: any },
  policy: { enabled: boolean; addressPrecedence: "BILLING_FIRST" | "SHIPPING_FIRST" },
  range: { from: Date; toExclusive: Date },
): Promise<ReportWarning[]> {
  if (!policy.enabled) return [];
  // Rules are judged as of each INVOICE'S issue date, not today: a rule lifted on Oct 1 must still flag
  // September. So read every rule whose window overlaps the range, then filter per invoice below.
  const rules: RuleFacts[] = await db.sellingRestriction.findMany({
    where: {
      effectiveFrom: { lt: range.toExclusive },
      AND: [
        { OR: [{ effectiveTo: null }, { effectiveTo: { gt: range.from } }] },
        { OR: [{ liftedAt: null }, { liftedAt: { gt: range.from } }] },
      ],
    },
    select: {
      jurisdiction: true,
      states: true,
      effectiveFrom: true,
      effectiveTo: true,
      liftedAt: true,
    },
  });
  if (rules.length === 0) return [];

  // One row per invoice (never one per line): an invoice with any productless line.
  const invoices: {
    id: string;
    invoiceNumber: string | null;
    issueDate: Date;
    customer: {
      businessName: string | null;
      addresses: {
        isDefault: boolean;
        addressType: string;
        stateCode: string | null;
        stateNeedsReview: boolean;
      }[];
    } | null;
  }[] = await db.invoice.findMany({
    where: {
      status: { notIn: ["DRAFT", "VOID"] },
      issueDate: { gte: range.from, lt: range.toExclusive },
      // productless AND not the system NSF fee line (the exported prefix the commission engine keys on; there
      // is no fee marker column yet, #2169). A REAL product line with the same description is never excluded:
      // this only ever narrows the productless lines.
      items: {
        some: { productId: null, NOT: { description: { startsWith: NSF_FEE_DESCRIPTION_PREFIX } } },
      },
    },
    select: {
      id: true,
      invoiceNumber: true,
      issueDate: true,
      customer: { select: { businessName: true, addresses: { select: ADDRESS_SELECT } } },
    },
  });

  const out: ReportWarning[] = [];
  for (const inv of invoices) {
    const active = rules.filter((r) =>
      ruleIsActive(
        {
          effectiveFrom: new Date(r.effectiveFrom),
          effectiveTo: r.effectiveTo ? new Date(r.effectiveTo) : null,
          liftedAt: r.liftedAt ? new Date(r.liftedAt) : null,
        },
        new Date(inv.issueDate),
      ),
    );
    if (active.length === 0) continue;
    const customer = inv.customer;
    const governing = resolveGoverningState(
      (customer?.addresses ?? []) as never,
      policy.addressPrecedence,
    );
    const listed =
      active.some(bindsEverywhere) ||
      !governing.resolved ||
      active.some((r) => ruleStates(r as never).includes((governing as { state: string }).state));
    if (!listed) continue;
    const where = governing.resolved ? `in ${governing.state}` : "in an unknown state";
    out.push({
      code: "UNCATEGORISED_LINE_IN_RULE_STATE",
      message: `Invoice ${inv.invoiceNumber ?? inv.id} for ${customer?.businessName ?? "a customer"} (${where}) has a custom line with no catalog product, and a selling restriction was active there when it was issued — review it. Add the item to the catalog to have it checked.`,
      invoiceId: inv.id,
      ...(customer?.businessName ? { customerName: customer.businessName } : {}),
    });
  }
  return out;
}

interface RuleFacts {
  jurisdiction: string;
  states: string[];
  effectiveFrom: Date | string;
  effectiveTo: Date | string | null;
  liftedAt: Date | string | null;
}

/**
 * A rule that binds EVERY customer, fail closed: FEDERAL; a STATE rule whose states cannot all be read (an
 * empty or all-blank list, or an unreadable entry: it blocks everywhere per the schema); or a jurisdiction this
 * code does not recognise (a newer schema value is never quietly ignored).
 */
function bindsEverywhere(r: RuleFacts): boolean {
  if (r.jurisdiction === "FEDERAL") return true;
  if (r.jurisdiction !== "STATE") return true;
  return (
    ruleStates(r as never).length === 0 ||
    r.states.some((s) => s.trim() !== "" && ruleStates({ ...r, states: [s] } as never).length === 0)
  );
}
