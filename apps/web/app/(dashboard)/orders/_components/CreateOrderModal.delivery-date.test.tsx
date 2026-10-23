import * as React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * Orders r3 F09 + F12 + F13: the Requested Delivery Date sits directly under the Customer picker (visible
 * without scrolling once lines are added), stays optional, and a date before today is refused next to the
 * field - the value is kept, the message says what to do, and Create Order does not send it.
 * Row 735a: "before today" is the BUSINESS's day (its zone from GET /settings), not the browser's.
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
let mockProducts: unknown[] = [PLAIN];
/** The business's zone as GET /settings reports it (undefined = the settings read carries none). */
let mockZone: string | undefined;

const CUSTOMERS = [
  { id: "c1", businessName: "Acme Deli", contactName: "Bo", pricingTier: 1, fulfillPath: "ROUTE" },
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
const mockCreateReset = jest.fn();
let mockCreateError: unknown = null;
jest.mock("@/lib/api/credit-notes", () => ({
  ...jest.requireActual("@/lib/api/credit-notes"),
  useCreditNotes: () => ({ data: { data: [] } }),
}));
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({
    mutate: mockCreateMutate,
    isPending: false,
    error: mockCreateError,
    reset: mockCreateReset,
  }),
  useActiveOrderForCustomer: () => ({ data: undefined }),
  useCustomerPriceHistory: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/drafts", () => ({
  useCreateDraft: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
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
    // GET /settings carries the business's zone (row 735a); every other read gets the tax shape it always did
    get: jest.fn().mockImplementation(async () => ({ data: { taxRate: 0, timezone: mockZone } })),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: () => <button type="button">scan</button>,
}));
jest.mock("@/lib/barcode-resolve", () => ({ resolveProductByCode: jest.fn() }));

const dateField = () => screen.getByLabelText(/requested delivery date/i) as HTMLInputElement;
const createButton = () => screen.getByRole("button", { name: "Create Order" });
type User = ReturnType<typeof userEvent.setup>;
/** Click once the target is interactive: a dialog still leaving sets `pointer-events: none`, which userEvent refuses (W-687). */
async function clickReady(user: User, el: HTMLElement) {
  await waitFor(() => expect(getComputedStyle(el).pointerEvents).not.toBe("none"));
  await user.click(el);
}
const PAST_MESSAGE = /pick today or a later date/i;
/** Fake only `Date`: React, userEvent and the query client keep their real timers. */
const ONLY_DATE = [
  "hrtime",
  "nextTick",
  "performance",
  "queueMicrotask",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "cancelIdleCallback",
  "setImmediate",
  "clearImmediate",
  "setInterval",
  "clearInterval",
  "setTimeout",
  "clearTimeout",
] as const;

// Two zones 25 hours apart (UTC+14, UTC-11) are on different calendar days at EVERY instant, so whatever day the
// browser (or this machine) is on, at least one of them is on another day than the browser: the old browser-day check
// could not pass for both. The default tenant is the eastern one.
const EAST = "Pacific/Kiritimati";
const WEST = "Pacific/Pago_Pago";

/** The business's calendar day (YYYY-MM-DD) in `zone` at `now`, shifted by whole days. */
const tenantDay = (offsetDays = 0, zone: string = mockZone ?? EAST, now: Date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now.getTime() + offsetDays * 86_400_000)); // en-CA formats as YYYY-MM-DD
const localDay = (offsetDays = 0) => tenantDay(offsetDays); // the tests below speak of the tenant's day

async function openWithCustomerAndLine() {
  const user = userEvent.setup({ delay: null });
  renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
  await user.type(screen.getByPlaceholderText(/search by business name/i), "acme");
  await clickReady(user, (await screen.findByText(/Acme Deli/)).closest("button") as HTMLElement);
  await user.type(screen.getByPlaceholderText(/search by name, sku or scan barcode/i), "cola");
  await clickReady(user, (await screen.findByText(/Sample Cola/)).closest("button") as HTMLElement);
  // the business's zone arrives with GET /settings; until then the field has no `min` and nothing is blocked locally
  if (mockZone) await waitFor(() => expect(dateField()).toHaveAttribute("min", tenantDay()));
  return user;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateMutate.mockReset();
  mockProducts = [PLAIN];
  mockCreateError = null;
  mockZone = EAST;
});
afterEach(() => jest.useRealTimers());

