import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ToastProvider } from "@routeflow/ui/web";
import { LadderEditor, type LadderEditorHandle } from "./LadderEditor";
import { LevelCodesFields } from "./LevelCodesFields";
import {
  blankRow,
  emptyDraft,
  type LadderDraft,
  type LadderRow,
  type MappedLadderError,
} from "@/lib/unit-ladder";

const UNITS = [
  { name: "Bottle", archived: false },
  { name: "Can", archived: false },
  { name: "Case", archived: false },
  { name: "Old Crate", archived: true },
  { name: "Pack", archived: false },
  { name: "Tray", archived: false },
];

let latest: LadderDraft;
function Harness({
  initial = emptyDraft(),
  serverError = null,
  showAllErrors = false,
  handle,
  packPrice = 24,
}: {
  initial?: LadderDraft;
  serverError?: MappedLadderError | null;
  showAllErrors?: boolean;
  handle?: React.Ref<LadderEditorHandle>;
  packPrice?: number | null;
}) {
  const [d, setD] = React.useState(initial);
  latest = d;
  return (
    <ToastProvider>
      <LadderEditor
        ref={handle}
        value={d}
        onChange={setD}
        tenantUnits={UNITS}
        packPrice={packPrice}
        serverError={serverError}
        showAllErrors={showAllErrors}
      />
    </ToastProvider>
  );
}
const row = (
  label: string,
  perParent: string,
  parentLabel: string,
  extra: Partial<LadderRow> = {},
) => ({
  ...blankRow(label, parentLabel),
  perParent,
  ...extra,
});
const bottleLadder = (): LadderDraft => ({
  ...emptyDraft(),
  baseLabel: "Bottle",
  rows: [row("Pack", "6", "Bottle"), row("Case", "4", "Pack")],
  packLevel: "Case",
});
const pick = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("LadderEditor", () => {
  it("is a named group with the Manage units link opening a new tab safely", () => {
    render(<Harness />);
    expect(screen.getByRole("group", { name: "How is this sold?" })).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Manage units" });
    expect(link).toHaveAttribute("href", "/settings/units");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener");
  });

  it("smallest unit: Piece first (default), active tenant units A-Z, archived not offered, plus Add new unit...", () => {
    render(<Harness />);
    const opts = within(screen.getByLabelText("Smallest unit"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(opts).toEqual(["Piece", "Bottle", "Can", "Case", "Pack", "Tray", "Add new unit..."]);
    expect(screen.getByText("What one item is called, like Bottle or Can.")).toBeInTheDocument();
  });

  it("a new row's left defaults to the base, then to the previous row's right; the number input is focused", () => {
    render(<Harness initial={{ ...emptyDraft(), baseLabel: "Bottle" }} />);
    fireEvent.click(screen.getByRole("button", { name: "+ Add a bigger unit" }));
    const level1 = screen.getByRole("group", { name: "Level 1" });
    expect((within(level1).getByLabelText("Level 1 made of") as HTMLSelectElement).value).toBe(
      "Bottle",
    );
    expect(within(level1).getByLabelText("How many Bottles in one unit")).toHaveFocus();
    pick("Level 1 unit", "Pack");
    fireEvent.click(screen.getByRole("button", { name: "+ Add a bigger unit" }));
    const level2 = screen.getByRole("group", { name: "Level 2" });
    expect((within(level2).getByLabelText("Level 2 made of") as HTMLSelectElement).value).toBe(
      "Pack",
    );
  });

  it("the chain updates the live summary (status region) and the number input names both units", () => {
    render(<Harness initial={{ ...emptyDraft(), baseLabel: "Bottle" }} />);
    fireEvent.click(screen.getByRole("button", { name: "+ Add a bigger unit" }));
    pick("Level 1 unit", "Pack");
    fireEvent.change(screen.getByLabelText("How many Bottles in one Pack"), {
      target: { value: "6" },
    });
    fireEvent.click(screen.getByRole("button", { name: "+ Add a bigger unit" }));
    pick("Level 2 unit", "Case");
    fireEvent.change(screen.getByLabelText("How many Packs in one Case"), {
      target: { value: "4" },
    });
    expect(screen.getByRole("status")).toHaveTextContent("1 Case = 4 Packs = 24 Bottles");
  });

  it("right-hand choices exclude the base and units already in the ladder", () => {
    render(<Harness initial={{ ...bottleLadder(), packLevel: null }} />);
    const opts = within(screen.getByLabelText("Level 1 unit"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(opts).toEqual(["Can", "Pack", "Tray", "Add new unit..."]);
    expect(opts).not.toContain("Bottle");
    expect(opts).not.toContain("Case");
  });

  describe("Add new unit...", () => {
    const start = () => {
      render(
        <Harness
          initial={{ ...emptyDraft(), baseLabel: "Bottle", rows: [row("", "", "Bottle")] }}
        />,
      );
    };

    it("shows a text field with Add and Cancel; Add keeps it in newUnits once and shows 'Crate (new)'", () => {
      start();
      pick("Level 1 unit", "__add_new_unit__");
      fireEvent.change(screen.getByLabelText("Level 1 unit: new unit name"), {
        target: { value: " Crate " },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      expect(latest.newUnits).toEqual(["Crate"]);
      expect(latest.rows[0].label).toBe("Crate");
      const opt = within(screen.getByLabelText("Level 1 unit")).getByRole("option", {
        name: "Crate (new)",
      });
      expect(opt).toBeInTheDocument();
      // the smallest-unit select offers it too
      expect(
        within(screen.getByLabelText("Smallest unit")).getByRole("option", { name: "Crate (new)" }),
      ).toBeInTheDocument();
    });

    it("Cancel adds nothing and returns to the select", () => {
      start();
      pick("Level 1 unit", "__add_new_unit__");
      fireEvent.change(screen.getByLabelText("Level 1 unit: new unit name"), {
        target: { value: "Crate" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(latest.newUnits).toEqual([]);
      expect(screen.getByLabelText("Level 1 unit")).toBeInTheDocument();
    });

    it.each([
      ["", "Enter a name."],
      ["x".repeat(31), "Keep it to 30 characters or fewer."],
      ["case", "You already have a unit called Case."],
    ])("name %p -> %s", (name, msg) => {
      start();
      pick("Level 1 unit", "__add_new_unit__");
      fireEvent.change(screen.getByLabelText("Level 1 unit: new unit name"), {
        target: { value: name },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      expect(screen.getByText(msg)).toBeInTheDocument();
      expect(latest.newUnits).toEqual([]);
    });
  });

  describe("inline validation (field-level, input kept)", () => {
    const withRow = (r: LadderRow, more: LadderRow[] = []) =>
      render(
        <Harness
          showAllErrors
          initial={{ ...emptyDraft(), baseLabel: "Bottle", rows: [r, ...more] }}
        />,
      );

    it.each([
      ["", "Enter a whole number, 2 or more."],
      ["1", "Enter a whole number, 2 or more."],
    ])("number %p", (n, msg) => {
      withRow(row("Pack", n, "Bottle"));
      expect(screen.getByRole("alert")).toHaveTextContent(msg);
      expect(screen.getByLabelText("How many Bottles in one Pack")).toHaveAttribute(
        "aria-invalid",
        "true",
      );
    });

    it("over the cap, same unit twice, same size twice", () => {
      const { unmount } = withRow(row("Pack", "1000", "Bottle"), [row("Pallet", "1001", "Pack")]);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "That's more than 1,000,000 Bottles in one Pallet. Check the numbers.",
      );
      unmount();
      const second = withRow(row("Pack", "6", "Bottle"), [row("Pack", "4", "Bottle")]);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Pack is already in this ladder. Use each unit once.",
      );
      second.unmount();
      withRow(row("Pack", "6", "Bottle"), [row("Tray", "6", "Bottle")]);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Pack and Tray would both hold 6 Bottles. Change one.",
      );
    });

    it("an untouched blank row shows no error until Save is tried", () => {
      render(
        <Harness
          initial={{ ...emptyDraft(), baseLabel: "Bottle", rows: [row("", "", "Bottle")] }}
        />,
      );
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("focusFirstError focuses the first invalid number", () => {
      const ref = React.createRef<LadderEditorHandle>();
      render(
        <Harness
          handle={ref}
          showAllErrors
          initial={{
            ...emptyDraft(),
            baseLabel: "Bottle",
            rows: [row("Pack", "6", "Bottle"), row("Case", "", "Pack")],
          }}
        />,
      );
      ref.current?.focusFirstError();
      expect(screen.getByLabelText("How many Packs in one Case")).toHaveFocus();
    });
  });

  describe("server errors under the row", () => {
    const text =
      '"Pack" is already used on an order or invoice at a different size, so its size cannot change. Create a new unit instead.';
    it("shows the used-size text verbatim and 'Add a new unit instead' keeps the row but clears the name", () => {
      const onDismiss = jest.fn();
      render(
        <ToastProvider>
          <LadderEditor
            value={{ ...emptyDraft(), baseLabel: "Bottle", rows: [row("Pack", "8", "Bottle")] }}
            onChange={() => {}}
            tenantUnits={UNITS}
            packPrice={24}
            serverError={{
              rowLabel: "Pack",
              field: "perParent",
              message: text,
              offerNewUnit: true,
            }}
            onDismissServerError={onDismiss}
          />
        </ToastProvider>,
      );
      expect(screen.getByText(text)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Add a new unit instead" }));
      expect(onDismiss).toHaveBeenCalled();
    });
    it("clearing the name keeps the row and its number", () => {
      render(
        <Harness
          serverError={{ rowLabel: "Pack", message: text, offerNewUnit: true }}
          initial={{ ...emptyDraft(), baseLabel: "Bottle", rows: [row("Pack", "8", "Bottle")] }}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Add a new unit instead" }));
      expect(latest.rows).toHaveLength(1);
      expect(latest.rows[0].label).toBe("");
      expect(latest.rows[0].perParent).toBe("8");
    });
  });

  describe("pack picker and prices", () => {
    it("'Price is for one' lists the base and each level, and explains itself", () => {
      render(<Harness initial={bottleLadder()} />);
      const opts = within(screen.getByLabelText("Price is for one"))
        .getAllByRole("option")
        .map((o) => o.textContent);
      expect(opts).toEqual(["Bottle", "Pack", "Case"]);
      expect(
        screen.getByText("The price above is for one Case. Other units are worked out from it."),
      ).toBeInTheDocument();
    });

    it("no levels -> no pack picker", () => {
      render(<Harness />);
      expect(screen.queryByLabelText("Price is for one")).toBeNull();
    });

    it("derived prices are grey placeholders; typing one overrides; the hint and radios are verbatim", () => {
      render(<Harness initial={bottleLadder()} packPrice={24} />);
      expect((screen.getByLabelText("Bottle price") as HTMLInputElement).placeholder).toBe("$1.00");
      expect((screen.getByLabelText("Pack price") as HTMLInputElement).placeholder).toBe("$6.00");
      fireEvent.change(screen.getByLabelText("Pack price"), { target: { value: "7" } });
      expect(latest.rows[0].price).toBe("7");
      expect(
        screen.getByText(
          "A grey price is worked out from the Case price. Type a price to use your own.",
        ),
      ).toBeInTheDocument();
      expect(screen.getAllByLabelText("Pre-selected on staff orders").length).toBeGreaterThan(0);
    });

    it("picking a default unit selects exactly one radio", () => {
      render(<Harness initial={bottleLadder()} />);
      const radios = screen.getAllByRole("radio");
      fireEvent.click(radios[1]);
      expect(latest.rows.filter((r) => r.isDefault).map((r) => r.label)).toEqual(["Pack"]);
      expect(latest.baseIsDefault).toBe(false);
    });
  });

  describe("Remove", () => {
    it("an unsaved row goes at once, with the rows built on it", () => {
      render(<Harness initial={bottleLadder()} />);
      fireEvent.click(
        within(screen.getByRole("group", { name: "Level 1" })).getByRole("button", {
          name: "Remove",
        }),
      );
      expect(latest.rows).toHaveLength(0);
      expect(latest.packLevel).toBeNull();
    });

    it("a saved row asks first, with the existing wording", async () => {
      const d = bottleLadder();
      d.rows[1] = { ...d.rows[1], id: "saved-1" };
      render(<Harness initial={d} />);
      fireEvent.click(
        within(screen.getByRole("group", { name: "Level 2" })).getByRole("button", {
          name: "Remove",
        }),
      );
      expect(await screen.findByText("Remove Case?")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Its prices are deleted. Existing orders and invoices keep what they charged.",
        ),
      ).toBeInTheDocument();
      expect(latest.rows).toHaveLength(2);
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
      expect(latest.rows).toHaveLength(1);
    });
  });

  it("the per-level codes toggle is absent while LEVEL_CODES_UI_ENABLED is false", () => {
    render(<Harness initial={bottleLadder()} />);
    expect(screen.queryByRole("button", { name: "Different barcode or SKU" })).toBeNull();
    expect(screen.queryByText(/Barcode and SKU: same as/)).toBeNull();
  });
});

describe("LevelCodesFields (built, hidden until U-8)", () => {
  const r = (over: Partial<LadderRow> = {}) => ({ ...row("Pack", "6", "Bottle"), ...over });
  const mount = (row: LadderRow, onChange = jest.fn()) =>
    render(
      <ToastProvider>
        <LevelCodesFields
          row={row}
          fallbackName="Bottle"
          packName="Case"
          idPrefix="x"
          onChange={onChange}
        />
      </ToastProvider>,
    );

  it("says 'same as Bottle' with a collapsed disclosure; opening shows Barcode and SKU and the helper", () => {
    mount(r());
    expect(screen.getByText(/Barcode and SKU: same as Bottle\./)).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Different barcode or SKU" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(btn).toHaveAttribute("aria-controls", "x-codes");
    fireEvent.click(btn);
    expect(screen.getByLabelText("Barcode")).toBeInTheDocument();
    expect(screen.getByLabelText("SKU")).toBeInTheDocument();
    expect(screen.getByText("Leave a field blank to use Bottle's.")).toBeInTheDocument();
  });

  it("pre-opens only when the level differs, and 'Use Case's instead' clears both", () => {
    const onChange = jest.fn();
    mount(r({ barcode: "123", sku: "A-1" }), onChange);
    expect(screen.getByLabelText("Barcode")).toHaveValue("123");
    fireEvent.click(screen.getByRole("button", { name: "Use Case's instead" }));
    expect(onChange).toHaveBeenCalledWith({ barcode: "", sku: "" });
  });

  it("refuses 65 characters with the 64-character copy", () => {
    mount(r({ sku: "a".repeat(65) }));
    expect(screen.getByText("Keep it to 64 characters or fewer.")).toBeInTheDocument();
  });
});
