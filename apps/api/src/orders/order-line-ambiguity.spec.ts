import { Logger } from "@nestjs/common";
import { orderLineRaw, warnOrderLine } from "./order-line-ambiguity";

/**
 * SA-982 PR-2b (row 139): what each orders class site hands `buildLine`, and that only the class sites are counted.
 * The DB-backed rows (a real create / counter sale logging, the write unchanged) live in qty-split-consistency.db.spec.ts.
 */
describe("orderLineRaw (SA-982a: each site's own reading of the client's line)", () => {
  it("create / counter / cr.add hand the line exactly as sent, with the live pack", () => {
    for (const site of ["orders.create.lines", "counter.sale", "orders.cr.add"] as const)
      expect(orderLineRaw(site, { qty: 6, boxes: null, pieces: undefined }, 12)).toEqual({
        unitsPerBox: 12,
        boxes: null,
        pieces: undefined,
        qty: 6,
      });
  });

  describe("orders.update.substitute", () => {
    const site = "orders.update.substitute";
    it("a boxed substitute takes the client's split and its qty", () => {
      expect(orderLineRaw(site, { qty: 24, boxes: 2, pieces: 0 }, 12, 5)).toEqual({
        unitsPerBox: 12,
        boxes: 2,
        pieces: 0,
        qty: 24,
      });
    });
    it("a boxed substitute with no split and no qty falls back to the held line's qty, with no split (B644, counted)", () => {
      expect(orderLineRaw(site, {}, 12, 5)).toEqual({
        unitsPerBox: 12,
        boxes: undefined,
        pieces: undefined,
        qty: 5,
      });
    });
    it("a loose substitute drops the split by design: only the qty is judged, no pack, no split", () => {
      expect(orderLineRaw(site, { qty: 3, boxes: 2, pieces: 1 }, 1, 5)).toEqual({ qty: 3 });
      expect(orderLineRaw(site, { boxes: 2 }, 0, 5)).toEqual({ qty: 5 });
    });
  });
});

describe("warnOrderLine", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());
  const prisma = { getTenantId: () => "t-7" };
  const logged = () => warn.mock.calls.map((c) => String(c[0]));

  it("logs one line naming the site, the reason and the tenant for an ambiguous class-site line", () => {
    warnOrderLine("orders.create.lines", { qty: 6 }, 12, prisma);
    warnOrderLine("orders.cr.add", { qty: 7, boxes: 1, pieces: 0 }, 12, prisma);
    expect(logged()).toEqual([
      "line-ambiguity site=orders.create.lines reason=BOXED_NO_SPLIT tenant=t-7 role=unknown",
      "line-ambiguity site=orders.cr.add reason=QTY_DISAGREES tenant=t-7 role=unknown",
    ]);
  });

  it("a loose substitute carrying a split is NOT counted (SPLIT_NO_PACK is dropped there by design)", () => {
    warnOrderLine("orders.update.substitute", { qty: 3, boxes: 2, pieces: 1 }, 1, prisma, 5);
    expect(logged()).toEqual([]);
  });

  it("a path that is not a class site (a staff edit, orders.update) is never counted", () => {
    warnOrderLine("orders.update", { qty: 6 }, 12, prisma);
    warnOrderLine("buyer.createOrder", { qty: 6 }, 12, prisma);
    expect(logged()).toEqual([]);
  });

  it("never throws without a prisma or tenant", () => {
    expect(() => warnOrderLine("orders.create.lines", { qty: 6 }, 12, null)).not.toThrow();
    expect(logged()).toEqual([
      "line-ambiguity site=orders.create.lines reason=BOXED_NO_SPLIT tenant=unknown role=unknown",
    ]);
  });
});

describe("the class sites are wired in orders.service.ts (SA-982a Pin B tags)", () => {
  const src = require("fs")
    .readFileSync(require("path").join(__dirname, "orders.service.ts"), "utf8")
    .split("\n")
    .filter((l: string) => !/^\s*\/\//.test(l))
    .join("\n");
  it.each(["orders.create.lines", "counter.sale", "orders.update.substitute", "orders.cr.add"])(
    "%s reaches warnSplit (and so the buildLine census)",
    (site) => {
      expect(src).toContain(`"${site}"`);
      expect(src).toMatch(new RegExp(`this\\.warnSplit\\(\\s*[^;]*"${site.replace(".", "\\.")}"`));
    },
  );
  it("orders.replace-all calls the census directly (its builder is pure and carries no tenant)", () => {
    expect(src).toMatch(/warnOrderLine\(\s*"orders\.replace-all"/);
  });
  it("the edit path stays a row 531 path only: orders.update is not a census site", () => {
    expect(src).toMatch(/this\.warnSplit\("orders\.update",/);
  });
});
