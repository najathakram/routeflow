import * as fs from "fs";
import * as path from "path";

/**
 * SA-839 section 6 (B705 / #1478, B706 / #1479): the owner-run regulated void-residue report. This spec covers
 * the pure part (scripts/lib/report-839-regulated-void-residue.cjs) with fixtures modelled on the ruling's
 * R1-R7 and R14 (each as MASTER wrote the rows), the filed-period test, the per-tenant fold, the statement
 * shape and the ids-only output with a mocked client, and pins the source of both files as read-only. The
 * spawned argument refusals live in report-839-regulated-void-residue-script.spec.ts.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require("../../scripts/lib/report-839-regulated-void-residue.cjs");

const API_DIR = path.resolve(__dirname, "../..");
const FILES = [
  path.join(API_DIR, "scripts", "report-839-regulated-void-residue.mjs"),
  path.join(API_DIR, "scripts", "lib", "report-839-regulated-void-residue.cjs"),
];

type Row = Record<string, unknown>;
type Finding = Record<string, unknown>;

let seq = 0;
/** One ledger row: SALE by default, all pointers null. Rows are created oldest first (createdAt follows `seq`). */
function row(o: Row): Row {
  seq += 1;
  return {
    id: `row-${seq}`,
    entryType: "SALE",
    returnId: null,
    creditNoteId: null,
    correctsEntryId: null,
    qty: 0,
    unitBasisQty: 0,
    netSales: 0,
    categoryTax: 0,
    periodBucket: "2026-09",
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, seq)).toISOString(),
    soldAt: new Date(Date.UTC(2026, 8, 1, 0, seq)).toISOString(),
    ...o,
  };
}
const sale = (qty = 10, net = 100, tax = 20, o: Row = {}) =>
  row({ qty, unitBasisQty: qty, netSales: net, categoryTax: tax, ...o });
/** A REVERSAL: pass POSITIVE magnitudes, the helper signs them. */
const reversal = (qty: number, net: number, tax: number, o: Row = {}) =>
  row({
    entryType: "REVERSAL",
    qty: -qty,
    unitBasisQty: -qty,
    netSales: -net,
    categoryTax: -tax,
    periodBucket: "2026-10",
    ...o,
  });
const LINE = { qty: 10, trackedCategoryId: "cat" };
const LINE5 = { qty: 5, trackedCategoryId: "cat" };

