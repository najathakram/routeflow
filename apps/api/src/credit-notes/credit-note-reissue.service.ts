import { CREDIT_SOURCE_EXCLUDED } from "../invoices/invoice-status-sets";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "crypto";
import { roundMoney } from "@routeflow/pricing";
import { Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NumberingService } from "../import/numbering.service";
import { IdempotencyService } from "../common/idempotency.service";
import { tenantTimeZone } from "../common/tenant-time-zone";
import { retryOnTxConflict } from "../common/tx-retry";
import { CreditNotesService } from "./credit-notes.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { asReadableConflict, cnBad, cnConflict, codeOf, messageOf } from "./credit-note-errors";
import { SOURCE_DELETED_MESSAGE, hasSourceDeletedMarker } from "./sourced-credit-guard";

export interface ReissueInput {
  amount: number;
  items?: Array<{ invoiceItemId: string; amount: number; qty?: number }>;
  reason?: string;
  expiresAt?: string | null;
}

export interface ReissueResult {
  voided: { id: string; creditNoteNumber: string };
  creditNote: any;
  unapplied: Array<{ invoiceId: string; invoiceNumber: string; amount: number }>;
}

/** What the idempotency row stores: the request's fingerprint plus the response it produced. */
interface StoredReissue {
  fingerprint: string;
  response: ReissueResult;
}

/** SA-535a(1): a return-backed note is edited through the return, never the note. */
const RETURN_BACKED = (returnNumber?: string | null) =>
  `This credit note backs a return${returnNumber ? ` (${returnNumber})` : ""}. Edit the return instead.`;

/** The refusal codes the cap and the void raise as 400s that are, for a reissue, a 409 conflict. */
const STATE_CODES = new Set<string>([
  API_ERROR_CODES.CREDIT_NOTE_OVER_HEADROOM,
  API_ERROR_CODES.CREDIT_NOTE_SOURCE_GONE,
  API_ERROR_CODES.CREDIT_NOTE_CHANGED_CONCURRENTLY,
  API_ERROR_CODES.CREDIT_NOTE_CREDIT_CONSUMED,
  API_ERROR_CODES.CREDIT_NOTE_VOID_NOT_EDITABLE,
  API_ERROR_CODES.CREDIT_NOTE_RETURN_BACKED,
]);

/** SA-608c: a note with no source invoice (born standalone, or orphaned by deleteInvoice). */
const NO_SOURCE_CAP =
  "A credit note without a source invoice can't be increased; issue a separate credit.";

/** A carried reason from an earlier reissue loses its own "Replaces …" prefix (no chains). */
const REPLACES_PREFIX = /^Replaces CN-\S+(?: — )?/;

/**
 * #2648 / SA-535(b) + SA-535a/b: an amount or line edit of a credit note. It is NEVER in place
 * (SA-500): ONE Serializable transaction voids the old note through `voidWithReversalInTx` (the
 * same locks in SA-214 order, refusals, reversal, apply blocks and ledger counter-entries as
 * `POST :id/void-with-reversal`) and then mints the replacement through `insertCreditNoteInTx`,
 * re-capped against the source invoice AFTER the void. The new note is unapplied. An
 * `Idempotency-Key` makes a replay return the same new note.
 */
@Injectable()
export class CreditNoteReissueService {
  private readonly logger = new Logger(CreditNoteReissueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creditNotes: CreditNotesService,
    private readonly numbering: NumberingService,
    private readonly idempotency: IdempotencyService,
    private readonly gateway: RouteFlowGateway,
  ) {}

  /** A stable hash of what the request asks for, so a key reused for a different edit is a 409. */
  static fingerprint(dto: ReissueInput): string {
    const items = [...(dto.items ?? [])]
      .map((i) => ({ i: i.invoiceItemId, a: Number(i.amount), q: i.qty ?? null }))
      .sort((x, y) => (x.i < y.i ? -1 : x.i > y.i ? 1 : x.a - y.a));
    const body = {
      amount: Number(dto.amount),
      items,
      reason: dto.reason ?? null,
      expiresAt: dto.expiresAt === undefined ? "<keep>" : dto.expiresAt,
    };
    return createHash("sha256").update(JSON.stringify(body)).digest("hex");
  }

