import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";

// PR-1c: exported so InlineReturnsService (inline-returns.service.ts) shares the SAME
// reason set and restock default instead of a second hand-typed copy (L-072-class risk) —
// the values/text stay byte-identical, so returns-restock-parity.spec.ts's scan of this
// exact declaration (it matches from `const NO_RESTOCK_REASONS` onward, `export` prefix and
// all) still passes unchanged.
export const VALID_RETURN_REASONS = [
  "DAMAGED",
  "WRONG_ITEM",
  "CUSTOMER_REFUSED",
  "QUALITY_ISSUE",
  "EXCESS_ORDER",
] as const;

// Reasons where the returned goods are physically unsellable never restock by
// default; the rest go back into stock unless the caller says otherwise.
export const NO_RESTOCK_REASONS = new Set(["DAMAGED", "QUALITY_ISSUE"]);
import { Prisma } from "@prisma/client";
import type { UnbilledReturnItem } from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { lockOrderRow } from "../credit-notes/credit-note-locks";
import {
  addCredits,
  piecesPerQtyOf,
  planProductRefund,
  toHeadroomLine,
  loadLineCredits,
  loadOrderPool,
  pooledRefundRefusal,
  type HeadroomLine,
  type OrderPool,
  type RefundItem,
} from "../credit-notes/line-credit-headroom";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { isLockUnavailableError } from "../common/db-locks";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import {
  EXTERNAL_REFUND_METHOD,
  isRefundPending,
  loadInvoiceRefundState,
  lockRefundInvoices,
  lockRefundOrders,
  refundSourcesRefusal,
  resolveRefundInvoiceIds,
  type RefundTender,
} from "./inline-return-refund";
import { assertCashRefundWithinCap } from "./cash-refund-cap";
import {
  assertStandardRefundWithinRemainder,
  previewStandardRefund,
} from "./refund-remainder-guard";
import {
  NOTHING_CREDITABLE_MESSAGE,
  REFUND_LOCK_TIMEOUT_MS,
  REFUND_TX_TIMEOUT_MS,
  isTransactionExpired,
  isNothingBilledRefusal,
  pricedNothingBilled,
  refundAlreadyResolved,
  refundBasisChanged,
  refundBusy,
  refundClaimWhere,
} from "./standard-refund-claim";
import { dbClockNow, lockCounterClose, registerKeyOfOrder } from "./counter-close-lock";
import { assertCounterWindowOpen } from "./counter-close-window";
import { refundTenderData, refundTenderOfColumn } from "./refund-tender";
import { roundMoney } from "@routeflow/pricing";
import type { ProcessRefundDto } from "./dto/process-refund.dto";
import { CREDIT_SOURCE_EXCLUDED } from "../invoices/invoice-status-sets";
import { IdempotencyService } from "../common/idempotency.service";
import { NumberingService } from "../import/numbering.service";
import {
  PACK_LINE_SELECT,
  capBasis,
  returnedPiecesByProduct,
  soldQtyForProduct,
  returnPricingAxis,
  standardPackBases,
  standardPackBasesForOrders,
  standardReturnPieces,
} from "./returns-pieces.util";
import { restockReturnItems } from "./returns-restock.util";
import { standardRestockResolver, type ProductPackBasis } from "./returns-restock-pieces";

/** M6/§2.3: every standard-path method refuses an INLINE-kind return — it has its own
 * endpoints and state machine (PR-1c/1d). Thrown the moment a `kind` is known to be INLINE. */
const INLINE_RETURN_USE_INLINE_ENDPOINTS = API_ERROR_CODES.INLINE_RETURN_USE_INLINE_ENDPOINTS;

/** SA-737: the return read (before the locks, and again under them) that the refund basis is priced from. */
const REFUND_RETURN_INCLUDE = {
  items: true,
  order: {
    select: {
      // `id` feeds the order-scoped headroom aggregate in billedBasisFor.
      id: true,
      orderNumber: true,
      // SA-740r2 item 6: a counter order's refund takes the counter-close lock on its register
      counterSale: true,
      registerKey: true,
      // F08 B53: the creditable/VOID decision must be made IN CODE
      // (billedBasisFor), never as a DB-level status filter here — excluding
      // VOID/WRITTEN_OFF at the query makes a VOID-only order indistinguishable
      // from a never-invoiced order (both come back with zero rows), which
      // would silently take the legacy order-line fallback instead of refusing.
      // Fetch every invoice with enough to price + rank it.
      invoices: {
        select: {
          id: true,
          // The remaining-room refusal below names this invoice to the operator
          // (billedBasisFor → the toast description), so the HUMAN number has to
          // travel with the row: without it the message degrades to a raw UUID.
          invoiceNumber: true,
          status: true,
          total: true,
          createdAt: true,
          items: {
            select: {
              id: true,
              productId: true,
              qty: true,
              subtotal: true,
              boxes: true,
              unitsPerBox: true,
              pieces: true,
              product: { select: { unitsPerBox: true } },
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }], // deterministic fill order (SA-628)
          },
        },
      },
      lineItems: {
        select: {
          ...PACK_LINE_SELECT, // B965: the pack evidence the mixed-unit gate reads (id, split, unit label, product pack)
          unitPrice: true,
          subtotal: true,
        },
      },
    },
  },
} as const satisfies Prisma.ReturnInclude;

/** The shape `create` returns — reused to type a replayed (idempotent) result. */
type CreatedReturn = Prisma.ReturnGetPayload<{ include: { items: true } }>;

/** The priced refund of a STANDARD return (`billedBasisFor` / `externalRefundBasis`), as the claim and the mint read it. */
type RefundBasis = {
  amount: number;
  invoiceId?: string;
  items?: RefundItem[];
  pooledRefund?: Array<{ productId: string; qty: number }>;
  unbilledItems?: UnbilledReturnItem[];
  refusal?: string;
};

/** F08 B166/B75: options object for `findAll`/`findAllForUser` — `search` narrows by
 * return/order number or customer name; everything else is unchanged filtering. */
export interface FindAllReturnsOptions {
  orderId?: string;
  customerId?: string;
  /** B221: scopes to returns on orders assigned to this driver's route run. */
  driverId?: string;
  status?: string;
  reason?: string;
  search?: string;
  /** #2406: STANDARD (default, unchanged list) | INLINE | ALL (no kind filter). Validated by
   * the controller's whitelist before it ever reaches here. */
  kind?: "STANDARD" | "INLINE" | "ALL";
  /** SA-727b: only INLINE returns captured for a REFUND whose refund is not recorded yet (RECEIVED, EXTERNAL_REFUND stored,
   * refundedAt null, no credit note). Overrides `kind` and `status`. */
  pendingRefund?: boolean;
  page?: number;
  limit?: number;
}

