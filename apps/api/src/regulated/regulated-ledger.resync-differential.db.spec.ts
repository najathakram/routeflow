/**
 * B297 PR4a, SA-819 call 1 (a): a DIFFERENTIAL spec for the changed-only re-sync inside `settleInvoiceBilled`.
 *
 * Each scenario builds the same fixture TWICE (invoice A and invoice B, same lines, same SALE rows, same
 * documents against them). On A it runs MASTER's old path: the dead-document sweep, `reverseInvoiceEntries`
 * with `preserveReturns: true` (reverse every held line), then `writeSaleEntries` (book every target line
 * fresh). On B it runs THE PR's path: `settleRegulatedLedger({ kind: "INVOICE_BILLED" })` (`syncInvoiceEntries`,
 * writing only what changed). It asserts the FULL net (qty, unitBasisQty, netSales, categoryTax) is equal per
 * line key AND per period bucket, so the PR cannot move a figure that master's rewrite would have kept.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * SAFETY: a throwaway `qa-b297d-<run>` tenant (`assertTestTenant`); `afterAll` deletes exactly the rows this
 * run created, in FK order. NOT run on the MacBook (no Postgres): the Windows DB lane runs it.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RegulatedLedgerService, type SaleLedgerLine } from "./regulated-ledger.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

/** One line of a fixture, by LABEL (item ids differ between the two copies). */
interface LineSpec {
  label: string;
  qty: number;
  net: number;
  tax: number;
  boxes?: number;
  pieces?: number;
  unitsPerBox?: number;
}
interface Copy {
  invoiceId: string;
  orderId: string;
  productId: string;
  /** label -> ids */
  items: Map<string, { invoiceItemId: string; orderItemId: string }>;
  specs: LineSpec[];
}
interface Net {
  qty: number;
  unitBasisQty: number;
  net: number;
  tax: number;
}

const SOLD_AT = new Date("2026-09-10T00:00:00Z"); // an earlier period than "now", so per-bucket sums mean something
const r3 = (n: number) => Math.round(n * 1000) / 1000;