describe("classifyLine: SA-839 R1-R7 and R14 as master wrote the rows", () => {
  it("R1 void -> unvoid: a live DRAFT billing 10 whose ledger nets 0 is UNVOID_UNBOOKED in the void's bucket", () => {
    const rows = [sale(), reversal(10, 100, 20)];
    expect(lib.classifyLine(rows, "DRAFT", {}, LINE)).toEqual([
      { cls: "UNVOID_UNBOOKED", bucket: "2026-10" },
    ]);
  });

  it("R2 void -> unvoid -> void -> unvoid: master's second void is a no-op, the shape is R1's", () => {
    const rows = [sale(), reversal(10, 100, 20)];
    expect(lib.classifyLine(rows, "DRAFT", {}, LINE).map((f: Finding) => f.cls)).toEqual([
      "UNVOID_UNBOOKED",
    ]);
    // ... and while the invoice is VOID that same square line is clean
    expect(lib.classifyLine(rows, "VOID", {}, LINE)).toEqual([]);
  });

  it("R3 return r1 before the void -> void -> unvoid: sale-record covers 3 of 10, UNVOID_UNBOOKED", () => {
    const rows = [
      sale(),
      reversal(3, 30, 6, { returnId: "r1", periodBucket: "2026-09" }),
      reversal(7, 70, 14),
    ];
    expect(lib.classifyLine(rows, "SENT", { r1: "RECEIVED" }, LINE)).toEqual([
      { cls: "UNVOID_UNBOOKED", bucket: "2026-10" },
    ]);
  });

  it("R4 return r1 -> void -> cancel r1 after the void (STANDARD): +3 on a VOID invoice is RETURN_CANCELLED", () => {
    // the cancel blind-deleted r1's row; the void had already absorbed its share
    const rows = [sale(), reversal(7, 70, 14)];
    expect(lib.classifyLine(rows, "VOID", { r1: "CANCELLED" }, LINE)).toEqual([
      { cls: "VOID_RESIDUE", sub: "RETURN_CANCELLED", bucket: "2026-10" },
    ]);
  });

  it("R5 the same as an INLINE PIECES return: still RETURN_CANCELLED (the order link is the source order)", () => {
    const rows = [
      sale(10, 100, 20, { unitBasisQty: 120 }),
      reversal(7, 70, 14, { unitBasisQty: -84 }),
    ];
    expect(lib.classifyLine(rows, "VOID", new Map([["r-inline", "CANCELLED"]]), LINE)).toEqual([
      { cls: "VOID_RESIDUE", sub: "RETURN_CANCELLED", bucket: "2026-10" },
    ]);
  });

  it("R6 R4 then unvoid: a DRAFT billing 10 over a +3 line is UNVOID_UNBOOKED", () => {
    const rows = [sale(), reversal(7, 70, 14)];
    expect(lib.classifyLine(rows, "DRAFT", { r1: "CANCELLED" }, LINE)).toEqual([
      { cls: "UNVOID_UNBOOKED", bucket: "2026-10" },
    ]);
  });

  it("R7 legacy VOID credit note -> unvoid: both UNVOID_UNBOOKED and VOID_NOTE_ON_LIVE_INVOICE, one note", () => {
    const rows = [
      sale(5, 25, 2),
      reversal(2, 10, 0.8, { creditNoteId: "n2", periodBucket: "2026-09" }),
      reversal(3, 15, 1.2),
    ];
    expect(lib.classifyLine(rows, "DRAFT", { n2: "VOID" }, LINE5)).toEqual([
      { cls: "UNVOID_UNBOOKED", bucket: "2026-10" },
      { cls: "VOID_NOTE_ON_LIVE_INVOICE", noteId: "n2", bucket: "2026-10" },
    ]);
  });

  it("R7b void with an unused sourced note (still VOID): the standing note rows are not flagged yet", () => {
    const rows = [
      sale(5, 25, 2),
      reversal(2, 10, 0.8, { creditNoteId: "n2", periodBucket: "2026-09" }),
      reversal(3, 15, 1.2),
    ];
    expect(lib.classifyLine(rows, "VOID", { n2: "VOID" }, LINE5)).toEqual([]);
  });

  it("R14 credit-note void after the invoice void: the note's row was removed, +3 is NOTE_VOIDED", () => {
    const rows = [sale(), reversal(7, 70, 14)];
    expect(lib.classifyLine(rows, "VOID", { n1: "VOID" }, LINE)).toEqual([
      { cls: "VOID_RESIDUE", sub: "NOTE_VOIDED", bucket: "2026-10" },
    ]);
  });
});

