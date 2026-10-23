import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { CreateOrderModal, MERGE_PROMPT_KEY_GUARD_MS } from "./CreateOrderModal";

/**
 * Orders apple-ux r4 gap-closer (PR-F), Create Order dialog:
 *  Q08 one compact footer row (Minimize lives in the header beside the X; no second "Close")
 *  Q09 "Tap to change" on the active line only
 *  N02 the "Open order exists" prompt: Enter takes the primary action, Escape cancels, Tab reaches the other
 * Pixels (390/768/1440) are the UI proof; this pins the DOM contract.
 */
window.HTMLElement.prototype.scrollIntoView = jest.fn();

const createOrderMutate = jest.fn();
let activeOrder: Record<string, unknown> | undefined;
const cust = { id: "c1", businessName: "Acme Foods", pricingTier: 3 };

jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [cust] } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({
    mutate: createOrderMutate,
    isPending: false,
    error: null,
    reset: jest.fn(),
  }),
  useActiveOrderForCustomer: () => ({ data: activeOrder }),
  useCustomerPriceHistory: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/drafts", () => ({
  useCreateDraft: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useUpdateDraft: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useDeleteDraft: () => ({ mutate: jest.fn() }),
  useDraft: () => ({ data: undefined, isFetching: false }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));
jest.mock("@/lib/api/tobacco", () => ({
  useHasAddon: () => false,
  useTenantAddons: () => ({ data: undefined, isLoading: false, isSuccess: false }),
}));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useScanV2: () => true,
  useOrderUiV2: () => ({ enabled: false, resolved: true }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
let capturedOnScan: ((code: string) => void) | undefined;
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: (props: { onScan: (code: string) => void; title?: string }) => {
    capturedOnScan = props.onScan;
    return <button type="button">{props.title}</button>;
  },
}));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));
jest.mock("./scan/useContinuousScanCamera", () => ({
  useContinuousScanCamera: () => ({
    videoRef: { current: null },
    torchAvailable: false,
    torchOn: false,
    toggleTorch: jest.fn(),
    refocus: jest.fn(),
    error: null,
  }),
}));
jest.mock("@/lib/scan-cue", () => ({ playScanCue: jest.fn(), unlockScanCue: jest.fn() }));
const mockResolveProductByCode = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolveProductByCode(code),
}));
jest.mock("@/lib/refocus-scanner", () => ({
  scheduleScannerRefocus: jest.fn(),
  isTextEntryActive: () => false,
}));

const product = (id: string, name: string) => ({
  notFound: false,
  archived: false,
  product: { id, name, pricePerUnit: "10", unit: "each" },
});

async function pickCustomer() {
  fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
    target: { value: "Acm" },
  });
  fireEvent.click(await screen.findByText("Acme Foods"));
  await new Promise((r) => setTimeout(r, 50));
}
async function scanLine(code: string, name: string) {
  capturedOnScan!(code);
  await screen.findByText(name);
}

// N05 / row 744: the merge prompt ignores Enter/Space for MERGE_PROMPT_KEY_GUARD_MS after it mounts. The mount stamp is
// performance.now(); a key event is judged by its OWN timeStamp (the same clock origin in a browser), never by a clock
// read while the handler runs. jsdom stamps events from another clock, so every key event gets a timeStamp from the
// controllable test clock: a capture listener registered BEFORE the component's (it runs first) defines it, unless the
// test gave the event one (stampedKey). pastKeyGuard() jumps the clock instead of really waiting.
let clockSkew = 0;
const realNow = performance.now.bind(performance);
let nowSpy: jest.SpyInstance;
const clock = () => realNow() + clockSkew;
const pastKeyGuard = () => {
  clockSkew += MERGE_PROMPT_KEY_GUARD_MS + 50;
};
const stampEvent = (e: Event) => {
  if (!Object.prototype.hasOwnProperty.call(e, "timeStamp"))
    Object.defineProperty(e, "timeStamp", { value: clock(), configurable: true });
};
/** A key event that carries a timeStamp of its own: one that was queued earlier than it is handled. */
const stampedKey = (type: "keydown" | "keyup", init: KeyboardEventInit, timeStamp: number) => {
  const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(e, "timeStamp", { value: timeStamp, configurable: true });
  return e;
};
beforeEach(() => {
  clockSkew = 0;
  nowSpy = jest.spyOn(performance, "now").mockImplementation(clock);
  document.addEventListener("keydown", stampEvent, true);
  document.addEventListener("keyup", stampEvent, true);
});
afterEach(() => {
  nowSpy.mockRestore();
  document.removeEventListener("keydown", stampEvent, true);
  document.removeEventListener("keyup", stampEvent, true);
});

