import * as React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@routeflow/ui/web";
import { createTestQueryClient } from "@/test-utils/render";
import { useSavePrices } from "@/lib/api/usePriceWrites";
import { ProductUnitsCard } from "./ProductUnitsCard";

/**
 * REG (units v2, money): a v2 price save (POST /products/:id/prices) did not refresh the units list the legacy
 * card drafts from, and the card's Save always re-sent EVERY price of the unit it opened with. So after a v2 save, a
 * plain rename of a non-pack unit wrote the pre-save unit prices back, and a cascade offer was worked out from them.
 * The REAL `useProductUnits`, `useUpdateProductUnit` and `useSavePrices` run; only the network (a tiny in-memory
 * "server": GET/PATCH of the units, POST of the v2 price write) is mocked.
 */
const patch = jest.fn();
const post = jest.fn();
const getUnits = jest.fn();
type Unit = Record<string, unknown>;
let serverUnits: Unit[];

jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (url: string) =>
      url === "/products/p1/units" ? getUnits() : Promise.reject(new Error("unmocked read")),
    patch: (...a: unknown[]) => patch(...a),
    post: (...a: unknown[]) => post(...a),
  },
}));
jest.mock("@/lib/api/product-units", () => ({
  ...jest.requireActual("@/lib/api/product-units"),
  useUnitsEnabled: () => true,
}));
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => ({ data: undefined, isLoading: true, isError: false }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: {} }) }));
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: "OPERATOR" } }) }));

const product = { id: "p1", unit: "Box", unitsPerBox: 24, pricePerUnit: "42.00" };
const unit = (id: string, label: string, factorToBase: number, price: string): Unit => ({
  id,
  label,
  factorToBase,
  price,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  isDefaultSelling: false,
  sortOrder: 0,
});
const PRICE_KEYS = ["price", "priceTier2", "priceTier3", "priceTier4", "priceTier5"] as const;

/** The v2 grid's save, as the page's real mutation hook runs it: moves the Case to 500 and the Pallet to 6000. */
function V2Saver() {
  const save = useSavePrices("p1");
  return (
    <button type="button" onClick={() => save.mutate({ patches: [] } as never)}>
      price write v2
    </button>
  );
}

function renderCard() {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <V2Saver />
        <ProductUnitsCard product={product} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function v2Save() {
  await screen.findByLabelText("Case name");
  const before = getUnits.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "price write v2" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  // The units list is refetched after the write, and the card shows the fresh figure.
  await waitFor(() => expect(getUnits.mock.calls.length).toBeGreaterThan(before));
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Pallet price") as HTMLInputElement).value.replace(/[^0-9.]/g, ""),
    ).toBe("6000.00"),
  );
}

const saveRow = (label: string) => {
  const row = screen.getByLabelText(`${label} name`).closest("li") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Save" }));
};

beforeEach(() => {
  jest.clearAllMocks();
  serverUnits = [
    unit("u-case", "Case", 288, "480.00"),
    unit("u-pallet", "Pallet", 5760, "5760.00"),
  ];
  getUnits.mockImplementation(() => Promise.resolve({ data: serverUnits.map((u) => ({ ...u })) }));
  post.mockImplementation(async () => {
    serverUnits = serverUnits.map((u) =>
      u.id === "u-case"
        ? { ...u, price: "500.00" }
        : u.id === "u-pallet"
          ? { ...u, price: "6000.00" }
          : u,
    );
    return { data: { grid: { revision: 2 } } };
  });
  patch.mockImplementation(async (url: string, body: Record<string, unknown>) => {
    const id = url.split("/").pop();
    serverUnits = serverUnits.map((u) => (u.id === id ? { ...u, ...body } : u));
    return { data: serverUnits.find((u) => u.id === id) };
  });
});

describe("the legacy Units card never restores a stale unit price", () => {
  it("REG: after a v2 save, renaming a non-pack unit sends no price key and the v2 prices survive", async () => {
    renderCard();
    await v2Save();
    fireEvent.change(screen.getByLabelText("Case name"), { target: { value: "Cases" } });
    saveRow("Case");
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [url, body] = patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe("/products/p1/units/u-case");
    expect(body.label).toBe("Cases");
    expect(body.factorToBase).toBe(288);
    for (const k of PRICE_KEYS) expect(body).not.toHaveProperty(k);
    // Readback: what the server holds (and the refetched card shows) is still the v2 price.
    expect(serverUnits.find((u) => u.id === "u-case")?.price).toBe("500.00");
    expect(serverUnits.find((u) => u.id === "u-pallet")?.price).toBe("6000.00");
  });

  it("a default-selling change sends no price key (it never did)", async () => {
    renderCard();
    await v2Save();
    const row = screen.getByLabelText("Case name").closest("li") as HTMLElement;
    fireEvent.click(within(row).getByLabelText("Default order unit"));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0][1]).toEqual({ isDefaultSelling: true });
  });

  it("REG: after a v2 save, a cascade offer is worked out from the FRESH prices", async () => {
    renderCard();
    await v2Save();
    // Case 500.00 -> 550 (+10%): the Pallet (6000 fresh, 5760 stale) is offered the same move.
    fireEvent.change(screen.getByLabelText("Case price"), { target: { value: "550" } });
    saveRow("Case");
    const dialog = await screen.findByText("Update the other unit prices too?");
    const modal = dialog.closest("[role='dialog']") as HTMLElement;
    expect(modal.textContent).toContain("$6,000.00 → $6,600.00");
    expect(modal.textContent).not.toContain("$5,760.00");
  });

  it("a genuine single price edit sends just that price key (with the label and factor as today)", async () => {
    renderCard();
    await v2Save();
    fireEvent.change(screen.getByLabelText("Case price"), { target: { value: "510" } });
    saveRow("Case");
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0][1]).toEqual({
      label: "Case",
      factorToBase: 288,
      price: 510,
    });
  });

  it("clearing an explicit price still sends null for that key alone", async () => {
    renderCard();
    await v2Save();
    fireEvent.change(screen.getByLabelText("Case price"), { target: { value: "" } });
    saveRow("Case");
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0][1]).toEqual({ label: "Case", factorToBase: 288, price: null });
  });
});