// W-687: a click that lands while a dialog is still leaving (pointer-events: none on the target) is refused by userEvent
// and the test flakes with the machine's speed. Simulate the exit window deterministically.
describe("a click during a dialog's exit window (W-687)", () => {
  it("the order still goes out when Create Order is clicked while it is briefly pointer-events: none", async () => {
    const user = await openWithCustomerAndLine();
    const button = createButton();
    button.style.pointerEvents = "none";
    setTimeout(() => {
      button.style.pointerEvents = "";
    }, 60);
    await clickReady(user, button);
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalled());
  });
});

describe("Requested Delivery Date placement (F09 + F12)", () => {
  it("renders right after the customer and before the products, with a line added", async () => {
    await openWithCustomerAndLine();
    const field = dateField();
    const customer = screen.getByRole("button", { name: "Change customer" });
    const productSearch = screen.getByPlaceholderText(/search by name, sku or scan barcode/i);
    const followedBy = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(followedBy(customer, field)).toBe(true);
    expect(followedBy(field, productSearch)).toBe(true);
    expect(followedBy(field, screen.getByText("Sample Cola", { selector: "p" }))).toBe(true);
  });

  it("stays optional: an order goes out with no delivery date", async () => {
    const user = await openWithCustomerAndLine();
    expect(dateField()).toHaveValue("");
    await clickReady(user, createButton());
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalled());
    expect(mockCreateMutate.mock.calls[0][0].requestedDeliveryDate).toBeUndefined();
  });

  it("a future date still goes out as requestedDeliveryDate", async () => {
    const user = await openWithCustomerAndLine();
    fireEvent.change(dateField(), { target: { value: localDay(3) } });
    await clickReady(user, createButton());
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalled());
    expect(mockCreateMutate.mock.calls[0][0].requestedDeliveryDate).toBe(localDay(3));
  });
});

describe("A delivery date in the past is refused (F13)", () => {
  it("shows what to do next to the field, keeps the typed value, and does not submit it", async () => {
    const user = await openWithCustomerAndLine();
    fireEvent.change(dateField(), { target: { value: "2025-10-26" } });
    const message = screen.getByText(PAST_MESSAGE);
    expect(message).toBeVisible();
    expect(dateField()).toHaveValue("2025-10-26");
    expect(dateField()).toHaveAttribute("aria-invalid", "true");
    expect(dateField()).toHaveAccessibleDescription(message.textContent ?? "");
    await clickReady(user, createButton());
    expect(mockCreateMutate).not.toHaveBeenCalled();
    expect(dateField()).toHaveValue("2025-10-26");
  });

  // Row 718: a blocking error is announced when it appears, and is red (the danger token), never amber.
  it("the message is a live region (role=alert) and the field and message are red, not amber", async () => {
    await openWithCustomerAndLine();
    fireEvent.change(dateField(), { target: { value: "2025-10-26" } });
    const alert = screen.getByRole("alert", { name: "" });
    expect(alert).toHaveTextContent(PAST_MESSAGE);
    expect(alert).toHaveClass("text-danger");
    expect(alert.className).not.toMatch(/amber/);
    expect(dateField()).toHaveClass("border-danger");
    expect(dateField().className).not.toMatch(/amber/);
  });

  it("no message and no alert while the date is fine", async () => {
    await openWithCustomerAndLine();
    fireEvent.change(dateField(), { target: { value: localDay(2) } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(dateField()).toHaveClass("border-surface-border");
  });

  it("yesterday is refused; today and a later date are accepted", async () => {
    const user = await openWithCustomerAndLine();
    fireEvent.change(dateField(), { target: { value: localDay(-1) } });
    expect(screen.getByText(PAST_MESSAGE)).toBeInTheDocument();
    fireEvent.change(dateField(), { target: { value: localDay(0) } });
    expect(screen.queryByText(PAST_MESSAGE)).toBeNull();
    expect(dateField()).not.toHaveAttribute("aria-invalid", "true");
    await clickReady(user, createButton());
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalled());
    expect(mockCreateMutate.mock.calls[0][0].requestedDeliveryDate).toBe(localDay(0));
  });

  it("fixing the date clears the message and lets the order go", async () => {
    const user = await openWithCustomerAndLine();
    fireEvent.change(dateField(), { target: { value: "2025-10-26" } });
    await clickReady(user, createButton());
    expect(mockCreateMutate).not.toHaveBeenCalled();
    fireEvent.change(dateField(), { target: { value: localDay(5) } });
    expect(screen.queryByText(PAST_MESSAGE)).toBeNull();
    await clickReady(user, createButton());
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalled());
    expect(mockCreateMutate.mock.calls[0][0].requestedDeliveryDate).toBe(localDay(5));
  });

  it("Save as draft does not send a past date either", async () => {
    const user = await openWithCustomerAndLine();
    fireEvent.change(dateField(), { target: { value: "2025-10-26" } });
    await clickReady(user, screen.getByRole("button", { name: "Save as draft" }));
    expect(mockCreateMutate).not.toHaveBeenCalled();
  });
});

