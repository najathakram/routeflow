import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export interface InvoiceDuplicateMatch {
  id: string;
  invoiceNumber: string;
}

/**
 * Secondary duplicate detection (spec §2). The external-id upsert
 * (`ExternalRefService`) catches re-runs of the same source; this catches the
 * SAME document arriving via two paths (CSV + connector, or a re-uploaded scan)
 * by matching on (normalized number, total, issue date ±1 day). Read-only over
 * Invoice — the finance module is never mutated.
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

  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }
}
