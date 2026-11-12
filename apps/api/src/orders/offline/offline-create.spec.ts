import { readFileSync } from "fs";
import { join } from "path";
import { BadRequestException, ConflictException } from "@nestjs/common";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import type { CreateOrderDto } from "../dto/create-order.dto";
import type { OfflineCreateOption } from "../order-create-options";
import { OFFLINE_GATE_FINDING_CODES, offlineCreate, resolveOfflineRequest } from "./offline-create";

const SRC = join(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(SRC, ...p), "utf8");

const opt = (over: Partial<OfflineCreateOption> = {}): OfflineCreateOption => ({
  quote: { total: 10, lines: [{ index: 0, unitPrice: 10, unitsPerBox: null, unitLabel: null }] },
  createdAt: null,
  openOrderId: null,
  ...over,
});
const conflict = (code: string, extra: object = {}) => new ConflictException({ code, ...extra });

describe("the four finding codes (SA-1124 item 5): one list, count-pinned", () => {
  it("is exactly the license, restriction (hard and warning) and credit refusals", () => {
    expect([...OFFLINE_GATE_FINDING_CODES].sort()).toEqual([
      "CREDIT_LIMIT_EXCEEDED",
      "REGULATED_AUTH_REQUIRED",
      "RESTRICTION_WARNING",
      "SELLING_RESTRICTED",
    ]);
    expect(OFFLINE_GATE_FINDING_CODES).toHaveLength(4);
  });
});

describe("OfflineCreate.gate", () => {
  it("online (no offline option) it IS the call: every error, even a finding code, propagates", async () => {
    const off = offlineCreate(undefined);
    for (const code of OFFLINE_GATE_FINDING_CODES) {
      await expect(off.gate(() => Promise.reject(conflict(code)))).rejects.toThrow(
        ConflictException,
      );
    }
    await expect(off.gate(async () => 7)).resolves.toBe(7);
    expect(off.blocked).toBe(false);
  });

  it.each(OFFLINE_GATE_FINDING_CODES)(
    "offline, %s becomes a finding and the create is blocked",
    async (code) => {
      const off = offlineCreate(opt());
      await expect(off.gate(() => Promise.reject(conflict(code)))).resolves.toBeUndefined();
      expect(off.blocked).toBe(true);
    },
  );

  it("offline, a clean gate returns its value and blocks nothing", async () => {
    const off = offlineCreate(opt());
    await expect(off.gate(async () => "decision")).resolves.toBe("decision");
    expect(off.blocked).toBe(false);
  });

  it("offline, any other error propagates unchanged (a 409 with another code, a 400, a bare Error)", async () => {
    const off = offlineCreate(opt());
    await expect(off.gate(() => Promise.reject(conflict("MERGE_CHOICE_REQUIRED")))).rejects.toThrow(
      ConflictException,
    );
    await expect(off.gate(() => Promise.reject(new BadRequestException("no")))).rejects.toThrow(
      "no",
    );
    await expect(off.gate(() => Promise.reject(new Error("db down")))).rejects.toThrow("db down");
    expect(off.blocked).toBe(false);
  });

  it("every gate still runs after the first finding", async () => {
    const off = offlineCreate(opt());
    const second = jest.fn().mockResolvedValue(undefined);
    await off.gate(() => Promise.reject(conflict("REGULATED_AUTH_REQUIRED")));
    await off.gate(second);
    expect(second).toHaveBeenCalled();
  });
});

