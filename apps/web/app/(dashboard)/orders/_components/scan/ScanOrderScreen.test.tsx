import * as React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScanOrderScreen } from "./ScanOrderScreen";
import type { ScanResolution } from "./useScanCodeHandler";
import type { ScanFrame } from "./useContinuousScanCamera";

// Barcode events are injected through the camera hook (spec §9.1): the real hook needs
// getUserMedia + zxing, but everything this screen owns — the gate, the buffer, the cue, the
// list, undo, totals — sits on the far side of `onDetect`.
let detect: (code: string, frame?: ScanFrame) => void = () => undefined;
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
    onDetect: (c: string, frame?: ScanFrame) => void;
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
  priceType?: string;
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
    renderLine: (l: Line, ctx: { highlighted: boolean; onTapPrice?: () => void }) => (
      <li key={l.tempId} data-testid={`row-${l.productId}`} data-highlighted={ctx.highlighted}>
        {l.name} ×{l.qty}
        {ctx.onTapPrice && (
          <button type="button" data-testid={`price-${l.productId}`} onClick={ctx.onTapPrice}>
            price
          </button>
        )}
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

// Steady-read is DEFAULT ON (owner ruling 2026-09-24): a code counts once the SAME value is held for several frames,
// so one deliberate scan in these tests is three consecutive frames of the same code.
const scan = async (code: string, frame?: ScanFrame) => {
  await act(async () => {
    detect(code, frame);
    detect(code, frame);
    detect(code, frame);
  });
};

describe("ScanOrderScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear(); // the scan mode is a per-device setting
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

    it("B993: a refused scan (units still loading) cues a rejection and shows the same sentence", async () => {
      setup({}, async () => ({ kind: "refused" }));
      await scan("111");
      expect(playScanCue).toHaveBeenCalledWith("rejected");
      expect(await screen.findByRole("status")).toHaveTextContent(
        "Units are still loading. Scan again in a moment",
      );
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
      // Opus item 4: NOT "rejected" — an operator scanning by ear hears "rejected" as
      // "rescan that", which is exactly how a queued-then-later-retried scan becomes a double
      // count. No dedicated "queued" tone exists, so silence is correct here.
      expect(playScanCue).toHaveBeenCalledWith("none");
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

    it("SA-090 REG: a Discard tap during an in-flight retry can never orphan the resolver's own add — the cue and history entry still land", async () => {
      // The real resolver ADDS the line as a side effect of resolving, whether or not anyone is
      // still listening for the outcome — this mock returning `added(...)` stands in for that.
      // Before SA-090's fix, "still queued?" was checked AFTER the await, so a Discard tap that
      // landed in the gap made retryOne walk away from a line the resolver had already added: no
      // cue, no history entry, nothing Undo could reach. The item is claimed out of the queue the
      // moment its lookup starts now, so a Discard tap here can only ever discard the QUEUE ROW —
      // it can no longer race the outcome once the lookup is already in flight.
      let release!: (r: ScanResolution) => void;
      const late = new Promise<ScanResolution>((r) => (release = r));
      const resolve = jest
        .fn<Promise<ScanResolution>, [string]>()
        .mockResolvedValueOnce(offline())
        .mockReturnValueOnce(late);
      setup({}, resolve);
      await scan("111");
      await advance(RETRY_WINDOW); // retry in flight — already claimed, removed from the queue
      // The row (and its Discard button) is gone the moment the lookup claimed it.
      expect(screen.queryByRole("button", { name: "Discard 111" })).not.toBeInTheDocument();

      await act(async () => release(added("p1", "Widget")));

      // Never dropped: the cue plays and the line is undoable, exactly as a live (non-queued)
      // scan would be — a Discard tap during the in-flight lookup changed nothing about the
      // outcome, because there was nothing left in the queue for it to discard by then.
      expect(await screen.findByText("Added Widget")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /undo last scan/i })).not.toBeDisabled();
    });

    it("an HTTP failure (the server answered) is reported, NOT queued", async () => {
      setup({}, async () => ({ kind: "error", message: "Server Error" }));
      await scan("111");
      expect(screen.getByText("Couldn't look up that code")).toBeInTheDocument();
      expect(screen.queryByLabelText("Waiting for signal")).not.toBeInTheDocument();
    });

    it("Opus review (#1271): a post-commit throw on retry is reported ONCE, never re-queued (never adds the line a second time)", async () => {
      // The real resolveCode ADDS the line as a side effect (flushSync, before returning) and only
      // THEN does post-commit work (a toast, mergedLineMessage) that could itself throw. Before this
      // fix, ScanOrderScreen's retryOne treated ANY throw here as a connectivity failure and
      // re-queued the code — the next retry called the resolver again and added the line a SECOND
      // time. A throw with no connectivity signal (no `err.response`, no ERR_NETWORK/timeout, browser
      // reports online) must be reported once and left alone, not retried.
      const resolve = jest
        .fn<Promise<ScanResolution>, [string, { quiet?: boolean; background?: boolean }?]>()
        .mockResolvedValueOnce(offline()) // the original lookup queues it
        .mockRejectedValueOnce(new Error("boom")); // the retry: resolver committed, then threw
      setup({}, resolve);
      await scan("111");
      expect(resolve).toHaveBeenCalledTimes(1);

      await advance(RETRY_WINDOW);

      // Exactly one retry attempt — never a second (which would be the double-add).
      expect(resolve).toHaveBeenCalledTimes(2);
      // Reported once, not silently dropped and not re-queued.
      expect(screen.getByText("Couldn't look up that code")).toBeInTheDocument();
      expect(screen.queryByLabelText("Waiting for signal")).not.toBeInTheDocument();

      // Nothing else retries it — advancing well past every retry window leaves the call count flat.
      await advance(60_000);
      expect(resolve).toHaveBeenCalledTimes(2);
    });

    it("SA-090f (red pin b): a post-commit throw on a LIVE (non-retry) scan gives an error cue and is never queued", async () => {
      setup({}, async () => {
        throw new Error("boom");
      });
      await scan("111");

      expect(screen.getByText("Couldn't look up that code")).toBeInTheDocument();
      expect(playScanCue).toHaveBeenLastCalledWith("rejected");
      expect(screen.queryByLabelText("Waiting for signal")).not.toBeInTheDocument();
    });

    it("SA-090f (red pin c): a genuine ERR_NETWORK on a RETRY's own lookup still re-queues (not the SA-090f fix's job to stop)", async () => {
      const resolve = jest
        .fn<Promise<ScanResolution>, [string]>()
        .mockResolvedValueOnce(offline()) // the original lookup queues it
        .mockResolvedValueOnce(offline()); // the retry's own lookup ALSO fails for lack of signal
      setup({}, resolve);
      await scan("111");
      expect(screen.getByLabelText("Waiting for signal")).toHaveTextContent("(1)");

      await advance(RETRY_WINDOW);

      // Still queued — a real connectivity failure on the retry itself must re-queue exactly like
      // the original lookup did, unaffected by SA-090f's "never re-queue an unexpected throw" fix
      // (this path never throws; useScanCodeHandler resolves it normally with offline: true).
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(screen.getByLabelText("Waiting for signal")).toHaveTextContent("(1)");
      expect(screen.getByLabelText("Waiting for signal")).toHaveTextContent("111");
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

    it("Opus review (#1271): discarding a later queued item while an earlier one's retry is still in flight must never retry (or double-count) the discarded one", async () => {
      // `runDueRetries` snapshots its due list ONCE when the loop starts (dueScans(pendingRef.current,
      // ...) is evaluated a single time, not re-read each iteration). If 222 is discarded while 111's
      // retry is still awaiting its resolver, the loop still holds 222's stale snapshot entry and,
      // without a synchronous still-queued check immediately before the claim, would retry (and add)
      // an item the operator already discarded — typically because they had already rescanned it,
      // making this a real double count.
      let release!: (r: ScanResolution) => void;
      const held = new Promise<ScanResolution>((r) => (release = r));
      const resolve = jest
        .fn<Promise<ScanResolution>, [string]>()
        .mockResolvedValueOnce(offline()) // 111's original lookup
        .mockResolvedValueOnce(offline()) // 222's original lookup
        .mockReturnValueOnce(held) // 111's retry hangs
        .mockResolvedValueOnce(added("p2", "Gadget")); // would be 222's retry, if it were ever asked
      setup({}, resolve);
      await scan("111");
      await scan("222");
      expect(screen.getByLabelText("Waiting for signal")).toHaveTextContent("(2)");

      await act(async () => {
        window.dispatchEvent(new Event("online"));
      });
      expect(resolve).toHaveBeenCalledTimes(3); // 111's retry is the one in flight

      fireEvent.click(screen.getByRole("button", { name: "Discard 222" }));

      await act(async () => release(added("p1", "Widget")));
      await advance(1_000);

      // 222's lookup must NEVER fire — the loop's stale snapshot entry for it must be refused at
      // the synchronous still-queued check, not retried.
      expect(resolve).toHaveBeenCalledTimes(3);
      expect(screen.queryByText("Added Gadget")).not.toBeInTheDocument();
    });

    // Opus review (#1271): the harness that lived here read `linesRef.current`, a ref updated
    // SYNCHRONOUSLY in the same tick as the decision — it can never observe a stale-render race,
    // so it stayed green even before ANY of this file's real fixes existed and proved nothing.
    // The real add-vs-merge decision lives in CreateOrderModal's `addLineItem`, which this screen
    // doesn't mount — moved to CreateOrderModal.test.tsx ("SA-090/Opus item 1 REG"), which renders
    // the real merge logic against genuinely async React state, with an actual await between the
    // decision and the commit.

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

    it("SA-090: Done (even pressed twice) never closes while a retry is actually in flight", async () => {
      let release!: (r: ScanResolution) => void;
      const hanging = new Promise<ScanResolution>((r) => (release = r));
      const resolve = jest
        .fn<Promise<ScanResolution>, [string]>()
        .mockResolvedValueOnce(offline())
        .mockReturnValueOnce(hanging);
      const { props } = setup({}, resolve);
      await scan("111");
      await act(async () => {
        window.dispatchEvent(new Event("online"));
      });
      await advance(RETRY_WINDOW); // retry claimed, lookup in flight, held

      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      expect(props.onClose).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      expect(props.onClose).not.toHaveBeenCalled(); // still not closed — a second press must not help

      await act(async () => release(added("p1", "Widget")));
      // The lookup is done now — Done is free to close (and there is nothing left queued).
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it("the status pill wraps instead of truncating, so the discard instruction is never cut off (B595)", async () => {
      setup({}, async () => offline());
      await scan("111");
      fireEvent.click(screen.getByRole("button", { name: "Done" }));

      const pill = screen.getByText(/press Done again to discard/);
      expect(pill).toHaveAttribute("role", "status");
      expect(pill).not.toHaveClass("truncate");
      expect(pill).toHaveClass("break-words");
      // The row lets the "Enter code manually" toggle drop below a long message.
      expect(pill.parentElement).toHaveClass("flex-wrap");
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

    it("a SPECIAL-priced line's price opens the editor too — an override needs a reason there (#2696(c))", () => {
      setup({ lines: [L({ priceType: "SPECIAL" }), L({ tempId: "t2", productId: "p2" })] });
      fireEvent.click(screen.getByTestId("price-p1"));
      expect(screen.getByTestId("editor")).toBeInTheDocument();
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

  describe("aim box + steady-read (owner ruling 2026-09-24, default ON)", () => {
    const AIM = { x: 100, y: 120, width: 1000, height: 360 };
    const inBox = {
      bounds: { origin: { x: 550, y: 290 }, size: { width: 100, height: 20 } },
      aimBox: AIM,
    };
    const offBox = {
      bounds: { origin: { x: 20, y: 20 }, size: { width: 100, height: 20 } },
      aimBox: AIM,
    };

    it("a single frame (a passing glance) is NOT a scan", async () => {
      const resolve = jest.fn().mockResolvedValue(added("p1", "Widget"));
      setup({ resolveCode: resolve });
      await act(async () => detect("111", inBox));
      expect(resolve).not.toHaveBeenCalled();
    });

    it("a held in-box code resolves exactly once", async () => {
      const resolve = jest.fn().mockResolvedValue(added("p1", "Widget"));
      setup({ resolveCode: resolve });
      await scan("111", inBox);
      await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
      expect(resolve.mock.calls[0][0]).toBe("111");
    });

    it("an OFF-CENTRE code never resolves, however long it is held", async () => {
      const resolve = jest.fn().mockResolvedValue(added("p1", "Widget"));
      setup({ resolveCode: resolve });
      await scan("111", offBox);
      await scan("111", offBox);
      expect(resolve).not.toHaveBeenCalled();
    });

    it("no geometry (frame omitted) fails OPEN: a steady code still resolves", async () => {
      const resolve = jest.fn().mockResolvedValue(added("p1", "Widget"));
      setup({ resolveCode: resolve });
      await scan("111");
      await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    });
  });

  describe("Hold to scan (owner ruling 2026-09-24: OPTIONAL per-device mode, default Continuous)", () => {
    const useHoldMode = () => localStorage.setItem("routeflow.scanMode", "hold");
    const holdButton = () => screen.getByRole("button", { name: "Hold to scan" });

    it("default Continuous: no hold button, and a steady scan resolves as before", async () => {
      const resolve = jest.fn().mockResolvedValue(added("p1", "Widget"));
      setup({ resolveCode: resolve });
      expect(screen.queryByRole("button", { name: "Hold to scan" })).not.toBeInTheDocument();
      await scan("111");
      await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    });

    it("the scan screen carries a Scan mode control: choosing Hold persists it and shows the round button", async () => {
      setup();
      fireEvent.click(screen.getByRole("button", { name: "Hold to scan mode" }));
      expect(localStorage.getItem("routeflow.scanMode")).toBe("hold");
      expect(holdButton()).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Continuous mode" }));
      expect(localStorage.getItem("routeflow.scanMode")).toBe("continuous");
      expect(screen.queryByRole("button", { name: "Hold to scan" })).not.toBeInTheDocument();
    });

    it("hold mode, NOT holding: frames are ignored (nothing resolves, however long)", async () => {
      useHoldMode();
      const resolve = jest.fn().mockResolvedValue(added("p1", "Widget"));
      setup({ resolveCode: resolve });
      await scan("111");
      await scan("111");
      expect(resolve).not.toHaveBeenCalled();
    });

    it("hold mode, WHILE holding (pointer): a steady code resolves; after release frames are ignored again", async () => {
      useHoldMode();
      const resolve = jest.fn().mockResolvedValue(added("p1", "Widget"));
      setup({ resolveCode: resolve });
      fireEvent.pointerDown(holdButton());
      expect(holdButton()).toHaveAttribute("aria-pressed", "true");
      await scan("111");
      await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
      fireEvent.pointerUp(holdButton());
      expect(holdButton()).toHaveAttribute("aria-pressed", "false");
      await scan("222");
      expect(resolve).toHaveBeenCalledTimes(1);
    });

    it("a RELEASE clears the streak: 2 frames, release, re-grab, 1 frame is NOT a scan", async () => {
      useHoldMode();
      const resolve = jest.fn().mockResolvedValue(added("p1", "Widget"));
      setup({ resolveCode: resolve });
      fireEvent.pointerDown(holdButton());
      await act(async () => {
        detect("111");
        detect("111");
      });
      fireEvent.pointerUp(holdButton());
      fireEvent.pointerDown(holdButton());
      await act(async () => detect("111"));
      expect(resolve).not.toHaveBeenCalled();
    });

    it("pointer cancel / leave, window blur and a hidden tab all release the hold", async () => {
      useHoldMode();
      setup();
      for (const release of [
        () => fireEvent.pointerCancel(holdButton()),
        () => fireEvent.pointerLeave(holdButton()),
        () => fireEvent.blur(window),
        () => {
          Object.defineProperty(document, "visibilityState", {
            value: "hidden",
            configurable: true,
          });
          fireEvent(document, new Event("visibilitychange"));
          Object.defineProperty(document, "visibilityState", {
            value: "visible",
            configurable: true,
          });
        },
      ]) {
        fireEvent.pointerDown(holdButton());
        expect(holdButton()).toHaveAttribute("aria-pressed", "true");
        release();
        expect(holdButton()).toHaveAttribute("aria-pressed", "false");
      }
    });

    it("keyboard: Space / Enter hold while down and release on keyup", () => {
      useHoldMode();
      setup();
      for (const key of [" ", "Enter"]) {
        fireEvent.keyDown(holdButton(), { key });
        expect(holdButton()).toHaveAttribute("aria-pressed", "true");
        fireEvent.keyUp(holdButton(), { key });
        expect(holdButton()).toHaveAttribute("aria-pressed", "false");
      }
    });

    it("a hold does NOT survive closing the scanner: reopen starts released and ignores frames until held again", async () => {
      useHoldMode();
      const resolve = jest.fn().mockResolvedValue(added("p1", "Widget"));
      const { rerender, props } = setup({ resolveCode: resolve });
      fireEvent.pointerDown(holdButton());
      rerender(<ScanOrderScreen {...props} open={false} />);
      rerender(<ScanOrderScreen {...props} open />);
      expect(holdButton()).toHaveAttribute("aria-pressed", "false");
      await scan("111");
      expect(resolve).not.toHaveBeenCalled();
    });

    it("a camera error while held releases the hold (the button unmounts, pointerup would never arrive)", () => {
      useHoldMode();
      const { rerender, props } = setup();
      fireEvent.pointerDown(holdButton());
      cameraState = { ...cameraState, error: "Camera blocked" };
      rerender(<ScanOrderScreen {...props} />);
      cameraState = { ...cameraState, error: null };
      rerender(<ScanOrderScreen {...props} />);
      expect(holdButton()).toHaveAttribute("aria-pressed", "false");
    });

    it("keyboard hold: focus leaving the button (Tab) releases it, since keyup lands elsewhere", () => {
      useHoldMode();
      setup();
      fireEvent.keyDown(holdButton(), { key: " " });
      expect(holdButton()).toHaveAttribute("aria-pressed", "true");
      fireEvent.blur(holdButton());
      expect(holdButton()).toHaveAttribute("aria-pressed", "false");
    });

    it("Continuous mode is unchanged: a window blur mid-streak does NOT restart the steady read", async () => {
      const resolve = jest.fn().mockResolvedValue(added("p1", "Widget"));
      setup({ resolveCode: resolve });
      await act(async () => {
        detect("111");
        detect("111");
      });
      fireEvent.blur(window);
      await act(async () => detect("111"));
      await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    });

    it("the mode chips and the hold button are real touch targets (chips >= 44px)", () => {
      setup();
      expect(screen.getByRole("button", { name: "Continuous mode" }).className).toMatch(
        /min-h-\[44px\]/,
      );
      expect(screen.getByRole("button", { name: "Hold to scan mode" }).className).toMatch(
        /min-h-\[44px\]/,
      );
    });

    it("the hold button straddles the strip's bottom edge so it never covers the aim box", () => {
      useHoldMode();
      setup();
      expect(holdButton().className).toMatch(/-bottom-7/);
    });

    it("2 UN-HELD frames never count: then hold + 1 frame is NOT a scan (the streak does not advance while un-held)", async () => {
      useHoldMode();
      const resolve = jest.fn().mockResolvedValue(added("p1", "Widget"));
      setup({ resolveCode: resolve });
      await act(async () => {
        detect("111");
        detect("111");
      });
      fireEvent.pointerDown(holdButton());
      await act(async () => detect("111"));
      expect(resolve).not.toHaveBeenCalled();
    });

    it("switching mode MID-HOLD releases it: back in Hold mode the button is up and frames are ignored", async () => {
      useHoldMode();
      const resolve = jest.fn().mockResolvedValue(added("p1", "Widget"));
      setup({ resolveCode: resolve });
      fireEvent.pointerDown(holdButton());
      expect(holdButton()).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(screen.getByRole("button", { name: "Continuous mode" }));
      fireEvent.click(screen.getByRole("button", { name: "Hold to scan mode" }));
      expect(holdButton()).toHaveAttribute("aria-pressed", "false");
      await scan("111");
      expect(resolve).not.toHaveBeenCalled();
    });

    it("the hold button is DESCRIBED by a visible hint, and blocks the iOS long-press callout", () => {
      useHoldMode();
      setup();
      const btn = holdButton();
      const id = btn.getAttribute("aria-describedby");
      expect(id).toBeTruthy();
      const hint = document.getElementById(id as string);
      expect(hint).toBeInTheDocument();
      expect(hint).toBeVisible();
      expect(hint).toHaveTextContent(/hold the button while the barcode is in the box/i);
      expect(btn.className).toMatch(/\[-webkit-touch-callout:none\]/);
    });

    it("the hold button is a real round target (>= 56px) at the bottom centre of the camera strip", () => {
      useHoldMode();
      setup();
      const btn = holdButton();
      expect(btn.className).toMatch(/h-14/);
      expect(btn.className).toMatch(/w-14/);
      expect(btn.className).toMatch(/rounded-full/);
      expect(btn.className).toMatch(/left-1\/2/);
      expect(btn.className).toMatch(/bottom-/);
    });

    it("manual entry is unaffected by the mode (a deliberate typed code always works)", async () => {
      useHoldMode();
      const resolve = jest.fn().mockResolvedValue(added("p1", "Widget"));
      setup({ resolveCode: resolve });
      fireEvent.click(screen.getByRole("button", { name: /Enter code manually/ }));
      const input = await screen.findByRole("textbox");
      fireEvent.change(input, { target: { value: "999" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(resolve).toHaveBeenCalledWith("999", expect.anything()));
    });
  });
});
