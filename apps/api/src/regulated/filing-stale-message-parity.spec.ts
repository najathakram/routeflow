import { FILING_STALE_MESSAGE } from "./regulated-filing.service";

/**
 * SA-995: the sentence for a filing whose figures no longer match the ledger exists in two places. Web reads it from
 * `@routeflow/types` (`FILING_STALE_COPY`); the API keeps a literal copy because it never value-imports
 * `@routeflow/types` at runtime (same reason as `common/shipped-order-message-parity.spec.ts`). Pinned byte-equal.
 */
function readShared(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require("@routeflow/types") as { FILING_STALE_COPY?: string }).FILING_STALE_COPY;
  } catch {
    return undefined;
  }
}

describe("filing-stale sentence: API copy == shared copy (SA-995)", () => {
  const shared = readShared();

  it("the shared copy is exported by @routeflow/types (build it first if this is undefined)", () => {
    expect(typeof shared).toBe("string");
    expect((shared ?? "").length).toBeGreaterThan(0);
  });

  it("the API's literal is byte-equal to the shared one", () => {
    expect(FILING_STALE_MESSAGE).toBe(shared);
  });
});
