import { BadRequestException, ConflictException, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { DocumentNumberType, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { validateDocumentPrefix } from "../common/document-prefix";
import { UpdateNumberingDto } from "./dto/update-numbering.dto";

/**
 * The three document types that carry a tenant-configurable numbering
 * sequence on the settings card (SA-274 Q6 drops PAYMENT from the card — its
 * own `PaymentCounter` wiring is unaffected and tracked as a separate B-id).
 */
export const DOCUMENT_NUMBER_TYPES: DocumentNumberType[] = ["INVOICE", "ESTIMATE", "CREDIT_NOTE"];

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
 * The doc types the numbering-settings card covers: INVOICE, ESTIMATE and
 * (B267) CREDIT_NOTE. Two series can supply their LIVE numbers (SA-274 Q1):
 * a saved year-0 row on the card, once the tenant has saved one, IS that doc
 * type's live series — prefix + pad(n), continuous, no year segment, never
 * resets — and takes precedence for every mint regardless of the year the
 * caller asks for; with nothing saved, minting falls back to the legacy
 * per-tenant-year `INV-<year>-####` series (B100/F16b), byte-identical to
 * before this fix. INVOICE/ESTIMATE share their per-year number namespace
 * with rows written out of band (imports for invoices; pre-B100 estimates
 * minted by the retired inline max+1 scan); CREDIT_NOTE joins them for the
 * same lazy-seed + collision-guard machinery even though nothing writes
 * credit notes out of band today. Every other doc type (PAYMENT/RETURN/
 * ORDER) keeps the plain year-0 fast path untouched either way.
 */
type YearScopedDocType = Extract<DocumentNumberType, "INVOICE" | "ESTIMATE" | "CREDIT_NOTE">;

const isYearScoped = (docType: DocumentNumberType): docType is YearScopedDocType =>
  docType === "INVOICE" || docType === "ESTIMATE" || docType === "CREDIT_NOTE";

/** Postgres ARE metacharacters, backslash-escaped, so a tenant prefix is matched literally. */
const escapeRegex = (s: string): string => s.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");

/** Plain-English doc-type name for user-facing messages ("credit note", not "CREDIT_NOTE"). */
const docTypeLabel = (docType: DocumentNumberType): string =>
  docType.toLowerCase().replace(/_/g, " ");

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
 * contract LIVE minting (invoices/estimates, B100/F16b; credit notes, B267)
 * consumes: for INVOICE/ESTIMATE/CREDIT_NOTE, a saved settings-card row (year 0)
 * IS the live series once the tenant has saved one (SA-274 Q1) — continuous
 * prefix + pad(n), max-first so an import landing after the save is never
 * undercut (Q2); with nothing saved, the per-tenant-year `INV-<year>-####` /
 * `EST-<year>-####` / `CN-<year>-####` series (B100/F16b) is unchanged — in its
 * own short transaction for a standalone caller, or on the caller's own client
 * when it is already inside one (`opts.tx`, the delivery path). Imported
 * documents keep their ORIGINAL numbers and must NOT call `reserveNext`.
 */
@Injectable()
export class NumberingService {
  private readonly logger = new Logger(NumberingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * `prefix` + zero-padded number, e.g. format("INV-", 42, 5) ⇒ "INV-00042".
   * `year` (B100/F16b), when > 0, inserts the per-tenant-year segment used by the
   * live INVOICE series: format("INV-", 38, 4, 2026) ⇒ "INV-2026-0038". Defaults
   * to 0 (no segment) so every pre-B100 3-arg call keeps its exact output — the
   * same no-segment form the SA-274 configured series (year 0) uses.
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
   * The three sequences for the current tenant, defaulting any not yet
   * configured. Scoped to `year: 0` — the configured series this card reads
   * and `updateSettings` writes; the per-year INVOICE/ESTIMATE/CREDIT_NOTE
   * rows `mintForYear` creates (B100/F16b) are a different series and never
   * populate this row (cause-ruling.md §2 D1). `preview` is the TRUE next
   * live number in both modes (SA-274 Q5): a saved row previews the max-first
   * configured number; an unsaved one previews the per-year next (mirroring
   * the mint's own collision jump, read-only) — never a static default.
   */
  async getSettings(): Promise<NumberingSettingRow[]> {
    const tenantId = this.requireTenant();
    const rows = await this.prisma.forTenant().numberingSequence.findMany({
      where: { year: 0 },
    });
    const byType = new Map(rows.map((r) => [r.docType, r]));
    const year = new Date().getFullYear();

    return this.prisma.tenantTransaction(async (tx: Prisma.TransactionClient) => {
      const settings: NumberingSettingRow[] = [];
      for (const docType of DOCUMENT_NUMBER_TYPES as YearScopedDocType[]) {
        const row = byType.get(docType);
        const prefix = row?.prefix ?? DEFAULTS[docType].prefix;
        const padding = row?.padding ?? DEFAULTS[docType].padding;
        const nextNumber = row?.nextNumber ?? 1;
        const preview = row
          ? await this.previewConfigured(tx, docType, tenantId, prefix, padding, nextNumber)
          : await this.previewUnconfigured(tx, docType, tenantId, prefix, padding, year);
        settings.push({ docType, prefix, nextNumber, padding, preview, configured: !!row });
      }
      return settings;
    });
  }

  /**
   * B1188: the true next number a prefix change would mint, WITHOUT saving anything — what the
   * Settings card shows the user to confirm. It is the same max-first scan the live mint uses
   * (`previewConfigured`): the highest existing document under the NEW prefix, one past it, never
   * below the stored counter. Returns the version token (`expectedNextNumber`, the stored
   * `nextNumber`; 1 for an unsaved row) the save must echo, so a sequence that moves between the
   * preview and the save is refused by `updateSettings` instead of silently renumbering.
   */
  async previewPrefix(
    docType: DocumentNumberType,
    prefix: string,
  ): Promise<{
    docType: DocumentNumberType;
    prefix: string;
    preview: string;
    expectedNextNumber: number;
  }> {
    const tenantId = this.requireTenant();
    const invalid = validateDocumentPrefix(prefix);
    if (invalid) throw new BadRequestException(invalid);
    if (!isYearScoped(docType)) {
      throw new BadRequestException(`${docTypeLabel(docType)} numbering has no preview.`);
    }
    const key = { tenantId_docType_year: { tenantId, docType, year: 0 } };
    return this.prisma.tenantTransaction(async (tx: Prisma.TransactionClient) => {
      const existing = await tx.numberingSequence.findUnique({ where: key });
      const padding = existing?.padding ?? DEFAULTS[docType].padding;
      const expectedNextNumber = existing?.nextNumber ?? 1;
      const preview = await this.previewConfigured(
        tx,
        docType,
        tenantId,
        prefix,
        padding,
        expectedNextNumber,
      );
      return { docType, prefix, preview, expectedNextNumber };
    });
  }

  /**
   * Save a tenant's sequence config (the import numbering card). Runs inside
   * one short `tenantTransaction` (D7: never nested) so the guard reads below
   * share the mint path's clients/RLS. Guards (SA-274 Q2/Q3, SA-287b), checked
   * before any write:
   *   - `dto.expectedNextNumber` is REQUIRED (400, "reload the settings") and
   *     must equal the stored `nextNumber` — 1 for an unsaved row — (the
   *     version token the card loaded) or the save 409s: the numbering moved
   *     since the card was opened, reload and retry.
   *   - `dto.nextNumber`, when given for a year-scoped docType, must be ABOVE
   *     the tenant's true numeric max for the effective prefix or the save
   *     400s naming the exact document number it collides with — lowering
   *     the next number above the max is an explicit, allowed act; landing
   *     at or below it never silently truncates history. The mint-time
   *     max-first GREATEST (`mintConfigured`) stays the net for an import
   *     that lands after this save.
   * The write itself: a compare-and-set (`updateMany` gated on the stored
   * `nextNumber`, 0 rows matched → 409) against an existing row, or a plain
   * `create` when none exists yet (a concurrent first save racing to the same
   * row → P2002 → 409). A card save and a configured mint serialize on this
   * row (the mint locks it first, `mintConfigured`).
   * The version token is `nextNumber` ONLY (SA-274 Q3, SA-287 LOW, accepted):
   * a prefix/padding edit saved from another tab, or a next number raised and
   * lowered back to the same value, leaves it unchanged, so a stale save can
   * still overwrite that tab's prefix/padding. It cannot rewind the counter
   * below an existing number — the Q2 guard above still refuses that.
   */
  async updateSettings(
    docType: DocumentNumberType,
    dto: UpdateNumberingDto,
  ): Promise<NumberingSettingRow> {
    const tenantId = this.requireTenant();
    const d = DEFAULTS[docType];
    const key = { tenantId_docType_year: { tenantId, docType, year: 0 } };
    const staleMessage = `${docTypeLabel(docType)} numbering changed since you opened it — reload and try again.`;

    return this.prisma.tenantTransaction(async (tx: Prisma.TransactionClient) => {
      // SA-287b: the version token is REQUIRED — a token-less write could lower a live counter
      // under an in-flight mint. An unsaved row's token is the card's loaded default, 1.
      // `== null`: JSON null passes the DTO's @IsOptional, and must be the same 400 (SA-306).
      if (dto.expectedNextNumber == null) {
        throw new BadRequestException(
          `These ${docTypeLabel(docType)} numbering settings are out of date — reload the settings and try again.`,
        );
      }
      const existing = await tx.numberingSequence.findUnique({ where: key });
      if ((existing?.nextNumber ?? 1) !== dto.expectedNextNumber) {
        throw new ConflictException(staleMessage);
      }

      if (dto.nextNumber !== undefined && isYearScoped(docType)) {
        const effectivePrefix = dto.prefix ?? existing?.prefix ?? d.prefix;
        const max = await this.scanMaxForYear(tx, docType, tenantId, 0, effectivePrefix);
        if (dto.nextNumber <= max) {
          const taken = await this.findTakenNumeric(tx, docType, tenantId, effectivePrefix, max);
          throw new BadRequestException(
            taken
              ? `${taken} already exists — the next ${docTypeLabel(docType)} number must be ${max + 1} or higher.`
              : `The next ${docTypeLabel(docType)} number must be ${max + 1} or higher.`,
          );
        }
      }

      const data = {
        ...(dto.prefix !== undefined && { prefix: dto.prefix }),
        ...(dto.nextNumber !== undefined && { nextNumber: dto.nextNumber }),
        ...(dto.padding !== undefined && { padding: dto.padding }),
      };

      let row: { docType: DocumentNumberType; prefix: string; nextNumber: number; padding: number };
      if (existing) {
        const result = await tx.numberingSequence.updateMany({
          // A WhereInput takes plain columns, never the compound-unique `key`.
          where: { tenantId, docType, year: 0, nextNumber: dto.expectedNextNumber },
          data,
        });
        if (result.count === 0) {
          throw new ConflictException(staleMessage);
        }
        row = await tx.numberingSequence.findUniqueOrThrow({ where: key });
      } else {
        try {
          row = await tx.numberingSequence.create({
            data: {
              tenantId,
              docType,
              prefix: dto.prefix ?? d.prefix,
              nextNumber: dto.nextNumber ?? 1,
              padding: dto.padding ?? d.padding,
            },
          });
        } catch (err: any) {
          if (err?.code !== "P2002") throw err;
          throw new ConflictException(staleMessage);
        }
      }

      const rowDocType = row.docType;
      const preview = isYearScoped(rowDocType)
        ? await this.previewConfigured(
            tx,
            rowDocType,
            tenantId,
            row.prefix,
            row.padding,
            row.nextNumber,
          )
        : this.format(row.prefix, row.nextNumber, row.padding);

      return {
        docType: row.docType,
        prefix: row.prefix,
        nextNumber: row.nextNumber,
        padding: row.padding,
        preview,
        configured: true,
      };
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
   * segment; omit it (or pass 0) for byte-identical pre-B100 behaviour. For a
   * year-scoped docType (SA-274 Q1) a saved settings-card row (year 0) takes
   * PRECEDENCE over `opts.year` whenever one exists — see `mintYearScoped`.
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
   * For a year-scoped docType (`isYearScoped()`, typed `YearScopedDocType` — the
   * live INVOICE, ESTIMATE and (B267) CREDIT_NOTE series), `mintYearScoped`
   * dispatches in this order (SA-274 Q1/Q2, first hit wins, `reserveNext` never
   * creates the year-0 row itself):
   *   1. a saved year-0 row exists → `mintConfigured` — max-first (below);
   *   2. else `opts.year > 0` → `mintForYear`, UNCHANGED from before this fix;
   *   3. else → `BadRequestException` (a mint can never CREATE a year-0 row —
   *      that row now means "the tenant saved the settings card"; no live
   *      caller omits the year, so this is unreached in practice).
   * `mintForYear` keeps these two extra guarantees for its per-year series:
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
   * `mintConfigured` (the saved-row series) applies the SAME collision guard,
   * but max-first: it re-scans the true numeric max on every attempt and
   * reserves `GREATEST(nextNumber, max+1)+1` in ONE statement BEFORE proving
   * the candidate free, so an import landing after the save is never undercut
   * (SA-274 Q2) — the guard below only ever fires on a race with a concurrent
   * out-of-band write, not on the ordinary path.
   * Every other case (year-0 series on a non-year-scoped docType, i.e.
   * PAYMENT/RETURN/ORDER) keeps the exact pre-B100 fast path: a single atomic
   * increment, no collision check, relying on Postgres serializing concurrent
   * `UPDATE`s of the SAME row (no explicit lock). `mintConfigured` differs: it
   * takes a row lock first with `SELECT … FOR UPDATE`, then reserves in one
   * `UPDATE`, so no caller can observe a torn read on either path.
   */
  async reserveNext(
    docType: DocumentNumberType,
    opts?: { year?: number; tenantId?: string; tx?: Prisma.TransactionClient },
  ): Promise<string> {
    const tenantId = this.requireTenant(opts);
    const year = opts?.year ?? 0;
    const d = DEFAULTS[docType];
    const callerTx = opts?.tx;

    if (isYearScoped(docType)) {
      // An in-transaction caller reserves ON its own client — opening one here
      // would be a NESTED transaction (a second pooled connection while the
      // caller holds one). Otherwise the reservation gets its OWN short
      // transaction, committed before the number is returned.
      const run = (tx: Prisma.TransactionClient) =>
        this.mintYearScoped(tx, docType, tenantId, year, d);
      return callerTx ? run(callerTx) : this.prisma.tenantTransaction(run);
    }

    // Fast path: ensure a row exists, then atomically increment it. On a caller's
    // tx both statements run there (never a nested transaction); standalone, they
    // get their own short transaction, as the year-scoped branch above does.
    const key = { tenantId_docType_year: { tenantId, docType, year } };
    const run = async (tx: Prisma.TransactionClient) => {
      // #2177: the seed MUST NOT raise. A Prisma `upsert` here is a select-then-insert, so two
      // first mints racing the same (tenant, docType, year) row surfaced P2002 to the loser —
      // and inside a caller's transaction a unique violation aborts the WHOLE transaction
      // (SQLSTATE 25P02). A conflict-tolerant INSERT seeds atomically instead: the loser waits
      // on the winner's uncommitted row, inserts nothing, and increments after it (the same
      // seed `mintForYear` uses).
      await tx.$executeRaw`
        INSERT INTO "NumberingSequence"
          ("id", "tenantId", "docType", "year", "prefix", "padding", "nextNumber", "updatedAt")
        VALUES (
          ${randomUUID()}, ${tenantId}, ${docType}::"DocumentNumberType", ${year},
          ${d.prefix}, ${d.padding}, 1, NOW()
        )
        ON CONFLICT ("tenantId", "docType", "year") DO NOTHING
      `;
      const updated = await tx.numberingSequence.update({
        where: key,
        data: { nextNumber: { increment: 1 } },
      });
      return this.format(updated.prefix, updated.nextNumber - 1, updated.padding, year);
    };
    return callerTx ? run(callerTx) : this.prisma.tenantTransaction(run);
  }

  /**
   * Dispatch for a year-scoped docType (SA-274 Q1, `reserveNext`'s doc comment
   * has the full ordering rationale): a saved year-0 row (the settings card)
   * IS the live series and takes precedence over `year` whenever one exists;
   * only with nothing saved does `year` select the legacy per-tenant-year
   * series (`mintForYear`, unchanged); with neither, minting is refused — a
   * mint must never CREATE a year-0 row.
   */
  private async mintYearScoped(
    db: Prisma.TransactionClient,
    docType: YearScopedDocType,
    tenantId: string,
    year: number,
    d: { prefix: string; padding: number },
  ): Promise<string> {
    const configuredKey = { tenantId_docType_year: { tenantId, docType, year: 0 } };
    const saved = await db.numberingSequence.findUnique({ where: configuredKey });
    if (saved) {
      return this.mintConfigured(db, docType, tenantId);
    }
    if (year > 0) {
      const key = { tenantId_docType_year: { tenantId, docType, year } };
      return this.mintForYear(db, docType, tenantId, year, key, d);
    }
    throw new BadRequestException(
      `Minting a ${docTypeLabel(docType)} number needs a year, or a saved row on the numbering settings card.`,
    );
  }

  /**
   * The configured series (SA-274 Q1/Q2): a saved year-0 row is the live
   * continuous prefix+pad(n) series for this doc type — no year segment,
   * never resets. Max-first, so an import landing after the save is never
   * undercut: every attempt re-scans the tenant's true numeric max for the
   * prefix and reserves `GREATEST(nextNumber, max+1)+1` in ONE statement
   * before proving the candidate free — the collision loop below only ever
   * fires on a race between that scan and a concurrent out-of-band write.
   */
  private async mintConfigured(
    db: Prisma.TransactionClient,
    docType: YearScopedDocType,
    tenantId: string,
  ): Promise<string> {
    const MINT_MAX_ATTEMPTS = 5;
    // SA-287b: lock the saved row FIRST. A card save writes the same row, so it now waits for
    // this mint (or this mint waits for it) instead of changing the prefix between the max
    // scan and the reservation — which could issue a number at or below an existing document
    // under the new prefix. Standalone callers hold the lock for their own short transaction;
    // the delivery path's `opts.tx` holds it until its commit, as the per-year UPDATE already does.
    const locked = await db.$queryRaw<
      Array<{ nextNumber: number; prefix: string; padding: number }>
    >`
      SELECT "nextNumber", "prefix", "padding" FROM "NumberingSequence"
      WHERE "tenantId" = ${tenantId}
        AND "docType" = ${docType}::"DocumentNumberType"
        AND "year" = 0
      FOR UPDATE
    `;
    if (!locked[0]) {
      throw new ConflictException(
        `The saved ${docTypeLabel(docType)} numbering changed while minting — try again.`,
      );
    }
    const prefix = locked[0].prefix;
    let priorNext = locked[0].nextNumber;
    let skipped = 0;

    for (let attempt = 0; attempt < MINT_MAX_ATTEMPTS; attempt++) {
      const max = await this.scanMaxForYear(db, docType, tenantId, 0, prefix);
      const rows = await db.$queryRaw<
        Array<{ nextNumber: number; prefix: string; padding: number }>
      >`
        UPDATE "NumberingSequence"
        SET "nextNumber" = GREATEST("nextNumber", ${max + 1}) + 1, "updatedAt" = NOW()
        WHERE "tenantId" = ${tenantId}
          AND "docType" = ${docType}::"DocumentNumberType"
          AND "year" = 0
        RETURNING "nextNumber", "prefix", "padding"
      `;
      const row = rows[0];
      const reserved = row.nextNumber - 1;
      // The row is locked, so RETURNING carries the prefix this attempt scanned; format with the
      // scanned one regardless, never with a prefix the max scan did not cover.
      const padding = row.padding;

      if (reserved > priorNext) skipped += reserved - priorNext;
      priorNext = row.nextNumber;

      const candidate = this.format(prefix, reserved, padding);
      const clash = await this.findTakenNumeric(db, docType, tenantId, prefix, reserved);
      if (!clash) {
        if (skipped) {
          this.logger.warn(
            `Numbering for ${docType} tenant ${tenantId} advanced past ${skipped} existing number(s) to ${candidate}.`,
          );
        }
        return candidate;
      }
    }

    throw new ConflictException(
      `Could not find a free ${docType} number for tenant ${tenantId} after ${MINT_MAX_ATTEMPTS} attempts.`,
    );
  }

  /**
   * The read-only mirror of the configured mint's preview (SA-274 Q5): the
   * true next number a save-less `getSettings`/`updateSettings` caller would
   * see, without reserving anything — `format(prefix, max(nextNumber,
   * numericMax+1), padding)`. No collision loop needed: the scanned max is
   * itself the highest existing document, so one past it can never collide.
   */
  private async previewConfigured(
    db: Prisma.TransactionClient,
    docType: YearScopedDocType,
    tenantId: string,
    prefix: string,
    padding: number,
    nextNumber: number,
  ): Promise<string> {
    const max = await this.scanMaxForYear(db, docType, tenantId, 0, prefix);
    return this.format(prefix, Math.max(nextNumber, max + 1), padding);
  }

  /**
   * The read-only mirror of `mintForYear`'s preview when nothing is saved:
   * the per-year row's stored `nextNumber` (else the scanned max + 1, for a
   * tenant that has never minted this year), then the loop's first-clash
   * jump replayed read-only (≤ 5 attempts) so an imported block does not make
   * the preview lie about the next live number.
   */
  private async previewUnconfigured(
    db: Prisma.TransactionClient,
    docType: YearScopedDocType,
    tenantId: string,
    prefix: string,
    padding: number,
    year: number,
  ): Promise<string> {
    const key = { tenantId_docType_year: { tenantId, docType, year } };
    const existing = await db.numberingSequence.findUnique({ where: key });
    const rowPrefix = existing?.prefix ?? prefix;
    const rowPadding = existing?.padding ?? padding;
    let candidateNumber =
      existing?.nextNumber ??
      (await this.scanMaxForYear(db, docType, tenantId, year, rowPrefix)) + 1;

    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const candidate = this.format(rowPrefix, candidateNumber, rowPadding, year);
      const clash = await this.findTaken(db, docType, tenantId, candidate);
      if (!clash) return candidate;
      const max = await this.scanMaxForYear(db, docType, tenantId, year, rowPrefix);
      candidateNumber = Math.max(max + 1, candidateNumber + 1);
    }
    return this.format(rowPrefix, candidateNumber, rowPadding, year);
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
    switch (docType) {
      case "ESTIMATE":
        return db.estimate.findFirst({ where: { tenantId, estimateNumber: candidate } });
      case "CREDIT_NOTE":
        return db.creditNote.findFirst({ where: { tenantId, creditNoteNumber: candidate } });
      default:
        return db.invoice.findFirst({ where: { tenantId, invoiceNumber: candidate } });
    }
  }

  /**
   * The stored document number matching numeric value `n` under `prefix`
   * (leading-zero and `-R{i}` reissue-suffix tolerant), or null when free.
   * Used both to prove a just-reserved configured candidate free (SA-274 Q2)
   * and, on a refused save, to name the exact document number the guard is
   * protecting — called with `n = max`, so it returns the very row that set
   * the max. `prefix` is regex-escaped like `scanMaxForYear`'s pattern; the
   * three literal table branches mirror it too.
   */
  private async findTakenNumeric(
    db: Prisma.TransactionClient,
    docType: YearScopedDocType,
    tenantId: string,
    prefix: string,
    n: number,
  ): Promise<string | null> {
    const pattern = `^${escapeRegex(prefix)}0*${n}(?:-R\\d+)?$`;
    let rows: Array<{ number: string }>;
    switch (docType) {
      case "ESTIMATE":
        rows = await db.$queryRaw<Array<{ number: string }>>`
            SELECT "estimateNumber" AS number
            FROM "Estimate"
            WHERE "tenantId" = ${tenantId} AND "estimateNumber" ~ ${pattern}
            LIMIT 1
          `;
        break;
      case "CREDIT_NOTE":
        rows = await db.$queryRaw<Array<{ number: string }>>`
            SELECT "creditNoteNumber" AS number
            FROM "CreditNote"
            WHERE "tenantId" = ${tenantId} AND "creditNoteNumber" ~ ${pattern}
            LIMIT 1
          `;
        break;
      default:
        rows = await db.$queryRaw<Array<{ number: string }>>`
            SELECT "invoiceNumber" AS number
            FROM "Invoice"
            WHERE "tenantId" = ${tenantId} AND "invoiceNumber" ~ ${pattern}
            LIMIT 1
          `;
    }
    return rows?.[0]?.number ?? null;
  }

  /**
   * The tenant's true numeric max for the series: `<PREFIX><year>-####`
   * (`-R{i}`) when `year > 0` (the live per-tenant-year INVOICE/ESTIMATE/
   * CREDIT_NOTE series, B100/F16b); `<PREFIX>####`(`-R{i}`) — no year segment
   * — when `year === 0` (the SA-274 configured card series). `prefix` is
   * regex-escaped (SA-274 Q2) so a tenant prefix containing an ARE
   * metacharacter (e.g. "INV." or "INV(") is matched literally rather than as
   * a regex fragment; the three default prefixes contain only `-`, which is
   * NOT escaped, so their per-year pattern is byte-identical to before this
   * fix. The capture is bounded to 9 digits ON PURPOSE: the imported numbers
   * sharing this namespace are arbitrary text, and a longer segment would
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
    // Year 0 (the configured series) skips leading zeros before the 9-digit capture: its
    // namespace holds migrated numbers of any zero-padding (padding 0–12), and `0090000123`
    // must count as 90000123, never vanish from the max (pre-merge review of #2170). The
    // per-year pattern stays byte-identical.
    const pattern =
      year > 0
        ? `^${escapeRegex(prefix)}${year}-(\\d{1,9})(?:-R\\d+)?$`
        : `^${escapeRegex(prefix)}0*(\\d{1,9})(?:-R\\d+)?$`;
    let rows: Array<{ max: number | null }>;
    switch (docType) {
      case "ESTIMATE":
        rows = await db.$queryRaw<Array<{ max: number | null }>>`
            SELECT COALESCE(MAX((regexp_match("estimateNumber", ${pattern}))[1]::int), 0)::int AS max
            FROM "Estimate"
            WHERE "tenantId" = ${tenantId}
          `;
        break;
      case "CREDIT_NOTE":
        rows = await db.$queryRaw<Array<{ max: number | null }>>`
            SELECT COALESCE(MAX((regexp_match("creditNoteNumber", ${pattern}))[1]::int), 0)::int AS max
            FROM "CreditNote"
            WHERE "tenantId" = ${tenantId}
          `;
        break;
      default:
        rows = await db.$queryRaw<Array<{ max: number | null }>>`
            SELECT COALESCE(MAX((regexp_match("invoiceNumber", ${pattern}))[1]::int), 0)::int AS max
            FROM "Invoice"
            WHERE "tenantId" = ${tenantId}
          `;
    }
    return Number(rows?.[0]?.max ?? 0);
  }

  private requireTenant(opts?: { tenantId?: string }): string {
    const tenantId = this.prisma.getTenantId() ?? opts?.tenantId;
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }
}
