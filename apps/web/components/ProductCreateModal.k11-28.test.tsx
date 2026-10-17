import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getStoredUser } from "@/lib/auth";
import { renderWithProviders } from "@/test-utils/render";
import { ProductCreateModal } from "./ProductCreateModal";
import { uploadProductImages } from "@/lib/api/products";
import {
  draftKey,
  EMPTY_DRAFT_FORM,
  DRAFT_SAVE_DELAY_MS,
} from "./product-create/product-create-draft";

/**
 * K11-28 (F06): an optional "Price per piece" when creating a cased product.
 *
 * Gate (K11-L3-SIGNOFFS): both flags, a pack unit, Units per case an integer >= 2, and no "Variant of" parent.
 * Writes (design gate option B2, price through S9, never on the units POST), in this order and no other:
 *   POST /products -> POST /products/:id/units {label:"Piece", factorToBase:1}
 *   -> GET /products/:id/price-grid (revision + priceState) -> POST /products/:id/prices (base, tier 1).
 * A failure after the product exists keeps the product, stops the chain, shows only the warning, and still hands the
 * product back once.
 */
const calls: string[] = [];
const bodies: Record<string, unknown> = {};
const mutateAsync = jest.fn();
const toastSpy = jest.fn();
const flags = { v2: true, v1: true };
let products: { data: unknown[] } = { data: [] };
const api = {
  post: jest.fn(),
  get: jest.fn(),
};

