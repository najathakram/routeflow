/**
 * SA-078(b) (Senior Architect ruling 2026-09-22, on top of B700/#1237). B700 made
 * `toSaleLedgerLines` prefer an InvoiceItem's own `unitsPerBox` snapshot over the live
 * product -- correct, but on the RECONCILE path (`rebuildSiblingDrafts`, called by
 * `reconcileOrderDeliveredInvoices` / `reconcileSplitOrderDrafts`, and
 * `reconcileOrderDraftInvoice`'s single-draft branch) the "snapshot" `buildInvoiceItemData`
 * writes is REBUILT from scratch every time: `li.unitsPerBox ?? li.product?.unitsPerBox ?? 0`
 * (invoices.service.ts ~859). A box-unaware order line stores no `unitsPerBox` of its own
 * (orders.service.ts ~2129 -- the qty axis carries the unit), so that expression falls
 * through to `li.product?.unitsPerBox`: TODAY's live pack. B700's own
 * `pack-at-sale.spec.ts:48` fixture hands `toSaleLedgerLines` an item that ALREADY carries a
 * pack of 12 -- an input the real reconcile path never produces for a box-unaware line, which
 * is why it went green while this defect shipped.
 *
 * This spec drives the ACTUAL reconcile method (`reconcileOrderDeliveredInvoices`), not
 * `toSaleLedgerLines` directly, so it cannot be fooled the same way. Scenario: a standing
 * order line sold at a live pack of 12 (its prior InvoiceItem's own `unitsPerBox` is 12); the
 * product is repacked to 24; a delivery reconcile rebuilds the invoice. Before the fix, the
 * rebuilt item -- and the regulated ledger line built from it -- silently re-book at 24.
 */

// Prevent Jest from traversing ESM-only dependencies (mirrors invoices.service.spec.ts).
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { readFileSync } from "fs";
import { join } from "path";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { NumberingService } from "../import/numbering.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { StorageService } from "../storage/storage.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { InvoiceStatus } from "@prisma/client";
import { RESYNC_ITEM_SELECT } from "./resync-plan";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