// Row 718: the server measures the day on the TENANT's calendar, so a browser on a different day than the tenant can
// pass the local check and still be refused (400 DELIVERY_DATE_IN_PAST). That sentence belongs on the date field.
describe("The server's DELIVERY_DATE_IN_PAST refusal lands on the date field (row 718)", () => {
  const SERVER_MESSAGE =
    "That day has passed (today is 2026-10-22 for this business). Pick today or a later date.";
  const refusal = {
    response: {
      status: 400,
      data: { code: "DELIVERY_DATE_IN_PAST", message: "raw server sentence", today: "2026-10-22" },
    },
    message: "Request failed with status code 400",
  };

  it("shows the refusal, with the tenant's day, next to the field as a red live region, with no second banner", async () => {
    mockCreateError = refusal;
    await openWithCustomerAndLine();
    fireEvent.change(dateField(), { target: { value: localDay(0) } });
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(SERVER_MESSAGE);
    expect(screen.queryByText(/raw server sentence/)).toBeNull(); // worded from the code + the tenant's today (B986)
    expect(alerts[0]).toHaveClass("text-danger");
    expect(screen.getAllByText(SERVER_MESSAGE)).toHaveLength(1);
    expect(dateField()).toHaveAttribute("aria-invalid", "true");
    expect(dateField()).toHaveAccessibleDescription(SERVER_MESSAGE);
    expect(dateField()).toHaveClass("border-danger");
  });

  it("editing the date clears the refusal", async () => {
    mockCreateError = refusal;
    await openWithCustomerAndLine();
    mockCreateReset.mockClear();
    fireEvent.change(dateField(), { target: { value: localDay(1) } });
    expect(mockCreateReset).toHaveBeenCalled();
  });

  it("any other API error is not put on the date field", async () => {
    mockCreateError = {
      response: {
        status: 400,
        data: { code: "SOMETHING_ELSE", message: "Nope, different problem" },
      },
      message: "x",
    };
    await openWithCustomerAndLine();
    fireEvent.change(dateField(), { target: { value: localDay(1) } });
    expect(dateField()).not.toHaveAttribute("aria-invalid", "true");
    expect(dateField()).toHaveAccessibleDescription("");
  });
});

// Row 718 (UI proof): the server answers MERGE_CHOICE_REQUIRED first and the merge prompt opens; choosing "separate" then
// meets 400 DELIVERY_DATE_IN_PAST. The prompt must not stay over the real problem: it closes, and the date field takes focus.
describe("A delivery-date refusal after the merge prompt (row 718)", () => {
  const ACTIVE = {
    id: "o-open",
    orderNumber: "ORD-7",
    status: "PENDING",
    itemCount: 2,
    total: 12.5,
  };
  const mergeRequired = {
    response: {
      status: 409,
      data: { code: "MERGE_CHOICE_REQUIRED", message: "choose", activeOrder: ACTIVE },
    },
    message: "Request failed with status code 409",
  };
  const pastDay = {
    response: {
      status: 400,
      data: { code: "DELIVERY_DATE_IN_PAST", message: "raw", today: "2026-10-22" },
    },
    message: "Request failed with status code 400",
  };

  it("closes the merge prompt, shows the field refusal, and focuses the date input", async () => {
    mockCreateMutate.mockImplementation(
      (_payload: unknown, opts: { onError?: (e: unknown) => void }) => {
        if (mockCreateMutate.mock.calls.length === 1) {
          opts.onError?.(mergeRequired);
        } else {
          mockCreateError = pastDay;
          opts.onError?.(pastDay);
        }
      },
    );
    const user = await openWithCustomerAndLine();
    fireEvent.change(dateField(), { target: { value: localDay(0) } });
    await clickReady(user, createButton());
    await clickReady(
      user,
      await screen.findByRole("button", { name: /create as separate order/i }),
    );

    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalledTimes(2));
    expect(mockCreateMutate.mock.calls[1][0].mergeChoice).toBe("separate");
    await waitFor(() => expect(screen.queryByText("Open order exists")).toBeNull());
    expect(screen.getByRole("alert")).toHaveTextContent(/today is 2026-10-22/);
    await waitFor(() => expect(document.activeElement).toBe(dateField()));
  });
});

