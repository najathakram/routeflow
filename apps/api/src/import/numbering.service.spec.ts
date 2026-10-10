import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { NumberingService } from "./numbering.service";

/**
 * REG-B861 shared fixture (build-plan.md FIX1/cause-ruling.md §3): models the
 * Postgres surface `reserveNext`/`getSettings`/`updateSettings` hit for the
 * SA-274 configured (year-0) series precisely enough to drive BOTH today's
 * pre-fix per-year mint (so a red run reaches its wrong value, e.g.
 * "INV-2026-0001", instead of throwing) and the planned max-first configured
 * mint. `numberingSequence.findUnique` answers purely by the requested
 * `year` — 0 → `savedRow` (the card's row), anything else → `perYearRow` —
 * never by docType, which is enough for every REG-B861 test since each one
 * only asserts a single docType's outcome.
 *
 * `$queryRaw`/`$executeRaw` both route through the same call inspector,
 * because the fix's exact choice of raw-query method is not yet written:
 *   - a statement containing `UPDATE` and `GREATEST` is the configured mint's
 *     "GREATEST(stored, target) + 1 RETURNING" — it advances `savedRow` and
 *     returns `[{ nextNumber, prefix, padding }]`.
 *   - a statement containing `regexp_match` is a max-scan — it runs the `^…`
 *     pattern value as a JS RegExp over `docs`, taking the max of capture
 *     group 1 across matches, and returns `[{ max }]`.
 *   - any other call whose values include a `^…` string is the "is this
 *     candidate taken" probe — returns `[{ number: <matched doc> }]` when a
 *     doc in `docs` matches, else `[]`.
 *   - anything else (e.g. the per-year lazy-seed INSERT) returns `[]`,
 *     unused by every REG-B861 test.
 * Never assert on the SQL text itself — only on reserveNext/getSettings/
 * updateSettings' observable return value.
 */
