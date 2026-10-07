import {
  getReactivationRefusal,
  reactivationRetryPayload,
  reactivationResolveLabel,
} from "../lib/product-reactivation-refusal";

const err = (data: unknown) => ({ response: { status: 409, data } });

describe("getReactivationRefusal", () => {
  it("lists the holders of a CODE_TAKEN 409 and the ids to deactivate", () => {
    const r = getReactivationRefusal(
      err({
        code: "CODE_TAKEN",
        message: "RAW SERVER TEXT",
        field: "sku",
        value: "A-1",
        productId: "h1",
        productName: "Grape Soda",
        holders: [
          {
            code: "CODE_TAKEN",
            field: "sku",
            value: "A-1",
            productId: "h1",
            productName: "Grape Soda",
          },
          {
            code: "CODE_TAKEN",
            field: "unitSku",
            value: "U-1",
            productId: "h2",
            productName: "Cola",
          },
        ],
      }),
    );
    expect(r).toMatchObject({ kind: "HOLDERS", holderIds: ["h1", "h2"], canResolve: true });
    if (r?.kind !== "HOLDERS") throw new Error("expected holders");
    expect(r.holders.map((h) => h.productName)).toEqual(["Grape Soda", "Cola"]);
  });

  it("never carries the raw server message into the copy", () => {
    const r = getReactivationRefusal(
      err({
        code: "NAME_TAKEN",
        message: "RAW SERVER TEXT",
        field: "name",
        value: "Grape Soda",
        productId: "h1",
        productName: "Grape Soda",
      }),
    );
    expect(JSON.stringify(r)).not.toContain("RAW SERVER TEXT");
    expect(r).toMatchObject({ kind: "HOLDERS", holderIds: ["h1"] });
  });

  it("falls back to the flat keys when holders[] is absent", () => {
    const r = getReactivationRefusal(
      err({
        code: "BARCODE_TAKEN",
        field: "barcode",
        value: "123",
        productId: "h9",
        productName: "X",
      }),
    );
    expect(r).toMatchObject({ kind: "HOLDERS", holderIds: ["h9"] });
  });

  it("cannot resolve when a holder is blocked by active variants", () => {
    const r = getReactivationRefusal(
      err({
        code: "CODE_TAKEN",
        field: "sku",
        value: "A",
        productId: "h1",
        productName: "Family",
        blocked: "HAS_ACTIVE_VARIANTS",
        holders: [
          {
            code: "CODE_TAKEN",
            field: "sku",
            value: "A",
            productId: "h1",
            productName: "Family",
            blocked: "HAS_ACTIVE_VARIANTS",
          },
        ],
      }),
    );
    expect(r).toMatchObject({ kind: "HOLDERS", canResolve: false });
  });

  it("asks for a plain retry when the holder set went stale", () => {
    expect(getReactivationRefusal(err({ code: "HOLDERS_CHANGED", holders: [] }))).toEqual({
      kind: "RETRY",
    });
  });

  it("is null for any other failure (the caller shows a generic line)", () => {
    expect(getReactivationRefusal(err({ code: "SOMETHING_ELSE", message: "x" }))).toBeNull();
    expect(getReactivationRefusal(new Error("network"))).toBeNull();
    expect(getReactivationRefusal(null)).toBeNull();
  });
});

describe("reactivationRetryPayload", () => {
  it("re-sends the reactivation with exactly the holder ids", () => {
    expect(reactivationRetryPayload("p1", ["h1", "h2"])).toEqual({
      id: "p1",
      isActive: true,
      deactivateHolderIds: ["h1", "h2"],
    });
  });
  it("omits the key when there are no ids", () => {
    expect(reactivationRetryPayload("p1", [])).toEqual({ id: "p1", isActive: true });
  });
});

describe("reactivationResolveLabel", () => {
  it("names one or two holders, counts more", () => {
    expect(reactivationResolveLabel(["A"])).toBe('Deactivate "A" and reactivate this');
    expect(reactivationResolveLabel(["A", "B", "C"])).toBe(
      "Deactivate 3 products and reactivate this",
    );
  });
});