describeDb(
  "Real-Postgres: the changed-only re-sync nets exactly what master's rewrite did (B297 PR4a)",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let ledger: RegulatedLedgerService;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(
      `qa-b297d-${run}`,
      "regulated-ledger.resync-differential.db.spec.ts",
    );
    let tenantId = "";
    let categoryId = "";
    let subcategoryId = "";
    let customerId = "";
    let seq = 0;
    const orderIds: string[] = [];
    const invoiceIds: string[] = [];
    const productIds: string[] = [];

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      ledger = new RegulatedLedgerService(prisma);
      tenantId = (await raw.tenant.create({ data: { slug, name: `B297d ${slug}` } })).id;
      categoryId = (
        await raw.trackedCategory.create({ data: { name: "Tobacco", taxType: "NONE", tenantId } })
      ).id;
      subcategoryId = (
        await raw.trackedSubcategory.create({
          data: { name: "Cigars", trackedCategoryId: categoryId, tenantId },
        })
      ).id;
      const custUser = await raw.user.create({
        data: {
          email: `cust-${run}@example.test`,
          username: `cust-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      customerId = (
        await raw.customer.create({
          data: {
            userId: custUser.id,
            businessName: "Acme Retail",
            contactName: "Acme Retail",
            tenantId,
          },
        })
      ).id;
    }, 120_000);

    afterAll(async () => {
      await raw.auditLog.deleteMany({ where: { tenantId } });
      await raw.regulatedSalesLedger.deleteMany({ where: { tenantId } });
      await raw.creditNoteItem.deleteMany({ where: { tenantId } });
      await raw.creditNote.deleteMany({ where: { tenantId } });
      for (const orderId of orderIds) await raw.return.deleteMany({ where: { orderId } });
      await raw.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
      await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.order.deleteMany({ where: { id: { in: orderIds } } });
      await raw.product.deleteMany({ where: { id: { in: productIds } } });
      await raw.customer.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({ where: { tenantId } });
      await raw.trackedSubcategory.deleteMany({ where: { tenantId } });
      await raw.trackedCategory.deleteMany({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    const inTenant = <T>(fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
    const db = () => prisma.forTenant();

    /** Build one copy: order + invoice + items, with each line's SALE booked by the real `writeSaleEntries`. */
    async function makeCopy(tag: string, specs: LineSpec[]): Promise<Copy> {
      const n = ++seq;
      const product = await raw.product.create({
        data: {
          name: `b297d ${tag} ${n}`,
          unit: "pack",
          pricePerUnit: "1.00",
          trackedCategoryId: categoryId,
          tenantId,
        },
      });
      productIds.push(product.id);
      const order = await raw.order.create({
        data: { customerId, status: "DELIVERED", subtotal: "1", total: "1", tenantId },
      });
      orderIds.push(order.id);
      const invoice = await raw.invoice.create({
        data: {
          invoiceNumber: `INV-B297D-${run}-${n}`,
          customerId,
          orderId: order.id,
          status: "SENT",
          subtotal: "1",
          taxAmount: "0",
          total: "1",
          tenantId,
        },
      });
      invoiceIds.push(invoice.id);
      const items = new Map<string, { invoiceItemId: string; orderItemId: string }>();
      const lines: SaleLedgerLine[] = [];
      for (const s of specs) {
        const orderItem = await raw.orderItem.create({
          data: {
            orderId: order.id,
            productId: product.id,
            status: "DELIVERED",
            qty: s.qty,
            deliveredQty: s.qty,
            boxes: s.boxes ?? null,
            pieces: s.pieces ?? null,
            unitsPerBox: s.unitsPerBox ?? null,
            unitPrice: "1.00",
            subtotal: String(s.net),
            trackedCategoryId: categoryId,
            tenantId,
          },
        });
        const item = await raw.invoiceItem.create({
          data: {
            invoiceId: invoice.id,
            description: `b297d ${s.label}`,
            productId: product.id,
            orderItemId: orderItem.id,
            qty: s.qty,
            unitPrice: "1.00",
            subtotal: String(s.net),
            trackedCategoryId: categoryId,
            tenantId,
          },
        });
        items.set(s.label, { invoiceItemId: item.id, orderItemId: orderItem.id });
        lines.push(
          lineFor(
            { invoiceId: invoice.id, orderId: order.id, productId: product.id, items, specs },
            s,
          ),
        );
      }
      await inTenant(() =>
        ledger.writeSaleEntries({
          tenantId,
          orderId: order.id,
          invoiceId: invoice.id,
          soldAt: SOLD_AT,
          lines,
          db: db(),
        }),
      );
      return { invoiceId: invoice.id, orderId: order.id, productId: product.id, items, specs };
    }

    function lineFor(
      c: Copy,
      s: LineSpec,
      over: Partial<SaleLedgerLine> & Partial<LineSpec> = {},
    ): SaleLedgerLine {
      const ids = c.items.get(s.label)!;
      const m = { ...s, ...over };
      return {
        invoiceItemId: ids.invoiceItemId,
        orderItemId: ids.orderItemId,
        trackedCategoryId: categoryId,
        trackedSubcategoryId: over.trackedSubcategoryId ?? null,
        qty: m.qty,
        boxes: m.boxes ?? null,
        pieces: m.pieces ?? null,
        unitsPerBox: m.unitsPerBox ?? null,
        packAtSale: m.unitsPerBox ?? null,
        netSales: m.net,
        categoryTax: m.tax,
      };
    }
    const targetLines = (
      c: Copy,
      over: Record<string, Partial<SaleLedgerLine> & Partial<LineSpec>> = {},
    ) =>
      c.specs
        .filter((s) => !(s.label in over && (over[s.label] as any).__removed))
        .map((s) => lineFor(c, s, over[s.label] ?? {}));

    const receiveReturn = async (
      c: Copy,
      pieces: number,
      unit: "LINE_UNIT" | "PIECES" = "LINE_UNIT",
    ) => {
      const ret = await raw.return.create({
        data: {
          orderId: c.orderId,
          customerId,
          reason: "EXCESS_ORDER",
          status: "RECEIVED",
          tenantId,
        },
      });
      await inTenant(() =>
        ledger.reverseReturnEntries({
          returnId: ret.id,
          orderId: c.orderId,
          returnedByProduct: new Map([[c.productId, pieces]]),
          returnedUnit: unit,
          db: db(),
        }),
      );
      return ret;
    };

    /** MASTER's old path: the sweep, reverse every held line (returns left standing), book every target fresh. */
    const masterResync = (c: Copy, lines: SaleLedgerLine[]) =>
      inTenant(async () => {
        const l: any = ledger;
        await l.counterDeadDocuments(db(), c.invoiceId);
        await l.reverseInvoiceEntries({ invoiceId: c.invoiceId, db: db(), preserveReturns: true });
        await ledger.writeSaleEntries({
          tenantId,
          orderId: c.orderId,
          invoiceId: c.invoiceId,
          soldAt: new Date(),
          lines,
          db: db(),
        });
      });
    /** THE PR's path. Returns the rows it appended. */
    const prResync = (c: Copy, lines: SaleLedgerLine[]) =>
      inTenant(
        async () =>
          (
            await ledger.settleRegulatedLedger(db(), {
              kind: "INVOICE_BILLED",
              invoiceId: c.invoiceId,
              orderId: c.orderId,
              tenantId,
              lines,
            })
          ).written,
      );

    const zero = (): Net => ({ qty: 0, unitBasisQty: 0, net: 0, tax: 0 });
    const add = (a: Net, r: any): Net => ({
      qty: r3(a.qty + Number(r.qty)),
      unitBasisQty: r3(a.unitBasisQty + Number(r.unitBasisQty)),
      net: Math.round((a.net + Number(r.netSales)) * 100) / 100,
      tax: Math.round((a.tax + Number(r.categoryTax)) * 100) / 100,
    });
    /** Net per line key (label | subcategory | category) and per period bucket. */
    async function nets(c: Copy) {
      const labelOf = new Map([...c.items].map(([label, ids]) => [ids.invoiceItemId, label]));
      const rows = await raw.regulatedSalesLedger.findMany({ where: { invoiceId: c.invoiceId } });
      const byKey: Record<string, Net> = {};
      const byBucket: Record<string, Net> = {};
      for (const r of rows) {
        const key = `${labelOf.get(r.invoiceItemId ?? "") ?? "?"}|${r.trackedSubcategoryId ?? ""}|${r.trackedCategoryId ?? ""}`;
        byKey[key] = add(byKey[key] ?? zero(), r);
        byBucket[r.periodBucket] = add(byBucket[r.periodBucket] ?? zero(), r);
      }
      return { byKey, byBucket, rows: rows.length };
    }

    /** Run both paths on two identical copies, then compare. `prep` runs identically on each copy. */
    async function differential(opts: {
      tag: string;
      specs: LineSpec[];
      prep?: (c: Copy) => Promise<void>;
      target: (c: Copy) => SaleLedgerLine[];
      expectPrWrites?: (written: number) => void;
    }) {
      const a = await makeCopy(`${opts.tag}-master`, opts.specs);
      const b = await makeCopy(`${opts.tag}-pr`, opts.specs);
      if (opts.prep) {
        await opts.prep(a);
        await opts.prep(b);
      }
      await masterResync(a, opts.target(a));
      const written = await prResync(b, opts.target(b));
      const na = await nets(a);
      const nb = await nets(b);
      expect(nb.byKey).toEqual(na.byKey);
      expect(nb.byBucket).toEqual(na.byBucket);
      opts.expectPrWrites?.(written);
      return { master: na, pr: nb, written };
    }

    const ONE: LineSpec[] = [{ label: "L1", qty: 10, net: 100, tax: 20 }];
    const TWO: LineSpec[] = [
      { label: "L1", qty: 10, net: 100, tax: 20 },
      { label: "L2", qty: 4, net: 40, tax: 8 },
    ];
    const same = (c: Copy) => targetLines(c);

    it("an unchanged invoice with a live return: same net, and the PR writes 0 rows", async () => {
      const { pr } = await differential({
        tag: "live-return",
        specs: ONE,
        prep: async (c) => void (await receiveReturn(c, 3)),
        target: same,
        expectPrWrites: (w) => expect(w).toBe(0),
      });
      expect(Object.values(pr.byKey)[0]).toEqual({ qty: 7, unitBasisQty: 7, net: 70, tax: 14 });
    }, 120_000);

    it("a cancelled return: same net (the counter-entry stands, nothing is re-billed)", async () => {
      await differential({
        tag: "cancelled-return",
        specs: ONE,
        prep: async (c) => {
          const ret = await receiveReturn(c, 3);
          await raw.return.update({ where: { id: ret.id }, data: { status: "CANCELLED" } });
          await inTenant(() =>
            ledger.settleRegulatedLedger(db(), { kind: "ADJUSTMENT_UNDONE", returnId: ret.id }),
          );
        },
        target: same,
      });
    }, 120_000);

    it("an undone credit on a live invoice: same net", async () => {
      await differential({
        tag: "undone-credit",
        specs: ONE,
        prep: async (c) => {
          const ids = c.items.get("L1")!;
          const cn = await raw.creditNote.create({
            data: {
              creditNoteNumber: `CN-B297D-${run}-${++seq}`,
              customerId,
              invoiceId: c.invoiceId,
              amount: "20",
              tenantId,
            },
          });
          await raw.creditNoteItem.create({
            data: {
              tenantId,
              creditNoteId: cn.id,
              invoiceItemId: ids.invoiceItemId,
              trackedCategoryId: categoryId,
              amount: "20",
              qty: 2,
              categoryTax: "4",
            },
          });
          await inTenant(() => ledger.reverseCreditNoteEntries({ creditNoteId: cn.id, db: db() }));
          await raw.creditNote.update({ where: { id: cn.id }, data: { status: "VOID" } });
          await inTenant(() =>
            ledger.settleRegulatedLedger(db(), { kind: "ADJUSTMENT_UNDONE", creditNoteId: cn.id }),
          );
        },
        target: same,
      });
    }, 120_000);

    it("void then unvoid with a live return: same net; the PR writes a REVERSAL of the residue plus the SALE (SA-819 call 1d)", async () => {
      const { pr, written } = await differential({
        tag: "void-unvoid",
        specs: ONE,
        prep: async (c) => {
          await receiveReturn(c, 3);
          await raw.invoice.update({ where: { id: c.invoiceId }, data: { status: "VOID" } });
          await inTenant(() =>
            ledger.settleRegulatedLedger(db(), { kind: "INVOICE_ZEROED", invoiceId: c.invoiceId }),
          );
          await raw.invoice.update({ where: { id: c.invoiceId }, data: { status: "DRAFT" } });
        },
        target: same,
      });
      // not "every line is square": the void reversed only sold - returned, so the line holds the returned 3
      expect(written).toBe(2);
      expect(Object.values(pr.byKey)[0]).toEqual({ qty: 7, unitBasisQty: 7, net: 70, tax: 14 });
    }, 120_000);

    it("a price change on a returned line: same net", async () => {
      await differential({
        tag: "price-change",
        specs: ONE,
        prep: async (c) => void (await receiveReturn(c, 3)),
        target: (c) => targetLines(c, { L1: { net: 120, tax: 24 } }),
      });
    }, 120_000);

    it("a subcategory re-file: same net per (line, subcategory) key", async () => {
      await differential({
        tag: "refile",
        specs: ONE,
        prep: async (c) => void (await receiveReturn(c, 3)),
        target: (c) => targetLines(c, { L1: { trackedSubcategoryId: subcategoryId } }),
      });
    }, 120_000);

    it("a removed line: same net", async () => {
      await differential({
        tag: "removed",
        specs: TWO,
        target: (c) => targetLines(c, { L2: { __removed: true } as any }),
      });
    }, 120_000);

    it("a boxed line (2 boxes of 12 + 3 pieces) with a returned 5 pieces, then 6 loose pieces: same net", async () => {
      await differential({
        tag: "boxed",
        specs: [{ label: "L1", qty: 27, net: 270, tax: 54, boxes: 2, pieces: 3, unitsPerBox: 12 }],
        prep: async (c) => void (await receiveReturn(c, 5, "PIECES")),
        target: (c) => targetLines(c, { L1: { qty: 30, net: 300, tax: 60, pieces: 6 } }),
      });
    }, 120_000);
  },
);
