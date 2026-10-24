import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Modal } from "@routeflow/ui/web";
import { AnchoredList, isInsideAnchoredList } from "./AnchoredList";
import { UnitCombobox } from "./UnitCombobox";
import { CategoryCombobox } from "./CategoryCombobox";

jest.mock("@/lib/api/products", () => ({
  useProductCategories: () => ({ data: ["Bakery", "Drinks"] }),
}));

function rectOf(top: number, height = 38) {
  return { top, bottom: top + height, left: 40, right: 340, width: 300, height, x: 40, y: top };
}

function Host({ top }: { top: number }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const setRef = (el: HTMLDivElement | null) => {
    ref.current = el;
    if (el) el.getBoundingClientRect = () => rectOf(top) as DOMRect;
  };
  return (
    <div role="dialog">
      <div ref={setRef}>anchor</div>
      <AnchoredList anchorRef={ref} open maxHeight={192}>
        <p>item</p>
      </AnchoredList>
    </div>
  );
}

describe("AnchoredList", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  });

  it("portals to document.body, outside any dialog, above Radix and clickable", () => {
    render(<Host top={100} />);
    const list = screen.getByText("item").closest("[data-anchored-list]") as HTMLElement;
    expect(list.parentElement).toBe(document.body);
    expect(screen.getByRole("dialog").contains(list)).toBe(false);
    expect(list.className).toMatch(/pointer-events-auto/);
    expect(list.style.position).toBe("fixed");
    // above the Radix dialog layer (50) but below ReAuthProvider's prompt (300)
    expect(Number(list.style.zIndex)).toBe(250);
    expect(isInsideAnchoredList(screen.getByText("item"))).toBe(true);
    expect(isInsideAnchoredList(screen.getByText("anchor"))).toBe(false);
  });

  it("opens below the anchor when there is room", () => {
    render(<Host top={100} />);
    const list = screen.getByText("item").closest("[data-anchored-list]") as HTMLElement;
    expect(list.style.top).toBe("140px");
    expect(list.style.bottom).toBe("");
  });

  it("flips above the anchor when near the bottom of the viewport", () => {
    render(<Host top={740} />);
    const list = screen.getByText("item").closest("[data-anchored-list]") as HTMLElement;
    expect(list.style.top).toBe("");
    expect(list.style.bottom).toBe("62px"); // 800 - 740 + 2
    expect(parseInt(list.style.maxHeight, 10)).toBeLessThanOrEqual(192);
  });
});

describe("combobox lists", () => {
  it.each([
    [
      "UnitCombobox",
      (onChange: (v: string) => void) => <UnitCombobox value="" onChange={onChange} />,
      "case",
    ],
    [
      "CategoryCombobox",
      (onChange: (v: string) => void) => <CategoryCombobox value="" onChange={onChange} />,
      "Bakery",
    ],
  ])(
    "%s: list is portalled, a press on it keeps it open, option click selects",
    (_n, make, opt) => {
      const onChange = jest.fn();
      render(<div role="dialog">{make(onChange)}</div>);
      fireEvent.focus(screen.getByRole("textbox"));
      const option = screen.getByRole("button", { name: opt });
      expect(screen.getByRole("dialog").contains(option)).toBe(false);
      expect(option.closest("[data-anchored-list]")!.parentElement).toBe(document.body);
      // pressing inside the list (e.g. its scrollbar) is not an outside click
      fireEvent.mouseDown(option.closest("[data-anchored-list]")!);
      expect(screen.getByRole("button", { name: opt })).toBeInTheDocument();
      fireEvent.mouseDown(option);
      expect(onChange).toHaveBeenCalledWith(opt);
    },
  );

  it("a real outside click still closes the list", () => {
    render(<UnitCombobox value="" onChange={jest.fn()} />);
    fireEvent.focus(screen.getByRole("textbox"));
    expect(screen.getByRole("button", { name: "case" })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("button", { name: "case" })).toBeNull();
  });
});

describe("scrolling a portalled list inside a Radix Modal", () => {
  // react-remove-scroll preventDefaults document-level wheel/touchmove outside its shard; the
  // list is portalled outside the dialog, so it must stop those events before they get there.
  it.each(["wheel", "touchmove"])(
    "does not let %s reach a document-level preventDefault",
    (type) => {
      const guard = (e: Event) => e.preventDefault();
      document.addEventListener(type, guard, { passive: false });
      try {
        render(
          <Modal open onClose={jest.fn()} title="T">
            <UnitCombobox value="" onChange={jest.fn()} />
          </Modal>,
        );
        fireEvent.focus(screen.getByRole("textbox"));
        const list = screen.getByRole("button", { name: "case" }).closest("[data-anchored-list]")!;
        const ev = new Event(type, { bubbles: true, cancelable: true });
        list.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(false);
      } finally {
        document.removeEventListener(type, guard);
      }
    },
  );
});

describe("a combo's list inside its own Modal", () => {
  it("a press on the list does not dismiss the dialog", async () => {
    const onClose = jest.fn();
    render(
      <Modal open onClose={onClose} title="T">
        <UnitCombobox value="" onChange={jest.fn()} />
      </Modal>,
    );
    fireEvent.focus(screen.getByRole("textbox"));
    await new Promise((r) => setTimeout(r, 20));
    const list = screen.getByRole("button", { name: "case" }).closest("[data-anchored-list]")!;
    expect(list.getAttribute("data-anchored-owner")).toBe(screen.getByRole("dialog").id);
    fireEvent.pointerDown(list);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("combobox a11y across the portal", () => {
  it.each([
    ["UnitCombobox", () => <UnitCombobox value="" onChange={jest.fn()} />],
    ["CategoryCombobox", () => <CategoryCombobox value="" onChange={jest.fn()} />],
  ])("%s: aria-controls and aria-activedescendant follow ArrowDown", (_n, make) => {
    render(<div role="dialog">{make()}</div>);
    const input = screen.getByRole("textbox");
    expect(input).not.toHaveAttribute("aria-controls");
    fireEvent.focus(input);
    const list = document.getElementById(input.getAttribute("aria-controls")!)!;
    expect(list).toHaveAttribute("data-anchored-list");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(input).toHaveAttribute("aria-activedescendant", options[1].id);
    expect(list.contains(options[1])).toBe(true);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).not.toHaveAttribute("aria-controls");
  });
});