describe("classifyLine: sub-classes, edges and clean lines", () => {
  it("AXIS_ONLY: money 0 with a piece residue (pre-B661, L-294), even with a cancelled return on the order", () => {
    const rows = [
      sale(10, 100, 20, { unitBasisQty: 120 }),
      reversal(10, 100, 20, { unitBasisQty: -100 }),
    ];
    expect(lib.classifyLine(rows, "VOID", {}, LINE)).toEqual([
      { cls: "VOID_RESIDUE", sub: "AXIS_ONLY", bucket: "2026-10" },
    ]);
    expect(lib.classifyLine(rows, "VOID", { r9: "CANCELLED" }, LINE)[0].sub).toBe("AXIS_ONLY");
  });

  it("OTHER: a standing VOID line with no cancelled return and no void note to explain it", () => {
    const rows = [sale(), reversal(8, 80, 16)];
    expect(lib.classifyLine(rows, "VOID", { r2: "RECEIVED", n3: "ISSUED" }, LINE)).toEqual([
      { cls: "VOID_RESIDUE", sub: "OTHER", bucket: "2026-10" },
    ]);
  });

  it("an invoiceId with no Invoice row (null or GONE) is judged like a VOID invoice", () => {
    const rows = [sale(), reversal(7, 70, 14)];
    for (const status of [null, undefined, "GONE"])
      expect(lib.classifyLine(rows, status, { r1: "CANCELLED" }, {})).toEqual([
        { cls: "VOID_RESIDUE", sub: "RETURN_CANCELLED", bucket: "2026-10" },
      ]);
  });

  it("RETURN_CANCELLED wins over NOTE_VOIDED when both documents are present", () => {
    const rows = [sale(), reversal(7, 70, 14)];
    expect(lib.classifyLine(rows, "VOID", { r1: "CANCELLED", n1: "VOID" }, LINE)[0].sub).toBe(
      "RETURN_CANCELLED",
    );
  });

  it("a residue with no void-signature row has no period (null bucket)", () => {
    const rows = [sale(), reversal(3, 30, 6, { returnId: "r1" })];
    // 7 standing, the invoice is VOID, no void row exists
    expect(lib.classifyLine(rows, "VOID", {}, LINE)).toEqual([
      { cls: "VOID_RESIDUE", sub: "OTHER", bucket: null },
    ]);
  });

  it("the period is the NEWEST void-signature REVERSAL", () => {
    const rows = [
      sale(),
      reversal(10, 100, 20, { periodBucket: "2026-10" }),
      sale(10, 100, 20, { periodBucket: "2026-11" }),
      reversal(10, 100, 20, { periodBucket: "2026-12" }),
    ];
    expect(lib.classifyLine(rows, "SENT", {}, LINE)).toEqual([
      { cls: "UNVOID_UNBOOKED", bucket: "2026-12" },
    ]);
  });

  describe("clean lines classify as nothing", () => {
    it("no rows", () => expect(lib.classifyLine([], "VOID", {}, LINE)).toEqual([]));

    it("a live invoice with only its SALE", () =>
      expect(lib.classifyLine([sale()], "SENT", {}, LINE)).toEqual([]));

    it("a correct unvoid: void, then a fresh SALE (even in the same transaction instant)", () => {
      const at = "2026-11-02T00:00:00.000Z";
      const rows = [
        sale(),
        reversal(10, 100, 20, { createdAt: at }),
        sale(10, 100, 20, { createdAt: at, periodBucket: "2026-11" }),
      ];
      expect(lib.classifyLine(rows, "SENT", {}, LINE)).toEqual([]);
      expect(lib.classifyLine([...rows].reverse(), "SENT", {}, LINE)).toEqual([]);
    });

    it("a live partial return keeps the line live and square", () =>
      expect(
        lib.classifyLine(
          [sale(), reversal(3, 30, 6, { returnId: "r1" })],
          "SENT",
          { r1: "RECEIVED" },
          LINE,
        ),
      ).toEqual([]));

    it("a VOID invoice whose line is fully reversed", () =>
      expect(
        lib.classifyLine(
          [sale(), reversal(3, 30, 6, { returnId: "r1" }), reversal(7, 70, 14)],
          "VOID",
          { r1: "RECEIVED" },
          LINE,
        ),
      ).toEqual([]));

    it("a live line with no category (nothing was ever booked for it)", () =>
      expect(lib.classifyLine([sale(), reversal(10, 100, 20)], "DRAFT", {}, { qty: 10 })).toEqual(
        [],
      ));

    it("a live line whose VOID note was countered (the rows net to 0)", () => {
      const rows = [
        sale(5, 25, 2),
        reversal(2, 10, 0.8, { creditNoteId: "n2" }),
        row({
          entryType: "REVERSAL",
          creditNoteId: "n2",
          correctsEntryId: "x",
          qty: 2,
          unitBasisQty: 2,
          netSales: 10,
          categoryTax: 0.8,
        }),
      ];
      expect(lib.classifyLine(rows, "SENT", { n2: "VOID" }, LINE5)).toEqual([]);
    });

    it("a live line with a note that is not VOID", () =>
      expect(
        lib.classifyLine(
          [sale(5, 25, 2), reversal(2, 10, 0.8, { creditNoteId: "n2" })],
          "SENT",
          { n2: "APPLIED" },
          LINE5,
        ),
      ).toEqual([]));

    it("sub-epsilon float noise is not a residue", () =>
      expect(lib.classifyLine([sale(), reversal(10.0002, 100.0001, 20)], "VOID", {}, LINE)).toEqual(
        [],
      ));
  });
});

