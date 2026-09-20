import * as React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScanOrderScreen } from "./ScanOrderScreen";
import type { ScanResolution } from "./useScanCodeHandler";

// Barcode events are injected through the camera hook (spec §9.1): the real hook needs
// getUserMedia + zxing, but everything this screen owns — the gate, the buffer, the cue, the
// list, undo, totals — sits on the far side of `onDetect`.
let detect: (code: string) => void = () => undefined;
let cameraEnabled = false;
let cameraState: {
  error: string | null;
  torchAvailable: boolean;
  torchOn: boolean;
} = { error: null, torchAvailable: false, torchOn: false };
const toggleTorch = jest.fn();
const refocus = jest.fn();
jest.mock("./useContinuousScanCamera", () => ({
  useContinuousScanCamera: ({
    enabled,
    onDetect,
  }: {
    enabled: boolean;
    onDetect: (c: string) => void;
  }) => {
    detect = onDetect;
    cameraEnabled = enabled;
    return { videoRef: { current: null }, toggleTorch, refocus, ...cameraState };
  },
}));

const playScanCue = jest.fn();
jest.mock("@/lib/scan-cue", () => ({
  playScanCue: (c: string) => playScanCue(c),
  unlockScanCue: jest.fn(),
}));

interface Line {
  tempId: string;
  productId: string;
  name: string;
  unitPrice: number;
  qty: number;
}
const L = (o: Partial<Line> = {}): Line => ({
  tempId: "t1",
  productId: "p1",
  name: "Widget",
  unitPrice: 2.5,
  qty: 1,
  ...o,
});

const added = (id: string, name: string, created = true): ScanResolution => ({
  kind: "added",
  product: { id, name },
  created,
});

function setup(
  over: Partial<React.ComponentProps<typeof ScanOrderScreen<Line>>> = {},
  resolve: (code: string) => Promise<ScanResolution> = async () => added("p1", "Widget"),
) {
  const props = {
    open: true,
    onClose: jest.fn(),
    lines: [] as Line[],
    renderLine: (l: Line, ctx: { highlighted: boolean; onTapPrice: () => void }) => (
      <li key={l.tempId} data-testid={`row-${l.productId}`} data-highlighted={ctx.highlighted}>
        {l.name} ×{l.qty}
        <button type="button" data-testid={`price-${l.productId}`} onClick={ctx.onTapPrice}>
          price
        </button>
      </li>
    ),
    renderPriceEditor: (l: Line, close: () => void) => (
      <div data-testid="editor">
        editing {l.name} ×{l.qty}
        <button type="button" onClick={close}>
          close-editor
        </button>
      </div>
    ),
    resolveCode: jest.fn(resolve),
    onUndo: jest.fn(),
    hasCustomer: true,
    ...over,
  };
  const utils = render(<ScanOrderScreen {...props} />);
  return { ...utils, props };
}

const scan = async (code: string) => {
  await act(async () => {
    detect(code);
  });
};

