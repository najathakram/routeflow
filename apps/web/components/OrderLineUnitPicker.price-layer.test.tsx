import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { OrderLineUnitPicker } from "./OrderLineUnitPicker";
import { applyLineUnit, type UnitLine } from "@/lib/order-line-unit";

// S19b slice B add-on (SA-811a R1): the unit picker offers and applies the customer's LAYER price for the picked unit when a surface
// passes `layer`; without it (flag off) it is master's ladder price. The surface owns the unconfirmed-prices notice (M3).
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
const LAYER = [packRow, caseRow] as never;
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
  });

  it("flag off: master's ladder price for Case, no layer line, no notice", () => {
    const onChange = jest.fn();
    render(<OrderLineUnitPicker line={line} tier={3} onChange={onChange} />);
    const opt = choose(onChange, "Case");
    expect(opt.price).toBe(412.57); // the tier ladder (not the layer)
    expect(opt.layerLine).toBeUndefined();
    expect(screen.queryByText(/Checking this customer/)).not.toBeInTheDocument();
  });

  it("invoices/new picker: flag on, picking Case gives the layer's $377.14 (list $480), SPECIAL", () => {
    const onChange = jest.fn();
    render(<OrderLineUnitPicker line={line} tier={3} layer={LAYER} onChange={onChange} />);
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
    const onChange = jest.fn();
    render(
      <OrderLineUnitPicker
        line={{ ...line, unitLabel: "Case", packBase: { ...line, qty: 1 } as never }}
        tier={3}
        layer={LAYER}
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

  it("nit 4: a MANUAL unit line re-prices when its ladder price moves ONLY when it is the layer's own above-list price (layerManual); every other MANUAL stands, as on master", () => {
    const base = {
      ...line,
      unitLabel: "Case",
      packBase: { ...line, qty: 1 } as never,
      unitPrice: 999,
      priceType: "MANUAL" as const,
    };
    const layerOwn = jest.fn();
    render(
      <OrderLineUnitPicker line={{ ...base, layerManual: true }} tier={3} onChange={layerOwn} />,
    );
    expect(layerOwn).toHaveBeenCalledTimes(1);
    expect(layerOwn.mock.calls[0][0].price).toBe(412.57);
    expect(layerOwn.mock.calls[0][1]).toBe(true);
    // master: a stored / typed MANUAL line is never re-priced by the picker (flag off: no layer, no mark)
    const stored = jest.fn();
    render(<OrderLineUnitPicker line={base} tier={3} onChange={stored} />);
    expect(stored).not.toHaveBeenCalled();
    const operator = jest.fn();
    render(
      <OrderLineUnitPicker
        line={{ ...base, discountedPrice: 999, layerManual: false }}
        tier={3}
        onChange={operator}
      />,
    );
    expect(operator).not.toHaveBeenCalled();
  });

  it("flag-off money: a loaded MANUAL Case line at $410 is not re-priced to the ladder's $412.57", () => {
    const onChange = jest.fn();
    render(
      <OrderLineUnitPicker
        line={{
          ...line,
          unitLabel: "Case",
          packBase: { ...line, qty: 1 } as never,
          unitPrice: 410,
          priceType: "MANUAL" as const,
        }}
        tier={3}
        onChange={onChange}
      />,
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});
