import type { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { RESTRICTION_OVERRIDE_IMPORTED_REASON } from "../selling-restrictions/override-constants";
import { writeOverrideAuditRows } from "../selling-restrictions/restriction-override-audit";
import { breachKeys } from "../selling-restrictions/staff-breaches";

/**
 * Row 510 (ruling #2093, 2026-10-13): HISTORICAL invoice IMPORT (`ImportService.importInvoices`, the Zoho invoice CSV) is
 * EXEMPT and never refused: it records sales that already happened, so history is not rewritten. A catalog line that
 * the engine would breach today is MARKED instead: its invoice item carries the stamp columns with the fixed reason
 * `RESTRICTION_OVERRIDE_IMPORTED_REASON`, the importing user, the time and ALL the rules matched at import (each as
 * `ruleId:STATE`, the state it was matched at, `UNKNOWN` when unresolved), with one `selling_restriction.overridden`
 * audit row per marked line (same transaction, so a mark without its audit row rolls back) and the caller's run-level
 * `invoice.import.restricted_lines` audit row. A productless (custom) line is exempt
 * and never marked.
 *
 * WHICH IMPORT PATH IS WHICH (grep-pinned in import-restriction-marker.spec.ts): `importInvoices` is the ONLY import that
 * writes a customer sale, and it is historical. The other imports write contacts, products, inventory, expenses,
 * payments, supplier bills (`BatchImportService`, purchases) and staged migration records; none creates an order or an
 * invoice for a customer, so there is no "import of NEW sales" to refuse. If one is ever added it must refuse a
 * breached row in its own report (not stamp it), and the pin fails until it is classified.
 *
 * NEVER throws and never delays the import: it runs after the loop, outside every per-invoice transaction; a failing
 * check or write is logged and that customer's lines stay as imported (flagged in the report, unmarked).
 */

export interface ImportedCandidate {
  customerId: string;
  invoiceId: string;
  invoiceNumber: string;
  /** Catalog product ids of the imported lines (a productless line is not here). */
  productIds: string[];
}

/** One flagged line, as the import report lists it. */
export interface ImportRestrictedLine {
  invoiceNumber: string;
  productId: string;
  productName: string;
  message: string;
}

interface MarkerTx {
  invoiceItem: {
    findMany(args: unknown): Promise<Array<{ id: string }>>;
    updateMany(args: unknown): Promise<unknown>;
  };
  auditLog: { create(args: { data: any }): Promise<unknown> };
}

export interface MarkerDeps {
  restrictions: Pick<SellingRestrictionsService, "judgeStaffWrite">;
  prisma: { tenantTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> };
  warn: (message: string) => void;
}

export async function markImportedRestrictedLines(
  deps: MarkerDeps,
  p: {
    tenantId: string;
    userId: string;
    /** The support agent's id when the import ran in a support session (carried onto each audit row). */
    impersonatedBy?: string | null;
    candidates: readonly ImportedCandidate[];
    at?: Date;
  },
): Promise<ImportRestrictedLine[]> {
  const out: ImportRestrictedLine[] = [];
  const byCustomer = new Map<string, ImportedCandidate[]>();
  for (const c of p.candidates)
    byCustomer.set(c.customerId, [...(byCustomer.get(c.customerId) ?? []), c]);

  for (const [customerId, entries] of byCustomer) {
    try {
      const productIds = [...new Set(entries.flatMap((e) => e.productIds))];
      if (productIds.length === 0) continue;
      const judgement = await deps.restrictions.judgeStaffWrite({
        tenantId: p.tenantId,
        customerId,
        lines: productIds.map((productId) => ({ productId })),
        channel: "STAFF",
      });
      if (judgement.outcome !== "BLOCK" && judgement.outcome !== "INDETERMINATE") continue;
      const reasonOf = new Map(judgement.reasons.map((r) => [r.productId, r]));
      const breachOf = new Map(judgement.breaches.map((b) => [b.productId, b]));
      const flagged = new Set([...reasonOf.keys(), ...breachOf.keys()]);
      for (const e of entries)
        for (const pid of e.productIds) {
          const r = reasonOf.get(pid);
          if (flagged.has(pid))
            out.push({
              invoiceNumber: e.invoiceNumber,
              productId: pid,
              productName: r?.productName ?? breachOf.get(pid)?.productName ?? "",
              message: r?.message ?? "",
            });
        }

      const at = p.at ?? new Date();
      await deps.prisma.tenantTransaction(async (tx: MarkerTx) => {
        for (const e of entries) {
          for (const pid of new Set(e.productIds)) {
            if (!flagged.has(pid)) continue;
            if (!e.invoiceId || !pid) continue; // the widening trap: never an updateMany without ids
            // each key is ruleId:STATE at the state the line was judged at when imported (UNKNOWN when unresolved)
            const b = breachOf.get(pid);
            const ruleIds = (b ? breachKeys(b) : []).sort();
            const items = await tx.invoiceItem.findMany({
              where: { invoiceId: e.invoiceId, productId: pid },
              select: { id: true },
            });
            const ids = items.map((i) => i.id);
            if (ids.length === 0) continue;
            await tx.invoiceItem.updateMany({
              where: { id: { in: ids }, invoiceId: e.invoiceId },
              data: {
                restrictionOverrideReason: RESTRICTION_OVERRIDE_IMPORTED_REASON,
                restrictionOverrideBy: p.userId,
                restrictionOverrideAt: at,
                restrictionOverrideRuleIds: ruleIds,
              },
            });
            await writeOverrideAuditRows(
              tx,
              {
                tenantId: p.tenantId,
                by: p.userId,
                impersonatedBy: p.impersonatedBy ?? null,
                entityType: "InvoiceItem",
                documentType: "INVOICE",
                documentId: e.invoiceId,
                warningHash: null,
                basis: judgement.basis,
              },
              ids.map((lineId) => ({
                lineId,
                productId: pid,
                lineKey: `l:${lineId}`,
                ruleIds,
                reason: RESTRICTION_OVERRIDE_IMPORTED_REASON,
              })),
            );
          }
        }
      });
    } catch (e) {
      deps.warn(
        `import restriction marker failed for a customer: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return out;
}