describe("isFiled", () => {
  const filings = [
    {
      trackedCategoryId: "cat",
      periodStart: new Date("2026-10-01T00:00:00Z"),
      periodEnd: new Date("2026-11-01T00:00:00Z"),
    },
    {
      trackedCategoryId: "q",
      periodStart: new Date("2026-07-01T00:00:00Z"),
      periodEnd: new Date("2026-10-01T00:00:00Z"),
    },
  ];

  it("covers the bucket's first instant, half-open", () => {
    expect(lib.isFiled(filings, "cat", "2026-10")).toBe(true);
    expect(lib.isFiled(filings, "cat", "2026-11")).toBe(false);
    expect(lib.isFiled(filings, "cat", "2026-09")).toBe(false);
  });

  it("a quarterly filing covers each of its months, only for its own category", () => {
    for (const b of ["2026-07", "2026-08", "2026-09"])
      expect(lib.isFiled(filings, "q", b)).toBe(true);
    expect(lib.isFiled(filings, "q", "2026-10")).toBe(false);
    expect(lib.isFiled(filings, "cat", "2026-08")).toBe(false);
  });

  it("no bucket or no category is never filed", () => {
    expect(lib.isFiled(filings, "cat", null)).toBe(false);
    expect(lib.isFiled(filings, null, "2026-10")).toBe(false);
  });
});

describe("fold", () => {
  it("counts distinct invoices, lines and notes per (class, sub-class, period, filed)", () => {
    const fold = lib.newFold();
    const filedFor = (b: string) => b === "2026-10";
    const unvoidAndNote = [
      { cls: "UNVOID_UNBOOKED", bucket: "2026-10" },
      { cls: "VOID_NOTE_ON_LIVE_INVOICE", noteId: "n1", bucket: "2026-10" },
    ];
    lib.foldFindings(fold, { invoiceId: "i1", filedFor, findings: unvoidAndNote });
    lib.foldFindings(fold, { invoiceId: "i1", filedFor, findings: unvoidAndNote });
    lib.foldFindings(fold, {
      invoiceId: "i2",
      filedFor,
      findings: [
        { cls: "VOID_RESIDUE", sub: "OTHER", bucket: null },
        { cls: "VOID_RESIDUE", sub: "OTHER", bucket: "2026-11" },
      ],
    });
    const base = { notes: 0, invoices: 1 };
    expect(lib.foldRows(fold)).toEqual([
      {
        class: "UNVOID_UNBOOKED",
        subclass: null,
        period: "2026-10",
        filed: "filed",
        lines: 2,
        ...base,
      },
      {
        class: "VOID_NOTE_ON_LIVE_INVOICE",
        subclass: null,
        period: "2026-10",
        filed: "filed",
        lines: 2,
        invoices: 1,
        notes: 1,
      },
      {
        class: "VOID_RESIDUE",
        subclass: "OTHER",
        period: "(no void row)",
        filed: "n/a",
        lines: 1,
        ...base,
      },
      {
        class: "VOID_RESIDUE",
        subclass: "OTHER",
        period: "2026-11",
        filed: "open",
        lines: 1,
        ...base,
      },
    ]);
  });
});

