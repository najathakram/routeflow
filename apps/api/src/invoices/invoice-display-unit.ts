import { Logger } from "@nestjs/common";
import {
  buildLadderView,
  customerTierFor,
  displayUnitForItem,
  displayUnitSnapshotOf,
  invoiceDisplayUnitFor,
  INVOICE_UNIT_SETTING_KEY,
  type LadderViewUnit,
} from "@routeflow/pricing";
import type { InvoiceDisplayUnitView } from "@routeflow/types";
import { txConflictState } from "../common/tx-retry";
import { isTxClient } from "../prisma/prisma.service";
import { asLadderProduct } from "../products/line-units";
import { ladderOptionsOf } from "../orders/units-prices-v2";
import { withComponentViews } from "../orders/component-view";

// SA-827 (T2): the invoice DISPLAY unit. A DISPLAY file (allow-listed by name in invoice-unit-display-only.spec.ts): it may
// name the snapshot columns and the display math. It never reads or writes money. The only writes are the two display
// columns InvoiceItem.invoiceUnitLabel/Factor, once, at the DRAFT -> issued transition (and cleared on a revert to draft).

const log = new Logger("InvoiceDisplayUnit");
const LEGACY: InvoiceDisplayUnitView = { kind: "legacy", label: null };
const legacy = (): InvoiceDisplayUnitView => ({ ...LEGACY });
/** The plan flag that gates unit ladders (UNITS_PRICES_V2_FLAG in @routeflow/pricing). */
const UNITS_V2_FLAG = "flag.units_prices_v2";

/** The strict flag reader (EntitlementsService.hasFlagStrict). */
export interface DisplayUnitEntitlements {
  hasFlagStrict: (tenantId: string, flag: string) => Promise<boolean>;
}

const str = (v: unknown): string | null => (v == null ? null : String(v as string | number));

const allLegacy = (items: ReadonlyArray<{ id: string }>): Map<string, InvoiceDisplayUnitView> =>
  new Map(items.map((i) => [i.id, legacy()]));

/**
 * The display unit each invoice line would render in RIGHT NOW (customer/product/tier/business preference, then legacy).
 * Batched: one query per table for the whole invoice. A failed flag read means flag off. Any error gives legacy for every
 * item: the read never fails.
 */
export async function resolveLiveDisplayUnits(
  db: any,
  tenantId: string | null | undefined, // a row without a tenant (nullable column) resolves legacy
  invoice: { customerId: string; items: Array<{ id: string; productId: string | null }> },
  entitlements?: DisplayUnitEntitlements | null,
): Promise<Map<string, InvoiceDisplayUnitView>> {
  try {
    return await resolveOrThrow(db, tenantId, invoice, entitlements);
  } catch (err) {
    log.warn(`live display unit resolve failed, rendering legacy: ${(err as Error)?.message}`);
    return allLegacy(invoice.items);
  }
}

/** What the catalog says for ONE customer's products (loaded by one batched query per table). Opaque to callers. */
export interface DisplayUnitCatalog {
  customerId: string;
  customerTier: number | string | null | undefined;
  cpBy: Map<string, any>;
  productBy: Map<string, any>;
  tierUnitBy: Map<string, any>;
  tierOrderUnits: Map<string, Record<number, string>>;
  unitsBy: Map<string, LadderViewUnit[]>;
  businessUnit: string | null;
  /** Customer.invoiceUnitDefault (LEGACY | PIECES | PACK), the highest-precedence preference. */
  customerDefault?: "LEGACY" | "PIECES" | "PACK" | null;
  /** The ladder flag was off: only a customer-wide PIECES applies, with no view. */
  ladderOff?: boolean;
}

const emptyCatalog = (): DisplayUnitCatalog => ({
  customerTier: null,
  cpBy: new Map(),
  productBy: new Map(),
  tierUnitBy: new Map(),
  tierOrderUnits: new Map(),
  unitsBy: new Map(),
  businessUnit: null,
});