beforeEach(() => {
  jest.clearAllMocks();
  activeOrder = undefined;
  mockResolveProductByCode.mockImplementation(async (code: string) =>
    code === "111" ? product("p1", "Widget") : product("p2", "Gadget"),
  );
});

describe("Q08: one compact footer row; Minimize beside the header X", () => {
  it("has exactly one Close control (the header X) and Minimize lives in the header with it", () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    const dialog = screen.getByRole("dialog");
    const closes = within(dialog).getAllByRole("button", { name: "Close" });
    expect(closes).toHaveLength(1);
    const minimize = within(dialog).getByRole("button", { name: /minimize/i });
    expect(minimize.parentElement).toBe(closes[0].parentElement);
  });

  it("the footer is a single row at every width: no stacked column, just the save actions (and the total)", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await scanLine("111", "Widget");
    const footer = screen.getByTestId("create-order-footer");
    expect(footer.className).not.toMatch(/flex-col/);
    expect(footer).toContainElement(screen.getByTestId("create-order-footer-total"));
    expect(footer).toContainElement(screen.getByRole("button", { name: /save as draft/i }));
    expect(footer).toContainElement(screen.getByRole("button", { name: /^create order$/i }));
    // Create Order stays the one primary: nothing else in the footer dismisses or parks
    expect(within(footer).queryByRole("button", { name: /minimize|close/i })).toBeNull();
  });

  it("the header X closes the dialog (it replaced the footer Close, same dismiss)", async () => {
    const onClose = jest.fn();
    const user = userEvent.setup();
    renderWithProviders(<CreateOrderModal isOpen onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("Minimize is disabled while the builder is empty and enabled once there is something to park", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(screen.getByRole("button", { name: /minimize/i })).toBeDisabled();
    await pickCustomer();
    expect(screen.getByRole("button", { name: /minimize/i })).toBeEnabled();
  });

  it("Minimize is a 44 px target below lg like the X beside it", () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    for (const name of [/minimize/i, "Close"]) {
      expect(screen.getByRole("button", { name })).toHaveClass("max-lg:h-11", "max-lg:w-11");
    }
  });
});

describe("Q09: 'Tap to change' shows on one line only", () => {
  it("two lines show the hint once, on the line you last touched", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await scanLine("111", "Widget");
    await scanLine("222", "Gadget");
    const rows = screen
      .getAllByRole("listitem")
      .filter((li) => within(li).queryByLabelText("Quantity"));
    expect(rows).toHaveLength(2);
    expect(screen.getAllByText("Tap to change")).toHaveLength(1);
    // the newest line is the active one
    expect(within(rows[1]).getByText("Tap to change")).toBeInTheDocument();
    await user.click(within(rows[0]).getByLabelText("Quantity"));
    expect(screen.getAllByText("Tap to change")).toHaveLength(1);
    expect(within(rows[0]).getByText("Tap to change")).toBeInTheDocument();
    expect(within(rows[1]).queryByText("Tap to change")).not.toBeInTheDocument();
  });
});

