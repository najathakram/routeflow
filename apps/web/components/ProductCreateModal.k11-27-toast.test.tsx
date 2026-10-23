import * as React from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { ProductCreateModal } from "./ProductCreateModal";

/**
 * K11-27: the "created" toast stays on screen for 5 s with the REAL ToastProvider (fake timers).
 *
 * Why a browser probe saw it "disappear after about 1 s": Radix gives `role="status"` only to a transient screen-reader
 * announcer that it removes after 1000 ms. The visible toast (an <li> in the Notifications region) has no role, so a
 * `getByRole("status")` locator stops matching at ~1 s while the toast is still up. Locate the visible toast as a
 * listitem of the Notifications region instead.
 */
const mutateAsync = jest.fn();

jest.mock("@/lib/api/products", () => ({
  useCreateProduct: () => ({ mutateAsync, isPending: false }),
  useProducts: () => ({ data: { data: [] } }),
  uploadProductImages: jest.fn(),
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
  useRegulatedTemplates: () => ({ data: [] }),
}));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock("./CategoryCombobox", () => ({ CategoryCombobox: () => <div /> }));
jest.mock("./SubcategoryCombobox", () => ({ SubcategoryCombobox: () => <div /> }));
jest.mock("./BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));

const visibleToasts = () =>
  screen
    .queryAllByRole("listitem")
    .filter(
      (li) => li.textContent?.includes("Cola created") && li.getAttribute("data-state") === "open",
    );
const announcers = () =>
  screen.queryAllByRole("status").filter((n) => n.textContent?.includes("Cola created"));

beforeEach(() => {
  jest.useFakeTimers();
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue({ id: "p1", name: "Cola", unit: "box", pricePerUnit: "12.00" });
});
afterEach(() => jest.useRealTimers());

it("the toast is still visible at 3 s and at 4.5 s, and gone after 5 s", async () => {
  function Host() {
    const [open, setOpen] = React.useState(true); // closes like the page does, so the toast is not aria-hidden behind it
    return (
      <ProductCreateModal isOpen={open} onClose={() => setOpen(false)} onCreated={jest.fn()} />
    );
  }
  renderWithProviders(<Host />);
  fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "Cola" } });
  fireEvent.change(screen.getByLabelText(/^Unit \*/), { target: { value: "box" } });
  fireEvent.change(screen.getByLabelText(/^Price per/), { target: { value: "12" } });
  fireEvent.click(screen.getByRole("button", { name: "Create product" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(visibleToasts()).toHaveLength(1);

  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  expect(visibleToasts()).toHaveLength(1); // the card: still visible 3 s later
  // the transient announcer is the only role=status node, and it is long gone by now
  expect(announcers()).toHaveLength(0);

  await act(async () => {
    jest.advanceTimersByTime(1500);
  });
  expect(visibleToasts()).toHaveLength(1); // 4.5 s: the 4 s default would already be gone

  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(visibleToasts()).toHaveLength(0); // held 5 s, not forever
});
