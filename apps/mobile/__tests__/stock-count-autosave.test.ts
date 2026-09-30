/**
 * Locks the durable stock-count session's autosave queue: the 900ms debounce,
 * the increment-vs-absolute payload choice, coalescing multiple scans of the
 * same product into one call, an edit superseding a pending increment, and
 * retry-safe merge-back on a failed write.
 */
import { createStockCountAutosave } from "../lib/stock-count-autosave";

describe("stock-count-autosave", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe("debounce", () => {
    it("waits the full 900ms idle window before writing, and any change resets it", () => {
      jest.useFakeTimers();
      const upsertLine = jest.fn().mockResolvedValue(undefined);
      const removeLine = jest.fn().mockResolvedValue(undefined);
      const engine = createStockCountAutosave({ upsertLine, removeLine });

      engine.queueScan("p1", 1, "REPLACE");
      jest.advanceTimersByTime(899);
      expect(upsertLine).not.toHaveBeenCalled();

      engine.queueScan("p1", 1, "REPLACE"); // resets the timer
      jest.advanceTimersByTime(899);
      expect(upsertLine).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      expect(upsertLine).toHaveBeenCalledTimes(1);
      expect(upsertLine).toHaveBeenCalledWith({
        productId: "p1",
        countedQty: 2,
        increment: true,
        mode: "REPLACE",
      });
    });
  });

  describe("scan increments", () => {
    it("coalesces three scans of the SAME product into one increment call carrying the sum", async () => {
      const upsertLine = jest.fn().mockResolvedValue(undefined);
      const removeLine = jest.fn();
      const engine = createStockCountAutosave({ upsertLine, removeLine });

      engine.queueScan("p1", 1, "REPLACE");
      engine.queueScan("p1", 1, "REPLACE");
      engine.queueScan("p1", 1, "REPLACE");
      await engine.flush();

      expect(upsertLine).toHaveBeenCalledTimes(1);
      expect(upsertLine).toHaveBeenCalledWith({
        productId: "p1",
        countedQty: 3,
        increment: true,
        mode: "REPLACE",
      });
    });

    it("flushes different products as separate calls", async () => {
      const upsertLine = jest.fn().mockResolvedValue(undefined);
      const engine = createStockCountAutosave({ upsertLine, removeLine: jest.fn() });

      engine.queueScan("p1", 1, "REPLACE");
      engine.queueScan("p2", 2, "ADD");
      await engine.flush();

      expect(upsertLine).toHaveBeenCalledTimes(2);
      expect(upsertLine).toHaveBeenCalledWith(
        expect.objectContaining({ productId: "p1", countedQty: 1 }),
      );
      expect(upsertLine).toHaveBeenCalledWith(
        expect.objectContaining({ productId: "p2", countedQty: 2, mode: "ADD" }),
      );
    });

    it("a zero delta never dirties the line", async () => {
      const upsertLine = jest.fn();
      const engine = createStockCountAutosave({ upsertLine, removeLine: jest.fn() });

      engine.queueScan("p1", 0, "REPLACE");
      expect(engine.pendingCount).toBe(0);
      await engine.flush();
      expect(upsertLine).not.toHaveBeenCalled();
    });
  });

  describe("increment vs absolute payload choice", () => {
    it("an edit sends the absolute total with `increment` ABSENT", async () => {
      const upsertLine = jest.fn().mockResolvedValue(undefined);
      const engine = createStockCountAutosave({ upsertLine, removeLine: jest.fn() });

      engine.queueEdit("p1", { countedQty: 12 }, "REPLACE");
      await engine.flush();

      expect(upsertLine).toHaveBeenCalledWith({ productId: "p1", mode: "REPLACE", countedQty: 12 });
      const call = upsertLine.mock.calls[0][0];
      expect(call.increment).toBeUndefined();
    });

    it("an edit queued after an unflushed scan REPLACES it — only the absolute edit is sent", async () => {
      const upsertLine = jest.fn().mockResolvedValue(undefined);
      const engine = createStockCountAutosave({ upsertLine, removeLine: jest.fn() });

      engine.queueScan("p1", 5, "REPLACE"); // e.g. 5 scans landed
      engine.queueEdit("p1", { countedQty: 4 }, "REPLACE"); // operator corrected it inline
      await engine.flush();

      expect(upsertLine).toHaveBeenCalledTimes(1);
      expect(upsertLine).toHaveBeenCalledWith({ productId: "p1", mode: "REPLACE", countedQty: 4 });
    });

    it("boxes/pieces and unitCostOverride pass through an edit patch untouched", async () => {
      const upsertLine = jest.fn().mockResolvedValue(undefined);
      const engine = createStockCountAutosave({ upsertLine, removeLine: jest.fn() });

      engine.queueEdit("p1", { boxes: 2, pieces: 3, unitCostOverride: 4.5678 }, "REPLACE");
      await engine.flush();

      expect(upsertLine).toHaveBeenCalledWith({
        productId: "p1",
        mode: "REPLACE",
        boxes: 2,
        pieces: 3,
        unitCostOverride: 4.5678,
      });
    });

    it("a later edit fully replaces an earlier queued edit (not merged field-by-field)", async () => {
      const upsertLine = jest.fn().mockResolvedValue(undefined);
      const engine = createStockCountAutosave({ upsertLine, removeLine: jest.fn() });

      engine.queueEdit("p1", { countedQty: 10, unitCostOverride: 1.5 }, "REPLACE");
      engine.queueEdit("p1", { countedQty: 11 }, "REPLACE"); // caller resends the full desired patch
      await engine.flush();

      expect(upsertLine).toHaveBeenCalledTimes(1);
      expect(upsertLine).toHaveBeenCalledWith({ productId: "p1", mode: "REPLACE", countedQty: 11 });
    });
  });

  describe("remove", () => {
    it("queues a DELETE and supersedes any pending scan/edit for the same product", async () => {
      const upsertLine = jest.fn();
      const removeLine = jest.fn().mockResolvedValue(undefined);
      const engine = createStockCountAutosave({ upsertLine, removeLine });

      engine.queueScan("p1", 3, "REPLACE");
      engine.queueRemove("p1");
      await engine.flush();

      expect(upsertLine).not.toHaveBeenCalled();
      expect(removeLine).toHaveBeenCalledWith("p1");
    });
  });

  describe('pendingCount ("n unsaved" badge)', () => {
    it("counts distinct dirty lines, not individual scans", () => {
      const engine = createStockCountAutosave({
        upsertLine: jest.fn().mockResolvedValue(undefined),
        removeLine: jest.fn(),
      });
      engine.queueScan("p1", 1, "REPLACE");
      engine.queueScan("p1", 1, "REPLACE");
      engine.queueScan("p2", 1, "REPLACE");
      expect(engine.pendingCount).toBe(2);
    });

    it("drops to 0 once every pending line has been flushed successfully", async () => {
      const engine = createStockCountAutosave({
        upsertLine: jest.fn().mockResolvedValue(undefined),
        removeLine: jest.fn(),
      });
      engine.queueScan("p1", 1, "REPLACE");
      engine.queueScan("p2", 1, "REPLACE");
      await engine.flush();
      expect(engine.pendingCount).toBe(0);
    });
  });

  describe("retry on failure", () => {
    it("keeps a failed increment pending and merges further scans onto it", async () => {
      const upsertLine = jest
        .fn()
        .mockRejectedValueOnce(new Error("network"))
        .mockResolvedValue(undefined);
      const onError = jest.fn();
      const engine = createStockCountAutosave({ upsertLine, removeLine: jest.fn(), onError });

      engine.queueScan("p1", 2, "REPLACE");
      await engine.flush(); // fails, delta=2 restored
      expect(engine.pendingCount).toBe(1);
      expect(onError).toHaveBeenCalledTimes(1);

      engine.queueScan("p1", 3, "REPLACE"); // another scan lands before the retry
      await engine.flush(); // succeeds this time, with the FULL accumulated delta

      expect(upsertLine).toHaveBeenLastCalledWith({
        productId: "p1",
        countedQty: 5,
        increment: true,
        mode: "REPLACE",
      });
      expect(engine.pendingCount).toBe(0);
    });

    it("a failed edit stays pending and is resent unchanged on the next flush", async () => {
      const upsertLine = jest
        .fn()
        .mockRejectedValueOnce(new Error("network"))
        .mockResolvedValue(undefined);
      const engine = createStockCountAutosave({ upsertLine, removeLine: jest.fn() });

      engine.queueEdit("p1", { countedQty: 9 }, "REPLACE");
      await engine.flush();
      expect(engine.pendingCount).toBe(1);

      await engine.flush();
      expect(upsertLine).toHaveBeenCalledTimes(2);
      expect(upsertLine).toHaveBeenLastCalledWith({
        productId: "p1",
        mode: "REPLACE",
        countedQty: 9,
      });
      expect(engine.pendingCount).toBe(0);
    });

    it("a newer edit queued while a failed increment retry is pending wins outright", async () => {
      const upsertLine = jest
        .fn()
        .mockRejectedValueOnce(new Error("network"))
        .mockResolvedValue(undefined);
      const engine = createStockCountAutosave({ upsertLine, removeLine: jest.fn() });

      engine.queueScan("p1", 2, "REPLACE");
      const flushing = engine.flush(); // increment in flight, about to fail
      engine.queueEdit("p1", { countedQty: 7 }, "REPLACE"); // operator switches to review, edits inline
      await flushing;

      // mergeBack sees a newer "edit" entry already queued for p1 and drops
      // the failed increment rather than clobbering it.
      expect(engine.pendingCount).toBe(1);
      await engine.flush();

      expect(upsertLine).toHaveBeenLastCalledWith({
        productId: "p1",
        mode: "REPLACE",
        countedQty: 7,
      });
    });
  });

  describe("flush()", () => {
    it("cancels the pending debounce timer and sends immediately", async () => {
      jest.useFakeTimers();
      const upsertLine = jest.fn().mockResolvedValue(undefined);
      const engine = createStockCountAutosave({ upsertLine, removeLine: jest.fn() });

      engine.queueScan("p1", 1, "REPLACE");
      await engine.flush();
      expect(upsertLine).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(5000);
      expect(upsertLine).toHaveBeenCalledTimes(1); // no duplicate fire from the (cancelled) timer
    });
  });

  describe("dispose()", () => {
    it("cancels a pending debounced write without discarding it — a later flush() still sends it", async () => {
      jest.useFakeTimers();
      const upsertLine = jest.fn().mockResolvedValue(undefined);
      const engine = createStockCountAutosave({ upsertLine, removeLine: jest.fn() });

      engine.queueScan("p1", 1, "REPLACE");
      engine.dispose();
      jest.advanceTimersByTime(5000);
      expect(upsertLine).not.toHaveBeenCalled();

      jest.useRealTimers();
      await engine.flush();
      expect(upsertLine).toHaveBeenCalledTimes(1);
    });
  });
});
