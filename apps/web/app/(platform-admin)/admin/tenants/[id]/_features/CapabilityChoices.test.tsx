import * as React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { CapabilityPresetKey } from "@/lib/platform-admin/capabilities-contract";
import { CapabilityChoices } from "./CapabilityChoices";
import { NO_TICKS, type CapabilityTicks } from "./capability-ticks";
import { CAPABILITY_PRESETS_FIXTURE } from "./__fixtures__/capabilities.fixtures";

type Props = React.ComponentProps<typeof CapabilityChoices>;

function Harness({
  initial = NO_TICKS,
  onChange,
  matchedPreset = null,
  excluded,
  presets = CAPABILITY_PRESETS_FIXTURE,
}: {
  initial?: CapabilityTicks;
  onChange?: (t: CapabilityTicks) => void;
  matchedPreset?: CapabilityPresetKey | null;
  excluded?: Props["excluded"];
  presets?: Props["presets"];
}) {
  const [ticks, setTicks] = React.useState(initial);
  return (
    <CapabilityChoices
      idPrefix="t"
      ticks={ticks}
      onChange={(next) => {
        onChange?.(next);
        setTicks(next);
      }}
      presets={presets}
      matchedPreset={matchedPreset}
      excluded={excluded}
    />
  );
}

const box = (name: string) => screen.getByRole("checkbox", { name });
const DELIVERY = "Delivers on own trucks";
const DOOR = "Collect payment at the door";
const SHIPPING = "Ships by carrier";
const COUNTER = "Sells at the counter";

describe("CapabilityChoices: the three boxes", () => {
  it("is one fieldset 'What this business does' with the three native checkboxes, nothing ticked", () => {
    render(<Harness />);
    const fieldset = screen.getByRole("group", { name: "What this business does" });
    expect(fieldset.tagName).toBe("FIELDSET");
    for (const name of [DELIVERY, SHIPPING, COUNTER]) {
      expect(box(name)).not.toBeChecked();
      expect((box(name) as HTMLInputElement).type).toBe("checkbox");
    }
  });

  it("the fieldset is a focus target with a tabindex, and the counter box is its own target", () => {
    render(<Harness />);
    const fieldset = screen.getByRole("group", { name: "What this business does" });
    expect(fieldset).toHaveAttribute("tabindex", "-1");
    expect(fieldset).toHaveAttribute("data-focus-target", "capabilities");
    expect(box(COUNTER)).toHaveAttribute("data-focus-target", "counter");
  });

  it("each label covers the whole row (clicking the text ticks the box)", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText(SHIPPING));
    expect(box(SHIPPING)).toBeChecked();
  });

  it("door payments sit in a group labelled by the Delivery box", () => {
    render(<Harness />);
    const group = screen.getByRole("group", { name: DELIVERY });
    expect(within(group).getByRole("checkbox", { name: DOOR })).toBeInTheDocument();
  });

  it("door payments are off and disabled with a visible reason until Delivery is ticked", () => {
    render(<Harness />);
    const door = box(DOOR);
    expect(door).toBeDisabled();
    expect(door).not.toBeChecked();
    expect(screen.getByText("Turn on delivery first.")).toBeVisible();
    expect(door).toHaveAccessibleDescription("Turn on delivery first.");
  });

  it("ticking Delivery turns door payments on; unticking clears them; re-ticking restores on", () => {
    render(<Harness />);
    fireEvent.click(box(DELIVERY));
    expect(box(DOOR)).toBeEnabled();
    expect(box(DOOR)).toBeChecked();
    expect(screen.queryByText("Turn on delivery first.")).toBeNull();

    fireEvent.click(box(DELIVERY));
    expect(box(DOOR)).toBeDisabled();
    expect(box(DOOR)).not.toBeChecked();

    fireEvent.click(box(DELIVERY));
    expect(box(DOOR)).toBeChecked();
  });

  it("door payments can be unticked on their own", () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(box(DELIVERY));
    fireEvent.click(box(DOOR));
    expect(box(DOOR)).not.toBeChecked();
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ delivery: true, doorPayments: false }),
    );
  });

  it("a capability the plan excludes is disabled with 'Not on the {Plan} plan.' tied to the box", () => {
    render(<Harness excluded={{ counter: "Starter" }} />);
    expect(box(COUNTER)).toBeDisabled();
    expect(screen.getByText("Not on the Starter plan.")).toBeVisible();
    expect(box(COUNTER)).toHaveAccessibleDescription("Not on the Starter plan.");
    expect(box(SHIPPING)).toBeEnabled();
  });

  it("a disabled form disables every box and the preset menu", () => {
    render(
      <CapabilityChoices
        idPrefix="t"
        ticks={NO_TICKS}
        onChange={jest.fn()}
        presets={CAPABILITY_PRESETS_FIXTURE}
        disabled
      />,
    );
    for (const name of [DELIVERY, SHIPPING, COUNTER]) expect(box(name)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start from…" })).toBeDisabled();
  });
});

