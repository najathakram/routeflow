// REG-B1395 (#4509 F6, SA-1292 part 3): the BUYER qty box never reverts in silence. A "-5" (or "12.5", "1e9") is
// rejected AND said ("Enter 1 or more.", the web words); a 0 or an empty box left on blur REMOVES the line, with
// Undo, instead of snapping back. A non-buyer box is unchanged. The screens map the two callbacks to the line.
import * as React from "react";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TestRenderer: any = require("react-test-renderer");
const { act } = TestRenderer;

jest.mock("react-native", () => ({
  Pressable: "Pressable",
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
  StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
}));

jest.mock("@routeflow/ui/tokens", () => {
  const deep: any = new Proxy(function () {}, { get: () => deep, apply: () => deep });
  return { ios: deep };
});

import { readFileSync } from "fs";
import { join } from "path";
import { QtyTextInput } from "../components/QtyStepper";
import { ENTER_ONE_OR_MORE } from "../lib/qty";
import { useCartStore } from "../store/cartStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(props: Record<string, unknown>) {
  const onChangeQty = jest.fn();
  const onReject = jest.fn();
  const onZero = jest.fn();
  let r: any;
  act(() => {
    r = TestRenderer.create(
      React.createElement(QtyTextInput, {
        value: 3,
        onChangeQty,
        onReject,
        onZero,
        min: 1,
        max: 8333,
        rejectNonDigits: true,
        emptyMeansZero: false,
        ...props,
      } as never),
    );
  });
  const input = () => r.root.findByType("TextInput");
  const type = (t: string) => act(() => input().props.onChangeText(t));
  const blur = () => act(() => input().props.onBlur());
  return { onChangeQty, onReject, onZero, input, type, blur };
}

describe("REG-B1395 F6: the buyer qty box says why it refused", () => {
  it("the one sentence is the web's", () => {
    expect(ENTER_ONE_OR_MORE).toBe("Enter 1 or more.");
  });

  it.each(["-5", "12.5", "1e9"])(
    "%j is rejected whole, the value stays 3, and it is reported",
    (t) => {
      const { onChangeQty, onReject, input, type } = mount({});
      type(t);
      expect(input().props.value).toBe("3");
      expect(onChangeQty).not.toHaveBeenCalled();
      expect(onReject).toHaveBeenCalledTimes(1);
    },
  );

  it("a 0 left on blur removes the line (onZero), it does not revert", () => {
    const { onChangeQty, onZero, type, blur } = mount({});
    type("0");
    expect(onZero).not.toHaveBeenCalled(); // typing never removes mid-keystroke
    blur();
    expect(onZero).toHaveBeenCalledTimes(1);
    expect(onChangeQty).not.toHaveBeenCalled();
  });

  it("an empty box left on blur removes the line (onZero)", () => {
    const { onZero, type, blur } = mount({});
    type("");
    blur();
    expect(onZero).toHaveBeenCalledTimes(1);
  });

  it("a good number commits and neither callback fires", () => {
    const { onChangeQty, onReject, onZero, type, blur } = mount({});
    type("40");
    blur();
    expect(onChangeQty).toHaveBeenLastCalledWith(40);
    expect(onReject).not.toHaveBeenCalled();
    expect(onZero).not.toHaveBeenCalled();
  });

  it("a box with no onZero keeps today's blur: a 0 reverts", () => {
    const { onChangeQty, input, type, blur } = mount({ onZero: undefined });
    type("0");
    blur();
    expect(onChangeQty).not.toHaveBeenCalled();
    expect(input().props.value).toBe("3");
  });

  it("a non-buyer box (no rejectNonDigits) never reports a rejection", () => {
    const { onReject, onChangeQty, type } = mount({
      rejectNonDigits: false,
      min: 0,
      max: undefined,
    });
    type("-5");
    expect(onChangeQty).toHaveBeenCalledWith(5);
    expect(onReject).not.toHaveBeenCalled();
  });
});

describe("REG-B1395 F6: the cart removes with Undo and puts the line back as it was", () => {
  const BOXED = {
    productId: "p-1",
    name: "Sample Cola",
    unitPrice: 18,
    unit: "case",
    unitsPerBox: 12,
  };
  beforeEach(() => useCartStore.setState({ items: [] }));

  it("restore puts a removed boxed line back exactly (3 boxes, 36 pieces)", () => {
    useCartStore.getState().add(BOXED);
    useCartStore.getState().setUnits("p-1", 3);
    const line = useCartStore.getState().items[0];
    useCartStore.getState().remove("p-1");
    expect(useCartStore.getState().items).toEqual([]);
    useCartStore.getState().restore(line);
    expect(useCartStore.getState().items).toEqual([line]);
    expect(line).toMatchObject({ qty: 36, boxes: 3, pieces: 0 });
  });

  it("restore after the product was added again joins the counts, clamped to 8,333 boxes", () => {
    useCartStore.getState().add(BOXED);
    useCartStore.getState().setUnits("p-1", 8333);
    const line = useCartStore.getState().items[0];
    useCartStore.getState().remove("p-1");
    useCartStore.getState().add(BOXED);
    useCartStore.getState().restore(line);
    expect(useCartStore.getState().items).toHaveLength(1);
    expect(useCartStore.getState().items[0]).toMatchObject({ boxes: 8333, qty: 99_996 });
  });
});

describe("REG-B1395 F6 / INFO-3: the screens pass the reasons through", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
  it.each([
    ["cart", "app/(customer)/orders/cart.tsx"],
    ["edit-items", "app/(customer)/orders/[id]/edit-items.tsx"],
  ])("the %s screen says why and removes with Undo", (_n, rel) => {
    const box = (read(rel).match(/<QtyTextInput[\s\S]*?\/>/g) ?? [])[0] ?? "";
    expect(box).toMatch(/onReject=/);
    expect(box).toMatch(/onZero=/);
    expect(box).toMatch(/emptyMeansZero=\{false\}/);
    expect(read(rel)).toMatch(/<UndoStrip/);
    expect(read(rel)).toMatch(/ENTER_ONE_OR_MORE/);
  });
});
