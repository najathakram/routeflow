import { PrismaService } from "../prisma/prisma.service";
import { normalizeInvoiceNumber } from "../import/duplicate-match.service";
import type { MatchableBill } from "./statement-matcher";

/**
 * The full, unbounded pool of non-VOID vendor bills for a supplier that
 * `matchStatementLines` may match a statement line against.
 *
 * REG-B117: both `SupplierStatementsService.fetchMatchableBills` and
 * `StatementApplyService.fetchMatchableBills` carried a byte-identical
 * `take: 500` cap with no `orderBy` — a supplier with more than 500 open
 * bills silently lost every bill past the 500th to whatever order the DB
 * happened to return rows in, so a real match for a newer bill came back
 * UNMATCHED. This is the ONE shared source now — no `take` at all (the
 * whole candidate pool), ordered `[{ billDate: "desc" }, { id: "desc" }]`
 * (REG-B169: an id tiebreaker, since `billDate` alone can collide across
 * many bills entered on the same day). `matchable-bills.guard.spec.ts`
 * fails the build if either service re-grows its own copy of this query.
 *
 * `normalize` defaults to the standalone `normalizeInvoiceNumber` (what
 * `StatementApplyService` used directly, no DI); `SupplierStatementsService`
 * passes its injected `DuplicateMatchService.normalizeNumber` instead so the
 * existing DI-based test coverage on that path is undisturbed — both wrap
 * the exact same literal rule (see `normalizeInvoiceNumber`'s own comment).
 */
export async function fetchMatchableBills(
  prisma: PrismaService,
  supplierId: string | null,
  normalize: (raw: string) => string = normalizeInvoiceNumber,
): Promise<MatchableBill[]> {
  if (!supplierId) return [];
  const bills = await prisma.forTenant().vendorBill.findMany({
    where: { supplierId, status: { not: "VOID" } },
    select: {
      id: true,
      billNumber: true,
      supplierInvoiceNumber: true,
      totalOwed: true,
      billDate: true,
      status: true,
    },
    orderBy: [{ billDate: "desc" }, { id: "desc" }],
  });
  return bills.map((b: any) => ({
    id: b.id,
    billNumber: b.billNumber,
    // Stored normalized already, but re-normalized here too — the matcher
    // must never trust a value it didn't itself put through the one
    // canonical rule.
    supplierInvoiceNumber: b.supplierInvoiceNumber ? normalize(b.supplierInvoiceNumber) : null,
    totalOwed: Number(b.totalOwed),
    billDate: b.billDate,
    status: b.status,
  }));
}