describe("CapabilityChoices: New staff orders open as", () => {
  const opensAs = () => screen.queryByRole("radiogroup", { name: "New staff orders open as" });

  it("is not shown until the counter and another box are ticked", () => {
    render(<Harness />);
    expect(opensAs()).toBeNull();
    fireEvent.click(box(COUNTER));
    expect(opensAs()).toBeNull();
    fireEvent.click(box(SHIPPING));
    expect(opensAs()).not.toBeNull();
  });

  it("Shipping + Counter: choosable, defaults to Counter sale (D6), Order stays selectable", () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(box(SHIPPING));
    fireEvent.click(box(COUNTER));
    const group = opensAs()!;
    const counterSale = within(group).getByRole("radio", { name: "Counter sale" });
    const order = within(group).getByRole("radio", { name: "Order" });
    expect(counterSale).toBeChecked();
    expect(order).toBeEnabled();
    expect(counterSale).toBeEnabled();
    fireEvent.click(order);
    expect(order).toBeChecked();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ opensAs: "order" }));
  });

  it.each([
    ["Delivery + Counter", [DELIVERY, COUNTER]],
    ["Delivery + Shipping + Counter", [DELIVERY, SHIPPING, COUNTER]],
  ])("%s: shown disabled on Order, with the reason in view", (_name, names) => {
    render(<Harness />);
    for (const n of names) fireEvent.click(box(n));
    const group = opensAs()!;
    const order = within(group).getByRole("radio", { name: "Order" });
    expect(order).toBeChecked();
    expect(order).toBeDisabled();
    expect(within(group).getByRole("radio", { name: "Counter sale" })).toBeDisabled();
    expect(screen.getByText("Delivery orders always open as orders.")).toBeVisible();
    expect(group).toHaveAccessibleDescription("Delivery orders always open as orders.");
  });

  it("is its own radiogroup: it holds no checkboxes", () => {
    render(<Harness />);
    fireEvent.click(box(SHIPPING));
    fireEvent.click(box(COUNTER));
    expect(within(opensAs()!).queryAllByRole("checkbox")).toHaveLength(0);
  });
});

describe("CapabilityChoices: Start from…", () => {
  const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "Start from…" }));

  it("one menu button lists every preset; each is a one-shot item with no pressed state", () => {
    render(<Harness />);
    expect(screen.queryByRole("menu")).toBeNull();
    openMenu();
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((i) => i.getAttribute("aria-label"))).toEqual([
      "Delivery",
      "Shipping only",
      "Counter sales only",
      "Counter + shipping",
      "Delivery + counter",
      "Delivery + shipping",
      "Everything",
    ]);
    for (const item of items) {
      expect(item).not.toHaveAttribute("aria-pressed");
      expect(item).not.toHaveAttribute("aria-checked");
    }
  });

  it("choosing a preset only pre-ticks: Delivery + counter ticks Delivery, door payments and Counter", () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delivery + counter" }));
    expect(box(DELIVERY)).toBeChecked();
    expect(box(DOOR)).toBeChecked();
    expect(box(COUNTER)).toBeChecked();
    expect(box(SHIPPING)).not.toBeChecked();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("choosing 'Counter + shipping' also pre-fills opening as a Counter sale", () => {
    render(<Harness />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Counter + shipping" }));
    expect(screen.getByRole("radio", { name: "Counter sale" })).toBeChecked();
  });

  it("marks 'Current' only on the server's matched preset, and puts it in the accessible name", () => {
    render(<Harness matchedPreset="delivery_pos" />);
    openMenu();
    const current = screen.getByRole("menuitem", { name: "Delivery + counter, current setup" });
    expect(within(current).getByText("Current")).toBeVisible();
    expect(screen.getAllByText("Current")).toHaveLength(1);
  });

  it("'Current' does not follow unsaved ticks", () => {
    render(<Harness matchedPreset="delivery_pos" />);
    fireEvent.click(box(SHIPPING));
    openMenu();
    expect(screen.getAllByText("Current")).toHaveLength(1);
    expect(
      screen.getByRole("menuitem", { name: "Delivery + counter, current setup" }),
    ).toBeInTheDocument();
  });

  it("Escape closes the menu and returns focus to the button", () => {
    render(<Harness />);
    openMenu();
    const button = screen.getByRole("button", { name: "Start from…" });
    expect(button).toHaveAttribute("aria-expanded", "true");
    act(() => {
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(button).toHaveFocus();
  });

  it("opening moves focus to the first item and arrow keys move between items", () => {
    render(<Harness />);
    openMenu();
    const items = screen.getAllByRole("menuitem");
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1]!, { key: "ArrowUp" });
    expect(items[0]).toHaveFocus();
  });

  it("a preset the API reports unavailable cannot be chosen", () => {
    const onChange = jest.fn();
    render(
      <Harness
        onChange={onChange}
        presets={CAPABILITY_PRESETS_FIXTURE.map((p) =>
          p.key === "delivery_pos" ? { ...p, available: false } : p,
        )}
      />,
    );
    openMenu();
    const item = screen.getByRole("menuitem", { name: "Delivery + counter" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(item);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("without presets there is no menu button", () => {
    render(<Harness presets={[]} />);
    expect(screen.queryByRole("button", { name: "Start from…" })).toBeNull();
  });
});