describe("SA-078(b) — reconcile rebuild carries the PRIOR InvoiceItem's unitsPerBox forward, never the live product", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let writeSaleEntries: jest.Mock;

  const mockNumbering = {
    reserveNext: jest.fn().mockResolvedValue("INV-2026-0001"),
    reserveNextTx: jest.fn().mockResolvedValue("INV-2026-0001"),
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    writeSaleEntries = jest.fn().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
        {
          provide: EmailService,
          useValue: { sendInvoice: jest.fn(), isEmailConfigured: jest.fn() },
        },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn(), set: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: {
            writeSaleEntries,
            reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        {
          provide: CreditNotesService,
          useValue: {
            autoApplyOldestCreditsInTx: jest
              .fn()
              .mockResolvedValue({ applied: 0, invoiceStatus: null }),
            settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
            releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
          },
        },
        { provide: MessagingService, useValue: { notify: jest.fn(), notifyEvent: jest.fn() } },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), presignedUrl: jest.fn(), delete: jest.fn() },
        },
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  // The order: ONE box-unaware regulated line (no unitsPerBox of its own -- the order
  // line's qty axis carries the unit), sold as 5 (boxes) delivered in full, originally at
  // pack 12 (its PRIOR InvoiceItem carries unitsPerBox: 12). The product is NOW repacked
  // to 24 -- what a live re-read would wrongly use.
  const order = {
    id: "o1",
    customerId: "c1",
    subtotal: 100,
    tax: 0,
    lineItems: [
      {
        id: "li1",
        productId: "p1",
        qty: 5,
        deliveredQty: 5,
        unitPrice: 20,
        originalPrice: null,
        priceType: "STANDARD",
        unitsPerBox: null, // box-unaware order line -- see orders.service.ts ~2129
        trackedCategoryId: "cat-tobacco",
        product: { name: "P1", unitsPerBox: 24 }, // REPACKED since the original sale
        status: "PENDING",
      },
    ],
  };

  const draftInvoice = {
    id: "d1",
    status: InvoiceStatus.DRAFT,
    deliveryBatchId: null,
    discount: 0,
    shippingFee: 0,
  };

  function armDeliveredReconcile() {
    // The order's live, non-VOID invoices -- ONE open draft whose CURRENT item (about to
    // be deleted and recreated) carries the ORIGINAL sale's own pack snapshot, 12.
    prisma.invoice.findMany.mockResolvedValue([
      { ...draftInvoice, items: [{ orderItemId: "li1", unitsPerBox: 12 }] },
    ]);
    prisma.order.findUnique.mockResolvedValue(order);
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
    prisma.invoiceItem.deleteMany.mockResolvedValue({});
    // Echo back whatever this code actually tries to create, so the ledger-facing
    // assertion below proves the REAL created item's own field, not a fixture's.
    prisma.invoice.update.mockImplementation((args: any) =>
      Promise.resolve({ id: "d1", items: args.data.items.create }),
    );
    prisma.orderItem.update.mockResolvedValue({});
    prisma.product.findMany.mockResolvedValue([{ id: "p1", unitsPerBox: 24 }]); // packAtSaleByProduct's live read
  }

  it("RED-FIRST (observe, do not predict): reports the rebuilt item's unitsPerBox and the ledger line's packAtSale as actually produced", async () => {
    armDeliveredReconcile();
    await service.reconcileOrderDeliveredInvoices("o1");

    const createdItem = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
    const ledgerLine = writeSaleEntries.mock.calls[0][0].lines[0];
    // No expect() here on purpose -- this case exists to print what the CURRENT code
    // actually does, per SA-078(b)'s "observe, do not predict." See the PR body for the
    // captured numbers from this run.
    // eslint-disable-next-line no-console
    console.log("SA-078(b) OBSERVED:", {
      createdItemUnitsPerBox: createdItem.unitsPerBox,
      ledgerLinePackAtSale: ledgerLine.packAtSale,
      ledgerLineQty: ledgerLine.qty,
    });
  });

  it("the rebuilt item carries the PRIOR snapshot (12), not the live repacked product (24)", async () => {
    armDeliveredReconcile();
    await service.reconcileOrderDeliveredInvoices("o1");

    const createdItem = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
    expect(createdItem.unitsPerBox).toBe(12);
  });

  it("the regulated ledger line built from the rebuilt item also carries pack 12 -- qty 5 books unitBasisQty 60, not 120", async () => {
    armDeliveredReconcile();
    await service.reconcileOrderDeliveredInvoices("o1");

    const ledgerLine = writeSaleEntries.mock.calls[0][0].lines[0];
    expect(ledgerLine.packAtSale).toBe(12);
    // regulatedUnitBasis's box-unaware branch: qty * packAtSale.
    expect(ledgerLine.qty * (ledgerLine.packAtSale as number)).toBe(60);
  });

  // reconcileOrderDeliveredInvoices only ever rebuilds lines that already have SOME
  // provenance on an existing draft (it partitions by each draft's CURRENT items'
  // orderItemId) -- a line with no prior InvoiceItem at all isn't reachable through it.
  // reconcileOrderDraftInvoice's single-draft branch is the one that rebuilds every
  // CURRENT order.lineItems regardless of prior provenance, so that's the real path for
  // this case.
  it("a GENUINELY NEW order line (no prior InvoiceItem) still snapshots the live pack (24) -- the fix never starves a first-time line of evidence", async () => {
    // reconcileSplitOrderDrafts (tried first) bails to the single-draft path below it
    // when there's only one open draft.
    prisma.invoice.findMany.mockResolvedValue([{ ...draftInvoice, items: [] }]);
    prisma.invoice.findFirst.mockResolvedValue({ id: "d1", discount: 0, shippingFee: 0 });
    prisma.invoiceItem.findMany.mockResolvedValue([]); // no prior items for this draft at all
    prisma.order.findUnique.mockResolvedValue(order);
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });
    prisma.invoiceItem.deleteMany.mockResolvedValue({});
    prisma.invoice.update.mockImplementation((args: any) =>
      Promise.resolve({ id: "d1", items: args.data.items.create }),
    );
    prisma.orderItem.findMany.mockResolvedValue([{ id: "li1" }]);
    prisma.orderItem.update.mockResolvedValue({});

    await service.reconcileOrderDraftInvoice("o1", { basis: "delivered" });
    const createdItem = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
    expect(createdItem.unitsPerBox).toBe(24);
  });

  // Second-review finding: rebuildIssuedDepositMirrorOnDelivery is a FOURTH caller of
  // the shared rebuildSiblingDrafts core (a prepaid order's mirror invoice, issued at
  // placement, has no open DRAFT for reconcileOrderDeliveredInvoices/
  // reconcileOrderDraftInvoice to find). Its own nonVoid query never selected `items`,
  // so `draft.items` was always undefined there -- the carried-pack map was always
  // empty on this ONE path, and the original defect still reproduced for deposit-mirror
  // orders after the first version of this fix. Private method -- called directly, the
  // same as this file's other tests drive the real rebuild code, not a hand-made item.
  describe("rebuildIssuedDepositMirrorOnDelivery (deposit-mirror orders, issued at placement)", () => {
    const mirrorInvoice = {
      id: "d1",
      status: InvoiceStatus.SENT,
      deliveryBatchId: null,
      depositPercent: 50,
      discount: 0,
      shippingFee: 0,
      dueDate: null,
      payments: [],
    };

    function armMirrorRebuild(priorItems: { orderItemId: string; unitsPerBox: number | null }[]) {
      prisma.invoice.findMany.mockResolvedValue([{ ...mirrorInvoice, items: priorItems }]);
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
      prisma.invoiceItem.deleteMany.mockResolvedValue({});
      prisma.invoice.update.mockImplementation((args: any) =>
        Promise.resolve({ id: "d1", items: args.data.items.create }),
      );
      prisma.orderItem.update.mockResolvedValue({});
    }

    it("carries the prior InvoiceItem's own pack (12), not the live repacked product (24)", async () => {
      armMirrorRebuild([{ orderItemId: "li1", unitsPerBox: 12 }]);
      await (service as any).rebuildIssuedDepositMirrorOnDelivery("o1", prisma);
      const createdItem = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
      expect(createdItem.unitsPerBox).toBe(12);
    });

    // This is the assertion that actually catches the second-review finding: a mock's
    // resolved value is whatever the test hands it, REGARDLESS of the real query's own
    // `select` -- reverting the source `select` clause does not change what a mocked
    // `findMany` returns here, so the test above alone cannot detect a missing field.
    // The genuine regression guard is on the QUERY SHAPE itself.
    //
    // B736: kept BESIDE the source-grep spec below, not replaced by it -- this checks
    // what's actually passed to prisma at RUNTIME for this one caller (the SA's #1257
    // PASS cited it as proven to discriminate, and a source-grep spec can't see a select
    // built through a variable or helper), while the source-grep spec below is what
    // extends the same discrimination to the other three callers B736 found blind.
    it("asks the nonVoid query for items.orderItemId/unitsPerBox -- without this, the carried-pack map is always empty on this path", async () => {
      armMirrorRebuild([{ orderItemId: "li1", unitsPerBox: 12 }]);
      await (service as any).rebuildIssuedDepositMirrorOnDelivery("o1", prisma);
      const queryArgs = prisma.invoice.findMany.mock.calls[0][0];
      expect(queryArgs.select.items).toEqual({
        select: { orderItemId: true, unitsPerBox: true },
      });
    });
  });
});