/**
 * All the I/O behind a display unit (SA-967): the flag (a failed read means off), then the customer tier, CustomerPrice,
 * ProductTierUnit, products, unit rows and the business preference, one batched query per table. Null when the ladder
 * flag is off. {@link resolveFromCatalog} is the pure half.
 */
export async function loadDisplayUnitCatalog(
  db: any,
  tenantId: string,
  customerId: string,
  productIds: string[],
  entitlements?: DisplayUnitEntitlements | null,
): Promise<DisplayUnitCatalog | null> {
  {
    let on = false;
    try {
      on = !!(await entitlements?.hasFlagStrict?.(tenantId, UNITS_V2_FLAG));
    } catch {
      on = false;
    }
    if (!on) {
      // Flag off: no ladder and no catalog read. Only a customer-wide PIECES still applies (SA-827 rule 5); the pricing
      // resolver returns pieces for it with a null view.
      const c = await db.customer.findFirst({
        where: { id: customerId, tenantId },
        select: { invoiceUnitDefault: true },
      });
      if (c?.invoiceUnitDefault !== "PIECES") return null;
      return { ...emptyCatalog(), customerDefault: "PIECES", ladderOff: true };
    }

    const [customer, cpRows, tierRows, products, unitRows, business] = await Promise.all([
      db.customer.findFirst({
        where: { id: customerId, tenantId },
        select: { pricingTier: true, invoiceUnitDefault: true },
      }),
      db.customerPrice.findMany({
        // CustomerPrice.tenantId is nullable, so the tenant rides the non-null customer relation
        where: {
          customerId: customerId,
          customer: { tenantId },
          productId: { in: productIds },
        },
        select: { productId: true, pricingTier: true, invoiceUnitRef: true },
      }),
      db.productTierUnit.findMany({
        where: { tenantId, productId: { in: productIds } },
        select: { productId: true, tier: true, orderUnitRef: true, invoiceUnitRef: true },
      }),
      db.product.findMany({
        where: { tenantId, id: { in: productIds } },
        select: {
          id: true,
          unit: true,
          packLabel: true,
          baseUnitLabel: true,
          unitsPerBox: true,
          pricePerUnit: true,
          priceTier2: true,
          priceTier3: true,
          priceTier4: true,
          priceTier5: true,
          orderUnitRef: true,
          packAuto: true,
          invoiceUnitRef: true,
        },
      }),
      db.productUnit.findMany({
        where: { tenantId, productId: { in: productIds } },
        select: {
          id: true,
          productId: true,
          label: true,
          factorToBase: true,
          price: true,
          priceTier2: true,
          priceTier3: true,
          priceTier4: true,
          priceTier5: true,
        },
        orderBy: [{ sortOrder: "asc" }, { factorToBase: "asc" }],
      }),
      db.systemConfig.findFirst({
        where: { tenantId, key: INVOICE_UNIT_SETTING_KEY },
        select: { value: true },
      }),
    ]);

    const businessUnit: string | null = business?.value?.trim() || null;
    const cpBy = new Map<string, any>((cpRows ?? []).map((r: any) => [r.productId, r]));
    const productBy = new Map<string, any>((products ?? []).map((p: any) => [p.id, p]));
    const tierUnitBy = new Map<string, any>();
    const tierOrderUnits = new Map<string, Record<number, string>>();
    for (const t of tierRows ?? []) {
      tierUnitBy.set(`${t.productId}:${t.tier}`, t);
      if (t.orderUnitRef && t.tier >= 2 && t.tier <= 5) {
        const own = tierOrderUnits.get(t.productId) ?? {};
        own[t.tier] = t.orderUnitRef;
        tierOrderUnits.set(t.productId, own);
      }
    }
    const unitsBy = new Map<string, LadderViewUnit[]>();
    for (const u of unitRows ?? []) {
      unitsBy.set(u.productId, [
        ...(unitsBy.get(u.productId) ?? []),
        {
          id: u.id,
          label: u.label,
          factorToBase: Number(u.factorToBase),
          price: str(u.price),
          priceTier2: str(u.priceTier2),
          priceTier3: str(u.priceTier3),
          priceTier4: str(u.priceTier4),
          priceTier5: str(u.priceTier5),
        },
      ]);
    }

    return {
      customerId,
      customerTier: customer?.pricingTier,
      customerDefault: customer?.invoiceUnitDefault ?? null,
      cpBy,
      productBy,
      tierUnitBy,
      tierOrderUnits,
      unitsBy,
      businessUnit,
    };
  }
}