describe("source is read-only", () => {
  it.each(FILES)("%s has no write verb, client write call or raw execute", (file) => {
    const src = fs.readFileSync(file, "utf8");
    expect(src).not.toMatch(/Delete|Put|Copy|executeRaw|UPDATE|INSERT|DELETE/);
    expect(src).not.toMatch(/\.(update|create|upsert|delete)\w*\(|\$execute/i);
  });

  const queries: Record<string, string> = {
    TENANT_ROWS: lib.TENANT_ROWS,
    LINE_ROWS: lib.LINE_ROWS,
    DOC_STATUS: lib.DOC_STATUS,
    CANCELLED_RETURNS: lib.CANCELLED_RETURNS,
    VOID_NOTES: lib.VOID_NOTES,
    FILED_FILINGS: lib.FILED_FILINGS,
  };
  const statements: string[] = [
    ...lib.READ_ONLY_SESSION,
    lib.BEGIN_READ_ONLY,
    lib.SHOW_READ_ONLY,
    ...Object.values(queries),
  ];

  it("every statement is a SELECT, WITH ... SELECT, SHOW, SET or BEGIN TRANSACTION READ ONLY", () => {
    for (const s of statements) {
      expect(s.trim()).toMatch(/^(SELECT|WITH|SHOW|SET|BEGIN TRANSACTION READ ONLY)\b/);
      expect(s).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|GRANT|MERGE|COPY|CREATE|CALL)\b/i,
      );
    }
    expect(lib.READ_ONLY_SESSION[0]).toBe("SET default_transaction_read_only = on");
    const session = lib.READ_ONLY_SESSION.join("\n");
    expect(session).toMatch(/statement_timeout/);
    expect(session).toMatch(/lock_timeout/);
    expect(session).toMatch(/idle_in_transaction_session_timeout/);
  });

  it("only the tenant query reads a slug (for isTestTenant); no name, email, number, customer or amount column anywhere", () => {
    expect(queries.TENANT_ROWS).toMatch(/\bslug\b/);
    const { TENANT_ROWS: _tenant, ...rest } = queries;
    void _tenant;
    expect(Object.values(rest).join("\n")).not.toMatch(
      /\bslug\b|\bemail\b|businessName|customer|\b[a-z]+\."?name"?\b|Number\b|\b[a-z]\.(total|amount|subtotal)\b/i,
    );
  });

  it("the tenant filter is a bind parameter, never interpolated", () => {
    expect(lib.LINE_ROWS).toContain('l."tenantId" = $1');
    expect(lib.TENANT_ROWS).toContain("$1::text");
  });
});

/** A client whose answers are keyed by the exact SQL text; records every statement in order. */
function mockClient(answer: (sql: string, params?: unknown[]) => Row[], readOnlyFlag = "on") {
  const seen: { sql: string; params?: unknown[] }[] = [];
  return {
    seen,
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      seen.push({ sql, params });
      if (sql === lib.SHOW_READ_ONLY) return { rows: [{ transaction_read_only: readOnlyFlag }] };
      return { rows: answer(sql, params) };
    }),
  };
}