describe("N02: the Open order exists prompt is keyboard-first", () => {
  const openPrompt = async () => {
    activeOrder = { id: "o1", orderNumber: "ORD-1", status: "PENDING", itemCount: 1, total: 40 };
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await scanLine("111", "Widget");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save as draft/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    return screen.findByRole("dialog", { name: "Open order exists" });
  };

  it("opens with the primary action (Merge) focused, so Enter merges", async () => {
    const user = userEvent.setup();
    const prompt = await openPrompt();
    const merge = within(prompt).getByRole("button", { name: /merge into ORD-1/i });
    await waitFor(() => expect(merge).toHaveFocus());
    pastKeyGuard();
    await user.keyboard("{Enter}");
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
    expect(createOrderMutate.mock.calls[0][0]).toMatchObject({ mergeChoice: "merge" });
  });

  it("Tab reaches Create as separate and Enter chooses it", async () => {
    const user = userEvent.setup();
    const prompt = await openPrompt();
    const merge = within(prompt).getByRole("button", { name: /merge into ORD-1/i });
    await waitFor(() => expect(merge).toHaveFocus());
    await user.tab();
    expect(within(prompt).getByRole("button", { name: /create as separate/i })).toHaveFocus();
    pastKeyGuard();
    await user.keyboard("{Enter}");
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
    expect(createOrderMutate.mock.calls[0][0]).toMatchObject({ mergeChoice: "separate" });
  });

  it("Escape cancels the prompt and creates nothing", async () => {
    const user = userEvent.setup();
    await openPrompt();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Open order exists" })).not.toBeInTheDocument(),
    );
    expect(createOrderMutate).not.toHaveBeenCalled();
  });
});