/**
 * PURE (SA-967): each item's display unit from a loaded catalog. An item with no product is legacy; a product the catalog
 * lacks (an office edit that landed between the catalog read and the tx) is legacy with a warn; a failure is legacy.
 */
export function resolveFromCatalog(
  catalog: DisplayUnitCatalog,
  items: ReadonlyArray<{ id: string; productId: string | null }>,
): Map<string, InvoiceDisplayUnitView> {
  const { customerTier, cpBy, productBy, tierUnitBy, tierOrderUnits, unitsBy, businessUnit } =
    catalog;
  const byProduct = new Map<string, InvoiceDisplayUnitView>();
  const productIds = new Set(items.map((i) => i.productId).filter((p): p is string => !!p));
  if (catalog.ladderOff) {
    const pieces = invoiceDisplayUnitFor({ customerDefault: "PIECES", scopes: {}, view: null });
    for (const pid of productIds) byProduct.set(pid, { ...pieces });
    return byProduct;
  }
  for (const pid of productIds) {
    try {
      const p = productBy.get(pid);
      if (!p) {
        byProduct.set(pid, legacy());
        continue;
      }
      const cp = cpBy.get(pid);
      const tier = customerTierFor(cp?.pricingTier, customerTier); // the one tier resolver
      const view = buildLadderView(
        asLadderProduct(p),
        unitsBy.get(pid) ?? [],
        ladderOptionsOf(p, tierOrderUnits.get(pid) as any),
      );
      byProduct.set(
        pid,
        invoiceDisplayUnitFor({
          customerDefault: catalog.customerDefault ?? null,
          scopes: {
            customer: cp?.invoiceUnitRef ?? null,
            tier: tierUnitBy.get(`${pid}:${tier}`)?.invoiceUnitRef ?? null,
            product: p.invoiceUnitRef ?? null,
            business: businessUnit,
          },
          view,
        }),
      );
    } catch {
      byProduct.set(pid, legacy());
    }
  }
  const out = new Map<string, InvoiceDisplayUnitView>();
  for (const it of items) {
    if (it.productId) out.set(it.id, { ...(byProduct.get(it.productId) ?? legacy()) });
  }
  return out;
}

async function resolveOrThrow(
  db: any,
  tenantId: string | null | undefined, // a row without a tenant (nullable column) resolves legacy
  invoice: { customerId: string; items: Array<{ id: string; productId: string | null }> },
  entitlements?: DisplayUnitEntitlements | null,
): Promise<Map<string, InvoiceDisplayUnitView>> {
  const out = allLegacy(invoice.items);
  if (!tenantId || !invoice.customerId) return out;
  const productIds = [
    ...new Set(invoice.items.map((i) => i.productId).filter((p): p is string => !!p)),
  ];
  if (productIds.length === 0) return out;
  const catalog = await loadDisplayUnitCatalog(
    db,
    tenantId,
    invoice.customerId,
    productIds,
    entitlements,
  );
  if (!catalog) return out;
  for (const [id, view] of resolveFromCatalog(catalog, invoice.items)) out.set(id, view);
  return out;
}

/**
 * Adds `displayUnit` to every item. A DRAFT follows `live`; an issued invoice reads its own snapshot (a reprint never
 * changes when the preference changes later); no snapshot (issued before SA-827) is legacy.
 */
export function withItemDisplayUnits<
  I extends { id: string; invoiceUnitLabel?: string | null; invoiceUnitFactor?: number | null },
  T extends { status: string; items: I[] },
