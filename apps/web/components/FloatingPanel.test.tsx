import * as React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FloatingPanel, ModalNoticeContext, computeAnchoredPlacement } from "@routeflow/ui/web";

/** jsdom has no matchMedia: install one that answers the two queries the panel asks. */
function installMatchMedia({ reduce = false, wide = true }: { reduce?: boolean; wide?: boolean }) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes("prefers-reduced-motion")
        ? reduce
        : query.includes("min-width")
          ? wide
          : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
});

type PanelProps = Partial<React.ComponentProps<typeof FloatingPanel>>;

function Harness({
  open = true,
  onOpenChange = () => undefined,
  ...rest
}: PanelProps & { open?: boolean }) {
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const originRef = React.useRef<HTMLButtonElement>(null);
  const firstRef = React.useRef<HTMLInputElement>(null);
  const returnRef = React.useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
  const [origin, setOrigin] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => {
    setAnchor(anchorRef.current);
    setOrigin(originRef.current);
  }, []);
  return (
    <div>
      <div ref={anchorRef}>card</div>
      <button ref={originRef}>Edit prices</button>
      <button ref={returnRef}>Return here</button>
      <FloatingPanel
        open={open}
        onOpenChange={onOpenChange}
        anchor={anchor}
        origin={origin}
        title="Edit prices"
        description="Acme widget"
        variant="anchored"
        initialFocus={firstRef}
        returnFocus={returnRef}
        footer={<button>Save</button>}
        {...rest}
      >
        <input ref={firstRef} aria-label="Retail price" />
        <input aria-label="Tier 2 price" />
      </FloatingPanel>
    </div>
  );
}

// Radix arms its outside-press listener on a timer after mount.
const armed = () => new Promise((r) => setTimeout(r, 20));

