import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";

/**
 * SA-1161 P1 + P3: the allowlist runs once, in the service, inside the CUSTOMER owner block, under the
 * `buyerLineIds === true` test (the two client PATCH routes), before classification. P3 closes the
 * opt-in side: a new caller, or a new route that passes a CUSTOMER without the flag, fails here.
 */
const SRC = join(__dirname, "..");
const read = (f: string) => readFileSync(join(__dirname, f), "utf8");
const calls = (s: string) => s.match(/assertBuyerEditInput\(/g)?.length ?? 0;
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function sources(dir: string, out: Array<{ rel: string; src: string }> = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      sources(p, out);
    } else if (e.name.endsWith(".ts") && !/\.(spec|test)\.ts$/.test(e.name)) {
      out.push({
        rel: relative(SRC, p).split("\\").join("/"),
        src: strip(readFileSync(p, "utf8")),
      });
    }
  }
  return out;
}

describe("buyer edit allowlist call site (SA-1161 P1)", () => {
  it("is called once in orders.service.ts and in neither controller", () => {
    expect(calls(read("orders.service.ts"))).toBe(1);
    expect(calls(read("orders.controller.ts"))).toBe(0);
    expect(calls(read("../buyer/buyer.controller.ts"))).toBe(0);
  });

  it("the call sits in the CUSTOMER owner block, under the buyerLineIds test, before classifyEditPayload(", () => {
    const src = read("orders.service.ts");
    const block = src.indexOf("user?.role === UserRole.CUSTOMER");
    const call = src.indexOf("assertBuyerEditInput(dto)");
    const classify = src.indexOf("classifyEditPayload(", call);
    expect(block).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(block);
    expect(classify).toBeGreaterThan(call);
    expect(call - block).toBeLessThan(1500);
    expect(src.slice(block, call)).toContain("opts?.buyerLineIds === true");
  });
});

describe("buyer edit allowlist reach (SA-1161 P3)", () => {
  const files = sources(SRC);
  const count = (re: RegExp, only?: string[]) =>
    files
      .filter((f) => !only || only.includes(f.rel))
      .reduce((n, f) => n + (f.src.match(re) ?? []).length, 0);

  it("buyerLineIds: true appears at exactly the two client PATCH routes", () => {
    const sites = files
      .filter((f) => /buyerLineIds:\s*true/.test(f.src))
      .map((f) => f.rel)
      .sort();
    expect(sites).toEqual(["buyer/buyer.controller.ts", "orders/orders.controller.ts"]);
    expect(count(/buyerLineIds:\s*true/g)).toBe(2);
  });

  it("updateOrderItems( is called from exactly 5 sites: 2 buyer-controller, 3 orders-controller", () => {
    expect(count(/\.updateOrderItems\(/g)).toBe(5);
    expect(count(/\.updateOrderItems\(/g, ["buyer/buyer.controller.ts"])).toBe(2);
    expect(count(/\.updateOrderItems\(/g, ["orders/orders.controller.ts"])).toBe(3);
  });
});
