/**
 * #3168 batch ship: the pure classifier, the service (sequential, refusals write nothing, exception
 * -> outcome mapping, rerun safe, tenant-scoped) and the outcome-set parity with packages/types.
 */
import * as fs from "fs";
import * as path from "path";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { FulfillPath, OrderStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { BATCH_SHIP_MAX } from "./dto/batch-ship.dto";
import {
  BATCH_SHIP_OUTCOMES,
  MESSAGES,
  TRACKING_SAVED_MESSAGES,
  OrderBatchShipService,
  classifyForShip,
} from "./order-batch-ship";
import { ORDER_STATUS_TRANSITIONS } from "./order-status-transitions";

const user = { sub: "u1", role: "OPERATOR", tenantId: "t1" } as any;

describe("classifyForShip (pure)", () => {
  const o = (status: OrderStatus, fulfillPath: FulfillPath = FulfillPath.SHIP) => ({
    status,
    fulfillPath,
  });
  it("a CONFIRMED carrier order is shippable (null)", () => {
    expect(classifyForShip(o(OrderStatus.CONFIRMED))).toBeNull();
  });
  it.each([FulfillPath.ROUTE, FulfillPath.PICKUP])("%s -> NOT_CARRIER_ORDER", (p) => {
    expect(classifyForShip(o(OrderStatus.CONFIRMED, p))).toBe("NOT_CARRIER_ORDER");
  });
  it("carrier check wins over status", () => {
    expect(classifyForShip(o(OrderStatus.DELIVERED, FulfillPath.ROUTE))).toBe("NOT_CARRIER_ORDER");
  });
  it.each([OrderStatus.OUT_FOR_DELIVERY, OrderStatus.PARTIALLY_DELIVERED, OrderStatus.DELIVERED])(
    "%s -> ALREADY_SHIPPED",
    (s) => {
      expect(classifyForShip(o(s))).toBe("ALREADY_SHIPPED");
    },
  );
  it.each([OrderStatus.DRAFT, OrderStatus.PENDING, OrderStatus.CANCELLED])(
    "%s -> NOT_CONFIRMED",
    (s) => {
      expect(classifyForShip(o(s))).toBe("NOT_CONFIRMED");
    },
  );
  it("the transition table still lets CONFIRMED go OUT_FOR_DELIVERY (the classifier's premise)", () => {
    expect(ORDER_STATUS_TRANSITIONS.CONFIRMED).toContain("OUT_FOR_DELIVERY");
  });
  it("no-copy pin: imports the transition table and SHIPPED_STATUSES, never re-declares them", () => {
    const src = fs.readFileSync(path.join(__dirname, "order-batch-ship.ts"), "utf8");
    expect(src).toMatch(
      /import[^;]*ORDER_STATUS_TRANSITIONS[^;]*from "\.\/order-status-transitions"/,
    );
    expect(src).toMatch(/import[^;]*SHIPPED_STATUSES[^;]*from "\.\/shipment-notifications"/);
    expect(src).not.toMatch(/new Set<OrderStatus>\(/);
    expect(src).not.toMatch(/OUT_FOR_DELIVERY:\s*\[/);
  });
});

describe("outcome parity (L-072)", () => {
  it("api literal === packages/types BATCH_SHIP_OUTCOMES", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const shared = (require("@routeflow/types") as Record<string, unknown>).BATCH_SHIP_OUTCOMES as
      readonly string[] | undefined;
    expect([...(shared ?? [])].sort()).toEqual([...BATCH_SHIP_OUTCOMES].sort());
  });
  it("api BATCH_SHIP_MAX === packages/types BATCH_SHIP_MAX_ORDERS", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const shared = (require("@routeflow/types") as Record<string, unknown>).BATCH_SHIP_MAX_ORDERS;
    expect(shared).toBe(BATCH_SHIP_MAX);
    // The mobile jest stub of @routeflow/types carries a hand copy; pin it too.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mobileStub = require("../../../mobile/__tests__/__mocks__/@routeflow/types.js");
    expect(mobileStub.BATCH_SHIP_MAX_ORDERS).toBe(BATCH_SHIP_MAX);
  });
});

type Row = {
  id: string;
  orderNumber: string | null;
  status: OrderStatus;
  fulfillPath: FulfillPath;
};
const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  orderNumber: `N-${id}`,
  status: OrderStatus.CONFIRMED,
  fulfillPath: FulfillPath.SHIP,
  ...over,
});

