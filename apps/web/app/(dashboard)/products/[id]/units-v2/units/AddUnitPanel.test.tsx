import * as React from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddUnitPanel } from "./AddUnitPanel";

const mutate = jest.fn();
let pending = false;

jest.mock("@/lib/api/product-units", () => ({
  useCreateProductUnit: () => ({ mutate, isPending: pending }),
}));

const OF = [
  { label: "Pack", factorToBase: 6 },
  { label: "Case", factorToBase: 24 },
];

function setup(props: Partial<React.ComponentProps<typeof AddUnitPanel>> = {}) {
  return render(<AddUnitPanel productId="p1" baseLabel="Piece" ofUnits={OF} {...props} />);
}

const opener = () => screen.getByTestId("units-v2-add-open");
const panel = () => screen.queryByTestId("units-v2-add-panel");

beforeEach(() => {
  mutate.mockReset();
  pending = false;
});

describe("AddUnitPanel (V15, V17)", () => {
  it("starts closed with a single 'Add a unit' button", () => {
    setup();
    expect(opener()).toHaveTextContent("Add a unit");
    expect(opener()).toHaveAttribute("aria-expanded", "false");
    expect(panel()).toBeNull();
  });

  it("opens the panel and hides the opener while it is open", async () => {
    setup();
    await userEvent.click(opener());
    expect(panel()).toBeInTheDocument();
    expect(opener()).not.toBeVisible();
    expect(screen.getByTestId("units-v2-add-name")).toHaveFocus();
  });

  it("Cancel closes the panel, shows the opener again and focuses it", async () => {
    setup();
    await userEvent.click(opener());
    await userEvent.click(screen.getByTestId("units-v2-add-cancel"));
    expect(panel()).toBeNull();
    expect(opener()).toBeVisible();
    expect(opener()).toHaveFocus();
  });

  it("Escape closes the panel and returns focus to the opener", async () => {
    setup();
    await userEvent.click(opener());
    await userEvent.type(screen.getByTestId("units-v2-add-name"), "Case");
    await userEvent.keyboard("{Escape}");
    expect(panel()).toBeNull();
    expect(opener()).toBeVisible();
    expect(opener()).toHaveFocus();
  });

  it("a second activation of the opener toggles the panel shut", async () => {
    setup();
    await userEvent.click(opener());
    // The opener is hidden while open, so a keyboard shortcut or script that fires it still toggles.
    act(() => opener().click());
    expect(panel()).toBeNull();
  });

  it("keeps Add unit disabled until there is a name and a count", async () => {
    setup();
    await userEvent.click(opener());
    const submit = screen.getByTestId("units-v2-add-submit");
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByTestId("units-v2-add-name"), "Box");
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByTestId("units-v2-add-n"), "12");
    expect(submit).toBeEnabled();
  });

  it("offers the base unit first, then the existing units, in 'n of'", async () => {
    setup();
    await userEvent.click(opener());
    const options = Array.from(
      (screen.getByTestId("units-v2-add-of") as HTMLSelectElement).options,
    ).map((o) => o.textContent);
    expect(options).toEqual(["Piece", "Pack", "Case"]);
  });

  it("posts label and factorToBase (n times the unit it contains)", async () => {
    setup();
    await userEvent.click(opener());
    await userEvent.type(screen.getByTestId("units-v2-add-name"), "  Pallet ");
    await userEvent.type(screen.getByTestId("units-v2-add-n"), "10");
    await userEvent.selectOptions(screen.getByTestId("units-v2-add-of"), "Case");
    await userEvent.click(screen.getByTestId("units-v2-add-submit"));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({ label: "Pallet", factorToBase: 240 });
  });

  it("closes and refocuses the opener after a successful add", async () => {
    mutate.mockImplementation((_body, opts) => opts.onSuccess?.());
    const onAdded = jest.fn();
    setup({ onAdded });
    await userEvent.click(opener());
    await userEvent.type(screen.getByTestId("units-v2-add-name"), "Box");
    await userEvent.type(screen.getByTestId("units-v2-add-n"), "12");
    await userEvent.click(screen.getByTestId("units-v2-add-submit"));
    expect(panel()).toBeNull();
    expect(opener()).toHaveFocus();
    expect(onAdded).toHaveBeenCalledTimes(1);
  });

  it("shows the server's refusal in the error line and keeps the panel open", async () => {
    mutate.mockImplementation((_body, opts) =>
      opts.onError?.({
        response: { status: 409, data: { message: "That unit name is already used." } },
      }),
    );
    setup();
    await userEvent.click(opener());
    await userEvent.type(screen.getByTestId("units-v2-add-name"), "Case");
    await userEvent.type(screen.getByTestId("units-v2-add-n"), "12");
    await userEvent.click(screen.getByTestId("units-v2-add-submit"));
    expect(screen.getByTestId("units-v2-add-err")).toHaveTextContent(
      "That unit name is already used.",
    );
    expect(screen.getByTestId("units-v2-add-err")).toHaveAttribute("role", "alert");
    expect(panel()).toBeInTheDocument();
  });

  it("is disabled, with a hint, while the price draft has unsaved changes", () => {
    setup({ dirty: true });
    expect(opener()).toBeDisabled();
    expect(screen.getByText("Save or discard your price changes first")).toBeInTheDocument();
  });

  it("is disabled without a hint when disabled for another reason", () => {
    setup({ disabled: true });
    expect(opener()).toBeDisabled();
    expect(screen.queryByText("Save or discard your price changes first")).toBeNull();
  });

  it("closes an open panel if the draft becomes dirty", async () => {
    const { rerender } = setup();
    await userEvent.click(opener());
    rerender(<AddUnitPanel productId="p1" baseLabel="Piece" ofUnits={OF} dirty />);
    expect(panel()).toBeNull();
    expect(opener()).toBeDisabled();
  });

  it("uses no em or en dashes in its copy", async () => {
    const { container } = setup();
    await userEvent.click(opener());
    expect(container.textContent).not.toMatch(/[–—]/);
  });
});