  async reissue(
    id: string,
    dto: ReissueInput,
    idempotencyKey: string | undefined,
    actorId: string | null,
  ): Promise<ReissueResult> {
    const key = idempotencyKey?.trim();
    if (!key)
      throw cnBad(
        API_ERROR_CODES.CREDIT_NOTE_KEY_REQUIRED,
        "An Idempotency-Key header is required.",
      );
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    const scope = `creditNoteReissue:${id}`;
    const fingerprint = CreditNoteReissueService.fingerprint(dto);

    // ── Before any write: a replay returns what the first attempt recorded, whatever the note's
    // state is now (it is VOID after a successful reissue), and burns no number.
    const cached = await this.prisma.tenantTransaction(async (tx: any) => {
      await this.idempotency.acquireLock(this.idempotency.hashFor(key, tenantId, scope), tx);
      return this.idempotency.check<StoredReissue>(key, tenantId, scope, tx);
    });
    if (cached) return this.replay(cached, fingerprint);

    const db = this.prisma.forTenant();
    const old = await db.creditNote.findFirst({
      where: { id },
      select: {
        id: true,
        creditNoteNumber: true,
        status: true,
        amount: true,
        customerId: true,
        invoiceId: true,
        reason: true,
        expiresAt: true,
        autoApplyExcluded: true,
        amountUsed: true,
      },
    });
    if (!old) throw new NotFoundException("Credit note not found");
    if (old.status === "VOID")
      throw cnConflict(
        API_ERROR_CODES.CREDIT_NOTE_VOID_NOT_EDITABLE,
        "A void credit note can't be edited or reissued.",
      );
    // SA-535a(1): the SUPERSET — any live return-backed note (the void's own refusal set).
    const ret = await db.return.findFirst({
      where: { creditNoteId: id, status: { notIn: ["CANCELLED", "REJECTED"] } },
      select: { returnNumber: true },
    });
    if (ret)
      throw cnConflict(API_ERROR_CODES.CREDIT_NOTE_RETURN_BACKED, RETURN_BACKED(ret.returnNumber));
    // Credit consumed somewhere a reversal cannot reach (RETURN_CREDIT_CONSUMED) is refused here,
    // BEFORE a number is reserved, so a refused attempt burns none. The void re-checks in-tx.
    const consumed = await this.creditNotes.voidWithReversalRefusal(
      db,
      old,
      await this.creditNotes.liveCreditPayments(db, id),
    );
    if (consumed) throw cnConflict(consumed.code, consumed.message);

    // #2848: a durable SOURCE_DELETED marker (written by every invoice-destroying door) refuses the
    // note entirely: no reissue, at any amount.
    if (await hasSourceDeletedMarker(db, id))
      throw cnConflict(API_ERROR_CODES.CREDIT_NOTE_SOURCE_GONE, SOURCE_DELETED_MESSAGE);
    // SA-608c (b): no invoice but line rows = its source was deleted (the rows survive); a reissue
    // would silently drop the split, so it is refused. (a): every no-invoice note is capped at its
    // own amount, so an edit can never create value the note did not already hold.
    if (!old.invoiceId) {
      const lineRows = await db.creditNoteItem.count({ where: { creditNoteId: id } });
      if (lineRows > 0)
        throw cnConflict(API_ERROR_CODES.CREDIT_NOTE_SOURCE_GONE, SOURCE_DELETED_MESSAGE);
      if (roundMoney(Number(dto.amount)) > roundMoney(Number(old.amount)) + 0.001)
        throw cnConflict(API_ERROR_CODES.CREDIT_NOTE_NO_SOURCE_CAP, NO_SOURCE_CAP);
    }

    const expiresAt = this.resolveExpiry(dto.expiresAt, old.expiresAt);
    const lineItems = Array.isArray(dto.items) && dto.items.length > 0 ? dto.items : undefined;
    if (lineItems && !old.invoiceId)
      throw cnBad(
        API_ERROR_CODES.CREDIT_NOTE_LINE_INVALID,
        "Credit line items require a source invoice",
      );
    // A line-linked note carries its line split (and, for regulated lines, the ledger reversal
    // keyed on it). A reissue without lines would silently drop both, so it must restate them.
    if (!lineItems && old.invoiceId) {
      const linked = await db.creditNoteItem.count({
        where: { creditNoteId: id, invoiceItemId: { not: null } },
      });
      if (linked > 0)
        throw cnBad(
          API_ERROR_CODES.CREDIT_NOTE_LINES_REQUIRED,
          "This credit is split across invoice lines: give the new amount for each line.",
        );
    }
    const carried = (dto.reason ?? old.reason ?? "").replace(REPLACES_PREFIX, "").trim();
    const reason = `Replaces ${old.creditNoteNumber}${carried ? ` — ${carried}` : ""}`;
    const capDto = {
      customerId: old.customerId,
      invoiceId: old.invoiceId ?? undefined,
      amount: Number(dto.amount),
      items: lineItems,
    };

    const customer = await db.customer.findFirst({
      where: { id: old.customerId },
      select: { id: true, businessName: true },
    });
    if (!customer) throw new NotFoundException("Customer not found");

    // SA-535b(1): the dry run leaves the old note out of both caps, so it counts exactly the
    // headroom the void will free. A refusal here is a 409 and burns no number.
    await this.asConflict(() =>
      this.creditNotes.validateAndBuildCnItems(db, capDto, { excludeCreditNoteId: old.id }),
    );

    // Hoisted above the SERIALIZABLE tx, as create() does: a blocked counter UPDATE would abort
    // under SERIALIZABLE instead of queueing. Every retry below reuses this one number.
    const creditNoteNumber = await this.numbering.reserveNext("CREDIT_NOTE", {
      year: new Date().getFullYear(),
      tenantId,
    });
    const tz = await tenantTimeZone(this.prisma);

    // SA-608g: the SOURCE invoice and its order go into the void's own sorted lock sets (SA-214), so
    // the mint's KEY SHARE on the invoice never comes after holding the note. Read here, outside the
    // tx: an invoice's order link never changes, and a row deleted meanwhile locks as a no-op.
    const sourceInvoice = old.invoiceId
      ? await db.invoice.findFirst({ where: { id: old.invoiceId }, select: { orderId: true } })
      : null;
    // B947: the recap is pooled across the order's creditable invoices, so every one of them joins the void's sorted lock set.
    const siblings = sourceInvoice?.orderId
      ? await db.invoice.findMany({
          where: { orderId: sourceInvoice.orderId, status: { notIn: CREDIT_SOURCE_EXCLUDED } },
          select: { id: true },
        })
      : [];
    const lockExtra = {
      orderIds: sourceInvoice?.orderId ? [sourceInvoice.orderId] : [],
      invoiceIds: [
        ...new Set([...(old.invoiceId ? [old.invoiceId] : []), ...siblings.map((i: any) => i.id)]),
      ],
    };

    let outcome: { replayed: boolean; stored: StoredReissue };
    try {
      outcome = await retryOnTxConflict(`credit reissue cn=${id}`, () =>
        this.prisma.tenantTransaction(
          async (tx: any): Promise<{ replayed: boolean; stored: StoredReissue }> => {
            await this.idempotency.acquireLock(this.idempotency.hashFor(key, tenantId, scope), tx);
            const raced = await this.idempotency.check<StoredReissue>(key, tenantId, scope, tx);
            if (raced) return { replayed: true, stored: raced };

            // The void, unchanged: Order → Invoice → CreditNote locks, refusal, reversal, apply
            // blocks, CAS, ledger counter-entries, the VOIDED audit row. A refusal that only a
            // race can reach here is a 409 (the return case keeps the reissue wording).
            const { reopened } = await this.asConflict(
              () =>
                this.creditNotes.voidWithReversalInTx(tx, id, actorId, tz, undefined, lockExtra),
              true,
            );

            // #2848 / SA-608f: the marker again, under the lock. deleteInvoice may have committed it
            // between the pre-check and here, and then a capped edit would be wrong: it must refuse.
            if (await hasSourceDeletedMarker(tx, id))
              throw cnConflict(API_ERROR_CODES.CREDIT_NOTE_SOURCE_GONE, SOURCE_DELETED_MESSAGE);

            // SA-608c (a), again under the lock: deleteInvoice may have unlinked the note since the
            // pre-read, which would turn a sourced edit into an uncapped standalone one.
            const cur = await tx.creditNote.findUnique({
              where: { id },
              select: { invoiceId: true, amount: true },
            });
            if (
              cur &&
              !cur.invoiceId &&
              roundMoney(Number(dto.amount)) > roundMoney(Number(cur.amount)) + 0.001
            )
              throw cnConflict(API_ERROR_CODES.CREDIT_NOTE_NO_SOURCE_CAP, NO_SOURCE_CAP);

            // B222 re-cap on the tx, AFTER the void and WITHOUT the exclude: authoritative.
            const cnItemsData = await this.asConflict(() =>
              this.creditNotes.validateAndBuildCnItems(tx, capDto),
            );
            const created = await this.creditNotes.insertCreditNoteInTx(
              tx,
              {
                creditNoteNumber,
                customerId: old.customerId,
                invoiceId: old.invoiceId,
                amount: Number(dto.amount),
                reason,
                expiresAt,
                // SA-608: an operator's "keep out of the send-time sweep" survives the reissue.
                autoApplyExcluded: old.autoApplyExcluded,
              },
              cnItemsData,
              tenantId,
              customer,
            );

            // SA-535a(2): SUPERSEDED on the old note, REISSUED on the new one (SA-442 vocabulary).
            await tx.auditLog.create({
              data: {
                tenantId,
                userId: actorId,
                action: "SUPERSEDED",
                entityType: "CreditNote",
                entityId: old.id,
                meta: { replacedById: created.id, replacedByNumber: created.creditNoteNumber },
              },
            });
            await tx.auditLog.create({
              data: {
                tenantId,
                userId: actorId,
                action: "REISSUED",
                entityType: "CreditNote",
                entityId: created.id,
                meta: {
                  replaces: old.id,
                  replacesNumber: old.creditNoteNumber,
                  unapplied: reopened,
                } as any,
              },
            });

            const stored: StoredReissue = {
              fingerprint,
              response: {
                voided: { id: old.id, creditNoteNumber: old.creditNoteNumber },
                creditNote: created,
                unapplied: reopened,
              },
            };
            await this.idempotency.save(key, tenantId, scope, stored, tx);
            return { replayed: false, stored };
          },
          { isolationLevel: "Serializable" },
        ),
      );
    } catch (err) {
      throw asReadableConflict(err, this.logger);
    }

    if (outcome.replayed) return this.replay(outcome.stored, fingerprint);

    // After commit only: never light the dashboard for a transaction that rolled back.
    const { response } = outcome.stored;
    this.gateway.emitCreditNoteVoided(tenantId, {
      creditNoteId: old.id,
      creditNoteNumber: old.creditNoteNumber,
      customerId: old.customerId,
      amount: Number(old.amount),
    });
    this.gateway.emitCreditNoteCreated(tenantId, {
      creditNoteId: response.creditNote.id,
      creditNoteNumber: response.creditNote.creditNoteNumber,
      customerId: response.creditNote.customerId,
      amount: Number(response.creditNote.amount),
    });
    return response;
  }