@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RouteFlowGateway,
    private readonly ledger: RegulatedLedgerService,
    private readonly creditNotes: CreditNotesService,
    private readonly numbering: NumberingService,
    // Provided by the @Global CommonModule in every running app. Declared
    // @Optional so the four existing ReturnsService spec suites (which predate
    // it and provide no mock) still resolve; a request carrying no
    // Idempotency-Key never touches it, which is the no-header regression pin.
    @Optional() private readonly idempotency?: IdempotencyService,
  ) {}

  private readonly logger = new Logger(ReturnsService.name);

  // DAMAGED/QUALITY_ISSUE goods are unsellable and must not restock by default;
  // WRONG_ITEM/CUSTOMER_REFUSED/EXCESS_ORDER goods are fine and go back to stock.
  private defaultRestockForReason(reason: string | undefined): boolean {
    return !NO_RESTOCK_REASONS.has(reason ?? "");
  }

  // B353: the last-six-digits-of-Date.now() scheme collided every ~16.7
  // minutes (1e6 ms). RETURN's DocumentNumberType/DEFAULTS entry was seeded
  // for exactly this call (see numbering.service.ts). Runs on the caller's
  // OWN transaction (`opts.tx`) — this is always invoked from inside
  // `create()`'s `tenantTransaction`, and reserving standalone here would be
  // a nested transaction (numbering.service.ts's `reserveNext` doc comment).
  private async generateReturnNumber(tx: Prisma.TransactionClient): Promise<string> {
    const year = new Date().getFullYear();
    const tenantId = this.prisma.getTenantId() ?? undefined;
    return this.numbering.reserveNext("RETURN", { year, tenantId, tx });
  }

  async create(dto: any, userId: string, userRole?: string, idempotencyKey?: string) {
    if (!VALID_RETURN_REASONS.includes(dto.reason)) {
      throw new BadRequestException(
        `Invalid reason. Must be one of: ${VALID_RETURN_REASONS.join(", ")}`,
      );
    }
    // POST /returns binds `@Body() dto: any`, so nothing validates the payload
    // shape — without this a body with no `items` reached the validation loop
    // below and surfaced as a 500 ("dto.items is not iterable") instead of a 400.
    if (!Array.isArray(dto.items) || dto.items.length === 0) {
      throw new BadRequestException("At least one return item is required");
    }

    // F1 (independent review round 1, PR-2): the scope used to be tenant+orderId alone, so two
    // DIFFERENT submitters (two drivers, or a driver and a customer-portal user) reusing the
    // same orderId+client-generated key collided onto one submitter's cached result — scope now
    // also includes the submitting user. The per-ATTEMPT half of F1 (the SAME submitter's own
    // retry-vs-genuinely-new-return distinction) lives in the nonce the caller bakes into the
    // key itself (`apps/mobile/lib/return-submit-key.ts`), not in this scope string. tenantId is
    // a required positional argument on `check`/`save` now (F6), so it can never be folded into
    // a hand-built scope string a caller forgets.
    const idemScopeSuffix = `returns.create:${userId}:${dto.orderId}`;
    const tenantId = this.prisma.getTenantId();

    // Cumulative-qty validation and the create must share one transaction: two
    // concurrent requests previously read the same snapshot, both passed the
    // remaining-qty check, and both committed — over-returning the order and
    // (once each was refunded) paying the customer twice for the same goods.
    const { ret, replayed, order } = await this.prisma.tenantTransaction(async (tx) => {
      // F5 round 2 (N1, independent review round 2, PR-2): check-then-create-then-save is a
      // check-then-act race — two concurrent replays of the same key both miss the check
      // (neither has saved yet) and both create a return. Round 1 closed this with a SEPARATE
      // session-level advisory lock on its own dedicated connection pool; the review judged that
      // pool an unjustified extra failure surface. `acquireLock` instead takes a
      // TRANSACTION-scoped `pg_advisory_xact_lock` on THIS transaction's own connection — no
      // extra connection, auto-released at commit/rollback. `check`/`save` run on this same
      // connection too, so the return row and its idempotency-key cache entry commit or roll
      // back TOGETHER — see idempotency.service.ts's class docstring for the full savepoint
      // reasoning, and for why `acquireLock` itself is the one method here that fails CLOSED.
      //
      // Round 3 (independent review round 3, PR-2): the replay check runs BEFORE the order
      // lookup/DELIVERED/ownership validation below, not after — those checks read MUTABLE
      // order state that can legitimately differ between a submission's first attempt and a
      // later retry (the order's status can change for reasons that have nothing to do with
      // this return, e.g. a separate workflow). A retry must return what was already recorded
      // regardless of the order's CURRENT state, never a 404/400 for state that moved out from
      // under an already-successful attempt.
      if (idempotencyKey && this.idempotency) {
        const lockHash = this.idempotency.hashFor(idempotencyKey, tenantId, idemScopeSuffix);
        await this.idempotency.acquireLock(lockHash, tx);
        const cached = await this.idempotency.check<CreatedReturn>(
          idempotencyKey,
          tenantId,
          idemScopeSuffix,
          tx,
        );
        if (cached) return { ret: cached, replayed: true as const, order: undefined };
      }

      // tx is already tenant-scoped (tenantTransaction wraps it with the same forTenant()
      // extension) — this is the identical read `this.prisma.forTenant().order.findUnique(...)`
      // used to be, just now sharing the lock/check's connection and transaction.
      const order = await tx.order.findUnique({
        where: { id: dto.orderId },
        include: {
          customer: { select: { id: true, businessName: true } },
          // status/position feed returns-pieces.util.ts's CANCELLED exclusion and
          // position-ordered axis pick (fix-round: these were missing, so both were
          // silently no-ops against a real query — see returns-overreturn.spec.ts's
          // CANCELLED-line probe, which only caught this because it mocked fields the
          // real query never selected).
          lineItems: {
            select: {
              ...PACK_LINE_SELECT, // id + the pack evidence the piece-axis cap reads (SA-158)
              unitPrice: true,
              subtotal: true,
            },
          },
          invoices: { select: { id: true } },
        },
      });
      if (!order) throw new NotFoundException("Order not found");
      if (order.status !== "DELIVERED")
        throw new BadRequestException("Returns can only be submitted for delivered orders");

      // Customers can only create returns for their own orders
      if (userRole === "CUSTOMER") {
        const customer = await tx.customer.findFirst({ where: { userId } });
        if (!customer || order.customerId !== customer.id) {
          throw new ForbiddenException("You can only submit returns for your own orders");
        }
      }

      // §5: serialize every return against this CUSTOMER (not just this order) —
      // the (PR-1c/1d) INLINE capture flow shares the same prior-returned accounting
      // (returnedPiecesByProduct) across a customer's orders, so two concurrent
      // returns — one STANDARD, one INLINE, on different orders for the same
      // customer's same product — must not both read the same stale "remaining"
      // snapshot. Placed after the idempotency lock/check and the unlocked order
      // read (source of customerId) above, before the order-row FOR UPDATE below.
      if (this.idempotency) {
        await this.idempotency.acquireLock(
          this.idempotency.hashFor(order.customerId, tenantId, "returns.customer"),
          tx,
        );
      }

      // The transaction ALONE does not close the race: tenantTransaction runs at
      // Postgres' default READ COMMITTED, so two concurrent creates would each
      // take a snapshot without the other's uncommitted insert, both pass the
      // remaining-qty check, and both commit. Lock the order row first so they
      // serialize here — mirrors the FOR UPDATE idiom in invoices.service.ts
      // recordPayment() and routes.service.ts dispatch.
      await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${dto.orderId} FOR UPDATE`;

      // B4/m-6: prior-returned pieces per product, shared with the (PR-1c/1d) INLINE
      // capture flow — sums STANDARD Return rows AND (once they exist) INLINE
      // ReturnItem rows sourced from this order. See returns-pieces.util.ts.
      // SA-158: cap, prior-returned and remaining are all in PIECES; the pack basis is resolved once
      // per order (only ambiguous lines query) and shared, so a mixed or unknown basis refuses (409)
      // before anything is written.
      const packBases = await standardPackBases(tx, dto.orderId, order.lineItems as any);
      const alreadyReturned = await returnedPiecesByProduct(tx, dto.orderId, packBases);

      // Validate return qty does not exceed ordered qty per item (cumulative)
      for (const item of dto.items) {
        if (!item.qty || item.qty <= 0)
          throw new BadRequestException("Return item quantity must be greater than zero");
        // The ITEM-level reason overrides dto.reason when deciding restock below, and
        // defaultRestockForReason treats every string outside NO_RESTOCK_REASONS as
        // sellable — so an unvalidated "damaged" (lower-case) or any typo would restock
        // unsellable goods, which is exactly the B61 defect. The body binds as
        // `@Body() dto: any`, so no class-validator layer catches it: validate here.
        if (item.reason != null && !VALID_RETURN_REASONS.includes(item.reason))
          throw new BadRequestException(
            `Invalid reason for product ${item.productId}. Must be one of: ${VALID_RETURN_REASONS.join(", ")}`,
          );
        // B4/m-6: sold pieces = the SUM of the product's non-CANCELLED lines on this
        // order (not just the first one `.find()` happened to match) — see
        // returns-pieces.util.ts. A product absent from every live line still 400s,
        // matching the pre-fix "not in the original order" behaviour.
        const soldLineUnits = soldQtyForProduct(order as any, item.productId);
        if (soldLineUnits <= 0)
          throw new BadRequestException(`Product ${item.productId} was not in the original order`);
        const cap = capBasis(packBases, item.productId); // 409: mixed / no line / half-resolvable
        const prior = alreadyReturned[item.productId];
        if (cap.mode === "lineUnit") {
          // SA-161: a legacy line whose pack cannot be resolved. Typed and sold share the line's own unit,
          // so the cap is exact with no pack (master's arithmetic); nothing is guessed or written. The one
          // honest refusal: a prior INLINE return (pieces) cannot be netted against line units.
          const inlinePieces = prior ? ("unknown" in prior ? prior.inlinePieces : prior.pieces) : 0;
          if (inlinePieces > 0)
            throw new ConflictException(
              `Product ${item.productId}: cannot reconcile a piece-based return with this line's unit; return it inline instead.`,
            );
          const returnedUnits = prior && "unknown" in prior ? prior.lineUnits : 0;
          const remainingUnits = soldLineUnits - returnedUnits;
          if (Number(item.qty) > remainingUnits)
            throw new BadRequestException(
              `Return qty (${Number(item.qty)}) exceeds remaining returnable qty (${remainingUnits}) for product ${item.productId}. Already returned: ${returnedUnits} of ${soldLineUnits}.`,
            );
          alreadyReturned[item.productId] = {
            unknown: true,
            reason: prior && "unknown" in prior ? prior.reason : "legacy line unit",
            lineUnits: returnedUnits + Number(item.qty),
            inlinePieces: 0,
          };
          continue;
        }
        if (prior && "unknown" in prior) throw new ConflictException(prior.reason);
        const { pieces: returnPieces, toLineUnit } = standardReturnPieces(
          packBases,
          item.productId,
          Number(item.qty),
        );
        const orderedQty = soldLineUnits * cap.factor;
        const previouslyReturned = prior?.pieces ?? 0;
        const remaining = orderedQty - previouslyReturned;
        if (returnPieces > remaining)
          throw new BadRequestException(
            `Return qty (${toLineUnit(returnPieces)}) exceeds remaining returnable qty (${toLineUnit(remaining)}) for product ${item.productId}. Already returned: ${toLineUnit(previouslyReturned)} of ${toLineUnit(orderedQty)}.`,
          );
        // Count this line against the running total too: a single payload that
        // lists the same productId twice previously validated every line against
        // the same pre-request snapshot, so 2 × qty 10 against 10 ordered both
        // passed and over-returned with no concurrency involved at all.
        alreadyReturned[item.productId] = { pieces: previouslyReturned + returnPieces };
      }

      const returnNumber = await this.generateReturnNumber(tx);
      const created = await tx.return.create({
        data: {
          returnNumber,
          orderId: dto.orderId,
          customerId: order.customerId,
          reason: dto.reason,
          notes: dto.notes,
          photoUrls: dto.photoUrls ?? [],
          status: "PENDING",
          kind: "STANDARD",
          items: {
            create: dto.items.map((i: any) => ({
              productId: i.productId,
              qty: i.qty,
              reason: i.reason,
              condition: i.condition ?? undefined,
              notes: i.notes ?? undefined,
              restock: i.restock ?? this.defaultRestockForReason(i.reason ?? dto.reason),
              tenantId: this.prisma.getTenantId(), // nested creates bypass forTenant() extension
            })),
          },
        },
        include: { items: true },
      });

      // Saved INSIDE this same transaction — the row and its idempotency-key cache entry commit
      // or roll back together (round 1 saved AFTER the transaction committed, on a separate
      // connection, leaving a narrow crash window with no cache entry for an already-created row).
      if (idempotencyKey && this.idempotency) {
        await this.idempotency.save(idempotencyKey, tenantId, idemScopeSuffix, created, tx);
      }

      return { ret: created, replayed: false as const, order };
    });

    // Stored/replayed inside the transaction above, so a replay never reaches here having
    // re-run any of the writes it replayed — but it DOES still need to skip the emit below, or
    // a replayed return.created would light up the operator dashboard twice. `order` is only
    // ever undefined on the replayed branch (round 3: order lookup now happens AFTER the replay
    // check, so a cache hit never reaches it) — exactly when this block is skipped.
    if (!replayed) {
      this.gateway.emitReturnCreated(tenantId, {
        returnId: ret.id,
        customerId: order.customerId,
        customerName: order.customer.businessName,
        orderId: dto.orderId,
        reason: dto.reason,
      });
    }

    return ret;
  }

  async findAllForUser(user: JwtPayload, options: FindAllReturnsOptions = {}) {
    if (user.role === "CUSTOMER") {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      // A CUSTOMER user with no Customer row must see NOTHING — passing
      // `customerId: undefined` through would drop the scoping filter entirely and
      // hand them the tenant-wide list (mirrors credit-notes' findAllForUser guard).
      if (!customer) {
        const page = options.page ?? 1;
        const limit = options.limit ?? 20;
        return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
      }
      return this.findAll({ ...options, customerId: customer.id });
    }
    // B221: findAll's own tenant scoping (forTenant()) is not USER scoping — a
    // driver with no branch here saw every return in the tenant, not just
    // returns on orders assigned to their own route runs.
    if (user.role === "DRIVER") {
      const driver = await this.prisma
        .forTenant()
        .driver.findFirst({ where: { userId: user.sub } });
      if (!driver) {
        const page = options.page ?? 1;
        const limit = options.limit ?? 20;
        return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
      }
      return this.findAll({ ...options, driverId: driver.id });
    }
    return this.findAll(options);
  }

  /**
   * F08 B166: `search` narrows the list by return number, order number, or
   * customer business name (case-insensitive contains) — ANDed with the
   * existing filters, so a CUSTOMER's `customerId` scoping still applies.
   * F08 B75: each row carries `refundEstimate`, priced by the SAME pure
   * `priceReturn` helper `processRefund`/`findOne` price from — never a
   * client-side `qty × unitPrice` re-derivation, and never the mint-time
   * `billedBasisFor` (that one is a money GATE: it hits the DB per row and
   * refuses). A row whose basis is not creditable reports 0 WITH
   * `refundEstimateReason`, so a real $0 is distinguishable from a refusal.
   */
  async findAll(options: FindAllReturnsOptions = {}) {
    const {
      orderId,
      customerId,
      driverId,
      status,
      reason,
      search,
      kind = "STANDARD",
      pendingRefund = false,
      page = 1,
      limit = 20,
    } = options;
    const skip = (page - 1) * limit;
    // M6/§2.3, extended by #2406: the default (STANDARD) keeps this the post-delivery RMA
    // surface only, unchanged. `kind: "INLINE"` or `"ALL"` is opt-in (the order-detail panel,
    // SA-484c) — an INLINE row's money is already resolved at capture (ReturnItem.unitPrice/
    // subtotal), so it SKIPS the priceReturn()/billedBasisFor() enrichment below entirely.
    const where: any = {};
    if (kind !== "ALL") where.kind = kind;
    if (orderId) where.orderId = orderId;
    if (customerId) where.customerId = customerId;
    // A relation filter, not a scalar FK — Return carries no driverId of its
    // own (RETURN → orderId → Order.routeRunId → RouteRun.driverId). An order
    // with no route run assigned (routeRunId null) can never match, which is
    // correct: it was never on any driver's route.
    if (driverId) where.order = { routeRun: { driverId } };
    if (status) where.status = status;
    if (pendingRefund) {
      // SA-727b: the "Pending refunds" list (one definition: `isRefundPending`, inline-return-refund.ts)
      where.kind = "INLINE";
      where.status = "RECEIVED";
      where.refundMethod = EXTERNAL_REFUND_METHOD;
      where.refundedAt = null;
      where.creditNoteId = null;
    }
    if (reason) where.reason = reason;
    if (search) {
      where.OR = [
        { returnNumber: { contains: search, mode: "insensitive" } },
        { order: { orderNumber: { contains: search, mode: "insensitive" } } },
        { customer: { businessName: { contains: search, mode: "insensitive" } } },
      ];
    }
    const [data, total] = await Promise.all([
      this.prisma.forTenant().return.findMany({
        where,
        include: {
          order: {
            select: {
              id: true,
              orderNumber: true,
              invoices: {
                select: {
                  id: true,
                  status: true,
                  total: true,
                  createdAt: true,
                  items: {
                    select: {
                      id: true,
                      productId: true,
                      qty: true,
                      subtotal: true,
                      boxes: true,
                      unitsPerBox: true,
                      pieces: true,
                      product: { select: { unitsPerBox: true } },
                    },
                    orderBy: [{ createdAt: "asc" }, { id: "asc" }], // deterministic fill order (SA-628)
                  },
                },
              },
              lineItems: {
                select: {
                  ...PACK_LINE_SELECT, // B969: the pack evidence the pieces-basis price reads
                  unitPrice: true,
                  subtotal: true,
                },
              },
            },
          },
          customer: { select: { id: true, businessName: true } },
          items: { include: { product: { select: { id: true, name: true } } } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      this.prisma.forTenant().return.count({ where }),
    ]);
    // B969: ONE invoice-item read for the whole page (only for lines whose pack needs evidence), never one per row.
    const packBasesByOrder = await standardPackBasesForOrders(
      this.prisma.forTenant(),
      data.filter((ret: any) => ret.kind !== "INLINE").map((ret: any) => ret.order),
    );
    const enriched = data.map((ret: any) => {
      // The invoice graph above is fetched ONLY to price a STANDARD row — it never crosses
      // the wire (GET /returns is readable by DRIVER/CUSTOMER roles). The response's
      // `order` keeps exactly the { id, orderNumber } shape it had before B75.
      const { order, ...rest } = ret;
      const strippedOrder = order ? { id: order.id, orderNumber: order.orderNumber } : order;
      // #2406: an INLINE row's money was already resolved at capture (refundAmount, on `rest`
      // via the ReturnItem/order graph) — it never calls priceReturn, and reports its refusal
      // as "INLINE" so a client can tell it apart from a STANDARD row's real refusal/estimate.
      if (ret.kind === "INLINE") {
        return {
          ...rest,
          order: strippedOrder,
          refundEstimate: null,
          refundEstimateReason: "INLINE",
          // SA-727b: a return captured for a refund that is not recorded yet (the POS "pending" state)
          refundPending: isRefundPending(ret),
        };
      }
      // Pure, DB-free pricing: the read path must never issue a per-row query (the
      // list is fetched with limit 500 for the KPI tile) and must never swallow a
      // refusal into a silent $0 — the reason travels with the row instead.
      const { amount, refusal } = this.priceReturn(
        ret.items ?? [],
        ret.order ?? undefined,
        packBasesByOrder.get(ret.order?.id) ?? new Map(),
      );
      return {
        ...rest,
        order: strippedOrder,
        refundEstimate: amount,
        refundEstimateReason: refusal ?? null,
      };
    });
    return { data: enriched, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async approve(id: string) {
    const ret = await this.prisma.forTenant().return.findUnique({ where: { id } });
    if (!ret) throw new NotFoundException("Return not found");
    if (ret.kind === "INLINE") throw new BadRequestException(INLINE_RETURN_USE_INLINE_ENDPOINTS);
    if (ret.status !== "PENDING")
      throw new BadRequestException("Only PENDING returns can be approved");
    return this.prisma.forTenant().return.update({ where: { id }, data: { status: "APPROVED" } });
  }

  async reject(id: string) {
    const ret = await this.prisma.forTenant().return.findUnique({ where: { id } });
    if (!ret) throw new NotFoundException("Return not found");
    if (ret.kind === "INLINE") throw new BadRequestException(INLINE_RETURN_USE_INLINE_ENDPOINTS);
    if (ret.status !== "PENDING")
      throw new BadRequestException("Only PENDING returns can be rejected");
    return this.prisma.forTenant().return.update({ where: { id }, data: { status: "REJECTED" } });
  }

  async markInTransit(id: string) {
    const ret = await this.prisma.forTenant().return.findUnique({ where: { id } });
    if (!ret) throw new NotFoundException("Return not found");
    if (ret.kind === "INLINE") throw new BadRequestException(INLINE_RETURN_USE_INLINE_ENDPOINTS);
    if (ret.status !== "APPROVED")
      throw new BadRequestException("Only APPROVED returns can be marked in transit");
    return this.prisma.forTenant().return.update({ where: { id }, data: { status: "IN_TRANSIT" } });
  }

  async receive(id: string, userId: string, opts?: { restock?: boolean }) {
    const ret = await this.prisma
      .forTenant()
      .return.findUnique({ where: { id }, include: { items: true } });
    if (!ret) throw new NotFoundException("Return not found");
    if (ret.kind === "INLINE") throw new BadRequestException(INLINE_RETURN_USE_INLINE_ENDPOINTS);
    if (!["APPROVED", "IN_TRANSIT"].includes(ret.status))
      throw new BadRequestException("Only APPROVED or IN_TRANSIT returns can be received");

    return this.prisma.tenantTransaction(async (tx) => {
      // Concurrency guard: atomically CLAIM the APPROVED/IN_TRANSIT→RECEIVED transition
      // before any restock or ledger reversal. A racing receive() (double-click,
      // retry, or two operators) matches 0 rows here and aborts, so the goods
      // can't be double-restocked or double-reversed. Under READ COMMITTED the
      // second writer re-checks the WHERE after the row lock, so exactly one wins.
      const claimed = await tx.return.updateMany({
        where: { id, status: { in: ["APPROVED", "IN_TRANSIT"] } },
        data: { status: "RECEIVED" },
      });
      if (claimed.count === 0) {
        throw new BadRequestException("Only APPROVED or IN_TRANSIT returns can be received");
      }
      // B848 (a sibling of SA-737): the Order row lock, in the house order Return (the claim above) -> Order, BEFORE the restock
      // and the ledger reversal. The reversal is pro-rated from the order's per-line remaining balances; two receives on one
      // order, or a receive beside a void, a cancel or a refund of it, must not read the same balance. Row lock only.
      if (ret.orderId) await lockOrderRow(tx, this.prisma.getTenantId(), ret.orderId);

      if (opts?.restock === false) {
        // "We are not keeping these goods": skip restocking entirely, and persist
        // restock=false on every item so a later cancel() — which decrements stock
        // for every item whose restock flag is true — stays symmetric with what was
        // actually put back on the shelf (nothing).
        await tx.returnItem.updateMany({ where: { returnId: id }, data: { restock: false } });
      } else {
        // PR-1c: shared with InlineReturnsService.capture() — see returns-restock.util.ts.
        // B665: a STANDARD return is typed in the line's own unit; stock is in pieces.
        await restockReturnItems(tx, ret, userId, standardRestockResolver(tx, ret.orderId));
      }
      // W5c: reverse the regulated sales ledger for the returned goods (pro-rated,
      // idempotent per return). Independent of `restock` — a returned regulated
      // sale must reverse for tax even if the goods aren't put back in stock.
      const returnedByProduct = new Map<string, number>();
      for (const item of ret.items) {
        returnedByProduct.set(
          item.productId,
          (returnedByProduct.get(item.productId) ?? 0) + Number(item.qty),
        );
      }
      await this.ledger.reverseReturnEntries({
        returnId: ret.id,
        orderId: ret.orderId,
        returnedByProduct,
        // The STANDARD path's ReturnItem.qty mirrors OrderItem.qty (returns-pieces.util.ts
        // converts to pieces only for the cap, never on disk) — the line's OWN unit,
        // never pieces (live production regression, B661/B671 fix round 2).
        returnedUnit: "LINE_UNIT",
        db: tx,
      });
      // Status already flipped to RECEIVED by the claim above; return the record.
      return tx.return.findUnique({ where: { id } });
    });
  }

  /**
   * F08 B53: prices a refund from what was actually BILLED — the order's
   * "creditable" (non-VOID/non-WRITTEN_OFF) invoices — instead of re-deriving it
   * from the order line. A single creditable invoice sources the credit directly;
   * 2+ mint against the LATEST one (by createdAt) so create()'s per-invoice cap
   * still applies, gated by a headroom check against what's already been credited
   * on those invoices; none creditable (invoices exist but all excluded) refuses
   * rather than silently falling back; an order with zero invoice rows at all
   * (never invoiced) keeps the legacy order-line basis. Refund qty is capped at
   * the billed qty (`min(returned, billed)`); narrowing that further by what was
   * already DELIVERED needs a `ReturnItem.deliveredQty` column (migration), so
   * the B53 x B128 composition is filed separately rather than half-built here.
   */
  private async billedBasisFor(
    items: any[],
    order?: any,
    // SA-737: the claim transaction's client when the basis is recomputed under the locks; the plain tenant client otherwise
    db: any = this.prisma.forTenant(),
  ): Promise<{
    amount: number;
    invoiceId?: string;
    items?: RefundItem[];
    pooledRefund?: Array<{ productId: string; qty: number }>;
    unbilledItems?: UnbilledReturnItem[];
  }> {
    // B969: the pack basis is loaded FIRST: the price below and the itemiser count in PIECES with it, the same converters the
    // preview (`findOne`/`findAll`) uses, so preview == mint.
    const packBases = await this.packBasesOf(order, db);
    const { amount, invoiceId, creditable, refusal, unresolvedProductId } = this.priceReturn(
      items,
      order,
      packBases,
    );
    if (refusal === "NOTHING_CREDITABLE") {
      throw new BadRequestException(NOTHING_CREDITABLE_MESSAGE);
    }
    // B965 (SA-628l): a STANDARD return's qty is in its order line's OWN unit, so a product sold on lines with different pack
    // factors (2 boxes of 12 on one line, 12 loose pieces on another) has no single piece count: every line-unit sum below
    // would add boxes to pieces. create() already refuses to record one (SA-158); this is the refund door's safety net for
    // legacy RECEIVED rows, refused BEFORE the claim and BEFORE the never-invoiced shortcut (its order-line pricing adds boxes to
    // pieces and mints with no cap). EXTERNAL_REFUND (priceReturn only) stays the escape hatch.
    const returnedByProduct = new Map<string, number>();
    for (const it of items)
      returnedByProduct.set(
        it.productId,
        (returnedByProduct.get(it.productId) ?? 0) + Number(it.qty),
      );
    for (const productId of returnedByProduct.keys()) {
      const basis = packBases.get(productId);
      if (basis && ("mixed" in basis || ("unknown" in basis && !basis.singleUnit)))
        throw this.mixedUnitRefusal(productId);
    }
    // B969: a product with no live order line whose billed items count in different units has no single axis either.
    if (refusal === "UNIT_UNRESOLVED" && unresolvedProductId)
      throw this.mixedUnitRefusal(unresolvedProductId);

    // No invoice rows at all: the amount came from the legacy order-line basis and
    // there is no source invoice for create() to cap against, so nothing to gate.
    if (creditable.length === 0) return { amount, invoiceId };

    // B959: which returned products have NO billed line (qty > 0) on any creditable invoice. A billed $0 (free) line IS billed.
    // Nothing billed at all => refuse (a $0 REFUNDED return with no credit note was a silent under-credit); a MIXED return refunds
    // the billed part and reports the rest as readable "not billed, no refund" lines.
    const billedProducts = new Set<string>();
    for (const inv of creditable)
      for (const it of inv.items ?? []) if (Number(it.qty) > 0) billedProducts.add(it.productId);
    const unbilledQty = new Map<string, number>();
    for (const it of items)
      if (Number(it.qty) > 0 && !billedProducts.has(it.productId))
        unbilledQty.set(it.productId, (unbilledQty.get(it.productId) ?? 0) + Number(it.qty));
    const returnedProducts = new Set(
      items.filter((it: any) => Number(it.qty) > 0).map((it: any) => it.productId),
    );
    if (returnedProducts.size > 0 && unbilledQty.size === returnedProducts.size)
      throw new BadRequestException({
        code: API_ERROR_CODES.RETURN_NOTHING_BILLED,
        message:
          "None of the returned items were billed on this order, so there is nothing to refund. " +
          "Cancel the return.",
      });
    let unbilledItems: UnbilledReturnItem[] | undefined;
    if (unbilledQty.size > 0) {
      const names: Array<{ id: string; name: string | null }> =
        (await db.product.findMany({
          where: { id: { in: [...unbilledQty.keys()] } },
          select: { id: true, name: true },
        })) ?? [];
      const nameById = new Map(names.map((p) => [p.id, p.name]));
      unbilledItems = [...unbilledQty].map(([productId, qty]) => {
        const name = nameById.get(productId) ?? "This item";
        return {
          productId,
          name,
          qty,
          message: `${name} was not billed on this order, so no refund was given for it.`,
        };
      });
    }

    // The credit is always minted against ONE invoice — the only creditable one, or
    // the LATEST of 2+ (picked by priceReturn) — because a standalone (invoiceId:
    // undefined) credit would skip create()'s per-invoice cap entirely. Both shapes
    // are gated BEFORE the caller's RECEIVED→REFUNDED claim: 2+ invoices additionally
    // get an order-wide headroom check (the latest invoice alone is not the order's
    // ceiling), and EVERY shape gets the source invoice's OWN remaining-room check,
    // which is what create() actually caps against.
    const latest = creditable.find((inv: any) => inv.id === invoiceId);

    if (creditable.length >= 2) {
      const totalBilled = creditable.reduce(
        (sum: number, inv: any) => sum + Number(inv.total ?? 0),
        0,
      );
      const creditableIds = creditable.map((inv: any) => inv.id);
      // Scope the credited side by the ORDER, not just by invoice id: an unsourced
      // credit note (invoiceId null — exactly what the pre-fix code minted for a
      // 2+-invoice order) is linked to the order through OrderCreditNote, and must
      // still reduce the headroom.
      const creditedScope: any[] = [{ invoiceId: { in: creditableIds } }];
      if (order?.id) creditedScope.push({ orderLinks: { some: { orderId: order.id } } });
      const agg = await db.creditNote.aggregate({
        where: {
          status: { not: "VOID" },
          OR: creditedScope,
        },
        _sum: { amount: true },
      });
      const alreadyCredited = Number((agg as any)?._sum?.amount ?? 0);
      const headroom = totalBilled - alreadyCredited;
      if (amount > headroom + 0.001) {
        throw new BadRequestException(
          "Refund exceeds the remaining headroom on this order's billed invoices",
        );
      }
    }

    // create() caps against the SOURCE invoice alone (`existing credits on it +
    // amount <= its total`), so an amount that clears the order-wide headroom can
    // still be rejected there — after the claim has committed. Refuse here instead.
    // This runs for a SINGLE creditable invoice too: create()'s cap does not care how
    // many invoices the order has, so a lone invoice that already carries a credit
    // note (an earlier partial return, or an operator-issued credit) would otherwise
    // sail past this method and throw inside create() after the claim had committed.
    // SA-628 (B946): a single-invoice refund is ITEMISED against that invoice's lines under the SAME per-line headroom
    // credit notes use, so a credit note and a return refund can never together exceed a line's value. 2+ creditable
    // invoices keep the lump-sum credit minted against the latest one (v1: a refund is one credit note, and a credit
    // note's items must belong to its one invoice). B947: the refund is still CHECKED against the older invoices' lines too (pooled).
    // Done BEFORE the invoice-room check so that check reads the amount that will actually be minted.
    let refundItems: RefundItem[] | undefined;
    let effectiveAmount = amount;
    if (creditable.length === 1 && latest) {
      const itemised = await this.itemiseRefund(items, latest, packBases, db);
      if (itemised.length > 0) {
        refundItems = itemised;
        effectiveAmount = roundMoney(itemised.reduce((n, it) => n + it.amount, 0));
      }
    }

    // B947: 2+ creditable invoices keep the lump sum minted on the latest invoice, but the refund is checked against the SAME
    // per-line headroom, POOLED per product across ALL the creditable invoices (a line on an older invoice was invisible to
    // it). REFUSES (409), never clips, before the claim; create() re-checks it under the locks at the mint (`pooledRefund`).
    let pooledRefund: Array<{ productId: string; qty: number }> | undefined;
    if (creditable.length >= 2 && order?.id) {
      const pool = await loadOrderPool(db, order.id);
      // B967: the pool and the mint count in PIECES; a standard qty is in the line's unit, so it is converted here, once.
      const returnedPieces = new Map<string, number>();
      for (const [productId, qty] of returnedByProduct)
        returnedPieces.set(productId, this.poolPieces(packBases, pool, productId, qty));
      for (const [productId, qty] of returnedPieces) {
        const refused = pooledRefundRefusal(pool, productId, qty);
        if (refused)
          throw new ConflictException({
            code: API_ERROR_CODES.RETURN_REFUND_OVER_LINE_HEADROOM,
            message:
              "This refund would credit more than the order's invoice lines are worth: part of it was already credited " +
              "(by a credit note or an earlier refund). Give store credit for what is still billable, or cancel the return.",
            productId,
            requested: refused.requestedAmount,
            remaining: refused.remainingAmount,
            requestedQty: refused.requestedQty,
            remainingQty: refused.remainingQty,
            qtyUnit: refused.qtyUnit,
          });
      }
      pooledRefund = [...returnedPieces].map(([productId, qty]) => ({ productId, qty }));
    }

    const latestAgg = await db.creditNote.aggregate({
      where: { status: { not: "VOID" }, invoiceId },
      _sum: { amount: true },
    });
    const latestRoom = Number(latest?.total ?? 0) - Number((latestAgg as any)?._sum?.amount ?? 0);
    if (effectiveAmount > latestRoom + 0.001) {
      // The operator reads this string verbatim, so it names the invoice the way the
      // UI does. `invoiceNumber` is selected by every caller that can reach this line
      // (processRefund's query); the `?? invoiceId` fallback covers only the impossible
      // case of a row that lost the field, and a UUID there is a bug, not a label.
      throw new BadRequestException(
        `Refund ${effectiveAmount} exceeds the remaining room ${roundMoney(latestRoom)} on invoice ` +
          `${latest?.invoiceNumber ?? invoiceId}; give store credit for what is still billable, or cancel the return`,
      );
    }
    return {
      amount: effectiveAmount,
      invoiceId,
      ...(refundItems ? { items: refundItems } : {}),
      ...(pooledRefund ? { pooledRefund } : {}),
      ...(unbilledItems ? { unbilledItems } : {}),
    };
  }

  /**
   * A STANDARD return's qty (the order line's own unit) in PIECES for the order pool (B967). One factor: the order lines'
   * (`standardReturnPieces`). Anything else is REFUSED fail-closed (409 RETURN_MIXED_UNIT_PRODUCT), never converted: an unknown
   * basis (a box-unaware line with no pack proof, or billed across several invoice items) has an order-line unit the pool's own
   * factor cannot vouch for, so a box-unaware line on 2+ invoices is refused; so are invoice lines with different factors. Only
   * a product with no live order line at all (the pre-line / fixture shape) takes the pool's single factor.
   */
  private poolPieces(
    bases: Map<string, ProductPackBasis>,
    pool: OrderPool,
    productId: string,
    qty: number,
  ): number {
    const basis = bases.get(productId);
    if (basis && "factor" in basis) return standardReturnPieces(bases, productId, qty).pieces;
    // An UNKNOWN basis (a boxed line with no pack proof, or billed across several invoice items) has an order-line unit the
    // pool's own factor cannot vouch for: refused, never converted. Only a product with no live order line at all (the
    // fixture / pre-line shape) takes the pool's own single factor.
    const factors = new Set(
      pool.lines
        .filter((l) => l.productId === productId && l.qty > 0)
        .map((l) => l.piecesPerQty ?? 1),
    );
    if ((basis && "unknown" in basis) || factors.size > 1)
      throw new ConflictException({
        code: API_ERROR_CODES.RETURN_MIXED_UNIT_PRODUCT,
        message:
          "This product's quantity cannot be priced as one unit across this order's invoices. " +
          "Credit it per line via an inline return, or cancel the return.",
        productId,
      });
    return qty * ([...factors][0] ?? 1);
  }

  /** The pack basis of every product on the order's live lines (B969: the axis a STANDARD return is priced on). */
  private async packBasesOf(
    order?: any,
    db: any = this.prisma.forTenant(),
  ): Promise<Map<string, ProductPackBasis>> {
    return order?.id && (order.lineItems?.length ?? 0) > 0
      ? standardPackBases(db, order.id, order.lineItems)
      : new Map<string, ProductPackBasis>();
  }

  /**
   * EXTERNAL_REFUND mints nothing, so it prices with the PURE helper and skips the mint-time gates, EXCEPT a return with no
   * single pricing axis (B969): that has no refund amount to record, and a recorded $0 would feed net sales silently. Refused
   * 409 RETURN_MIXED_UNIT_PRODUCT, like the mint.
   */
  private async externalRefundBasis(items: any[], order?: any, db: any = this.prisma.forTenant()) {
    const priced = this.priceReturn(items, order, await this.packBasesOf(order, db));
    if (priced.refusal === "UNIT_UNRESOLVED" && priced.unresolvedProductId)
      throw this.mixedUnitRefusal(priced.unresolvedProductId);
    return priced;
  }

  private mixedUnitRefusal(productId: string): ConflictException {
    return new ConflictException({
      code: API_ERROR_CODES.RETURN_MIXED_UNIT_PRODUCT,
      message:
        "This product was sold in different units on this order (for example boxes and loose pieces), so the return " +
        "cannot be priced as one quantity. Credit it per line via an inline return, or cancel the return.",
      productId,
    });
  }

  /**
   * SA-628: the refund as per-line items against `invoice`, filled in line order under what each line still has (qty AND
   * net amount, after item-bearing credit notes and the legacy itemless-refund term). REFUSES (409
   * RETURN_REFUND_OVER_LINE_HEADROOM), never clips, when a returned product has more qty than its lines can still absorb.
   * An invoice whose items carry no id (never the real query) stays a lump sum.
   *
   * B969 (SA-628p): the returned qty is in the ORDER line's unit and an invoice line counts its own (a box-split item counts
   * pieces, a selling-unit item counts boxes), so the lines are planned in PIECES (the `toPiecesPool` shape, the SAME axis
   * `priceReturn` prices on) and each item's qty is written back in its own line's axis (pieces / pieces-per-qty).
   */
  private async itemiseRefund(
    returnItems: any[],
    invoice: any,
    packBases: Map<string, ProductPackBasis>,
    db: any = this.prisma.forTenant(),
  ): Promise<RefundItem[]> {
    const lines: HeadroomLine[] = (invoice?.items ?? []).map(toHeadroomLine);
    if (lines.length === 0 || lines.some((l) => !l.id)) return [];
    const returnedByProduct = new Map<string, number>();
    for (const it of returnItems) {
      returnedByProduct.set(
        it.productId,
        (returnedByProduct.get(it.productId) ?? 0) + Number(it.qty),
      );
    }
    let credited = await loadLineCredits(db, invoice.id, lines);
    const out: RefundItem[] = [];
    for (const [productId, returnedQty] of returnedByProduct) {
      const mine = lines.filter((l) => l.productId === productId);
      const axis = returnPricingAxis(
        packBases,
        productId,
        returnedQty,
        (invoice.items ?? []).filter((it: any) => it.productId === productId),
      );
      if ("unresolved" in axis) throw this.mixedUnitRefusal(productId);
      const factorOf = (l: HeadroomLine): number => (axis.pieces ? (l.piecesPerQty ?? 1) : 1);
      const inPieces = mine.map((l) => ({ ...l, qty: l.qty * factorOf(l), piecesPerQty: 1 }));
      const creditedInPieces = new Map(credited);
      for (const l of mine) {
        const c = credited.get(l.id);
        if (c) creditedInPieces.set(l.id, { ...c, qty: c.qty * factorOf(l) });
      }
      // EPS (0.001) per line on the line's own axis, scaled by its pieces-per-qty, like `pooledRefundRefusal`
      const qtyTol = Math.max(
        0.001,
        mine.reduce((t, l) => t + 0.001 * factorOf(l), 0),
      );
      const { items, refusal } = planProductRefund(
        inPieces,
        creditedInPieces,
        productId,
        axis.returned,
        "refund",
        qtyTol,
      );
      if (refusal) {
        throw new ConflictException({
          code: API_ERROR_CODES.RETURN_REFUND_OVER_LINE_HEADROOM,
          message:
            "This refund would credit more than the invoice line is worth: part of it was already credited " +
            "(by a credit note or an earlier refund). Give store credit for what is still billable, or cancel the return.",
          productId,
          requested: refusal.requestedAmount,
          remaining: refusal.remainingAmount,
          requestedQty: refusal.requestedQty,
          remainingQty: refusal.remainingQty,
          qtyUnit: axis.pieces ? "pieces" : refusal.qtyUnit,
        });
      }
      const lineById = new Map(mine.map((l) => [l.id, l]));
      const inLineAxis = items.map((it) => ({
        ...it,
        qty:
          Math.round((it.qty / factorOf(lineById.get(it.invoiceItemId) as HeadroomLine)) * 1000) /
          1000,
      }));
      out.push(...inLineAxis);
      credited = addCredits(credited, inLineAxis);
    }
    return out;
  }

  /**
   * F08 B75: the PURE half of the billed basis — the money figure only, with no
   * DB round trip and no refusal thrown. Read paths (`findAll`, `findOne`) price
   * from this; `billedBasisFor` wraps it with the mint-time gates (refusal +
   * headroom) that only the write path may apply. `refusal` reports why an
   * amount is 0 so a caller can tell "nothing creditable" from a genuine $0.
   */
  private priceReturn(
    items: any[],
    order: any,
    packBases: Map<string, ProductPackBasis>,
  ): {
    amount: number;
    invoiceId?: string;
    creditable: any[];
    refusal?: "NOTHING_CREDITABLE" | "NOTHING_BILLED" | "UNIT_UNRESOLVED";
    /** B969: the first returned product with no single pricing axis (mixed units); set with `UNIT_UNRESOLVED`. */
    unresolvedProductId?: string;
  } {
    const allInvoices = order?.invoices ?? [];

    if (allInvoices.length === 0) {
      // Never invoiced (or its invoice rows are gone) — legacy order-line basis.
      // PR-1a fix-round (Opus review F1): create()'s over-return cap now sums a
      // product's qty across every non-CANCELLED line (soldQtyForProduct), but this
      // basis used to price off a SINGLE `.find()`-matched line's per-unit rate against
      // the full (now-pooled) returned qty — a product split across two lines priced
      // the whole return at one line's rate, over-crediting whenever the lines differ
      // in price. Pool qty/subtotal per product the same way the invoiced branch below
      // already does, so the cap and the price always agree.
      const soldQtyByProduct = new Map<string, number>();
      const soldSubtotalByProduct = new Map<string, number>();
      for (const li of order?.lineItems ?? []) {
        if (!li.productId || li.status === "CANCELLED") continue;
        soldQtyByProduct.set(
          li.productId,
          (soldQtyByProduct.get(li.productId) ?? 0) + Number(li.qty),
        );
        soldSubtotalByProduct.set(
          li.productId,
          (soldSubtotalByProduct.get(li.productId) ?? 0) + Number(li.subtotal),
        );
      }
      let amount = 0;
      for (const item of items) {
        const soldQty = soldQtyByProduct.get(item.productId) ?? 0;
        if (soldQty <= 0) continue;
        const soldSubtotal = soldSubtotalByProduct.get(item.productId) ?? 0;
        const perUnit = soldSubtotal / soldQty;
        const refundQty = Math.min(Number(item.qty), soldQty);
        amount += refundQty * perUnit;
      }
      return { amount: roundMoney(amount), invoiceId: undefined, creditable: [] };
    }

    const creditable = allInvoices.filter(
      (inv: any) => !CREDIT_SOURCE_EXCLUDED.includes(inv.status as any),
    );
    if (creditable.length === 0) {
      // Invoices exist but none of them can source a credit (all VOID/WRITTEN_OFF).
      // Pricing reports it; only the mint path (billedBasisFor) turns it into a refusal.
      return { amount: 0, invoiceId: undefined, creditable, refusal: "NOTHING_CREDITABLE" };
    }

    const billedQtyByProduct = new Map<string, number>();
    const billedItemsByProduct = new Map<string, any[]>();
    for (const inv of creditable) {
      for (const invItem of inv.items ?? []) {
        billedQtyByProduct.set(
          invItem.productId,
          (billedQtyByProduct.get(invItem.productId) ?? 0) + Number(invItem.qty),
        );
        const list = billedItemsByProduct.get(invItem.productId);
        if (list) list.push(invItem);
        else billedItemsByProduct.set(invItem.productId, [invItem]);
      }
    }

    // SA-628b: the pooled average per product (master's price), the same `planProductRefund` price the mint uses, rounded
    // per product so the preview equals what the mint itemises (money-neutral vs master up to a cent across products).
    // B969 (SA-628p): the average runs in PIECES on both sides (`returnPricingAxis`: the returned qty through
    // `standardReturnPieces`, each billed item through `piecesPerQtyOf`) so 1 box of a 2-box line billed as 24 pieces refunds
    // 12 x (120 / 24), not 1 x (120 / 24).
    const returned = new Map<string, number>();
    for (const item of items) {
      returned.set(item.productId, (returned.get(item.productId) ?? 0) + Number(item.qty));
    }
    let amount = 0;
    let unresolvedProductId: string | undefined;
    for (const [productId, qty] of returned) {
      const billedItems = billedItemsByProduct.get(productId) ?? [];
      if ((billedQtyByProduct.get(productId) ?? 0) <= 0) continue;
      const axis = returnPricingAxis(packBases, productId, qty, billedItems, {
        pooled: creditable.length >= 2,
      });
      if ("unresolved" in axis) {
        unresolvedProductId ??= productId;
        continue;
      }
      const billed = billedItems.reduce(
        (t, it) => t + Number(it.qty) * (axis.pieces ? piecesPerQtyOf(it) : 1),
        0,
      );
      const billedSubtotal = billedItems.reduce((t, it) => t + Number(it.subtotal), 0);
      amount += roundMoney((Math.min(axis.returned, billed) * billedSubtotal) / billed);
    }
    amount = roundMoney(amount);

    // B959: nothing the customer returned was billed on any creditable invoice (a billed $0 line is billed): the preview says
    // so (amount 0 WITH a reason) and billedBasisFor refuses it, instead of a plain $0.
    const nothingBilled =
      [...returned].length > 0 &&
      [...returned.keys()].every((productId) => (billedQtyByProduct.get(productId) ?? 0) <= 0);
    // B969: if ANY returned product has no single pricing axis the WHOLE preview is $0 WITH a reason, because the mint refuses
    // the whole return (409). Never make this a partial sum of the products that did resolve.
    const why = unresolvedProductId
      ? { refusal: "UNIT_UNRESOLVED" as const, unresolvedProductId }
      : nothingBilled
        ? { refusal: "NOTHING_BILLED" as const }
        : {};
    if (unresolvedProductId) amount = 0;

    if (creditable.length === 1) {
      return { amount, invoiceId: creditable[0].id, creditable, ...why };
    }

    // 2+ creditable invoices: the source is the LATEST one (by createdAt) so
    // create()'s per-invoice cap still applies. billedBasisFor gates it.
    const latest = [...creditable].sort((a: any, b: any) => {
      const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bt - at;
    })[0];
    return { amount, invoiceId: latest.id, creditable, ...why };
  }

  async processRefund(id: string, dto?: ProcessRefundDto, actor?: JwtPayload) {
    const method = dto?.method ?? "CREDIT_NOTE";
    // Row 59: a refund is a money write on one tenant's return; a tenantless session is refused before any read.
    if (!this.prisma.getTenantId()) {
      throw new ForbiddenException({
        code: API_ERROR_CODES.REFUND_NOT_ALLOWED,
        message: "A refund needs a tenant: open the tenant first",
      });
    }
    // SA-740r2 item 4: the tender belongs to a recorded refund only; store credit has none.
    if (dto?.tender && method !== "EXTERNAL_REFUND") {
      throw new BadRequestException("A tender only applies to a cash, card or check refund");
    }

    const ret = await this.prisma.forTenant().return.findUnique({
      where: { id },
      include: REFUND_RETURN_INCLUDE,
    });
    if (!ret) throw new NotFoundException("Return not found");
    if (ret.kind === "INLINE") throw new BadRequestException(INLINE_RETURN_USE_INLINE_ENDPOINTS);
    if (ret.status !== "RECEIVED")
      throw new BadRequestException("Only RECEIVED returns can be refunded");

    // F08 B53: refund value is priced from what was actually BILLED (the order's
    // creditable invoices), not re-derived from the order line — see billedBasisFor.
    // EXTERNAL_REFUND mints nothing, so it prices with the PURE helper and skips the mint-time headroom gates. Whether the money
    // may go back is decided separately, under locks, by claimRefund (the order's invoices paid in full, SA-740r2).
    // SA-737: this first figure only refuses early (the same 400/409 as ever, before any lock is taken). It is NEVER claimed:
    // claimRefund recomputes the basis from the locked rows and claims from that.
    const firstBasis =
      method === EXTERNAL_REFUND_METHOD
        ? await this.externalRefundBasis(ret.items ?? [], ret.order ?? undefined)
        : await this.billedBasisFor(ret.items ?? [], ret.order ?? undefined);

    // SA-737: ONE claim transaction for both methods (SA-740r2 / R20-2 for the recorded refund): Return, Order, invoices locked in
    // house order, the basis recomputed under them, then the RECEIVED→REFUNDED claim carrying the amount. The mint below is not in it.
    const claim = await this.claimRefund(ret, method, dto?.tender, firstBasis, actor);
    if (method === EXTERNAL_REFUND_METHOD) return claim.row;
    const {
      amount: refundAmount,
      invoiceId: sourceInvoiceId,
      items: refundItems,
      pooledRefund,
      unbilledItems,
    } = claim.basis;
    const updated = claim.row;
    // B959: a mixed return says WHICH item got no refund, in the same response (never a silent $0)
    const withUnbilled = <T>(r: T): T | (T & { unbilledItems: UnbilledReturnItem[] }) =>
      unbilledItems && unbilledItems.length > 0 && r ? { ...r, unbilledItems } : r;

    if (refundAmount <= 0.001) return withUnbilled(updated);

    // Sequential, NOT nested (the claim transaction above has committed): create() opens its own Serializable tx and books NO
    // regulated reversal for a lump-sum credit (no items) — the returned regulated
    // goods were already reversed at receive(). billedBasisFor already picked the
    // single creditable invoice, or the latest of 2+ after a headroom check, or
    // undefined for a zero-invoice (legacy) or VOID-sourced order.
    let cn: Awaited<ReturnType<CreditNotesService["create"]>>;
    try {
      cn = await this.creditNotes.create(
        {
          customerId: ret.customerId,
          invoiceId: sourceInvoiceId,
          amount: refundAmount,
          reason: `Refund for return ${ret.returnNumber ?? ret.id.slice(0, 8)}`,
          // SA-628: an ITEMISED credit (trackedCategoryId null on its rows, so no second ledger reversal: receive() already
          // reversed the returned regulated goods) counted by the shared per-line headroom.
          ...(refundItems && refundItems.length > 0
            ? {
                items: refundItems.map((it) => ({
                  invoiceItemId: it.invoiceItemId,
                  amount: it.amount,
                  qty: it.qty,
                })),
              }
            : {}),
        },
        // receive() already reversed the returned regulated goods in the ledger: the refund rows must not reverse them again
        // SA-773 row 333(a): the return id goes with EVERY shape, so the link is written inside the mint transaction
        { ledgerReversedByReturn: true, returnId: id, ...(pooledRefund ? { pooledRefund } : {}) },
      );
    } catch (err) {
      // F08 B68: the RECEIVED→REFUNDED claim above already committed. A failed mint
      // must not strand the return in REFUNDED with no credit note — compensate the
      // claim back to RECEIVED (only if the mint truly never landed: creditNoteId is
      // still null) so the return can be re-attempted, then rethrow the original error.
      this.logger.error(
        `Refund mint failed for return ${id} (amount ${refundAmount}, invoice ${sourceInvoiceId ?? "none"}): ${(err as Error)?.message}`,
      );
      try {
        await this.prisma.forTenant().return.updateMany({
          where: { id, status: "REFUNDED", creditNoteId: null },
          data: { status: "RECEIVED", refundMethod: null, refundAmount: null, refundedAt: null },
        });
        this.logger.warn(
          `Return ${id} bounced REFUNDED→RECEIVED after the failed mint (amount ${refundAmount}, invoice ${sourceInvoiceId ?? "none"})`,
        );
      } catch (compErr) {
        // The compensation itself failed — the row may be stranded in REFUNDED with no
        // credit note. Log it, but NEVER let this error replace the real cause below.
        this.logger.error(
          `Compensation failed for return ${id} (amount ${refundAmount}, invoice ${sourceInvoiceId ?? "none"}): ${(compErr as Error)?.message}`,
        );
      }
      // SA-628: a racing credit note / refund that took the line's headroom between the pre-check and the mint is the SAME
      // refusal (409 RETURN_REFUND_OVER_LINE_HEADROOM), never the credit note's own over-headroom 400.
      const code = (err as { getResponse?: () => { code?: string } })?.getResponse?.()?.code;
      const pooledRefusal =
        (err as { getResponse?: () => { pooled?: boolean } })?.getResponse?.()?.pooled === true;
      if (
        (refundItems &&
          (code === API_ERROR_CODES.CREDIT_NOTE_OVER_HEADROOM ||
            code === API_ERROR_CODES.CREDIT_NOTE_LINE_INVALID)) ||
        (pooledRefund && pooledRefusal) // B947: the pool's own refusal; the invoice-total cap keeps its own wording
      ) {
        throw new ConflictException({
          code: API_ERROR_CODES.RETURN_REFUND_OVER_LINE_HEADROOM,
          message:
            "This refund would credit more than the invoice line is worth: part of it was already credited " +
            "(by a credit note or an earlier refund). Give store credit for what is still billable, or cancel the return.",
        });
      }
      throw err;
    }
    return withUnbilled({ ...updated, creditNoteId: cn.id });
  }

  /**
   * SA-737 (+ SA-740r2 for the recorded refund): the ONE claim transaction of a STANDARD return's refund, both methods.
   * House lock order: counter-close (a counter order's recorded refund), Return `FOR UPDATE` (tenant-bound), the order's row,
   * then the order's creditable invoices id-sorted (the same rows a void and an order cancel take, Order first). Only then is
   * the basis recomputed from the locked rows: a void or a cancel that committed while this waited is seen, and nothing billed
   * left is 409 RETURN_REFUND_BASIS_CHANGED, never a claim from the first figure. EXTERNAL_REFUND then needs the order's
   * creditable invoices paid in full (409 REFUND_NEEDS_PAID_INVOICE; paid with store credit is 409
   * REFUND_PAID_WITH_STORE_CREDIT, the inline refund's resolver and predicate) and fits the cash cap. The claim (RECEIVED ->
   * REFUNDED) is a CAS on `refundedAt` / `creditNoteId` too and carries the amount, the method and, for a recorded refund, the
   * database-clock `refundedAt` and the optional tender (`Return.refundTender`; omitted -> null).
   *
   * The CREDIT_NOTE mint is NOT here: `creditNotes.create` opens its own Serializable transaction and runs after this commits.
   * A lock wait past `REFUND_LOCK_TIMEOUT_MS` is a retryable 409 CONCURRENT_UPDATE; nothing was written.
   */
  private async claimRefund(
    ret: {
      id: string;
      orderId?: string | null;
      order?: { id?: string; counterSale?: boolean | null; registerKey?: string | null } | null;
    },
    method: string,
    tender: RefundTender | undefined,
    firstBasis: object,
    actor?: JwtPayload,
  ): Promise<{ row: any; basis: RefundBasis }> {
    const id = ret.id;
    const tenantId = this.prisma.getTenantId();
    const external = method === EXTERNAL_REFUND_METHOD;
    // SA-740r2 item 6: the shared counter-close lock is the FIRST statement (a counter order's refund counts in the drawer)
    const registerKey = external ? registerKeyOfOrder(ret.order) : null;
    try {
      return await this.prisma.tenantTransaction(
        async (tx: any) => {
          // The wait bound comes FIRST so the counter-close wait is bounded too; it takes no lock, so the close lock is still the
          // first LOCK the transaction acquires (counter-close -> Return -> Order -> invoices).
          await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(REFUND_LOCK_TIMEOUT_MS)}, true)`;
          if (registerKey && tenantId) await lockCounterClose(tx, tenantId, registerKey);
          await tx.$executeRaw`SELECT id FROM "Return" WHERE id = ${id} AND (${tenantId}::text IS NULL OR "tenantId" = ${tenantId}) FOR UPDATE`;
          const fresh = await tx.return.findFirst({
            where: { id },
            select: { id: true, status: true, kind: true },
          });
          if (!fresh) throw new NotFoundException("Return not found");
          if (fresh.kind === "INLINE")
            throw new BadRequestException(INLINE_RETURN_USE_INLINE_ENDPOINTS);
          // The first read (above the locks) is 400 "Only RECEIVED returns can be refunded", as ever. This re-read, under the Return lock,
          // is 409 with the same text: the return was RECEIVED a moment ago, so another request resolved it while this one waited
          // (the loser of two refunds). Lead ruling: 400 before the lock, 409 in it.
          if (fresh.status !== "RECEIVED") throw refundAlreadyResolved();
          const orderId = ret.order?.id ?? ret.orderId;
          if (orderId) await lockRefundOrders(tx, tenantId, [orderId]);
          const resolved = await resolveRefundInvoiceIds(tx, {
            kind: "ORDER",
            orderId: orderId ?? "",
          });
          await lockRefundInvoices(tx, tenantId, resolved.invoiceIds);

          // the order, its invoices and their lines as they are NOW, under the locks
          const locked = await tx.return.findUnique({
            where: { id },
            include: REFUND_RETURN_INCLUDE,
          });
          if (!locked) throw new NotFoundException("Return not found");
          const basis = await this.basisUnderLock(method, locked, tx, firstBasis);
          const refundAmount = roundMoney(basis.amount);
          // SA-773: both methods give value back, so both fit the goods' remainder (read under the locks held here)
          await assertStandardRefundWithinRemainder(tx, {
            returnId: id,
            invoiceIds: resolved.invoiceIds,
            items: locked.items ?? [],
            bases: await this.packBasesOf(locked.order ?? undefined, tx),
            amount: refundAmount,
          });

          if (external) {
            const state = await loadInvoiceRefundState(tx, resolved);
            const refusal = refundSourcesRefusal(state);
            if (refusal) throw refusal;
            // SA-749r2 item 9: a CASH refund may not exceed the cash applied to the order minus earlier cash refunds on it
            if (orderId) {
              await assertCashRefundWithinCap(tx, {
                returnId: id,
                tender,
                counterOrder: registerKey != null,
                perOrder: new Map([[orderId, refundAmount]]),
              });
            }
          }

          // SA-758 CR-2: a recorded refund's refundedAt is the DATABASE clock, read after the close lock
          const refundedAt = external ? await dbClockNow(tx) : new Date();
          // SA-750r3: a recorded refund dated inside a closed window is refused (a closed day's totals never move). A plain read
          // under the close lock already held (registerKey is null for store credit), so it adds no lock: counter-close ->
          // Return -> Order -> invoices stays the whole order. It runs after the basis/cash-cap refusals and before the claim.
          if (registerKey && tenantId)
            await assertCounterWindowOpen(tx, tenantId, registerKey, refundedAt);
          const claimed = await tx.return.updateMany({
            where: refundClaimWhere(id),
            data: {
              status: "REFUNDED",
              refundMethod: method,
              refundAmount,
              refundedAt,
              ...(external ? refundTenderData(tender) : {}),
            },
          });
          if (claimed.count === 0) throw refundAlreadyResolved();
          // SA-737 (parity with the inline refund's M5): cash leaving with no audit row is a gap; AWAITED, in this transaction,
          // so no audit row means no refund
          if (external) {
            await tx.auditLog.create({
              data: {
                userId: actor?.sub ?? null,
                impersonatedBy: actor?.impersonatedBy ?? null,
                action: AUDIT_ACTIONS.STANDARD_REFUND_RECORDED,
                entityType: "Return",
                entityId: id,
                meta: {
                  returnId: id,
                  returnNumber: locked.returnNumber ?? null,
                  orderId: orderId ?? null,
                  customerId: locked.customerId,
                  invoiceIds: resolved.invoiceIds,
                  amount: refundAmount,
                  tender: tender ?? null,
                  actor: actor?.sub ?? null,
                  impersonatedBy: actor?.impersonatedBy ?? null,
                },
              },
            });
          }
          const row = await tx.return.findUnique({ where: { id } });
          // one tender vocabulary (SA-740r2 item 8): answered like the inline refund, read back from the stored column
          return {
            row:
              external && row
                ? { ...row, refundTender: refundTenderOfColumn(row.refundTender) }
                : row,
            basis: { ...basis, amount: refundAmount },
          };
        },
        { timeout: REFUND_TX_TIMEOUT_MS },
      );
    } catch (err) {
      // a lock wait past its bound (55P03) or a transaction that ran out of budget (P2028): nothing was written, safe to retry
      if (isLockUnavailableError(err) || isTransactionExpired(err)) throw refundBusy();
      throw err;
    }
  }

  /**
   * SA-737: the refund basis from the rows read under the locks. A STANDARD refund whose first figure existed but whose locked
   * rows bill nothing of what was returned (every invoice voided, or the order cancelled, while it waited) is 409
   * RETURN_REFUND_BASIS_CHANGED. Any other refusal of the recomputed basis (headroom, mixed units) is that refusal, as before.
   */
  private async basisUnderLock(
    method: string,
    locked: { items?: any[]; order?: any },
    tx: any,
    firstBasis: object,
  ): Promise<RefundBasis> {
    let basis: RefundBasis;
    try {
      basis =
        method === EXTERNAL_REFUND_METHOD
          ? await this.externalRefundBasis(locked.items ?? [], locked.order ?? undefined, tx)
          : await this.billedBasisFor(locked.items ?? [], locked.order ?? undefined, tx);
    } catch (err) {
      if (isNothingBilledRefusal(err)) throw refundBasisChanged();
      throw err;
    }
    // the recorded refund prices with the PURE helper, which reports "nothing billed" instead of throwing it
    if (pricedNothingBilled(basis) && !pricedNothingBilled(firstBasis)) throw refundBasisChanged();
    // A recorded (cash) refund is handed over against the figure the operator saw: a different figure under the locks is
    // refused, never recorded silently (the drawer would drift from the books). Store credit claims the locked figure.
    if (
      method === EXTERNAL_REFUND_METHOD &&
      roundMoney(Number((firstBasis as { amount?: number }).amount ?? 0)) !==
        roundMoney(basis.amount)
    )
      throw refundBasisChanged("AMOUNT");
    return basis;
  }

  async cancel(id: string, user: JwtPayload) {
    const ret = await this.prisma.forTenant().return.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!ret) throw new NotFoundException("Return not found");
    // M6/§2.3: refused for every caller, CUSTOMER included — an INLINE return cancels
    // through its own endpoint (PR-1c/1d), never this one.
    if (ret.kind === "INLINE") throw new BadRequestException(INLINE_RETURN_USE_INLINE_ENDPOINTS);
    // SECURITY (F2-001): a CUSTOMER may only cancel their OWN return. Without this
    // check any customer could cancel a tenant-mate's return and reverse stock.
    if (user.role === "CUSTOMER") {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || ret.customerId !== customer.id) {
        throw new ForbiddenException("You can only cancel your own returns");
      }
    }
    if (ret.status === "CANCELLED") throw new BadRequestException("Return is already cancelled");
    if (ret.status === "REFUNDED")
      throw new BadRequestException("Refunded returns cannot be cancelled");

    return this.prisma.tenantTransaction(async (tx) => {
      // B69: the pre-transaction `ret` read above can be stale by the time we get
      // here (e.g. a concurrent receive() committed RECEIVED after our read but
      // before this transaction started). Lock the row for the rest of the
      // transaction, then re-read it fresh IN-TX — the undo decision below keys
      // off `fresh`, never the stale outer `ret`.
      await tx.$executeRaw`SELECT id FROM "Return" WHERE id = ${id} FOR UPDATE`;
      const fresh = await tx.return.findUnique({ where: { id }, include: { items: true } });

      // Concurrency guard: claim the →CANCELLED transition atomically so two
      // concurrent cancels can't both run the stock/ledger undo (double-decrement).
      // The loser matches 0 rows and aborts.
      const claimed = await tx.return.updateMany({
        where: { id, status: { notIn: ["CANCELLED", "REFUNDED"] } },
        data: { status: "CANCELLED" },
      });
      if (claimed.count === 0) {
        throw new BadRequestException("Return can no longer be cancelled");
      }
      // Reverse stock movements if items were already received into stock.
      // F2 (independent review, PR-2): B348 removed the PROCESSED arm on the theory that no
      // writer in this service ever sets it — true for CODE, not for DATA. PROCESSED is a
      // legacy ReturnStatus: the enum member is retained in sales.prisma specifically because
      // rows already sitting in that state predate whatever retired the writer, and cancelling
      // one of THOSE must still undo its stock/ledger effects. Restored unconditionally rather
      // than gated on a prod check — retire this arm only after a prod
      // `GROUP BY status` count shows zero PROCESSED rows.
      if (fresh.status === "RECEIVED" || fresh.status === "PROCESSED") {
        const returnRef = `RET-${fresh.id.slice(0, 8)}`;
        // A restock still parked for this return is void once the return is cancelled.
        //
        // This DELETE runs BEFORE the movement scan below, and the order is load-bearing. The parked row
        // is the lock a concurrent `ParkedRestockResolutionService.resolve()` claims, so:
        //   - resolve claimed first: this DELETE blocks on its row lock until resolve commits, then
        //     matches 0 rows (resolvedAt is set) — and the movement scan below, a LATER statement with a
        //     fresh snapshot, therefore SEES the movement resolve just booked and undoes it.
        //   - this DELETE wins: the row is gone, so resolve's conditional claim matches 0 rows and books
        //     nothing at all.
        // Scanning the movements FIRST would let a resolve that commits in between book a movement this
        // cancel has already looked past, leaving an orphan RET-<id> row and stock permanently inflated
        // by the resolved pieces, with no second cancel to undo it.
        await tx.returnParkedRestock.deleteMany({
          where: { returnId: fresh.id, resolvedAt: null },
        });
        // B665: undo EXACTLY what receive() restocked (in PIECES), read from its own RET-<id>
        // movements, never recomputed from the typed qty (a box-unaware line's qty counts BOXES). A parked
        // or restock:false item has no movement, so there is nothing to undo for it.
        const moved: any[] = await tx.stockMovement.findMany({
          where: { reference: returnRef, type: "RETURN" },
          select: { productId: true, quantity: true },
        });
        const undo = new Map<string, number>();
        for (const m of moved)
          undo.set(m.productId, (undo.get(m.productId) ?? 0) + Number(m.quantity));
        // B562 PR-2 (SA-136 §2): nothing deletes a movement. The undo APPENDS one reversing RETURN row
        // per product (negative quantity, same reference, notes RETURN_CANCELLED) with `stockAfter`
        // read from the decrement's own result, so the reference nets to zero and the history stays.
        for (const [productId, qty] of undo) {
          if (qty === 0) continue;
          const updated = await tx.product.update({
            where: { id: productId },
            data: { currentStock: { decrement: qty } },
          });
          await tx.stockMovement.create({
            data: {
              productId,
              type: "RETURN",
              quantity: new Prisma.Decimal(qty).neg(),
              unitCost: updated.averageCost ?? null,
              avgCostAfter: updated.averageCost ?? null,
              stockAfter: updated.currentStock,
              reference: returnRef,
              notes: "RETURN_CANCELLED",
              performedById: user?.sub ?? null,
            },
          });
        }
        // W5c: undo the regulated ledger reversal written at receive() (symmetric
        // to reversing the stock movements above). cancel() blocks REFUNDED returns,
        // so a finalized reversal is never touched.
        await this.ledger.unreverseReturnEntries({ returnId: fresh.id, db: tx });
      }
      return tx.return.findUnique({ where: { id } });
    });
  }

  /** RF-081: Fetches a return by ID with ownership enforcement for CUSTOMER role. */
  async findOneForUser(id: string, user: JwtPayload) {
    const ret = await this.findOne(id);
    if (user.role === "CUSTOMER") {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || ret.customerId !== customer.id) {
        throw new ForbiddenException("You can only view your own returns");
      }
    }
    return ret;
  }

  async findOne(id: string) {
    const ret = await this.prisma.forTenant().return.findUnique({
      where: { id },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            // SA-740r2: the web requires a refund tender for a COUNTER order (the cash cap treats no tender as cash)
            counterSale: true,
            // F08 B53: same creditable-invoice shape as processRefund, so
            // refundEstimate below is priced by the same billedBasisFor helper.
            invoices: {
              select: {
                id: true,
                status: true,
                total: true,
                createdAt: true,
                items: {
                  select: {
                    id: true,
                    productId: true,
                    qty: true,
                    subtotal: true,
                    boxes: true,
                    unitsPerBox: true,
                    pieces: true,
                    product: { select: { unitsPerBox: true } },
                  },
                  orderBy: [{ createdAt: "asc" }, { id: "asc" }], // deterministic fill order (SA-628)
                },
              },
            },
            lineItems: {
              select: {
                ...PACK_LINE_SELECT, // B969: the pack evidence the pieces-basis price reads
                unitPrice: true,
                subtotal: true,
              },
            },
          },
        },
        customer: { select: { id: true, businessName: true } },
        items: { include: { product: { select: { id: true, name: true, unit: true } } } },
      },
    });
    if (!ret) throw new NotFoundException("Return not found");
    // #2406 (SA-484c): findOne now RENDERS an INLINE row (the order-detail panel links to
    // it) — only the standard-path mutation endpoints (approve/reject/markInTransit/receive/
    // processRefund/cancel, above) still refuse INLINE with INLINE_RETURN_USE_INLINE_ENDPOINTS.
    // An INLINE row's pricing was already resolved at capture (refundAmount), so it skips the
    // priceReturn() re-derivation below, same as findAll.

    // Enrich each return item with orderedQty from the original order. `orderedQty`
    // uses the same pooled-across-lines basis as create()'s cap (soldQtyForProduct,
    // fix-round: the pre-fix single-line `.find()` here could show an operator a cap
    // lower than what create() actually enforces); `unitPrice` stays a single line's
    // rate — display-only — since a pooled per-unit rate has no one line to attribute
    // it to.
    const enrichedItems = ret.items.map((item) => {
      const orderLine = ret.order?.lineItems?.find((li) => li.productId === item.productId);
      return {
        ...item,
        orderedQty: ret.order ? soldQtyForProduct(ret.order as any, item.productId) : null,
        unitPrice: orderLine ? Number(orderLine.unitPrice) : null,
      };
    });

    // Surface the resolution: Return.creditNoteId is populated by processRefund but never
    // reached a client before. There is no Prisma relation here (legacy rows may point at a
    // deleted credit note — see WP0's schema note), so the lookup is manual and tolerant of a miss.
    let creditNote: any = null;
    if (ret.creditNoteId) {
      creditNote = await this.prisma.forTenant().creditNote.findFirst({
        where: { id: ret.creditNoteId },
        select: { id: true, creditNoteNumber: true, amount: true, status: true },
      });
    }

    // The same billed-invoice basis processRefund prices from (priceReturn), so a
    // client can show the amount BEFORE resolving without re-deriving box-priced
    // money itself. Pure and DB-free: a read never runs the mint-time headroom
    // query, and an unrefundable basis reports 0 WITH a reason rather than being
    // swallowed into a silent $0 (which is indistinguishable from a DB failure).
    // #2406: an INLINE row skips this — its money was already resolved at capture.
    let refundEstimate: number | null;
    let refusal: string | null | undefined;
    if (ret.kind === "INLINE") {
      refundEstimate = null;
      refusal = "INLINE";
    } else {
      const bases = await this.packBasesOf(ret.order);
      ({ amount: refundEstimate, refusal } = this.priceReturn(
        ret.items,
        ret.order ?? undefined,
        bases,
      ));
      // SA-773: a return that can be refunded now previews what the claim would accept (display only; the claim is never clamped)
      if (ret.status === "RECEIVED" && !refusal && refundEstimate > 0) {
        const preview = await previewStandardRefund(this.prisma.forTenant(), {
          returnId: ret.id,
          invoiceIds: (ret.order?.invoices ?? [])
            .filter((inv: any) => !CREDIT_SOURCE_EXCLUDED.includes(inv.status))
            .map((inv: any) => inv.id as string),
          items: ret.items,
          bases,
          amount: refundEstimate,
        });
        if (preview.capped) {
          refundEstimate = preview.amount;
          refusal = "EXCEEDS_REFUNDABLE";
        }
      }
    }

    // The invoice graph is fetched only to price the row — strip it back out (this
    // read returned no invoice money before F08 B53).
    const { invoices: _invoices, ...orderWithoutInvoices } = (ret.order ?? {}) as any;

    return {
      ...ret,
      order: ret.order ? orderWithoutInvoices : ret.order,
      items: enrichedItems,
      creditNote,
      refundEstimate,
      refundEstimateReason: refusal ?? null,
    };
  }
}
