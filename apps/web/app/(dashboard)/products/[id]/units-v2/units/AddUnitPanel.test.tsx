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
