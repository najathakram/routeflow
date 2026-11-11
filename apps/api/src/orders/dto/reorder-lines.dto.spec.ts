import "reflect-metadata";
import * as fs from "fs";
import * as path from "path";
import { buildGlobalValidationPipe } from "../../common/global-validation-pipe";
import { ROLES_KEY } from "../../auth/decorators/roles.decorator";
import { OrdersController } from "../orders.controller";
import { BuyerController } from "../../buyer/buyer.controller";
import { LINE_ORDER_MAX_IDS, LINE_SORT_VALUES, ReorderLinesDto } from "./reorder-lines.dto";

/**
 * W-1187 (D5, D11): the body of the two line-order routes goes through the global pipe. Exactly two fields; nothing a
 * buyer could smuggle in survives; ids are bounded, unique UUIDs; and the routes keep their guards.
 */
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AT = "2026-11-08T12:00:00.000Z";
const pipe = buildGlobalValidationPipe();
const run = (body: unknown) =>
  pipe.transform(body, { type: "body", metatype: ReorderLinesDto, data: "" });

describe("ReorderLinesDto through the global validation pipe", () => {
  it("accepts a token and a list of line ids", async () => {
    const out = (await run({ expectedUpdatedAt: AT, lineIds: [ID(1), ID(2)] })) as ReorderLinesDto;
    expect(out.lineIds).toEqual([ID(1), ID(2)]);
    expect(out.expectedUpdatedAt).toBe(AT);
  });

  it("BG-f: refuses any other field (a line field, a revision, a tenant)", async () => {
    for (const extra of [
      { qty: 9 },
      { expectedRevisionNumber: 3 },
      { tenantId: "t" },
      { items: [] },
      { position: 0 },
    ]) {
      await expect(
        run({ expectedUpdatedAt: AT, lineIds: [ID(1)], ...extra }),
      ).rejects.toMatchObject({ status: 400 });
    }
  });

  it("refuses a missing token, a bad token, a missing list and a non-array list", async () => {
    for (const body of [
      { lineIds: [ID(1)] },
      { expectedUpdatedAt: "yesterday", lineIds: [ID(1)] },
      { expectedUpdatedAt: AT },
      { expectedUpdatedAt: AT, lineIds: ID(1) },
      { expectedUpdatedAt: AT, lineIds: null },
    ]) {
      await expect(run(body)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("refuses a duplicate id and a non-UUID id", async () => {
    await expect(run({ expectedUpdatedAt: AT, lineIds: [ID(1), ID(1)] })).rejects.toMatchObject({
      status: 400,
    });
    await expect(run({ expectedUpdatedAt: AT, lineIds: ["not-a-uuid"] })).rejects.toMatchObject({
      status: 400,
    });
    await expect(run({ expectedUpdatedAt: AT, lineIds: [{ id: ID(1) }] })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("R-sort: accepts sort name in place of a list; refuses both, an unknown mode, a non-string and neither", async () => {
    const out = (await run({ expectedUpdatedAt: AT, sort: "name" })) as ReorderLinesDto;
    expect(out.sort).toBe("name");
    for (const bad of [
      { expectedUpdatedAt: AT, sort: "name", lineIds: [ID(1)] },
      { expectedUpdatedAt: AT, sort: "price" },
      { expectedUpdatedAt: AT, sort: 1 },
      { expectedUpdatedAt: AT },
    ]) {
      await expect(run(bad)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("bounds the list at LINE_ORDER_MAX_IDS", async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => ID(i + 1));
    await expect(
      run({ expectedUpdatedAt: AT, lineIds: ids(LINE_ORDER_MAX_IDS) }),
    ).resolves.toBeDefined();
    await expect(
      run({ expectedUpdatedAt: AT, lineIds: ids(LINE_ORDER_MAX_IDS + 1) }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("LINE_SORT_VALUES parity (the API never value-imports @routeflow/types)", () => {
  it("equals the shared list", () => {
    const shared = fs.readFileSync(
      path.resolve(__dirname, "../../../../../packages/types/api/line-order.ts"),
      "utf8",
    );
    const m = /LINE_SORT_VALUES = \[([^\]]*)\] as const/.exec(shared);
    expect(m).not.toBeNull();
    expect(LINE_SORT_VALUES).toEqual(m![1].split(",").map((v) => v.trim().replace(/"/g, "")));
  });
});

describe("LINE_ORDER_MAX_IDS parity (the API never value-imports @routeflow/types)", () => {
  it("equals the shared constant", () => {
    const shared = fs.readFileSync(
      path.resolve(__dirname, "../../../../../packages/types/api/line-order.ts"),
      "utf8",
    );
    const m = /export const LINE_ORDER_MAX_IDS\s*=\s*(\d+)\s*;/.exec(shared);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(LINE_ORDER_MAX_IDS);
  });
});

describe("the line-order routes keep their guards", () => {
  it("the staff route is operators and above only (a driver and a buyer are refused)", () => {
    const roles = Reflect.getMetadata(ROLES_KEY, OrdersController.prototype.reorderLines);
    expect(roles).toEqual(["OPERATOR"]);
  });

  it("the buyer route sits behind the seller-context guard, not the staff guard", () => {
    const guards: Array<{ name: string }> =
      Reflect.getMetadata("__guards__", BuyerController.prototype.reorderLines) ?? [];
    expect(guards.map((g) => g.name)).toEqual(["BuyerSellerContextGuard"]);
  });
});
