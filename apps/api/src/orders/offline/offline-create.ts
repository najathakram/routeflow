import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { OrderReviewFlagKind, UserRole } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import type { OfflineQuote } from "@routeflow/types";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { fulfilCaller } from "../fulfil-path-resolver";
import { posModeDeniedGroups } from "../counter-sale/till-permission.guard";
import type { CreateOrderDto } from "../dto/create-order.dto";
import type { OrdersService } from "../orders.service";
import type { CreateOrderOptions, OfflineCreateOption } from "../order-create-options";
import { judgeOfflineDrift, type ServerLine } from "./offline-drift";

/**
 * SA-1124 PR-1a (SA-817): the staff `offline` create mode. A staff device took an order while offline and replays it
 * through POST /orders. The server prices and judges it at replay time exactly as online; the three things that would
 * REFUSE it online (license, selling restriction, credit limit) instead save it as a DRAFT with a review flag, so the
 * staff's work is never lost and never goes live unjudged. This file is the controller half (who may ask, what it may
 * carry), the gate wrapper and the flag rows; `offline-drift.ts` judges price drift; `review-flags.ts` reads and
 * resolves flags. `orders.service.ts` and the controller hold one-line call sites only.
 */

/**
 * The ONLY gate refusals an offline create turns into findings (SA-1124 item 5). Count-pinned at 4 in
 * `offline-create.spec.ts`; every other error from a gate propagates unchanged.
 */
export const OFFLINE_GATE_FINDING_CODES = [
  API_ERROR_CODES.REGULATED_AUTH_REQUIRED,
  API_ERROR_CODES.SELLING_RESTRICTED,
  API_ERROR_CODES.RESTRICTION_WARNING,
  API_ERROR_CODES.CREDIT_LIMIT_EXCEEDED,
] as const;

export type OfflineGateFindingCode = (typeof OFFLINE_GATE_FINDING_CODES)[number];

/** A gate refusal that became a finding: its code and the body the online 409 would have carried. */
export interface GateFinding {
  code: OfflineGateFindingCode;
  body: Record<string, unknown>;
}

// ─── controller half ─────────────────────────────────────────────────────────────────────────────────────────────

/** What the controller proved about an `offline: true` request (the role, the money fields and the quote). */
export interface OfflineRequest {
  quote: OfflineQuote;
  createdAt: Date | null;
}

const isStaff = (user: JwtPayload) =>
  user.role === UserRole.OPERATOR || user.role === UserRole.TENANT_ADMIN;

const refuse = (Ctor: typeof BadRequestException, code: string, message: string) =>
  new Ctor({ code, message });

/** Every quote line indexes a distinct entry of `items`, and there are no more lines than items. */
function quoteIsUsable(quote: OfflineQuote | undefined, itemCount: number): quote is OfflineQuote {
  if (!quote || !Array.isArray(quote.lines) || !Number.isFinite(quote.total)) return false;
  if (quote.lines.length > itemCount) return false;
  const seen = new Set<number>();
  for (const l of quote.lines) {
    if (!Number.isInteger(l.index) || l.index < 0 || l.index >= itemCount) return false;
    if (seen.has(l.index)) return false;
    seen.add(l.index);
  }
  return true;
}

/**
 * The FIRST step of `OrdersController.create`, before any merge logic. Null = an ordinary create (the offline fields
 * are never read again). `offline: true` is staff only (403), books no money and delivers nothing now (400: credit notes, an inline return, immediateDelivery) and
 * needs a usable quote (400, fail closed). The service never reads `dto.offline`: it gets the internal option.
 */
export function resolveOfflineRequest(
  dto: CreateOrderDto,
  user: JwtPayload,
): OfflineRequest | null {
  if (dto.offline !== true) return null;
  if (!isStaff(user)) {
    throw new ForbiddenException({
      code: API_ERROR_CODES.OFFLINE_STAFF_ONLY,
      message: "Only staff can send an order taken offline.",
    });
  }
  if (dto.appliedCreditNotes?.length) {
    throw refuse(
      BadRequestException,
      API_ERROR_CODES.OFFLINE_CREDITS_ONLINE_ONLY,
      "Credit notes are applied online. Remove them and apply them once the order is saved.",
    );
  }
  if (dto.inlineReturn) {
    throw refuse(
      BadRequestException,
      API_ERROR_CODES.OFFLINE_PAYMENT_ONLINE_ONLY,
      "A return that issues credit is taken online. Take it once the order is saved.",
    );
  }
  if (dto.immediateDelivery) {
    // `create()` writes CONFIRMED over whatever status the gates left when a run link and immediateDelivery are sent,
    // which would store a refused (DRAFT) order as CONFIRMED with no gate passed. Delivered-now is an online step.
    throw refuse(
      BadRequestException,
      API_ERROR_CODES.OFFLINE_IMMEDIATE_DELIVERY_ONLINE_ONLY,
      "Delivering an order on the spot is done online. Save the order first, then deliver it.",
    );
  }
  if (!quoteIsUsable(dto.offlineQuote as OfflineQuote | undefined, (dto.items ?? []).length)) {
    throw refuse(
      BadRequestException,
      API_ERROR_CODES.OFFLINE_QUOTE_REQUIRED,
      "This order needs the prices the device showed.",
    );
  }
  return {
    quote: dto.offlineQuote as OfflineQuote,
    createdAt: dto.offlineCreatedAt ? new Date(dto.offlineCreatedAt) : null,
  };
}