  private replay(stored: StoredReissue, fingerprint: string): ReissueResult {
    if (stored.fingerprint !== fingerprint)
      throw cnConflict(
        API_ERROR_CODES.CREDIT_NOTE_KEY_REUSED,
        "This Idempotency-Key was already used for a different edit of this credit note.",
      );
    return stored.response;
  }

  /** Omitted keeps the old expiry (400 if already past); null clears it; a date must be future. */
  private resolveExpiry(input: string | null | undefined, old: Date | null): Date | null {
    if (input === null) return null;
    if (input === undefined) {
      if (old && new Date(old).getTime() <= Date.now())
        throw cnBad(
          API_ERROR_CODES.CREDIT_NOTE_EXPIRY_PAST,
          "This credit note has expired: set a new expiry to reissue it.",
        );
      return old ? new Date(old) : null;
    }
    const d = new Date(input);
    if (isNaN(d.getTime())) throw new BadRequestException("expiresAt must be a valid ISO date");
    if (d.getTime() <= Date.now())
      throw cnBad(API_ERROR_CODES.CREDIT_NOTE_EXPIRY_PAST, "expiresAt must be in the future");
    return d;
  }

  /**
   * The cap and the void refuse with 400; for a reissue every such refusal is a 409 (SA-535(b)):
   * the source is gone, the headroom is exceeded, or the note changed underneath. `fromVoid`
   * swaps the void's return-backed wording for the reissue's "edit the return instead".
   */
  private async asConflict<T>(run: () => Promise<T>, fromVoid = false): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof BadRequestException)) throw err;
      const code = codeOf(err);
      // Only a STATE refusal (cap exceeded, source gone/uncreditable, void raced or refused) is a
      // 409; a malformed line (LINE_INVALID) and anything uncoded stay the 400 they are.
      if (!code || !STATE_CODES.has(code)) throw err;
      const text = messageOf(err);
      if (fromVoid && code === API_ERROR_CODES.CREDIT_NOTE_RETURN_BACKED) {
        const m = /\(([^)]+)\)/.exec(text);
        throw cnConflict(API_ERROR_CODES.CREDIT_NOTE_RETURN_BACKED, RETURN_BACKED(m?.[1]));
      }
      throw cnConflict(code as never, text);
    }
  }
}
