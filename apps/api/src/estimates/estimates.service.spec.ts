import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { EstimatesService } from "./estimates.service";
import * as EstimatesServiceModule from "./estimates.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

// B8: accept() had no status guard and convertToInvoice() was a read-then-write
// with no transaction, so a double-click (re-accept a CONVERTED estimate, or two
// concurrent converts) could mint a second invoice for the same estimate. Both
// paths now claim their status transition atomically via a conditional
// updateMany before doing any invoice work.
describe("EstimatesService — B8 accept/convert duplicate-invoice race", () => {
  let service: EstimatesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  // B100/F16b harness note: convertToInvoice routes its mint through
  // NumberingService once P1/P2 land — EstimatesService does not inject it yet, so
  // this provider is unused by today's code and only backs the new REG-B100/pin
  // tests below (cause-ruling.md §2 D3). Default resolves to the same
  // "INV-2026-0001" the pre-B100 findFirst-null mock produced.
  const mockNumbering = {
    reserveNext: jest.fn().mockResolvedValue("INV-2026-0001"),
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    mockNumbering.reserveNext.mockClear();
    mockNumbering.reserveNext.mockResolvedValue("INV-2026-0001");
    const mod = await Test.createTestingModule({
      providers: [
        EstimatesService,
        { provide: PrismaService, useValue: prisma },
        // flag.msrp defaults OFF so convertToInvoice's MSRP snapshot is a no-op.
        {
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
        },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();
    service = mod.get(EstimatesService);
  });

  describe("accept()", () => {
    it("throws and does not flip status when the estimate is already CONVERTED", async () => {
      // The atomic claim via claimTransition excludes CONVERTED and DECLINED
      // in its WHERE, so a re-accept attempt matches zero rows.
      prisma.estimate.updateMany.mockResolvedValue({ count: 0 });
      // PIN-B70 T27 (bug-test-plan.md): once accept() routes its count-0 path
      // through a findFirst lookup to tell "missing" (404) apart from "wrong
      // status" (400), this mock must resolve a non-terminal row so this test's
      // 400 assertion below keeps holding after fix-b70 lands. Extending, not
      // replacing — HEAD ignores this mock entirely today.
      prisma.estimate.findFirst.mockResolvedValue({ id: "est-1", status: "SENT" });

      await expect(service.accept("est-1")).rejects.toThrow(BadRequestException);
      await expect(service.accept("est-1")).rejects.toThrow(
        "Converted estimates cannot be re-accepted",
      );

      expect(prisma.estimate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "est-1",
            status: { notIn: ["CONVERTED", "DECLINED"] },
          }),
          data: { status: "ACCEPTED" },
        }),
      );
      // A losing claim must never fall through to the final read/return.
      expect(prisma.estimate.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it("claims the status and returns the updated estimate when not CONVERTED or voided", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 });
      prisma.estimate.findUniqueOrThrow.mockResolvedValue({ id: "est-1", status: "ACCEPTED" });

      const result = await service.accept("est-1");

      expect(result).toEqual({ id: "est-1", status: "ACCEPTED" });
      expect(prisma.estimate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "est-1",
            status: { notIn: ["CONVERTED", "DECLINED"] },
          }),
          data: { status: "ACCEPTED" },
        }),
      );
    });
  });

  describe("convertToInvoice()", () => {
    it("throws and creates no invoice when a concurrent convert already won the claim", async () => {
      // Simulates the losing side of a race: another request's claim already
      // flipped ACCEPTED -> CONVERTED first, so this updateMany matches nothing.
      prisma.estimate.updateMany.mockResolvedValue({ count: 0 });
      prisma.estimate.findUnique.mockResolvedValue({ id: "est-1", status: "ACCEPTED" });

      await expect(service.convertToInvoice("est-1")).rejects.toThrow(BadRequestException);
      await expect(service.convertToInvoice("est-1")).rejects.toThrow(
        "Only ACCEPTED estimates can be converted",
      );

      expect(prisma.estimate.updateMany).toHaveBeenCalledWith({
        where: { id: "est-1", status: "ACCEPTED" },
        data: { status: "CONVERTED" },
      });
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });

    it("claims the status before creating the invoice, and mints exactly one invoice", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 });
      prisma.estimate.findUnique.mockResolvedValue({
        id: "est-1",
        status: "ACCEPTED",
        customerId: "cust-1",
        subtotal: 100,
        taxAmount: 10,
        discount: 0,
        total: 110,
        notes: null,
        terms: null,
        items: [
          {
            description: "Widget",
            productId: "prod-1",
            qty: 2,
            unitPrice: 50,
            subtotal: 100,
          },
        ],
      });
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve({ id: "inv-1", ...args.data, customer: {} }),
      );

      const inv = await service.convertToInvoice("est-1");

      expect(inv).toMatchObject({ id: "inv-1", customerId: "cust-1", status: "DRAFT" });
      expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
      expect(prisma.estimate.updateMany).toHaveBeenCalledWith({
        where: { id: "est-1", status: "ACCEPTED" },
        data: { status: "CONVERTED" },
      });

      // The claim must land strictly before the invoice is created — that
      // ordering is what makes the claim atomic protection instead of decoration.
      const claimOrder = prisma.estimate.updateMany.mock.invocationCallOrder[0];
      const createOrder = prisma.invoice.create.mock.invocationCallOrder[0];
      expect(claimOrder).toBeLessThan(createOrder);
    });

    // B294: convertToInvoice hardcoded `taxRate: 0` on every converted line —
    // the same bug fixed for order-derived invoice lines in
    // invoices.service.ts (REG-B294). A taxed estimate (subtotal 100, taxAmount
    // 10 -> effective rate 0.10) must stamp that real rate onto its converted
    // line, not 0, so a later applyPriceAdjustment recompute doesn't silently
    // zero the tax.
    it("REG-B294: a converted line stores the estimate's effective tax rate, not 0", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 });
      prisma.estimate.findUnique.mockResolvedValue({
        id: "est-294",
        status: "ACCEPTED",
        customerId: "cust-294",
        subtotal: 100,
        taxAmount: 10, // 10 / 100 = 0.10 effective rate
        discount: 0,
        total: 110,
        notes: null,
        terms: null,
        items: [
          {
            description: "Widget",
            productId: "prod-294",
            qty: 2,
            unitPrice: 50,
            subtotal: 100,
          },
        ],
      });
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve({ id: "inv-294", ...args.data, customer: {} }),
      );

      await service.convertToInvoice("est-294");

      const createdLine = prisma.invoice.create.mock.calls[0][0].data.items.create[0];
      expect(createdLine.taxRate).not.toBe(0);
      expect(createdLine.taxRate).toBeCloseTo(0.1, 4);
    });

    // B294 round 2: convertToInvoice passed `isTaxExempt: false` unconditionally
    // to effectiveTaxRateFromTotals, so an exempt customer whose estimate still
    // carries a stale non-zero taxAmount (from before exemption was set, or a
    // data-entry error) would convert that stale amount into a non-zero line
    // rate. An exempt customer must always convert at rate 0 regardless of what
    // taxAmount says.
    it("REG-B294: an exempt customer's estimate converts with line rate 0 even with a stale non-zero taxAmount", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 });
      prisma.estimate.findUnique.mockResolvedValue({
        id: "est-294x",
        status: "ACCEPTED",
        customerId: "cust-294x",
        customer: { isTaxExempt: true },
        subtotal: 100,
        taxAmount: 10, // stale non-zero taxAmount on an exempt customer's estimate
        discount: 0,
        total: 100,
        notes: null,
        terms: null,
        items: [
          {
            description: "Widget",
            productId: "prod-294x",
            qty: 2,
            unitPrice: 50,
            subtotal: 100,
          },
        ],
      });
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve({ id: "inv-294x", ...args.data, customer: {} }),
      );

      await service.convertToInvoice("est-294x");

      const createdLine = prisma.invoice.create.mock.calls[0][0].data.items.create[0];
      expect(createdLine.taxRate).toBe(0);
    });

    // REG-B100-F (cause-ruling.md §3, cause-refutation.md §7.4): convertToInvoice
    // has no P2002 catch today — a concurrent convert's unique-constraint hit
    // propagates as a raw 500. TODAY this rejects with the plain `{ code: "P2002" }`
    // object, not a ConflictException, so the assertion below fails on the type.
    it("REG-B100-F: maps a concurrent convert's P2002 into ConflictException (409), not a raw 500", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 });
      prisma.estimate.findUnique.mockResolvedValue({
        id: "est-2",
        status: "ACCEPTED",
        customerId: "cust-1",
        subtotal: 100,
        taxAmount: 10,
        discount: 0,
        total: 110,
        notes: null,
        terms: null,
        items: [],
      });
      prisma.invoice.create.mockRejectedValue({
        code: "P2002",
        message: "Unique constraint failed on the fields: (`invoiceNumber`)",
      });

      await expect(service.convertToInvoice("est-2")).rejects.toBeInstanceOf(ConflictException);
    });

    // B100/F16b pin (P5, cause-ruling.md §2 D3): convertToInvoice calls
    // numbering.reserveNext("INVOICE", { year, tx }) directly — it has no
    // generateInvoiceNumber helper of its own. TODAY it scans tx.invoice.findFirst
    // instead and never touches NumberingService, so this fails on "was not
    // called".
    it("REG-B100 pin P5: delegates to numbering.reserveNext before the tx instead of scanning tx.invoice.findFirst", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 });
      prisma.estimate.findUnique.mockResolvedValue({
        id: "est-3",
        status: "ACCEPTED",
        customerId: "cust-1",
        subtotal: 10,
        taxAmount: 1,
        discount: 0,
        total: 11,
        notes: null,
        terms: null,
        items: [],
      });
      mockNumbering.reserveNext.mockResolvedValueOnce("INV-2026-0038");
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve({ id: "inv-9", ...args.data, customer: {} }),
      );

      const inv = await service.convertToInvoice("est-3");

      expect(mockNumbering.reserveNext).toHaveBeenCalledWith(
        "INVOICE",
        expect.objectContaining({ year: new Date().getFullYear() }),
      );
      expect((inv as any).invoiceNumber).toBe("INV-2026-0038");
      expect(prisma.invoice.findFirst).not.toHaveBeenCalled();
    });
  });

  // T4 unit pin — B277 (cause-ruling.md §2 D5, cause-refutation.md §2.7,
  // bug-test-plan.md T4). estimates.service.ts:139 is the ONLY writer of
  // estimateNumber in the repo and reserveNext is already collision-guarded, so
  // this is a zero-risk consistency pin, not a live repro — same construction as
  // the REG-B100-F pin above (convertToInvoice), applied to create() instead.
  // TODAY create() has no try/catch around estimate.create at all, so the raw
  // `{ code: "P2002" }` object propagates unchanged and this fails on the TYPE
  // of the rejection, not an unresolved import or a stub.
  describe("create()", () => {
    // Named `REG-B277` (not a bare `B277 pin`) so the red gate's `-t "REG-B2"`
    // name filter actually collects this repro — the sibling pin below is GREEN
    // today and deliberately stays outside that filter.
    it("REG-B277 pin: maps a P2002 on the estimate number into ConflictException (409), not a raw 500", async () => {
      prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
      prisma.estimate.create.mockRejectedValue({
        code: "P2002",
        message: "Unique constraint failed on the fields: (`estimateNumber`)",
      });

      await expect(
        service.create({
          customerId: "cust-1",
          items: [{ description: "Widget", unitPrice: 10, qty: 1 }],
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    // The same try also spans `items: { create: itemsData }`, so a P2002 raised
    // by some OTHER unique must not be relabelled as a numbering conflict with a
    // retry instruction that cannot help.
    it("B277 pin: a P2002 on a NON-number constraint propagates as the original error", async () => {
      prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
      const err = { code: "P2002", meta: { target: ["estimateId", "productId"] } };
      prisma.estimate.create.mockRejectedValue(err);

      await expect(
        service.create({
          customerId: "cust-1",
          items: [{ description: "Widget", unitPrice: 10, qty: 1 }],
        }),
      ).rejects.toBe(err);
    });
  });

  // B70 (bug-test-plan.md T1-T11, T24-T28; cause-ruling.md; rc-b70 findings):
  // send()/decline() do a bare estimate.update with NO status predicate, so a
  // CONVERTED (or voided) estimate can be laundered CONVERTED -> SENT/DECLINED
  // -> ACCEPTED -> convertToInvoice() and mint a second invoice. accept() claims
  // via updateMany with only `{ not: "CONVERTED" }` (voided estimates slip
  // through), and voidEstimate() is read-then-check (TOCTOU): findUnique, an
  // if-check, then a bare update. Literals copied verbatim from HEAD / rc-b70's
  // findings (never invented): <VOID-STATUS> = "DECLINED" (voidEstimate() writes
  // this literal today; there is no separate enum member) — ACCEPT_MSG =
  // "Converted estimates cannot be re-accepted" — VOID_MSG = "Converted
  // estimates cannot be voided" — accept()'s updateMany where key set is
  // `{ id, status }` (no tenant key).
  //
  // Wrong values these tests catch on HEAD today (rt-b70 remediation item 4 —
  // populates the bug's "wrong value" explicitly rather than leaving it as an
  // empty placeholder): send()/decline() resolve a Promise instead of
  // rejecting for a CONVERTED/voided estimate (laundering entry point);
  // voidEstimate() does a bare `estimate.update` after a separate
  // `findUnique` read (TOCTOU, not atomic); accept()'s claim where-clause is
  // `{ not: "CONVERTED" }` instead of `{ notIn: ["CONVERTED", "DECLINED"] }`,
  // so a voided (DECLINED) row still gets claimed; missing-id calls throw a
  // raw Prisma P2025 Error or (for accept()) BadRequestException instead of
  // NotFoundException; the laundering chains mint invoice.create 2x instead
  // of 1x. See tests-report.md's "Verbatim runner output" for the exact
  // received-vs-expected value on every one of these.
  //
  // KNOWN OPEN CONFLICT (flagged by rc-b70, unresolved as of this test-authoring
  // pass — see this task's tests-report.md and the rt-b70 diff brief): because
  // voidEstimate() has no distinct VOID status, <VOID-STATUS> === "DECLINED".
  // T4/T28 require the terminal-status notIn set to contain "DECLINED", while
  // T26 requires accept()'s notIn set to NOT contain "DECLINED" so
  // DECLINED -> ACCEPTED keeps working. Both are transcribed here verbatim from
  // bug-test-plan.md; no implementation can satisfy both without a real,
  // distinct VOID status — a decision the brief explicitly defers to fix-b70.
  // This conflict is unresolved by this remediation pass; it is a fix-b70
  // design decision (add a distinct VOID enum value, or accept the functional
  // limitation), not a test-structure defect, and is called out again in
  // tests-report.md's "Open issues" section for the PR description.
  //
  // Red-gate scope (rt-b70 remediation item 1): the structural RED check
  // requires every un-skipped test declared in this file to fail against
  // today's wrong value. T24/T26/T11 below are non-regression PIN checks that
  // are correctly GREEN on HEAD (and must stay green after fix-b70) — they are
  // `.skip()`-ed with a comment at their declaration so they don't count
  // against the RED audit; re-enable them once fix-b70 lands, as part of its
  // own PIN verification pass. T25 and T28 stay un-skipped and in-scope: both
  // are legitimately RED on HEAD today (see "Open issues" #2 in
  // tests-report.md) even though bug-test-plan.md labels them PIN, because
  // what they assert (updateMany key-set parity across all four mutators, and
  // the TERMINAL_ESTIMATE_STATUSES export) doesn't exist until fix-b70 lands.
  const ACCEPT_MSG = "Converted estimates cannot be re-accepted";
  const VOID_MSG = "Converted estimates cannot be voided";
  const VOID_STATUS = "DECLINED";
  const TERMINAL_NOT_IN = ["CONVERTED", VOID_STATUS];

  // Builds a single stateful in-memory estimate row shared by every mocked
  // prisma call (forTenant() and tenantTransaction()'s `tx` are literally the
  // same jest.fn()s under createMockPrisma — see prisma-mock.ts), so a laundering
  // chain (convert -> send -> accept -> convert) can be driven end-to-end and
  // invoice.create's call count observed. `updateMany` evaluates the same
  // `{ not }` / `{ notIn }` / plain-string status predicates the service (and
  // its eventual claimTransition() helper) issue; `update` writes unconditionally,
  // matching today's bare mutators.
  function createLaunderingHarness(prisma: ReturnType<typeof createMockPrisma>, initial: any) {
    const row: any = { ...initial };
    let invoiceSeq = 0;

    prisma.estimate.findUnique.mockImplementation(() => Promise.resolve({ ...row }));
    prisma.estimate.findFirst.mockImplementation(() => Promise.resolve({ ...row }));

    prisma.estimate.updateMany.mockImplementation((args: any) => {
      const predicate = args?.where?.status;
      let matches: boolean;
      if (predicate && typeof predicate === "object") {
        if ("notIn" in predicate) matches = !predicate.notIn.includes(row.status);
        else if ("not" in predicate) matches = row.status !== predicate.not;
        else matches = false;
      } else {
        matches = row.status === predicate;
      }
      if (!matches) return Promise.resolve({ count: 0 });
      Object.assign(row, args.data);
      return Promise.resolve({ count: 1 });
    });

    prisma.estimate.update.mockImplementation((args: any) => {
      Object.assign(row, args.data);
      return Promise.resolve({ ...row });
    });

    prisma.invoice.create.mockImplementation(() => {
      invoiceSeq += 1;
      return Promise.resolve({ id: `inv-${invoiceSeq}` });
    });

    return row;
  }

  describe("send()", () => {
    it("REG-B70 send() refuses a CONVERTED estimate", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 0 });
      prisma.estimate.findFirst.mockResolvedValue({ id: "est-1", status: "CONVERTED" });
      prisma.estimate.update.mockResolvedValue({ id: "est-1", status: "SENT" });

      await expect(service.send("est-1")).rejects.toThrow(BadRequestException);
      await expect(service.send("est-1")).rejects.toThrow(
        "Converted or voided estimates cannot be re-sent",
      );
      expect(prisma.estimate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "est-1", status: { notIn: TERMINAL_NOT_IN } }),
          data: { status: "SENT" },
        }),
      );
    });

    it("REG-B70 send() refuses a voided estimate", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 0 });
      prisma.estimate.findFirst.mockResolvedValue({ id: "est-1", status: VOID_STATUS });
      prisma.estimate.update.mockResolvedValue({ id: "est-1", status: "SENT" });

      await expect(service.send("est-1")).rejects.toThrow(BadRequestException);
      await expect(service.send("est-1")).rejects.toThrow(
        "Converted or voided estimates cannot be re-sent",
      );
      expect(prisma.estimate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "est-1", status: { notIn: TERMINAL_NOT_IN } }),
          data: { status: "SENT" },
        }),
      );
    });

    it("REG-B70 missing id is 404 not 400 — send", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 0 });
      prisma.estimate.findFirst.mockResolvedValue(null);
      prisma.estimate.update.mockRejectedValue(
        Object.assign(
          new Error(
            "An operation failed because it depends on one or more records that were required but not found.",
          ),
          {
            code: "P2025",
          },
        ),
      );

      await expect(service.send("nope")).rejects.toThrow(NotFoundException);
      await expect(service.send("nope")).rejects.toThrow("Estimate not found");
    });

    // Non-regression only (rt-b70 remediation, red-gate finding #1): this test
    // is GREEN on HEAD today and must stay green after fix-b70 — it is not a
    // repro and does not belong in the structural RED count, which requires
    // every un-skipped test in this file to fail on HEAD. Skipped here rather
    // than deleted so fix-b70's own revert-probe / PIN verification pass can
    // re-enable it (drop `.skip`) to confirm the fix didn't change send()'s
    // response shape.
    it.skip("PIN-B70 send() response shape unchanged", async () => {
      const ROW = { id: "est-1", status: "SENT" };
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 });
      prisma.estimate.findFirst.mockResolvedValue(ROW);
      prisma.estimate.findUnique.mockResolvedValue(ROW);
      prisma.estimate.update.mockResolvedValue(ROW);

      await expect(service.send("est-1")).resolves.toEqual(ROW);
    });
  });

  describe("decline()", () => {
    it("REG-B70 decline() refuses a CONVERTED estimate", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 0 });
      prisma.estimate.findFirst.mockResolvedValue({ id: "est-1", status: "CONVERTED" });
      prisma.estimate.update.mockResolvedValue({ id: "est-1", status: "DECLINED" });

      await expect(service.decline("est-1")).rejects.toThrow(BadRequestException);
      await expect(service.decline("est-1")).rejects.toThrow(
        "Converted or voided estimates cannot be declined",
      );
      expect(prisma.estimate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "est-1", status: { notIn: TERMINAL_NOT_IN } }),
          data: { status: "DECLINED" },
        }),
      );
    });

    it("REG-B70 missing id is 404 not 400 — decline", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 0 });
      prisma.estimate.findFirst.mockResolvedValue(null);
      prisma.estimate.update.mockRejectedValue(
        Object.assign(
          new Error(
            "An operation failed because it depends on one or more records that were required but not found.",
          ),
          {
            code: "P2025",
          },
        ),
      );

      await expect(service.decline("nope")).rejects.toThrow(NotFoundException);
      await expect(service.decline("nope")).rejects.toThrow("Estimate not found");
    });
  });

  describe("accept() — voided estimates and missing ids", () => {
    it("REG-B70 accept() refuses a voided estimate", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 0 });
      prisma.estimate.findFirst.mockResolvedValue({ id: "est-1", status: VOID_STATUS });

      await expect(service.accept("est-1")).rejects.toThrow(BadRequestException);
      await expect(service.accept("est-1")).rejects.toThrow(ACCEPT_MSG);
      // The where-shape is the discriminator here, not the rejection alone —
      // HEAD's `{ not: "CONVERTED" }` also rejects a voided row via count-0,
      // but never carries a `notIn` set that includes the void status.
      expect(prisma.estimate.updateMany.mock.calls[0][0].where.status).toEqual({
        notIn: TERMINAL_NOT_IN,
      });
    });

    it("REG-B70 missing id is 404 not 400 — accept", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 0 });
      prisma.estimate.findFirst.mockResolvedValue(null);

      await expect(service.accept("nope")).rejects.toThrow(NotFoundException);
      await expect(service.accept("nope")).rejects.toThrow("Estimate not found");
    });

    // Non-regression only (rt-b70 remediation, red-gate finding #1) — same
    // rationale as the skipped send() shape pin above: GREEN on HEAD today,
    // must stay GREEN after fix-b70, not a repro. Skipped from the structural
    // RED count; re-enable during fix-b70's PIN verification pass.
    it.skip("PIN-B70 accept() still allows DECLINED->ACCEPTED", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 });
      prisma.estimate.findUniqueOrThrow.mockResolvedValue({ id: "est-1", status: "ACCEPTED" });

      await expect(service.accept("est-1")).resolves.toEqual({ id: "est-1", status: "ACCEPTED" });

      const whereStatus = prisma.estimate.updateMany.mock.calls[0][0].where.status;
      expect(whereStatus).not.toEqual(
        expect.objectContaining({ notIn: expect.arrayContaining([VOID_STATUS]) }),
      );
    });
  });

  describe("voidEstimate()", () => {
    it("REG-B70 voidEstimate() claims atomically", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 0 });
      prisma.estimate.findUnique.mockResolvedValue({ id: "est-1", status: "CONVERTED" });
      prisma.estimate.findFirst.mockResolvedValue({ id: "est-1", status: "CONVERTED" });
      prisma.estimate.update.mockResolvedValue({ id: "est-1", status: VOID_STATUS });

      await expect(service.voidEstimate("est-1")).rejects.toThrow(BadRequestException);
      await expect(service.voidEstimate("est-1")).rejects.toThrow(VOID_MSG);
      expect(prisma.estimate.update).not.toHaveBeenCalled();
      expect(prisma.estimate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: VOID_STATUS } }),
      );
    });

    // PIN-B70 (rc-b70 finding 4): HEAD already returns 404, not 400, for a
    // missing id here — voidEstimate() does `findUnique` -> null ->
    // `NotFoundException("Estimate not found")` before ever reaching an update.
    // This is a PIN, not a REG (bug-test-plan.md T11 / Escalated item 2).
    // Non-regression only (rt-b70 remediation, red-gate finding #1) — same
    // rationale as above: reclassified REG->PIN per rc-b70 finding 4 because
    // HEAD already 404s here, so it is GREEN today and after fix-b70. Skipped
    // from the structural RED count; re-enable during fix-b70's PIN
    // verification pass.
    it.skip("PIN-B70 missing id is 404 not 400 — voidEstimate", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 0 });
      prisma.estimate.findUnique.mockResolvedValue(null);
      prisma.estimate.findFirst.mockResolvedValue(null);

      await expect(service.voidEstimate("nope")).rejects.toThrow(NotFoundException);
      await expect(service.voidEstimate("nope")).rejects.toThrow("Estimate not found");
      expect(prisma.estimate.update).not.toHaveBeenCalled();
    });
  });

  describe("laundering chains — a CONVERTED/voided estimate must never mint a second invoice", () => {
    it("REG-B70 laundered chain A convert->send->accept->convert mints one invoice", async () => {
      createLaunderingHarness(prisma, {
        id: "est-1",
        tenantId: "test-tenant",
        status: "ACCEPTED",
        customerId: "c-1",
        subtotal: 100,
        taxAmount: 0,
        discount: 0,
        total: 100,
        notes: null,
        terms: null,
        items: [
          { productId: "prod-1", description: "Widget", qty: 1, unitPrice: 100, subtotal: 100 },
        ],
      });

      let sendRejected = false;
      await service.convertToInvoice("est-1");
      try {
        await service.send("est-1");
      } catch {
        sendRejected = true;
      }
      if (!sendRejected) {
        await service.accept("est-1");
        await service.convertToInvoice("est-1");
      }

      expect(sendRejected).toBe(true);
      expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
    });

    it("REG-B70 laundered chain B convert->void->send->accept->convert mints one invoice", async () => {
      const row = createLaunderingHarness(prisma, {
        id: "est-1",
        tenantId: "test-tenant",
        status: "ACCEPTED",
        customerId: "c-1",
        subtotal: 100,
        taxAmount: 0,
        discount: 0,
        total: 100,
        notes: null,
        terms: null,
        items: [
          { productId: "prod-1", description: "Widget", qty: 1, unitPrice: 100, subtotal: 100 },
        ],
      });

      await service.convertToInvoice("est-1");
      // Seed the post-void state directly rather than driving an actual
      // voidEstimate() call: HEAD's voidEstimate() already 400s a CONVERTED row
      // (rc-b70 finding 4, see the voidEstimate() describe block above) — that
      // leg is unrelated to and unaffected by this REG, whose target is the
      // `send` step from an estimate that was successfully voided.
      row.status = VOID_STATUS;

      let sendRejected = false;
      try {
        await service.send("est-1");
      } catch {
        sendRejected = true;
      }
      if (!sendRejected) {
        await service.accept("est-1");
        await service.convertToInvoice("est-1");
      }

      expect(sendRejected).toBe(true);
      expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
    });
  });

  describe("where-clause key-set parity and the terminal-status set", () => {
    it("PIN-B70 where-clause key-set parity across accept/send/decline/voidEstimate", async () => {
      const row = { id: "est-1", status: "SENT" };
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 });
      prisma.estimate.findFirst.mockResolvedValue(row);
      prisma.estimate.findUnique.mockResolvedValue(row);
      prisma.estimate.findUniqueOrThrow.mockResolvedValue(row);
      prisma.estimate.update.mockResolvedValue(row);

      await service.accept("est-1").catch(() => undefined);
      await service.send("est-1").catch(() => undefined);
      await service.decline("est-1").catch(() => undefined);
      await service.voidEstimate("est-1").catch(() => undefined);

      const keySets = prisma.estimate.updateMany.mock.calls.map((call: any) =>
        Object.keys(call[0].where).sort(),
      );
      // Today, only accept() claims via updateMany at all — send/decline/
      // voidEstimate go through a bare estimate.update instead, so this array
      // has length 1, not 4.
      expect(keySets.length).toBe(4);
      expect(new Set(keySets.map((k: string[]) => k.join(","))).size).toBe(1);
    });

    it("PIN-B70 exact terminal-status set", () => {
      // TERMINAL_ESTIMATE_STATUSES does not exist on HEAD (it is fix-b70's
      // export) — accessed via the namespace import + `any` cast so a missing
      // export fails this assertion's value check, not the whole file's
      // compilation.
      expect((EstimatesServiceModule as any).TERMINAL_ESTIMATE_STATUSES).toEqual([
        "CONVERTED",
        VOID_STATUS,
      ]);
    });
  });

  // B17 (rc-b17 finding, bug-test-plan.md T12/T13/T29): convertToInvoice()
  // claims the estimate via updateMany({ where: { id, status: "ACCEPTED" },
  // data: { status: "CONVERTED" } }) (the SAME where-key set as rc-b70's
  // finding 2 — { id, status }, no tenant key) and returns the minted invoice,
  // but never writes Estimate.invoiceId even though the column exists
  // (invoiceId @unique, FK onDelete: SetNull). Both REGs below drive the same
  // ACCEPTED-estimate fixture used by the existing convertToInvoice() tests
  // above.
  describe("convertToInvoice() — B17 invoiceId link", () => {
    const ACCEPTED_ESTIMATE = {
      id: "est-1",
      status: "ACCEPTED",
      customerId: "cust-1",
      subtotal: 100,
      taxAmount: 10,
      discount: 0,
      total: 110,
      notes: null,
      terms: null,
      items: [
        {
          description: "Widget",
          productId: "prod-1",
          qty: 2,
          unitPrice: 50,
          subtotal: 100,
        },
      ],
    };

    it("REG-B17 convertToInvoice links the estimate to the minted invoice", async () => {
      // First updateMany call = the ACCEPTED claim; second = the invoiceId link.
      prisma.estimate.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      prisma.estimate.findUnique.mockResolvedValue(ACCEPTED_ESTIMATE);
      prisma.invoice.create.mockResolvedValue({ id: "inv_1", customerId: "cust-1" });

      await service.convertToInvoice("est-1");

      // Red today: HEAD's convertToInvoice() calls tx.estimate.updateMany
      // exactly once (the ACCEPTED claim) and never links invoiceId, so this
      // second call is never made.
      expect(prisma.estimate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "est-1", status: "CONVERTED" }),
          data: { invoiceId: "inv_1" },
        }),
      );

      const linkCall = prisma.estimate.updateMany.mock.calls.findIndex(
        (call: any) => call[0]?.data?.invoiceId === "inv_1",
      );
      const linkOrder = prisma.estimate.updateMany.mock.invocationCallOrder[linkCall];
      const createOrder = prisma.invoice.create.mock.invocationCallOrder[0];
      expect(linkOrder).toBeGreaterThan(createOrder);
    });

    it("REG-B17 link count mismatch rolls back", async () => {
      // The ACCEPTED claim wins, but the invoiceId link matches zero rows
      // (e.g. a concurrent write raced the same estimate) — convertToInvoice
      // must reject and never resolve with the minted invoice.
      prisma.estimate.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });
      prisma.estimate.findUnique.mockResolvedValue(ACCEPTED_ESTIMATE);
      prisma.invoice.create.mockResolvedValue({ id: "inv_1", customerId: "cust-1" });

      // Red today: HEAD never issues a link updateMany at all (count-0 branch
      // is unreachable) and resolves with the invoice instead of rejecting.
      // A single call is asserted twice (not two separate calls) because the
      // queued mockResolvedValueOnce pair above is consumed by one
      // convertToInvoice() invocation.
      let caught: unknown;
      try {
        await service.convertToInvoice("est-1");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConflictException);
      expect((caught as Error)?.message).toBe("Estimate link failed");
    });

    it("PIN-B17 convert still claims via updateMany status ACCEPTED and returns the invoice", async () => {
      prisma.estimate.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      prisma.estimate.findUnique.mockResolvedValue(ACCEPTED_ESTIMATE);
      const mintedInvoice = { id: "inv_1", customerId: "cust-1" };
      prisma.invoice.create.mockResolvedValue(mintedInvoice);

      const result = await service.convertToInvoice("est-1");

      // First updateMany call only — the ACCEPTED claim, unaffected by
      // whatever the B17 link write (asserted separately above) looks like.
      expect(prisma.estimate.updateMany.mock.calls[0][0]).toMatchObject({
        where: expect.objectContaining({ status: "ACCEPTED" }),
        data: { status: "CONVERTED" },
      });
      expect(result).toMatchObject(mintedInvoice);
    });
  });
});
