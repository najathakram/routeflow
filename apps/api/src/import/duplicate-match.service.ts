import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export interface InvoiceDuplicateMatch {
  id: string;
  invoiceNumber: string;
}

/**
 * Enough of the existing bill for a caller to explain the block to an operator
 * without a second query: whether it is a still-resumable DRAFT, what it is
 * worth, and whether the totals actually agree (a number match whose total
 * differs is worth surfacing rather than silently trusting).
 */
export interface VendorBillDuplicateMatch {
  id: string;
  billNumber: string;
  status: string;
  totalOwed: number;
  billDate: Date | null;
  receivedDate: Date | null;
  supplierId: string | null;
  itemCount: number;
  matchedBy: "number" | "fuzzy";
  totalMatches: boolean;
}

/** Money agreement window — Decimal(10,2) columns compared as floats. */
const TOTAL_TOLERANCE = 0.005;

const VENDOR_BILL_DUP_SELECT = {
  id: true,
  billNumber: true,
  status: true,
  totalOwed: true,
  billDate: true,
  receivedDate: true,
  supplierId: true,
  notes: true,
  _count: { select: { items: true } },
} as const;

/**
 * Batch-import vendor bills embed the supplier's own invoice number in a fixed
 * `notes` phrase. `VendorBill.supplierInvoiceNumber` is the authoritative
 * field; the phrase is the only carrier on rows written before that column
 * existed and on any client that still sends only notes, so
 * `extractSupplierInvoiceNumber` parses it back out.
 * `batch-import.service.ts` writes notes via this same helper so the two never
 * drift apart.
 */
export function formatSupplierInvoiceNote(invoiceNumber: string): string {
  return `Batch import — Supplier invoice #${invoiceNumber}`;
}

const SUPPLIER_INVOICE_NOTE_RE = /supplier invoice #\s*(\S+)/i;

export function extractSupplierInvoiceNumber(notes: string | null | undefined): string | null {
  const match = notes?.match(SUPPLIER_INVOICE_NOTE_RE);
  return match ? match[1] : null;
}

/**
 * Secondary duplicate detection (spec §2). The external-id upsert
 * (`ExternalRefService`) catches re-runs of the same source; this catches the
 * SAME document arriving via two paths (CSV + connector, or a re-uploaded scan)
 * by matching on (normalized number, total, issue date ±1 day).
 * `findInvoiceDuplicate` is read-only over the CUSTOMER `Invoice` table — for
 * SUPPLIER invoices (vendor bills), use `findVendorBillDuplicate` instead;
 * the two tables track opposite directions of money and must never be
 * cross-checked against each other.
 */
@Injectable()
export class DuplicateMatchService {
  constructor(private readonly prisma: PrismaService) {}

  /** Normalize an invoice number for fuzzy matching: strip whitespace, uppercase. */
  normalizeNumber(raw: string): string {
    return (raw ?? "").toUpperCase().replace(/\s+/g, "");
  }

  /**
   * Find an existing invoice that is very likely the same document: total to the
   * cent, issue date within ±1 day, and — when a number is supplied — the same
   * normalized number. Returns the matched invoice's { id, invoiceNumber } (so the
   * caller can LINK the skipped duplicate to it, per §2), or null.
   */
  async findInvoiceDuplicate(params: {
    number?: string | null;
    total: number;
    issueDate: Date;
  }): Promise<InvoiceDuplicateMatch | null> {
    this.requireTenant();
    const from = new Date(params.issueDate);
    from.setDate(from.getDate() - 1);
    const to = new Date(params.issueDate);
    to.setDate(to.getDate() + 1);

    // Narrow by date window + total-to-the-cent in the query (avoids Decimal
    // equality pitfalls by using a ±0.005 range), then confirm the number in app.
    const candidates = await this.prisma.forTenant().invoice.findMany({
      where: {
        issueDate: { gte: from, lte: to },
        total: { gte: params.total - 0.005, lte: params.total + 0.005 },
      },
      select: { id: true, invoiceNumber: true },
      take: 200,
    });
    if (!candidates.length) return null;

    if (!params.number) {
      return { id: candidates[0].id, invoiceNumber: candidates[0].invoiceNumber };
    }
    const target = this.normalizeNumber(params.number);
    const match = candidates.find((c) => this.normalizeNumber(c.invoiceNumber) === target);
    return match ? { id: match.id, invoiceNumber: match.invoiceNumber } : null;
  }

