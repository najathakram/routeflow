import * as fs from "fs";
import * as path from "path";
import type { FulfilmentMethod, FulfillPath } from "@routeflow/types";

/**
 * B1059 / L-072: `FulfilmentMethod` mirrors the Prisma `FulfillPath` enum, so it must derive from
 * the shared `FulfillPath` (packages/types/api/enums.ts, pinned to Prisma by enum-parity.spec.ts)
 * instead of hand-typing its own `"ROUTE" | "SHIP" | "PICKUP"` union.
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
// Compile-time pin (checked by `tsc --noEmit`): the two types are identical.
export type FulfilmentMethodIsFulfillPath = Expect<Equal<FulfilmentMethod, FulfillPath>>;

describe("FulfilmentMethod mirror (B1059)", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../../../../packages/types/api/fulfilment.ts"),
    "utf8",
  );
  const decl = src.match(/export type FulfilmentMethod\s*=\s*([^;]+);/);

  it("declares FulfilmentMethod", () => {
    expect(decl).not.toBeNull();
  });

  it("derives from FulfillPath, not a hand-typed string-literal union", () => {
    expect(decl?.[1].trim()).toBe("FulfillPath");
  });
});