/**
 * B736 — coverage guard for the gap that bit #1257: `rebuildIssuedDepositMirrorOnDelivery`'s
 * invoice query never selected `items`, so `priorUnitsPerBoxMap(draft.items ?? [])` inside the
 * shared `rebuildSiblingDrafts` core silently saw an empty array and every rebuilt line lost its
 * prior pack snapshot. The ORIGINAL guard for this (the single "asks the nonVoid query for
 * items.orderItemId/unitsPerBox" test that used to live in the describe block above) covered
 * only that one, just-fixed caller — an assertion against a MOCK's return value (the value-level
 * tests above) stays green regardless of the real select clause, because the mock supplies
 * whatever shape the fixture hands it. This block replaces that single-caller query-shape
 * assertion with one that covers all FOUR callers of the shared core, via a SOURCE-TEXT pin
 * (the same class of check as `line-units-callsites.spec.ts`): it reads the real select clause
 * each caller sends, so reverting any one of their `select` blocks fails here regardless of what
 * any mock is arranged to return.
 *
 * Grepped `this.rebuildSiblingDrafts(` (the CONSUMING core's call sites), not the producing
 * `db.invoice.find*` call sites — grepping the producer is exactly how the fourth caller
 * (`reconcileSplitOrderDrafts`) was missed when #1257 was fixed: the fix touched the one caller
 * named in the bug report, not every caller of the function that actually needed the field.
 *
 * Every field checked below is read directly off `draft`/`pd.draft` inside `rebuildSiblingDrafts`
 * (invoices.service.ts): `items[].orderItemId` + `items[].unitsPerBox` (priorUnitsPerBoxMap),
 * `shippingFee` + `discount` (every call, sibling-fee placement + the total calc), and —
 * ONLY for a call that passes `preserveStatus: true` — `payments[].amount`/`.status`, `dueDate`,
 * `status` (the recomputeStatus branch). A caller that doesn't preserve status never reads those
 * three, so they are not required there.
 *
 * COUNT-PINNED at 4 (the number found on master at bc7b0ad9). A 5th caller must add its own
 * correct select AND bump this constant — that is the point: the ratchet only ever grows the
 * safety net, and a caller nobody re-checked here is a caller that fails loudly, not silently.
 */