describe("N05: the Open order exists prompt does not take the key press that opened it", () => {
  /**
   * Faithful model of the walker's repro. The server answers 409 MERGE_CHOICE_REQUIRED (the
   * pre-check missed, so `activeOrder` stays undefined), so the prompt opens LATER than the click.
   * jsdom has no default actions, so we drive the browser's event order by hand:
   *   1. mouse click on "Create Order" (request in flight, held by the mock);
   *   2. Enter keydown on the still-focused Create Order button (the impatient double submit);
   *   3. the 409 arrives: the prompt opens and N02 moves focus to "Merge into ORD-1";
   *   4. the SAME physical press now lands on Merge: an auto-repeat keydown (repeat: true), the
   *      click the browser's default action makes from it (detail 0 = keyboard), then the keyup.
   * A press is "the same" when its keydown was seen before the open and no keyup has ended it.
   */
  const conflict = { id: "o1", orderNumber: "ORD-1", status: "PENDING", itemCount: 1, total: 40 };
  let resolve409: () => void;
  const openVia409 = async () => {
    activeOrder = undefined;
    createOrderMutate.mockImplementation(
      (_payload: unknown, opts: { onError: (e: unknown) => void }) => {
        resolve409 = () =>
          opts.onError({
            response: {
              status: 409,
              data: { code: "MERGE_CHOICE_REQUIRED", activeOrder: conflict },
            },
          });
      },
    );
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await scanLine("111", "Widget");
    const create = screen.getByRole("button", { name: "Create Order" });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create); // 1
    await waitFor(() => expect(createOrderMutate).toHaveBeenCalledTimes(1));
    return create;
  };
  const showPrompt = async () => {
    act(() => resolve409());
    const prompt = await screen.findByRole("dialog", { name: "Open order exists" });
    const merge = within(prompt).getByRole("button", { name: /merge into ORD-1/i });
    await waitFor(() => expect(merge).toHaveFocus());
    return { prompt, merge };
  };

  it("(a) an Enter that began before the prompt opened does not merge, and the prompt stays", async () => {
    const create = await openVia409();
    fireEvent.keyDown(create, { key: "Enter", code: "Enter" }); // 2
    const { merge } = await showPrompt(); // 3
    const keyDownDefault = fireEvent.keyDown(merge, { key: "Enter", code: "Enter", repeat: true }); // 4
    fireEvent.click(merge, { detail: 0 }); // ...and even if a browser clicked anyway, it is swallowed
    fireEvent.keyUp(merge, { key: "Enter", code: "Enter" });
    expect(createOrderMutate).toHaveBeenCalledTimes(1); // only the original create
    expect(createOrderMutate.mock.calls.some(([p]) => p.mergeChoice === "merge")).toBe(false);
    expect(screen.getByRole("dialog", { name: "Open order exists" })).toBeInTheDocument();
    expect(keyDownDefault).toBe(false); // the guard cancels the keydown default action (the click)
  });

  it("(a2) a Space that began before the prompt opened does not merge on its keyup click", async () => {
    const create = await openVia409();
    fireEvent.keyDown(create, { key: " ", code: "Space" });
    const { merge } = await showPrompt();
    // Space activates on keyup: the keyup (and the click it makes) belong to the pre-open press.
    const keyUpDefault = fireEvent.keyUp(merge, { key: " ", code: "Space" });
    if (keyUpDefault) fireEvent.click(merge, { detail: 0 }); // the default action, only if not cancelled
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Open order exists" })).toBeInTheDocument();
    expect(keyUpDefault).toBe(false); // preventDefault on keyup cancels Space's click
  });

  it("(a3) once the stale press has ended, a fresh Enter merges (the guard does not stick)", async () => {
    const user = userEvent.setup();
    const create = await openVia409();
    fireEvent.keyDown(create, { key: "Enter", code: "Enter" });
    const { merge } = await showPrompt();
    fireEvent.keyUp(merge, { key: "Enter", code: "Enter" }); // the stale press is over
    pastKeyGuard();
    await user.keyboard("{Enter}");
    expect(createOrderMutate).toHaveBeenCalledTimes(2);
    expect(createOrderMutate.mock.calls[1][0]).toMatchObject({ mergeChoice: "merge" });
  });

  it("(b) a fresh Enter pressed after the prompt is open merges (N02 kept)", async () => {
    const user = userEvent.setup();
    await openVia409();
    await showPrompt();
    pastKeyGuard();
    await user.keyboard("{Enter}"); // keydown + keypress/click + keyup, all after the open
    expect(createOrderMutate).toHaveBeenCalledTimes(2);
    expect(createOrderMutate.mock.calls[1][0]).toMatchObject({ mergeChoice: "merge" });
  });

  it("(b2) a mouse click on Merge right after the open still merges", async () => {
    const user = userEvent.setup();
    const create = await openVia409();
    fireEvent.keyDown(create, { key: "Enter", code: "Enter" }); // a key is still down...
    const { merge } = await showPrompt();
    await user.click(merge); // ...but a pointer click (detail >= 1) is deliberate
    expect(createOrderMutate.mock.calls[1][0]).toMatchObject({ mergeChoice: "merge" });
  });

  it("(c) Escape cancels and creates nothing more", async () => {
    const user = userEvent.setup();
    await openVia409();
    await showPrompt();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Open order exists" })).not.toBeInTheDocument(),
    );
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
  });

  it("(d) Tab then Enter picks Separate", async () => {
    const user = userEvent.setup();
    await openVia409();
    const { prompt } = await showPrompt();
    await user.tab();
    expect(within(prompt).getByRole("button", { name: /create as separate/i })).toHaveFocus();
    pastKeyGuard();
    await user.keyboard("{Enter}");
    expect(createOrderMutate).toHaveBeenCalledTimes(2);
    expect(createOrderMutate.mock.calls[1][0]).toMatchObject({ mergeChoice: "separate" });
  });
});