describe("withReadOnlyTx", () => {
  it("sets the read-only session first, opens a READ ONLY tx, proves it, and ends with ROLLBACK", async () => {
    const client = mockClient(() => []);
    await lib.withReadOnlyTx(client, async () => client.query("SELECT 1"));
    const sqls = client.seen.map((s) => s.sql);
    expect(sqls[0]).toBe("SET default_transaction_read_only = on");
    expect(sqls.slice(0, 4)).toEqual(lib.READ_ONLY_SESSION);
    expect(sqls[4]).toBe(lib.BEGIN_READ_ONLY);
    expect(sqls[5]).toBe(lib.SHOW_READ_ONLY);
    expect(sqls.at(-1)).toBe("ROLLBACK");
  });

  it("aborts, still rolling back, when transaction_read_only is not on", async () => {
    const client = mockClient(() => [], "off");
    const body = jest.fn();
    await expect(lib.withReadOnlyTx(client, body)).rejects.toThrow(/transaction_read_only/);
    expect(body).not.toHaveBeenCalled();
    expect(client.seen.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("rolls back when the body throws", async () => {
    const client = mockClient(() => []);
    await expect(
      lib.withReadOnlyTx(client, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(client.seen.at(-1)?.sql).toBe("ROLLBACK");
  });
});

describe("buildReport: tenant ids and counts only", () => {
  const SLUG = "acme-secret-slug";
  const NOTE_ID = "note-secret-77";
  const withLine = (r: Row): Row => ({
    ...r,
    invoiceId: "inv-1",
    invoiceItemId: "item-1",
    orderId: "ord-1",
    trackedCategoryId: "cat",
    invoiceStatus: "VOID",
    lineQty: 10,
    lineTrackedCategoryId: "cat",
  });
  const ledger = [withLine(sale(10, 123456.78, 20)), withLine(reversal(7, 98765.43, 14))];

  function client() {
    return mockClient((sql, params) => {
      if (sql === lib.TENANT_ROWS)
        return [
          { tenantId: "t-live", slug: SLUG },
          { tenantId: "t-test", slug: "test" },
          { tenantId: "t-clean", slug: "clean-co" },
        ];
      if (sql === lib.LINE_ROWS) return params?.[0] === "t-clean" ? [] : ledger;
      if (sql === lib.CANCELLED_RETURNS)
        return [{ returnId: "r1", orderId: "ord-1", sourceOrderIds: [] }];
      if (sql === lib.VOID_NOTES) return [{ creditNoteId: NOTE_ID, invoiceId: "other-invoice" }];
      if (sql === lib.FILED_FILINGS)
        return [
          {
            trackedCategoryId: "cat",
            periodStart: new Date("2026-10-01T00:00:00Z"),
            periodEnd: new Date("2026-11-01T00:00:00Z"),
          },
        ];
      return [];
    });
  }

  it("flags protected and test tenants, drops clean ones, and leaks no slug, id, amount or row id", async () => {
    const c = client();
    const report = await lib.withReadOnlyTx(c, () =>
      lib.buildReport(c, { protectedIds: new Set(["t-live"]) }),
    );
    expect(report.tenantsScanned).toBe(3);
    expect(report.tenants.map((t: Row) => [t.tenantId, t.protected, t.test])).toEqual([
      ["t-live", true, false],
      ["t-test", false, true],
    ]);
    const meta = { generatedAt: "2026-10-22T00:00:00.000Z", scope: "all tenants" };
    const text = lib.formatReport(report, meta);
    const json = JSON.stringify(lib.jsonReport(report, meta));
    for (const out of [text, json]) {
      for (const secret of [
        SLUG,
        NOTE_ID,
        "123456",
        "98765",
        "row-",
        "inv-1",
        "item-1",
        "ord-1",
        "r1",
        "clean-co",
        "t-clean",
      ])
        expect(out).not.toContain(secret);
      expect(out).toContain("t-live");
    }
    expect(text).toContain("tenant t-live [PROTECTED]");
    expect(text).toContain("tenant t-test [TEST]");
    expect(text).toMatch(
      /VOID_RESIDUE\/RETURN_CANCELLED {2}period 2026-10 {2}filed {2}invoices 1, lines 1/,
    );
    expect(JSON.parse(json).totals.VOID_RESIDUE).toEqual({
      tenants: 2,
      invoices: 2,
      lines: 2,
      notes: 0,
    });
  });

  it("scopes one tenant by bind parameter and makes only SELECT-shaped calls", async () => {
    const c = client();
    await lib.withReadOnlyTx(c, () =>
      lib.buildReport(c, { protectedIds: new Set(), onlyTenant: "t-live" }),
    );
    expect(c.seen.find((s) => s.sql === lib.TENANT_ROWS)?.params).toEqual(["t-live"]);
    for (const s of c.seen)
      expect(s.sql.trim()).toMatch(
        /^(SELECT|WITH|SHOW|SET|BEGIN TRANSACTION READ ONLY|ROLLBACK)\b/,
      );
  });

  it("an empty database prints a clear no-findings line", async () => {
    const c = mockClient(() => []);
    const report = await lib.withReadOnlyTx(c, () =>
      lib.buildReport(c, { protectedIds: new Set() }),
    );
    expect(lib.formatReport(report, { generatedAt: "x", scope: "all tenants" })).toContain(
      "(no tenant has any finding)",
    );
  });
});

describe("checkArgs", () => {
  it.each(["--apply", "--fix", "--repair"])("refuses %s", (flag) => {
    expect(lib.checkArgs([flag])).toMatchObject({ ok: false });
    expect(lib.checkArgs(["--json", flag])).toMatchObject({ ok: false });
  });

  it("accepts --json, --tenant ID, --self-test; refuses anything else", () => {
    expect(lib.checkArgs([])).toMatchObject({ ok: true, json: false, tenant: null });
    expect(lib.checkArgs(["--json", "--tenant", "abc-123"])).toMatchObject({
      ok: true,
      json: true,
      tenant: "abc-123",
    });
    expect(lib.checkArgs(["--self-test"])).toMatchObject({ ok: true, selfTest: true });
    expect(lib.checkArgs(["--tenant"]).ok).toBe(false);
    expect(lib.checkArgs(["--tenant", "a b"]).ok).toBe(false);
    expect(lib.checkArgs(["--wat"]).ok).toBe(false);
    expect(lib.checkArgs(["stray"]).ok).toBe(false);
  });
});
