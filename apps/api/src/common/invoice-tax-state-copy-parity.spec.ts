import { TAX_STATE_STALE_COPY } from "../invoices/stored-tax-state";

/**
 * SA-814e: the 409 INVOICE_TAX_STATE_STALE sentence per `path` exists in two places. Web and mobile read it
 * from `@routeflow/types` (`INVOICE_TAX_STATE_STALE_COPY`); the API keeps a literal copy because it never
 * value-imports `@routeflow/types` at runtime (the SHIPPED_ORDER_MESSAGE precedent). This pins them
 * byte-equal, key for key, so the message the API sends and the copy a client shows cannot drift apart.
 */
function readShared(): Record<string, string> | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (
      require("@routeflow/types") as { INVOICE_TAX_STATE_STALE_COPY?: Record<string, string> }
    ).INVOICE_TAX_STATE_STALE_COPY;
  } catch {
    return undefined;
  }
}

describe("invoice tax-state 409 copy: API literal == shared copy (SA-814e)", () => {
  const shared = readShared();

  it("the shared copy is exported by @routeflow/types (build it first if this is undefined)", () => {
    expect(shared).toBeDefined();
  });

  it("the API's literal is byte-equal to the shared one for every path", () => {
    expect(TAX_STATE_STALE_COPY).toEqual(shared);
  });
});
