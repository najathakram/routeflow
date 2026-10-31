import * as React from "react";
import { act } from "@testing-library/react";
import { screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { TOUCH_FIRST_QUERY } from "@/lib/touch-first";
import { renderTill } from "@/test-utils/render-till";
import { newProductPrefill } from "@/lib/product-prefill";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * W-1042 / SA-1062 A-2: which field a code goes to is decided by the DOOR, not the digits. The camera always reads a code
 * (SKU, whatever its characters). A miss from the scan box goes to SKU when it has no space and at least one digit, otherwise
 * Name. Create "<text>" from the live list is typed, so the helper's own rule (six or more digits) stands. Create Order's
 * typed row and unknown scan are not edited.
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", role: "TENANT_ADMIN", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
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
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock("@/lib/scan-cue", () => ({ playScanCue: jest.fn(), unlockScanCue: jest.fn() }));
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: false,
    capability: { counter: "always" },
    deniedGroups: [],
  }),
  useCreateCounterSale: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
const strip: { onCode: ((code: string) => void) | null } = { onCode: null };
jest.mock("./CounterCameraStrip", () => ({
  ...jest.requireActual("./CounterCameraStrip"),
  CounterCameraStrip: (props: { onCode: (code: string) => void }) => {
    strip.onCode = props.onCode;
    return <div data-testid="counter-camera-strip" />;
  },
}));

let created: Record<string, any> | null = null;
beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  strip.onCode = null;
  created = null;
  (apiClient.get as jest.Mock).mockImplementation(async (url: string) => {
    if (url === "/settings") return { data: { taxRate: 0 } };
    if (url === "/tracked-categories" || url === "/products/categories") return { data: [] };
    if (url.startsWith("/products/barcode/")) {
      const code = decodeURIComponent(url.slice("/products/barcode/".length));
      return created && created.sku === code
        ? { data: created }
        : Promise.reject({ response: { status: 404 } });
    }
    if (url === "/products") return { data: { data: [] } };
    throw new Error(`unexpected GET ${url}`);
  });
  (apiClient.post as jest.Mock).mockImplementation(async (_url: string, body: any) => {
    created = { id: "p-new", ...body, unitsPerBox: null, isActive: true };
    return { data: created };
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      matches: q === TOUCH_FIRST_QUERY,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
  });
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).matchMedia;
});

const field = () => screen.getByLabelText("Scan or search items") as HTMLInputElement;
const submitScan = (text: string) => {
  fireEvent.change(field(), { target: { value: text } });
  fireEvent.submit(field().closest("form")!);
};
const lines = () =>
  within(screen.getByRole("list", { name: "Items" }))
    .queryAllByRole("listitem")
    .filter((li) => li.textContent !== "No items yet.");
const nameInput = () => screen.getByPlaceholderText("e.g. Sourdough Bread") as HTMLInputElement;
const skuInput = () => screen.getByPlaceholderText("Scan or type") as HTMLInputElement;

async function boxMissThenCreate(text: string) {
  submitScan(text);
  await screen.findByText(`No product for '${text}'`);
  fireEvent.click(await screen.findByRole("button", { name: "Create item" }));
  await screen.findByRole("heading", { name: "New product" });
}

describe("A-2: the scan box reads the shape", () => {
  it("R5c: 'AB12345' Enter, Create item: SKU holds it, and the next scan adds the line", async () => {
    renderTill(<CounterSaleScreen />);
    await boxMissThenCreate("AB12345");
    expect(skuInput().value).toBe("AB12345");
    expect(nameInput().value).toBe("");
    fireEvent.change(nameInput(), { target: { value: "Fresh Pie" } });
    fireEvent.change(screen.getByPlaceholderText("e.g. case, kg, unit"), {
      target: { value: "each" },
    });
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "4.5" } });
    fireEvent.submit(screen.getByRole("button", { name: /create product/i }).closest("form")!);
    await waitFor(() => expect(lines()).toHaveLength(1));
    submitScan("AB12345");
    await waitFor(() => expect(lines()[0]).toHaveTextContent("× 2"));
    expect(lines()).toHaveLength(1);
  });

  it("R5e guard: 'Fresh Pie' and 'Cola' go to Name", async () => {
    renderTill(<CounterSaleScreen />);
    await boxMissThenCreate("Fresh Pie");
    expect(nameInput().value).toBe("Fresh Pie");
    expect(skuInput().value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await boxMissThenCreate("Cola");
    expect(nameInput().value).toBe("Cola");
    expect(skuInput().value).toBe("");
  });

  it("R5f guard: '012345678' goes to SKU", async () => {
    renderTill(<CounterSaleScreen />);
    await boxMissThenCreate("012345678");
    expect(skuInput().value).toBe("012345678");
    expect(nameInput().value).toBe("");
  });
});

describe("A-2: the camera always reads a code", () => {
  it("R5d: the camera reads 'ABCDEF', Create item: SKU holds it, Name is empty", async () => {
    renderTill(<CounterSaleScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
    act(() => strip.onCode!("ABCDEF"));
    await screen.findByText("No product for 'ABCDEF'");
    fireEvent.click(await screen.findByRole("button", { name: "Create item" }));
    await screen.findByRole("heading", { name: "New product" });
    expect(skuInput().value).toBe("ABCDEF");
    expect(nameInput().value).toBe("");
  });
});

describe("A-2: the live list is typing and keeps the helper's rule", () => {
  it('R5g guard: Create "AB12345" goes to Name, Create "012345678" goes to SKU', async () => {
    renderTill(<CounterSaleScreen />);
    fireEvent.change(field(), { target: { value: "AB12345" } });
    fireEvent.click(await screen.findByRole("button", { name: 'Create "AB12345"' }));
    await screen.findByRole("heading", { name: "New product" });
    expect(nameInput().value).toBe("AB12345");
    expect(skuInput().value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.change(field(), { target: { value: "012345678" } });
    fireEvent.click(await screen.findByRole("button", { name: 'Create "012345678"' }));
    await screen.findByRole("heading", { name: "New product" });
    expect(skuInput().value).toBe("012345678");
    expect(nameInput().value).toBe("");
  });
});

describe("A-2: Create Order's rule is the helper's default", () => {
  it("R5h guard: with no door named, six digits are a SKU and anything else a name", () => {
    expect(newProductPrefill("012345678")).toEqual({ name: "", sku: "012345678" });
    expect(newProductPrefill("AB12345")).toEqual({ name: "AB12345", sku: "" });
    expect(newProductPrefill("Cola")).toEqual({ name: "Cola", sku: "" });
  });
});
