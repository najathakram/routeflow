/**
 * SA-984 §4 / SA-987 / SA-996: the DB-lane half of the units fold-in battery. Test support, not a spec.
 *
 * The readers kit (`units-fold-battery.ts`) prices one line through the real readers with a transcription of
 * `create()`'s pack branch. This harness runs the REAL `OrdersService.create()` on Postgres: several tenants are seeded
 * by ONE function (`seedFoldTenant`), each is given its own key set of the three `flag.units_*` keys, and the same
 * document is created in each. What a cell compares is what `create()` STORED and moved: the line, the order header,
 * the SALE stock the sale took, the printed quantity text. Separate tenants also defeat the 30 s flag cache and keep the
 * stock baselines equal (plan R3/R4).
 *
 * The flag stub answers BOTH `hasFlag` and `hasFlagStrict` (plan R1) per tenant and records every call, so each cell
 * reports how many times each key was consulted, exactly as the readers kit does.
 *
 * SAFETY: the specs name their tenants `qa-ufold-*`, which `assertTestTenant` approves; nothing here touches another tenant.
 */
import { Logger } from "@nestjs/common";
import { invoiceLineQtyText } from "@routeflow/pricing";
import type { PrismaClient } from "@prisma/client";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import type { PrismaService } from "../../prisma/prisma.service";
import type { TenantContextService } from "../../tenant/tenant-context.service";
import { OrdersService } from "../orders.service";
import {
  FLAG_PRICES_V2,
  FLAG_SETTINGS,
  FLAG_V1,
  REGULATED,
  SHAPES,
  customerOf,
  type Consulted,
  type CustomerRow,
  type Fig,
  type LineReq,
  type LineRun,
  type Shape,
} from "./units-fold-battery";

// ─── the per-tenant flag stub ───────────────────────────────────────────────────────────────────────────────────────
export interface DbFlagCall {
  tenantId: string;
  flag: string;
  method: "hasFlag" | "hasFlagStrict";
}
const UNITS_KEYS: readonly string[] = [FLAG_V1, FLAG_PRICES_V2, FLAG_SETTINGS];

export function makeTenantFlags() {
  const held = new Map<string, Set<string>>();
  const calls: DbFlagCall[] = [];
  // Every flag that is NOT one of the three units keys answers true, as the neighbouring DB specs do (hasFlag: true).
  const answer = (tenantId: string, flag: string): boolean =>
    UNITS_KEYS.includes(flag) ? !!held.get(tenantId)?.has(flag) : true;
  const entitlements: Record<string, unknown> = {
    hasFlag: async (tenantId: string, flag: string) => {
      calls.push({ tenantId, flag, method: "hasFlag" });
      return answer(tenantId, flag);
    },
  };
  const strictFn = async (tenantId: string, flag: string) => {
    calls.push({ tenantId, flag, method: "hasFlagStrict" });
    return answer(tenantId, flag);
  };
  entitlements.hasFlagStrict = strictFn;
  return {
    entitlements,
    calls,
    /** Give a tenant exactly these units keys. */
    grant: (tenantId: string, keys: readonly string[]) => held.set(tenantId, new Set(keys)),
    /** The dead stub (plan R1): drop hasFlagStrict, so loadUnitsPricesV2 returns null before the flag is read. */
    setStrict: (on: boolean) => {
      if (on) entitlements.hasFlagStrict = strictFn;
      else delete entitlements.hasFlagStrict;
    },
    consulted: (tenantId: string, from: number): Consulted => {
      const mine = calls.slice(from).filter((c) => c.tenantId === tenantId);
      return {
        units_v1: mine.filter((c) => c.flag === FLAG_V1).length,
        units_prices_v2: mine.filter((c) => c.flag === FLAG_PRICES_V2).length,
        units_settings_v1: mine.filter((c) => c.flag === FLAG_SETTINGS).length,
        strict: mine.filter((c) => c.method === "hasFlagStrict").length,
        plain: mine.filter((c) => c.method === "hasFlag").length,
      };
    },
  };
}
export type TenantFlags = ReturnType<typeof makeTenantFlags>;

// ─── the real OrdersService over Postgres ──────────────────────────────────────────────────────────────────────────
/** Unknown collaborators answer every method with a no-op (never `then`). */
const noop = new Proxy(
  {},
  {
    get: (_t, prop) =>
      prop === "then" || typeof prop === "symbol" ? undefined : async () => undefined,
  },
);

export interface PromoRule {
  id: string;
  type: "PERCENT" | "BUY_N_GET_M" | "FIXED" | "QTY_BREAK";
  value: number;
  minQty: number | null;
}
const catalogPromo = (p: PromoRule) => ({
  id: p.id,
  name: `promo ${p.id}`,
  bannerText: null,
  type: p.type,
  value: p.value,
  minQty: p.minQty,
  scope: "ALL",
  category: null,
  startsAt: new Date(Date.now() - 86_400_000),
  endsAt: new Date(Date.now() + 86_400_000),
  productIds: [],
});

