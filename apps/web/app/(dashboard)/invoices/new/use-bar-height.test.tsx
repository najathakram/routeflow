import * as React from "react";
import { act, render } from "@testing-library/react";
import { useBarHeight } from "./use-bar-height";

/**
 * Row 492 clearance: the page sizes its bottom padding from the MEASURED action bar, so a wrapped
 * (taller) bar never covers the last form control. jsdom has no layout, so ResizeObserver is faked.
 */
describe("useBarHeight", () => {
  let fire: (() => void) | undefined;
  const original = (global as any).ResizeObserver;
  beforeEach(() => {
    (global as any).ResizeObserver = class {
      constructor(cb: () => void) {
        fire = cb;
      }
      observe() {}
      disconnect() {}
    };
  });
  afterEach(() => {
    (global as any).ResizeObserver = original;
  });

  function Probe({ height }: { height: number }) {
    const [h, ref] = useBarHeight();
    return (
      <div data-testid="root" data-h={h}>
        <div
          ref={(el) => {
            if (el)
              Object.defineProperty(el, "offsetHeight", { value: height, configurable: true });
            ref(el);
          }}
        />
      </div>
    );
  }

  it("reports the bar's height on mount and again when it resizes", () => {
    const { getByTestId, rerender } = render(<Probe height={64} />);
    expect(getByTestId("root").getAttribute("data-h")).toBe("64");
    rerender(<Probe height={150} />);
    act(() => fire?.());
    expect(getByTestId("root").getAttribute("data-h")).toBe("150");
  });
});