jest.mock("@/lib/auth", () => ({
  ...jest.requireActual("@/lib/auth"),
  getStoredUser: jest.fn(),
}));
jest.mock("@routeflow/ui/web", () => {
  const actual = jest.requireActual("@routeflow/ui/web");
  return {
    ...actual,
    useToast: () => {
      const real = actual.useToast();
      return {
        ...real,
        toast: (d: unknown) => {
          toastSpy(d);
          return real.toast(d as never);
        },
      };
    },
  };
});
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => flags.v2 }));
jest.mock("@/lib/api/product-units", () => ({ useUnitsEnabled: () => flags.v1 }));
jest.mock("@/lib/api/products", () => ({
  useCreateProduct: () => ({ mutateAsync, isPending: false }),
  useProducts: () => ({ data: products }),
  uploadProductImages: jest.fn(),
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
  useRegulatedTemplates: () => ({ data: [] }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...a: unknown[]) => api.get(...a),
    post: (...a: unknown[]) => api.post(...a),
  },
}));
jest.mock("./CategoryCombobox", () => ({ CategoryCombobox: () => <div /> }));
jest.mock("./SubcategoryCombobox", () => ({ SubcategoryCombobox: () => <div /> }));
jest.mock("./BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));

const GRID = { revision: 7, priceState: "ps-1", rows: [], productId: "p1" };

function setupApi(fail: "units" | "grid" | "prices" | null = null) {
  calls.length = 0;
  api.post.mockReset();
  api.get.mockReset();
  mutateAsync.mockReset();
  mutateAsync.mockImplementation(async (b: unknown) => {
    calls.push("POST /products");
    bodies["POST /products"] = b;
    return { id: "p1", name: "Cola", unit: "case", pricePerUnit: "21.00" };
  });
  api.post.mockImplementation(async (url: string, body: unknown) => {
    const key = `POST ${url.replace("/products/p1", "/products/:id")}`;
    calls.push(key);
    bodies[key] = body;
    if (fail === "units" && url.endsWith("/units")) throw new Error("units 500");
    if (fail === "prices" && url.endsWith("/prices")) throw new Error("prices 409");
    return { data: {} };
  });
  api.get.mockImplementation(async (url: string) => {
    calls.push(`GET ${url.replace("/products/p1", "/products/:id")}`);
    if (fail === "grid") throw new Error("grid 500");
    return { data: GRID };
  });
}

function open(props: Partial<React.ComponentProps<typeof ProductCreateModal>> = {}) {
  const onCreated = jest.fn();
  const onClose = jest.fn();
  const utils = renderWithProviders(
    <ProductCreateModal isOpen onClose={onClose} onCreated={onCreated} {...props} />,
  );
  return { onCreated, onClose, ...utils };
}

async function fillCase(opts: { piece?: string; perCase?: string; unit?: string } = {}) {
  await userEvent.type(screen.getByLabelText("Name *"), "Cola");
  await userEvent.type(screen.getByLabelText(/^Unit \*/), opts.unit ?? "case");
  await userEvent.type(screen.getByLabelText(/^Price per case/), "21");
  await userEvent.type(screen.getByLabelText("Units per box"), opts.perCase ?? "12");
  if (opts.piece != null) {
    await userEvent.type(screen.getByLabelText(/^Price per piece/), opts.piece);
  }
}
const pieceField = () => screen.queryByLabelText(/^Price per piece/);
const create = () => fireEvent.click(screen.getByRole("button", { name: "Create product" }));

beforeEach(() => {
  localStorage.clear();
  (getStoredUser as jest.Mock).mockReset();
  (getStoredUser as jest.Mock).mockReturnValue(null);
  flags.v2 = true;
  flags.v1 = true;
  products = { data: [] };
  toastSpy.mockReset();
  setupApi();
});

describe("K11-28: when the field shows", () => {
  it("shows for a pack unit with Units per case 12, both flags on, no parent", async () => {
    open();
    await fillCase();
    expect(pieceField()).toBeInTheDocument();
  });

  it.each([
    ["flag.units_prices_v2 is off", () => (flags.v2 = false), "12", "case"],
    ["flag.units_v1 is off", () => (flags.v1 = false), "12", "case"],
    ["the unit is not a pack", () => undefined, "12", "each"],
    ["Units per case is 1", () => undefined, "1", "case"],
    ["Units per case is not a whole number", () => undefined, "2.5", "case"],
  ])("is hidden when %s", async (_n, arrange, perCase, unit) => {
    arrange();
    open();
    await userEvent.type(screen.getByLabelText(/^Unit \*/), unit);
    const per = screen.queryByLabelText("Units per box");
    if (per) await userEvent.type(per, perCase);
    expect(pieceField()).toBeNull();
  });

  it("is hidden while Units per case is blank", async () => {
    open();
    await userEvent.type(screen.getByLabelText(/^Unit \*/), "case");
    expect(pieceField()).toBeNull();
  });

  it("is hidden when a Variant of parent is set (the family prices a variant)", async () => {
    products = {
      data: [{ id: "par1", name: "Acme", unit: "case", pricePerUnit: "21", unitsPerBox: 12 }],
    };
    open({ defaultParentId: "par1" });
    await waitFor(() => expect(screen.getByLabelText(/^Unit \*/)).toHaveValue("case"));
    expect(pieceField()).toBeNull();
  });
});

describe("K11-28: where it sits and how it reads", () => {
  it("is the third cell of the price row: under Price per case, tab order case price, units, piece price", async () => {
    open();
    await fillCase();
    const row = document.querySelector("[data-price-row]") as HTMLElement;
    const cells = Array.from(row.children) as HTMLElement[];
    expect(cells).toHaveLength(3);
    expect(cells[0]).toContainElement(screen.getByLabelText(/^Price per case/));
    expect(cells[1]).toContainElement(screen.getByLabelText("Units per box"));
    expect(cells[2]).toContainElement(pieceField() as HTMLElement);
    expect(row.className).toMatch(/grid-cols-2/);
  });

  it("is labelled 'Price per piece (optional)' with a $ box and the one-line helper", async () => {
    open();
    await fillCase();
    const label = document.querySelector('label[for="product-base-price"]') as HTMLElement;
    expect(label.textContent).toBe("Price per piece (optional)");
    expect(label.querySelector("span")?.textContent).toBe("(optional)");
    const cell = pieceField()!.closest("div.flex")!.parentElement as HTMLElement;
    expect(cell).toHaveTextContent("$");
    expect(screen.getByText("Leave blank to sell only by the box.")).toBeInTheDocument();
  });

  it("when the field appears it is scrolled into view (nearest) so it never sits under the pinned footer, without taking focus", async () => {
    const scroll = jest.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      open();
      await userEvent.type(screen.getByLabelText(/^Unit \*/), "case");
      await userEvent.type(screen.getByLabelText("Units per box"), "1");
      expect(scroll).not.toHaveBeenCalled(); // hidden at 1: nothing to reveal
      await userEvent.type(screen.getByLabelText("Units per box"), "2");
      await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: "nearest" }));
      const target = scroll.mock.instances[0] as HTMLElement;
      expect(target).toContainElement(pieceField() as HTMLElement); // the whole cell (field + helper)
      expect(target).toHaveTextContent("Leave blank to sell only by the box.");
      expect(document.activeElement).toBe(screen.getByLabelText("Units per box"));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("appearing does not move focus", async () => {
    open();
    await userEvent.type(screen.getByLabelText(/^Unit \*/), "case");
    await userEvent.type(screen.getByLabelText("Units per box"), "12");
    expect(document.activeElement).toBe(screen.getByLabelText("Units per box"));
  });
});