  /**
   * Find an existing VENDOR BILL that is the same supplier document. Runs over
   * `VendorBill` (money owed BY us), never the customer `Invoice` table (money
   * owed TO us) — supplier invoices checked against `Invoice` produced both
   * false positives (issued invoices that happen to share a total/date) and
   * false negatives (real repeat vendor bills were never caught).
   *
   * Layered, strongest first:
   *  1. the persisted `supplierInvoiceNumber` column;
   *  2. the same number parsed out of the legacy `notes` phrase, within the
   *     old total/date window (rows predating the column);
   *  3. no number at all → supplier + date window + total together, which is
   *     the weakest signal that still identifies a document.
   *
   * VOID bills never match: voiding is how an operator undoes a bad scan, so
   * a voided bill must not block re-recording the real one.
   *
   * Line items are deliberately NOT compared — operators edit lines during
   * review, so item equality yields false negatives. Identity is supplier +
   * number; total agreement is reported (`totalMatches`), not required.
   */
  async findVendorBillDuplicate(params: {
    supplierId?: string | null;
    number?: string | null;
    total?: number | null;
    issueDate?: Date | null;
  }): Promise<VendorBillDuplicateMatch | null> {
    this.requireTenant();
    const target = params.number ? this.normalizeNumber(params.number) : "";
    const total = params.total ?? null;
    const supplierId = params.supplierId ?? null;
    const issueDate =
      params.issueDate && !isNaN(params.issueDate.getTime()) ? params.issueDate : null;

    if (target) {
      const byNumber = await this.prisma.forTenant().vendorBill.findMany({
        where: {
          supplierInvoiceNumber: target,
          status: { not: "VOID" },
          ...this.supplierScope(supplierId, true),
        },
        select: VENDOR_BILL_DUP_SELECT,
        orderBy: { createdAt: "desc" },
        take: 20,
      });
      const hit = this.pickNumberMatch(byNumber, supplierId, total);
      if (hit) return this.toVendorBillMatch(hit, "number", total);

      if (total != null && issueDate) {
        const legacy = await this.fuzzyVendorBillCandidates(supplierId, total, issueDate, true);
        const numbered = legacy.filter((c) => {
          const embedded = extractSupplierInvoiceNumber(c.notes);
          return embedded ? this.normalizeNumber(embedded) === target : false;
        });
        const match = this.pickNumberMatch(numbered, supplierId, total);
        if (match) return this.toVendorBillMatch(match, "number", total);
      }
      return null;
    }

    if (!supplierId || !issueDate || total == null) return null;
    const candidates = await this.fuzzyVendorBillCandidates(supplierId, total, issueDate, false);
    return candidates.length ? this.toVendorBillMatch(candidates[0], "fuzzy", total) : null;
  }

  /**
   * Supplier narrowing for a bill lookup. A stored bill with no supplier is
   * routine — batch import writes one whenever the scan resolved no vendor — so
   * an exact-NUMBER lookup must reach those rows too, or they can never be
   * recognized again once a caller knows its supplier. Bills belonging to a
   * DIFFERENT supplier stay excluded either way.
   */
  private supplierScope(supplierId: string | null, includeUnassigned: boolean) {
    if (!supplierId) return {};
    return includeUnassigned ? { OR: [{ supplierId }, { supplierId: null }] } : { supplierId };
  }

  /**
   * Rank number-matched rows: the caller's own supplier outranks a
   * supplier-less row. Without a caller supplier the number alone isn't
   * identity — "INV-1001" recurs across vendors — so the total has to agree
   * before it counts.
   */
  private pickNumberMatch<T extends { supplierId: string | null; totalOwed: unknown }>(
    rows: T[],
    supplierId: string | null,
    total: number | null,
  ): T | undefined {
    if (!supplierId) return rows.find((r) => this.totalAgrees(r.totalOwed, total));
    return rows.find((r) => r.supplierId === supplierId) ?? rows.find((r) => r.supplierId === null);
  }

  /** Bills within ±1 day of the issue date whose total matches to the cent. */
  private async fuzzyVendorBillCandidates(
    supplierId: string | null,
    total: number,
    issueDate: Date,
    includeUnassignedSupplier: boolean,
  ) {
    const from = new Date(issueDate);
    from.setDate(from.getDate() - 1);
    const to = new Date(issueDate);
    to.setDate(to.getDate() + 1);

    return this.prisma.forTenant().vendorBill.findMany({
      where: {
        billDate: { gte: from, lte: to },
        totalOwed: { gte: total - TOTAL_TOLERANCE, lte: total + TOTAL_TOLERANCE },
        status: { not: "VOID" },
        ...this.supplierScope(supplierId, includeUnassignedSupplier),
      },
      select: VENDOR_BILL_DUP_SELECT,
      take: 200,
    });
  }

  private toVendorBillMatch(
    row: {
      id: string;
      billNumber: string;
      status: string;
      totalOwed: unknown;
      billDate: Date | null;
      receivedDate: Date | null;
      supplierId: string | null;
      _count?: { items: number };
    },
    matchedBy: "number" | "fuzzy",
    total: number | null,
  ): VendorBillDuplicateMatch {
    const totalOwed = Number(row.totalOwed);
    return {
      id: row.id,
      billNumber: row.billNumber,
      status: row.status,
      totalOwed,
      billDate: row.billDate ?? null,
      receivedDate: row.receivedDate ?? null,
      supplierId: row.supplierId ?? null,
      itemCount: row._count?.items ?? 0,
      matchedBy,
      totalMatches: total != null && Math.abs(totalOwed - total) <= TOTAL_TOLERANCE,
    };
  }

  private totalAgrees(totalOwed: unknown, total: number | null): boolean {
    return total != null && Math.abs(Number(totalOwed) - total) <= TOTAL_TOLERANCE;
  }

  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }
}
