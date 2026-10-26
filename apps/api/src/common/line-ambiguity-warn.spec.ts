import { Logger } from "@nestjs/common";
import { AMBIGUOUS_LINE_REASONS } from "@routeflow/pricing";
import {
  LINE_GUARD_SITES,
  lineGuardCtx,
  warnLineAmbiguity,
  type LineGuardSite,
} from "./line-ambiguity-warn";

/**
 * SA-982 PR-2: the warn phase. `warnLineAmbiguity` dry-runs `buildLine` on a class site's RAW input and logs ONE line on
 * an `AmbiguousLineError`: `line-ambiguity site=<id> reason=<code> tenant=<tenantId> role=<role>`. It NEVER changes the
 * write, never throws, and logs no names or numbers. The prod census of what a later flip would refuse is this log.
 */
describe("warnLineAmbiguity", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  const ctx = { tenantId: "tenant-acme", role: "OPERATOR" };
  const lines = () => warn.mock.calls.map((c) => String(c[0]));

  it.each([
    ["BOXED_NO_SPLIT", { unitsPerBox: 12, qty: 6 }],
    ["NON_INTEGER", { unitsPerBox: 12, boxes: 1.5, pieces: 0 }],
    ["QTY_DISAGREES", { unitsPerBox: 12, boxes: 1, pieces: 0, qty: 5 }],
    ["ZERO", { unitsPerBox: 12, boxes: 0, pieces: 0 }],
    ["SPLIT_NO_PACK", { unitsPerBox: 1, boxes: 2, pieces: 0 }],
    ["BAD_QTY", { unitsPerBox: 1, qty: 0 }],
  ] as const)(
    "%s: logs exactly one line with the site, the reason, the tenant id and the role",
    (reason, raw) => {
      warnLineAmbiguity("orders.create.lines", { unitPrice: 24, ...raw }, ctx);
      expect(lines()).toEqual([
        `line-ambiguity site=orders.create.lines reason=${reason} tenant=tenant-acme role=OPERATOR`,
      ]);
    },
  );

  it("covers every reason code the pricing package defines", () => {
    expect(AMBIGUOUS_LINE_REASONS).toHaveLength(6);
  });

  it("logs nothing for a valid split, an unrolled split (buildLine rolls it over), or a non-boxed qty", () => {
    warnLineAmbiguity(
      "invoices.manual",
      { unitPrice: 24, unitsPerBox: 12, boxes: 2, pieces: 3 },
      ctx,
    );
    warnLineAmbiguity(
      "invoices.manual",
      { unitPrice: 24, unitsPerBox: 12, boxes: 1, pieces: 14 },
      ctx,
    );
    warnLineAmbiguity("invoices.manual", { unitPrice: 24, unitsPerBox: 1, qty: 2.5 }, ctx);
    warnLineAmbiguity("invoices.manual", { unitPrice: 24, qty: 3 }, ctx);
    expect(lines()).toEqual([]);
  });

  it("an unknown role or tenant is logged as `unknown`, never as a blank", () => {
    warnLineAmbiguity(
      "counter.sale",
      { unitPrice: 1, unitsPerBox: 12, qty: 6 },
      { tenantId: null },
    );
    expect(lines()).toEqual([
      "line-ambiguity site=counter.sale reason=BOXED_NO_SPLIT tenant=unknown role=unknown",
    ]);
  });

  it("never throws, whatever it is given", () => {
    const junk = [
      {},
      { unitPrice: Number.NaN, qty: "abc", boxes: {}, pieces: [], unitsPerBox: "x" },
      { unitPrice: undefined, unitsPerBox: 12, boxes: null, pieces: null, qty: null },
      { unitPrice: 5, unitsPerBox: -3, boxes: -1, pieces: Infinity },
    ];
    for (const raw of junk) {
      expect(() => warnLineAmbiguity("orders.create.lines", raw as never, ctx)).not.toThrow();
    }
    expect(() => warnLineAmbiguity("orders.create.lines", null as never, ctx)).not.toThrow();
    expect(() =>
      warnLineAmbiguity("orders.create.lines", { unitPrice: 1, qty: 1 }, null as never),
    ).not.toThrow();
  });

  it("never changes its input (the write is the caller's, untouched)", () => {
    // A clone taken BEFORE the call, deep-compared after: a frozen input only throws in strict mode, so a mutant that
    // wrote to it could pass silently. Both an ambiguous shape (the catch path) and a valid one (no log) are checked.
    for (const raw of [
      { unitPrice: 24, unitsPerBox: 12, boxes: 1.5, pieces: 0, qty: 18 },
      { unitPrice: 24, unitsPerBox: 12, boxes: 1, pieces: 6, qty: 18 },
      { unitPrice: 24, unitsPerBox: 12, qty: 6 },
    ]) {
      const before = structuredClone(raw);
      warnLineAmbiguity("orders.create.lines", raw, ctx);
      expect(raw).toEqual(before);
    }
  });

  it("the log line carries no names or amounts", () => {
    warnLineAmbiguity("orders.create.lines", { unitPrice: 24.5, unitsPerBox: 12, qty: 6 }, ctx);
    expect(lines()[0]).not.toMatch(/24|\b6\b|\b12\b/);
  });
});

describe("LINE_GUARD_SITES", () => {
  it("is the closed list of wired sites: the compiler, not free text, names a site", () => {
    expect([...LINE_GUARD_SITES].sort()).toEqual(
      [
        "counter.sale",
        "invoices.manual",
        "orders.cr.add",
        "orders.create.lines",
        "orders.replace-all",
        "orders.update.substitute",
      ].sort(),
    );
    const site: LineGuardSite = "orders.create.lines";
    expect(LINE_GUARD_SITES).toContain(site);
  });
});

describe("lineGuardCtx", () => {
  const prisma = { getTenantId: () => "t-9" };
  it("carries the tenant, the actor's role and the named census site", () => {
    expect(lineGuardCtx(prisma, { role: "OPERATOR" }, "invoices.manual")).toEqual({
      tenantId: "t-9",
      role: "OPERATOR",
      warnSite: "invoices.manual",
    });
  });
  it("an internal caller names no site", () => {
    expect(lineGuardCtx(prisma, null).warnSite).toBeUndefined();
  });
});
