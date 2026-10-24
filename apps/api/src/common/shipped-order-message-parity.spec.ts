import { SHIPPED_ORDER_MESSAGE as API_COPY } from "../orders/order-carrier-guard";

/**
 * B1135: the sentence for an order that is with the carrier exists in two places. Web and mobile read
 * it from `@routeflow/types` (`SHIPPED_ORDER_MESSAGE`); the API keeps a literal copy because it never
 * value-imports `@routeflow/types` at runtime (see `no-runtime-workspace-imports.spec.ts`, the same
 * reason `api-error-codes.ts` is a local copy). This pins the two byte-equal, so the 409 the API sends
 * and the sentence the web shows for it cannot drift apart.
 */
function readShared(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require("@routeflow/types") as { SHIPPED_ORDER_MESSAGE?: string })
      .SHIPPED_ORDER_MESSAGE;
  } catch {
    return undefined;
  }
}

describe("shipped-order sentence: API copy == shared copy (B1135)", () => {
  const shared = readShared();

  it("the shared copy is exported by @routeflow/types (build it first if this is undefined)", () => {
    expect(typeof shared).toBe("string");
    expect((shared ?? "").length).toBeGreaterThan(0);
  });

  it("the API's literal is byte-equal to the shared one", () => {
    expect(API_COPY).toBe(shared);
  });
});
