import { orderTaxLabel } from "./order-tax-label";

/**
 * Row 329a: the order edit panel's Tax label never invents a rate. It names one only when a STORED invoice line rate is
 * corroborated by the tenant's configured rate (pricing's storedTaxRatePercent) AND reproduces the order's tax to the cent
 * (explainedTaxRatePercent); otherwise plain "Tax". Placeholders only.
 */
const inv = (rates: Array<number | string>, status = "SENT") => ({
  status,
  items: rates.map((taxRate) => ({ taxRate })),
});

describe("orderTaxLabel", () => {
  it("names the exact stored percent (8.25), never a rounded one (8)", () => {
    expect(orderTaxLabel({ subtotal: 100, tax: 8.25 }, [inv([0.0825, 0.0825])], 8.25)).toBe(
      "Tax (8.25%)",
    );
  });

  it("an order with no invoice (so no stored rate) is plain Tax, even when the tax divides out to 8%", () => {
    expect(orderTaxLabel({ subtotal: 100, tax: 8.25 }, [], 8.25)).toBe("Tax");
    expect(orderTaxLabel({ subtotal: 100, tax: 8 }, undefined, 8)).toBe("Tax");
  });

  it("a derived stored rate the tenant never configured is plain Tax (0.0827 on a configured 8.25%)", () => {
    expect(orderTaxLabel({ subtotal: 100, tax: 8.27 }, [inv([0.0827])], 8.25)).toBe("Tax");
  });

  it("no configured rate on file corroborates nothing", () => {
    expect(orderTaxLabel({ subtotal: 100, tax: 8.25 }, [inv([0.0825])], null)).toBe("Tax");
    expect(orderTaxLabel({ subtotal: 100, tax: 8.25 }, [inv([0.0825])], undefined)).toBe("Tax");
  });

  it("mixed stored rates are plain Tax", () => {
    expect(orderTaxLabel({ subtotal: 100, tax: 7 }, [inv([0.0825, 0.05])], 8.25)).toBe("Tax");
    expect(orderTaxLabel({ subtotal: 100, tax: 8.25 }, [inv([0.0825]), inv([0.05])], 8.25)).toBe(
      "Tax",
    );
  });

  it("a stored rate that does not reproduce the order's tax is plain Tax (a re-price or credit is not tax)", () => {
    expect(orderTaxLabel({ subtotal: 100, tax: 6 }, [inv([0.0825])], 8.25)).toBe("Tax");
  });

  it("a VOID or written-off invoice's rate is not read", () => {
    expect(orderTaxLabel({ subtotal: 100, tax: 8.25 }, [inv([0.0825], "VOID")], 8.25)).toBe("Tax");
    expect(orderTaxLabel({ subtotal: 100, tax: 8.25 }, [inv([0.0825], "WRITTEN_OFF")], 8.25)).toBe(
      "Tax",
    );
  });

  it("no tax at all is plain Tax", () => {
    expect(orderTaxLabel({ subtotal: 100, tax: 0 }, [inv([0])], 8.25)).toBe("Tax");
  });
});
