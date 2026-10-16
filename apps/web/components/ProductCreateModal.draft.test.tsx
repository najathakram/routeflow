import * as React from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test-utils/render";
import { ProductCreateModal } from "./ProductCreateModal";
import { draftKey, EMPTY_DRAFT_FORM, readDraft } from "./product-create/product-create-draft";

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
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn() } }));
jest.mock("./CategoryCombobox", () => ({ CategoryCombobox: () => <div /> }));
jest.mock("./SubcategoryCombobox", () => ({ SubcategoryCombobox: () => <div /> }));
jest.mock("./BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));

const BANNER = "units-v2-restore-banner";

function seed(fields: Partial<typeof EMPTY_DRAFT_FORM> = { name: "Cola", pricePerUnit: "12.00" }) {
  localStorage.setItem(
    draftKey(),
    JSON.stringify({ v: 1, savedAt: Date.now(), fields: { ...EMPTY_DRAFT_FORM, ...fields } }),
  );
}

function open(props: Partial<React.ComponentProps<typeof ProductCreateModal>> = {}) {
  return renderWithProviders(
    <ProductCreateModal isOpen onClose={jest.fn()} onCreated={jest.fn()} {...props} />,
  );
}

/** Make one Storage method throw for the draft key only (the auth provider reads storage too). */
function failOnDraftKey(method: "getItem" | "setItem") {
  const original = Storage.prototype[method] as (this: Storage, ...a: string[]) => unknown;
  return jest.spyOn(Storage.prototype, method).mockImplementation(function (
    this: Storage,
    ...args: string[]
  ) {
    if (String(args[0]).startsWith("routeflow:product-create-draft")) throw new Error("denied");
    return original.apply(this, args);
  } as never);
}

beforeEach(() => {
  localStorage.clear();
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue({ id: "p1", name: "Cola", unit: "box", pricePerUnit: "12.00" });
});

describe("ProductCreateModal draft + restore banner (V13)", () => {
  it("shows no banner when there is no saved draft", () => {
    open();
    expect(screen.queryByTestId(BANNER)).toBeNull();
  });

  it("has the banner in the very first render when a draft exists (no layout shift)", () => {
    seed();
    open();
    // Synchronous, no waitFor / findBy: the banner is decided before first paint.
    expect(screen.getByTestId(BANNER)).toBeInTheDocument();
  });

  it("Restore fills the form fields and removes the banner", async () => {
    seed({ name: "Cola", pricePerUnit: "12.00", unit: "box", unitsPerBox: "24" });
    open();
    await userEvent.click(screen.getByTestId("units-v2-restore-yes"));
    expect(screen.queryByTestId(BANNER)).toBeNull();
    expect(screen.getByLabelText("Name *")).toHaveValue("Cola");
    expect(screen.getByLabelText("Price per box *")).toHaveValue(12);
    expect(screen.getByLabelText("Units per box")).toHaveValue(24);
  });

  it("Start fresh deletes the draft and keeps the form blank", async () => {
    seed();
    open();
    await userEvent.click(screen.getByTestId("units-v2-restore-no"));
    expect(screen.queryByTestId(BANNER)).toBeNull();
    expect(localStorage.getItem(draftKey())).toBeNull();
    expect(screen.getByLabelText("Name *")).toHaveValue("");
  });

  it("is silent when storage throws", () => {
    const spy = failOnDraftKey("getItem");
    try {
      expect(() => open()).not.toThrow();
      expect(screen.queryByTestId(BANNER)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("does not offer a draft in the variant (family) mode", () => {
    seed();
    open({ defaultParentId: "parent-1" });
    expect(screen.queryByTestId(BANNER)).toBeNull();
  });

  it("does not offer a draft when the caller prefilled the form, and leaves it untouched", () => {
    seed();
    open({ initialName: "Scanned item" });
    expect(screen.queryByTestId(BANNER)).toBeNull();
    expect(readDraft(draftKey())).not.toBeNull();
  });

  describe("saving", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it("saves a draft about 500 ms after the user types, not on every keystroke", () => {
      open();
      fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "Cola" } });
      expect(readDraft(draftKey())).toBeNull();
      act(() => {
        jest.advanceTimersByTime(499);
      });
      expect(readDraft(draftKey())).toBeNull();
      act(() => {
        jest.advanceTimersByTime(2);
      });
      expect(readDraft(draftKey())?.fields.name).toBe("Cola");
    });

    it("saves nothing for a blank form", () => {
      open();
      act(() => {
        jest.advanceTimersByTime(2000);
      });
      expect(localStorage.getItem(draftKey())).toBeNull();
    });

    it("does not overwrite the saved draft while the banner waits for an answer", () => {
      seed({ name: "Old draft" });
      open();
      fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "Typed over it" } });
      act(() => {
        jest.advanceTimersByTime(2000);
      });
      expect(readDraft(draftKey())?.fields.name).toBe("Old draft");
    });

    it("never throws when saving fails", () => {
      const set = failOnDraftKey("setItem");
      try {
        open();
        fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "Cola" } });
        expect(() => {
          act(() => {
            jest.advanceTimersByTime(1000);
          });
        }).not.toThrow();
        expect(set).toHaveBeenCalled();
      } finally {
        set.mockRestore();
      }
    });
  });

  it("clears the draft once the product is created", async () => {
    seed({ name: "Cola", pricePerUnit: "12", unit: "box" });
    open();
    await userEvent.click(screen.getByTestId("units-v2-restore-yes"));
    // The restore re-arms the debounced save; wait for it so we prove create clears it.
    await waitFor(() => expect(readDraft(draftKey())?.fields.name).toBe("Cola"));
    fireEvent.click(screen.getByRole("button", { name: "Create Product" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    await waitFor(() => expect(localStorage.getItem(draftKey())).toBeNull());
  });
});
