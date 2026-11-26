import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { computeLineSubtotal } from "@routeflow/pricing";
import { renderWithProviders } from "@/test-utils/render";
import { formatMoney } from "@/lib/format";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * SA-1256 typed sums PR 1, order-builder level (B1-B6, B8). Mocks and helpers are copied from
 * CreateOrderModal.submit-chord.test.tsx; the POST is the `useCreateOrder().mutate` call.
 */

window.HTMLElement.prototype.scrollIntoView = jest.fn();

const PLAIN = {
  id: "p-plain",
  name: "Sample Cola",
  sku: "100200300",
  unit: "each",
  pricePerUnit: "2.50",
  isActive: true,
};
const BOXED = {
  id: "p-boxed",
  name: "Sample Chips",
  sku: "400500600",
  unit: "case",
  pricePerUnit: "30.00",
  unitsPerBox: 24,
  isActive: true,
};
let mockProducts: unknown[] = [PLAIN, BOXED];

const CUSTOMERS = [
  {
    id: "c1",
    businessName: "Acme Market",
    contactName: "Ann",
    pricingTier: 3,
    fulfillPath: "SHIP",
  },
];
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: CUSTOMERS } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: mockProducts } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
const mockCreateMutate = jest.fn();
const mockCreateDraft = jest.fn().mockResolvedValue({ id: "d1" });
jest.mock("@/lib/api/credit-notes", () => ({
  ...jest.requireActual("@/lib/api/credit-notes"),
  useCreditNotes: () => ({ data: { data: [] } }),
}));
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({
    mutate: mockCreateMutate,
    isPending: false,
    error: null,
    reset: jest.fn(),
  }),
  useActiveOrderForCustomer: () => ({ data: undefined }),
  useCustomerPriceHistory: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/drafts", () => ({
  useCreateDraft: () => ({ mutate: jest.fn(), mutateAsync: mockCreateDraft, isPending: false }),
  useUpdateDraft: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useDeleteDraft: () => ({ mutate: jest.fn() }),
  useDraft: () => ({ data: undefined, isFetching: false }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useOrderUiV2: () => ({ enabled: true, resolved: true }),
  useScanV2: () => false,
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: () => <button type="button">scan</button>,
}));
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: jest
    .fn()
    .mockResolvedValue({ notFound: true, archived: false, product: null }),
}));

type User = ReturnType<typeof userEvent.setup>;
const cust = () => screen.getByPlaceholderText(/search by business name/i) as HTMLInputElement;
const prod = () =>
  screen.getByPlaceholderText(/search by name, sku or scan barcode/i) as HTMLInputElement;
const rowBtn = async (name: RegExp) =>
  (await screen.findByText(name)).closest("button") as HTMLElement;

beforeEach(() => {
  jest.clearAllMocks();
  mockProducts = [PLAIN, BOXED];
});

/** Opens the builder, picks the customer and adds one line (`search` finds `product`). */
async function addLine(user: User, search: string, product: RegExp, onClose = jest.fn()) {
  renderWithProviders(<CreateOrderModal isOpen onClose={onClose} />);
  await user.type(cust(), "acme");
  await user.click(await rowBtn(/Acme Market/));
  await user.type(prod(), search);
  await user.click(await rowBtn(product));
  return onClose;
}
const qtyBox = () => document.querySelector<HTMLInputElement>('input[aria-label="Quantity"]')!;
const boxesBox = () => screen.getByTitle(/number of whole/i) as HTMLInputElement;
const create = () => screen.getByRole("button", { name: "Create Order" });
/** Focus the way a person does, then put text in the box in one change (a paste or a quick burst). */
async function focusAndType(user: User, el: HTMLElement, text: string) {
  await user.click(el);
  fireEvent.change(el, { target: { value: text } });
}
const postedItems = () => mockCreateMutate.mock.calls[0][0].items as Array<Record<string, unknown>>;