describe("K11-28: validation runs before anything is written", () => {
  it.each(["0", "-2"])(
    "a piece price of %s blocks Create with an inline error and writes nothing",
    async (bad) => {
      open();
      await fillCase({ piece: bad });
      create();
      const field = pieceField()!;
      await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));
      const err = document.getElementById(
        field.getAttribute("aria-describedby")!.split(" ").pop()!,
      )!;
      expect(err).toHaveTextContent(/above \$0\.00/);
      expect(mutateAsync).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
      expect(screen.getByRole("button", { name: "Create product" })).toBeEnabled();
    },
  );

  it("fixing the value clears the error", async () => {
    open();
    await fillCase({ piece: "0" });
    create();
    await waitFor(() => expect(pieceField()).toHaveAttribute("aria-invalid", "true"));
    await userEvent.clear(pieceField()!);
    await userEvent.type(pieceField()!, "1.75");
    expect(pieceField()).not.toHaveAttribute("aria-invalid", "true");
  });
});

describe("K11-28: the write chain", () => {
  it("sends exactly four requests, in this order, with these bodies", async () => {
    const { onCreated, onClose } = open();
    await fillCase({ piece: "1.75" });
    create();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([
      "POST /products",
      "POST /products/:id/units",
      "GET /products/:id/price-grid",
      "POST /products/:id/prices",
    ]);
    // the units write carries NO price: it would bypass the S9 compare-and-set, audit and undo
    expect(bodies["POST /products/:id/units"]).toEqual({ label: "Piece", factorToBase: 1 });
    expect(bodies["POST /products/:id/prices"]).toEqual({
      expectedRevision: 7,
      expectedPriceState: "ps-1",
      patches: [{ ref: "base", tier: 1, to: 1.75 }],
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Cola created", variant: "success" }),
    );
  });

  it("rounds the price to cents before sending", async () => {
    const { onCreated } = open();
    await fillCase({ piece: "1.755" });
    create();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect((bodies["POST /products/:id/prices"] as any).patches[0].to).toBe(1.76);
  });

  it("a blank piece price makes no unit or price call at all", async () => {
    const { onCreated } = open();
    await fillCase();
    create();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(calls).toEqual(["POST /products"]);
  });

  it("a typed value in a hidden field is kept in state but never sent, and comes back when the field does", async () => {
    const { onCreated } = open();
    await fillCase({ piece: "1.75" });
    await userEvent.clear(screen.getByLabelText("Units per box"));
    expect(pieceField()).toBeNull();
    create();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(calls).toEqual(["POST /products"]);
  });

  it("the value returns when the field shows again", async () => {
    open();
    await fillCase({ piece: "1.75" });
    await userEvent.clear(screen.getByLabelText("Units per box"));
    await userEvent.type(screen.getByLabelText("Units per box"), "6");
    expect(pieceField()).toHaveValue(1.75);
  });

  it.each([
    ["units", ["POST /products", "POST /products/:id/units"]],
    ["grid", ["POST /products", "POST /products/:id/units", "GET /products/:id/price-grid"]],
    [
      "prices",
      [
        "POST /products",
        "POST /products/:id/units",
        "GET /products/:id/price-grid",
        "POST /products/:id/prices",
      ],
    ],
  ] as const)(
    "a failure at the %s step keeps the product, stops there, warns, and still calls onCreated once",
    async (step, expected) => {
      setupApi(step);
      const { onCreated, onClose } = open();
      await fillCase({ piece: "1.75" });
      create();
      await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
      expect(calls).toEqual(expected); // nothing follows the failed step
      expect(mutateAsync).toHaveBeenCalledTimes(1); // the product exists and is not created twice
      expect(toastSpy).toHaveBeenCalledTimes(1); // the warning stands in for the success toast
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Product created, but its piece price wasn't saved. Set it on the product page.",
          variant: "warning",
        }),
      );
      expect(onClose).toHaveBeenCalledTimes(1);
    },
  );

  it("when the piece write AND the photo upload both fail, one combined warning replaces both", async () => {
    setupApi("units");
    (uploadProductImages as jest.Mock).mockRejectedValueOnce(new Error("500"));
    const { onCreated, onClose } = open();
    await fillCase({ piece: "1.75" });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File(["x"], "cola.png", { type: "image/png" })] },
    });
    create();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title:
          "Product created, but its piece price and photos weren't saved. Set them on the product page.",
        variant: "warning",
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a failed photo upload with a saved piece price still shows only the photos warning", async () => {
    (uploadProductImages as jest.Mock).mockRejectedValueOnce(new Error("500"));
    const { onCreated } = open();
    await fillCase({ piece: "1.75" });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File(["x"], "cola.png", { type: "image/png" })] },
    });
    create();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Product created, but its photos didn't upload" }),
    );
  });

  it("a double-click runs the chain once (B1244 holds), and Create stays busy for all of it", async () => {
    let release!: () => void;
    api.post.mockImplementation(async (url: string) => {
      calls.push(`POST ${url.replace("/products/p1", "/products/:id")}`);
      if (url.endsWith("/units")) await new Promise<void>((r) => (release = r));
      return { data: {} };
    });
    const { onCreated } = open();
    await fillCase({ piece: "1.75" });
    const btn = screen.getByRole("button", { name: "Create product" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(calls).toContain("POST /products/:id/units"));
    fireEvent.click(btn);
    release();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.endsWith("/units"))).toHaveLength(1);
  });
});