function build(rows: Row[]) {
  const db = new Map(rows.map((r) => [r.id, { ...r }]));
  const calls: string[] = [];
  const findFirst = jest.fn(async ({ where }: any) => db.get(where.id) ?? null);
  const prisma = { forTenant: () => ({ order: { findFirst } }) } as any;
  const ordersService = {
    updateShipment: jest.fn(async (id: string) => {
      calls.push(`ship:${id}`);
    }),
    changeStatus: jest.fn(async (id: string) => {
      calls.push(`status:${id}`);
      const r = db.get(id)!;
      r.status = OrderStatus.OUT_FOR_DELIVERY;
    }),
  };
  const svc = new OrderBatchShipService(prisma, ordersService as any);
  return { svc, ordersService, findFirst, calls, db };
}

describe("OrderBatchShipService.batchShip", () => {
  it("ships in request order, SEQUENTIALLY, tracking first then status", async () => {
    const { svc, calls, ordersService } = build([row("a"), row("b")]);
    let inFlight = 0;
    let maxInFlight = 0;
    ordersService.changeStatus.mockImplementation(async (id: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      calls.push(`status:${id}`);
      inFlight--;
    });
    const res = await svc.batchShip(
      [{ orderId: "a", carrier: "UPS", trackingNumber: "1Z" }, { orderId: "b" }],
      user,
    );
    expect(res.results.map((r) => [r.orderId, r.outcome])).toEqual([
      ["a", "SHIPPED"],
      ["b", "SHIPPED"],
    ]);
    expect(maxInFlight).toBe(1);
    expect(calls).toEqual(["ship:a", "status:a", "status:b"]);
    expect(ordersService.changeStatus).toHaveBeenCalledWith(
      "a",
      { status: OrderStatus.OUT_FOR_DELIVERY },
      user,
    );
  });

  it("does not use Promise.all / allSettled (source pin)", () => {
    const src = fs.readFileSync(path.join(__dirname, "order-batch-ship.ts"), "utf8");
    expect(src).not.toMatch(/Promise\.(all|allSettled)\(/);
  });

  it("refused orders get ZERO writes", async () => {
    const { svc, ordersService } = build([
      row("r", { fulfillPath: FulfillPath.ROUTE }),
      row("p", { status: OrderStatus.PENDING }),
      row("s", { status: OrderStatus.DELIVERED }),
    ]);
    const res = await svc.batchShip(
      [
        { orderId: "r", trackingNumber: "T" },
        { orderId: "p", trackingNumber: "T" },
        { orderId: "s", trackingNumber: "T" },
      ],
      user,
    );
    expect(res.results.map((r) => r.outcome)).toEqual([
      "NOT_CARRIER_ORDER",
      "NOT_CONFIRMED",
      "ALREADY_SHIPPED",
    ]);
    expect(ordersService.updateShipment).not.toHaveBeenCalled();
    expect(ordersService.changeStatus).not.toHaveBeenCalled();
  });

  it("no tracking given -> updateShipment is not called", async () => {
    const { svc, ordersService } = build([row("a")]);
    await svc.batchShip([{ orderId: "a" }], user);
    expect(ordersService.updateShipment).not.toHaveBeenCalled();
  });

  it("a foreign / missing id -> NOT_FOUND, no write, same shape as a missing id", async () => {
    const { svc, ordersService } = build([row("a")]);
    const res = await svc.batchShip([{ orderId: "foreign-tenant-id", trackingNumber: "T" }], user);
    expect(res.results).toEqual([
      {
        orderId: "foreign-tenant-id",
        orderNumber: null,
        outcome: "NOT_FOUND",
        message: expect.any(String),
      },
    ]);
    expect(ordersService.updateShipment).not.toHaveBeenCalled();
    expect(ordersService.changeStatus).not.toHaveBeenCalled();
  });

  it("lookup goes through prisma.forTenant() (tenant-scoped read)", async () => {
    const { svc, findFirst } = build([row("a")]);
    await svc.batchShip([{ orderId: "a" }], user);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "a" } }));
  });

  it("credit gate 409 -> CREDIT_HOLD and the batch continues", async () => {
    const { svc, ordersService } = build([row("a"), row("b")]);
    ordersService.changeStatus.mockRejectedValueOnce(
      new ConflictException({ code: API_ERROR_CODES.CREDIT_LIMIT_EXCEEDED, message: "over limit" }),
    );
    const res = await svc.batchShip([{ orderId: "a" }, { orderId: "b" }], user);
    expect(res.results.map((r) => r.outcome)).toEqual(["CREDIT_HOLD", "SHIPPED"]);
  });

  it("B1095 409 -> ORDER_CHANGED", async () => {
    const { svc, ordersService } = build([row("a")]);
    ordersService.changeStatus.mockRejectedValueOnce(
      new ConflictException({ code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT, message: "x" }),
    );
    const res = await svc.batchShip([{ orderId: "a" }], user);
    expect(res.results[0].outcome).toBe("ORDER_CHANGED");
  });

  it("invalid tracking (400 from updateShipment) -> INVALID_TRACKING, status never changed", async () => {
    const { svc, ordersService } = build([row("a")]);
    ordersService.updateShipment.mockRejectedValueOnce(new BadRequestException("bad"));
    const res = await svc.batchShip([{ orderId: "a", trackingNumber: "T" }], user);
    expect(res.results[0].outcome).toBe("INVALID_TRACKING");
    expect(ordersService.changeStatus).not.toHaveBeenCalled();
  });

  it("over-long tracking is refused up front with no writes", async () => {
    const { svc, ordersService } = build([row("a")]);
    const res = await svc.batchShip([{ orderId: "a", trackingNumber: "x".repeat(129) }], user);
    expect(res.results[0].outcome).toBe("INVALID_TRACKING");
    expect(ordersService.updateShipment).not.toHaveBeenCalled();
    expect(ordersService.changeStatus).not.toHaveBeenCalled();
  });

  it("invoice settle failure AFTER the status committed -> SHIPPED_INVOICE_PENDING", async () => {
    const { svc, ordersService, db } = build([row("a")]);
    ordersService.changeStatus.mockImplementationOnce(async (id: string) => {
      db.get(id)!.status = OrderStatus.OUT_FOR_DELIVERY; // committed
      throw new ConflictException({
        code: API_ERROR_CODES.ORDER_INVOICE_SETTLE_FAILED,
        message: "The order was marked shipped, but its invoice could not be created",
      });
    });
    const res = await svc.batchShip([{ orderId: "a" }], user);
    expect(res.results[0].outcome).toBe("SHIPPED_INVOICE_PENDING");
  });

  it("a 400 from changeStatus -> FAILED, not INVALID_TRACKING (#3168 a)", async () => {
    const { svc, ordersService } = build([row("a")]);
    ordersService.changeStatus.mockRejectedValueOnce(new BadRequestException("bad transition"));
    const res = await svc.batchShip([{ orderId: "a" }], user);
    expect(res.results[0].outcome).toBe("FAILED");
  });

  it("a non-invoice 409 on an order that ended shipped -> FAILED, not SHIPPED_INVOICE_PENDING (#3168 b)", async () => {
    const { svc, ordersService, db } = build([row("a")]);
    ordersService.changeStatus.mockImplementationOnce(async (id: string) => {
      db.get(id)!.status = OrderStatus.OUT_FOR_DELIVERY;
      throw new ConflictException({ code: "SOME_OTHER_CONFLICT" });
    });
    const res = await svc.batchShip([{ orderId: "a" }], user);
    expect(res.results[0].outcome).toBe("FAILED");
  });

  it("a 409 with the invoice-failure TEXT but no code on a shipped order -> FAILED (#3168 b)", async () => {
    const { svc, ordersService, db } = build([row("a")]);
    ordersService.changeStatus.mockImplementationOnce(async (id: string) => {
      db.get(id)!.status = OrderStatus.OUT_FOR_DELIVERY;
      throw new ConflictException(
        "The order was marked shipped, but its invoice could not be created",
      );
    });
    const res = await svc.batchShip([{ orderId: "a" }], user);
    expect(res.results[0].outcome).toBe("FAILED");
  });

  it("ORDER_INVOICES_NEED_REVIEW on a shipped order -> SHIPPED_INVOICE_PENDING (#3168 b)", async () => {
    const { svc, ordersService, db } = build([row("a")]);
    ordersService.changeStatus.mockImplementationOnce(async (id: string) => {
      db.get(id)!.status = OrderStatus.OUT_FOR_DELIVERY;
      throw new ConflictException({ code: API_ERROR_CODES.ORDER_INVOICES_NEED_REVIEW });
    });
    const res = await svc.batchShip([{ orderId: "a" }], user);
    expect(res.results[0].outcome).toBe("SHIPPED_INVOICE_PENDING");
  });

  it("every outcome has both a plain and a tracking-saved sentence; no cut sentences (#3168 c)", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const shared = (require("@routeflow/types") as Record<string, unknown>)
      .BATCH_SHIP_OUTCOMES as readonly string[];
    expect(Object.keys(MESSAGES).sort()).toEqual([...shared].sort());
    expect(Object.keys(TRACKING_SAVED_MESSAGES).sort()).toEqual([...shared].sort());
    for (const [outcome, m] of Object.entries(TRACKING_SAVED_MESSAGES)) {
      expect(m).not.toMatch(/Nothing was/);
      // the two shipped outcomes keep their plain sentence (tracking saved is implied by shipping)
      if (!outcome.startsWith("SHIPPED")) expect(m.endsWith("The tracking was saved.")).toBe(true);
    }
  });

  it("tracking saved but the ship failed -> trackingSaved + message says so (#3168 c)", async () => {
    const { svc, ordersService } = build([row("a"), row("b")]);
    ordersService.changeStatus.mockRejectedValueOnce(new Error("pg down"));
    const res = await svc.batchShip(
      [{ orderId: "a", carrier: "UPS", trackingNumber: "1Z" }, { orderId: "b" }],
      user,
    );
    expect(res.results[0].outcome).toBe("FAILED");
    expect(res.results[0].trackingSaved).toBe(true);
    expect(res.results[0].message).toMatch(/tracking was saved/i);
    expect(res.results[0].message).not.toMatch(/nothing was/i);
    expect(res.results[1].trackingSaved).toBeFalsy();
  });

  it("an unknown error with the status unchanged -> FAILED (message not leaked raw)", async () => {
    const { svc, ordersService } = build([row("a")]);
    ordersService.changeStatus.mockRejectedValueOnce(new Error("pg: secret detail"));
    const res = await svc.batchShip([{ orderId: "a" }], user);
    expect(res.results[0].outcome).toBe("FAILED");
    expect(res.results[0].message).not.toContain("secret");
  });

  it("a rerun -> ALREADY_SHIPPED with no second changeStatus (so no second shipped email)", async () => {
    const { svc, ordersService } = build([row("a")]);
    const first = await svc.batchShip([{ orderId: "a" }], user);
    const second = await svc.batchShip([{ orderId: "a" }], user);
    expect(first.results[0].outcome).toBe("SHIPPED");
    expect(second.results[0].outcome).toBe("ALREADY_SHIPPED");
    expect(ordersService.changeStatus).toHaveBeenCalledTimes(1);
  });

  it("a duplicate id in one request is processed once", async () => {
    const { svc, ordersService } = build([row("a")]);
    const res = await svc.batchShip([{ orderId: "a" }, { orderId: "a" }], user);
    expect(res.results).toHaveLength(1);
    expect(ordersService.changeStatus).toHaveBeenCalledTimes(1);
  });
});
