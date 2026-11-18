import { readFileSync } from "fs";
import { join } from "path";

/** SA-1161 P1: the allowlist runs once, in the service, inside the CUSTOMER owner block, before classification. */
const read = (f: string) => readFileSync(join(__dirname, f), "utf8");
const calls = (s: string) => s.match(/assertBuyerEditInput\(/g)?.length ?? 0;

describe("buyer edit allowlist call site (SA-1161 P1)", () => {
  it("is called once in orders.service.ts and in neither controller", () => {
    expect(calls(read("orders.service.ts"))).toBe(1);
    expect(calls(read("orders.controller.ts"))).toBe(0);
    expect(calls(read("../buyer/buyer.controller.ts"))).toBe(0);
  });

  it("the call sits in the CUSTOMER owner block, before classifyEditPayload(", () => {
    const src = read("orders.service.ts");
    const block = src.indexOf("user?.role === UserRole.CUSTOMER");
    const call = src.indexOf("assertBuyerEditInput(dto)");
    const classify = src.indexOf("classifyEditPayload(", call);
    expect(block).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(block);
    expect(classify).toBeGreaterThan(call);
    expect(call - block).toBeLessThan(1500);
  });
});
