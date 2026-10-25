/**
 * W-871 (SA-948 §2 MUST 1): updateOrderItems now refuses a replace on a post-delivery order with 409
 * LINES_REPLACE_AFTER_DELIVERY. The server's own `replaceAll: true` senders are the two merge folds (staff create's
 * auto-merge, the buyer's order merge). This pins that both fold into `findActiveOrder`'s target only, and that the
 * target search reads DRAFT / PENDING orders only, so neither fold can reach a post-delivery order. A new sender, or
 * a widened status list, turns this red and goes back to the SA.
 */
import * as fs from "fs";
import * as path from "path";
import { OrderStatus } from "@prisma/client";
import { findActiveOrderImpl } from "./merge-candidates";

const SRC = path.join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !/\.(spec|test)\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Code lines only: a `replaceAll: true` inside a comment is not a sender. */
const codeLines = (file: string) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => !/^\s*(\*|\/\/|\/\*)/.test(l));

describe("W-871 pin: the merge folds only target pre-delivery orders", () => {
  it("the only replaceAll: true senders in apps/api/src are the two folds", () => {
    const senders = walk(SRC).flatMap((f) =>
      codeLines(f)
        .filter(({ l }) => /replaceAll:\s*true/.test(l))
        .map(() => path.relative(SRC, f)),
    );
    expect(senders.sort()).toEqual(["buyer/buyer.controller.ts", "orders/orders.controller.ts"]);
  });

  it.each([
    [
      "orders/orders.controller.ts",
      "current",
      /const current = await this\.ordersService\.findActiveOrder\(/,
    ],
    [
      "buyer/buyer.controller.ts",
      "activeOrder",
      /const activeOrder = await this\.ordersService\.findActiveOrder\(/,
    ],
  ])("%s folds into the findActiveOrder target (%s)", (file, name, decl) => {
    const text = fs.readFileSync(path.join(SRC, file), "utf8");
    expect(text).toMatch(decl);
    // the fold's write names that target, and nothing else
    expect(text).toMatch(new RegExp(`updateOrderItems\\(\\s*${name}\\.id,`));
  });

  it("findActiveOrder's search reads DRAFT and PENDING orders only", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    await findActiveOrderImpl({ forTenant: () => ({ order: { findFirst } }) } as any, "cust-1");
    expect(findFirst.mock.calls[0][0].where.status).toEqual({
      in: [OrderStatus.DRAFT, OrderStatus.PENDING],
    });
  });
});
