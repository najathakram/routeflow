// B1382: the BUYER qty box (QtyTextInput with rejectNonDigits) rejects "-5", "12.5" and "1e9" whole, fits the
// limit in maxLength, and clamps; a non-buyer QtyTextInput (no rejectNonDigits) behaves exactly as before.
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

// The design tokens are only read at style-creation time; any value will do for these assertions.
jest.mock("@routeflow/ui/tokens", () => {
  const deep: any = new Proxy(function () {}, { get: () => deep, apply: () => deep });
  return { ios: deep };
});

import { BUYER_LINE_QTY_MAX, maxLineCount } from "@routeflow/pricing";
import { QtyTextInput } from "../components/QtyStepper";
import { maxLineUnits } from "../store/cartStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(props: Record<string, unknown>) {
  const onChangeQty = jest.fn();
  let r: any;
  act(() => {
    r = TestRenderer.create(
      React.createElement(QtyTextInput, { value: 3, onChangeQty, ...props } as never),
    );
  });
  const input = () => r.root.findByType("TextInput");
  const type = (t: string) => act(() => input().props.onChangeText(t));
  return { onChangeQty, input, type };
}

describe("buyer qty box (rejectNonDigits)", () => {
  it.each(["-5", "12.5", "1e9", "5a", " 5"])(
    "%j leaves the value at 3 and commits nothing",
    (t) => {
      const { onChangeQty, input, type } = mount({
        min: 1,
        max: BUYER_LINE_QTY_MAX,
        rejectNonDigits: true,
      });
      type(t);
      expect(input().props.value).toBe("3");
      expect(onChangeQty).not.toHaveBeenCalled();
    },
  );

  it("whole digits commit, clamped to max", () => {
    const { onChangeQty, type } = mount({ min: 1, max: 8333, rejectNonDigits: true });
    type("8334");
    expect(onChangeQty).toHaveBeenLastCalledWith(8333);
    type("40");
    expect(onChangeQty).toHaveBeenLastCalledWith(40);
  });

  it("maxLength fits the limit: 6 for 100,000", () => {
    const { input } = mount({ min: 1, max: BUYER_LINE_QTY_MAX, rejectNonDigits: true });
    expect(input().props.maxLength).toBe(6);
  });

  it("the store bound is 8,333 boxes at 12 per box and 100,000 otherwise", () => {
    expect(maxLineUnits(12)).toBe(8333);
    expect(maxLineUnits(12)).toBe(maxLineCount(BUYER_LINE_QTY_MAX, 12));
    expect(maxLineUnits(null)).toBe(100_000);
  });
});

describe("a non-buyer QtyTextInput is unchanged", () => {
  it('"-5" is sanitized to 5 and committed, as on master', () => {
    const { onChangeQty, input, type } = mount({});
    type("-5");
    expect(input().props.value).toBe("5");
    expect(onChangeQty).toHaveBeenCalledWith(5);
  });

  it("maxLength stays 5 even when a max is passed", () => {
    const { input } = mount({ max: BUYER_LINE_QTY_MAX });
    expect(input().props.maxLength).toBe(5);
  });
});