describe("ScanOrderScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cameraState = { error: null, torchAvailable: false, torchOn: false };
  });

  describe("shell", () => {
    it("renders nothing when closed", () => {
      setup({ open: false });
      expect(screen.queryByRole("dialog", { name: "Scan items" })).not.toBeInTheDocument();
    });

    it("renders as a portal on document.body (out of the transformed, focus-trapped Dialog)", () => {
      const { container } = setup();
      expect(container).toBeEmptyDOMElement();
      expect(screen.getByRole("dialog", { name: "Scan items" }).parentElement).toBe(document.body);
    });

    it("runs the camera only while open and not paused, and hides (keeps the session) when paused", () => {
      const { rerender, props } = setup();
      expect(cameraEnabled).toBe(true);
      rerender(<ScanOrderScreen {...props} paused />);
      expect(cameraEnabled).toBe(false);
      // aria-hidden while paused, so it is found by label rather than by role.
      expect(screen.getByLabelText("Scan items")).toHaveClass("hidden");
      rerender(<ScanOrderScreen {...props} paused={false} />);
      expect(cameraEnabled).toBe(true);
    });

    it("Close and Done both close the screen", () => {
      const { props } = setup();
      fireEvent.click(screen.getByRole("button", { name: /close/i }));
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      expect(props.onClose).toHaveBeenCalledTimes(2);
    });

    it("Escape closes ONLY this screen — stopPropagation keeps it from dismissing anything beneath", () => {
      const { props } = setup();
      const bubbled = jest.fn();
      document.addEventListener("keydown", bubbled);
      fireEvent.keyDown(document.body, { key: "Escape" });
      document.removeEventListener("keydown", bubbled);
      expect(props.onClose).toHaveBeenCalledTimes(1);
      expect(bubbled).not.toHaveBeenCalled();
    });

    it("does not react to Escape while paused", () => {
      const { props } = setup({ paused: true });
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(props.onClose).not.toHaveBeenCalled();
    });

    it("offers a flashlight only when the camera reports a torch", () => {
      setup();
      expect(screen.queryByLabelText(/flashlight/i)).not.toBeInTheDocument();
    });

    it("drives the torch through the camera hook", () => {
      cameraState = { error: null, torchAvailable: true, torchOn: false };
      setup();
      fireEvent.click(screen.getByLabelText("Turn flashlight on"));
      expect(toggleTorch).toHaveBeenCalled();
    });
  });

  describe("list, count and total", () => {
    it("renders one row per line through renderLine — the screen keeps no cart of its own", () => {
      setup({ lines: [L(), L({ tempId: "t2", productId: "p2", name: "Gadget" })] });
      expect(screen.getByTestId("row-p1")).toHaveTextContent("Widget ×1");
      expect(screen.getByTestId("row-p2")).toHaveTextContent("Gadget ×1");
    });

    it("shows the empty prompt with no lines, and 0 items · $0.00", () => {
      setup();
      expect(screen.getByText("Scan an item to add it.")).toBeInTheDocument();
      expect(screen.getByText("0 items · $0.00")).toBeInTheDocument();
    });

    it("counts DISTINCT SKUs, not units (owner ruling D2), and totals with computeLineSubtotal", () => {
      setup({
        lines: [
          L({ qty: 12, unitPrice: 8.99 }),
          L({ tempId: "t2", productId: "p2", qty: 1, unitPrice: 14.5 }),
        ],
      });
      // 12 x 8.99 + 14.50 = 122.38 — and 2 items, not 13.
      expect(screen.getByText("2 items · $122.38")).toBeInTheDocument();
    });

    it("singular '1 item'", () => {
      setup({ lines: [L()] });
      expect(screen.getByText("1 item · $2.50")).toBeInTheDocument();
    });
  });

  describe("scanning", () => {
    it("a decoded code is resolved exactly once and the accept cue plays before anything else", async () => {
      const { props } = setup();
      await scan("012345678905");
      expect(props.resolveCode).toHaveBeenCalledTimes(1);
      expect(props.resolveCode).toHaveBeenCalledWith("012345678905", { quiet: true });
      expect(playScanCue).toHaveBeenCalledWith("accepted");
      expect(await screen.findByRole("status")).toHaveTextContent("Added Widget");
    });

    it("per-frame repeats of the SAME barcode never add again (the gate)", async () => {
      const { props } = setup();
      await scan("012345678905");
      await scan("012345678905");
      await scan("012345678905");
      expect(props.resolveCode).toHaveBeenCalledTimes(1);
    });

    it("a different barcode is a new item and is resolved", async () => {
      const { props } = setup();
      await scan("111");
      await scan("222");
      expect((props.resolveCode as jest.Mock).mock.calls.map((c) => c[0])).toEqual(["111", "222"]);
    });

    it("a code detected mid-resolve is buffered, then resolved — never lost", async () => {
      let release!: (r: ScanResolution) => void;
      const first = new Promise<ScanResolution>((res) => (release = res));
      const resolve = jest
        .fn<Promise<ScanResolution>, [string]>()
        .mockReturnValueOnce(first)
        .mockResolvedValue(added("p2", "Gadget"));
      setup({}, resolve);

      await scan("111");
      await scan("222"); // arrives while 111 is still resolving
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(await screen.findByText(/Resolving/)).toBeInTheDocument();

      await act(async () => release(added("p1", "Widget")));

      await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
      expect(resolve.mock.calls.map((c) => c[0])).toEqual(["111", "222"]);
    });

    it("an archived product cues a rejection and says so", async () => {
      setup({}, async () => ({ kind: "archived", name: "Retired Widget" }));
      await scan("111");
      expect(playScanCue).toHaveBeenCalledWith("rejected");
      expect(await screen.findByRole("status")).toHaveTextContent("Retired Widget is archived");
    });

    it("an unknown code cues a rejection and names the code", async () => {
      setup({}, async () => ({ kind: "unknown" }));
      await scan("999000111222");
      expect(playScanCue).toHaveBeenCalledWith("rejected");
      expect(await screen.findByRole("status")).toHaveTextContent(
        "Not in the catalog: 999000111222",
      );
    });

    it("a lookup error cues a rejection and does NOT wedge the queue — the next scan still resolves", async () => {
      const resolve = jest
        .fn<Promise<ScanResolution>, [string]>()
        .mockResolvedValueOnce({ kind: "error", message: "Network Error" })
        .mockResolvedValueOnce(added("p2", "Gadget"));
      setup({}, resolve);
      await scan("111");
      await scan("222");
      expect(playScanCue).toHaveBeenCalledWith("rejected");
      expect(resolve).toHaveBeenCalledTimes(2);
    });

    it("a throwing resolver still advances the engine — the next scan is not stranded", async () => {
      const resolve = jest
        .fn<Promise<ScanResolution>, [string]>()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce(added("p2", "Gadget"));
      setup({}, resolve);

      await scan("111");
      expect(playScanCue).toHaveBeenCalledWith("rejected");
      await scan("222");

      expect(resolve).toHaveBeenCalledTimes(2);
      expect(playScanCue).toHaveBeenLastCalledWith("accepted");
    });

    it("highlights the row the last scan touched, then clears it", async () => {
      jest.useFakeTimers();
      try {
        setup({ lines: [L(), L({ tempId: "t2", productId: "p2", name: "Gadget" })] }, async () =>
          added("p2", "Gadget"),
        );
        await scan("222");
        expect(screen.getByTestId("row-p2")).toHaveAttribute("data-highlighted", "true");
        expect(screen.getByTestId("row-p1")).toHaveAttribute("data-highlighted", "false");
        await act(async () => {
          jest.advanceTimersByTime(2100);
        });
        expect(screen.getByTestId("row-p2")).toHaveAttribute("data-highlighted", "false");
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("manual entry", () => {
    it("is one tap away, submits on Enter, and clears the field", async () => {
      const { props } = setup();
      fireEvent.click(screen.getByRole("button", { name: /enter code manually/i }));
      const input = screen.getByLabelText("Barcode or SKU");
      fireEvent.change(input, { target: { value: " 12345678 " } });
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" });
      });
      expect(props.resolveCode).toHaveBeenCalledWith("12345678", { quiet: true });
      expect(input).toHaveValue("");
    });

    it("SKIPS the gate — a deliberate re-entry of the code just scanned is accepted", async () => {
      const { props } = setup();
      await scan("111");
      fireEvent.click(screen.getByRole("button", { name: /enter code manually/i }));
      fireEvent.change(screen.getByLabelText("Barcode or SKU"), { target: { value: "111" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Add" }));
      });
      expect(props.resolveCode).toHaveBeenCalledTimes(2);
    });

    it("Add is disabled for an empty/blank value", () => {
      setup();
      fireEvent.click(screen.getByRole("button", { name: /enter code manually/i }));
      expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
      fireEvent.change(screen.getByLabelText("Barcode or SKU"), { target: { value: "   " } });
      expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    });

    it("becomes the primary path when the camera cannot start", () => {
      cameraState = { error: "Camera access was denied.", torchAvailable: false, torchOn: false };
      setup();
      expect(screen.getByText("Camera access was denied.")).toBeInTheDocument();
      expect(screen.getByLabelText("Barcode or SKU")).toBeInTheDocument();
    });
  });

  describe("undo", () => {
    it("is disabled until something was scanned", () => {
      setup();
      expect(screen.getByRole("button", { name: /undo last scan/i })).toBeDisabled();
    });

    it("undoes the most recent scan first (LIFO), reporting whether it created the line", async () => {
      const resolve = jest
        .fn<Promise<ScanResolution>, [string]>()
        .mockResolvedValueOnce(added("p1", "Widget", true))
        .mockResolvedValueOnce(added("p1", "Widget", false));
      const { props } = setup({}, resolve);
      await scan("111");
      await scan("222");

      fireEvent.click(screen.getByRole("button", { name: /undo last scan/i }));
      expect(props.onUndo).toHaveBeenLastCalledWith({ productId: "p1", created: false });
      fireEvent.click(screen.getByRole("button", { name: /undo last scan/i }));
      expect(props.onUndo).toHaveBeenLastCalledWith({ productId: "p1", created: true });
      expect(screen.getByRole("button", { name: /undo last scan/i })).toBeDisabled();
    });

    it("only ADDED scans are undoable — a rejected scan changes nothing to undo", async () => {
      setup({}, async () => ({ kind: "unknown" }));
      await scan("999");
      expect(screen.getByRole("button", { name: /undo last scan/i })).toBeDisabled();
    });

    it("a new session does not inherit a stuck Resolving indicator from the last one", async () => {
      const hung = new Promise<ScanResolution>(() => undefined);
      const { rerender, props } = setup({}, () => hung);
      await scan("111");
      expect(await screen.findByText(/Resolving/)).toBeInTheDocument();

      rerender(<ScanOrderScreen {...props} open={false} />);
      rerender(<ScanOrderScreen {...props} open />);

      expect(screen.queryByText(/Resolving/)).not.toBeInTheDocument();
    });

    it("a new session starts with an empty undo stack", async () => {
      const { rerender, props } = setup();
      await scan("111");
      expect(screen.getByRole("button", { name: /undo last scan/i })).toBeEnabled();
      rerender(<ScanOrderScreen {...props} open={false} />);
      rerender(<ScanOrderScreen {...props} open />);
      expect(screen.getByRole("button", { name: /undo last scan/i })).toBeDisabled();
    });
  });

  describe("poor-signal queue (step 7)", () => {
    const offline = (): ScanResolution => ({
      kind: "error",
      message: "Network Error",
      offline: true,
    });
    const RETRY_WINDOW = 6_600; // first retry is due 5s after the failure; the tick is 1.5s

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
      jest.useRealTimers();
      // A test that throws before restoring its navigator.onLine spy must not leave the rest offline.
      jest.restoreAllMocks();
    });

    const advance = async (ms: number) => {
      // The ASYNC variant flushes promise microtasks between timers, so a retry's failure is
      // recorded at the clock reading it happened at, not at the end of the whole advance.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(ms);
      });
    };

    it("a lookup that failed for lack of signal is QUEUED, not reported as a failure or added", async () => {
      const { props } = setup({}, async () => offline());
      await scan("111");

      expect(screen.getByLabelText("Waiting for signal")).toHaveTextContent(
        "Waiting for signal (1)",
      );
      expect(screen.getByLabelText("Waiting for signal")).toHaveTextContent("111");
      expect(playScanCue).toHaveBeenCalledWith("rejected");
      expect(props.onUndo).not.toHaveBeenCalled();
      // A queued scan is not an added scan, so there is nothing to undo.
      expect(screen.getByRole("button", { name: /undo last scan/i })).toBeDisabled();
    });

    it("tells the operator it is queued", async () => {
      setup({}, async () => offline());
      await scan("111");
      expect(screen.getByText(/No signal - 111 queued, will retry/)).toBeInTheDocument();
    });

    it("retries after 5s, and on success adds it exactly like a live scan (cue, pill, undo entry)", async () => {
      const resolve = jest
        .fn<Promise<ScanResolution>, [string, { quiet?: boolean }?]>()
        .mockResolvedValueOnce(offline())
        .mockResolvedValueOnce(added("p1", "Widget"));
      setup({}, resolve);
      await scan("111");
      expect(resolve).toHaveBeenCalledTimes(1);

      await advance(RETRY_WINDOW);

      expect(resolve).toHaveBeenCalledTimes(2);
      expect(resolve).toHaveBeenLastCalledWith("111", { quiet: true, background: true });
      expect(screen.queryByLabelText("Waiting for signal")).not.toBeInTheDocument();
      expect(playScanCue).toHaveBeenLastCalledWith("accepted");
      expect(screen.getByText("Added Widget")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /undo last scan/i })).toBeEnabled();
    });

    it("does NOT retry before it is due", async () => {
      const resolve = jest.fn<Promise<ScanResolution>, [string]>().mockResolvedValue(offline());
      setup({}, resolve);
      await scan("111");
      await advance(3_000);
      expect(resolve).toHaveBeenCalledTimes(1);
    });

    it("backs off exponentially while still offline (5s, 10s, ...)", async () => {
      const resolve = jest.fn<Promise<ScanResolution>, [string]>().mockResolvedValue(offline());
      setup({}, resolve);
      await scan("111");

      await advance(RETRY_WINDOW); // retry #1 fails -> next in 10s
      expect(resolve).toHaveBeenCalledTimes(2);
      await advance(6_000);
      expect(resolve).toHaveBeenCalledTimes(2); // not yet
      await advance(5_000); // 11s after retry #1
      expect(resolve).toHaveBeenCalledTimes(3);
    });

    it("gives up after 10 tries, says so, and empties the queue", async () => {
      const resolve = jest.fn<Promise<ScanResolution>, [string]>().mockResolvedValue(offline());
      setup({}, resolve);
      await scan("111");

      // Step tick by tick and stop AT the give-up: its status pill only lives 2.5s.
      for (let i = 0; i < 1000 && resolve.mock.calls.length < 10; i++) await advance(1_500);
      await advance(1_500);

      expect(resolve).toHaveBeenCalledTimes(10); // the original + 9 retries
      expect(screen.queryByLabelText("Waiting for signal")).not.toBeInTheDocument();
      expect(screen.getByText(/Gave up on 111 after 10 tries/)).toBeInTheDocument();
    });

    it("'Retry now' makes everything due immediately", async () => {
      const resolve = jest
        .fn<Promise<ScanResolution>, [string]>()
        .mockResolvedValueOnce(offline())
        .mockResolvedValueOnce(added("p1", "Widget"));
      setup({}, resolve);
      await scan("111");

      fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
      await advance(1_600);

      expect(resolve).toHaveBeenCalledTimes(2);
    });

    it("the browser coming back online retries at once", async () => {
      const resolve = jest
        .fn<Promise<ScanResolution>, [string]>()
        .mockResolvedValueOnce(offline())
        .mockResolvedValueOnce(added("p1", "Widget"));
      setup({}, resolve);
      await scan("111");

      await act(async () => {
        window.dispatchEvent(new Event("online"));
      });

      expect(resolve).toHaveBeenCalledTimes(2);
    });

    it("does not retry while the browser reports it is offline", async () => {
      const resolve = jest.fn<Promise<ScanResolution>, [string]>().mockResolvedValue(offline());
      setup({}, resolve);
      await scan("111");
      const online = jest.spyOn(navigator, "onLine", "get").mockReturnValue(false);

      await advance(30_000);

      expect(resolve).toHaveBeenCalledTimes(1);
      online.mockRestore();
    });

    it("the operator can discard a queued scan", async () => {
      const resolve = jest.fn<Promise<ScanResolution>, [string]>().mockResolvedValue(offline());
      setup({}, resolve);
      await scan("111");

      fireEvent.click(screen.getByRole("button", { name: "Discard 111" }));
      await advance(30_000);

      expect(screen.queryByLabelText("Waiting for signal")).not.toBeInTheDocument();
      expect(resolve).toHaveBeenCalledTimes(1); // never retried
    });

    it("an answer that arrives AFTER the operator discarded the scan is ignored (no line appears)", async () => {
      let release!: (r: ScanResolution) => void;
      const late = new Promise<ScanResolution>((r) => (release = r));
      const resolve = jest
        .fn<Promise<ScanResolution>, [string]>()
        .mockResolvedValueOnce(offline())
        .mockReturnValueOnce(late);
      setup({}, resolve);
      await scan("111");
      await advance(RETRY_WINDOW); // retry in flight
      fireEvent.click(screen.getByRole("button", { name: "Discard 111" }));

      await act(async () => release(added("p1", "Widget")));

      expect(screen.queryByText("Added Widget")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /undo last scan/i })).toBeDisabled();
    });

    it("an HTTP failure (the server answered) is reported, NOT queued", async () => {
      setup({}, async () => ({ kind: "error", message: "Server Error" }));
      await scan("111");
      expect(screen.getByText("Couldn't look up that code")).toBeInTheDocument();
      expect(screen.queryByLabelText("Waiting for signal")).not.toBeInTheDocument();
    });

    it("retries are quiet: the resolver is always asked not to toast", async () => {
      const resolve = jest
        .fn<Promise<ScanResolution>, [string, { quiet?: boolean }?]>()
        .mockResolvedValue(offline());
      setup({}, resolve);
      await scan("111");
      await advance(60_000);
      expect(resolve.mock.calls[0][1]).toEqual({ quiet: true }); // the live scan
      for (const call of resolve.mock.calls.slice(1)) {
        // every retry is quiet AND background (it must not pop create-product on its own)
        expect(call[1]).toEqual({ quiet: true, background: true });
      }
    });

    it("waits at most 20 scans, then tells the operator to reconnect", async () => {
      setup({}, async () => offline());
      for (let i = 0; i < 20; i++) await scan(`code-${i}`);
      expect(screen.getByLabelText("Waiting for signal")).toHaveTextContent("(20)");

      await scan("code-20");

      expect(screen.getByLabelText("Waiting for signal")).toHaveTextContent("(20)");
      expect(screen.getByText(/Too many scans are waiting for signal/)).toBeInTheDocument();
    });

    it("retries ONE AT A TIME - the second starts only after the first has resolved (no duplicate rows)", async () => {
      let release!: (r: ScanResolution) => void;
      const first = new Promise<ScanResolution>((r) => (release = r));
      const resolve = jest
        .fn<Promise<ScanResolution>, [string]>()
        .mockResolvedValueOnce(offline()) // the two original lookups
        .mockResolvedValueOnce(offline())
        .mockReturnValueOnce(first) // retry #1 hangs
        .mockResolvedValue(added("p1", "Widget"));
      setup({}, resolve);
      await scan("111");
      await scan("222");
      expect(screen.getByLabelText("Waiting for signal")).toHaveTextContent("(2)");

      await act(async () => {
        window.dispatchEvent(new Event("online"));
      });
      await advance(5_000); // ample time for a concurrent retry to have started
      expect(resolve).toHaveBeenCalledTimes(3); // only retry #1 is out

      await act(async () => release(added("p1", "Widget")));
      await advance(1_000);

      expect(resolve).toHaveBeenCalledTimes(4); // now retry #2
    });

    it("'Retry now' says so when the browser is still offline, instead of doing nothing", async () => {
      const resolve = jest.fn<Promise<ScanResolution>, [string]>().mockResolvedValue(offline());
      setup({}, resolve);
      await scan("111");
      jest.spyOn(navigator, "onLine", "get").mockReturnValue(false);

      fireEvent.click(screen.getByRole("button", { name: "Retry now" }));

      // Asserted right away: the status pill only lives 2.5s.
      expect(
        screen.getByText(/Still offline - will retry as soon as the connection returns/),
      ).toBeInTheDocument();
      await advance(3_000);
      expect(resolve).toHaveBeenCalledTimes(1);
    });

    it("closing with scans still waiting warns first; a second press discards and closes", async () => {
      const { props } = setup({}, async () => offline());
      await scan("111");

      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      expect(props.onClose).not.toHaveBeenCalled();
      expect(
        screen.getByText(/1 scan still waiting for signal - press Done again to discard/),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it("Escape and Close use the same warn-then-discard rule", async () => {
      const { props } = setup({}, async () => offline());
      await scan("111");

      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(props.onClose).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: /close/i }));
      expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it("once the queue is empty (discarded) closing is immediate again", async () => {
      const { props } = setup({}, async () => offline());
      await scan("111");
      fireEvent.click(screen.getByRole("button", { name: "Done" })); // arms
      fireEvent.click(screen.getByRole("button", { name: "Discard 111" }));

      fireEvent.click(screen.getByRole("button", { name: "Done" }));

      expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it("a reconnect while the price sheet is open is NOT missed - it retries once the sheet closes", async () => {
      const resolve = jest
        .fn<Promise<ScanResolution>, [string]>()
        .mockResolvedValueOnce(offline())
        .mockResolvedValue(added("p1", "Widget"));
      setup({ lines: [L()] }, resolve);
      await scan("111");
      fireEvent.click(screen.getByTestId("price-p1")); // editor open

      await act(async () => {
        window.dispatchEvent(new Event("online"));
      });
      expect(resolve).toHaveBeenCalledTimes(1); // waits for the sheet

      fireEvent.click(screen.getByRole("button", { name: "close-editor" }));
      await advance(1_600);

      expect(resolve).toHaveBeenCalledTimes(2); // due immediately, not after the 5s backoff
    });

    it("does not retry under the price sheet or while paused", async () => {
      const resolve = jest.fn<Promise<ScanResolution>, [string]>().mockResolvedValue(offline());
      const lines = [L()];
      const { rerender, props } = setup({ lines }, resolve);
      await scan("111");

      fireEvent.click(screen.getByTestId("price-p1")); // editor open
      await advance(30_000);
      expect(resolve).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "close-editor" }));
      rerender(<ScanOrderScreen {...props} paused />);
      await advance(30_000);
      expect(resolve).toHaveBeenCalledTimes(1);

      rerender(<ScanOrderScreen {...props} paused={false} />);
      await advance(RETRY_WINDOW);
      expect(resolve.mock.calls.length).toBeGreaterThan(1); // resumes when live again
    });

    it("a queued scan belongs to its session - a new session starts with an empty queue", async () => {
      const resolve = jest.fn<Promise<ScanResolution>, [string]>().mockResolvedValue(offline());
      const { rerender, props } = setup({}, resolve);
      await scan("111");
      expect(screen.getByLabelText("Waiting for signal")).toBeInTheDocument();

      rerender(<ScanOrderScreen {...props} open={false} />);
      rerender(<ScanOrderScreen {...props} open />);
      await advance(60_000);

      expect(screen.queryByLabelText("Waiting for signal")).not.toBeInTheDocument();
      expect(resolve).toHaveBeenCalledTimes(1); // the old scan never resurfaces
    });
  });

  describe("price editor (step 6)", () => {
    const two = [L(), L({ tempId: "t2", productId: "p2", name: "Gadget" })];

    it("tapping a row's price opens the editor for THAT line", () => {
      setup({ lines: two });
      expect(screen.queryByTestId("editor")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("price-p2"));
      expect(screen.getByTestId("editor")).toHaveTextContent("editing Gadget ×1");
    });

    it("the editor sees the LIVE line, so an edit shows immediately", () => {
      const { rerender, props } = setup({ lines: two });
      fireEvent.click(screen.getByTestId("price-p1"));
      rerender(<ScanOrderScreen {...props} lines={[L({ qty: 5 }), two[1]]} />);
      expect(screen.getByTestId("editor")).toHaveTextContent("editing Widget ×5");
    });

    it("its own close control dismisses only the editor", () => {
      const { props } = setup({ lines: two });
      fireEvent.click(screen.getByTestId("price-p1"));
      fireEvent.click(screen.getByRole("button", { name: "close-editor" }));
      expect(screen.queryByTestId("editor")).not.toBeInTheDocument();
      expect(props.onClose).not.toHaveBeenCalled();
    });

    it("Escape closes the EDITOR first, and only a second Escape closes the screen", () => {
      const { props } = setup({ lines: two });
      fireEvent.click(screen.getByTestId("price-p1"));

      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(screen.queryByTestId("editor")).not.toBeInTheDocument();
      expect(props.onClose).not.toHaveBeenCalled();

      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it("pauses the camera while the editor is open, and resumes when it closes", () => {
      setup({ lines: two });
      expect(cameraEnabled).toBe(true);
      fireEvent.click(screen.getByTestId("price-p1"));
      expect(cameraEnabled).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "close-editor" }));
      expect(cameraEnabled).toBe(true);
    });

    it("closes itself when the line disappears underneath it (undo / removal)", () => {
      const { rerender, props } = setup({ lines: two });
      fireEvent.click(screen.getByTestId("price-p1"));
      rerender(<ScanOrderScreen {...props} lines={[two[1]]} />);
      expect(screen.queryByTestId("editor")).not.toBeInTheDocument();
    });

    it("without renderPriceEditor, tapping the price opens nothing and Escape closes the screen", () => {
      const { props } = setup({ lines: two, renderPriceEditor: undefined });
      fireEvent.click(screen.getByTestId("price-p1"));
      expect(screen.queryByTestId("editor")).not.toBeInTheDocument();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it("a new session never reopens a stale editor", () => {
      const { rerender, props } = setup({ lines: two });
      fireEvent.click(screen.getByTestId("price-p1"));
      rerender(<ScanOrderScreen {...props} open={false} />);
      rerender(<ScanOrderScreen {...props} open />);
      expect(screen.queryByTestId("editor")).not.toBeInTheDocument();
    });
  });

  describe("customer pricing banner (owner ruling D1)", () => {
    it("warns that items are priced at list when no customer is chosen", () => {
      setup({ hasCustomer: false });
      expect(
        screen.getByText(/No customer selected — scanned items are priced at list price/),
      ).toBeInTheDocument();
    });

    it("shows no banner once a customer is chosen — scans take the customer's price immediately", () => {
      setup({ hasCustomer: true });
      expect(screen.queryByText(/No customer selected/)).not.toBeInTheDocument();
    });
  });
});