export interface FoldWorldDeps {
  prisma: PrismaService;
  tenantCtx: TenantContextService;
  systemConfig: unknown;
  flags: TenantFlags;
}
/** `promos` is read on every create(): a spec swaps the list for one cell and restores it. */
export function makeFoldOrders(d: FoldWorldDeps, promos: { current: PromoRule[] }): OrdersService {
  return Object.assign(Object.create(OrdersService.prototype), {
    prisma: d.prisma,
    tenantCtx: d.tenantCtx,
    systemConfig: d.systemConfig,
    entitlements: d.flags.entitlements,
    gateway: noop,
    notifications: noop,
    messaging: noop,
    commissionEngine: noop,
    inventoryService: noop,
    ledger: noop,
    invoicesService: noop,
    creditNotes: noop,
    sellingRestrictions: {
      assertLinesSellable: async () => undefined,
      checkLinesSellable: async () => ({ outcome: "OFF", reasons: [] }),
      getPolicy: async () => ({ enabled: false }),
    },
    authGuard: {
      assertAuthorizedOrThrow: async () => undefined,
      checkAuthorized: async () => ({ blocked: [] }),
    },
    promotionsService: { activeForCatalog: async () => promos.current.map(catalogPromo) },
    oversellReader: { read: async () => "off" },
    logger: new Logger(OrdersService.name),
  }) as OrdersService;
}

// ─── shapes and customers (one table, seeded identically into every tenant) ────────────────────────────────────────
/** Regulated twins carrying a Case row, so E1's tax column has a piece-count-driven levy (plan §4). */
const REG = { trackedCategoryId: REGULATED.id, trackedSubcategoryId: "sub-reg" };
export const DB_SHAPES: Record<string, Shape> = {
  ...SHAPES,
  "LADC-reg": {
    ...SHAPES.LADC,
    id: "LADC-reg",
    product: { ...SHAPES.LADC.product, id: "p-ladc-reg", ...REG },
    category: REGULATED,
  },
  "LADP-reg": {
    ...SHAPES.LADP,
    id: "LADP-reg",
    product: { ...SHAPES.LADP.product, id: "p-ladp-reg", ...REG },
    category: REGULATED,
  },
};
export const dbShape = (id: string): Shape => DB_SHAPES[id];

const ALL_P = Object.values(DB_SHAPES).map((s) => s.product.id);
const everyProduct = (pricingTier: number | null) =>
  ALL_P.map((productId) => ({ productId, pricingTier }));

/** Every customer the cells use. Junk tiers (7, 0) exist only in the DB: no API writer can make them (SA-996 E2). */
export const FOLD_CUSTOMERS: Record<string, CustomerRow> = {
  C1: customerOf("C1", 1),
  C3: customerOf("C3", 1, { cp: everyProduct(3) }),
  // a typed pack price on the full-ladder shape (PC-1; a {v1,v2} holder's data)
  CT: customerOf("CT", 1, { typed: [{ productId: "p-lad", unitRef: "pack", price: "9.50" }] }),
  // E2: a tier outside 1-5 on the customer, or on its CustomerPrice row
  E1: customerOf("E1", 7),
  E2: customerOf("E2", 0),
  E3: customerOf("E3", 3, { cp: [{ productId: "p-b12", pricingTier: 7 }] }),
  E4: customerOf("E4", 2, { cp: [{ productId: "p-b12", pricingTier: 0 }] }),
  // the repair twins (SA-996 E2): the junk replaced by 1, never null
  E1R: customerOf("E1R", 1),
  E2R: customerOf("E2R", 1),
  E3R: customerOf("E3R", 3, { cp: [{ productId: "p-b12", pricingTier: 1 }] }),
  E4R: customerOf("E4R", 2, { cp: [{ productId: "p-b12", pricingTier: 1 }] }),
};

export interface FoldTenant {
  id: string;
  slug: string;
  label: string;
  operator: JwtPayload;
  /** shape id -> product id */
  products: Record<string, string>;
  /** customer key -> ids */
  customers: Record<string, { customerId: string; userId: string }>;
}

const money = (v: string | null) => (v === null ? null : v);

/**
 * ONE seeder for every tenant: the same shapes, the same ladders, the same customers, the same settings, so that the
 * ONLY thing a pair of tenants differs in is the key set the stub grants them.
 */