/**
 * `create()`'s third argument for an offline request: it never asks MERGE_CHOICE_REQUIRED and never merges (the order is
 * created apart, `skipAutoMerge`), and the customer's open order, if any, is handed on so create() flags it.
 */
export async function offlineCreateOptions(
  orders: Pick<OrdersService, "prisma" | "findActiveOrder">,
  dto: CreateOrderDto,
  user: JwtPayload,
  req: OfflineRequest,
): Promise<CreateOrderOptions> {
  const open = dto.customerId
    ? await orders.findActiveOrder(dto.customerId, {
        forMerge: true,
        mergeAs: {
          explicit: dto.fulfillPath,
          ...fulfilCaller(user, await posModeDeniedGroups(orders.prisma, user, dto.fulfillPath)),
        },
      })
    : null;
  return {
    skipAutoMerge: true,
    offline: { quote: req.quote, createdAt: req.createdAt, openOrderId: open?.id ?? null },
  };
}

// ─── service half ────────────────────────────────────────────────────────────────────────────────────────────────

/** The body of a refusal that is one of the four finding codes; null for anything else (it propagates). */
function findingOf(e: unknown): GateFinding | null {
  if (!(e instanceof ConflictException)) return null;
  const body = e.getResponse();
  const code =
    typeof body === "object" && body !== null ? (body as { code?: string }).code : undefined;
  return (OFFLINE_GATE_FINDING_CODES as readonly string[]).includes(code ?? "")
    ? { code: code as OfflineGateFindingCode, body: body as Record<string, unknown> }
    : null;
}

type FlagRow = {
  kind: OrderReviewFlagKind;
  lineIndex: number | null;
  detail: Prisma.InputJsonObject;
};

interface CreatedLine {
  id: string;
  position: number | null;
  productId: string | null;
  backorderedPieces?: unknown;
}

/** What the rows are built from: the written lines, the request lines and the lines as priced. */
export interface FlagContext {
  created: ReadonlyArray<CreatedLine>;
  items: ReadonlyArray<{ productId?: string | null }>;
  priced: ReadonlyArray<{ trackedCategoryId?: string | null }>;
}

const lineIndexesOf = (items: FlagContext["items"], productId: unknown): number[] =>
  items.flatMap((it, i) => (it.productId && it.productId === productId ? [i] : []));

/** RESTRICTED rows: a warning names its lines (`n:<index>`), a hard block names products (every line of each). */
function restrictedRows(f: GateFinding, ctx: FlagContext): FlagRow[] {
  const detailOf = (lineIndex: number, extra: Prisma.InputJsonObject = {}): FlagRow => ({
    kind: OrderReviewFlagKind.RESTRICTED,
    lineIndex,
    detail: {
      lineIndex,
      productId: ctx.items[lineIndex]?.productId ?? null,
      code: f.code,
      ...extra,
    },
  });
  const warned = (f.body.lines as Array<{ lineKey?: string }> | undefined) ?? [];
  const keyed = warned
    .map((l) => /^n:(\d+)$/.exec(l.lineKey ?? "")?.[1])
    .filter((n): n is string => n != null)
    .map(Number);
  if (keyed.length > 0) return [...new Set(keyed)].map((i) => detailOf(i));
  const blocked = (f.body.blockedLines as Array<{ productId?: string; reason?: string }>) ?? [];
  const seen = new Set<number>();
  const rows: FlagRow[] = [];
  for (const b of blocked)
    for (const i of lineIndexesOf(ctx.items, b.productId))
      if (!seen.has(i)) {
        seen.add(i);
        rows.push(detailOf(i, b.reason ? { reason: b.reason } : {}));
      }
  return rows;
}

function findingRows(f: GateFinding, ctx: FlagContext): FlagRow[] {
  if (f.code === API_ERROR_CODES.REGULATED_AUTH_REQUIRED) {
    const blocked = new Set(
      ((f.body.blockedCategories as Array<{ trackedCategoryId?: string }>) ?? []).map(
        (c) => c.trackedCategoryId,
      ),
    );
    return ctx.priced.flatMap((li, i) =>
      li.trackedCategoryId && blocked.has(li.trackedCategoryId)
        ? [
            {
              kind: OrderReviewFlagKind.LICENSE_REQUIRED,
              lineIndex: i,
              detail: {
                lineIndex: i,
                productId: ctx.items[i]?.productId ?? null,
                trackedCategoryId: li.trackedCategoryId,
              },
            },
          ]
        : [],
    );
  }
  if (f.code === API_ERROR_CODES.CREDIT_LIMIT_EXCEEDED) {
    return [
      {
        kind: OrderReviewFlagKind.CREDIT_BLOCKED,
        lineIndex: null,
        detail: {
          limit: (f.body.limit as number | undefined) ?? null,
          exposure: (f.body.exposure as number | undefined) ?? null,
        },
      },
    ];
  }
  return restrictedRows(f, ctx);
}

