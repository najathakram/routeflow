import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { NumberingService } from "./numbering.service";

describe("NumberingService", () => {
  let service: NumberingService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [NumberingService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(NumberingService);
  });

  describe("format", () => {
    it("zero-pads to the configured width", () => {
      expect(service.format("INV-", 42, 5)).toBe("INV-00042");
    });
    it("does not truncate numbers longer than the padding", () => {
      expect(service.format("INV-", 123456, 4)).toBe("INV-123456");
    });
    it("padding 0 means no padding", () => {
      expect(service.format("", 7, 0)).toBe("7");
    });
  });

  describe("parseDocumentNumber", () => {
    it("splits prefix, number and padding off the trailing digits", () => {
      expect(service.parseDocumentNumber("INV-08841")).toEqual({
        prefix: "INV-",
        number: 8841,
        padding: 5,
      });
    });
    it("handles a bare number", () => {
      expect(service.parseDocumentNumber("42")).toEqual({ prefix: "", number: 42, padding: 2 });
    });
    it("returns null when there is no trailing number", () => {
      expect(service.parseDocumentNumber("DRAFT")).toBeNull();
    });
  });

  describe("getSettings", () => {
    it("returns all four doc types, defaulting the unconfigured ones", async () => {
      prisma.numberingSequence.findMany.mockResolvedValue([
        { docType: "INVOICE", prefix: "INV-", nextNumber: 8842, padding: 5 },
      ]);
      const settings = await service.getSettings();
      expect(settings.map((s) => s.docType)).toEqual([
        "INVOICE",
        "ESTIMATE",
        "CREDIT_NOTE",
        "PAYMENT",
      ]);
      const invoice = settings.find((s) => s.docType === "INVOICE")!;
      expect(invoice).toMatchObject({ preview: "INV-08842", configured: true });
      const estimate = settings.find((s) => s.docType === "ESTIMATE")!;
      expect(estimate).toMatchObject({ preview: "EST-0001", configured: false });
      // B100/F16b: the card describes the CONFIGURED (year-0) series only — the
      // per-year rows live minting creates must not be read here.
      expect(prisma.numberingSequence.findMany).toHaveBeenCalledWith({ where: { year: 0 } });
    });

    it("ignores the per-year INVOICE rows live minting creates (B100/F16b)", async () => {
      // The `where: { year: 0 }` scope filters them out at the DB, so the service
      // sees no INVOICE row at all and reports the unconfigured default.
      prisma.numberingSequence.findMany.mockResolvedValue([]);
      const settings = await service.getSettings();
      const invoice = settings.find((s) => s.docType === "INVOICE")!;
      expect(invoice).toMatchObject({
        nextNumber: 1,
        preview: "INV-0001",
        configured: false,
      });
    });
  });

  describe("updateSettings", () => {
    it("upserts the sequence and returns the new preview", async () => {
      prisma.numberingSequence.upsert.mockResolvedValue({
        docType: "INVOICE",
        prefix: "INV-",
        nextNumber: 9000,
        padding: 4,
      });
      const row = await service.updateSettings("INVOICE", { nextNumber: 9000 });
      expect(prisma.numberingSequence.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenantId_docType_year: { tenantId: "test-tenant", docType: "INVOICE", year: 0 },
          },
          update: { nextNumber: 9000 },
        }),
      );
      expect(row.preview).toBe("INV-9000");
    });

    it("throws without a tenant context", async () => {
      prisma.getTenantId.mockReturnValue(null);
      await expect(service.updateSettings("INVOICE", { nextNumber: 1 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe("seedFromSource", () => {
    it("continues from the source's last number (INV-08841 → next INV-08842)", async () => {
      prisma.numberingSequence.upsert.mockResolvedValue({
        docType: "INVOICE",
        prefix: "INV-",
        nextNumber: 8842,
        padding: 5,
      });
      const row = await service.seedFromSource("INVOICE", "INV-08841");
      expect(prisma.numberingSequence.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ prefix: "INV-", nextNumber: 8842, padding: 5 }),
        }),
      );
      expect(row.preview).toBe("INV-08842");
    });

    it("rejects a source number it cannot parse", async () => {
      await expect(service.seedFromSource("INVOICE", "n/a")).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  // B100/F16b: reserveNext grows a `{ year?, tx?, tenantId? }` options object (was a
  // caller-supplied `exists` predicate) and returns the formatted number as a plain
  // string (was `{ number, advanced }`) — see cause-ruling.md §2 D1 and the
  // bug-test-plan's harness notes. The tests below replace the pre-B100
  // fast-path/collision-guard/cap-exceeded trio, which pinned the retired predicate
  // design. The collision guard and the attempt cap are re-pinned HERE against the
  // new jump design (the "jumps past an out-of-band imported block" and "cap" tests
  // below) — a mutation that deletes the `invoice.findFirst` clash check must go red
  // in this lane, not only in the DB lane, which never reproduces a taken candidate.
  // The DB lane (REG-B100-B/C/D in invoice-numbering.db.spec.ts) still owns the
  // concurrency/tenancy claims, per L-061 — those are only provable against a real
  // Postgres.
  describe("reserveNext — B100/F16b pins", () => {
    it("P1: formats INV-<year>-NNNN (padded to 4) from opts.year — nextNumber 38 -> INV-2026-0038", async () => {
      prisma.numberingSequence.upsert.mockResolvedValue({
        prefix: "INV-",
        padding: 4,
        nextNumber: 38,
      });
      prisma.numberingSequence.findUnique.mockResolvedValue({
        prefix: "INV-",
        padding: 4,
        nextNumber: 38,
      });
      prisma.numberingSequence.update.mockResolvedValue({ nextNumber: 39 });

      // `as any`: the pre-B100 signature types this second argument as a predicate
      // function, not the year-scoped options object D1 introduces — the cast keeps
      // this file compiling under ts-jest ahead of the P1 implementation while still
      // exercising the real (currently non-conforming) runtime call.
      // Padding half, checkable TODAY through the already-public helper: 38 pads to four
      // digits. Without this the two P1 tests are indistinguishable pre-implementation — both
      // die on the same `exists is not a function` inside the unchanged SUT.
      expect(service.format("INV-", 38, 4)).toBe("INV-0038");

      await expect(service.reserveNext("INVOICE", { year: 2026 } as any)).resolves.toBe(
        "INV-2026-0038",
      );
    });

    it("P1: widens past 4 digits rather than truncating — nextNumber 10001 -> INV-2026-10001", async () => {
      prisma.numberingSequence.upsert.mockResolvedValue({
        prefix: "INV-",
        padding: 4,
        nextNumber: 10001,
      });
      prisma.numberingSequence.findUnique.mockResolvedValue({
        prefix: "INV-",
        padding: 4,
        nextNumber: 10001,
      });
      prisma.numberingSequence.update.mockResolvedValue({ nextNumber: 10002 });

      // Widening half, checkable TODAY: past the 4-digit width the number grows, never
      // truncates — the property the …-10001 oracle below extends to the year-scoped format.
      expect(service.format("INV-", 10001, 4)).toBe("INV-10001");

      await expect(service.reserveNext("INVOICE", { year: 2026 } as any)).resolves.toBe(
        "INV-2026-10001",
      );
    });

    it("P2: reserveNext(docType) with no year keys year:0 and formats with no year segment (byte-identical to the pre-B100 series)", async () => {
      prisma.numberingSequence.upsert.mockResolvedValue({
        prefix: "INV-",
        padding: 4,
        nextNumber: 5,
      });
      prisma.numberingSequence.update.mockResolvedValue({ nextNumber: 6 });

      const result = await service.reserveNext("INVOICE");

      // Pre-B100 this resolves to { number: "INV-0005", advanced: false } — an
      // object, not the plain string D1 returns — so this fails on the shape until
      // P1 lands, exactly like every other reserveNext caller.
      expect(result).toBe("INV-0005");
    });

    // Helper: drive the year-scoped INVOICE mint through a tx the test controls
    // (the shared mock builds a throwaway `$queryRaw` per tenantTransaction call).
    const withTx = (tx: any) => {
      prisma.tenantTransaction.mockImplementation((fn: any) => fn(tx));
      return tx;
    };

    it("logs the seed decision with tenant, year, scanned max and seeded next", async () => {
      const tx = withTx({
        numberingSequence: {
          findUnique: jest.fn().mockResolvedValue(null),
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValue({ prefix: "INV-", padding: 4, nextNumber: 413 }),
          update: jest.fn().mockResolvedValue({ nextNumber: 414 }),
        },
        invoice: { findFirst: jest.fn().mockResolvedValue(null) },
        $queryRaw: jest.fn().mockResolvedValue([{ max: 412 }]),
        $executeRaw: jest.fn().mockResolvedValue(0),
      });
      const log = jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);

      await expect(service.reserveNext("INVOICE", { year: 2026 })).resolves.toBe("INV-2026-0413");

      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0][0]);
      expect(line).toContain("test-tenant");
      expect(line).toContain("2026");
      expect(line).toContain("412");
      expect(tx.$queryRaw).toHaveBeenCalled();
    });

    it("jumps past an out-of-band imported block in one update instead of skipping number by number", async () => {
      // Sequence sits at 51; an import wrote INV-2026-0051..0300 out of band.
      const taken = new Set(
        Array.from({ length: 250 }, (_, i) => `INV-2026-${String(51 + i).padStart(4, "0")}`),
      );
      let nextNumber = 51;
      const update = jest.fn(async ({ data }: any) => {
        nextNumber = data.nextNumber?.increment
          ? nextNumber + data.nextNumber.increment
          : data.nextNumber;
        return { nextNumber };
      });
      // The jump is a raw `GREATEST` UPDATE (fix-round-2b.md D8), so this mock has to
      // model Postgres' semantics — monotonic, never a rewind — for the loop below to
      // terminate the way the real statement makes it terminate.
      const jumps: Array<{ sql: string; values: any[] }> = [];
      const executeRaw = jest.fn(async (strings: any, ...values: any[]) => {
        const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
        if (sql.includes("UPDATE")) {
          jumps.push({ sql, values });
          nextNumber = Math.max(nextNumber, Number(values[0]));
        }
        return 0;
      });
      withTx({
        numberingSequence: {
          findUnique: jest.fn().mockResolvedValue({ prefix: "INV-", padding: 4, nextNumber: 51 }),
          findUniqueOrThrow: jest.fn(),
          update,
        },
        invoice: {
          findFirst: jest.fn(async ({ where }: any) =>
            taken.has(where.invoiceNumber) ? { id: "x" } : null,
          ),
        },
        $queryRaw: jest.fn().mockResolvedValue([{ max: 300 }]),
        $executeRaw: executeRaw,
      });
      const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);

      await expect(service.reserveNext("INVOICE", { year: 2026 })).resolves.toBe("INV-2026-0301");
      // One clash → ONE jump statement straight to max+1, not 250 increments: two
      // increments total (the clashing 51 and the free 301).
      expect(update).toHaveBeenCalledTimes(2);
      // D8: the jump is `GREATEST("nextNumber", <target>)` — monotonic, so a third
      // mint that raced past `target` between the scan and this write is never
      // rewound onto a number it already issued.
      expect(jumps).toHaveLength(1);
      expect(jumps[0].sql).toContain("GREATEST");
      expect(jumps[0].values[0]).toBe(301);
      // The skip is never silent: exactly one warning, naming the tenant. Deleting the
      // clash check makes this zero (and the number above the taken INV-2026-0051).
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("test-tenant");
    });

    // D7 (fix-round-2b.md): the delivery path is already inside a transaction, so it
    // hands its own client in. The reservation must then run THERE and open nothing —
    // a nested `$transaction` would need a second pooled connection while the caller
    // holds one (REG-B100-C, 7/10 rejected). `tenantTransaction` is deliberately left
    // on its default (call-through) mock: an accidental nested open would still work
    // at runtime here, so only the "not called" assertion catches it.
    it("D7: with opts.tx the mint runs on THAT client and opens no transaction of its own", async () => {
      const tx = {
        numberingSequence: {
          findUnique: jest.fn().mockResolvedValue({ prefix: "INV-", padding: 4, nextNumber: 38 }),
          findUniqueOrThrow: jest.fn(),
          update: jest.fn().mockResolvedValue({ nextNumber: 39 }),
        },
        invoice: { findFirst: jest.fn().mockResolvedValue(null) },
        $queryRaw: jest.fn().mockResolvedValue([{ max: 0 }]),
        $executeRaw: jest.fn().mockResolvedValue(0),
      };

      await expect(service.reserveNext("INVOICE", { year: 2026, tx: tx as any })).resolves.toBe(
        "INV-2026-0038",
      );

      expect(tx.numberingSequence.update).toHaveBeenCalledTimes(1);
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      // …and nothing leaked onto the base client (which, inside a caller's tx, would
      // be a second pooled connection).
      expect(prisma.numberingSequence.update).not.toHaveBeenCalled();
      expect(prisma.numberingSequence.findUnique).not.toHaveBeenCalled();
    });

    it("cap: throws ConflictException rather than looping when every jump still clashes", async () => {
      // Pathological tenant: every candidate the sequence hands back is already taken,
      // and the scanned max never moves the sequence forward. The mint must give up
      // with a ConflictException instead of spinning — and must never return a number
      // an Invoice row already carries.
      const update = jest.fn().mockResolvedValue({ nextNumber: 302 });
      const findFirst = jest.fn().mockResolvedValue({ id: "x" });
      withTx({
        numberingSequence: {
          findUnique: jest.fn().mockResolvedValue({ prefix: "INV-", padding: 4, nextNumber: 301 }),
          findUniqueOrThrow: jest.fn(),
          update,
        },
        invoice: { findFirst },
        $queryRaw: jest.fn().mockResolvedValue([{ max: 300 }]),
        $executeRaw: jest.fn().mockResolvedValue(0),
      });
      jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);

      await expect(service.reserveNext("INVOICE", { year: 2026 })).rejects.toBeInstanceOf(
        ConflictException,
      );
      // Bounded: at most two writes (increment + jump) per attempt, MINT_MAX_ATTEMPTS = 5.
      expect(update.mock.calls.length).toBeLessThanOrEqual(10);
      expect(findFirst).toHaveBeenCalled();
    });

    it("P3: uses opts.tenantId when there is no request tenant, and refuses only when neither is present", async () => {
      // The NEW half first (red pre-B100: the retired signature took a predicate as the
      // second argument and requireTenant() read no opts, so it threw before any
      // opts.tenantId could be honoured).
      prisma.getTenantId.mockReturnValue(null);
      prisma.numberingSequence.findUnique.mockResolvedValue({
        prefix: "INV-",
        padding: 4,
        nextNumber: 7,
      });
      prisma.numberingSequence.update.mockResolvedValue({ nextNumber: 8 });
      prisma.invoice.findFirst.mockResolvedValue(null);

      await expect(
        service.reserveNext("INVOICE", { year: 2026, tenantId: "tenant-x" }),
      ).resolves.toBe("INV-2026-0007");
      expect(prisma.numberingSequence.findUnique).toHaveBeenCalledWith({
        where: {
          tenantId_docType_year: { tenantId: "tenant-x", docType: "INVOICE", year: 2026 },
        },
      });

      // …and only with NEITHER source does it refuse. requireTenant() throws before any
      // write — no "singleton"-style row (the PaymentCounter anti-pattern,
      // docs/IMPROVEMENTS.md:508-510) ever lands.
      prisma.numberingSequence.findUnique.mockClear();
      prisma.numberingSequence.update.mockClear();
      prisma.numberingSequence.upsert.mockClear();

      await expect(service.reserveNext("INVOICE", { year: 2026 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.numberingSequence.findUnique).not.toHaveBeenCalled();
      expect(prisma.numberingSequence.update).not.toHaveBeenCalled();
      expect(prisma.numberingSequence.upsert).not.toHaveBeenCalled();
    });
  });
});