export async function seedFoldTenant(
  raw: PrismaClient,
  slug: string,
  label: string,
): Promise<FoldTenant> {
  const tenant = await raw.tenant.create({ data: { slug, name: `fold ${slug}` } });
  const tenantId = tenant.id;
  await raw.tenantConfig.create({ data: { tenantId, timezone: "America/New_York" } });
  await raw.systemConfig.create({ data: { tenantId, key: "settings.taxRate", value: "8.25" } });
  const mkUser = async (role: "OPERATOR" | "CUSTOMER", tag: string) =>
    (
      await raw.user.create({
        data: { email: `${tag}-${slug}@example.test`, username: `${tag}-${slug}`, role, tenantId },
      })
    ).id;
  const operatorId = await mkUser("OPERATOR", "op");
  const category = await raw.trackedCategory.create({
    data: {
      tenantId,
      name: `reg ${slug}`,
      taxType: REGULATED.taxType as never,
      rate: Number(REGULATED.rate).toString(),
      priceIncludesTax: REGULATED.priceIncludesTax,
    },
  });
  const products: Record<string, string> = {};
  const byKitId: Record<string, string> = {};
  for (const shape of Object.values(DB_SHAPES)) {
    const spec = shape.product;
    const row = await raw.product.create({
      data: {
        tenantId,
        name: `${shape.id} ${slug}`,
        unit: spec.unit,
        unitsPerBox: spec.unitsPerBox,
        pricePerUnit: spec.pricePerUnit,
        priceTier2: money(spec.priceTier2),
        priceTier3: money(spec.priceTier3),
        priceTier4: money(spec.priceTier4),
        priceTier5: money(spec.priceTier5),
        currentStock: "100000",
        trackedCategoryId: spec.trackedCategoryId ? category.id : null,
      } as never,
    });
    products[shape.id] = row.id;
    byKitId[spec.id] = row.id;
    for (const u of shape.units) {
      await raw.productUnit.create({
        data: {
          tenantId,
          productId: row.id,
          label: u.label,
          factorToBase: u.factorToBase,
          price: u.price,
          priceTier2: u.priceTier2,
          priceTier3: u.priceTier3,
          priceTier4: u.priceTier4,
          priceTier5: u.priceTier5,
        } as never,
      });
    }
  }
  const customers: FoldTenant["customers"] = {};
  for (const [key, c] of Object.entries(FOLD_CUSTOMERS)) {
    const userId = await mkUser("CUSTOMER", key.toLowerCase());
    const customer = await raw.customer.create({
      data: {
        userId,
        businessName: `Acme ${key}`,
        contactName: "T",
        tenantId,
        pricingTier: c.pricingTier === null ? 1 : c.pricingTier,
      },
    });
    customers[key] = { customerId: customer.id, userId };
    for (const r of c.cp) {
      await raw.customerPrice.create({
        data: {
          tenantId,
          customerId: customer.id,
          productId: byKitId[r.productId],
          pricingTier: r.pricingTier,
          orderUnitRef: r.orderUnitRef ?? null,
        },
      });
    }
    for (const t of c.typed ?? []) {
      await raw.customerUnitPrice.create({
        data: {
          tenantId,
          customerId: customer.id,
          productId: byKitId[t.productId],
          unitRef: t.unitRef,
          price: t.price,
        },
      });
    }
  }
  return {
    id: tenantId,
    slug,
    label,
    operator: {
      sub: operatorId,
      username: `op-${slug}`,
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    } as JwtPayload,
    products,
    customers,
  };
}

/** Deletes everything the seeder and the cells made, children first; a failed delete never masks a test result. */
export async function cleanupFoldTenants(raw: PrismaClient, tenantIds: string[]): Promise<void> {
  const swallow = () => undefined;
  const where = { where: { tenantId: { in: tenantIds } } };
  await raw.orderItem.deleteMany(where).catch(swallow);
  await raw.order.deleteMany(where).catch(swallow);
  await raw.stockMovement
    .deleteMany({ where: { product: { tenantId: { in: tenantIds } } } })
    .catch(swallow);
  await raw.auditLog.deleteMany(where).catch(swallow);
  await raw.customerUnitPrice.deleteMany(where).catch(swallow);
  await raw.customerPrice.deleteMany(where).catch(swallow);
  await raw.productUnit.deleteMany(where).catch(swallow);
  await raw.product.deleteMany(where).catch(swallow);
  await raw.trackedCategory.deleteMany(where).catch(swallow);
  await raw.customer.deleteMany(where).catch(swallow);
  await raw.systemConfig.deleteMany(where).catch(swallow);
  await raw.tenantConfig.deleteMany(where).catch(swallow);
  await raw.user.deleteMany(where).catch(swallow);
  await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(swallow);
}