describe("N05: the pre-check opens the prompt inside the click; an Enter/Space right after must not take it", () => {
  /**
   * The real-browser repro (Playwright: click Create Order, then press Enter/Space at once). The client already
   * knows the open order (`activeOrder`), so there is NO 409: the prompt mounts synchronously in the click and the
   * key arrives afterwards as a fresh, non-repeat keydown, which the held-key lineage rightly treats as new. jsdom has
   * no default actions, so each step honours preventDefault: Enter's click is made at keydown, Space's at keyup.
   */
  const openViaPreCheck = async () => {
    activeOrder = { id: "o1", orderNumber: "ORD-1", status: "PENDING", itemCount: 1, total: 40 };
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await scanLine("111", "Widget");
    const create = screen.getByRole("button", { name: "Create Order" });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create); // the prompt mounts right here, no request
    const prompt = await screen.findByRole("dialog", { name: "Open order exists" });
    const merge = within(prompt).getByRole("button", { name: /merge into ORD-1/i });
    await waitFor(() => expect(merge).toHaveFocus());
    expect(createOrderMutate).not.toHaveBeenCalled();
    return { prompt, merge };
  };
  const stillOpenAndUnmerged = () => {
    expect(createOrderMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Open order exists" })).toBeInTheDocument();
  };

  it("Enter keydown, keyboard click and keyup inside the window do not merge", async () => {
    const { merge } = await openViaPreCheck();
    const down = fireEvent.keyDown(merge, { key: "Enter", code: "Enter" });
    if (down) fireEvent.click(merge, { detail: 0 }); // the browser clicks on Enter's keydown unless cancelled
    fireEvent.click(merge, { detail: 0 }); // ...and even if it clicked anyway, it is swallowed
    fireEvent.keyUp(merge, { key: "Enter", code: "Enter" });
    stillOpenAndUnmerged();
    expect(down).toBe(false);
  });

  it("Space (activates on keyup) inside the window does not merge", async () => {
    const { merge } = await openViaPreCheck();
    fireEvent.keyDown(merge, { key: " ", code: "Space" });
    const up = fireEvent.keyUp(merge, { key: " ", code: "Space" });
    if (up) fireEvent.click(merge, { detail: 0 }); // Space clicks on keyup unless cancelled
    stillOpenAndUnmerged();
    expect(up).toBe(false);
  });

  it("a Space pressed inside the window but released after it still does not merge", async () => {
    const { merge } = await openViaPreCheck();
    fireEvent.keyDown(merge, { key: " ", code: "Space" });
    pastKeyGuard();
    const up = fireEvent.keyUp(merge, { key: " ", code: "Space" });
    if (up) fireEvent.click(merge, { detail: 0 });
    stillOpenAndUnmerged();
  });

  it("a fresh Enter after the window merges (N02 kept)", async () => {
    const user = userEvent.setup();
    const { merge } = await openViaPreCheck();
    fireEvent.keyDown(merge, { key: "Enter", code: "Enter" }); // the impatient one, swallowed
    fireEvent.keyUp(merge, { key: "Enter", code: "Enter" });
    pastKeyGuard();
    await user.keyboard("{Enter}");
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
    expect(createOrderMutate.mock.calls[0][0]).toMatchObject({ mergeChoice: "merge" });
  });

  it("a mouse click on Merge inside the window merges at once", async () => {
    const user = userEvent.setup();
    const { merge } = await openViaPreCheck();
    await user.click(merge);
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
    expect(createOrderMutate.mock.calls[0][0]).toMatchObject({ mergeChoice: "merge" });
  });

  // Row 744: Separate is a button the operator can reach by Tab at once; the window guards it the same as Merge.
  it("Separate inside the window: Enter and Space on the focused Separate button create nothing", async () => {
    const user = userEvent.setup();
    const { prompt } = await openViaPreCheck();
    await user.tab();
    const separate = within(prompt).getByRole("button", { name: /create as separate/i });
    expect(separate).toHaveFocus();
    const down = fireEvent.keyDown(separate, { key: "Enter", code: "Enter" });
    if (down) fireEvent.click(separate, { detail: 0 });
    fireEvent.keyUp(separate, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(separate, { key: " ", code: "Space" });
    const up = fireEvent.keyUp(separate, { key: " ", code: "Space" });
    if (up) fireEvent.click(separate, { detail: 0 });
    stillOpenAndUnmerged();
    expect(down).toBe(false);
    expect(up).toBe(false);
  });

  it("Tab inside the window, then Enter after it, picks Separate", async () => {
    const user = userEvent.setup();
    const { prompt } = await openViaPreCheck();
    await user.tab(); // Tab is never guarded
    expect(within(prompt).getByRole("button", { name: /create as separate/i })).toHaveFocus();
    pastKeyGuard();
    await user.keyboard("{Enter}");
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
    expect(createOrderMutate.mock.calls[0][0]).toMatchObject({ mergeChoice: "separate" });
  });

  // Row 744: the guard reads the KEY EVENT's own timeStamp, not a clock read while the handler runs. A press that was
  // queued before the prompt mounted but is handled after it (a long main-thread stall) is "before the window".
  it("an Enter queued before the prompt mounted, handled after the window has passed, still does not merge", async () => {
    const queuedAt = clock(); // the press happens now, before the prompt exists
    const { merge } = await openViaPreCheck();
    pastKeyGuard(); // the main thread stalled: the handler runs well after the window
    const down = fireEvent(merge, stampedKey("keydown", { key: "Enter", code: "Enter" }, queuedAt));
    if (down) fireEvent.click(merge, { detail: 0 });
    fireEvent(merge, stampedKey("keyup", { key: "Enter", code: "Enter" }, queuedAt));
    stillOpenAndUnmerged();
    expect(down).toBe(false);
  });

  it("a Space queued before the prompt mounted, handled after the window, does not merge on its keyup", async () => {
    const queuedAt = clock();
    const { merge } = await openViaPreCheck();
    pastKeyGuard();
    fireEvent(merge, stampedKey("keydown", { key: " ", code: "Space" }, queuedAt));
    const up = fireEvent(merge, stampedKey("keyup", { key: " ", code: "Space" }, queuedAt));
    if (up) fireEvent.click(merge, { detail: 0 });
    stillOpenAndUnmerged();
    expect(up).toBe(false);
  });

  it("an Enter stamped inside the window but handled after it is swallowed; one stamped after it merges", async () => {
    const { merge } = await openViaPreCheck();
    const stampedInside = clock() + 10; // 10 ms after the mount
    pastKeyGuard(); // the handler runs late
    const swallowed = fireEvent(
      merge,
      stampedKey("keydown", { key: "Enter", code: "Enter" }, stampedInside),
    );
    fireEvent(merge, stampedKey("keyup", { key: "Enter", code: "Enter" }, stampedInside));
    expect(swallowed).toBe(false);
    stillOpenAndUnmerged();
    const deliberate = fireEvent(
      merge,
      stampedKey("keydown", { key: "Enter", code: "Enter" }, clock()),
    );
    expect(deliberate).toBe(true);
  });

  it("Escape inside the window still cancels, and Tab still reaches Separate", async () => {
    const user = userEvent.setup();
    const { prompt } = await openViaPreCheck();
    await user.tab();
    expect(within(prompt).getByRole("button", { name: /create as separate/i })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Open order exists" })).not.toBeInTheDocument(),
    );
    expect(createOrderMutate).not.toHaveBeenCalled();
  });
});

describe("N01: merging tells the operator what the merge added", () => {
  it("the merged toast names the added line and the total the SERVER returned", async () => {
    const user = userEvent.setup();
    createOrderMutate.mockImplementation((_payload, opts) =>
      opts.onSuccess({ id: "o1", orderNumber: "ORD-1", total: "131.94" }),
    );
    activeOrder = { id: "o1", orderNumber: "ORD-1", status: "PENDING", itemCount: 1, total: 40 };
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await scanLine("111", "Widget");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save as draft/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    const merge = await screen.findByRole("button", { name: /merge into ORD-1/i });
    await user.click(merge);
    expect(await screen.findByText("Merged into order ORD-1")).toBeInTheDocument();
    expect(screen.getByText("+1 Widget · new total $131.94")).toBeInTheDocument();
  });
});
