import { ORDER_DELIVERED_ON_ROUTE_STOP_COPY as API_COPY } from "../orders/office-delivered-route-stop";

/**
 * Row 590: the sentence for an office DELIVERED on a run-stop order exists in two places. Web reads it from
 * `@routeflow/types`; the API keeps a literal copy (it never value-imports that package at runtime). This pins the two
 * byte-equal, so the 409 the API sends and the sentence the web shows for it cannot drift apart.
 */
function readShared(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require("@routeflow/types") as { ORDER_DELIVERED_ON_ROUTE_STOP_COPY?: string })
      .ORDER_DELIVERED_ON_ROUTE_STOP_COPY;
  } catch {
    return undefined;
  }
}

describe("run-stop DELIVERED sentence: API copy == shared copy (row 590)", () => {
  const shared = readShared();

  it("the shared copy is exported by @routeflow/types (build it first if this is undefined)", () => {
    expect(typeof shared).toBe("string");
    expect((shared ?? "").length).toBeGreaterThan(0);
  });

  it("the API's literal is byte-equal to the shared one", () => {
    expect(API_COPY).toBe(shared);
  });
});