// ─── what a created document looks like ────────────────────────────────────────────────────────────────────────────
/** The stored line columns the cells compare, named as strings (this file only READS the stored line). */
const LINE_KEYS = [
  "qty",
  "boxes",
  "pieces",
  "unitsPerBox",
  "unitLabel",
  "unitPrice",
  "priceType",
  "originalPrice",
  "promoFreeUnits",
  "subtotal",
  "categoryTaxAmount",
  "categoryTaxType",
  "categoryTaxRate",
] as const;
const plain = (v: unknown): unknown =>
  v !== null && typeof v === "object" && "toNumber" in (v as object)
    ? (v as { toNumber(): number }).toNumber()
    : v;

export interface DocRun extends LineRun {
  orderId: string | null;
}
export type Mode = "staff" | "buyer" | "counter";
export interface DocLine extends LineReq {
  shape: string;
}
export interface DocArgs {
  tenant: FoldTenant;
  customer: string;
  line: DocLine;
  mode?: Mode;
}

export interface FoldWorld {
  raw: PrismaClient;
  prisma: PrismaService;
  tenantCtx: TenantContextService;
  flags: TenantFlags;
  orders: OrdersService;
}

/**
 * Creates ONE single-line order through the real `create()` and reads back what it stored and moved. A refused create
 * is a figure too (`fig.error`), as in the readers kit.
 */
export async function createDoc(w: FoldWorld, a: DocArgs): Promise<DocRun> {
  const mode = a.mode ?? "staff";
  const t = a.tenant;
  const { shape, ...req } = a.line;
  const productId = t.products[shape];
  const item = { productId, ...req };
  const from = w.flags.calls.length;
  const stockBefore = Number(
    (await w.raw.product.findUniqueOrThrow({ where: { id: productId } })).currentStock,
  );
  const customer = t.customers[a.customer];
  const buyer = {
    sub: customer.userId,
    username: `buyer-${t.slug}`,
    role: "CUSTOMER",
    status: "ACTIVE",
    forcePasswordChange: false,
    tenantId: t.id,
    tenantSlug: t.slug,
    type: "BUYER",
  } as unknown as JwtPayload;
  try {
    const created = (await w.tenantCtx.run(t.id, () =>
      w.orders.create(
        (mode === "buyer"
          ? { items: [item], status: "PENDING" }
          : { customerId: customer.customerId, items: [item] }) as never,
        mode === "buyer" ? buyer : t.operator,
        mode === "counter" ? { counterSale: true, skipAutoMerge: true } : { skipAutoMerge: true },
      ),
    )) as { id: string };
    const order = await w.raw.order.findUniqueOrThrow({ where: { id: created.id } });
    const lines = await w.raw.orderItem.findMany({
      where: { orderId: created.id },
      orderBy: { createdAt: "asc" },
    });
    const stored = lines[0] as unknown as Record<string, unknown>;
    const fig: Fig = Object.fromEntries(LINE_KEYS.map((k) => [k, plain(stored[k])]));
    const stockAfter = Number(
      (await w.raw.product.findUniqueOrThrow({ where: { id: productId } })).currentStock,
    );
    const sales = await w.raw.stockMovement.findMany({
      where: { productId, reference: { contains: created.id } },
    });
    Object.assign(fig, {
      lineCount: lines.length,
      headerSubtotal: Number(order.subtotal),
      headerTax: Number(order.tax),
      headerTotal: Number(order.total),
      stockPieces: stockBefore - stockAfter,
      saleMovements: sales.length,
      printedQty: invoiceLineQtyText({
        qty: Number(stored.qty),
        boxes: stored.boxes as number | null,
        pieces: stored.pieces as number | null,
        unitsPerBox: stored.unitsPerBox as number | null,
        unitLabel: stored.unitLabel as string | null,
      } as never),
    });
    return { orderId: created.id, fig, consulted: w.flags.consulted(t.id, from) };
  } catch (e) {
    const err = e as Error;
    return {
      orderId: null,
      fig: { error: `${err.constructor.name}: ${err.message}` },
      consulted: w.flags.consulted(t.id, from),
    };
  }
}

/** Line forms of plan §3: qty, the box/piece split, pieces only; N-* run qty only (plus boxes:1 on N-1, the web sends it). */
export const boxedShape = (id: string): boolean => {
  const { unitsPerBox: pack } = dbShape(id).product;
  return Number(pack ?? 0) > 1;
};
export const formsOf = (id: string): Record<string, LineReq> => {
  if (boxedShape(id))
    return { qty3: { qty: 3 }, split: { boxes: 1, pieces: 3 }, pieces5: { pieces: 5 } };
  if (id === "N-1") return { qty3: { qty: 3 }, boxes1: { qty: 4, boxes: 1 } };
  return { qty3: { qty: 3 } };
};
