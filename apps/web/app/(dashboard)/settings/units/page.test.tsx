import * as React from "react";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import UnitsPage from "./page";

const toast = jest.fn();
const createMutate = jest.fn();
const updateMutate = jest.fn();
const refetch = jest.fn();
let state: { data?: unknown[]; isLoading: boolean; isError: boolean } = {
  data: [],
  isLoading: false,
  isError: false,
};

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/tenant-units", () => ({
  ...jest.requireActual("@/lib/api/tenant-units"),
  useTenantUnits: () => ({ ...state, refetch }),
  useCreateTenantUnit: () => ({ mutate: createMutate, isPending: false }),
  useUpdateTenantUnit: () => ({ mutate: updateMutate, isPending: false }),
}));

const u = (name: string, productCount = 0, archivedAt: string | null = null) => ({
  id: `id-${name}`,
  name,
  productCount,
  archivedAt,
});
const setUnits = (...units: ReturnType<typeof u>[]) => {
  state = { data: units, isLoading: false, isError: false };
};
const render = () => renderWithProviders(<UnitsPage />);
const row = (name: string) => screen.getByText(name, { selector: "li *" }).closest("li")!;
const addField = () => screen.getByLabelText("Unit name") as HTMLInputElement;
const toastTitles = () => toast.mock.calls.map(([t]) => t.title);
const setOnline = (online: boolean) => {
  Object.defineProperty(window.navigator, "onLine", { value: online, configurable: true });
  act(() => {
    window.dispatchEvent(new Event(online ? "online" : "offline"));
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  setUnits();
  setOnline(true);
});

describe("Units page: load states", () => {
  it("shows 5 skeleton rows while loading", () => {
    state = { isLoading: true, isError: false };
    render();
    expect(screen.getAllByTestId("units-skeleton-row")).toHaveLength(5);
  });

  it("a load error says so, never 'No units yet', and Retry refetches", () => {
    state = { isLoading: false, isError: true };
    render();
    expect(screen.getByText("Couldn't load your units. Try again")).toBeInTheDocument();
    expect(screen.queryByText("No units yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("the empty state explains itself, shows chips expanded and focuses the add field", () => {
    render();
    expect(screen.getByRole("heading", { name: "No units yet" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Add the words you sell and stock by, like Case, Box or Bottle. Products without units keep selling by the piece.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Case" })).toBeInTheDocument();
    expect(addField()).toHaveFocus();
  });

  it("shows the heading, the sub line and the Piece note", () => {
    setUnits(u("Case", 12));
    render();
    expect(screen.getByRole("heading", { name: "Units" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "The names you sell and stock by, like Case, Box or Bottle. Products pick from this list.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Piece is always there as the smallest unit.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Units are archived, never deleted, so old orders and invoices keep their words.",
      ),
    ).toBeInTheDocument();
  });
});

describe("Units page: list", () => {
  it("shows 'Used by N products', singular, and 'Not used yet'", () => {
    setUnits(u("Case", 12), u("Box", 1), u("Pallet", 0));
    render();
    expect(within(row("Case")).getByText("Used by 12 products")).toBeInTheDocument();
    expect(within(row("Box")).getByText("Used by 1 product")).toBeInTheDocument();
    expect(within(row("Pallet")).getByText("Not used yet")).toBeInTheDocument();
  });

  it("has NO Delete or Remove control anywhere", () => {
    setUnits(u("Case", 12), u("Pallet", 0, "2026-10-01T00:00:00Z"));
    render();
    fireEvent.click(screen.getByRole("button", { name: /^Archived \(1\)/ }));
    expect(screen.queryByRole("button", { name: /delete|remove/i })).toBeNull();
    expect(screen.queryByText(/delete/i, { selector: "button *" })).toBeNull();
  });

  it("search appears only above 8 units, filters, and a miss offers to add it", () => {
    setUnits(
      u("Case"),
      u("Box"),
      u("Pack"),
      u("Bag"),
      u("Dozen"),
      u("Tray"),
      u("Pallet"),
      u("Can"),
    );
    const { unmount } = render();
    expect(screen.queryByPlaceholderText("Search units")).toBeNull();
    unmount();
    setUnits(
      u("Case"),
      u("Box"),
      u("Pack"),
      u("Bag"),
      u("Dozen"),
      u("Tray"),
      u("Pallet"),
      u("Can"),
      u("Gift Box"),
    );
    render();
    const search = screen.getByPlaceholderText("Search units");
    fireEvent.change(search, { target: { value: "gift" } });
    expect(screen.getByText("Gift Box")).toBeInTheDocument();
    expect(screen.queryByText("Pallet")).toBeNull();
    fireEvent.change(search, { target: { value: "bot" } });
    expect(screen.getByText('No unit named "bot". Add it?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: 'Add "bot"' }));
    expect(createMutate).toHaveBeenCalledWith({ name: "Bot" }, expect.anything());
  });
});

describe("Units page: add", () => {
  it("Enter and the Add button both create; a lowercase name is Title-cased, '12pk' is left alone", () => {
    setUnits(u("Box"));
    render();
    fireEvent.change(addField(), { target: { value: "case" } });
    fireEvent.keyDown(addField(), { key: "Enter" });
    fireEvent.submit(addField().closest("form")!);
    expect(createMutate).toHaveBeenLastCalledWith({ name: "Case" }, expect.anything());
    fireEvent.change(addField(), { target: { value: "12pk" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(createMutate).toHaveBeenLastCalledWith({ name: "12pk" }, expect.anything());
    fireEvent.change(addField(), { target: { value: "  Bundle  " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(createMutate).toHaveBeenLastCalledWith({ name: "Bundle" }, expect.anything());
  });

  it("on success clears the field, toasts 'Added X' and returns focus to the field", () => {
    setUnits(u("Box"));
    createMutate.mockImplementation((_v, o) => o.onSuccess(u("Case")));
    render();
    fireEvent.change(addField(), { target: { value: "case" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(toastTitles()).toContain("Added Case");
    expect(addField().value).toBe("");
    expect(addField()).toHaveFocus();
  });

  it("empty, too long and duplicate show the exact inline message, keep the input, and call nothing", () => {
    setUnits(u("Case"));
    render();
    const add = () => fireEvent.click(screen.getByRole("button", { name: "Add" }));
    add();
    expect(screen.getByText("Enter a name.")).toBeInTheDocument();
    expect(addField()).toHaveAttribute("aria-invalid", "true");
    expect(addField().getAttribute("aria-describedby")).toBeTruthy();

    fireEvent.change(addField(), { target: { value: "x".repeat(31) } });
    add();
    expect(screen.getByText("Keep it to 30 characters or fewer.")).toBeInTheDocument();
    expect(addField().value).toBe("x".repeat(31));

    fireEvent.change(addField(), { target: { value: "case" } });
    add();
    expect(screen.getByText("You already have a unit called Case.")).toBeInTheDocument();
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("R4: adding an ARCHIVED name restores it: the add succeeds and toasts 'Restored X.'", () => {
    setUnits(u("Case"), u("Pallet", 3, "2026-10-01T00:00:00Z"));
    createMutate.mockImplementation((_v, o) => o.onSuccess(u("Pallet", 3)));
    render();
    fireEvent.change(addField(), { target: { value: "pallet" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(createMutate).toHaveBeenCalledWith({ name: "Pallet" }, expect.anything());
    expect(toastTitles()).toContain("Restored Pallet.");
    expect(screen.queryByText(/is archived\. Restore it instead/)).toBeNull();
  });

  it("a server failure shows the fixed sentence inline, keeps the input, and adds no second toast", () => {
    setUnits(u("Box"));
    createMutate.mockImplementation((_v, o) => o.onError({ response: { status: 500, data: {} } }));
    render();
    fireEvent.change(addField(), { target: { value: "Case" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(
      screen.getByText("Couldn't save. Your change is still here. Try again."),
    ).toBeInTheDocument();
    expect(addField().value).toBe("Case");
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("Units page: common unit chips", () => {
  it("a chip adds exactly that name, toasts 'Added X', and disappears once it is in the list", () => {
    setUnits(u("Box"));
    createMutate.mockImplementation((_v, o) => o.onSuccess(u("Case")));
    const { rerender } = render();
    expect(screen.queryByRole("button", { name: "Add Box" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add Case" }));
    expect(createMutate).toHaveBeenCalledWith({ name: "Case" }, expect.anything());
    expect(toastTitles()).toContain("Added Case");
    setUnits(u("Box"), u("Case"));
    rerender(<UnitsPage />);
    expect(screen.queryByRole("button", { name: "Add Case" })).toBeNull();
  });

  it("offers the chip subset only: no Piece synonyms and no measures until More", () => {
    setUnits(u("Box"));
    render();
    for (const n of ["Case", "Pack", "Bag", "Dozen", "Tray", "Pallet", "Bottle", "Can"]) {
      expect(screen.getByRole("button", { name: `Add ${n}` })).toBeInTheDocument();
    }
    for (const n of ["each", "unit", "pcs", "Each", "Unit", "kg", "lb", "ml", "L"]) {
      expect(screen.queryByRole("button", { name: `Add ${n}` })).toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("button", { name: "Add kg" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add each" })).toBeNull();
  });

  it("with 8 or more active units the chips collapse into a 'Common units' disclosure", () => {
    setUnits(u("A1"), u("A2"), u("A3"), u("A4"), u("A5"), u("A6"), u("A7"), u("A8"));
    render();
    const disclosure = screen.getByRole("button", { name: "Common units" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Add Case" })).toBeNull();
    fireEvent.click(disclosure);
    expect(screen.getByRole("button", { name: "Add Case" })).toBeInTheDocument();
  });
});

describe("Units page: rename", () => {
  it("shows 'Updates N products' while renaming, with the old-lines promise", () => {
    setUnits(u("Case", 12));
    render();
    fireEvent.click(within(row("Case")).getByRole("button", { name: "Rename" }));
    const field = screen.getByLabelText("Rename Case") as HTMLInputElement;
    expect(field).toHaveFocus();
    expect(
      screen.getByText(
        "Updates 12 products. Orders and invoices already created keep the old name.",
      ),
    ).toBeInTheDocument();
  });

  it("zero products says so; one product is singular", () => {
    setUnits(u("Case", 0), u("Box", 1));
    render();
    fireEvent.click(within(row("Case")).getByRole("button", { name: "Rename" }));
    expect(screen.getByText("Not used by any product yet.")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("Rename Case"), { key: "Escape" });
    fireEvent.click(within(row("Box")).getByRole("button", { name: "Rename" }));
    expect(screen.getByText(/^Updates 1 product\./)).toBeInTheDocument();
  });

  it("Esc cancels with no call; Enter saves the new name", () => {
    setUnits(u("Case", 2));
    render();
    fireEvent.click(within(row("Case")).getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Rename Case"), { target: { value: "Carton" } });
    fireEvent.keyDown(screen.getByLabelText("Rename Case"), { key: "Escape" });
    expect(updateMutate).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Rename Case")).toBeNull();

    fireEvent.click(within(row("Case")).getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Rename Case"), { target: { value: "Carton" } });
    fireEvent.keyDown(screen.getByLabelText("Rename Case"), { key: "Enter" });
    expect(updateMutate).toHaveBeenCalledWith({ id: "id-Case", name: "Carton" }, expect.anything());
  });

  it("a rename collision shows the product names inline and keeps the field open", () => {
    setUnits(u("Case", 2));
    updateMutate.mockImplementation((_v, o) =>
      o.onError({
        response: {
          status: 409,
          data: {
            code: "UNIT_RENAME_COLLISION",
            products: [
              { id: "1", name: "Gift Box" },
              { id: "2", name: "Mini Gift Box" },
            ],
          },
        },
      }),
    );
    render();
    fireEvent.click(within(row("Case")).getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Rename Case"), { target: { value: "Carton" } });
    fireEvent.keyDown(screen.getByLabelText("Rename Case"), { key: "Enter" });
    expect(
      screen.getByText(
        "Can't rename to Carton. Gift Box and Mini Gift Box already have a Carton. Change those first.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Rename Case")).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });

  it("a name already in the list is refused client-side", () => {
    setUnits(u("Case", 2), u("Box"));
    render();
    fireEvent.click(within(row("Case")).getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Rename Case"), { target: { value: "box" } });
    fireEvent.keyDown(screen.getByLabelText("Rename Case"), { key: "Enter" });
    expect(screen.getByText("You already have a unit called Box.")).toBeInTheDocument();
    expect(updateMutate).not.toHaveBeenCalled();
  });
});

describe("Units page: archive and restore", () => {
  it("an unused unit archives at once, toasts 'Archived X.' with an Undo that restores it", () => {
    setUnits(u("Pallet", 0));
    updateMutate.mockImplementation((_v, o) =>
      o.onSuccess({ unit: u("Pallet"), productsUpdated: 0 }),
    );
    render();
    fireEvent.click(within(row("Pallet")).getByRole("button", { name: "Archive" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(updateMutate).toHaveBeenCalledWith(
      { id: "id-Pallet", archived: true },
      expect.anything(),
    );
    const t = toast.mock.calls.map(([x]) => x).find((x) => x.title === "Archived Pallet.");
    expect(t).toBeTruthy();
    expect(t.duration).toBe(6000);
    expect(t.action.label).toBe("Undo");
    t.action.onClick();
    expect(updateMutate).toHaveBeenLastCalledWith(
      { id: "id-Pallet", archived: false },
      expect.anything(),
    );
  });

  it("a used unit asks first: Cancel has focus, the confirm is primary (not red), Cancel changes nothing", () => {
    setUnits(u("Bottle", 40));
    render();
    fireEvent.click(within(row("Bottle")).getByRole("button", { name: "Archive" }));
    const dialog = screen.getByRole("dialog", { name: "Archive Bottle?" });
    expect(
      within(dialog).getByText(
        "40 products use it. They keep it and it still shows on their orders. You won't see it when you pick a unit for a new product. You can restore it any time.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "Archive" }).className).not.toMatch(
      /danger|red/,
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(updateMutate).not.toHaveBeenCalled();
    fireEvent.click(within(row("Bottle")).getByRole("button", { name: "Archive" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Archive" }));
    expect(updateMutate).toHaveBeenCalledWith(
      { id: "id-Bottle", archived: true },
      expect.anything(),
    );
  });

  it("archived units sit in a collapsed disclosure; Restore is one click and toasts", () => {
    setUnits(
      u("Case", 1),
      u("Pallet", 3, "2026-10-01T00:00:00Z"),
      u("Tray", 0, "2026-10-01T00:00:00Z"),
    );
    updateMutate.mockImplementation((_v, o) =>
      o.onSuccess({ unit: u("Pallet", 3), productsUpdated: 0 }),
    );
    render();
    const disclosure = screen.getByRole("button", { name: /^Archived \(2\)/ });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Pallet")).toBeNull();
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(disclosure.getAttribute("aria-controls")).toBeTruthy();
    expect(within(row("Pallet")).getByText("Used by 3 products")).toBeInTheDocument();
    fireEvent.click(within(row("Pallet")).getByRole("button", { name: "Restore" }));
    expect(updateMutate).toHaveBeenCalledWith(
      { id: "id-Pallet", archived: false },
      expect.anything(),
    );
    expect(toastTitles()).toContain("Restored Pallet.");
  });
});

describe("Units page: offline and the small-screen sheet", () => {
  it("offline disables Add, Rename and Archive and says why", () => {
    setUnits(u("Case", 1));
    render();
    setOnline(false);
    expect(screen.getByText("You're offline. Reconnect to change units.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(within(row("Case")).getByRole("button", { name: "Rename" })).toBeDisabled();
    expect(within(row("Case")).getByRole("button", { name: "Archive" })).toBeDisabled();
    setOnline(true);
    expect(screen.queryByText("You're offline. Reconnect to change units.")).toBeNull();
  });

  it("the Edit button opens a named sheet with Rename and Archive", () => {
    setUnits(u("Case", 12));
    render();
    fireEvent.click(within(row("Case")).getByRole("button", { name: "Edit Case" }));
    const sheet = screen.getByRole("dialog", { name: "Edit Case" });
    fireEvent.change(within(sheet).getByLabelText("Rename Case"), { target: { value: "Carton" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(updateMutate).toHaveBeenCalledWith({ id: "id-Case", name: "Carton" }, expect.anything());
    expect(within(sheet).getByRole("button", { name: "Archive" })).toBeInTheDocument();
  });
});
