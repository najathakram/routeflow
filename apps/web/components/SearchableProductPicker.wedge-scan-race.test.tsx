import * as React from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { SearchableProductPicker } from "./SearchableProductPicker";
import { BarcodeScannerButton } from "./BarcodeScannerButton";

/**
 * B672 audit (inventory/page.tsx pairs this picker's exposed `inputRef` with a companion
 * BarcodeScannerButton). `handleKeyDown`'s Enter branches ran unconditionally, so once B672 lets
 * the detector actually fire, a real wedge scan would ALSO open the dropdown / pick the
 * highlighted row on the same Enter. Fixed with one `e.defaultPrevented` guard covering every
 * branch (the detector only ever preventDefaults an Enter, so this is safe for Arrow/Escape too).
 */

const PRODUCTS = [{ id: "p-1", name: "Sample Cola", sku: "100200300" }];

function Wrapper() {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [value, setValue] = React.useState("");
  return (
    <div className="flex">
      <SearchableProductPicker
        value={value}
        onChange={(id) => {
          onChangeSpy(id);
          setValue(id);
        }}
        products={PRODUCTS}
        inputRef={inputRef}
      />
      <BarcodeScannerButton inputRef={inputRef} onScan={(code) => onScanSpy(code)} title="scan" />
    </div>
  );
}

let onScanSpy: jest.Mock;
let onChangeSpy: jest.Mock;
let dateNowSpy: jest.SpyInstance<number, []>;
beforeEach(() => {
  onScanSpy = jest.fn();
  onChangeSpy = jest.fn();
  let t = 1_700_000_000_000;
  dateNowSpy = jest.spyOn(Date, "now").mockImplementation(() => (t += 10));
});
afterEach(() => {
  dateNowSpy.mockRestore();
});

function wedgeScan(input: HTMLElement, code: string) {
  for (const ch of code) {
    fireEvent.keyDown(input, { key: ch });
  }
  fireEvent.change(input, { target: { value: code } });
  fireEvent.keyDown(input, { key: "Enter" });
}

it("a real wedge scan reaches onScan without the picker's own Enter handler also firing", async () => {
  renderWithProviders(<Wrapper />);
  const input = screen.getByRole("textbox");

  await act(async () => {
    wedgeScan(input, "100200300");
  });

  await waitFor(() => expect(onScanSpy).toHaveBeenCalledTimes(1));
  // The picker's OWN Enter handler must NOT also fire (it would call its onChange a second time,
  // via visibleProducts[highlight] — a DIFFERENT resolution path than the scan's exact-code
  // lookup, which can disagree with the scanner about which product was meant).
  expect(onChangeSpy).not.toHaveBeenCalled();
});
