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
beforeEach(() => {
  onScanSpy = jest.fn();
  onChangeSpy = jest.fn();
});

/**
 * The scan detector times keys by the browser's own `event.timeStamp` (see BarcodeScannerButton), not by
 * Date.now(). A synthetic fireEvent gets the REAL clock as its timeStamp, so on a loaded host the render
 * between two keys could stretch a "fast" burst past the detector's 200 ms inter-key / 150 ms Enter gates and
 * the scan was (correctly) not recognised. The scenario under test is a scanner's 10 ms-per-key cadence, so
 * the test pins each event's timeStamp to that cadence instead of racing the scheduler.
 */
const SCAN_KEY_INTERVAL_MS = 10;
function keyDownAt(input: HTMLElement, key: string, timeStamp: number) {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  Object.defineProperty(ev, "timeStamp", { value: timeStamp });
  fireEvent(input, ev);
}

function wedgeScan(input: HTMLElement, code: string) {
  let t = 1_000;
  for (const ch of code) {
    keyDownAt(input, ch, (t += SCAN_KEY_INTERVAL_MS));
  }
  fireEvent.change(input, { target: { value: code } });
  keyDownAt(input, "Enter", (t += SCAN_KEY_INTERVAL_MS));
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