/** One create() call's offline state: inert (every method a no-op or a pass-through) when the request is not offline. */
export class OfflineCreate {
  private findings: GateFinding[] = [];
  private drift: ReturnType<typeof judgeOfflineDrift> = [];

  constructor(private readonly opt: OfflineCreateOption | undefined) {}

  /** True when a gate refused and the order must be saved as a DRAFT instead. */
  get blocked(): boolean {
    return this.findings.length > 0;
  }

  /**
   * Runs one of create()'s three gate calls. Online it IS the call. Offline a refusal with one of the four codes is kept
   * as a finding (the call resolves to undefined) and the next gate still runs; any other error propagates unchanged.
   */
  async gate<T>(call: () => Promise<T>): Promise<T | undefined> {
    if (!this.opt) return call();
    try {
      return await call();
    } catch (e) {
      const finding = findingOf(e);
      if (!finding) throw e;
      this.findings.push(finding);
      return undefined;
    }
  }

  /** Price drift on the server's own priced lines (`items[i].unitPrice` typed by staff = an override, never flagged). */
  judgeDrift(
    items: ReadonlyArray<{ productId?: string | null; unitPrice?: number | null }>,
    priced: ReadonlyArray<object>,
    total: number,
  ): void {
    if (!this.opt) return;
    const server: ServerLine[] = (priced as ReadonlyArray<Record<string, unknown>>).map(
      (li, i) => ({
        productId: (li.productId as string | null | undefined) ?? null,
        unitPrice: Number(li.unitPrice),
        unitsPerBox: (li.unitsPerBox as number | null | undefined) ?? null,
        unitLabel: (li.unitLabel as string | null | undefined) ?? null,
        override: items[i]?.unitPrice != null,
      }),
    );
    this.drift = judgeOfflineDrift(server, total, this.opt.quote);
  }

  /** The Order columns an offline create adds (device time, display only). */
  orderData(): { offlineCreatedAt?: Date } {
    return this.opt?.createdAt ? { offlineCreatedAt: this.opt.createdAt } : {};
  }

  /** The flag rows this create produces, in a stable order: gate findings, drift, the open order, backorders. */
  rows(ctx: FlagContext): FlagRow[] {
    if (!this.opt) return [];
    const rows: FlagRow[] = this.findings.flatMap((f) => findingRows(f, ctx));
    for (const d of this.drift) {
      rows.push(
        d.kind === "LINE"
          ? {
              kind: OrderReviewFlagKind.PRICE_CHANGED_OFFLINE,
              lineIndex: d.lineIndex,
              detail: {
                lineIndex: d.lineIndex,
                productId: d.productId,
                shown: d.shown,
                now: d.now,
                ...(d.unitChanged ? { unitChanged: true } : {}),
              },
            }
          : {
              kind: OrderReviewFlagKind.PRICE_CHANGED_OFFLINE,
              lineIndex: null,
              detail: { shownTotal: d.shownTotal, nowTotal: d.nowTotal },
            },
      );
    }
    if (this.opt.openOrderId) {
      rows.push({
        kind: OrderReviewFlagKind.OPEN_ORDER_EXISTS,
        lineIndex: null,
        detail: { existingOrderId: this.opt.openOrderId },
      });
    }
    for (const line of ctx.created) {
      const pieces = Number(line.backorderedPieces ?? 0); // OrderItem.backorderedPieces (SA-716)
      if (pieces > 0 && line.position != null) {
        rows.push({
          kind: OrderReviewFlagKind.BACKORDERED_OFFLINE,
          lineIndex: line.position,
          detail: {
            lineIndex: line.position,
            productId: line.productId,
            backorderedPieces: pieces,
          },
        });
      }
    }
    return rows;
  }

  /**
   * ONE top-level `createMany` inside create()'s transaction with an explicit `tenantId` (never nested under
   * `order.create`: nested creates are not tenant-stamped). Nothing when there are no rows; a replay never gets here.
   */
  async writeFlags(
    tx: { orderReviewFlag: { createMany(args: { data: any[] }): Promise<unknown> } },
    order: { id: string; tenantId: string; lineItems: ReadonlyArray<CreatedLine> },
    items: FlagContext["items"],
    priced: FlagContext["priced"],
  ): Promise<void> {
    const rows = this.rows({ created: order.lineItems, items, priced });
    if (rows.length === 0) return;
    const itemIdAt = new Map(order.lineItems.map((l) => [l.position, l.id]));
    await tx.orderReviewFlag.createMany({
      data: rows.map((r) => ({
        tenantId: order.tenantId,
        orderId: order.id,
        orderItemId: r.lineIndex == null ? null : (itemIdAt.get(r.lineIndex) ?? null),
        kind: r.kind,
        detail: r.detail,
      })),
    });
  }
}

/** `new OfflineCreate(options.offline)`, named for the call site. */
export const offlineCreate = (opt: OfflineCreateOption | undefined) => new OfflineCreate(opt);