>(
  invoice: T,
  live: ReadonlyMap<string, InvoiceDisplayUnitView> | null | undefined,
): T & { items: Array<I & { displayUnit: InvoiceDisplayUnitView }> } {
  return {
    ...invoice,
    items: invoice.items.map((item) => ({
      ...item,
      displayUnit: displayUnitForItem(
        invoice.status,
        { label: item.invoiceUnitLabel ?? null, factor: item.invoiceUnitFactor ?? null },
        live?.get(item.id) ?? null,
      ),
    })),
  };
}

/**
 * Resolves the display unit each not-yet-snapshotted line of an invoice would freeze into, through a NON-transaction client
 * (so no catalog read joins the money tx's Serializable snapshot). A catalog error gives an empty map, and a line missing
 * from the map is written nothing, so it renders legacy. The one throw: a failed own-rows read through the caller's tx
 * (`ownRowsDb`), which has already aborted that tx, is rethrown so a 40001 conflict reaches the retry instead of a 25P02.
 */
export async function resolveIssueDisplayUnits(
  readDb: any,
  tenantId: string,
  invoiceId: string,
  entitlements?: DisplayUnitEntitlements | null,
  /** Where the invoice's OWN rows are read (default `readDb`). Pass the caller's tx when the invoice or its items may
   *  have been written in that uncommitted tx (the delivery path); catalog reads always stay on `readDb`. */
  ownRowsDb?: any,
): Promise<Map<string, InvoiceDisplayUnitView>> {
  if (typeof invoiceId !== "string" || !invoiceId || typeof tenantId !== "string" || !tenantId) {
    return new Map();
  }
  const own = ownRowsDb ?? readDb;
  let inv: { customerId: string | null } | null = null;
  let items: Array<{ id: string; productId: string | null }> = [];
  try {
    inv = await own.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      select: { customerId: true },
    });
    if (inv?.customerId) {
      items = await own.invoiceItem.findMany({
        where: { invoiceId, invoiceUnitFactor: null, invoice: { tenantId } },
        select: { id: true, productId: true },
      });
    }
  } catch (err) {
    // A failed read inside the caller's tx aborts it (25P02 on the next statement): surface the real error (a retryable
    // 40001/40P01 conflict) instead of swallowing it. Any other client just skips.
    if (ownRowsDb != null && isTxClient(own)) throw err;
    log.warn(`display unit resolve skipped for invoice ${invoiceId}: ${(err as Error)?.message}`);
    return new Map();
  }
  if (!inv?.customerId || !items.length) return new Map();
  try {
    return await resolveOrThrow(
      readDb,
      tenantId,
      { customerId: inv.customerId, items },
      entitlements,
    );
  } catch (err) {
    log.warn(`display unit resolve skipped for invoice ${invoiceId}: ${(err as Error)?.message}`);
    return new Map();
  }
}

/**
 * Pre-tx resolve for a send/pay path: reads the invoice's status (the same read markSent always made; a failure throws),
 * and only a DRAFT with a tenant resolves the units it would freeze. Anything else is null (nothing to write).
 */
export async function resolveDraftIssueUnits(
  readDb: any,
  invoiceId: string,
  entitlements?: DisplayUnitEntitlements | null,
): Promise<Map<string, InvoiceDisplayUnitView> | null> {
  const pre = await readDb.invoice.findUnique({
    where: { id: invoiceId },
    select: { status: true, tenantId: true },
  });
  return pre?.status === "DRAFT" && pre.tenantId
    ? resolveIssueDisplayUnits(readDb, pre.tenantId, invoiceId, entitlements)
    : null;
}

/** `invoice.items` with `displayUnit`: a DRAFT resolves live, an issued invoice reads its snapshot (no catalog query). */
export async function itemsWithDisplayUnits<
  I extends {
    id: string;
    productId: string | null;
    invoiceUnitLabel?: string | null;
    invoiceUnitFactor?: number | null;
  },