describe("FloatingPanel semantics and focus", () => {
  it("is a modal dialog named by its title", () => {
    installMatchMedia({});
    render(<Harness />);
    const dialog = screen.getByRole("dialog", { name: "Edit prices" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("Acme widget");
  });

  it("puts initial focus on initialFocus, never on the close button", async () => {
    installMatchMedia({});
    render(<Harness />);
    await waitFor(() => expect(screen.getByLabelText("Retail price")).toHaveFocus());
    expect(screen.getByRole("button", { name: "Close" })).not.toHaveFocus();
  });

  it("accepts an element getter for initialFocus", async () => {
    installMatchMedia({});
    render(<Harness initialFocus={() => screen.getByLabelText("Tier 2 price")} />);
    await waitFor(() => expect(screen.getByLabelText("Tier 2 price")).toHaveFocus());
  });

  it("without initialFocus, focus lands on the panel itself, not the close button", async () => {
    installMatchMedia({});
    render(<Harness initialFocus={undefined} />);
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(dialog).toHaveFocus());
    expect(screen.getByRole("button", { name: "Close" })).not.toHaveFocus();
  });

  it("Tab from the last focusable wraps to the first", async () => {
    installMatchMedia({});
    const user = userEvent.setup();
    render(<Harness />);
    const save = screen.getByRole("button", { name: "Save" });
    act(() => save.focus());
    expect(save).toHaveFocus();
    await user.tab();
    // The first tabbable in the panel is the header Close button.
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(save).toHaveFocus();
  });

  it("closing returns focus to returnFocus", async () => {
    installMatchMedia({});
    const { rerender } = render(<Harness />);
    await waitFor(() => expect(screen.getByLabelText("Retail price")).toHaveFocus());
    rerender(<Harness open={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Return here" })).toHaveFocus());
  });

  it("N1: the element that had focus at open wins over returnFocus, which is only a fallback", async () => {
    installMatchMedia({});
    const opener = document.createElement("button");
    opener.textContent = "figure";
    document.body.appendChild(opener);
    opener.focus();
    const { rerender } = render(<Harness />);
    await waitFor(() => expect(screen.getByLabelText("Retail price")).toHaveFocus());
    rerender(<Harness open={false} />);
    await waitFor(() => expect(opener).toHaveFocus());
    expect(screen.getByRole("button", { name: "Return here" })).not.toHaveFocus();
    opener.remove();
  });

  it("N1: when the opener left the DOM, returnFocus is used", async () => {
    installMatchMedia({});
    const opener = document.createElement("button");
    opener.textContent = "figure";
    document.body.appendChild(opener);
    opener.focus();
    const { rerender } = render(<Harness />);
    await waitFor(() => expect(screen.getByLabelText("Retail price")).toHaveFocus());
    opener.remove();
    rerender(<Harness open={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Return here" })).toHaveFocus());
  });

  it("falls back to the element focused at open when returnFocus is gone", async () => {
    installMatchMedia({});
    const opener = document.createElement("button");
    opener.textContent = "opener";
    document.body.appendChild(opener);
    opener.focus();
    const { rerender } = render(<Harness returnFocus={() => null} />);
    await waitFor(() => expect(screen.getByLabelText("Retail price")).toHaveFocus());
    rerender(<Harness open={false} returnFocus={() => null} />);
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
  });
});

describe("FloatingPanel dismissal is the caller's call", () => {
  it("Escape calls onEscapeKeyDown and does not close when the handler prevents default", async () => {
    installMatchMedia({});
    const user = userEvent.setup();
    const onOpenChange = jest.fn();
    const onEscapeKeyDown = jest.fn((e: KeyboardEvent) => e.preventDefault());
    render(<Harness onOpenChange={onOpenChange} onEscapeKeyDown={onEscapeKeyDown} />);
    await user.keyboard("{Escape}");
    expect(onEscapeKeyDown).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("Escape closes through onOpenChange(false) when the handler lets it", async () => {
    installMatchMedia({});
    const user = userEvent.setup();
    const onOpenChange = jest.fn();
    const onEscapeKeyDown = jest.fn();
    render(<Harness onOpenChange={onOpenChange} onEscapeKeyDown={onEscapeKeyDown} />);
    await user.keyboard("{Escape}");
    expect(onEscapeKeyDown).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("an outside pointerdown calls onInteractOutside and does not close when prevented", async () => {
    installMatchMedia({});
    const onOpenChange = jest.fn();
    const onInteractOutside = jest.fn((e: Event) => e.preventDefault());
    render(<Harness onOpenChange={onOpenChange} onInteractOutside={onInteractOutside} />);
    await armed();
    fireEvent.pointerDown(document.body);
    expect(onInteractOutside).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("an outside pointerdown closes only when the handler lets it", async () => {
    installMatchMedia({});
    const onOpenChange = jest.fn();
    const onInteractOutside = jest.fn();
    render(<Harness onOpenChange={onOpenChange} onInteractOutside={onInteractOutside} />);
    await armed();
    fireEvent.pointerDown(document.body);
    expect(onInteractOutside).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("the header Close button asks to close", async () => {
    installMatchMedia({});
    const user = userEvent.setup();
    const onOpenChange = jest.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("FloatingPanel content", () => {
  it("renders the ModalNoticeContext value inside the dialog", () => {
    installMatchMedia({});
    render(
      <ModalNoticeContext.Provider value={<p>This account is read only.</p>}>
        <Harness />
      </ModalNoticeContext.Provider>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toContainElement(screen.getByText("This account is read only."));
  });

  it("renders no notice when the context is empty", () => {
    installMatchMedia({});
    render(<Harness />);
    expect(screen.getByRole("dialog").querySelector("[data-floating-panel-notice]")).toBeNull();
  });

  it("renders the optional header and the footer outside the scrolling body", () => {
    installMatchMedia({});
    render(<Harness header={<p>Header extras</p>} />);
    const body = screen.getByRole("dialog").querySelector("[data-floating-panel-body]");
    expect(body).not.toBeNull();
    expect(body).toContainElement(screen.getByLabelText("Retail price"));
    expect(body).not.toContainElement(screen.getByText("Header extras"));
    expect(body).not.toContainElement(screen.getByRole("button", { name: "Save" }));
  });

  it("uses a light scrim with no blur (anchored) and a heavier one for the sheet", () => {
    installMatchMedia({});
    const { unmount } = render(<Harness variant="anchored" />);
    const anchoredScrim = document.querySelector("[data-floating-panel-scrim]") as HTMLElement;
    expect(anchoredScrim.className).toContain("bg-black/10");
    expect(anchoredScrim.className).not.toContain("backdrop-blur");
    unmount();
    render(<Harness variant="sheet" />);
    const sheetScrim = document.querySelector("[data-floating-panel-scrim]") as HTMLElement;
    expect(sheetScrim.className).toContain("bg-black/30");
    expect(sheetScrim.className).not.toContain("backdrop-blur");
  });
});

describe("FloatingPanel variants and motion", () => {
  it("auto picks anchored at a wide viewport", () => {
    installMatchMedia({ wide: true });
    render(<Harness variant="auto" />);
    expect(screen.getByRole("dialog")).toHaveAttribute("data-variant", "anchored");
  });

  it("auto picks the bottom sheet below md", () => {
    installMatchMedia({ wide: false });
    render(<Harness variant="auto" />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("data-variant", "sheet");
    expect(dialog.className).toContain("rounded-t-2xl");
    expect(dialog.className).toContain("bottom-0");
    expect(dialog.className).toContain("92dvh");
    // 44 x 44 close target, safe-area footer, no grabber.
    expect(screen.getByRole("button", { name: "Close" }).className).toContain("h-11");
    expect(screen.getByRole("button", { name: "Close" }).className).toContain("w-11");
    expect(dialog.querySelector("[data-floating-panel-footer]")!.className).toContain(
      "safe-area-inset-bottom",
    );
    expect(dialog.querySelector("[data-floating-panel-grabber]")).toBeNull();
  });

  it("an explicit variant wins over the media query", () => {
    installMatchMedia({ wide: false });
    render(<Harness variant="anchored" />);
    expect(screen.getByRole("dialog")).toHaveAttribute("data-variant", "anchored");
  });

  it("anchored panel opens with opacity plus a 0.97 scale in 150 ms and closes on opacity only", () => {
    installMatchMedia({ reduce: false, wide: true });
    render(<Harness variant="anchored" />);
    const cls = screen.getByRole("dialog").className;
    expect(cls).toContain("fade-in-0");
    expect(cls).toContain("zoom-in-[0.97]");
    expect(cls).toContain("data-[state=open]:duration-150");
    expect(cls).toContain("fade-out-0");
    expect(cls).toContain("data-[state=closed]:duration-[120ms]");
    expect(cls).not.toContain("zoom-out");
    expect(cls).not.toContain("slide-out");
  });

  it("sheet rises 24 px with opacity in 200 ms", () => {
    installMatchMedia({ reduce: false, wide: false });
    render(<Harness variant="sheet" />);
    const cls = screen.getByRole("dialog").className;
    expect(cls).toContain("slide-in-from-bottom-6");
    expect(cls).toContain("data-[state=open]:duration-200");
    expect(cls).toContain("fade-in-0");
  });

  it.each(["anchored", "sheet"] as const)(
    "under prefers-reduced-motion the %s panel has no scale or translate animation class",
    (variant) => {
      installMatchMedia({ reduce: true, wide: variant === "anchored" });
      render(<Harness variant={variant} />);
      const cls = screen.getByRole("dialog").className;
      expect(cls).toContain("fade-in-0");
      expect(cls).toContain("fade-out-0");
      expect(cls).not.toMatch(/zoom-(in|out)/);
      expect(cls).not.toMatch(/slide-(in|out)/);
      expect(cls).not.toMatch(/translate/);
    },
  );

  it("adds a 1px border under prefers-contrast: more (anchored)", () => {
    installMatchMedia({});
    render(<Harness variant="anchored" />);
    const cls = screen.getByRole("dialog").className;
    expect(cls).toContain("contrast-more:border");
    expect(cls).toContain("contrast-more:border-line-strong");
  });

  it("anchored width and height follow the spec", () => {
    installMatchMedia({});
    render(<Harness variant="anchored" />);
    const cls = screen.getByRole("dialog").className;
    expect(cls).toContain("w-[min(860px,calc(100vw-32px))]");
    expect(cls).toContain("max-h-[min(40rem,calc(100dvh-48px))]");
    expect(cls).toContain("rounded-xl");
    expect(cls).toContain("shadow-modal");
  });
});

describe("FloatingPanel placement in the DOM", () => {
  it("anchored: the panel is positioned from the anchor and origin rects on open", () => {
    installMatchMedia({});
    const rect = (r: Partial<DOMRect>) => ({ x: 0, y: 0, width: 0, height: 0, ...r }) as DOMRect;
    const spy = jest
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.textContent === "card")
          return rect({ right: 1000, left: 300, top: 100, bottom: 500 });
        if (this.textContent === "Edit prices" && this.tagName === "BUTTON")
          return rect({ left: 900, right: 980, top: 120, bottom: 150, width: 80, height: 30 });
        return rect({});
      });
    const widthSpy = jest.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    const heightSpy = jest.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(400);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    try {
      render(<Harness variant="anchored" />);
      const dialog = screen.getByRole("dialog");
      expect(dialog.style.left).toBe("200px"); // 1000 - 800
      expect(dialog.style.top).toBe("158px"); // 150 + 8
    } finally {
      spy.mockRestore();
      widthSpy.mockRestore();
      heightSpy.mockRestore();
    }
  });
});

describe("computeAnchoredPlacement", () => {
  const viewport = { width: 1440, height: 900 };

  it("right-aligns to the anchor and sits 8 px below the origin", () => {
    expect(
      computeAnchoredPlacement({
        anchor: { right: 1000 },
        origin: { bottom: 200 },
        panel: { width: 800, height: 400 },
        viewport,
      }),
    ).toEqual({ left: 200, top: 208 });
  });

  it("moves up until the panel fits above the 24 px bottom margin", () => {
    expect(
      computeAnchoredPlacement({
        anchor: { right: 1000 },
        origin: { bottom: 700 },
        panel: { width: 800, height: 400 },
        viewport,
      }),
    ).toEqual({ left: 200, top: 476 }); // 900 - 24 - 400
  });

  it("stays put when it just fits", () => {
    expect(
      computeAnchoredPlacement({
        anchor: { right: 1000 },
        origin: { bottom: 468 },
        panel: { width: 800, height: 400 },
        viewport,
      }),
    ).toEqual({ left: 200, top: 476 });
  });

  it("pins to the 24 px top margin when the viewport is shorter than the panel", () => {
    expect(
      computeAnchoredPlacement({
        anchor: { right: 1000 },
        origin: { bottom: 300 },
        panel: { width: 800, height: 640 },
        viewport: { width: 1440, height: 500 },
      }),
    ).toEqual({ left: 200, top: 24 });
  });

  it("never lets the panel's top go above the top margin", () => {
    expect(
      computeAnchoredPlacement({
        anchor: { right: 1000 },
        origin: { bottom: -50 },
        panel: { width: 800, height: 400 },
        viewport,
      }).top,
    ).toBe(24);
  });

  it("grows leftward past the card but not past the 16 px side margin", () => {
    expect(
      computeAnchoredPlacement({
        anchor: { right: 600 },
        origin: { bottom: 200 },
        panel: { width: 860, height: 400 },
        viewport,
      }),
    ).toEqual({ left: 16, top: 208 });
  });

  it("keeps the right edge inside the viewport when the anchor is off screen", () => {
    expect(
      computeAnchoredPlacement({
        anchor: { right: 1500 },
        origin: { bottom: 200 },
        panel: { width: 860, height: 400 },
        viewport,
      }),
    ).toEqual({ left: 564, top: 208 }); // 1440 - 16 - 860
  });

  it("falls back to the viewport's top-right corner with no anchor or origin", () => {
    expect(
      computeAnchoredPlacement({
        anchor: null,
        origin: null,
        panel: { width: 800, height: 400 },
        viewport,
      }),
    ).toEqual({ left: 624, top: 24 });
  });

  it("honours custom gap and margins", () => {
    expect(
      computeAnchoredPlacement({
        anchor: { right: 1000 },
        origin: { bottom: 200 },
        panel: { width: 800, height: 400 },
        viewport,
        gap: 12,
        margin: 40,
        sideMargin: 32,
      }),
    ).toEqual({ left: 200, top: 212 });
  });
});
