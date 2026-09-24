import * as React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QuickEditCell } from "./QuickEditCell";
import { BarcodeScannerButton } from "@/components/BarcodeScannerButton";

/**
 * B672 audit (products/page.tsx pairs the SKU field's forwarded ref with a companion
 * BarcodeScannerButton). `onKeyDown`'s Enter branch called `commit()` unconditionally, so once
 * B672 lets the detector actually fire, a real wedge scan would ALSO commit() the same Enter —
 * a real scan double-saves. Fixed with one `e.defaultPrevented` guard at the top of the handler.
 */

function Wrapper() {
  const ref = React.useRef<HTMLInputElement>(null);
  // BarcodeScannerButton's effect only checks `inputRef.current` at mount/dep-change time; in
  // the real page it mounts alongside the WHOLE row as soon as quickEditMode turns on, well
  // before any particular cell enters `editing` (a separate, real ref-availability gap — not
  // this test's concern). Mounting the button only once the input actually exists isolates the
  // ONE thing under test here: does a real scan, once the detector IS attached, double-fire?
  const [ready, setReady] = React.useState(false);
  return (
    <div className="flex">
      <QuickEditCell
        ref={ref}
        productId="p-1"
        productName="Sample Cola"
        field="sku"
        value={null}
        quickEditMode
        onSave={(val, record) => onSaveSpy(val, record)}
      />
      {ready && (
        <BarcodeScannerButton inputRef={ref} onScan={(code) => onScanSpy(code)} title="scan" />
      )}
      <button type="button" title="attach-scanner" onClick={() => setReady(true)} hidden />
    </div>
  );
}

let onScanSpy: jest.Mock;
let onSaveSpy: jest.Mock;
let dateNowSpy: jest.SpyInstance<number, []>;
beforeEach(() => {
  onScanSpy = jest.fn();
  onSaveSpy = jest.fn().mockResolvedValue(undefined);
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

it("a real wedge scan reaches onScan without the cell's own Enter handler also committing", async () => {
  render(<Wrapper />);
  fireEvent.click(screen.getByTitle("Add sku"));
  const input = await screen.findByPlaceholderText("Type and press Enter");
  fireEvent.click(screen.getByTitle("attach-scanner"));

  await act(async () => {
    wedgeScan(input, "100200300");
  });

  await waitFor(() => expect(onScanSpy).toHaveBeenCalledTimes(1));
  expect(onScanSpy).toHaveBeenCalledWith("100200300");
  // The cell's own commit() must NOT also fire on the same Enter (a real scan double-saves).
  expect(onSaveSpy).not.toHaveBeenCalled();
});
