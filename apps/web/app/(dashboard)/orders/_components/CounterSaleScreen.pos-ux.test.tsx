import * as React from "react";
import { act } from "@testing-library/react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { renderTill } from "@/test-utils/render-till";
import { CounterSaleScreen } from "./CounterSaleScreen";
import { LINE_UNDO_MS } from "./useCounterLineUndo";

/** B1373: a till line shows its quantity in the order row's number field (no "× N" text). */
const qtyOf = (line: HTMLElement) =>
  Number(
    (within(line).getByRole("spinbutton", { name: /Set quantity of/ }) as HTMLInputElement).value,
  );

/**
 * POS UX review folds: typed quantity editor, single-line note, payment column scroll, undo bar live region + pause, receipt targets. The API is
 * mocked at the module boundary exactly as CounterSaleScreen.test.tsx does. RTL cannot measure pixels, so the layout and
 * size pins are CLASS pins (Playwright verifies the rendered 390 / lg layout).
 */

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: jest.fn() }) }));

const COLA = { id: "p-cola", name: "Cola", pricePerUnit: 2.5, unit: "each", unitsPerBox: null };
const WATER = { id: "p-water", name: "Water", pricePerUnit: 12, unit: "case", unitsPerBox: 12 };
const productFor: Record<string, unknown> = { COLA, WATER };
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    productFor[code] ? { product: productFor[code], source: "sku" } : { notFound: true },
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({
    data: [],
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }), post: jest.fn() },
}));
let gate: Record<string, unknown> = {};
const mutateAsync = jest.fn();
let pending = false;
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => gate,
  useCreateCounterSale: () => ({ mutateAsync, isPending: pending }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  pending = false;
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.print = jest.fn();
  gate = {
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: true,
    capability: { counter: "always", methods: ["SHIP", "PICKUP"], staffDefault: "PICKUP" },
  };
  mutateAsync.mockResolvedValue({
    orderId: "o1",
    orderNumber: "ORD-1",
    invoiceId: "i1",
    invoiceNumber: "INV-1",
    total: 0,
    paid: 0,
    balanceDue: 0,
    paymentRecorded: true,
  });
});
afterEach(() => jest.useRealTimers());

const scan = async (text: string) => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
};
const UNDO = /^Undo: put back /;
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));

/** Cola x2 (first line, plain) and Water 1 box + 3 pcs (second line, boxed). */
async function buildCart() {
  renderTill(<CounterSaleScreen />);
  await scan("COLA");
  await scan("COLA");
  await scan("WATER");
  await waitFor(() => expect(screen.getByText(/Water/)).toBeInTheDocument());
  // B1373: there is no one-tap piece stepper on a boxed line: open the loose-pieces field and type 3
  fireEvent.click(within(lineOf("Water")).getByRole("button", { name: /^\+ .*: add extra / }));
  fireEvent.change(piecesField(), { target: { value: "3" } });
}
const itemNames = () =>
  within(screen.getByRole("list", { name: "Items" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent ?? "");

const qtyInput = (name: string) =>
  screen.getByLabelText(`Set quantity of ${name}`) as HTMLInputElement;
const lineOf = (name: string) =>
  within(screen.getByRole("list", { name: "Items" }))
    .getAllByRole("listitem")
    .find((li) => li.textContent?.includes(name))!;
/** The boxed line's whole-boxes field and its opt-in loose-pieces field (the order row's controls). */
const boxesField = () =>
  within(lineOf("Water")).getByTitle(/^Number of whole /) as HTMLInputElement;
const piecesField = () =>
  within(lineOf("Water")).getByRole("spinbutton", { name: /^Extra / }) as HTMLInputElement;

describe("typed quantity editor (steppers stay)", () => {
  it("a plain line: a typed number commits as it is typed; Enter hands the cursor back to the scan box; the steppers are still there", async () => {
    await buildCart(); // Cola x2
    expect(screen.getByRole("button", { name: "Add one Cola" })).toBeInTheDocument();
    const input = qtyInput("Cola");
    expect(input.type).toBe("number");
    expect(input).toHaveClass("max-lg:h-11"); // the 44 px touch floor below lg
    fireEvent.change(input, { target: { value: "5" } });
    expect(qtyOf(lineOf("Cola"))).toBe(5);
    expect(screen.getByTestId("running-total")).toHaveTextContent("$27.50"); // 5 x 2.50 + 15.00
    qtyInput("Cola").focus();
    fireEvent.keyDown(qtyInput("Cola"), { key: "Enter" });
    await waitFor(() => expect(screen.getByLabelText("Scan or search items")).toHaveFocus());
    fireEvent.change(qtyInput("Cola"), { target: { value: "3" } });
    expect(qtyOf(lineOf("Cola"))).toBe(3);
  });

  it("0, negative or empty reverts (it never removes the line; x does)", async () => {
    await buildCart();
    for (const bad of ["0", "-3", ""]) {
      fireEvent.change(qtyInput("Cola"), { target: { value: bad } });
      expect(qtyOf(lineOf("Cola"))).toBe(2);
      expect(qtyInput("Cola").value).toBe("2");
    }
    expect(screen.getByRole("button", { name: "Remove Cola" })).toBeInTheDocument();
  });

  it("Tab from the Boxes field of a boxed line is natural (never redirected), even with a draft", async () => {
    await buildCart();
    const boxes = boxesField();
    boxes.focus();
    fireEvent.change(boxes, { target: { value: "2" } });
    expect(fireEvent.keyDown(boxes, { key: "Tab" })).toBe(true);
  });

  it("a boxed line has box and piece inputs, normalized through normalizeBoxesPieces (42 pcs -> 3 boxes + 6 pcs)", async () => {
    await buildCart(); // Water 1 box + 3 pcs
    expect([boxesField().value, piecesField().value]).toEqual(["1", "3"]);
    fireEvent.change(piecesField(), { target: { value: "30" } });
    expect(boxesField().value).toBe("3");
    expect(piecesField().value).toBe("6");
    expect(screen.getByTestId("running-total")).toHaveTextContent("$47.00");
  });

  it("a boxed line typed down to nothing (0 boxes, 0 pieces) reverts the last edit", async () => {
    await buildCart(); // Water 1 box + 3 pcs
    fireEvent.change(piecesField(), { target: { value: "0" } });
    expect([boxesField().value, piecesField().value]).toEqual(["1", "0"]);
    fireEvent.change(boxesField(), { target: { value: "0" } });
    expect(boxesField().value).toBe("1");
  });

  it("the typed quantity rides the ring (qty only for a plain line)", async () => {
    await buildCart();
    fireEvent.change(qtyInput("Cola"), { target: { value: "4" } });
    click("Exact");
    click("Complete & show receipt");
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].dto.items[0]).toEqual({ productId: "p-cola", qty: 4 });
  });
});

