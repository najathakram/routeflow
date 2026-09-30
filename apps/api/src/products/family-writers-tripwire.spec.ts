import { readFileSync } from "fs";
import { join } from "path";

/**
 * WS8 (SA-606): a FAMILY is never on a sellable line. Every writer of an order / estimate / invoice / PO line calls the ONE
 * `assertSellableLines` (products/sellable-lines.ts) with the products it loaded. This tripwire LISTS each call site by file
 * and exact count: a new line writer that skips the helper, or a removed call, fails here. Add the new writer's row
 * (and its call) in the same PR.
 */
const SRC = join(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const WRITERS: Record<string, { calls: number; why: string }> = {
  "orders/orders.service.ts": {
    calls: 4,
    why: "create(); updateOrderItems: replace-all (x2 load sites) and the diff edit-add",
  },
  "estimates/estimates.service.ts": { calls: 1, why: "estimate create/update line load" },
  "invoices/manual-invoice-context.ts": {
    calls: 1,
    why: "manual invoice line products (create/update share it)",
  },
  "inventory/inventory.service.ts": {
    calls: 3,
    why: "createDraftPurchaseOrderInTx, createPurchaseOrder, updatePurchaseOrder",
  },
};

describe("FAMILY never on a sellable line: the writers call assertSellableLines (WS8)", () => {
  it.each(Object.entries(WRITERS))("%s calls it %d time(s)", (file, { calls, why }) => {
    expect(why.length).toBeGreaterThan(10);
    const src = strip(readFileSync(join(SRC, file), "utf8"));
    expect((src.match(/assertSellableLines\(/g) ?? []).length).toBe(calls);
    expect(src).toMatch(/from "\.\.\/products\/sellable-lines"/);
  });

  it("no other non-spec file outside products/ calls it (a new writer must add its row above)", () => {
    const { execSync } = require("child_process") as typeof import("child_process");
    const out = execSync(`grep -rl "assertSellableLines(" "${SRC}" --include='*.ts' || true`, {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .map((f) => f.slice(SRC.length + 1))
      .filter((f) => !f.endsWith(".spec.ts") && !f.startsWith("products/"));
    expect(out.sort()).toEqual(Object.keys(WRITERS).sort());
  });
});