describe("K11-28: the draft keeps the piece price", () => {
  beforeEach(() =>
    (getStoredUser as jest.Mock).mockReturnValue({ id: "user-a", tenantSlug: "acme" }),
  );

  it("saves it with the other fields", async () => {
    open();
    await fillCase({ piece: "1.75" });
    await waitFor(
      () =>
        expect(JSON.parse(localStorage.getItem(draftKey()!)!).fields.pricePerPiece).toBe("1.75"),
      { timeout: DRAFT_SAVE_DELAY_MS + 2000 },
    );
  });

  it("restores it", async () => {
    const fields = {
      ...EMPTY_DRAFT_FORM,
      name: "Cola",
      unit: "case",
      unitsPerBox: "12",
      pricePerPiece: "1.75",
    };
    localStorage.setItem(draftKey()!, JSON.stringify({ v: 1, savedAt: Date.now(), fields }));
    open();
    await userEvent.click(screen.getByTestId("units-v2-restore-yes"));
    expect(pieceField()).toHaveValue(1.75);
  });

  it("an old draft without the key loads with the field empty", async () => {
    const { pricePerPiece: _drop, ...old } = {
      ...EMPTY_DRAFT_FORM,
      name: "Cola",
      unit: "case",
      unitsPerBox: "12",
    };
    void _drop;
    localStorage.setItem(draftKey()!, JSON.stringify({ v: 1, savedAt: Date.now(), fields: old }));
    open();
    await userEvent.click(screen.getByTestId("units-v2-restore-yes"));
    expect(screen.getByLabelText("Name *")).toHaveValue("Cola");
    expect(pieceField()).toHaveValue(null);
  });

  it("typing a piece price makes the dialog dirty, so Escape no longer closes it", async () => {
    const { onClose } = open();
    await fillCase({ piece: "1" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
