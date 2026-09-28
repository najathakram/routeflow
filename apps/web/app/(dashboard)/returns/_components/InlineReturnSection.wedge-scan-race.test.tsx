import * as React from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { InlineReturnSection, type InlineReturnSectionState } from "./InlineReturnSection";

/**
 * #2694 lead verdict (#2704): the REAL BarcodeScannerButton's wedge detector handles a USB scan on
 * the "Add another product" field (native keydown → onScan) and preventDefaults its Enter. The
 * section's own React Enter handler must then stand down (`e.defaultPrevented`, the guard every
 * `*.wedge-scan-race.test.tsx` path uses), or ONE physical scan adds the product twice — 2 pieces,
 * an over-credit. The button is NOT mocked here (the scan-2694 suite mocks it, which is exactly how
 * this double-add hid).
 */
jest.mock("@/lib/api/orders", () => ({ useOrder: () => ({ data: undefined }) }));
jest.mock("@/lib/api/products", () => ({ useProducts: () => ({ data: { data: [] } }) }));
jest.mock("@/lib/api/inline-returns", () => ({
  useInlineReturnQuote: () => ({ mutate: jest.fn(), isPending: false }),
}));

const WIDGET = { id: "prod-1", name: "Widget", unit: "each", unitsPerBox: null };
const resolveProductByCode = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => resolveProductByCode(code),
}));

let dateNowSpy: jest.SpyInstance<number, []>;
beforeEach(() => {
  resolveProductByCode.mockReset();
  resolveProductByCode.mockResolvedValue({ product: WIDGET, source: "barcode" });
  // Wedge speed: every keystroke 10 ms apart, as the detector expects of a scanner.
  let t = 1_700_000_000_000;
  dateNowSpy = jest.spyOn(Date, "now").mockImplementation(() => (t += 10));
});
afterEach(() => dateNowSpy.mockRestore());

function wedgeScan(input: HTMLElement, code: string) {
  for (const ch of code) fireEvent.keyDown(input, { key: ch });
  fireEvent.change(input, { target: { value: code } });
  fireEvent.keyDown(input, { key: "Enter" });
}

it("one physical wedge scan adds the product ONCE (1 piece), never twice", async () => {
  const states: InlineReturnSectionState[] = [];
  renderWithProviders(
    <InlineReturnSection customerId="cust-1" onStateChange={(s) => states.push(s)} />,
  );
  const input = screen.getByLabelText(/add another product/i);

  await act(async () => {
    wedgeScan(input, "0123456789012");
  });

  await waitFor(() =>
    expect((states[states.length - 1]?.lines ?? []).map((l) => l.pieces)).toEqual(["1"]),
  );
  // Settle any second (racing) add before asserting it never happened.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(resolveProductByCode).toHaveBeenCalledTimes(1);
  expect((states[states.length - 1]?.lines ?? []).map((l) => l.pieces)).toEqual(["1"]);
});
