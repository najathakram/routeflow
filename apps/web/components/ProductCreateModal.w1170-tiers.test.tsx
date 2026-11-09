import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getStoredUser } from "@/lib/auth";
import { renderWithProviders } from "@/test-utils/render";
import { ProductCreateModal } from "./ProductCreateModal";

/**
 * W-1170 F12a: under prices v2 the New product form offers optional Tier 2-5 prices behind a closed disclosure.
 * Only typed values are sent, as numbers; the server rounds and a blank tier stays Auto. Variants never show it.
 */
const mutateAsync = jest.fn();
const flags = { v2: true };
let products: { data: unknown[] } = { data: [] };

jest.mock("@/lib/auth", () => ({
  ...jest.requireActual("@/lib/auth"),
  getStoredUser: jest.fn(),
}));
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => flags.v2 }));
jest.mock("@/lib/api/product-units", () => ({ useUnitsEnabled: () => false }));
jest.mock("@/lib/api/products", () => ({
  useCreateProduct: () => ({ mutateAsync, isPending: false }),
  useProducts: () => ({ data: products }),
  uploadProductImages: jest.fn(),
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
  useRegulatedTemplates: () => ({ data: [] }),
}));
jest.mock("./CategoryCombobox", () => ({ CategoryCombobox: () => <div /> }));
jest.mock("./SubcategoryCombobox", () => ({ SubcategoryCombobox: () => <div /> }));
jest.mock("./BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));

const open = () =>
  renderWithProviders(<ProductCreateModal isOpen onClose={jest.fn()} onCreated={jest.fn()} />);
const create = () => fireEvent.click(screen.getByRole("button", { name: "Create product" }));
const toggle = () => screen.queryByRole("button", { name: /Different prices for tiers/ });

beforeEach(() => {
  localStorage.clear();
  (getStoredUser as jest.Mock).mockReturnValue(null);
  flags.v2 = true;
  products = { data: [] };
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue({ id: "p1", name: "UX-Soda", unit: "each", pricePerUnit: "10" });
});

async function fill() {
  await userEvent.type(screen.getByLabelText("Name *"), "UX-Soda");
  await userEvent.type(screen.getByLabelText(/^Unit \*/), "each");
  await userEvent.type(screen.getByLabelText(/^Price per each/), "10");
}

describe("W-1170 F12a: tier prices at create", () => {
  it("starts closed: no tier inputs until the disclosure opens", async () => {
    open();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Tier 2")).toBeNull();
  });

  it("sends a typed Tier 2 as a number and leaves untouched tiers out", async () => {
    open();
    await fill();
    await userEvent.click(toggle()!);
    const t2 = screen.getByLabelText("Tier 2");
    expect(t2).toHaveAttribute("placeholder", "Auto");
    await userEvent.type(t2, "33.00");
    create();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const body = mutateAsync.mock.calls[0][0];
    expect(body.priceTier2).toBe(33);
    expect(body).not.toHaveProperty("priceTier3");
    expect(body).not.toHaveProperty("priceTier4");
    expect(body).not.toHaveProperty("priceTier5");
  });

  it("sends no tier keys when the disclosure is never used", async () => {
    open();
    await fill();
    create();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(
      Object.keys(mutateAsync.mock.calls[0][0]).filter((k) => k.startsWith("priceTier")),
    ).toEqual([]);
  });

  it("is absent when prices v2 is off", () => {
    flags.v2 = false;
    open();
    expect(toggle()).toBeNull();
  });

  it("is absent for a variant of a family", async () => {
    products = {
      data: [{ id: "par1", name: "UX-Acme", unit: "each", pricePerUnit: "5", unitsPerBox: 1 }],
    };
    renderWithProviders(
      <ProductCreateModal
        isOpen
        onClose={jest.fn()}
        onCreated={jest.fn()}
        defaultParentId="par1"
      />,
    );
    await waitFor(() => expect(screen.getByLabelText(/^Unit \*/)).toHaveValue("each"));
    expect(toggle()).toBeNull();
  });

  it("lays the tier block out below the price row, full width (not inside the half-width price cell)", async () => {
    open();
    await userEvent.click(toggle()!);
    const block = screen.getByLabelText("Tier 2").closest("[data-tier-block]") as HTMLElement;
    expect(block).toBeInTheDocument();
    expect(block.className).toMatch(/col-span-2/);
    const row = document.querySelector("[data-price-row]") as HTMLElement;
    expect(row).not.toContainElement(block);
    expect(screen.getByText("Blank tiers follow Retail.")).toBeInTheDocument();
  });

  it("shows how many tiers are set on the closed toggle", async () => {
    open();
    await userEvent.click(toggle()!);
    await userEvent.type(screen.getByLabelText("Tier 2"), "33");
    await userEvent.type(screen.getByLabelText("Tier 4"), "30");
    await userEvent.click(toggle()!);
    expect(
      screen.getByRole("button", { name: /Different prices for tiers · 2 set/ }),
    ).toBeInTheDocument();
  });

  it.each([["12,50"], ["0"], ["-3"], ["abc"]])(
    "a tier of %p blocks Create, reopens the closed block and flags the input",
    async (bad) => {
      open();
      await fill();
      await userEvent.click(toggle()!);
      await userEvent.type(screen.getByLabelText("Tier 3"), bad);
      await userEvent.click(toggle()!);
      expect(screen.queryByLabelText("Tier 3")).toBeNull();
      create();
      const alert = await screen.findByRole("alert");
      expect(mutateAsync).not.toHaveBeenCalled();
      const input = screen.getByLabelText("Tier 3");
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input.getAttribute("aria-describedby")).toBe(alert.id);
      if (bad === "0") expect(alert).toHaveTextContent("Leave blank to follow Retail.");
    },
  );

  it("keeps aria-controls only while the block is open", async () => {
    open();
    expect(toggle()).not.toHaveAttribute("aria-controls");
    await userEvent.click(toggle()!);
    expect(toggle()).toHaveAttribute("aria-controls", "product-tier-prices");
  });

  it("Escape does not close the dialog once only a tier value was typed (not pristine)", async () => {
    const onClose = jest.fn();
    renderWithProviders(<ProductCreateModal isOpen onClose={onClose} onCreated={jest.fn()} />);
    await userEvent.click(toggle()!);
    fireEvent.keyDown(screen.getByLabelText("Tier 2"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    onClose.mockClear();
    await userEvent.type(screen.getByLabelText("Tier 2"), "33");
    fireEvent.keyDown(screen.getByLabelText("Tier 2"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
