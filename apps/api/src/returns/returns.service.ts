import {
  BadRequestException,
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
import { PrismaService } from "../prisma/prisma.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { roundMoney } from "@routeflow/pricing";
import type { ProcessRefundDto } from "./dto/process-refund.dto";
import { CREDIT_SOURCE_EXCLUDED } from "../invoices/invoice-status-sets";
import { IdempotencyService } from "../common/idempotency.service";
import { NumberingService } from "../import/numbering.service";
import {
  returnedPiecesByProduct,
  soldPiecesForProduct,
  standardReturnPieces,
} from "./returns-pieces.util";
import { restockReturnItems } from "./returns-restock.util";

/** M6/§2.3: every standard-path method refuses an INLINE-kind return — it has its own
 * endpoints and state machine (PR-1c/1d). Thrown the moment a `kind` is known to be INLINE. */
const INLINE_RETURN_USE_INLINE_ENDPOINTS = "INLINE_RETURN_USE_INLINE_ENDPOINTS";

/** The shape `create` returns — reused to type a replayed (idempotent) result. */
type CreatedReturn = Prisma.ReturnGetPayload<{ include: { items: true } }>;

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
              productId: true,
              qty: true,
              unitPrice: true,
              subtotal: true,
              status: true,
              position: true,
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
      const alreadyReturned = await returnedPiecesByProduct(tx, dto.orderId);

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
        const orderedQty = soldPiecesForProduct(order as any, item.productId);
        if (orderedQty <= 0)
          throw new BadRequestException(`Product ${item.productId} was not in the original order`);
        const { pieces: returnPieces, toLineUnit } = standardReturnPieces(
          order as any,
          item.productId,
          Number(item.qty),
        );
        const previouslyReturned = alreadyReturned[item.productId] ?? 0;
        const remaining = orderedQty - previouslyReturned;
        if (returnPieces > remaining)
          throw new BadRequestException(
            `Return qty (${toLineUnit(returnPieces)}) exceeds remaining returnable qty (${toLineUnit(remaining)}) for product ${item.productId}. Already returned: ${toLineUnit(previouslyReturned)} of ${toLineUnit(orderedQty)}.`,
          );
        // Count this line against the running total too: a single payload that
        // lists the same productId twice previously validated every line against
        // the same pre-request snapshot, so 2 × qty 10 against 10 ordered both
        // passed and over-returned with no concurrency involved at all.
        alreadyReturned[item.productId] = previouslyReturned + returnPieces;
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
    const { orderId, customerId, driverId, status, reason, search, page = 1, limit = 20 } = options;
    const skip = (page - 1) * limit;
    // M6/§2.3: this list is the STANDARD (post-delivery RMA) surface only — an INLINE
    // return has its own list/queue (PR-1c/1d §7 "Needs attention"), not this one, and
    // its money fields (ReturnItem.unitPrice/subtotal/taxAmount, priced at capture) are
    // not shaped for the priceReturn()/billedBasisFor() logic below.
    const where: any = { kind: "STANDARD" };
    if (orderId) where.orderId = orderId;
    if (customerId) where.customerId = customerId;
    // A relation filter, not a scalar FK — Return carries no driverId of its
    // own (RETURN → orderId → Order.routeRunId → RouteRun.driverId). An order
    // with no route run assigned (routeRunId null) can never match, which is
    // correct: it was never on any driver's route.
    if (driverId) where.order = { routeRun: { driverId } };
    if (status) where.status = status;
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
                  items: { select: { productId: true, qty: true, subtotal: true } },
                },
              },
              lineItems: {
                select: {
                  productId: true,
                  qty: true,
                  unitPrice: true,
                  subtotal: true,
                  status: true,
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
    const enriched = data.map((ret: any) => {
      // Pure, DB-free pricing: the read path must never issue a per-row query (the
      // list is fetched with limit 500 for the KPI tile) and must never swallow a
      // refusal into a silent $0 — the reason travels with the row instead.
      const { amount, refusal } = this.priceReturn(ret.items ?? [], ret.order ?? undefined);
      // The invoice graph above is fetched ONLY to price the row — it never crosses
      // the wire (GET /returns is readable by DRIVER/CUSTOMER roles). The response's
      // `order` keeps exactly the { id, orderNumber } shape it had before B75.
      const { order, ...rest } = ret;
      return {
        ...rest,
        order: order ? { id: order.id, orderNumber: order.orderNumber } : order,
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

      if (opts?.restock === false) {
        // "We are not keeping these goods": skip restocking entirely, and persist
        // restock=false on every item so a later cancel() — which decrements stock
        // for every item whose restock flag is true — stays symmetric with what was
        // actually put back on the shelf (nothing).
        await tx.returnItem.updateMany({ where: { returnId: id }, data: { restock: false } });
      } else {
        // PR-1c: shared with InlineReturnsService.capture() — see returns-restock.util.ts.
        await restockReturnItems(tx, ret, userId);
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
  ): Promise<{ amount: number; invoiceId?: string }> {
    const { amount, invoiceId, creditable, refusal } = this.priceReturn(items, order);
    if (refusal === "NOTHING_CREDITABLE") {
      throw new BadRequestException("Nothing billed on this order can be refunded");
    }
    // No invoice rows at all: the amount came from the legacy order-line basis and
    // there is no source invoice for create() to cap against, so nothing to gate.
    if (creditable.length === 0) return { amount, invoiceId };

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
      const agg = await this.prisma.forTenant().creditNote.aggregate({
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
    const latestAgg = await this.prisma.forTenant().creditNote.aggregate({
      where: { status: { not: "VOID" }, invoiceId },
      _sum: { amount: true },
    });
    const latestRoom = Number(latest?.total ?? 0) - Number((latestAgg as any)?._sum?.amount ?? 0);
    if (amount > latestRoom + 0.001) {
      // The operator reads this string verbatim, so it names the invoice the way the
      // UI does. `invoiceNumber` is selected by every caller that can reach this line
      // (processRefund's query); the `?? invoiceId` fallback covers only the impossible
      // case of a row that lost the field, and a UUID there is a bug, not a label.
      throw new BadRequestException(
        `Refund ${amount} exceeds the remaining room ${roundMoney(latestRoom)} on invoice ` +
          `${latest?.invoiceNumber ?? invoiceId}; refund it outside RouteFlow or issue the credit note manually`,
      );
    }
    return { amount, invoiceId };
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
    order?: any,
  ): {
    amount: number;
    invoiceId?: string;
    creditable: any[];
    refusal?: "NOTHING_CREDITABLE";
  } {
    const allInvoices = order?.invoices ?? [];

    if (allInvoices.length === 0) {
      // Never invoiced (or its invoice rows are gone) — legacy order-line basis.
      // PR-1a fix-round (Opus review F1): create()'s over-return cap now sums a
      // product's qty across every non-CANCELLED line (soldPiecesForProduct), but this
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
    const billedSubtotalByProduct = new Map<string, number>();
    for (const inv of creditable) {
      for (const invItem of inv.items ?? []) {
        billedQtyByProduct.set(
          invItem.productId,
          (billedQtyByProduct.get(invItem.productId) ?? 0) + Number(invItem.qty),
        );
        billedSubtotalByProduct.set(
          invItem.productId,
          (billedSubtotalByProduct.get(invItem.productId) ?? 0) + Number(invItem.subtotal),
        );
      }
    }

    let amount = 0;
    for (const item of items) {
      const billedQty = billedQtyByProduct.get(item.productId) ?? 0;
      if (billedQty <= 0) continue;
      const billedSubtotal = billedSubtotalByProduct.get(item.productId) ?? 0;
      const perUnit = billedSubtotal / billedQty;
      const refundQty = Math.min(Number(item.qty), billedQty);
      amount += refundQty * perUnit;
    }
    amount = roundMoney(amount);

    if (creditable.length === 1) {
      return { amount, invoiceId: creditable[0].id, creditable };
    }

    // 2+ creditable invoices: the source is the LATEST one (by createdAt) so
    // create()'s per-invoice cap still applies. billedBasisFor gates it.
    const latest = [...creditable].sort((a: any, b: any) => {
      const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bt - at;
    })[0];
    return { amount, invoiceId: latest.id, creditable };
  }

  async processRefund(id: string, dto?: ProcessRefundDto) {
    const method = dto?.method ?? "CREDIT_NOTE";

    const ret = await this.prisma.forTenant().return.findUnique({
      where: { id },
      include: {
        items: true,
        order: {
          select: {
            // `id` feeds the order-scoped headroom aggregate in billedBasisFor.
            id: true,
            orderNumber: true,
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
                items: { select: { productId: true, qty: true, subtotal: true } },
              },
            },
            lineItems: {
              select: {
                productId: true,
                qty: true,
                unitPrice: true,
                subtotal: true,
                status: true,
              },
            },
          },
        },
      },
    });
    if (!ret) throw new NotFoundException("Return not found");
    if (ret.kind === "INLINE") throw new BadRequestException(INLINE_RETURN_USE_INLINE_ENDPOINTS);
    if (ret.status !== "RECEIVED")
      throw new BadRequestException("Only RECEIVED returns can be refunded");

    // F08 B53: refund value is priced from what was actually BILLED (the order's
    // creditable invoices), not re-derived from the order line — see billedBasisFor.
    // EXTERNAL_REFUND mints nothing, so it prices with the PURE helper and skips the
    // mint-time gates: a RECEIVED return on a VOID-only (or fully credited) order must
    // still be resolvable by "refunded outside RouteFlow", or it is stuck forever.
    const { amount: refundAmount, invoiceId: sourceInvoiceId } =
      method === "EXTERNAL_REFUND"
        ? this.priceReturn(ret.items ?? [], ret.order ?? undefined)
        : await this.billedBasisFor(ret.items ?? [], ret.order ?? undefined);

    // Concurrency guard: atomically CLAIM the RECEIVED→REFUNDED transition — and persist
    // the resolution snapshot (method/amount/timestamp) in that SAME write — before
    // minting any store credit. A racing processRefund (double-click, client retry, or
    // two operators) matches 0 rows here and aborts, so a single return can never mint
    // two credits or record two resolutions. Mirrors receive()'s claim above — under READ
    // COMMITTED the second writer re-checks the WHERE after the row lock, so exactly one wins.
    const claimed = await this.prisma.forTenant().return.updateMany({
      where: { id, status: "RECEIVED" },
      data: {
        status: "REFUNDED",
        refundMethod: method,
        refundAmount,
        refundedAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      throw new BadRequestException("Only RECEIVED returns can be refunded");
    }
    const updated = await this.prisma.forTenant().return.findUnique({ where: { id } });

    // EXTERNAL_REFUND: the money was returned outside RouteFlow. Record it, mint nothing.
    if (method === "EXTERNAL_REFUND") return updated;

    if (refundAmount <= 0.001) return updated;

    // Sequential, NOT nested: create() opens its own Serializable tx and books NO
    // regulated reversal for a lump-sum credit (no items) — the returned regulated
    // goods were already reversed at receive(). billedBasisFor already picked the
    // single creditable invoice, or the latest of 2+ after a headroom check, or
    // undefined for a zero-invoice (legacy) or VOID-sourced order.
    let cn: Awaited<ReturnType<CreditNotesService["create"]>>;
    try {
      cn = await this.creditNotes.create({
        customerId: ret.customerId,
        invoiceId: sourceInvoiceId,
        amount: refundAmount,
        reason: `Refund for return ${ret.returnNumber ?? ret.id.slice(0, 8)}`,
      });
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
      throw err;
    }
    await this.prisma.forTenant().return.update({ where: { id }, data: { creditNoteId: cn.id } });

    return { ...updated, creditNoteId: cn.id };
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
        for (const item of fresh.items) {
          if (item.restock) {
            await tx.product.update({
              where: { id: item.productId },
              data: { currentStock: { decrement: Number(item.qty) } },
            });
          }
          await tx.stockMovement.deleteMany({
            where: { productId: item.productId, reference: returnRef },
          });
        }
        // W5c: undo the regulated ledger reversal written at receive() (symmetric
        // to deleting the stock movements above). cancel() blocks REFUNDED returns,
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
            // F08 B53: same creditable-invoice shape as processRefund, so
            // refundEstimate below is priced by the same billedBasisFor helper.
            invoices: {
              select: {
                id: true,
                status: true,
                total: true,
                createdAt: true,
                items: { select: { productId: true, qty: true, subtotal: true } },
              },
            },
            lineItems: {
              select: {
                productId: true,
                qty: true,
                unitPrice: true,
                subtotal: true,
                status: true,
              },
            },
          },
        },
        customer: { select: { id: true, businessName: true } },
        items: { include: { product: { select: { id: true, name: true, unit: true } } } },
      },
    });
    if (!ret) throw new NotFoundException("Return not found");
    // M6/§2.3: same STANDARD-only boundary as findAll — an INLINE return's detail
    // view is its own (PR-1c/1d) surface, and its pricing is already resolved at
    // capture, not re-derived here.
    if (ret.kind === "INLINE") throw new BadRequestException(INLINE_RETURN_USE_INLINE_ENDPOINTS);

    // Enrich each return item with orderedQty from the original order. `orderedQty`
    // uses the same pooled-across-lines basis as create()'s cap (soldPiecesForProduct,
    // fix-round: the pre-fix single-line `.find()` here could show an operator a cap
    // lower than what create() actually enforces); `unitPrice` stays a single line's
    // rate — display-only — since a pooled per-unit rate has no one line to attribute
    // it to.
    const enrichedItems = ret.items.map((item) => {
      const orderLine = ret.order?.lineItems?.find((li) => li.productId === item.productId);
      return {
        ...item,
        orderedQty: ret.order ? soldPiecesForProduct(ret.order as any, item.productId) : null,
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
    const { amount: refundEstimate, refusal } = this.priceReturn(ret.items, ret.order ?? undefined);

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