describe("AddUnitPanel a11y (K10d)", () => {
  it("the form is labelled by its own heading", async () => {
    setup();
    await userEvent.click(opener());
    const form = screen.getByRole("form", { name: "Add a unit" });
    expect(form).toBe(screen.getByTestId("units-v2-add-panel"));
    const headingId = form.getAttribute("aria-labelledby");
    expect(headingId).toBeTruthy();
    expect(document.getElementById(headingId!)).toHaveTextContent("Add a unit");
  });
});

describe("AddUnitPanel optional price (K10d)", () => {
  const fill = async (name = "Box", n = "12") => {
    await userEvent.click(opener());
    await userEvent.type(screen.getByTestId("units-v2-add-name"), name);
    await userEvent.type(screen.getByTestId("units-v2-add-n"), n);
  };
  const validatePrice = (t: string) => (t.trim() === "bad" ? "Enter a price like 12.50." : null);

  it("has no price field unless the caller can validate one", async () => {
    setup();
    await userEvent.click(opener());
    expect(screen.queryByTestId("units-v2-add-price")).toBeNull();
  });

  it("shows a 'Price (optional)' field when the caller passes a validator", async () => {
    setup({ validatePrice });
    await userEvent.click(opener());
    expect(screen.getByLabelText("Price (optional)")).toBe(
      screen.getByTestId("units-v2-add-price"),
    );
  });

  it("refuses an invalid price in the panel and creates no unit", async () => {
    setup({ validatePrice });
    await fill();
    await userEvent.type(screen.getByTestId("units-v2-add-price"), "bad");
    await userEvent.click(screen.getByTestId("units-v2-add-submit"));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByTestId("units-v2-add-err")).toHaveTextContent("Enter a price like 12.50.");
    expect(panel()).toBeInTheDocument();
  });

  it("a refused price marks the price box invalid and points it at the error; typing clears the mark", async () => {
    setup({ validatePrice });
    await fill();
    const price = screen.getByTestId("units-v2-add-price");
    expect(price).not.toHaveAttribute("aria-invalid");
    await userEvent.type(price, "bad");
    await userEvent.click(screen.getByTestId("units-v2-add-submit"));
    expect(price).toHaveAttribute("aria-invalid", "true");
    expect(price).toHaveAttribute("aria-describedby", "units-v2-add-err");
    expect(document.getElementById("units-v2-add-err")).toHaveTextContent(
      "Enter a price like 12.50.",
    );
    await userEvent.type(price, "x");
    expect(price).not.toHaveAttribute("aria-invalid");
    expect(price).not.toHaveAttribute("aria-describedby");
  });

  it("a server refusal does not mark the price box invalid", async () => {
    mutate.mockImplementation((_b, o) =>
      o.onError?.({ response: { status: 409, data: { message: "Used." } } }),
    );
    setup({ validatePrice });
    await fill();
    await userEvent.type(screen.getByTestId("units-v2-add-price"), "5");
    await userEvent.click(screen.getByTestId("units-v2-add-submit"));
    expect(screen.getByTestId("units-v2-add-price")).not.toHaveAttribute("aria-invalid");
  });

  it("a blank price creates the unit as today and reports no price", async () => {
    mutate.mockImplementation((_b, o) => o.onSuccess?.({ id: "u9" }));
    const onAdded = jest.fn();
    setup({ validatePrice, onAdded });
    await fill();
    await userEvent.click(screen.getByTestId("units-v2-add-submit"));
    expect(mutate.mock.calls[0][0]).toEqual({ label: "Box", factorToBase: 12 });
    expect(onAdded).toHaveBeenCalledWith({ id: "u9", label: "Box", price: "" });
  });

  it("a typed price is never sent to the create call: it goes back to the caller", async () => {
    mutate.mockImplementation((_b, o) => o.onSuccess?.({ id: "u9" }));
    const onAdded = jest.fn();
    setup({ validatePrice, onAdded });
    await fill();
    await userEvent.type(screen.getByTestId("units-v2-add-price"), " 7.50 ");
    await userEvent.click(screen.getByTestId("units-v2-add-submit"));
    expect(mutate.mock.calls[0][0]).toEqual({ label: "Box", factorToBase: 12 });
    expect(onAdded).toHaveBeenCalledWith({ id: "u9", label: "Box", price: "7.50" });
  });
});

describe("AddUnitPanel reveals itself when it opens (K10d, under the Edit save bar)", () => {
  const seen: Array<{ el: Element; opts: unknown }> = [];
  beforeEach(() => {
    seen.length = 0;
    Element.prototype.scrollIntoView = function (this: Element, opts?: unknown) {
      seen.push({ el: this, opts });
    };
  });
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("scrolls the whole panel to the nearest edge, so scroll-padding keeps its buttons clear of the bar", async () => {
    setup();
    await userEvent.click(opener());
    const hit = seen.filter((s) => s.el === screen.getByTestId("units-v2-add-panel"));
    expect(hit).toHaveLength(1);
    expect(hit[0].opts).toEqual({ block: "nearest" });
  });

  it("does nothing before it is opened", () => {
    setup();
    expect(seen).toEqual([]);
  });
});

describe("AddUnitPanel onOpen (K10d)", () => {
  it("fires when the opener opens the panel, not when the panel closes", async () => {
    const onOpen = jest.fn();
    setup({ onOpen });
    await userEvent.click(opener());
    expect(onOpen).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    expect(onOpen).toHaveBeenCalledTimes(1);
    await userEvent.click(opener());
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});
