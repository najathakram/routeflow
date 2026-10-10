import { ConflictException, ForbiddenException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { createHash } from "crypto";
import { assertReplayCarriesReturnKey } from "./order-inline-return";
import { assertReplaySameCart } from "./replay-same-cart";
import type { InlineReturnReplayLines } from "../returns/inline-return-fingerprint";

// Canonical JSON: object keys sorted, undefined-valued keys dropped (an absent field and a
// missing field fingerprint the same), arrays kept in order at this level.
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * B215: the fingerprint of a staff merge request, stored as OrderIdempotencyKey.responseHash.
 * A same-key retry is replayed only when its fingerprint matches; a same key with a different
 * cart is refused (409), mirroring create()'s R4 content check. Neither item order NOR
 * credit-note order matters — both are SETS on the wire (the client sends whatever order its
 * selection UI happens to hold), so an order-sensitive fingerprint refused an honest retry of
 * the identical cart with a 409.
 */
export function mergeRequestHash(input: {
  customerId: string;
  items?: readonly unknown[] | null;
  appliedCreditNotes?: unknown;
  /** #2094: a return added or changed on a replay must not be silently dropped. */
  inlineReturn?: unknown;
}): string {
  const items = (input.items ?? []).map(stable).sort();
  // Same treatment as `items`: stable-serialize each entry, then sort the serialized strings.
  // A non-array value (null / undefined / an object) is fingerprinted as-is — only a list has
  // an order to normalize away.
  const appliedCreditNotes = Array.isArray(input.appliedCreditNotes)
    ? input.appliedCreditNotes.map(stable).sort()
    : (input.appliedCreditNotes ?? null);
  return createHash("sha256")
    .update(
      stable({
        customerId: input.customerId,
        items,
        appliedCreditNotes,
        // A cart with no return fingerprints exactly as before (an absent key is dropped by stable()).
        inlineReturn: input.inlineReturn ?? undefined,
      }),
    )
    .digest("hex");
}

/**
 * B215: the machine-readable `code` on both Idempotency-Key 409 bodies from
 * `findOrderIdByIdempotencyKey`. Clients branch on this (mobile NewOrderScreen offers
 * "Open order" using the body's `orderId`) the same way they branch on the merge branch's
 * `MERGE_CHOICE_REQUIRED` and the lock path's `LOCK_UNAVAILABLE`. There is no shared
 * error-code const module in `packages/types` yet — these codes are declared next to the
 * code that throws them, so this lives here rather than beside `MERGE_CHOICE_REQUIRED`
 * (an inline literal in orders.controller.ts).
 *
 * Bodies: `{ code, reason: "CART_MISMATCH" | "HELD_BY_OTHER_ORDER", orderId, message }` —
 * `orderId` is always the order that HOLDS the key.
 */
export const IDEMPOTENCY_KEY_CONFLICT = "IDEMPOTENCY_KEY_CONFLICT";

/**
 * B215/R2 (round 2): a post-delivery merge REPLAY whose partial-billing routing cannot be
 * reproduced from the order's current state. The fold's guard reads the PRE-EDIT cumulative
 * `invoicedQty`, which a replace-all fold resets — so when the current lines show nothing
 * invoiced while finalized invoices still exist, the replay can neither safely resync (it could
 * expand an already-issued invoice to units it never billed) nor safely skip (it would leave the
 * invoice permanently out of step with the edit). It refuses LOUDLY instead and points the
 * operator at the order. Clients treat it like `IDEMPOTENCY_KEY_CONFLICT`: offer "Open order"
 * using the body's `orderId`.
 *
 * Body: `{ code, orderId, message }`.
 */
export const IDEMPOTENCY_REPLAY_NEEDS_RECONCILE = "IDEMPOTENCY_REPLAY_NEEDS_RECONCILE";

/**
 * B667 (#1185 review round 5, item 6): the one shared tolerance for "is a Decimal(10,3) qty
 * effectively equal/at-least another" across every qty-coverage predicate in this family
 * (`shouldSkipInPlaceResync` below, `checkOrderCoverage` in finalize-order-recompute.ts) — Node's
 * float math (0.7 + 0.1 === 0.7999999999999999) means a strict comparison can misjudge a
 * genuinely-exact sum. One constant so it can never drift into two different literals.
 */
export const QTY_EPSILON = 0.001;

/**
 * B215/R2: the partial-billing guard `updateOrderItems` applies to a POST-DELIVERY edit, as a
 * pure predicate over the line rows it reads — so the replay path can evaluate the SAME rule
 * instead of hard-coding one side of it.
 *
 * "Partial" is CROSS-LINE, not just within a line: a line billed for part of its qty, OR a subset
 * of lines billed in full while siblings are entirely un-invoiced. Both make an in-place resync
 * unsafe (it rebuilds each invoice at the full current line qty). The two safe states proceed:
 * nothing invoiced yet, and every billable line fully invoiced.
 *
 * `true` = skip the in-place resync (the operator reconciles manually).
 */
export function shouldSkipInPlaceResync(
  lines: ReadonlyArray<{ qty?: unknown; invoicedQty?: unknown }>,
): boolean {
  const billableLines = lines.filter((li) => Number(li.qty ?? 0) > QTY_EPSILON);
  const anyInvoiced = billableLines.some((li) => Number(li.invoicedQty ?? 0) > QTY_EPSILON);
  const allFullyInvoiced = billableLines.every(
    (li) => Number(li.invoicedQty ?? 0) >= Number(li.qty ?? 0) - QTY_EPSILON,
  );
  return anyInvoiced && !allFullyInvoiced;
}

/** What the extracted replay lookup needs from OrdersService: its prisma client and logger. */
export interface IdempotencyLookupDeps {
  prisma: { getTenantId(): string | null; forTenant(): any };
  logger: { warn(message: string): void };
}

export async function findOrderIdByIdempotencyKey(
  deps: IdempotencyLookupDeps,
  idempotencyKey: string,
  customerId: string,
  requestHash?: string,
): Promise<{ orderId: string; verified: boolean } | null> {
  // B215: `forTenant()` hands back the UNSCOPED client when the session carries no tenant
  // (prisma.service.ts `forTenant`), so for such a caller the lookups below would search
  // every tenant's rows. Refuse up front — before any read and before the controller enters
  // the fold — mirroring the identical guard in `create()`. `recordMergeIdempotencyKey`
  // keeps the same check as the fail-closed backstop inside the fold's transaction.
  if (!deps.prisma.getTenantId()) {
    deps.logger.warn(`idempotency key refused: no tenant scope key=${idempotencyKey}`);
    throw new ForbiddenException("Idempotency-Key requires a tenant-scoped session");
  }
  // B215: every staff merge wave records its OWN key in OrderIdempotencyKey (written inside
  // the fold's transaction by recordMergeIdempotencyKey), so that table is the authoritative
  // replay store for the merge branch. Scoped to THIS customer through the order relation —
  // the key is client-chosen, so a bare match could replay onto another customer's order.
  const keyed = await deps.prisma.forTenant().orderIdempotencyKey.findFirst({
    where: { key: idempotencyKey, order: { customerId } },
    select: { orderId: true, responseHash: true },
  });
  if (keyed) {
    if (requestHash !== undefined && keyed.responseHash !== requestHash) {
      deps.logger.warn(
        `idempotency replay refused: cart mismatch tenant=${deps.prisma.getTenantId()} ` +
          `customer=${customerId} order=${keyed.orderId} key=${idempotencyKey}`,
      );
      // B215: machine-readable body — the mobile client cannot mint a fresh key without
      // abandoning the cart, so it needs `orderId` to offer "Open order" instead of wedging
      // the screen on a bare message.
      throw new ConflictException({
        code: IDEMPOTENCY_KEY_CONFLICT,
        reason: "CART_MISMATCH",
        orderId: keyed.orderId,
        message:
          "Idempotency-Key reused with a different cart — open the existing order to edit it, or retry it unchanged",
      });
    }
    // VERIFIED only when a fingerprint was supplied AND matched: a caller that passes no
    // `requestHash` (the db-spec's bare two-argument probe, any future keyless caller) has
    // proven nothing about the body, so it gets the same unverified treatment as a column hit.
    return { orderId: keyed.orderId, verified: requestHash !== undefined };
  }
  // The single Order column: keys stamped by create() and by recordIdempotencyKey. Unchanged.
  // B215: deliberately NOT compared against `requestHash` — the column stores no fingerprint,
  // and its main producer is the create -> retry path (the first POST creates the order and
  // stamps the key; the retry finds it pending and enters the merge branch). Refusing that
  // replay for want of a hash would re-open the double-write this fix exists to close, so a
  // column-only hit is replay-eligible. The key TABLE, which does store the hash, is the only
  // path that refuses on a mismatch. Pinned by P5.
  //
  // B215 (lookup ORDER, D3): this customer-scoped column read runs BEFORE the tenant-wide
  // `heldByAnotherOrder` check below. Both are "the key exists somewhere in this tenant", but
  // only this one proves it is THIS customer's own order — checking the tenant-wide table
  // first refused a legitimate replay of the caller's own key with a 409 whenever the key sat
  // on the Order column here and any other customer happened to hold a key-table row.
  const existing = await deps.prisma.forTenant().order.findFirst({
    where: { idempotencyKey, customerId },
    select: { id: true },
  });
  // UNVERIFIED by construction: the column stores no fingerprint, so this hit proves only
  // "this customer's order already used this key", never "with this cart".
  if (existing) return { orderId: existing.id, verified: false };
  // B215: the key may already belong to ANOTHER customer's order in this tenant. The in-tx
  // insert catches that through `@@unique([tenantId, key])`, but only after
  // `revertLinkedInvoicesForOrderEdit` has committed on its own connection (outside the fold)
  // and the whole fold has run — so a 409 there leaves a linked invoice flipped SENT -> DRAFT
  // for an edit that never landed. Refuse here instead: this lookup runs inside the customer
  // advisory lock, before any write. The P2002 branch of `recordMergeIdempotencyKey` stays as
  // the backstop for a true race (a customer-keyed lock does not serialize against another
  // customer's fold).
  const heldByAnotherOrder = await deps.prisma.forTenant().orderIdempotencyKey.findFirst({
    where: { key: idempotencyKey },
    select: { orderId: true },
  });
  if (heldByAnotherOrder) {
    deps.logger.warn(
      `idempotency key already held by another order: refused before the fold ` +
        `tenant=${deps.prisma.getTenantId()} customer=${customerId} ` +
        `order=${heldByAnotherOrder.orderId} key=${idempotencyKey}`,
    );
    throw new ConflictException({
      code: IDEMPOTENCY_KEY_CONFLICT,
      reason: "HELD_BY_OTHER_ORDER",
      orderId: heldByAnotherOrder.orderId,
      message: "Idempotency-Key already used for a different order",
    });
  }
  return null;
}

/**
 * #2094 (Opus R): `findOrderIdByIdempotencyKey`, then a request that carries a return checks it on
 * EVERY key hit, verified or not (a merge target legitimately holds earlier returns, so only a
 * request with a returnKey is checked).
 */
export async function findOrderIdByKeyCheckingReturn(
  deps: IdempotencyLookupDeps & { prisma: { forTenant(): unknown } },
  idempotencyKey: string,
  customerId: string,
  requestHash: string | undefined,
  inlineReturn: InlineReturnReplayLines | undefined, // #2424: its items are compared too, not only its key
  cart: { items?: ReadonlyArray<unknown> | null; status?: string | null }, // BUG-A: the body to compare
): Promise<{ orderId: string; verified: boolean } | null> {
  const hit = await findOrderIdByIdempotencyKey(deps, idempotencyKey, customerId, requestHash);
  if (hit && !hit.verified) {
    // An Order-COLUMN hit stores no fingerprint: compare the body to the order the key created.
    const held = await (deps.prisma.forTenant() as any).order.findFirst({
      where: { id: hit.orderId },
      select: { id: true, status: true, lineItems: true },
    });
    if (held) assertReplaySameCart(held, cart);
  }
  if (hit) await assertReplayCarriesReturnKey(deps.prisma.forTenant(), inlineReturn, hit.orderId);
  return hit;
}

/**
 * B215: `create()`'s replay candidate for `idempotencyKey`, loaded with the include its
 * caller's ownership + cart checks read.
 *
 * Consults the OrderIdempotencyKey TABLE first and the Order COLUMN only as a fallback: a
 * keyed request that reached the merge branch has its key in the table alone (the fold writes
 * it there), and such a request CAN fall through to `create()` — the merge target vanishing
 * before the advisory lock is the live path — so a column-only lookup would miss the replay
 * and mint a duplicate order.
 *
 * B215/R4 (round 2): the CALLER'S OWN row wins. Lookup order is (1) a key-TABLE row on an
 * order belonging to `customerId`, (2) this customer's key-stamped Order COLUMN, (3) only then
 * the tenant-wide table row — which the caller's ownership gate still turns into a 409. Without
 * step 1/2 a key-table row belonging to ANOTHER customer was fetched first and 409'd a caller
 * whose own column-stamped order was sitting right there (the same D3 ordering bug already
 * fixed in `findOrderIdByIdempotencyKey`).
 */
export async function loadReplayCandidateByKey(
  deps: IdempotencyLookupDeps,
  idempotencyKey: string,
  customerId: string,
) {
  const include = {
    customer: { select: { id: true, businessName: true } },
    lineItems: { include: { product: { select: { id: true, name: true, unit: true } } } },
  };
  const load = (where: Record<string, unknown>) =>
    deps.prisma.forTenant().order.findFirst({ where, include });
  // (1) a key-table row on an order that is THIS customer's.
  const owned = await deps.prisma.forTenant().orderIdempotencyKey.findFirst({
    where: { key: idempotencyKey, order: { customerId } },
    select: { orderId: true },
  });
  if (owned) return load({ id: owned.orderId });
  // (2) this customer's own key-stamped Order column.
  const ownColumn = await load({ idempotencyKey, customerId });
  if (ownColumn) return ownColumn;
  // (3) the tenant-wide key-table row — the caller's ownership gate turns this into a 409.
  const keyed = await deps.prisma
    .forTenant()
    .orderIdempotencyKey.findFirst({ where: { key: idempotencyKey }, select: { orderId: true } });
  // (4) and finally the tenant-wide column, which is likewise gated by ownership. Unchanged
  // behaviour for a key stamped on another customer's order: found, then refused.
  return load(keyed ? { id: keyed.orderId } : { idempotencyKey });
}

/**
 * F30/R8 (B196): stamp the replay key onto the order a staff merge landed on,
 * so a re-delivery of that same request replays instead of folding the same
 * items in again.
 *
 * An order holds at most one key, so a merge overwrites whatever key created
 * the order. That is deliberate: replays arrive within seconds/minutes of the
 * request they duplicate, so the MOST RECENT operation on the order is the one
 * whose replay window is still open. A concurrent claim from another API
 * replica loses the unique-constraint race (P2002) — the merge it raced has
 * already been written, so swallow it rather than fail a completed write.
 */
export async function stampOrderIdempotencyKey(
  deps: IdempotencyLookupDeps,
  orderId: string,
  idempotencyKey: string,
): Promise<void> {
  try {
    // First key wins (R1): an order can absorb several queued requests (auto-
    // merge waves); the EARLIEST key is the one a stuck client will retry
    // with, so never let a later wave clobber it — the later request's own
    // replay is answered by content comparison against the same order anyway,
    // for `create()`; the merge path's replay is a bare key lookup, so a key
    // that was already set leaves that fold unguarded (campaign candidate).
    await deps.prisma.forTenant().order.updateMany({
      where: { id: orderId, idempotencyKey: null },
      data: { idempotencyKey },
    });
  } catch (e: any) {
    if (e?.code !== "P2002") throw e;
  }
}

/**
 * B215: record a staff merge's Idempotency-Key in OrderIdempotencyKey through the FOLD's own
 * transaction client `tx`, so the key and the fold commit — or roll back — together. Called
 * only from updateOrderItems' transaction callback. A P2002 means the key already belongs to
 * another request (every same-customer retry is answered by the replay pre-check before the
 * fold), so it aborts the fold with a 409: swallowing an error inside a Postgres transaction
 * would leave the transaction aborted anyway. Uses only deps.prisma (the DB lane builds this
 * service without DI).
 */
export async function insertMergeIdempotencyKey(
  deps: IdempotencyLookupDeps,
  tx: any,
  orderId: string,
  idem: { key: string; responseHash: string },
): Promise<void> {
  const tenantId = deps.prisma.getTenantId();
  if (!tenantId) {
    deps.logger.warn(`idempotency key refused: no tenant scope key=${idem.key}`);
    throw new ForbiddenException("Idempotency-Key requires a tenant-scoped session");
  }
  try {
    await tx.orderIdempotencyKey.create({
      data: { tenantId, key: idem.key, orderId, responseHash: idem.responseHash },
    });
  } catch (e: any) {
    if (e?.code === "P2002") {
      deps.logger.warn(
        `idempotency key already held by another order: fold rolled back ` +
          `tenant=${tenantId} order=${orderId} key=${idem.key}`,
      );
      throw new ConflictException("Idempotency-Key already used for a different order");
    }
    throw e;
  }
}

/**
 * create()'s two Idempotency-Key 409s, each CODED (the order already exists: for a counter sale an UNKNOWN
 * outcome). The message text is unchanged from before the codes were added.
 */
export const otherOrderConflict = () =>
  new ConflictException({
    code: API_ERROR_CODES.IDEMPOTENCY_KEY_OTHER_ORDER,
    message: "Idempotency-Key already used for a different order",
  });
export const cartMismatchConflict = (orderId: string) =>
  new ConflictException({
    code: API_ERROR_CODES.IDEMPOTENCY_KEY_CART_MISMATCH,
    // BUG-A: the order that HOLDS the key, so a client can open it instead of wedging on a message.
    orderId,
    message:
      "Idempotency-Key reused with a different cart — submit the edited cart as a new order (new key), or retry the original unchanged",
  });
/** BUG-A: the key already made this order as a DRAFT (or already made a real order and this is a draft save). */
export const draftMismatchConflict = (orderId: string, storedIsDraft: boolean) =>
  new ConflictException({
    code: API_ERROR_CODES.IDEMPOTENCY_KEY_DRAFT_MISMATCH,
    orderId,
    message: storedIsDraft
      ? "This order was saved as a draft — open it to confirm"
      : "This order was already created — open it instead of saving it as a draft",
  });
