import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { OrderLineUnitPicker } from "./OrderLineUnitPicker";
import { applyLineUnit, type UnitLine } from "@/lib/order-line-unit";

// S19b slice B add-on (SA-811a R1, SA-813 M3): the unit picker on invoices/new (LineUnitControl) and the order modal offers
// and applies the customer's LAYER price for the picked unit; flag off it is master's ladder price, with no request.
let mockLayerEnabled = false;
let mockLayerState: "ready" | "pending" | "failed" = "ready";
const mockRefetch = jest.fn();
const caseRow = {
  ref: "u-case",
  label: "Case",
  price: 377.14,
  listPrice: 480,
  source: "customer-shape",
  aboveList: false,
};
const packRow = {
  ref: "pack",
  label: null,
  price: 33,
  listPrice: 42,
  source: "customer",
  aboveList: false,
};
jest.mock("@/lib/api/useCustomerPriceLayer", () => {
  const { priceLayerStatus } = jest.requireActual("@routeflow/pricing");
  return {
    useCustomerPriceLayer: (customerId?: string | null) => {
      const enabled = mockLayerEnabled && !!customerId;
      const data = { complete: true, products: { "prod-1": [packRow, caseRow] } };
      const status = priceLayerStatus({
        enabled,
        isPending: mockLayerState === "pending",
        isError: mockLayerState === "failed",
        data: mockLayerState === "ready" ? data : null,
      });
      return {
        ...status,
        layerOf: (id?: string | null) =>
          enabled && mockLayerState === "ready" && id ? data.products[id as "prod-1"] : undefined,
        error: null,
        refetch: mockRefetch,
      };
    },
  };
});
jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => true,
  useProductUnits: () => ({
    data: [
      {
        label: "Case",
        factorToBase: 12,
        isDefaultSelling: false,
        price: "456",
        priceTier2: null,
        priceTier3: null,
        priceTier4: null,
        priceTier5: null,
      },
    ],
  }),
}));

const tierPrices = { pricePerUnit: "42", priceTier2: "40", priceTier3: "38" };
const line = {
  productId: "prod-1",
  productName: "Widget",
  unit: "Bottle",
  listPrice: 42,
  unitPrice: 38,
  priceType: "SPECIAL" as const,
  tierPrices,
};
const choose = (onChange: jest.Mock, label: string) => {
  fireEvent.change(screen.getByLabelText("Sell Widget by"), { target: { value: label } });
  return onChange.mock.calls[onChange.mock.calls.length - 1][0];
};

describe("OrderLineUnitPicker - the customer's layer (picker add-on)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLayerEnabled = false;
    mockLayerState = "ready";
  });

  it("flag off: master's ladder price for Case, no layer line, no notice", () => {
    const onChange = jest.fn();
    render(<OrderLineUnitPicker line={line} tier={3} customerId="c1" onChange={onChange} />);
    const opt = choose(onChange, "Case");
    expect(opt.price).toBe(412.57); // the tier ladder (not the layer)
    expect(opt.layerLine).toBeUndefined();
    expect(screen.queryByText(/Checking this customer/)).not.toBeInTheDocument();
  });

  it("invoices/new picker: flag on, picking Case gives the layer's $377.14 (list $480), SPECIAL", () => {
    mockLayerEnabled = true;
    const onChange = jest.fn();
    render(<OrderLineUnitPicker line={line} tier={3} customerId="c1" onChange={onChange} />);
    const opt = choose(onChange, "Case");
    expect(opt.price).toBe(377.14);
    expect(opt.listPrice).toBe(480);
    const applied: UnitLine = applyLineUnit({ ...line, qty: 1 } as UnitLine, opt, { tier: 3 });
    expect(applied.unitPrice).toBe(377.14);
    expect(applied.listPrice).toBe(480);
    expect(applied.priceType).toBe("SPECIAL");
    expect(applied.specialPrice).toBe(377.14);
  });

  it("order modal picker: a layer passed in directly prices the Case the same way", () => {
    const onChange = jest.fn();
    render(
      <OrderLineUnitPicker
        line={line}
        tier={3}
        layer={[packRow, caseRow] as never}
        onChange={onChange}
      />,
    );
    expect(choose(onChange, "Case").price).toBe(377.14);
  });

  it("back to the pack takes the layer's $33", () => {
    mockLayerEnabled = true;
    const onChange = jest.fn();
    render(
      <OrderLineUnitPicker
        line={{ ...line, unitLabel: "Case", packBase: { ...line, qty: 1 } as never }}
        tier={3}
        customerId="c1"
        onChange={onChange}
      />,
    );
    const opt = choose(onChange, "");
    const back = applyLineUnit(
      { ...line, qty: 1, unitLabel: "Case", packBase: { ...line, qty: 1 } as never },
      opt,
      { tier: 3 },
    );
    expect(back.unitPrice).toBe(33);
  });

  it("pending layer: the unconfirmed notice; failed: the failure copy and Retry refetches", () => {
    mockLayerEnabled = true;
    mockLayerState = "pending";
    const { rerender } = render(
      <OrderLineUnitPicker line={line} tier={3} customerId="c1" onChange={jest.fn()} />,
    );
    expect(screen.getByText("Checking this customer's prices…")).toBeInTheDocument();
    mockLayerState = "failed";
    rerender(<OrderLineUnitPicker line={line} tier={3} customerId="c1" onChange={jest.fn()} />);
    expect(screen.getByText(/Couldn't load this customer's prices\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });
  it("nit 4: a system MANUAL unit line (no one-time price) re-prices when its ladder price moves; an operator MANUAL stands", () => {
    const base = {
      ...line,
      unitLabel: "Case",
      packBase: { ...line, qty: 1 } as never,
      unitPrice: 999,
      priceType: "MANUAL" as const,
    };
    const system = jest.fn();
    render(<OrderLineUnitPicker line={base} tier={3} onChange={system} />);
    expect(system).toHaveBeenCalledTimes(1);
    expect(system.mock.calls[0][0].price).toBe(412.57);
    expect(system.mock.calls[0][1]).toBe(true);
    const operator = jest.fn();
    render(
      <OrderLineUnitPicker line={{ ...base, discountedPrice: 999 }} tier={3} onChange={operator} />,
    );
    expect(operator).not.toHaveBeenCalled();
  });
});
