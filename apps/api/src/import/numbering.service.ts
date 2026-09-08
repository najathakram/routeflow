import { BadRequestException, ConflictException, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
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

/**
 * The doc types whose LIVE series is keyed per tenant-year (B100/F16b): the
 * `INV-<year>-####` invoices and the `EST-<year>-####` estimates. Both share
 * their number namespace with rows written out of band (imports for invoices;
 * pre-B100 estimates minted by the retired inline max+1 scan), so both get the
 * lazy seed and the collision guard rather than the bare fast path. Every other
 * doc type keeps the year-0 series untouched.
 */
type YearScopedDocType = Extract<DocumentNumberType, "INVOICE" | "ESTIMATE">;

const isYearScoped = (docType: DocumentNumberType): docType is YearScopedDocType =>
  docType === "INVOICE" || docType === "ESTIMATE";

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

/**
 * Owns per-tenant, per-document-type numbering continuity (spec §1). Set during
 * migration from the source's last number ("INV-08841" → next "INV-08842") and
 * editable afterwards. `reserveNext(docType, opts?)` is the collision-guarded
 * contract LIVE minting (invoices/estimates, B100/F16b) consumes for the
 * per-tenant-year `INV-<year>-####` / `EST-<year>-####` series — in its own short
 * transaction for a standalone caller, or on the caller's own client when it is
 * already inside one (`opts.tx`, the delivery path). Imported documents keep their
 * ORIGINAL numbers and must NOT call `reserveNext`.
 */
@Injectable()
export class NumberingService {
  private readonly logger = new Logger(NumberingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * `prefix` + zero-padded number, e.g. format("INV-", 42, 5) ⇒ "INV-00042".
   * `year` (B100/F16b), when > 0, inserts the per-tenant-year segment used by the
   * live INVOICE series: format("INV-", 38, 4, 2026) ⇒ "INV-2026-0038". Defaults
   * to 0 (no segment) so every pre-B100 3-arg call keeps its exact output.
   */
  format(prefix: string, n: number, padding: number, year = 0): string {
    const digits = String(Math.max(0, Math.trunc(n)));
    const padded = padding > 0 ? digits.padStart(padding, "0") : digits;
    return year > 0 ? `${prefix}${year}-${padded}` : `${prefix}${padded}`;
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

  /**
   * All four sequences for the current tenant, defaulting any not yet configured.
   * Scoped to `year: 0` — the configured series this card reads and `updateSettings`
   * writes. The per-year INVOICE/ESTIMATE rows `mintForYear` creates (B100/F16b)
   * are a different series and must never shadow it (cause-ruling.md §2 D1).
   */
  async getSettings(): Promise<NumberingSettingRow[]> {
    const rows = await this.prisma.forTenant().numberingSequence.findMany({
      where: { year: 0 },
    });
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
   * Reserve (consume) the next number and return it formatted (B100/F16b: a
   * plain string — the retired `{ number, advanced }` shape and the
   * caller-supplied `exists` predicate are both gone, see cause-ruling.md §2 D1).
   *
   * `opts.year` (> 0) keys the sequence to `(tenantId, docType, year)` instead of
   * the year-agnostic `year: 0` series and formats with the `INV-<year>-####`
   * segment; omit it (or pass 0) for byte-identical pre-B100 behaviour.
   * `opts.tenantId` is used only when the request context carries none
   * (the fire-and-forget delivery path); `requireTenant()` still THROWS on a
   * null tenant either way — never a sentinel tenant.
   *
   * Pass `opts.tx` ONLY when you are already inside a transaction (the delivery
   * path: routes stop completion → `recordDeliveryPaymentInTx` →
   * `createInvoiceFromOrder(orderId, tx)`); the reservation statements then run on
   * THAT client and NO transaction is opened here. You hold the counter row lock
   * until your commit — safe because the office paths reserve standalone and never
   * hold another row lock while holding the counter, so there is no lock-order
   * cycle; concurrent deliveries for one tenant merely serialize on the counter for
   * the routes transaction's duration (a wait, not a failure). Standalone callers
   * must never hold another row lock while reserving (fix-round-2b.md D7).
   *
   * Without `opts.tx` the reservation runs in its OWN short transaction, opened
   * here and committed before the number is returned, so a rollback after
   * reservation leaves a gap. What is NEVER allowed on either shape is opening a
   * transaction from inside a caller's one: a nested `$transaction` needs a second
   * pooled connection while the caller holds one and starves the pool under
   * concurrent mints (REG-B100-C, 7/10 rejected). And a standalone reservation must
   * never be hoisted above a caller tx that ALREADY holds other row locks — that is
   * what inverted lock order against the driver stop-completion transaction (a
   * 40P01 with no retry) and serialized every concurrent mint behind the slowest
   * invoice body under the 5 s interactive-tx budget. Invariant: no nested
   * `$transaction` anywhere on a mint path.
   *
   * For a year-scoped series (`opts.year > 0` with `docType` satisfying
   * `isYearScoped()` (typed `YearScopedDocType`) — the live INVOICE and
   * ESTIMATE series) two extra
   * guarantees hold, because `import.service.ts` / `import-zoho.js` write
   * arbitrary external numbers into this same namespace
   * (cause-refutation.md §7.9):
   *   - lazy seed: when no sequence row exists yet, the tenant's true numeric max
   *     is computed from its own `<PREFIX>-<year>-####`(`-R{i}`) documents
   *     (imported numbers with no year segment don't match and are ignored) and
   *     the row is created one past it — replacing the F16 design-of-record's
   *     backfill migration. The seed is a conflict-tolerant INSERT, so a
   *     concurrent first mint costs the loser nothing: it reads the winner's row
   *     and falls into the same increment loop below rather than surfacing to the
   *     caller.
   *   - collision guard: every reserved candidate is proven free against the
   *     backing document table before it is returned; a taken one (an import
   *     landed on it out of band) jumps the sequence past the tenant's true max
   *     for the year in ONE statement rather than skipping number by number, so
   *     the round trips inside the reservation transaction stay bounded by a
   *     small constant attempt cap however wide the imported block is.
   * Every other case (year-0 series, or any other docType) keeps the exact
   * pre-B100 fast path: a single atomic increment, no collision check — both
   * paths rely on Postgres serializing concurrent `UPDATE`s of the SAME row
   * rather than a manual `SELECT … FOR UPDATE`, so no caller can observe a
   * torn read even without one.
   */
  async reserveNext(
    docType: DocumentNumberType,
    opts?: { year?: number; tenantId?: string; tx?: Prisma.TransactionClient },
  ): Promise<string> {
    const tenantId = this.requireTenant(opts);
    const year = opts?.year ?? 0;
    const d = DEFAULTS[docType];
    const key = { tenantId_docType_year: { tenantId, docType, year } };
    const callerTx = opts?.tx;

    if (year > 0 && isYearScoped(docType)) {
      // An in-transaction caller reserves ON its own client — opening one here
      // would be a NESTED transaction (a second pooled connection while the
      // caller holds one). Otherwise the reservation gets its OWN short
      // transaction, committed before the number is returned.
      return callerTx
        ? this.mintForYear(callerTx, docType, tenantId, year, key, d)
        : this.prisma.tenantTransaction((tx: Prisma.TransactionClient) =>
            this.mintForYear(tx, docType, tenantId, year, key, d),
          );
    }

    // Fast path (unchanged): ensure a row exists, then atomically increment it.
    // Standalone, each statement autocommits, so no row lock outlives this call;
    // on a caller's tx the two statements run there (never a nested transaction),
    // and `key` carries the tenantId explicitly, so the un-extended client is
    // still tenant-scoped.
    const db = callerTx ?? this.prisma.forTenant();
    const seq = await db.numberingSequence.upsert({
      where: key,
      create: { tenantId, docType, year, prefix: d.prefix, padding: d.padding, nextNumber: 1 },
      update: {},
    });
    const updated = await db.numberingSequence.update({
      where: key,
      data: { nextNumber: { increment: 1 } },
    });
    const reserved = updated.nextNumber - 1;
    return this.format(seq.prefix, reserved, seq.padding, year);
  }

  /**
   * The year-scoped path (see `reserveNext`'s doc comment): lazy-seed from the
   * backing document table when no sequence row exists yet, then atomically
   * increment and collision-guard against that table until a free candidate is
   * proven. `db` is either the reservation's own short transaction or — on the
   * delivery path — the caller's (fix-round-2b.md D7); it is never a transaction
   * this method opens, so no mint ever nests one.
   */
  private async mintForYear(
    db: Prisma.TransactionClient,
    docType: YearScopedDocType,
    tenantId: string,
    year: number,
    key: { tenantId_docType_year: { tenantId: string; docType: DocumentNumberType; year: number } },
    d: { prefix: string; padding: number },
  ): Promise<string> {
    let current = await db.numberingSequence.findUnique({ where: key });

    if (!current) {
      const max = await this.scanMaxForYear(db, docType, tenantId, year, d.prefix);
      this.logger.log(
        `Seeded ${docType} numbering for tenant ${tenantId} year ${year}: max ${max}, next ${max + 1}.`,
      );
      // The seed MUST NOT raise: Postgres aborts the entire transaction on a
      // unique violation (every later statement then fails with SQLSTATE 25P02),
      // so a `create()` + caught P2002 could never "fall through onto the
      // winner's row" from inside the caller's own tx — it would poison the
      // invoice write too. A conflict-tolerant INSERT seeds atomically instead:
      // the concurrent loser inserts nothing and simply reads the winner's row.
      await db.$executeRaw`
        INSERT INTO "NumberingSequence"
          ("id", "tenantId", "docType", "year", "prefix", "padding", "nextNumber", "updatedAt")
        VALUES (
          ${randomUUID()}, ${tenantId}, ${docType}::"DocumentNumberType", ${year},
          ${d.prefix}, ${d.padding}, ${max + 1}, NOW()
        )
        ON CONFLICT ("tenantId", "docType", "year") DO NOTHING
      `;
      current = await db.numberingSequence.findUniqueOrThrow({ where: key });
    }

    const prefix = current.prefix ?? d.prefix;
    const padding = current.padding ?? d.padding;

    // A block an import wrote out of band can be thousands of numbers wide, so a
    // taken candidate is never skipped one round trip at a time (that would scale
    // the reservation transaction with the size of the import and time it out).
    // Instead one clash jumps the sequence straight past the tenant's true max for
    // the year, so the round trips per mint are bounded by a small constant.
    const MINT_MAX_ATTEMPTS = 5;
    let skipped = 0;
    for (let attempt = 0; attempt < MINT_MAX_ATTEMPTS; attempt++) {
      const updated = await db.numberingSequence.update({
        where: key,
        data: { nextNumber: { increment: 1 } },
      });
      const reserved = updated.nextNumber - 1;
      const candidate = this.format(prefix, reserved, padding, year);

      // Never return a candidate an import may already have written out of band.
      const clash = await this.findTaken(db, docType, tenantId, candidate);
      if (!clash) {
        if (skipped) {
          this.logger.warn(
            `Numbering for ${docType} tenant ${tenantId} year ${year} advanced past ${skipped} existing number(s) to ${candidate}.`,
          );
        }
        return candidate;
      }

      const max = await this.scanMaxForYear(db, docType, tenantId, year, prefix);
      const target = Math.max(max + 1, updated.nextNumber);
      skipped += target - reserved;
      // GREATEST, not an absolute `SET "nextNumber" = target` (fix-round-2b.md D8):
      // `target` was computed from a read taken before this write, so a third mint
      // that incremented past it in between would be REWOUND by an absolute set and
      // its already-issued number handed out a second time (a spurious 409 at best,
      // a duplicate at worst). GREATEST makes the jump monotonic — it can only ever
      // move the counter forward — and stays ONE statement.
      await db.$executeRaw`
        UPDATE "NumberingSequence"
        SET "nextNumber" = GREATEST("nextNumber", ${target}), "updatedAt" = NOW()
        WHERE "tenantId" = ${tenantId}
          AND "docType" = ${docType}::"DocumentNumberType"
          AND "year" = ${year}
      `;
    }

    throw new ConflictException(
      `Could not find a free ${docType} number for tenant ${tenantId} year ${year} after ${MINT_MAX_ATTEMPTS} attempts.`,
    );
  }

  /** The tenant's row already carrying `candidate`, or null. */
  private async findTaken(
    db: Prisma.TransactionClient,
    docType: YearScopedDocType,
    tenantId: string,
    candidate: string,
  ): Promise<{ id: string } | null> {
    return docType === "ESTIMATE"
      ? db.estimate.findFirst({ where: { tenantId, estimateNumber: candidate } })
      : db.invoice.findFirst({ where: { tenantId, invoiceNumber: candidate } });
  }

  /**
   * The tenant's true numeric max for the `<PREFIX>-<year>-####`(`-R{i}`) series.
   * The pattern anchors on the fixed default prefix ("INV-"/"EST-", never a
   * tenant's customised one — the per-year series has no stored prefix,
   * cause-ruling.md §2 D1), captures the base number and ignores any `-R{i}`
   * credit-reissue suffix so it shares the base's max (an invoice-only
   * convention; no estimate number carries one, so the optional group simply
   * never fires there); a foreign shape (an imported "INV-08841") does not match
   * and is ignored. The capture is bounded to 9 digits ON PURPOSE: the imported
   * numbers sharing this namespace are arbitrary text, and a longer segment would
   * overflow the `::int` cast and abort the statement (SQLSTATE 22003) — so an
   * oversized foreign number is ignored like any other foreign shape rather than
   * being cast. The two branches are spelled out with literal table/column names
   * rather than interpolated: nothing about the SQL shape is dynamic.
   */
  private async scanMaxForYear(
    db: Prisma.TransactionClient,
    docType: YearScopedDocType,
    tenantId: string,
    year: number,
    prefix: string,
  ): Promise<number> {
    const pattern = `^${prefix}${year}-(\\d{1,9})(?:-R\\d+)?$`;
    const rows =
      docType === "ESTIMATE"
        ? await db.$queryRaw<Array<{ max: number | null }>>`
            SELECT COALESCE(MAX((regexp_match("estimateNumber", ${pattern}))[1]::int), 0)::int AS max
            FROM "Estimate"
            WHERE "tenantId" = ${tenantId}
          `
        : await db.$queryRaw<Array<{ max: number | null }>>`
            SELECT COALESCE(MAX((regexp_match("invoiceNumber", ${pattern}))[1]::int), 0)::int AS max
            FROM "Invoice"
            WHERE "tenantId" = ${tenantId}
          `;
    return Number(rows?.[0]?.max ?? 0);
  }

  private requireTenant(opts?: { tenantId?: string }): string {
    const tenantId = this.prisma.getTenantId() ?? opts?.tenantId;
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }
}