function buildNumberingFixture(
  opts: {
    savedRow?: { prefix: string; nextNumber: number; padding: number } | null;
    perYearRow?: { prefix: string; nextNumber: number; padding: number } | null;
    docs?: string[];
  } = {},
) {
  let saved = opts.savedRow ?? null;
  const perYear = opts.perYearRow ?? null;
  const docs = opts.docs ?? [];

  // TODAY's per-year surface (pre-fix `mintForYear`'s lazy seed), keyed by
  // docType so C's ESTIMATE case reaches "EST-2026-0001" rather than an
  // INVOICE-shaped value.
  const PER_YEAR_SEED_DEFAULTS: Record<string, { prefix: string; padding: number }> = {
    INVOICE: { prefix: "INV-", padding: 4 },
    ESTIMATE: { prefix: "EST-", padding: 4 },
    CREDIT_NOTE: { prefix: "CN-", padding: 4 },
  };

  const findUnique = jest.fn(({ where }: any) =>
    Promise.resolve(where.tenantId_docType_year.year === 0 ? saved : perYear),
  );

  const findUniqueOrThrow = jest.fn(({ where }: any) => {
    const docType = where.tenantId_docType_year.docType as string;
    return Promise.resolve({ ...PER_YEAR_SEED_DEFAULTS[docType], nextNumber: 1 });
  });

  const raw = jest.fn((strings: any, ...values: any[]) => {
    const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
    // SA-287b: the configured mint first locks the saved row (`SELECT … FOR UPDATE`).
    if (sql.includes("FOR UPDATE")) {
      return Promise.resolve(saved ? [{ ...saved }] : []);
    }
    if (sql.includes("UPDATE") && sql.includes("GREATEST")) {
      const target = values.find((v) => typeof v === "number") as number | undefined;
      const stored = saved?.nextNumber ?? 0;
      const nextNumber = Math.max(stored, target ?? 0) + 1;
      saved = {
        prefix: saved?.prefix ?? "",
        padding: saved?.padding ?? 0,
        nextNumber,
      };
      return Promise.resolve([{ nextNumber, prefix: saved.prefix, padding: saved.padding }]);
    }
    const pattern = values.find((v) => typeof v === "string" && v.startsWith("^")) as
      string | undefined;
    if (sql.includes("regexp_match")) {
      let max = 0;
      if (pattern) {
        const re = new RegExp(pattern);
        for (const doc of docs) {
          const m = re.exec(doc);
          if (m) max = Math.max(max, parseInt(m[1], 10));
        }
      }
      return Promise.resolve([{ max }]);
    }
    if (pattern) {
      const re = new RegExp(pattern);
      const match = docs.find((d) => re.test(d));
      return Promise.resolve(match ? [{ number: match }] : []);
    }
    return Promise.resolve([]);
  });

  return {
    numberingSequence: {
      findUnique,
      findUniqueOrThrow,
      update: jest.fn().mockResolvedValue({ nextNumber: 2 }),
      // The card's write paths, modelling the saved year-0 row: the compare-and-set /
      // first-create pair.
      create: jest.fn(({ data }: any) => {
        saved = { prefix: data.prefix, nextNumber: data.nextNumber, padding: data.padding };
        return Promise.resolve({ docType: data.docType, ...saved });
      }),
      updateMany: jest.fn(({ where, data }: any) => {
        if (!saved || (where.nextNumber !== undefined && saved.nextNumber !== where.nextNumber)) {
          return Promise.resolve({ count: 0 });
        }
        saved = { ...saved, ...data };
        return Promise.resolve({ count: 1 });
      }),
    },
    invoice: { findFirst: jest.fn().mockResolvedValue(null) },
    estimate: { findFirst: jest.fn().mockResolvedValue(null) },
    creditNote: { findFirst: jest.fn().mockResolvedValue(null) },
    $queryRaw: raw,
    $executeRaw: raw,
  };
}

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
    it("returns the card's doc types, defaulting the unconfigured ones", async () => {
      prisma.numberingSequence.findMany.mockResolvedValue([
        { docType: "INVOICE", prefix: "INV-", nextNumber: 8842, padding: 5 },
      ]);
      // SA-274: getSettings previews now scan the live document tables for the
      // true max inside a short tenantTransaction (max-first) — wire the shared
      // B861 fixture so that scan resolves `[{ max }]` instead of the default
      // mock's empty `$queryRaw` array. The doc-type-list and unconfigured
      // ESTIMATE-preview assertions moved to REG-B861-F / REG-B861-E.
      prisma.tenantTransaction.mockImplementation((fn: any) => fn(buildNumberingFixture()));
      const settings = await service.getSettings();
      const invoice = settings.find((s) => s.docType === "INVOICE")!;
      expect(invoice).toMatchObject({ preview: "INV-08842", configured: true });
      // Unchanged by SA-274: an unsaved row still reports configured:false (only its preview moved).
      const estimate = settings.find((s) => s.docType === "ESTIMATE")!;
      expect(estimate).toMatchObject({ configured: false });
      // B100/F16b: the card describes the CONFIGURED (year-0) series only — the
      // per-year rows live minting creates must not be read here.
      expect(prisma.numberingSequence.findMany).toHaveBeenCalledWith({ where: { year: 0 } });
    });

    it("ignores the per-year INVOICE rows live minting creates (B100/F16b)", async () => {
      // The `where: { year: 0 }` scope filters them out at the DB, so the service
      // sees no INVOICE row at all and reports the unconfigured default.
      prisma.numberingSequence.findMany.mockResolvedValue([]);
      // SA-274: the unconfigured preview is now the true next PER-YEAR number
      // (REG-B861-E/W own that value) — the stale "INV-0001" expectation is
      // dropped here; the year-0-only shape (nextNumber/configured) is pinned.
      prisma.tenantTransaction.mockImplementation((fn: any) => fn(buildNumberingFixture()));
      const settings = await service.getSettings();
      const invoice = settings.find((s) => s.docType === "INVOICE")!;
      expect(invoice).toMatchObject({
        nextNumber: 1,
        configured: false,
      });
    });
  });

  describe("updateSettings", () => {
    it("a first save carrying the card's loaded default token creates the row", async () => {
      // SA-287b: expectedNextNumber is required; an unsaved row's token is the default 1, and
      // the write is a plain create (a concurrent first save gets P2002 → 409, DB-lane pin).
      const tx = buildNumberingFixture();
      prisma.tenantTransaction.mockImplementation((fn: any) => fn(tx));
      const row = await service.updateSettings("INVOICE", {
        nextNumber: 9000,
        expectedNextNumber: 1,
      });
      expect(tx.numberingSequence.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: "test-tenant",
          docType: "INVOICE",
          prefix: "INV-",
          nextNumber: 9000,
          padding: 4,
        }),
      });
      expect(row.preview).toBe("INV-9000");
    });

    it("throws without a tenant context", async () => {
      prisma.getTenantId.mockReturnValue(null);
      await expect(service.updateSettings("INVOICE", { nextNumber: 1 })).rejects.toBeInstanceOf(
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
      // SA-274: reserveNext now checks the year-0 row FIRST (a configured card
      // row) before falling into the per-year mint — key this mock on the
      // requested year (0 → no saved row → unconfigured, as this pin assumes)
      // so it does not shadow the year-scoped `findUnique` this test drives.
      prisma.numberingSequence.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(
          where.tenantId_docType_year.year === 0
            ? null
            : { prefix: "INV-", padding: 4, nextNumber: 38 },
        ),
      );
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
      // SA-274: key on the requested year (0 → null, see the P1 test above).
      prisma.numberingSequence.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(
          where.tenantId_docType_year.year === 0
            ? null
            : { prefix: "INV-", padding: 4, nextNumber: 10001 },
        ),
      );
      prisma.numberingSequence.update.mockResolvedValue({ nextNumber: 10002 });

      // Widening half, checkable TODAY: past the 4-digit width the number grows, never
      // truncates — the property the …-10001 oracle below extends to the year-scoped format.
      expect(service.format("INV-", 10001, 4)).toBe("INV-10001");

      await expect(service.reserveNext("INVOICE", { year: 2026 } as any)).resolves.toBe(
        "INV-2026-10001",
      );
    });

    // P-3 (SA-274 retarget, was the INVOICE no-year case — that case is now
    // REG-B861-I, since a year-scoped docType with no saved row and no year
    // must THROW, not mint a bare year-0 fallback). RETURN is not year-scoped
    // (see `isYearScoped`), so it never touches the new configured-row check
    // and keeps this exact byte-identical fast path both before and after the
    // fix.
    it("P-3: reserveNext(docType) with no year keys year:0 and formats with no year segment for a non-year-scoped type (byte-identical to the pre-B100 series)", async () => {
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(0),
        numberingSequence: {
          upsert: jest.fn(),
          update: jest.fn().mockResolvedValue({ prefix: "RET-", padding: 4, nextNumber: 6 }),
        },
      };
      prisma.tenantTransaction.mockImplementation((fn: any) => fn(tx));

      const result = await service.reserveNext("RETURN");

      expect(result).toBe("RET-0005");
      expect(tx.numberingSequence.update).toHaveBeenCalledWith({
        where: { tenantId_docType_year: { tenantId: "test-tenant", docType: "RETURN", year: 0 } },
        data: { nextNumber: { increment: 1 } },
      });
    });

    // #2177 (SA-409): the fast-path seed never raises for the LOSER of a first-mint race — it
    // inserts nothing and reserves the winner's next number. Behavioural, over an in-memory
    // NumberingSequence with the real unique key and ON-CONFLICT-DO-NOTHING semantics: the store
    // has NO `upsert`, so a regression back to the select-then-insert seed fails here as a
    // TypeError. The genuine two-connection race is pinned on real Postgres in
    // numbering-first-mint-race.db.spec.ts.
    function fakeSequenceStore() {
      const rows = new Map<string, { prefix: string; padding: number; nextNumber: number }>();
      const keyOf = (tenantId: string, docType: string, year: number) =>
        `${tenantId}|${docType}|${year}`;
      const store = {
        rows,
        // The seed's bound values, in order: id, tenantId, docType, year, prefix, padding.
        $executeRaw: jest.fn((_sql: TemplateStringsArray, ...v: any[]) => {
          const key = keyOf(v[1], v[2], v[3]);
          if (rows.has(key)) return Promise.resolve(0); // conflict: the loser inserts nothing
          rows.set(key, { prefix: v[4], padding: v[5], nextNumber: 1 });
          return Promise.resolve(1);
        }),
        numberingSequence: {
          update: jest.fn(({ where, data }: any) => {
            const w = where.tenantId_docType_year;
            const row = rows.get(keyOf(w.tenantId, w.docType, w.year));
            if (!row)
              return Promise.reject(Object.assign(new Error("not found"), { code: "P2025" }));
            row.nextNumber += data.nextNumber.increment;
            return Promise.resolve({ ...row });
          }),
        },
      };
      return store;
    }

    it("#2177: on a caller's tx, the first mint seeds and the loser inserts nothing and gets n+1", async () => {
      const store = fakeSequenceStore();
      const opts = { year: 2026, tenantId: "tenant-1", tx: store as any };

      const winner = await service.reserveNext("RETURN", opts);
      const loser = await service.reserveNext("RETURN", opts);

      expect([winner, loser]).toEqual(["RET-2026-0001", "RET-2026-0002"]);
      expect(await store.$executeRaw.mock.results[1].value).toBe(0); // the loser inserted nothing
      expect(store.rows.size).toBe(1);
      expect(prisma.tenantTransaction).not.toHaveBeenCalled(); // never a nested transaction
    });

    it("#2177: a row a concurrent winner already committed at n is kept — the loser reserves n, never resets it", async () => {
      const store = fakeSequenceStore();
      store.rows.set("test-tenant|RETURN|2026", { prefix: "RET-", padding: 4, nextNumber: 5 });

      const n = await service.reserveNext("RETURN", {
        year: 2026,
        tenantId: "tenant-1",
        tx: store as any,
      });

      expect(n).toBe("RET-2026-0005");
      expect(store.rows.get("test-tenant|RETURN|2026")?.nextNumber).toBe(6);
    });

    it("#2177: with no caller tx, the SAME seed-then-increment runs inside its own tenantTransaction", async () => {
      const store = fakeSequenceStore();
      prisma.tenantTransaction.mockImplementation((fn: any) => fn(store));

      const first = await service.reserveNext("RETURN");
      const second = await service.reserveNext("RETURN");

      expect([first, second]).toEqual(["RET-0001", "RET-0002"]);
      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2);
      expect(await store.$executeRaw.mock.results[1].value).toBe(0);
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
          // SA-274: key on the requested year (0 → null, no saved card row for
          // this pin) so the new year-0 check does not shadow this per-year row.
          findUnique: jest.fn(({ where }: any) =>
            Promise.resolve(
              where.tenantId_docType_year.year === 0
                ? null
                : { prefix: "INV-", padding: 4, nextNumber: 51 },
            ),
          ),
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
          // SA-274: key on the requested year (0 → null: no saved card row —
          // this pin exercises the year-scoped per-year mint on the caller's tx).
          findUnique: jest.fn(({ where }: any) =>
            Promise.resolve(
              where.tenantId_docType_year.year === 0
                ? null
                : { prefix: "INV-", padding: 4, nextNumber: 38 },
            ),
          ),
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
          // SA-274: key on the requested year (0 → null: no saved card row).
          findUnique: jest.fn(({ where }: any) =>
            Promise.resolve(
              where.tenantId_docType_year.year === 0
                ? null
                : { prefix: "INV-", padding: 4, nextNumber: 301 },
            ),
          ),
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
      // SA-274: key on the requested year (0 → null: no saved card row for
      // this tenant — this pin exercises the year-scoped per-year mint).
      prisma.numberingSequence.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(
          where.tenantId_docType_year.year === 0
            ? null
            : { prefix: "INV-", padding: 4, nextNumber: 7 },
        ),
      );
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

  // SA-274 (cause-ruling.md §2/§3, bug-test-plan.md "Red set — api unit"): a
  // saved year-0 card row becomes the LIVE series for INVOICE/ESTIMATE/
  // CREDIT_NOTE — max-first, never below or equal to an existing document
  // number, 400/409 on save, PAYMENT dropped from the card. Every test below
  // fails TODAY on its own wrong value (see each comment); `as any` marks a
  // not-yet-existing input (`expectedNextNumber`) so the file compiles ahead
  // of FIX1.
  describe("reserveNext / getSettings / updateSettings — REG-B861 (SA-274)", () => {
    it("REG-B861-A a saved INVOICE row (INV-, 10543, pad 5) is the live series", async () => {
      const tx = buildNumberingFixture({
        savedRow: { prefix: "INV-", nextNumber: 10543, padding: 5 },
      });
      prisma.tenantTransaction.mockImplementation((fn: any) => fn(tx));

      // Fails TODAY: mintForYear ignores the saved row and mints "INV-2026-0001".
      await expect(service.reserveNext("INVOICE", { year: 2026 })).resolves.toBe("INV-10543");
    });

    it("REG-B861-B max-first: imported INV-10543..INV-10550 after the save → INV-10551", async () => {
      const docs = Array.from({ length: 8 }, (_, i) => `INV-${10543 + i}`);
      const tx = buildNumberingFixture({
        savedRow: { prefix: "INV-", nextNumber: 10543, padding: 5 },
        docs,
      });
      prisma.tenantTransaction.mockImplementation((fn: any) => fn(tx));

      // Fails TODAY: "INV-2026-0001".
      await expect(service.reserveNext("INVOICE", { year: 2026 })).resolves.toBe("INV-10551");
    });

    it("REG-B861-C empty prefix mints a bare number (Q7)", async () => {
      const tx = buildNumberingFixture({ savedRow: { prefix: "", nextNumber: 7, padding: 0 } });
      prisma.tenantTransaction.mockImplementation((fn: any) => fn(tx));

      // Fails TODAY: "EST-2026-0001".
      await expect(service.reserveNext("ESTIMATE", { year: 2026 })).resolves.toBe("7");
    });

    it("REG-B861-J with opts.tx the configured mint runs on that client and opens no transaction", async () => {
      const tx = buildNumberingFixture({
        savedRow: { prefix: "INV-", nextNumber: 10543, padding: 5 },
      });

      // Fails TODAY: "INV-2026-0001".
      await expect(service.reserveNext("INVOICE", { year: 2026, tx: tx as any })).resolves.toBe(
        "INV-10543",
      );
    });

    // P-5 (pin, no REG token): the second half of J — a configured mint given
    // opts.tx must never open its own transaction (fix-round-2b.md D7 extended
    // to the configured path).
    it("(pin P-5) a configured tx mint does not call tenantTransaction", async () => {
      const tx = buildNumberingFixture({
        savedRow: { prefix: "INV-", nextNumber: 10543, padding: 5 },
      });

      await service.reserveNext("INVOICE", { year: 2026, tx: tx as any });

      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    });

    it("REG-B861-D getSettings previews the true next configured number", async () => {
      prisma.numberingSequence.findMany.mockResolvedValue([
        { docType: "INVOICE", prefix: "INV-", nextNumber: 10543, padding: 5 },
      ]);
      const docs = Array.from({ length: 8 }, (_, i) => `INV-${10543 + i}`);
      prisma.tenantTransaction.mockImplementation((fn: any) => fn(buildNumberingFixture({ docs })));

      const settings = await service.getSettings();

      // Fails TODAY: getSettings previews off the stored nextNumber alone —
      // "INV-10543", never scanning the imported block.
      const invoice = settings.find((s) => s.docType === "INVOICE")!;
      expect(invoice.preview).toBe("INV-10551");
    });

    it("REG-B861-E getSettings previews the per-year next when nothing is saved", async () => {
      const Y = new Date().getFullYear();
      prisma.numberingSequence.findMany.mockResolvedValue([]);
      prisma.tenantTransaction.mockImplementation((fn: any) =>
        fn(buildNumberingFixture({ perYearRow: { prefix: "INV-", nextNumber: 414, padding: 4 } })),
      );

      const settings = await service.getSettings();

      // Fails TODAY: unconfigured always previews "INV-0001" (year-0 default),
      // never the live per-year row.
      const invoice = settings.find((s) => s.docType === "INVOICE")!;
      expect(invoice.preview).toBe(`INV-${Y}-0414`);
    });

    it("REG-B861-F the card lists INVOICE, ESTIMATE, CREDIT_NOTE only (Q6)", async () => {
      prisma.numberingSequence.findMany.mockResolvedValue([]);
      prisma.tenantTransaction.mockImplementation((fn: any) => fn(buildNumberingFixture()));

      const settings = await service.getSettings();

      // Fails TODAY: the array also contains "PAYMENT".
      expect(settings.map((s) => s.docType)).toEqual(["INVOICE", "ESTIMATE", "CREDIT_NOTE"]);
    });

    it("REG-B861-G a save at or below an existing number is refused, naming it", async () => {
      prisma.tenantTransaction.mockImplementation((fn: any) =>
        fn(buildNumberingFixture({ docs: ["INV-10550"] })),
      );

      // Fails TODAY: resolves (upserts nextNumber 10549 with no guard at all).
      await expect(
        service.updateSettings("INVOICE", { nextNumber: 10549, expectedNextNumber: 1 }),
      ).rejects.toThrow(/INV-10550/);
    });

    it("REG-B861-Z a zero-padded number longer than 9 characters is seen by the save guard", async () => {
      // Pre-merge review of #2170: the year-0 max scan captured `(\d{1,9})` with no leading
      // `0*`, so a bare migrated `0090000123` (10 characters, value 90000123) was invisible —
      // a save of next 1000 passed and the series would mint BELOW an existing number.
      // The fixture forwards `upsert` so a guard that does NOT refuse resolves (the wrong value
      // the red run must show) instead of dying on a missing mock.
      const tx = buildNumberingFixture({ docs: ["0090000123"] });
      (tx.numberingSequence as any).upsert = jest.fn().mockResolvedValue({
        docType: "INVOICE",
        prefix: "",
        nextNumber: 1000,
        padding: 10,
      });
      prisma.tenantTransaction.mockImplementation((fn: any) => fn(tx));

      await expect(
        service.updateSettings("INVOICE", {
          prefix: "",
          nextNumber: 1000,
          padding: 10,
          expectedNextNumber: 1,
        }),
      ).rejects.toThrow(/0090000123/);
    });

    it("REG-B861-AB a save without expectedNextNumber is refused (400, reload the settings)", async () => {
      // SA-287b: the token is REQUIRED. Today a token-less save falls back to an unconditional
      // upsert that can lower a live counter under an in-flight mint.
      prisma.tenantTransaction.mockImplementation((fn: any) =>
        fn(buildNumberingFixture({ savedRow: { prefix: "INV-", nextNumber: 10543, padding: 5 } })),
      );

      await expect(service.updateSettings("INVOICE", { prefix: "ACME-" })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("REG-B861-AD a null expectedNextNumber is refused like a missing one (400, reload)", async () => {
      // SA-306: JSON null passes @IsOptional; today it reaches the compare (1 !== null) and 409s.
      prisma.tenantTransaction.mockImplementation((fn: any) =>
        fn(buildNumberingFixture({ savedRow: { prefix: "INV-", nextNumber: 10543, padding: 5 } })),
      );

      await expect(
        service.updateSettings("INVOICE", { prefix: "ACME-", expectedNextNumber: null } as any),
      ).rejects.toBeInstanceOf(BadRequestException); // the 409's text also says "reload"
    });

    it("REG-B861-H a stale card save (expectedNextNumber) is refused with 409", async () => {
      prisma.tenantTransaction.mockImplementation((fn: any) =>
        fn(buildNumberingFixture({ savedRow: { prefix: "INV-", nextNumber: 10560, padding: 4 } })),
      );

      // Fails TODAY: `expectedNextNumber` does not exist yet — the upsert
      // resolves and overwrites the row with prefix "ACME-".
      await expect(
        service.updateSettings("INVOICE", {
          prefix: "ACME-",
          expectedNextNumber: 10543,
        } as any),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("REG-B861-I a no-year mint with no saved row throws and creates no year-0 row", async () => {
      // TODAY, a year-scoped docType with no `opts.year` falls into the
      // UNCHANGED fast path and happily mints a year-0 row — model that so the
      // red run actually resolves ("INV-0001") instead of throwing for an
      // unrelated reason (an unmocked upsert/update).
      prisma.numberingSequence.upsert.mockResolvedValue({
        prefix: "INV-",
        padding: 4,
        nextNumber: 1,
      });
      prisma.numberingSequence.update.mockResolvedValue({ nextNumber: 2 });

      await expect(service.reserveNext("INVOICE")).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