>(
  readDb: any,
  invoice: { status: string; tenantId: string | null; customerId: string; items: I[] },
  entitlements?: DisplayUnitEntitlements | null,
): Promise<Array<I & { displayUnit: InvoiceDisplayUnitView }>> {
  const live =
    invoice.status === "DRAFT"
      ? await resolveLiveDisplayUnits(readDb, invoice.tenantId, invoice, entitlements)
      : null;
  return withItemDisplayUnits<I, { status: string; items: I[] }>(
    { status: invoice.status, items: withComponentViews(invoice.items as any) as unknown as I[] },
    live,
  ).items;
}

/**
 * At a DRAFT -> issued transition: resolve (invoice's own rows through `tx`, catalog through `readDb`) and freeze the
 * display units in `tx`. No tenant, nothing to do. For the inline flip `readDb` and `tx` are the same non-tx client.
 */
export async function freezeDraftIssueUnits(
  readDb: any,
  tx: any,
  inv: { id: string; tenantId: string | null },
  entitlements?: DisplayUnitEntitlements | null,
): Promise<void> {
  if (!inv.tenantId) return;
  const units = await resolveIssueDisplayUnits(readDb, inv.tenantId, inv.id, entitlements, tx);
  await writeIssueDisplayUnits(tx, inv.id, units);
}

/**
 * The delivery path (SA-967): the invoice and its lines are created INSIDE the delivery tx, so their units cannot be resolved
 * before it, but the CATALOG they resolve against can. This loads the STOP's customer's catalog for the products on the
 * stop's orders on a non-tx client BEFORE the tx opens, so the tx never takes a pooled connection for a catalog read or the
 * flag read. Never throws: no customer, no tenant, no orders, the flag off or a failed read give null, and a line then reads
 * legacy (the module's contract for a failed resolve).
 */
export async function loadStopDisplayUnitCatalog(
  prisma: { forTenant(): any; getTenantId(): string | null | undefined },
  stop: { customerId: string | null; orders: ReadonlyArray<{ id: string }> },
  entitlements?: DisplayUnitEntitlements | null,
): Promise<DisplayUnitCatalog | null> {
  const tenantId = prisma.getTenantId();
  if (!tenantId || !stop.customerId || stop.orders.length === 0) return null;
  try {
    const db = prisma.forTenant();
    const rows: Array<{ productId: string | null }> = await db.orderItem.findMany({
      where: { orderId: { in: stop.orders.map((o) => o.id) }, order: { tenantId } },
      select: { productId: true },
    });
    const productIds = [
      ...new Set((rows ?? []).map((r) => r.productId).filter((p): p is string => !!p)),
    ];
    if (productIds.length === 0) return null;
    return await loadDisplayUnitCatalog(db, tenantId, stop.customerId, productIds, entitlements);
  } catch (err) {
    log.warn(`stop display unit catalog load skipped: ${(err as Error)?.message}`);
    return null;
  }
}

/**
 * In the caller's tx, at the DRAFT -> issued transition on the delivery path (SA-967): freeze the lines' display units from
 * the catalog {@link loadStopDisplayUnitCatalog} loaded before the tx. It takes the CATALOG, never a client: only the
 * invoice's OWN rows are read (through `tx`, they may be uncommitted) and no catalog query and no flag read happens here.
 * A null catalog, or an invoice of another customer, writes nothing (legacy). A line whose product the catalog lacks is
 * written nothing, with a warn. A failed own-rows read is rethrown (it has aborted the tx; a 40001 must reach the retry).
 */
export async function freezeIssueUnitsFromCatalog(
  tx: any,
  inv: { id: string; tenantId: string | null },
  catalog: DisplayUnitCatalog | null,
): Promise<void> {
  if (!inv.tenantId || !catalog) return;
  const own = await tx.invoice.findFirst({
    where: { id: inv.id, tenantId: inv.tenantId },
    select: { customerId: true },
  });
  if (!own?.customerId || own.customerId !== catalog.customerId) return;
  const items: Array<{ id: string; productId: string | null }> = await tx.invoiceItem.findMany({
    where: { invoiceId: inv.id, invoiceUnitFactor: null, invoice: { tenantId: inv.tenantId } },
    select: { id: true, productId: true },
  });
  if (!items.length) return;
  const missing = items.filter((i) => i.productId && !catalog.productBy.has(i.productId));
  if (missing.length > 0) {
    log.warn(
      `display unit catalog lacks ${missing.length} product(s) of invoice ${inv.id}: those lines read legacy`,
    );
  }
  await writeIssueDisplayUnits(tx, inv.id, resolveFromCatalog(catalog, items)); // a missing product is legacy: nothing written
}