describe("CreateOrderModal typed sums (SA-1256 B1-B8)", () => {
  it("B1: qty 3, type 5*2, Tab, Create: the POST line quantity is 10", async () => {
    const user = userEvent.setup({ delay: null });
    await addLine(user, "cola", /Sample Cola/);
    await focusAndType(user, qtyBox(), "3");
    await focusAndType(user, qtyBox(), "5*2");
    await user.tab();
    await user.click(create());
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalledTimes(1));
    expect(postedItems()).toEqual([expect.objectContaining({ productId: "p-plain", qty: 10 })]);
  });

  it("B2: Ctrl+Enter on a held 5*2 works it out and does not post; a second Ctrl+Enter posts 10", async () => {
    const user = userEvent.setup({ delay: null });
    await addLine(user, "cola", /Sample Cola/);
    await focusAndType(user, qtyBox(), "3");
    await focusAndType(user, qtyBox(), "5*2");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(mockCreateMutate).not.toHaveBeenCalled();
    expect(qtyBox().value).toBe("10");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalledTimes(1));
    expect(postedItems()).toEqual([expect.objectContaining({ qty: 10 })]);
  });

  it("B3: a held 5*2, then a click on Create (the box blurs first): the POST carries 10", async () => {
    const user = userEvent.setup({ delay: null });
    await addLine(user, "cola", /Sample Cola/);
    await focusAndType(user, qtyBox(), "3");
    await focusAndType(user, qtyBox(), "5*2");
    await user.click(create());
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalledTimes(1));
    expect(postedItems()).toEqual([expect.objectContaining({ qty: 10 })]);
  });

  it("B4: on a 24-per-box line, boxes 2*3 and Enter give 6 boxes, 144 pieces and the priced total", async () => {
    const user = userEvent.setup({ delay: null });
    await addLine(user, "chips", /Sample Chips/);
    expect(boxesBox().value).toBe("1");
    await focusAndType(user, boxesBox(), "2*3");
    await user.keyboard("{Enter}");
    expect(boxesBox().value).toBe("6");
    expect(screen.getByText(/144 pcs total/)).toBeInTheDocument();
    expect(screen.getByTestId("line-total")).toHaveTextContent(
      formatMoney(
        computeLineSubtotal({ unitPrice: 30, qty: 144, boxes: 6, pieces: 0, unitsPerBox: 24 }),
      ),
    );
    await user.click(create());
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalledTimes(1));
    expect(postedItems()).toEqual([
      expect.objectContaining({ productId: "p-boxed", qty: 144, boxes: 6, pieces: 0 }),
    ]);
  });

  it("B4: the unit-total box takes 2*12 as 24 pieces", async () => {
    const user = userEvent.setup({ delay: null });
    await addLine(user, "chips", /Sample Chips/);
    await user.click(screen.getByRole("button", { name: "Piece" }));
    const total = screen.getByTitle(/^Total /) as HTMLInputElement;
    await focusAndType(user, total, "2*12");
    await user.keyboard("{Enter}");
    expect(total.value).toBe("24");
    await user.click(create());
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalledTimes(1));
    expect(postedItems()).toEqual([expect.objectContaining({ qty: 24, boxes: 1, pieces: 0 })]);
  });

  it("B5: boxes 5/2 is refused, the line stays at 1 box, and the message says why", async () => {
    const user = userEvent.setup({ delay: null });
    await addLine(user, "chips", /Sample Chips/);
    await focusAndType(user, boxesBox(), "5/2");
    await user.keyboard("{Enter}");
    expect(boxesBox().value).toBe("1");
    expect(screen.getByRole("alert")).toHaveTextContent("Not a whole number. Not changed.");
    expect(screen.getByText(/24 pcs total/)).toBeInTheDocument();
  });

  it("B6: 999*999 is refused with the cap message and the quantity stays 3", async () => {
    const user = userEvent.setup({ delay: null });
    await addLine(user, "cola", /Sample Cola/);
    await focusAndType(user, qtyBox(), "3");
    await user.tab(); // leave: the next visit starts from 3
    await focusAndType(user, qtyBox(), "999*999");
    await user.keyboard("{Enter}");
    expect(qtyBox().value).toBe("3");
    expect(screen.getByRole("alert")).toHaveTextContent("Too big. The most is 100,000.");
  });

  it("B8: a held 5*2 and a bare Enter work it out to 10 and post nothing", async () => {
    const user = userEvent.setup({ delay: null });
    await addLine(user, "cola", /Sample Cola/);
    await focusAndType(user, qtyBox(), "3");
    await focusAndType(user, qtyBox(), "5*2");
    await user.keyboard("{Enter}");
    expect(qtyBox().value).toBe("10");
    expect(mockCreateMutate).not.toHaveBeenCalled();
  });

  it("Escape on held text puts the value back and does not close the order builder", async () => {
    const user = userEvent.setup({ delay: null });
    const onClose = await addLine(user, "cola", /Sample Cola/);
    await focusAndType(user, qtyBox(), "3");
    await user.tab(); // leave: the next visit starts from 3
    await focusAndType(user, qtyBox(), "5*2");
    await user.keyboard("{Escape}");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(qtyBox().value).toBe("3");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create Order" })).toBeInTheDocument();
  });
});
