/**
 * W-904 / SA-1142 R6: the `shippedAt` writer inventory, count-pinned and shrink-only (OP-7), plus the structural rule
 * the fix rests on: a tracking save never writes `shippedAt` from a value it read. The stamp comes from the ship
 * transition (order-status-claim.ts); everything else is a conditional, fill-only write the database judges.
 *
 * A new file that carries a `shippedAt:` key fails until it is listed here with a reason; a changed count in a listed
 * file fails too. Readers (`select: { shippedAt: true }`) are not counted.
 */
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..");
const KEY = /\bshippedAt\s*:(?!\s*true\b)/g;

/** file (relative to apps/api/src) -> number of `shippedAt:` keys that are not `: true` selects, and why. */
const INVENTORY: Record<string, { count: number; why: string }> = {
  "buyer/buyer-dashboard.service.ts": { count: 1, why: "read model field (portal DTO)" },
  "invoices/invoices.service.ts": {
    count: 1,
    why: "standalone invoice create stamps `now` with a tracking number",
  },
  "invoices/order-shipment-fields.ts": {
    count: 4,
    why: "copy of the order's stamp at creation (1); writeInvoiceTracking: CLEAR null, fill-only where + data (3)",
  },
  "orders/carrier-in-transit-guard.ts": { count: 1, why: "where-filter (read)" },
  "orders/merge-candidates.ts": { count: 1, why: "where-filter (read)" },
  "orders/order-lifecycle.ts": {
    count: 4,
    why: "tracking save: conditional order backfill (where + data), fill-only invoice mirror (where + data)",
  },
  "orders/order-status-claim.ts": { count: 1, why: "the ship transition's own stamp" },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.(spec|test)\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The text of the first balanced `(...)` call that starts at `needle` in `src`. */
function callText(src: string, needle: string, from = 0): string {
  const at = src.indexOf(needle, from);
  if (at < 0) throw new Error(`pin: ${needle} not found`);
  let depth = 0;
  for (let i = src.indexOf("(", at); i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`pin: unbalanced call at ${needle}`);
}

describe("W-904 shippedAt writers (SA-1142 R6)", () => {
  it("every file with a shippedAt key is listed, with its count (count-pinned, shrink-only)", () => {
    const found: Record<string, number> = {};
    for (const f of walk(SRC)) {
      if (f.includes(`${path.sep}testing${path.sep}`)) continue;
      const n = (fs.readFileSync(f, "utf8").match(KEY) ?? []).length;
      if (n > 0) found[path.relative(SRC, f).split(path.sep).join("/")] = n;
    }
    expect(found).toEqual(
      Object.fromEntries(Object.entries(INVENTORY).map(([k, v]) => [k, v.count])),
    );
  });

  const lifecycle = fs.readFileSync(path.join(SRC, "orders/order-lifecycle.ts"), "utf8");
  const fn = lifecycle.slice(lifecycle.indexOf("export async function updateShipmentImpl"));

  it("the tracking save's main order write and the mirror's carrier write carry no shippedAt key", () => {
    expect(callText(fn, "db.order.update(")).not.toMatch(/\bshippedAt\b/);
    expect(callText(fn, "db.invoice.updateMany(")).not.toMatch(/\bshippedAt\b/);
  });

  it("the only shippedAt writes are the conditional backfill and the fill-only mirror (both `where shippedAt: null`)", () => {
    const backfill = callText(fn, "db.order.updateMany(");
    expect(backfill).toMatch(/where:[^]*shippedAt:\s*null/);
    const mirror = callText(
      fn,
      "db.invoice.updateMany(",
      fn.indexOf("db.invoice.updateMany(") + 10,
    );
    expect(mirror).toMatch(/where:[^]*shippedAt:\s*null/);
  });
});

describe("W-904 invoice tracking save (SA-1142 R4)", () => {
  const src = fs.readFileSync(path.join(SRC, "invoices/order-shipment-fields.ts"), "utf8");
  const fn = src.slice(src.indexOf("export async function writeInvoiceTracking"));

  it("the update's data writes the date only through the CLEAR spread; the SET stamp is where shippedAt is null", () => {
    expect(callText(fn, "db.invoice.update(")).not.toMatch(/shippedAt/);
    expect(fn).toContain("const clear = tracking ? {} : { shippedAt: null }");
    expect(callText(fn, "db.invoice.updateMany(")).toMatch(/where:[^]*shippedAt:\s*null/);
  });

  it("updateInvoiceShipment delegates to it and writes no shippedAt itself", () => {
    const svc = fs.readFileSync(path.join(SRC, "invoices/invoices.service.ts"), "utf8");
    const body = svc.slice(svc.indexOf("async updateInvoiceShipment("));
    const method = body.slice(0, body.indexOf("\n  }\n"));
    expect(method).toContain("writeInvoiceTracking(");
    expect(method).not.toMatch(/shippedAt/);
  });
});