/**
 * Runs `work` under SAVEPOINT when `db` is a transaction client (the commission-sync pattern, sales-agents/
 * commission-engine.service.ts): a failed statement would otherwise abort the whole Postgres tx. A write conflict
 * (40001 / 40P01 / P2034) is RETHROWN with no rollback-to, so the caller's retryCreditTx re-runs the whole tx. Any other
 * error rolls back to the savepoint, is logged and swallowed. A non-tx client (the inline flip) just swallows.
 */
async function underSavepoint(
  db: any,
  invoiceId: string,
  work: () => Promise<void>,
): Promise<void> {
  if (!isTxClient(db)) {
    try {
      await work();
    } catch (err) {
      log.warn(`display unit write skipped for invoice ${invoiceId}: ${(err as Error)?.message}`);
    }
    return;
  }
  await db.$executeRaw`SAVEPOINT display_unit_snapshot`;
  try {
    await work();
    await db.$executeRaw`RELEASE SAVEPOINT display_unit_snapshot`;
  } catch (err) {
    if (txConflictState(err)) throw err;
    try {
      await db.$executeRaw`ROLLBACK TO SAVEPOINT display_unit_snapshot`;
    } catch (rollbackErr) {
      log.error(
        `display unit write for invoice ${invoiceId} failed and ROLLBACK TO SAVEPOINT also failed; the caller's transaction is unusable: ${(rollbackErr as Error)?.message}`,
      );
      throw rollbackErr;
    }
    log.warn(`display unit write skipped for invoice ${invoiceId}: ${(err as Error)?.message}`);
  }
}

/**
 * In the caller's tx, at the DRAFT -> issued transition ONLY: freeze the PIECES lines' display unit into
 * InvoiceItem.invoiceUnitLabel/Factor, one updateMany per distinct label. The data holds ONLY those two keys, and the where
 * keeps a line that already has a snapshot (invoiceUnitFactor null). A legacy line is not written (null = legacy). With no
 * pieces line it issues zero statements. `units` comes from {@link resolveIssueDisplayUnits}, resolved OUTSIDE the tx.
 */
export async function writeIssueDisplayUnits(
  tx: any,
  invoiceId: string,
  units: ReadonlyMap<string, InvoiceDisplayUnitView> | null | undefined,
): Promise<void> {
  if (typeof invoiceId !== "string" || !invoiceId || !units) return; // Prisma drops an undefined where key
  const byLabel = new Map<string, string[]>();
  for (const [id, unit] of units) {
    const snap = displayUnitSnapshotOf(unit);
    if (!snap || typeof id !== "string" || !id) continue;
    byLabel.set(snap.label, [...(byLabel.get(snap.label) ?? []), id]);
  }
  if (byLabel.size === 0) return;
  await underSavepoint(tx, invoiceId, async () => {
    for (const [label, ids] of byLabel) {
      await tx.invoiceItem.updateMany({
        where: { id: { in: ids }, invoiceId, invoiceUnitFactor: null },
        data: { invoiceUnitLabel: label, invoiceUnitFactor: 1 },
      });
    }
  });
}

/**
 * On a revert to DRAFT: clear the snapshot of that invoice's lines (both columns to null). A DRAFT renders live (SA-827
 * rule 5), so a re-issue snapshots afresh. The data holds ONLY the two display columns.
 */
export async function clearIssueDisplayUnits(tx: any, invoiceId: string): Promise<void> {
  if (typeof invoiceId !== "string" || !invoiceId) return;
  await underSavepoint(tx, invoiceId, async () => {
    await tx.invoiceItem.updateMany({
      where: { invoiceId },
      data: { invoiceUnitLabel: null, invoiceUnitFactor: null },
    });
  });
}
