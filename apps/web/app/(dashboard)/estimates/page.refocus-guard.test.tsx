import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import EstimatesPage from "./page";

/**
 * B744 (estimates family) — adding a line schedules a 50 ms refocus of the product search so the
 * barcode scanner is re-armed. It must never take focus from a text-entry field the operator
 * moved to in that window (here, the estimate's Notes textarea).
 *
 * Harness: REAL timers; the pick and the note focus are synchronous, so the note is focused
 * before the 50 ms timer fires, and the test then waits past it. Keystrokes use `user.keyboard`
 * (types into whatever holds focus), never `user.type`, which would click the note first and
 * mask the steal. The pins model a real Chrome mouse pick — the clicked result row holds focus
 * and then unmounts — rather than jsdom's fireEvent.click, which moves no focus at all.
 */

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/estimates",
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock("@/lib/api/estimates", () => ({
  ...jest.requireActual("@/lib/api/estimates"),
  useEstimates: () => ({
    data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 1 } },
    isLoading: false,
    isError: false,
  }),
  useCreateEstimate: () => ({ mutate: jest.fn(), isPending: false }),
}));

const CUSTOMER = {
  id: "cust-1",
  businessName: "Acme Foods",
  contactName: "Jane",
  pricingTier: 1,
};

const PRODUCT = {
  id: "prod-1",
  name: "Widget",
  sku: "WID-1",
  unit: "each",
  pricePerUnit: 10,
  isActive: true,
};

jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomers: () => ({ data: { data: [CUSTOMER] }, isLoading: false, isError: false }),
  useCustomerPrices: () => ({ data: [], isLoading: false, isError: false }),
}));

jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [PRODUCT] }, isLoading: false, isError: false }),
}));

jest.mock("@/lib/api/tier-labels", () => ({
  ...jest.requireActual("@/lib/api/tier-labels"),
  useTierLabels: () => ({ data: {}, isLoading: false, isError: false }),
}));

const pastReArm = () => act(() => new Promise<void>((r) => setTimeout(r, 90)));

async function openDialog() {
  renderWithProviders(<EstimatesPage />);
  fireEvent.click(screen.getByRole("button", { name: "New Estimate" }));
  const dialog = await screen.findByRole("dialog");
  // The product search only renders once a customer is chosen.
  fireEvent.change(within(dialog).getByPlaceholderText(/search customers/i), {
    target: { value: "Acme" },
  });
  fireEvent.click(await within(dialog).findByText("Acme Foods"));
  const search = (await within(dialog).findByPlaceholderText(
    /search by name, sku/i,
  )) as HTMLInputElement;
  return { dialog, search };
}

/** A real mouse pick: the result row takes focus, then the click adds the line and unmounts it. */
async function mousePick(dialog: HTMLElement, search: HTMLInputElement) {
  fireEvent.change(search, { target: { value: "Widget" } });
  const row = (await within(dialog).findByText("Widget")).closest("button") as HTMLElement;
  act(() => row.focus());
  fireEvent.click(row);
}

describe("B744 — estimates: the scanner re-arm never steals focus from Notes (REG-B744)", () => {
  it("REG-B744-2: Notes focused inside the re-arm window keeps focus, and the full text lands in it", async () => {
    const user = userEvent.setup({ delay: null });
    const { dialog, search } = await openDialog();
    await mousePick(dialog, search);
    const notes = within(dialog).getByPlaceholderText("Additional notes…") as HTMLTextAreaElement;
    act(() => notes.focus());

    await pastReArm();

    expect(document.activeElement).toBe(notes);
    await user.keyboard("Deliver Tuesday");
    expect(notes.value).toBe("Deliver Tuesday");
    expect(search.value).toBe("");
  });
});

describe("B744 pins — estimates: scanning never dies", () => {
  it("P1: a mouse pick re-arms the product search", async () => {
    const { dialog, search } = await openDialog();
    await mousePick(dialog, search);
    await waitFor(() => expect(search).toHaveFocus());
  });

  it("P2: a focused BUTTON (the dialog's close X) does not block the re-arm", async () => {
    const { dialog, search } = await openDialog();
    await mousePick(dialog, search);
    const close = within(dialog).getByRole("button", { name: /close/i });
    act(() => close.focus());

    await pastReArm();

    expect(search).toHaveFocus();
  });
});
