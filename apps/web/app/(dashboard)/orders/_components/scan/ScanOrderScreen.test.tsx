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
    renderLine: (l: Line, ctx: { highlighted: boolean }) => (
      <li key={l.tempId} data-testid={`row-${l.productId}`} data-highlighted={ctx.highlighted}>
        {l.name} ×{l.qty}
      </li>
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
      expect(props.resolveCode).toHaveBeenCalledWith("012345678905");
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
      expect(props.resolveCode).toHaveBeenCalledWith("12345678");
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