describe("OfflineCreate rows", () => {
  const items = [{ productId: "pa" }, { productId: "pb" }, { productId: "pa" }];
  const priced = [
    { trackedCategoryId: null },
    { trackedCategoryId: "cat1" },
    { trackedCategoryId: null },
  ];
  const created = [0, 1, 2].map((i) => ({
    id: `item${i}`,
    position: i,
    productId: items[i].productId,
    backorderedPieces: i === 2 ? 3 : 0,
  }));
  const order = { id: "o1", tenantId: "t1", lineItems: created };

  it("RESTRICTED from a warning names its lines by lineKey; a hard block names every line of each product", async () => {
    const warn = offlineCreate(opt());
    await warn.gate(() =>
      Promise.reject(
        conflict("RESTRICTION_WARNING", { lines: [{ lineKey: "n:1" }, { lineKey: "n:1" }] }),
      ),
    );
    expect(warn.rows({ created, items, priced }).map((r) => [r.kind, r.lineIndex])).toEqual([
      ["RESTRICTED", 1],
      ["BACKORDERED_OFFLINE", 2],
    ]);
    const hard = offlineCreate(opt());
    await hard.gate(() =>
      Promise.reject(
        conflict("SELLING_RESTRICTED", {
          blockedLines: [{ productId: "pa", reason: "STATE_BAN" }],
        }),
      ),
    );
    const rows = hard.rows({ created, items, priced }).filter((r) => r.kind === "RESTRICTED");
    expect(rows.map((r) => r.lineIndex)).toEqual([0, 2]);
    expect(rows[0].detail).toMatchObject({ productId: "pa", reason: "STATE_BAN" });
  });

  it("LICENSE_REQUIRED lands on the lines whose category is blocked, CREDIT_BLOCKED is order-level", async () => {
    const off = offlineCreate(opt());
    await off.gate(() =>
      Promise.reject(
        conflict("REGULATED_AUTH_REQUIRED", { blockedCategories: [{ trackedCategoryId: "cat1" }] }),
      ),
    );
    await off.gate(() =>
      Promise.reject(conflict("CREDIT_LIMIT_EXCEEDED", { limit: 5, exposure: 22 })),
    );
    const rows = off.rows({ created, items, priced });
    expect(rows.find((r) => r.kind === "LICENSE_REQUIRED")).toMatchObject({
      lineIndex: 1,
      detail: { lineIndex: 1, productId: "pb", trackedCategoryId: "cat1" },
    });
    expect(rows.find((r) => r.kind === "CREDIT_BLOCKED")).toMatchObject({
      lineIndex: null,
      detail: { limit: 5, exposure: 22 },
    });
  });

  it("the open order and a backordered line are flagged without any gate finding", () => {
    const rows = offlineCreate(opt({ openOrderId: "other" })).rows({ created, items, priced });
    expect(rows.map((r) => r.kind)).toEqual(["OPEN_ORDER_EXISTS", "BACKORDERED_OFFLINE"]);
    expect(rows[0].detail).toEqual({ existingOrderId: "other" });
    expect(rows[1].detail).toEqual({ lineIndex: 2, productId: "pa", backorderedPieces: 3 });
  });

  it("an online create (no option) produces no rows and writes nothing", async () => {
    const off = offlineCreate(undefined);
    expect(off.rows({ created, items, priced })).toEqual([]);
    const createMany = jest.fn();
    await off.writeFlags({ orderReviewFlag: { createMany } }, order, items, priced);
    expect(createMany).not.toHaveBeenCalled();
    expect(off.orderData()).toEqual({});
  });

  it("writeFlags is ONE createMany with an explicit tenantId and the line ids; none when there are no rows", async () => {
    const off = offlineCreate(opt({ openOrderId: "other" }));
    const createMany = jest.fn().mockResolvedValue({ count: 2 });
    await off.writeFlags({ orderReviewFlag: { createMany } }, order, items, priced);
    expect(createMany).toHaveBeenCalledTimes(1);
    const { data } = createMany.mock.calls[0][0];
    expect(data).toHaveLength(2);
    expect(data.every((d: any) => d.tenantId === "t1" && d.orderId === "o1")).toBe(true);
    expect(data.map((d: any) => d.orderItemId)).toEqual([null, "item2"]);
    const quiet = jest.fn();
    await offlineCreate(opt()).writeFlags(
      { orderReviewFlag: { createMany: quiet } },
      { ...order, lineItems: created.map((c) => ({ ...c, backorderedPieces: 0 })) },
      items,
      priced,
    );
    expect(quiet).not.toHaveBeenCalled();
  });

  it("drift findings become PRICE_CHANGED_OFFLINE rows; a typed override line is never flagged", () => {
    const off = offlineCreate(
      opt({
        quote: {
          total: 30,
          lines: [
            { index: 0, unitPrice: 10, unitsPerBox: null, unitLabel: null },
            { index: 1, unitPrice: 10, unitsPerBox: null, unitLabel: null },
          ],
        },
      }),
    );
    off.judgeDrift(
      [{ productId: "pa" }, { productId: "pb", unitPrice: 9 }],
      [
        { productId: "pa", unitPrice: 12 },
        { productId: "pb", unitPrice: 9 },
      ],
      21,
    );
    const rows = off.rows({ created: [], items, priced });
    expect(rows).toEqual([
      {
        kind: "PRICE_CHANGED_OFFLINE",
        lineIndex: 0,
        detail: { lineIndex: 0, productId: "pa", shown: 10, now: 12 },
      },
    ]);
  });

  it("orderData carries the device time only when one was sent", () => {
    const at = new Date("2026-11-07T15:00:00.000Z");
    expect(offlineCreate(opt({ createdAt: at })).orderData()).toEqual({ offlineCreatedAt: at });
    expect(offlineCreate(opt()).orderData()).toEqual({});
  });
});