describe("B736 — every rebuildSiblingDrafts caller selects the fields the core consumes", () => {
  const SERVICE_PATH = join(__dirname, "invoices.service.ts");
  const EXPECTED_CALL_COUNT = 4;

  function stripComments(s: string): string {
    return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  /** `openIdx` must point at an opening `{`. Returns the index of its matching `}`. */
  function matchBrace(text: string, openIdx: number): number {
    if (text[openIdx] !== "{") {
      throw new Error(
        `matchBrace: index ${openIdx} is not '{' (got ${JSON.stringify(text[openIdx])})`,
      );
    }
    let depth = 0;
    for (let i = openIdx; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) return i;
      }
    }
    throw new Error("matchBrace: unbalanced braces");
  }

  /** All indices of `this.rebuildSiblingDrafts(` in `text`, in source order. */
  function findCallSites(text: string): number[] {
    const sites: number[] = [];
    const needle = "this.rebuildSiblingDrafts(";
    let idx = text.indexOf(needle);
    while (idx !== -1) {
      sites.push(idx);
      idx = text.indexOf(needle, idx + needle.length);
    }
    return sites;
  }

  /** Every `\n  <modifiers> name(` class-method start (2-space class-body indent), as [index, name]. */
  function findMethodStarts(text: string): Array<{ index: number; name: string }> {
    const re = /\n {2}(?:private |public |protected )?(?:async )?([A-Za-z_$][\w$]*)\s*\(/g;
    const out: Array<{ index: number; name: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push({ index: m.index + 1, name: m[1] }); // +1: skip the leading \n captured by the regex
    }
    return out;
  }

  /** The full text of the call expression starting at `callStart` (up to its closing `)`). */
  function callExpressionText(text: string, callStart: number): string {
    const openParen = text.indexOf("(", callStart);
    let depth = 0;
    for (let i = openParen; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") {
        depth--;
        if (depth === 0) return text.slice(callStart, i + 1);
      }
    }
    throw new Error("callExpressionText: unbalanced parens");
  }

  /**
   * The invoice `select: {...}` block (balance-matched) belonging to the FIRST
   * `db.invoice.find*(` call inside `slice` — never "nearest preceding select", which would just
   * as happily match an unrelated `product: { select: {...} }` sitting between the invoice query
   * and the call site (the order/product select also legitimately contains `unitsPerBox`, so a
   * naive nearest-select scan would pass on the WRONG block).
   */
  function invoiceSelectBlock(slice: string): string {
    const queryMatch = slice.match(/db\.invoice\.find(?:Many|First|Unique)\(/);
    if (!queryMatch || queryMatch.index == null) {
      throw new Error("invoiceSelectBlock: no db.invoice.find*( call in this method's slice");
    }
    const afterQuery = slice.slice(queryMatch.index);
    const selectOffset = afterQuery.indexOf("select: {");
    if (selectOffset === -1) {
      throw new Error("invoiceSelectBlock: no select: { after the db.invoice.find*( call");
    }
    const openBrace = queryMatch.index + selectOffset + "select: ".length;
    const closeBrace = matchBrace(slice, openBrace);
    return slice.slice(openBrace, closeBrace + 1);
  }

  /** The `items: { ... }` sub-block (balance-matched) inside an already-isolated select block. */
  function itemsSubBlock(selectBlock: string): string {
    const offset = selectBlock.indexOf("items:");
    if (offset === -1) throw new Error("itemsSubBlock: no items: key in this select block");
    const openBrace = selectBlock.indexOf("{", offset);
    const closeBrace = matchBrace(selectBlock, openBrace);
    // A caller may spell its items select as the shared RESYNC_ITEM_SELECT constant (resync-plan.ts);
    // expand it to the constant's real keys so the field check still reads the fields actually selected.
    return selectBlock
      .slice(openBrace, closeBrace + 1)
      .replace(/\bRESYNC_ITEM_SELECT\b/g, Object.keys(RESYNC_ITEM_SELECT).join(", "));
  }

  interface CallerCheck {
    methodName: string;
    preservesStatus: boolean;
    selectBlock: string;
  }

  /** One entry per `this.rebuildSiblingDrafts(` call site, in source order. */
  function findCallers(): CallerCheck[] {
    const raw = readFileSync(SERVICE_PATH, "utf8");
    const src = stripComments(raw);
    const methodStarts = findMethodStarts(src);
    const callSites = findCallSites(src);

    return callSites.map((callStart) => {
      const enclosing = [...methodStarts].reverse().find((m) => m.index <= callStart);
      if (!enclosing) {
        throw new Error(`findCallers: no enclosing method found for call at index ${callStart}`);
      }
      const methodSlice = src.slice(enclosing.index, callStart);
      const callText = callExpressionText(src, callStart);
      return {
        methodName: enclosing.name,
        preservesStatus: /preserveStatus:\s*true/.test(callText),
        selectBlock: invoiceSelectBlock(methodSlice),
      };
    });
  }

  it(`has exactly ${EXPECTED_CALL_COUNT} callers (count-pinned — a 5th caller must extend this spec, not just add itself)`, () => {
    const src = stripComments(readFileSync(SERVICE_PATH, "utf8"));
    expect(findCallSites(src)).toHaveLength(EXPECTED_CALL_COUNT);
  });

  it("every caller's items select carries orderItemId + unitsPerBox (priorUnitsPerBoxMap's inputs)", () => {
    const callers = findCallers();
    expect(callers).toHaveLength(EXPECTED_CALL_COUNT);
    for (const c of callers) {
      const items = itemsSubBlock(c.selectBlock);
      expect({ method: c.methodName, items }).toEqual(
        expect.objectContaining({
          method: c.methodName,
          items: expect.stringMatching(/orderItemId/),
        }),
      );
      expect({ method: c.methodName, items }).toEqual(
        expect.objectContaining({
          method: c.methodName,
          items: expect.stringMatching(/unitsPerBox/),
        }),
      );
    }
  });

  it("every caller selects shippingFee + discount (the sibling-fee placement and total calc)", () => {
    const callers = findCallers();
    for (const c of callers) {
      expect({
        method: c.methodName,
        hasShippingFee: /\bshippingFee\b/.test(c.selectBlock),
      }).toEqual({ method: c.methodName, hasShippingFee: true });
      expect({ method: c.methodName, hasDiscount: /\bdiscount\b/.test(c.selectBlock) }).toEqual({
        method: c.methodName,
        hasDiscount: true,
      });
    }
  });

  it("a preserveStatus: true caller also selects payments (amount + status) + dueDate + status", () => {
    const callers = findCallers();
    const preserving = callers.filter((c) => c.preservesStatus);
    // Sanity: the scanner must actually find at least one preserveStatus caller, or the
    // assertions below would pass vacuously over an empty array.
    expect(preserving.length).toBeGreaterThan(0);
    for (const c of preserving) {
      expect({
        method: c.methodName,
        hasPayments: /payments:\s*\{[\s\S]*?amount[\s\S]*?status/.test(c.selectBlock),
      }).toEqual({ method: c.methodName, hasPayments: true });
      expect({ method: c.methodName, hasDueDate: /\bdueDate\b/.test(c.selectBlock) }).toEqual({
        method: c.methodName,
        hasDueDate: true,
      });
      expect({
        method: c.methodName,
        hasStatus: /\bstatus:\s*true\b/.test(c.selectBlock),
      }).toEqual({ method: c.methodName, hasStatus: true });
    }
  });

  it("the scanner can actually see the broken shape (a regex that matches nothing would pass vacuously)", () => {
    // The exact #1257 shape: an invoice select with no items key at all.
    const brokenMethod = `
  async brokenCaller(orderId: string, db: any) {
    const nonVoid = await db.invoice.findMany({
      where: { orderId },
      select: {
        id: true,
        status: true,
        shippingFee: true,
        discount: true,
      },
    });
    return this.rebuildSiblingDrafts(order, [{ draft: nonVoid[0], lines: [] }], "delivered", db);
  }
`;
    expect(() => invoiceSelectBlock(brokenMethod)).not.toThrow();
    expect(() => itemsSubBlock(invoiceSelectBlock(brokenMethod))).toThrow(/no items: key/);

    // The #1257 shape one step later: items IS selected, but without unitsPerBox (a caller that
    // added the key for a different reason and never noticed the core also needs the pack).
    const partialMethod = brokenMethod.replace(
      "discount: true,",
      "discount: true,\n        items: { select: { orderItemId: true } },",
    );
    const items = itemsSubBlock(invoiceSelectBlock(partialMethod));
    expect(/orderItemId/.test(items)).toBe(true);
    expect(/unitsPerBox/.test(items)).toBe(false); // this is the shape that must fail the real test

    // And the correct shape passes both.
    const fixedMethod = brokenMethod.replace(
      "discount: true,",
      "discount: true,\n        items: { select: { orderItemId: true, unitsPerBox: true } },",
    );
    const fixedItems = itemsSubBlock(invoiceSelectBlock(fixedMethod));
    expect(/orderItemId/.test(fixedItems)).toBe(true);
    expect(/unitsPerBox/.test(fixedItems)).toBe(true);
  });
});