// Row 735a: the local past-date check reads the BUSINESS's calendar day (GET /settings timezone), never the browser's.
describe("The past-date check uses the tenant's day, not the browser's (row 735a)", () => {
  it.each([
    ["UTC+14", EAST],
    ["UTC-11", WEST],
  ])(
    "a %s business: its yesterday is refused, its today and tomorrow go out; `min` is its today",
    async (_label, zone) => {
      mockZone = zone;
      const user = await openWithCustomerAndLine();
      expect(dateField()).toHaveAttribute("min", tenantDay(0, zone));
      fireEvent.change(dateField(), { target: { value: tenantDay(-1, zone) } });
      expect(screen.getByText(PAST_MESSAGE)).toBeInTheDocument();
      await clickReady(user, createButton());
      expect(mockCreateMutate).not.toHaveBeenCalled();
      for (const offset of [0, 1]) {
        fireEvent.change(dateField(), { target: { value: tenantDay(offset, zone) } });
        expect(screen.queryByText(PAST_MESSAGE)).toBeNull();
      }
      fireEvent.change(dateField(), { target: { value: tenantDay(0, zone) } });
      await clickReady(user, createButton());
      await waitFor(() => expect(mockCreateMutate).toHaveBeenCalled());
      expect(mockCreateMutate.mock.calls[0][0].requestedDeliveryDate).toBe(tenantDay(0, zone));
    },
  );

  it("the two businesses really are on different days now (so the two cases above cannot both be the browser's day)", () => {
    expect(tenantDay(0, EAST) > tenantDay(0, WEST)).toBe(true);
  });

  it("a Honolulu business (UTC-10) at 05:00Z on the 22nd is on the 21st: the 21st is allowed, the 20th refused", async () => {
    mockZone = "Pacific/Honolulu";
    jest.useFakeTimers({ now: new Date("2026-10-22T05:00:00Z"), doNotFake: [...ONLY_DATE] });
    const user = await openWithCustomerAndLine();
    expect(dateField()).toHaveAttribute("min", "2026-10-21");
    fireEvent.change(dateField(), { target: { value: "2026-10-20" } });
    expect(screen.getByText(PAST_MESSAGE)).toBeInTheDocument();
    fireEvent.change(dateField(), { target: { value: "2026-10-21" } });
    expect(screen.queryByText(PAST_MESSAGE)).toBeNull();
    await clickReady(user, createButton());
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalled());
    expect(mockCreateMutate.mock.calls[0][0].requestedDeliveryDate).toBe("2026-10-21");
  });

  it("across the Chicago fall-back (2026-11-01 is 25 hours long): 23:30 CST on the 1st still allows the 1st", async () => {
    mockZone = "America/Chicago";
    jest.useFakeTimers({ now: new Date("2026-11-02T05:30:00Z"), doNotFake: [...ONLY_DATE] }); // 00:30 on the 2nd if the CDT offset were kept
    await openWithCustomerAndLine();
    expect(dateField()).toHaveAttribute("min", "2026-11-01");
    fireEvent.change(dateField(), { target: { value: "2026-11-01" } });
    expect(screen.queryByText(PAST_MESSAGE)).toBeNull();
  });

  it("...and 00:30 CST on the 2nd refuses the 1st", async () => {
    mockZone = "America/Chicago";
    jest.useFakeTimers({ now: new Date("2026-11-02T06:30:00Z"), doNotFake: [...ONLY_DATE] });
    await openWithCustomerAndLine();
    expect(dateField()).toHaveAttribute("min", "2026-11-02");
    fireEvent.change(dateField(), { target: { value: "2026-11-01" } });
    expect(screen.getByText(PAST_MESSAGE)).toBeInTheDocument();
  });

  it("until the business's zone is known nothing is blocked here and the field has no min: the server decides", async () => {
    mockZone = undefined;
    const user = await openWithCustomerAndLine();
    fireEvent.change(dateField(), { target: { value: "2025-10-26" } });
    expect(dateField()).not.toHaveAttribute("min");
    expect(screen.queryByText(PAST_MESSAGE)).toBeNull();
    await clickReady(user, createButton());
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalled()); // its 400 lands on the field (row 718, below)
  });
});