describe("resolveOfflineRequest", () => {
  const user = (role: string) => ({ sub: "u", role, tenantId: "t" }) as JwtPayload;
  const dto = (extra: object = {}) =>
    ({
      customerId: "c",
      items: [{ productId: "p", qty: 1 }],
      ...extra,
    }) as unknown as CreateOrderDto;
  const quote = {
    total: 10,
    lines: [{ index: 0, unitPrice: 10, unitsPerBox: null, unitLabel: null }],
  };

  it("offline is read only when it is exactly true: absent, false or a string is an ordinary create", () => {
    expect(resolveOfflineRequest(dto(), user("CUSTOMER"))).toBeNull();
    expect(resolveOfflineRequest(dto({ offline: false }), user("DRIVER"))).toBeNull();
    expect(resolveOfflineRequest(dto({ offline: "true" }), user("DRIVER"))).toBeNull();
  });

  it("the role is judged before the money or the quote (a customer with no quote gets the 403)", () => {
    expect(() => resolveOfflineRequest(dto({ offline: true }), user("CUSTOMER"))).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  it("returns the quote and the parsed device time", () => {
    const r = resolveOfflineRequest(
      dto({ offline: true, offlineQuote: quote, offlineCreatedAt: "2026-11-07T15:00:00.000Z" }),
      user("TENANT_ADMIN"),
    );
    expect(r).toEqual({ quote, createdAt: new Date("2026-11-07T15:00:00.000Z") });
  });
});

describe("structural pins (SA-1124): offline is read only after the controller's role check", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("nothing but offline-create.ts reads the offline body fields off a DTO", () => {
    for (const f of [
      "orders/orders.service.ts",
      "orders/orders.controller.ts",
      "orders/order-list.ts",
    ]) {
      const src = strip(read(...f.split("/")));
      expect(src).not.toMatch(/dto\.offline|\.offlineQuote|\.offlineCreatedAt/);
    }
  });

  it("the service reads the internal option exactly once, behind offlineCreate()", () => {
    const src = strip(read("orders", "orders.service.ts"));
    expect(src.match(/options\.offline/g)).toHaveLength(1);
    expect(src).toContain("offlineCreate(options.offline)");
  });

  it("the controller resolves the offline request before any merge lookup", () => {
    const src = strip(read("orders", "orders.controller.ts"));
    const createAt = src.indexOf("async create(");
    const body = src.slice(createAt);
    expect(body.indexOf("resolveOfflineRequest(dto, user)")).toBeGreaterThan(-1);
    expect(body.indexOf("resolveOfflineRequest(dto, user)")).toBeLessThan(
      body.indexOf("findActiveOrder("),
    );
  });

  it("flags are written with createMany only, never nested under order.create", () => {
    const svc = strip(read("orders", "orders.service.ts"));
    expect(svc).not.toMatch(/reviewFlags\s*:\s*\{\s*create/);
    const off = strip(read("orders", "offline", "offline-create.ts"));
    expect(off.match(/orderReviewFlag\.createMany/g)).toHaveLength(1);
    expect(off).not.toMatch(/orderReviewFlag\.create\(/);
  });
});
