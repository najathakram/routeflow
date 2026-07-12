import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export interface InvoiceDuplicateMatch {
  id: string;
  invoiceNumber: string;
}

export interface VendorBillDuplicateMatch {
  id: string;
  billNumber: string;
}

/**
 * Batch-import vendor bills embed the supplier's own invoice number in a
 * fixed `notes` phrase (there's no dedicated column yet — see the batch-scan
 * plan's phase-3 follow-up) so `findVendorBillDuplicate` can parse it back
 * out. `batch-import.service.ts` writes notes via this same helper so the
 * two never drift apart.
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
   * Find an existing VENDOR BILL that is very likely the same supplier
   * document: total to the cent, bill date within ±1 day, narrowed to the
   * matched supplier when one was resolved, and — when a supplier invoice
   * number is supplied — the same normalized number embedded in `notes` via
   * `formatSupplierInvoiceNote`. Mirrors `findInvoiceDuplicate`'s shape but
   * over `VendorBill` (money owed BY us), never the customer `Invoice` table
   * (money owed TO us) — batch import scans supplier invoices, so checking
   * against `Invoice` produced both false positives (against issued
   * invoices that just happen to share a total/date) and false negatives
   * (real repeat vendor bills were never caught).
   */
  async findVendorBillDuplicate(params: {
    supplierId?: string | null;
    number?: string | null;
    total: number;
    issueDate: Date;
  }): Promise<VendorBillDuplicateMatch | null> {
    this.requireTenant();
    const from = new Date(params.issueDate);
    from.setDate(from.getDate() - 1);
    const to = new Date(params.issueDate);
    to.setDate(to.getDate() + 1);

    const candidates = await this.prisma.forTenant().vendorBill.findMany({
      where: {
        billDate: { gte: from, lte: to },
        totalOwed: { gte: params.total - 0.005, lte: params.total + 0.005 },
        ...(params.supplierId ? { supplierId: params.supplierId } : {}),
      },
      select: { id: true, billNumber: true, notes: true },
      take: 200,
    });
    if (!candidates.length) return null;

    if (!params.number) {
      return { id: candidates[0].id, billNumber: candidates[0].billNumber };
    }
    const target = this.normalizeNumber(params.number);
    const match = candidates.find((c) => {
      const embedded = extractSupplierInvoiceNumber(c.notes);
      return embedded ? this.normalizeNumber(embedded) === target : false;
    });
    return match ? { id: match.id, billNumber: match.billNumber } : null;
  }

  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }
}