describe("line note field", () => {
  it("is capped at 200, keeps a leading space while typing, Enter closes it, trims on the wire", async () => {
    await buildCart();
    click("Add a note to Cola");
    const box = screen.getByLabelText("Note for Cola") as HTMLTextAreaElement;
    expect(box.maxLength).toBe(200);
    fireEvent.change(box, { target: { value: " no ice" } });
    expect((screen.getByLabelText("Note for Cola") as HTMLTextAreaElement).value).toBe(" no ice");
    fireEvent.keyDown(box, { key: "Enter" }); // Enter closes (no new line)
    expect((screen.getByLabelText("Note for Cola") as HTMLTextAreaElement).value).toBe(" no ice");
    click("Exact");
    click("Complete & show receipt");
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].dto.items[0].note).toBe("no ice");
  });
});

describe("payment column never scrolls off", () => {
  it("is sticky from md with a viewport-bound max height and its own scroll", async () => {
    await buildCart();
    const col = screen.getByTestId("counter-payment-column");
    expect(col.className).toMatch(/md:sticky/);
    expect(col.className).toMatch(/md:max-h-\[calc\(100vh-5rem\)\]/);
    expect(col.className).toMatch(/md:overflow-y-auto/);
  });
});

describe("removed-line bar: live region, pause on hover/focus, named Undo", () => {
  it("the live region is always mounted (polite), empty until a removal", async () => {
    await buildCart();
    const region = screen.getByRole("status", { name: "Removed item" });
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toBeEmptyDOMElement();
    click("Remove Cola");
    expect(screen.getByRole("status", { name: "Removed item" })).toBe(region); // same node
    expect(region).toHaveTextContent("Line removed.");
    expect(screen.getByRole("button", { name: "Undo: put back Cola" })).toBeInTheDocument();
  });

  it("hover pauses the undo timer and leaving resumes it", async () => {
    await buildCart();
    jest.useFakeTimers();
    click("Remove Cola");
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    fireEvent.mouseEnter(screen.getByTestId("line-undo-bar"));
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(screen.getByRole("button", { name: UNDO })).toBeInTheDocument(); // paused
    fireEvent.mouseLeave(screen.getByTestId("line-undo-bar"));
    act(() => {
      jest.advanceTimersByTime(LINE_UNDO_MS - 3000 - 100);
    });
    expect(screen.getByRole("button", { name: UNDO })).toBeInTheDocument(); // the rest of the window was left
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(screen.queryByRole("button", { name: UNDO })).toBeNull();
  });

  it("focus pauses it and blur resumes it", async () => {
    await buildCart();
    jest.useFakeTimers();
    click("Remove Cola");
    fireEvent.focus(screen.getByRole("button", { name: UNDO }));
    act(() => {
      jest.advanceTimersByTime(20_000);
    });
    expect(screen.getByRole("button", { name: UNDO })).toBeInTheDocument();
    fireEvent.blur(screen.getByRole("button", { name: UNDO }));
    act(() => {
      jest.advanceTimersByTime(LINE_UNDO_MS + 100);
    });
    expect(screen.queryByRole("button", { name: UNDO })).toBeNull();
  });
});

describe("receipt controls are 44 px with visible focus rings", () => {
  it("Print and New sale", async () => {
    await buildCart();
    click("Exact");
    click("Complete & show receipt");
    await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
    for (const name of ["Print", "New sale"]) {
      const cls = screen.getByRole("button", { name }).className;
      expect(cls).toMatch(/min-h-\[44px\]/);
      expect(cls).toMatch(/min-w-\[44px\]/);
      expect(cls).toMatch(/focus-visible:ring-/);
    }
  });

  it("Record payment (payment not recorded) is a 44 px link with a focus ring", async () => {
    mutateAsync.mockResolvedValue({
      orderId: "o1",
      orderNumber: "ORD-1",
      invoiceId: "i1",
      invoiceNumber: "INV-1",
      total: 20,
      paid: 0,
      balanceDue: 20,
      paymentRecorded: false,
    });
    await buildCart();
    click("Exact");
    click("Complete & show receipt");
    const link = await screen.findByRole("link", { name: "Record payment" });
    expect(link.className).toMatch(/min-h-\[44px\]/);
    expect(link.className).toMatch(/focus-visible:ring-/);
  });
});
