import { BadRequestException, ConflictException, Injectable, Logger } from "@nestjs/common";
import { DocumentNumberType, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { UpdateNumberingDto } from "./dto/update-numbering.dto";

/** The four document types that carry a tenant-configurable numbering sequence. */
export const DOCUMENT_NUMBER_TYPES: DocumentNumberType[] = [
  "INVOICE",
  "ESTIMATE",
  "CREDIT_NOTE",
  "PAYMENT",
];

/** Fallback prefix/padding when a tenant has never configured a sequence. */
const DEFAULTS: Record<DocumentNumberType, { prefix: string; padding: number }> = {
  INVOICE: { prefix: "INV-", padding: 4 },
  ESTIMATE: { prefix: "EST-", padding: 4 },
  CREDIT_NOTE: { prefix: "CN-", padding: 4 },
  PAYMENT: { prefix: "PAY-", padding: 4 },
  // F01/G6: match the series the ad-hoc minters emit today (returns.service.ts
  // `RET-<year>-…` pad-4, orders.service.ts `ORD-…` pad-5) so F16 can route
  // them through reserveNext without renumbering anything.
  RETURN: { prefix: "RET-", padding: 4 },
  ORDER: { prefix: "ORD-", padding: 5 },
};

export interface NumberingSettingRow {
  docType: DocumentNumberType;
  prefix: string;
  nextNumber: number;
  padding: number;
  /** Formatted next number (what `reserveNext` would mint next), for previews. */
  preview: string;
  /** false when this row is a default the tenant has not yet saved. */
  configured: boolean;
}

export interface ReservedNumber {
  number: string;
  /** true when the collision guard skipped past an already-existing number. */
  advanced: boolean;
}

/**
 * Owns per-tenant, per-document-type numbering continuity (spec §1). Set during
 * migration from the source's last number ("INV-08841" → next "INV-08842") and
 * editable afterwards. `reserveNext(docType)` is the collision-guarded contract
 * that LIVE minting (invoices/orders) will consume — wiring it into those call
 * sites is a deferred cross-module change; this module only defines the sequence
 * store + service. Imported documents keep their ORIGINAL numbers and must NOT
 * call `reserveNext`.
 */
@Injectable()
export class NumberingService {
  private readonly logger = new Logger(NumberingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** `prefix` + zero-padded number, e.g. format("INV-", 42, 5) ⇒ "INV-00042". */
  format(prefix: string, n: number, padding: number): string {
    const digits = String(Math.max(0, Math.trunc(n)));
    return `${prefix}${padding > 0 ? digits.padStart(padding, "0") : digits}`;
  }

  /**
   * Parse a source document number into { prefix, number, padding } by splitting
   * on the trailing run of digits. "INV-08841" ⇒ { "INV-", 8841, 5 }; "42" ⇒
   * { "", 42, 2 }. Returns null when there is no trailing number to continue from.
   */
  parseDocumentNumber(raw: string): { prefix: string; number: number; padding: number } | null {
    const m = /^(.*?)(\d+)\s*$/.exec((raw ?? "").trim());
    if (!m) return null;
    const [, prefix, digits] = m;
    return { prefix, number: parseInt(digits, 10), padding: digits.length };
  }

  /** All four sequences for the current tenant, defaulting any not yet configured. */
  async getSettings(): Promise<NumberingSettingRow[]> {
    const rows = await this.prisma.forTenant().numberingSequence.findMany();
    const byType = new Map(rows.map((r) => [r.docType, r]));
    return DOCUMENT_NUMBER_TYPES.map((docType) => {
      const row = byType.get(docType);
      const prefix = row?.prefix ?? DEFAULTS[docType].prefix;
      const padding = row?.padding ?? DEFAULTS[docType].padding;
      const nextNumber = row?.nextNumber ?? 1;
      return {
        docType,
        prefix,
        nextNumber,
        padding,
        preview: this.format(prefix, nextNumber, padding),
        configured: !!row,
      };
    });
  }

  /** Upsert a tenant's sequence config (import numbering card / migration setup). */
  async updateSettings(
    docType: DocumentNumberType,
    dto: UpdateNumberingDto,
  ): Promise<NumberingSettingRow> {
    const tenantId = this.requireTenant();
    const d = DEFAULTS[docType];
    const row = await this.prisma.forTenant().numberingSequence.upsert({
      where: { tenantId_docType_year: { tenantId, docType, year: 0 } },
      create: {
        tenantId,
        docType,
        prefix: dto.prefix ?? d.prefix,
        nextNumber: dto.nextNumber ?? 1,
        padding: dto.padding ?? d.padding,
      },
      update: {
        ...(dto.prefix !== undefined && { prefix: dto.prefix }),
        ...(dto.nextNumber !== undefined && { nextNumber: dto.nextNumber }),
        ...(dto.padding !== undefined && { padding: dto.padding }),
      },
    });
    return {
      docType: row.docType,
      prefix: row.prefix,
      nextNumber: row.nextNumber,
      padding: row.padding,
      preview: this.format(row.prefix, row.nextNumber, row.padding),
      configured: true,
    };
  }

  /**
   * Seed a sequence from a migration source's last-issued number:
   * seedFromSource("INVOICE", "INV-08841") ⇒ next mints "INV-08842". Continuity
   * only — the parsed prefix/padding are adopted so RouteFlow numbers look like
   * the source's.
   */
  async seedFromSource(
    docType: DocumentNumberType,
    lastNumber: string,
  ): Promise<NumberingSettingRow> {
    const parsed = this.parseDocumentNumber(lastNumber);
    if (!parsed) {
      throw new BadRequestException(`Could not read a number to continue from "${lastNumber}".`);
    }
    return this.updateSettings(docType, {
      prefix: parsed.prefix,
      nextNumber: parsed.number + 1,
      padding: parsed.padding,
    });
  }

  /** The next number that would be minted, without consuming it. */
  async peekNext(docType: DocumentNumberType): Promise<string> {
    const settings = await this.getSettings();
    return settings.find((r) => r.docType === docType)!.preview;
  }

  /**
   * Reserve (consume) the next number. Without an `exists` predicate this is a
   * single-statement atomic increment (race-safe). With one — supplied by the
   * caller so this stays decoupled from the invoices schema — the collision guard
   * skips forward past any candidate that already exists (e.g. an imported
   * invoice), returning `advanced: true` so the caller can surface "numbering
   * advanced past an imported invoice", and throwing if no free number is found
   * within the safety cap (never returns an unverified number).
   *
   * CONCURRENCY NOTE for the deferred mint-site wiring: the collision path is a
   * read-modify-write inside a tenant transaction that does NOT take a row lock
   * (default READ COMMITTED), so two concurrent minting calls could still race.
   * When wiring this into live invoice/order minting, run it at SERIALIZABLE
   * isolation (or add a `SELECT … FOR UPDATE` on the sequence row) and rely on
   * the invoice-number unique constraint as the final backstop.
   */
  async reserveNext(
    docType: DocumentNumberType,
    exists?: (candidate: string) => Promise<boolean> | boolean,
  ): Promise<ReservedNumber> {
    const tenantId = this.requireTenant();
    const d = DEFAULTS[docType];

    // Ensure a row exists so the atomic increment / tx update has a target.
    const seq = await this.prisma.forTenant().numberingSequence.upsert({
      where: { tenantId_docType_year: { tenantId, docType, year: 0 } },
      create: { tenantId, docType, prefix: d.prefix, padding: d.padding, nextNumber: 1 },
      update: {},
    });

    if (!exists) {
      // Fast path: atomic single-statement increment — safe under concurrency.
      const updated = await this.prisma.forTenant().numberingSequence.update({
        where: { tenantId_docType_year: { tenantId, docType, year: 0 } },
        data: { nextNumber: { increment: 1 } },
      });
      const reserved = updated.nextNumber - 1;
      return { number: this.format(seq.prefix, reserved, seq.padding), advanced: false };
    }

    // Collision-guarded path: read-modify-write inside a tenant transaction,
    // skipping forward past numbers that already exist.
    return this.prisma.tenantTransaction(async (tx: Prisma.TransactionClient) => {
      const current = await tx.numberingSequence.findUnique({
        where: { tenantId_docType_year: { tenantId, docType, year: 0 } },
      });
      const prefix = current?.prefix ?? seq.prefix;
      const padding = current?.padding ?? seq.padding;
      let n = current?.nextNumber ?? 1;

      let advanced = false;
      let candidate = this.format(prefix, n, padding);
      // Loop only exits when `candidate` has been PROVEN free (exists → false),
      // so we never return an unverified number. A pathological predicate that
      // never yields a free number throws at the cap rather than minting a
      // duplicate at the safety valve.
      let guard = 0;
      while (await exists(candidate)) {
        if (guard++ >= 10_000) {
          throw new ConflictException(
            `Could not find a free ${docType} number after ${guard} attempts (last tried ${candidate}).`,
          );
        }
        n += 1;
        advanced = true;
        candidate = this.format(prefix, n, padding);
      }
      if (advanced) {
        this.logger.warn(
          `Numbering for ${docType} advanced past existing number(s) to ${candidate}.`,
        );
      }

      await tx.numberingSequence.update({
        where: { tenantId_docType_year: { tenantId, docType, year: 0 } },
        data: { nextNumber: n + 1 },
      });
      return { number: candidate, advanced };
    });
  }

  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }
}
