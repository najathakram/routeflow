import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { CreditNoteReissueService } from "./credit-note-reissue.service";
import { codeOf, cnBad } from "./credit-note-errors";
import { API_ERROR_CODES as CODES } from "../common/api-error-codes";
import { CreditNotesService } from "./credit-notes.service";
import { CreditNotesController } from "./credit-notes.controller";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { IdempotencyService } from "../common/idempotency.service";
import { RolesGuard } from "../auth/guards/roles.guard";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * #2648 / SA-535(b), SA-535a, SA-535b unit pins for the credit-note reissue (an amount/line edit
 * = void-with-reversal + an unapplied replacement in ONE transaction). The real-Postgres pins
 * (atomic rollback, balances, ledger counter-entries, one note on replay) are in
 * credit-note-reissue.db.spec.ts.
 */
describe("CreditNoteReissueService (#2648)", () => {
  let service: CreditNoteReissueService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let creditNotes: {
    validateAndBuildCnItems: jest.Mock;
    voidWithReversalInTx: jest.Mock;
    insertCreditNoteInTx: jest.Mock;
    voidWithReversalRefusal: jest.Mock;
    liveCreditPayments: jest.Mock;
  };
  let numbering: { reserveNext: jest.Mock };
  let idem: { acquireLock: jest.Mock; hashFor: jest.Mock; check: jest.Mock; save: jest.Mock };
  let gateway: { emitCreditNoteVoided: jest.Mock; emitCreditNoteCreated: jest.Mock };

  const OLD = {
    id: "cn-old",
    creditNoteNumber: "CN-2026-0007",
    status: "APPLIED",
    amount: 30,
    customerId: "cust-1",
    invoiceId: "inv-1",
    reason: "Damaged case",
    expiresAt: null as Date | null,
    autoApplyExcluded: false,
    amountUsed: 0,
  };
  const REOPENED = [{ invoiceId: "inv-9", invoiceNumber: "INV-9", amount: 30 }];
  const NEW = { id: "cn-new", creditNoteNumber: "CN-2026-0012", customerId: "cust-1", amount: 20 };

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.creditNote.findFirst.mockResolvedValue({ ...OLD });
    prisma.return.findFirst.mockResolvedValue(null);
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", businessName: "Acme Mart" });
    prisma.creditNoteItem.count.mockResolvedValue(0);
    prisma.invoice.findFirst.mockResolvedValue({ id: "inv-1", orderId: "ord-src" });
    creditNotes = {
      validateAndBuildCnItems: jest.fn().mockResolvedValue([]),
      voidWithReversalInTx: jest
        .fn()
        .mockResolvedValue({ creditNote: { ...OLD, status: "VOID" }, reopened: REOPENED }),
      insertCreditNoteInTx: jest.fn().mockResolvedValue({ ...NEW }),
      voidWithReversalRefusal: jest.fn().mockResolvedValue(null),
      liveCreditPayments: jest.fn().mockResolvedValue([]),
    };
    numbering = { reserveNext: jest.fn().mockResolvedValue("CN-2026-0012") };
    idem = {
      acquireLock: jest.fn().mockResolvedValue(undefined),
      hashFor: jest.fn().mockReturnValue("hash"),
      check: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue(undefined),
    };
    gateway = { emitCreditNoteVoided: jest.fn(), emitCreditNoteCreated: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        CreditNoteReissueService,
        { provide: PrismaService, useValue: prisma },
        { provide: CreditNotesService, useValue: creditNotes },
        { provide: NumberingService, useValue: numbering },
        { provide: IdempotencyService, useValue: idem },
        { provide: RouteFlowGateway, useValue: gateway },
      ],
    }).compile();
    service = mod.get(CreditNoteReissueService);
  });

  const auditActions = () =>
    prisma.auditLog.create.mock.calls.map((c: any[]) => c[0].data.action as string);
  const auditOf = (action: string) =>
    prisma.auditLog.create.mock.calls
      .map((c: any[]) => c[0].data)
      .find((d: any) => d.action === action);

  it("SA-608g: a note with NO source invoice passes no extra lock set, and one whose invoice has no order passes only the invoice", async () => {
    prisma.creditNote.findFirst.mockResolvedValue({ ...OLD, invoiceId: null, amount: 30 });
    await service.reissue("cn-old", { amount: 20 }, "key-a", "user-1");
    expect(creditNotes.voidWithReversalInTx.mock.calls[0][5]).toEqual({
      orderIds: [],
      invoiceIds: [],
    });
    creditNotes.voidWithReversalInTx.mockClear();
    prisma.creditNote.findFirst.mockResolvedValue({ ...OLD });
    prisma.invoice.findFirst.mockResolvedValue({ id: "inv-1", orderId: null });
    await service.reissue("cn-old", { amount: 20 }, "key-b", "user-1");
    expect(creditNotes.voidWithReversalInTx.mock.calls[0][5]).toEqual({
      orderIds: [],
      invoiceIds: ["inv-1"],
    });
  });

  it("voids the old note, then mints an unapplied replacement on the same tx, in that order", async () => {
    const res = await service.reissue("cn-old", { amount: 20 }, "key-1", "user-1");

    const voidOrder = creditNotes.voidWithReversalInTx.mock.invocationCallOrder[0];
    const recapOrder = creditNotes.validateAndBuildCnItems.mock.invocationCallOrder[1];
    const mintOrder = creditNotes.insertCreditNoteInTx.mock.invocationCallOrder[0];
    expect(voidOrder).toBeLessThan(recapOrder);
    expect(recapOrder).toBeLessThan(mintOrder);
    const voidTx = creditNotes.voidWithReversalInTx.mock.calls[0][0];
    expect(creditNotes.insertCreditNoteInTx.mock.calls[0][0]).toBe(voidTx);
    // SA-608g: the SOURCE invoice (and its order) ride into the void's own sorted lock sets, so the
    // reissue never takes KEY SHARE on the invoice AFTER holding the note (CN -> Invoice) while
    // deleteInvoice holds the invoice and wants the note.
    expect(creditNotes.voidWithReversalInTx).toHaveBeenCalledWith(
      voidTx,
      "cn-old",
      "user-1",
      null,
      undefined,
      { orderIds: ["ord-src"], invoiceIds: ["inv-1"] },
    );
    expect(prisma.tenantTransaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });

    const [, data] = creditNotes.insertCreditNoteInTx.mock.calls[0];
    expect(data).toEqual({
      creditNoteNumber: "CN-2026-0012",
      customerId: "cust-1",
      invoiceId: "inv-1",
      amount: 20,
      reason: "Replaces CN-2026-0007 — Damaged case",
      expiresAt: null,
      autoApplyExcluded: false,
    });
    expect(res).toEqual({
      voided: { id: "cn-old", creditNoteNumber: "CN-2026-0007" },
      creditNote: NEW,
      unapplied: REOPENED,
    });
  });

  it.each([true, false])(
    "SA-608: the replacement carries the old note's autoApplyExcluded (%s), so the sweep cannot apply it",
    async (excluded) => {
      prisma.creditNote.findFirst.mockResolvedValue({ ...OLD, autoApplyExcluded: excluded });

      await service.reissue("cn-old", { amount: 20 }, "key-1", "user-1");

      const [, data] = creditNotes.insertCreditNoteInTx.mock.calls[0];
      expect(data.autoApplyExcluded).toBe(excluded);
    },
  );

  describe("conflicts and refusals are readable 4xx, never a raw 500", () => {
    const p2034 = () => Object.assign(new Error("write conflict"), { code: "P2034" });

    it("exhausted serialization retries map to a 409, like create()", async () => {
      creditNotes.voidWithReversalInTx.mockRejectedValue(p2034());
      await expect(service.reissue("cn-old", { amount: 20 }, "key-1", "u")).rejects.toThrow(
        ConflictException,
      );
      expect(creditNotes.voidWithReversalInTx).toHaveBeenCalledTimes(3);
    });

    it("a P2002 on some OTHER unique constraint is rethrown untouched, not dressed up as a number conflict", async () => {
      const other = Object.assign(new Error("unique"), {
        code: "P2002",
        meta: { target: ["creditNoteId", "invoiceItemId"] },
      });
      creditNotes.insertCreditNoteInTx.mockRejectedValue(other);
      await expect(service.reissue("cn-old", { amount: 20 }, "key-1", "u")).rejects.toBe(other);
    });

    it("a line amount/qty over the line with NO prior credits is a 400 (plain validation)", async () => {
      for (const msg of [
        "Credit line amount (90) exceeds invoice line subtotal (50)",
        "Credit line qty (9) exceeds invoice line qty (5)",
      ]) {
        creditNotes.validateAndBuildCnItems.mockRejectedValueOnce(
          cnBad(CODES.CREDIT_NOTE_LINE_INVALID, msg),
        );
        const err = await service
          .reissue("cn-old", { amount: 20, items: [{ invoiceItemId: "li", amount: 20 }] }, "k", "u")
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect(err).not.toBeInstanceOf(ConflictException);
      }
    });

    it("...but WITH prior credits it is the state conflict (409)", async () => {
      creditNotes.validateAndBuildCnItems.mockRejectedValueOnce(
        cnBad(
          CODES.CREDIT_NOTE_OVER_HEADROOM,
          "Credit line amount (20) plus prior credits (40) would exceed invoice line subtotal (50)",
        ),
      );
      await expect(
        service.reissue(
          "cn-old",
          { amount: 20, items: [{ invoiceItemId: "li", amount: 20 }] },
          "k",
          "u",
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("a counter collision on the number (P2002) is a 409", async () => {
      creditNotes.insertCreditNoteInTx.mockRejectedValue(
        Object.assign(new Error("unique"), { code: "P2002" }),
      );
      await expect(service.reissue("cn-old", { amount: 20 }, "key-1", "u")).rejects.toThrow(
        ConflictException,
      );
    });

    it("a credit consumed somewhere a void cannot reverse is a 409 BEFORE the tx (no number burned)", async () => {
      creditNotes.voidWithReversalRefusal.mockResolvedValue({
        code: CODES.CREDIT_NOTE_CREDIT_CONSUMED,
        message:
          "Part of this credit was used somewhere it cannot be reversed from here (RETURN_CREDIT_CONSUMED). Nothing was changed.",
      });
      await expect(service.reissue("cn-old", { amount: 20 }, "key-1", "u")).rejects.toThrow(
        /RETURN_CREDIT_CONSUMED/,
      );
      expect(numbering.reserveNext).not.toHaveBeenCalled();
      expect(creditNotes.voidWithReversalInTx).not.toHaveBeenCalled();
    });

    it.each([
      "Credit line li-9 is not on invoice inv-1",
      "Credit line amount must be greater than 0",
      "Credit line amounts (25) must sum to the credit note amount (20)",
    ])("a line-shape error is a 400, not a 409: %s", async (msg) => {
      creditNotes.validateAndBuildCnItems.mockRejectedValueOnce(
        cnBad(CODES.CREDIT_NOTE_LINE_INVALID, msg),
      );
      const err = await service
        .reissue("cn-old", { amount: 20, items: [{ invoiceItemId: "li-9", amount: 20 }] }, "k", "u")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err).not.toBeInstanceOf(ConflictException);
    });

    describe("SA-608c: a note with NO source invoice", () => {
      const ORPHAN = { ...OLD, invoiceId: null as string | null, amount: 50 };
      const noWrites = () => {
        expect(numbering.reserveNext).not.toHaveBeenCalled();
        expect(creditNotes.voidWithReversalInTx).not.toHaveBeenCalled();
        expect(creditNotes.insertCreditNoteInTx).not.toHaveBeenCalled();
      };

      it("(a) an increase above the old amount is a 409 in the dry run: zero writes, no number burned", async () => {
        prisma.creditNote.findFirst.mockResolvedValue({ ...ORPHAN });
        await expect(service.reissue("cn-old", { amount: 500 }, "k", "u")).rejects.toThrow(
          new ConflictException(
            "A credit note without a source invoice can't be increased; issue a separate credit.",
          ),
        );
        noWrites();
      });

      it.each([50, 30])("(a) an edit to %s (<= the old $50) passes", async (amount) => {
        prisma.creditNote.findFirst.mockResolvedValue({ ...ORPHAN });
        await service.reissue("cn-old", { amount }, "k", "u");
        expect(creditNotes.insertCreditNoteInTx).toHaveBeenCalledTimes(1);
      });

      it("(a) re-checked IN the tx: a note orphaned after the pre-read (deleteInvoice) is still capped", async () => {
        prisma.creditNote.findFirst.mockResolvedValue({ ...OLD, amount: 50 }); // sourced at pre-read
        prisma.creditNote.findUnique.mockResolvedValue({ invoiceId: null, amount: 50 });
        await expect(service.reissue("cn-old", { amount: 500 }, "k", "u")).rejects.toThrow(
          /without a source invoice can't be increased/,
        );
        expect(creditNotes.insertCreditNoteInTx).not.toHaveBeenCalled();
      });

      it("(b) a line-bearing orphan is a 409 'source invoice was deleted', zero writes", async () => {
        prisma.creditNote.findFirst.mockResolvedValue({ ...ORPHAN });
        prisma.creditNoteItem.count.mockResolvedValue(2);
        await expect(service.reissue("cn-old", { amount: 10 }, "k", "u")).rejects.toThrow(
          new ConflictException("This credit's source invoice was deleted; it can't be edited."),
        );
        noWrites();
      });

      it("#2848: a note with a SOURCE_DELETED marker is refused entirely, even at <= its amount", async () => {
        prisma.creditNote.findFirst.mockResolvedValue({ ...ORPHAN });
        prisma.auditLog.findFirst.mockResolvedValue({ id: "al-1" });
        await expect(
          service.reissue(
            "cn-old",
            { amount: 10, expiresAt: "2999-01-01T00:00:00.000Z" },
            "k",
            "u",
          ),
        ).rejects.toThrow(
          new ConflictException("This credit's source invoice was deleted; it can't be edited."),
        );
        expect(prisma.auditLog.findFirst).toHaveBeenCalledWith({
          where: { entityType: "CreditNote", entityId: "cn-old", action: "SOURCE_DELETED" },
          select: { id: true },
        });
        noWrites();
      });

      it("#2848 (SA-608f): the marker is ALSO checked inside the tx, so a concurrent deleteInvoice refuses rather than caps", async () => {
        // The pre-check sees no marker; by the time the tx holds the locks, deleteInvoice has committed it.
        prisma.auditLog.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: "al-1" });
        await expect(
          service.reissue("cn-old", { amount: 10 }, "k", "u"), // sourced at pre-read, <= the old amount
        ).rejects.toThrow(
          new ConflictException("This credit's source invoice was deleted; it can't be edited."),
        );
        expect(creditNotes.insertCreditNoteInTx).not.toHaveBeenCalled();
        expect(idem.save).not.toHaveBeenCalled();
      });

      it("#2848 (SA-608f) + PR-C: the IN-TX marker refusal also carries CREDIT_NOTE_SOURCE_GONE (409)", async () => {
        prisma.auditLog.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: "al-1" });
        const err: any = await service
          .reissue("cn-old", { amount: 10 }, "k", "u")
          .catch((e: unknown) => e);
        expect(err?.getStatus?.()).toBe(409);
        expect(codeOf(err)).toBe(CODES.CREDIT_NOTE_SOURCE_GONE);
      });

      it("#2848 + PR-C: a SOURCE_DELETED marker refusal carries CREDIT_NOTE_SOURCE_GONE (409)", async () => {
        prisma.creditNote.findFirst.mockResolvedValue({ ...ORPHAN });
        prisma.auditLog.findFirst.mockResolvedValue({ id: "al-1" });
        const err: any = await service
          .reissue("cn-old", { amount: 10 }, "k", "u")
          .catch((e: unknown) => e);
        expect(err?.getStatus?.()).toBe(409);
        expect(codeOf(err)).toBe(CODES.CREDIT_NOTE_SOURCE_GONE);
      });

      it("a sourced note is not subject to the no-invoice cap", async () => {
        await service.reissue("cn-old", { amount: 9999 }, "k", "u"); // OLD is $50 with invoiceId
        expect(creditNotes.insertCreditNoteInTx).toHaveBeenCalledTimes(1);
      });
    });

    it("a source invoice that is gone or no longer creditable stays a 409", async () => {
      creditNotes.validateAndBuildCnItems.mockRejectedValueOnce(
        cnBad(CODES.CREDIT_NOTE_SOURCE_GONE, "Invoice not found"),
      );
      await expect(service.reissue("cn-old", { amount: 20 }, "key-1", "u")).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe("PR-C: every refusal carries its CREDIT_NOTE_* code and status", () => {
    const p2034 = () => Object.assign(new Error("write conflict"), { code: "P2034" });
    const run = (over: Record<string, unknown> = {}, key: string | undefined = "k") =>
      service.reissue("cn-old", { amount: 20, ...over } as any, key || undefined, "u").then(
        () => null,
        (e: unknown) => e as any,
      );
    const expectRefusal = async (err: any, code: string, status: number) => {
      expect(err?.getStatus?.()).toBe(status);
      expect(codeOf(err)).toBe(code);
    };

    it("no Idempotency-Key => KEY_REQUIRED 400", async () => {
      await expectRefusal(await run({}, ""), CODES.CREDIT_NOTE_KEY_REQUIRED, 400);
    });
    it("a VOID note => VOID_NOT_EDITABLE 409", async () => {
      prisma.creditNote.findFirst.mockResolvedValue({ ...OLD, status: "VOID" });
      await expectRefusal(await run(), CODES.CREDIT_NOTE_VOID_NOT_EDITABLE, 409);
    });
    it("a live return-backed note => RETURN_BACKED 409", async () => {
      prisma.return.findFirst.mockResolvedValue({ returnNumber: "RET-1" });
      await expectRefusal(await run(), CODES.CREDIT_NOTE_RETURN_BACKED, 409);
    });
    it("credit consumed out of reach => CREDIT_CONSUMED 409 (pre-tx)", async () => {
      creditNotes.voidWithReversalRefusal.mockResolvedValue({
        code: CODES.CREDIT_NOTE_CREDIT_CONSUMED,
        message: "consumed",
      });
      await expectRefusal(await run(), CODES.CREDIT_NOTE_CREDIT_CONSUMED, 409);
    });
    it("an orphan with line rows (its source was deleted) => SOURCE_GONE 409", async () => {
      prisma.creditNote.findFirst.mockResolvedValue({ ...OLD, invoiceId: null });
      prisma.creditNoteItem.count.mockResolvedValue(1);
      await expectRefusal(await run(), CODES.CREDIT_NOTE_SOURCE_GONE, 409);
    });
    it("no-invoice note increased => NO_SOURCE_CAP 409", async () => {
      prisma.creditNote.findFirst.mockResolvedValue({ ...OLD, invoiceId: null, amount: 50 });
      await expectRefusal(await run({ amount: 60 }), CODES.CREDIT_NOTE_NO_SOURCE_CAP, 409);
    });
    it("cap refusals keep their code but become 409: OVER_HEADROOM, SOURCE_GONE", async () => {
      creditNotes.validateAndBuildCnItems.mockRejectedValueOnce(
        cnBad(CODES.CREDIT_NOTE_OVER_HEADROOM, "would exceed"),
      );
      await expectRefusal(await run(), CODES.CREDIT_NOTE_OVER_HEADROOM, 409);
      creditNotes.validateAndBuildCnItems.mockRejectedValueOnce(
        cnBad(CODES.CREDIT_NOTE_SOURCE_GONE, "Invoice not found"),
      );
      await expectRefusal(await run(), CODES.CREDIT_NOTE_SOURCE_GONE, 409);
    });
    it("a malformed line keeps LINE_INVALID 400", async () => {
      creditNotes.validateAndBuildCnItems.mockRejectedValueOnce(
        cnBad(CODES.CREDIT_NOTE_LINE_INVALID, "bad line"),
      );
      await expectRefusal(
        await run({ items: [{ invoiceItemId: "li", amount: 20 }] }),
        CODES.CREDIT_NOTE_LINE_INVALID,
        400,
      );
    });
    it("lines on a no-invoice note => LINE_INVALID 400", async () => {
      prisma.creditNote.findFirst.mockResolvedValue({ ...OLD, invoiceId: null });
      await expectRefusal(
        await run({ items: [{ invoiceItemId: "li", amount: 20 }] }),
        CODES.CREDIT_NOTE_LINE_INVALID,
        400,
      );
    });
    it("a line-linked note without lines => LINES_REQUIRED 400", async () => {
      prisma.creditNoteItem.count.mockResolvedValue(2);
      await expectRefusal(await run(), CODES.CREDIT_NOTE_LINES_REQUIRED, 400);
    });
    it("an expired note without a new expiry, or a past expiresAt => EXPIRY_PAST 400", async () => {
      prisma.creditNote.findFirst.mockResolvedValue({ ...OLD, expiresAt: new Date("2020-01-01") });
      await expectRefusal(await run(), CODES.CREDIT_NOTE_EXPIRY_PAST, 400);
      prisma.creditNote.findFirst.mockResolvedValue({ ...OLD });
      await expectRefusal(
        await run({ expiresAt: "2020-01-01T00:00:00.000Z" }),
        CODES.CREDIT_NOTE_EXPIRY_PAST,
        400,
      );
    });
    it("exhausted retries, a number collision, or a void that raced => CHANGED_CONCURRENTLY 409", async () => {
      creditNotes.voidWithReversalInTx.mockRejectedValue(p2034());
      await expectRefusal(await run(), CODES.CREDIT_NOTE_CHANGED_CONCURRENTLY, 409);
      creditNotes.voidWithReversalInTx.mockReset();
      creditNotes.voidWithReversalInTx.mockResolvedValue({ creditNote: {}, reopened: [] });
      creditNotes.insertCreditNoteInTx.mockRejectedValueOnce(
        Object.assign(new Error("u"), { code: "P2002" }),
      );
      await expectRefusal(await run(), CODES.CREDIT_NOTE_CHANGED_CONCURRENTLY, 409);
      creditNotes.voidWithReversalInTx.mockRejectedValueOnce(
        cnBad(CODES.CREDIT_NOTE_CHANGED_CONCURRENTLY, "changed while it was being voided"),
      );
      await expectRefusal(await run(), CODES.CREDIT_NOTE_CHANGED_CONCURRENTLY, 409);
    });
    it("a void that raced onto a return keeps the reissue's RETURN_BACKED 409", async () => {
      creditNotes.voidWithReversalInTx.mockRejectedValueOnce(
        cnBad(CODES.CREDIT_NOTE_RETURN_BACKED, "backs a return (RET-5)"),
      );
      await expectRefusal(await run(), CODES.CREDIT_NOTE_RETURN_BACKED, 409);
    });
    it("the same key with a different body => KEY_REUSED 409", async () => {
      idem.check.mockResolvedValue({
        fingerprint: "other",
        response: { voided: {}, creditNote: {}, unapplied: [] },
      });
      await expectRefusal(await run(), CODES.CREDIT_NOTE_KEY_REUSED, 409);
    });
  });

  it("SA-535b(1): the dry run excludes the old note; the in-tx re-cap after the void does not", async () => {
    await service.reissue("cn-old", { amount: 20 }, "key-1", "user-1");

    const [dry, recap] = creditNotes.validateAndBuildCnItems.mock.calls;
    expect(dry[1]).toEqual({
      customerId: "cust-1",
      invoiceId: "inv-1",
      amount: 20,
      items: undefined,
    });
    expect(dry[2]).toEqual({ excludeCreditNoteId: "cn-old" });
    expect(recap[2]).toBeUndefined();
  });

  it("a refused dry run is a 409 and never reserves a number (no number burned)", async () => {
    creditNotes.validateAndBuildCnItems.mockRejectedValueOnce(
      cnBad(
        CODES.CREDIT_NOTE_OVER_HEADROOM,
        "Credit note amount (99) would exceed invoice total (50).",
      ),
    );

    await expect(service.reissue("cn-old", { amount: 99 }, "key-1", "u")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(numbering.reserveNext).not.toHaveBeenCalled();
    expect(creditNotes.voidWithReversalInTx).not.toHaveBeenCalled();
  });

  it("the in-tx re-cap refusing after the void is a 409 (the reserved number burns, like create())", async () => {
    creditNotes.validateAndBuildCnItems
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(cnBad(CODES.CREDIT_NOTE_OVER_HEADROOM, "would exceed invoice total"));

    await expect(service.reissue("cn-old", { amount: 20 }, "key-1", "u")).rejects.toThrow(
      new ConflictException("would exceed invoice total"),
    );
    expect(numbering.reserveNext).toHaveBeenCalledTimes(1);
    expect(creditNotes.insertCreditNoteInTx).not.toHaveBeenCalled();
    expect(idem.save).not.toHaveBeenCalled();
  });

  it("SA-535a(1): a live return-backed note is a 409 'edit the return instead', before any write", async () => {
    prisma.return.findFirst.mockResolvedValue({ returnNumber: "RET-0004" });

    await expect(service.reissue("cn-old", { amount: 20 }, "key-1", "u")).rejects.toThrow(
      new ConflictException("This credit note backs a return (RET-0004). Edit the return instead."),
    );
    expect(prisma.return.findFirst).toHaveBeenCalledWith({
      where: { creditNoteId: "cn-old", status: { notIn: ["CANCELLED", "REJECTED"] } },
      select: { returnNumber: true },
    });
    expect(numbering.reserveNext).not.toHaveBeenCalled();
    expect(creditNotes.voidWithReversalInTx).not.toHaveBeenCalled();
  });

  it("a void refusal only a race reaches is re-mapped to 409; the return case keeps the reissue copy", async () => {
    creditNotes.voidWithReversalInTx.mockRejectedValueOnce(
      cnBad(
        CODES.CREDIT_NOTE_RETURN_BACKED,
        "This credit note backs a return (RET-0005). Cancel the return instead of voiding its credit.",
      ),
    );
    await expect(service.reissue("cn-old", { amount: 20 }, "key-1", "u")).rejects.toThrow(
      new ConflictException("This credit note backs a return (RET-0005). Edit the return instead."),
    );

    creditNotes.voidWithReversalInTx.mockRejectedValueOnce(
      cnBad(
        CODES.CREDIT_NOTE_CHANGED_CONCURRENTLY,
        "This credit note changed while it was being voided. Nothing was changed; try again.",
      ),
    );
    await expect(service.reissue("cn-old", { amount: 20 }, "key-2", "u")).rejects.toThrow(
      new ConflictException(
        "This credit note changed while it was being voided. Nothing was changed; try again.",
      ),
    );
  });

  it("a VOID note is a 409; a missing Idempotency-Key is a 400", async () => {
    await expect(service.reissue("cn-old", { amount: 20 }, undefined, "u")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.reissue("cn-old", { amount: 20 }, "  ", "u")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    prisma.creditNote.findFirst.mockResolvedValue({ ...OLD, status: "VOID" });
    await expect(service.reissue("cn-old", { amount: 20 }, "key-1", "u")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(numbering.reserveNext).not.toHaveBeenCalled();
  });

  it("SA-535a(2): SUPERSEDED on the old note and REISSUED on the new one, in the same tx", async () => {
    await service.reissue("cn-old", { amount: 20 }, "key-1", "user-1");

    expect(auditActions()).toEqual(["SUPERSEDED", "REISSUED"]);
    expect(auditOf("SUPERSEDED")).toEqual({
      tenantId: "test-tenant",
      userId: "user-1",
      action: "SUPERSEDED",
      entityType: "CreditNote",
      entityId: "cn-old",
      meta: { replacedById: "cn-new", replacedByNumber: "CN-2026-0012" },
    });
    expect(auditOf("REISSUED")).toEqual({
      tenantId: "test-tenant",
      userId: "user-1",
      action: "REISSUED",
      entityType: "CreditNote",
      entityId: "cn-new",
      meta: { replaces: "cn-old", replacesNumber: "CN-2026-0007", unapplied: REOPENED },
    });
  });

  it("idempotent replay: the same body returns the stored response, reserves nothing, writes nothing", async () => {
    const stored = {
      fingerprint: CreditNoteReissueService.fingerprint({ amount: 20 }),
      response: {
        voided: { id: "cn-old", creditNoteNumber: "CN-2026-0007" },
        creditNote: NEW,
        unapplied: [],
      },
    };
    idem.check.mockResolvedValue(stored);
    prisma.creditNote.findFirst.mockResolvedValue({ ...OLD, status: "VOID" }); // after the first run

    await expect(service.reissue("cn-old", { amount: 20 }, "key-1", "u")).resolves.toEqual(
      stored.response,
    );
    expect(idem.check).toHaveBeenCalledWith(
      "key-1",
      "test-tenant",
      "creditNoteReissue:cn-old",
      expect.anything(),
    );
    expect(numbering.reserveNext).not.toHaveBeenCalled();
    expect(creditNotes.voidWithReversalInTx).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(gateway.emitCreditNoteCreated).not.toHaveBeenCalled();
  });

  it("the same key with a different body is a 409", async () => {
    idem.check.mockResolvedValue({
      fingerprint: CreditNoteReissueService.fingerprint({ amount: 20 }),
      response: {},
    });
    await expect(service.reissue("cn-old", { amount: 25 }, "key-1", "u")).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("a replay racing inside the tx returns the stored response without voiding twice", async () => {
    const stored = {
      fingerprint: CreditNoteReissueService.fingerprint({ amount: 20 }),
      response: {
        voided: { id: "cn-old", creditNoteNumber: "CN-2026-0007" },
        creditNote: NEW,
        unapplied: [],
      },
    };
    idem.check.mockResolvedValueOnce(null).mockResolvedValueOnce(stored);

    await expect(service.reissue("cn-old", { amount: 20 }, "key-1", "u")).resolves.toEqual(
      stored.response,
    );
    expect(creditNotes.voidWithReversalInTx).not.toHaveBeenCalled();
    expect(gateway.emitCreditNoteVoided).not.toHaveBeenCalled();
  });

  it("saves the response under the key in the same tx as the mint, and emits only after", async () => {
    await service.reissue("cn-old", { amount: 20 }, "key-1", "u");

    const txOfMint = creditNotes.insertCreditNoteInTx.mock.calls[0][0];
    const [k, t, scope, stored, tx] = idem.save.mock.calls[0];
    expect([k, t, scope, tx]).toEqual([
      "key-1",
      "test-tenant",
      "creditNoteReissue:cn-old",
      txOfMint,
    ]);
    expect(stored.fingerprint).toBe(CreditNoteReissueService.fingerprint({ amount: 20 }));
    expect(idem.save.mock.invocationCallOrder[0]).toBeLessThan(
      gateway.emitCreditNoteCreated.mock.invocationCallOrder[0],
    );
    expect(gateway.emitCreditNoteVoided).toHaveBeenCalledWith("test-tenant", {
      creditNoteId: "cn-old",
      creditNoteNumber: "CN-2026-0007",
      customerId: "cust-1",
      amount: 30,
    });
  });

  describe("expiry and reason (SA-535b(2))", () => {
    const minted = () => creditNotes.insertCreditNoteInTx.mock.calls[0][1];

    it("an expired old note with no new expiry is a 400 'set a new expiry'", async () => {
      prisma.creditNote.findFirst.mockResolvedValue({
        ...OLD,
        expiresAt: new Date(Date.now() - 86_400_000),
      });
      await expect(service.reissue("cn-old", { amount: 20 }, "key-1", "u")).rejects.toThrow(
        /set a new expiry/,
      );
      expect(numbering.reserveNext).not.toHaveBeenCalled();
    });

    it("a future old expiry carries over when omitted; explicit null clears it", async () => {
      const future = new Date(Date.now() + 10 * 86_400_000);
      prisma.creditNote.findFirst.mockResolvedValue({ ...OLD, expiresAt: future });
      await service.reissue("cn-old", { amount: 20 }, "key-1", "u");
      expect(minted().expiresAt.getTime()).toBe(future.getTime());

      creditNotes.insertCreditNoteInTx.mockClear();
      await service.reissue("cn-old", { amount: 20, expiresAt: null }, "key-2", "u");
      expect(minted().expiresAt).toBeNull();
    });

    it("a past expiresAt in the body is a 400", async () => {
      await expect(
        service.reissue("cn-old", { amount: 20, expiresAt: "2020-01-01" }, "key-1", "u"),
      ).rejects.toThrow(new BadRequestException("expiresAt must be in the future"));
    });

    it("a new reason is prefixed; a carried 'Replaces' prefix is never chained", async () => {
      await service.reissue("cn-old", { amount: 20, reason: "Price fix" }, "key-1", "u");
      expect(minted().reason).toBe("Replaces CN-2026-0007 — Price fix");

      creditNotes.insertCreditNoteInTx.mockClear();
      prisma.creditNote.findFirst.mockResolvedValue({
        ...OLD,
        reason: "Replaces CN-2026-0003 — Damaged case",
      });
      await service.reissue("cn-old", { amount: 20 }, "key-2", "u");
      expect(minted().reason).toBe("Replaces CN-2026-0007 — Damaged case");
    });

    it("a line-linked note must restate its lines (never silently drop the split)", async () => {
      prisma.creditNoteItem.count.mockResolvedValue(2);
      await expect(service.reissue("cn-old", { amount: 20 }, "key-1", "u")).rejects.toThrow(
        /give the new amount for each line/,
      );
      expect(prisma.creditNoteItem.count).toHaveBeenCalledWith({
        where: { creditNoteId: "cn-old", invoiceItemId: { not: null } },
      });
      expect(numbering.reserveNext).not.toHaveBeenCalled();

      const items = [{ invoiceItemId: "ii-1", amount: 20 }];
      await service.reissue("cn-old", { amount: 20, items }, "key-2", "u");
      expect(creditNotes.validateAndBuildCnItems.mock.calls[0][1].items).toEqual(items);
    });

    it("lines on a standalone note are a 400; a standalone note reissues standalone", async () => {
      prisma.creditNote.findFirst.mockResolvedValue({ ...OLD, invoiceId: null });
      await expect(
        service.reissue(
          "cn-old",
          { amount: 20, items: [{ invoiceItemId: "ii-1", amount: 20 }] },
          "key-1",
          "u",
        ),
      ).rejects.toThrow(new BadRequestException("Credit line items require a source invoice"));

      await service.reissue("cn-old", { amount: 20 }, "key-2", "u");
      expect(minted().invoiceId).toBeNull();
    });
  });
});

describe("validateAndBuildCnItems excludeCreditNoteId (SA-535b(1))", () => {
  let service: CreditNotesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: {} },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: CommissionEngineService, useValue: {} },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
    // A $50 invoice already fully credited by the note being reissued (cn-old, $50).
    prisma.invoice.findFirst.mockResolvedValue({
      total: 50,
      customerId: "cust-1",
      status: "SENT",
      items: [{ id: "ii-1", subtotal: 50, qty: 5, trackedCategoryId: null, categoryTaxAmount: 0 }],
    });
    prisma.creditNote.aggregate.mockImplementation(async (args: any) => ({
      _sum: { amount: args.where.id?.not === "cn-old" ? 0 : 50 },
    }));
    prisma.creditNoteItem.findMany.mockImplementation(async (args: any) =>
      args.where.creditNote.id?.not === "cn-old"
        ? []
        : [{ invoiceItemId: "ii-1", amount: 50, qty: 5 }],
    );
  });
  const dto = (amount: number, items?: any[]) => ({
    customerId: "cust-1",
    invoiceId: "inv-1",
    amount,
    items,
  });

  describe("PR-C: validateAndBuildCnItems refusals carry their CREDIT_NOTE_* code", () => {
    const codeFrom = async (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => codeOf(e),
      );

    it("over the invoice total (prior credits) => OVER_HEADROOM", async () => {
      expect(await codeFrom(service.validateAndBuildCnItems(prisma, dto(10)))).toBe(
        CODES.CREDIT_NOTE_OVER_HEADROOM,
      );
    });
    it("the source invoice is missing, or dead (VOID) => SOURCE_GONE", async () => {
      prisma.invoice.findFirst.mockResolvedValueOnce(null);
      expect(await codeFrom(service.validateAndBuildCnItems(prisma, dto(10)))).toBe(
        CODES.CREDIT_NOTE_SOURCE_GONE,
      );
      prisma.invoice.findFirst.mockResolvedValueOnce({
        total: 50,
        customerId: "cust-1",
        status: "VOID",
        items: [],
      });
      expect(
        await codeFrom(
          service.validateAndBuildCnItems(prisma, dto(10), { excludeCreditNoteId: "cn-old" }),
        ),
      ).toBe(CODES.CREDIT_NOTE_SOURCE_GONE);
    });
    it("a line that is not on the invoice, or amounts that do not sum => LINE_INVALID", async () => {
      const ex = { excludeCreditNoteId: "cn-old" };
      expect(
        await codeFrom(
          service.validateAndBuildCnItems(
            prisma,
            dto(10, [{ invoiceItemId: "nope", amount: 10 }]),
            ex,
          ),
        ),
      ).toBe(CODES.CREDIT_NOTE_LINE_INVALID);
      expect(
        await codeFrom(
          service.validateAndBuildCnItems(
            prisma,
            dto(10, [{ invoiceItemId: "ii-1", amount: 4 }]),
            ex,
          ),
        ),
      ).toBe(CODES.CREDIT_NOTE_LINE_INVALID);
    });
    it("a line over its subtotal with NO prior credit => LINE_INVALID; WITH prior => OVER_HEADROOM", async () => {
      const ex = { excludeCreditNoteId: "cn-old" };
      expect(
        await codeFrom(
          service.validateAndBuildCnItems(
            prisma,
            dto(60, [{ invoiceItemId: "ii-1", amount: 60 }]),
            ex,
          ),
        ),
      ).toBe(CODES.CREDIT_NOTE_OVER_HEADROOM); // header cap first: 60 > 50
      prisma.invoice.findFirst.mockResolvedValue({
        total: 500,
        customerId: "cust-1",
        status: "SENT",
        items: [
          { id: "ii-1", subtotal: 50, qty: 5, trackedCategoryId: null, categoryTaxAmount: 0 },
        ],
      });
      prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
      prisma.creditNoteItem.findMany.mockResolvedValue([]);
      expect(
        await codeFrom(
          service.validateAndBuildCnItems(prisma, dto(60, [{ invoiceItemId: "ii-1", amount: 60 }])),
        ),
      ).toBe(CODES.CREDIT_NOTE_LINE_INVALID);
      prisma.creditNoteItem.findMany.mockResolvedValue([
        { invoiceItemId: "ii-1", amount: 30, qty: 3 },
      ]);
      expect(
        await codeFrom(
          service.validateAndBuildCnItems(prisma, dto(30, [{ invoiceItemId: "ii-1", amount: 30 }])),
        ),
      ).toBe(CODES.CREDIT_NOTE_OVER_HEADROOM);
    });
  });

  it("with the exclude, a fully-credited invoice passes a new amount ≤ its total, header and lines", async () => {
    await expect(
      service.validateAndBuildCnItems(prisma, dto(50), { excludeCreditNoteId: "cn-old" }),
    ).resolves.toEqual([]);
    await expect(
      service.validateAndBuildCnItems(prisma, dto(40, [{ invoiceItemId: "ii-1", amount: 40 }]), {
        excludeCreditNoteId: "cn-old",
      }),
    ).resolves.toHaveLength(1);
  });

  it("with the exclude, a new amount above the invoice total still refuses", async () => {
    await expect(
      service.validateAndBuildCnItems(prisma, dto(50.01), { excludeCreditNoteId: "cn-old" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("without the exclude (create(), the in-tx re-cap) the old note still counts", async () => {
    await expect(service.validateAndBuildCnItems(prisma, dto(10))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.creditNote.aggregate.mock.calls[0][0].where).toEqual({
      invoiceId: "inv-1",
      status: { not: "VOID" },
    });
  });

  it("the exclude reaches BOTH caps (header aggregate AND priorLineItems)", async () => {
    // Header has room only because of the exclude; the line cap must see it too or it refuses.
    await service.validateAndBuildCnItems(
      prisma,
      dto(50, [{ invoiceItemId: "ii-1", amount: 50 }]),
      {
        excludeCreditNoteId: "cn-old",
      },
    );
    expect(prisma.creditNote.aggregate.mock.calls[0][0].where.id).toEqual({ not: "cn-old" });
    expect(prisma.creditNoteItem.findMany.mock.calls[0][0].where.creditNote.id).toEqual({
      not: "cn-old",
    });
  });
});

describe("CreditNotesController — POST :id/reissue roles (#2648)", () => {
  const guard = new RolesGuard(new Reflector());
  const ctx = (role: UserRole) =>
    ({
      getHandler: () => CreditNotesController.prototype.reissue,
      getClass: () => CreditNotesController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    }) as any;

  it.each([UserRole.OPERATOR, UserRole.TENANT_ADMIN])("%s may reissue", (role) => {
    expect(guard.canActivate(ctx(role))).toBe(true);
  });

  it.each([UserRole.DRIVER, UserRole.CUSTOMER])("%s may not", (role) => {
    expect(guard.canActivate(ctx(role))).toBe(false);
  });
});
