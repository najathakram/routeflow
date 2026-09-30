import { createDraftAutosave, type DraftRowMeta } from "../lib/use-draft-autosave";

/**
 * Drives the framework-free autosave engine directly (no React renderer in
 * this Jest project — see jest.config.js's node testEnvironment and
 * `**\/__tests__/**\/*.test.ts` matcher). Covers the PR-3 §PR-3.1 contract:
 * a single-flight create latch (stored Promise, not a boolean), the
 * JSON-unchanged skip, hydration seeding both refs, and discard() making
 * every later write a permanent no-op.
 */

const META: DraftRowMeta = { kind: "ORDER", customerId: "cust-1", customerName: "Acme Retail" };

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("use-draft-autosave", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe("debounce", () => {
    it("waits the full 900ms idle window before writing, and any change resets it", () => {
      jest.useFakeTimers();
      const createDraft = jest.fn().mockResolvedValue({ id: "draft-1" });
      const updateDraft = jest.fn().mockResolvedValue(undefined);
      const engine = createDraftAutosave({ createDraft, updateDraft });

      engine.update({ v: 1 }, META, true);
      jest.advanceTimersByTime(899);
      expect(createDraft).not.toHaveBeenCalled();

      engine.update({ v: 2 }, META, true); // resets the timer
      jest.advanceTimersByTime(899);
      expect(createDraft).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      expect(createDraft).toHaveBeenCalledTimes(1);
      expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({ payload: { v: 2 } }));
    });
  });

  describe("single-flight create latch", () => {
    it("collapses three payload changes across one create round-trip into exactly ONE POST /drafts", async () => {
      const created = deferred<{ id: string }>();
      const createDraft = jest.fn(() => created.promise);
      const updateDraft = jest.fn().mockResolvedValue(undefined);
      // Stubbed alongside create/update per the package contract, even though
      // the engine itself never calls it — submit-time delete is the
      // screen's job (decisions doc §PR-3.2's poison-pill flow), not the
      // autosave engine's.
      const deleteDraft = jest.fn().mockResolvedValue(undefined);
      const engine = createDraftAutosave({ createDraft, updateDraft, deleteDraft });

      engine.update({ v: 1 }, META, true);
      const p1 = engine.flush(); // starts the create; not yet resolved

      engine.update({ v: 2 }, META, true);
      const p2 = engine.flush(); // must reuse the in-flight create promise

      engine.update({ v: 3 }, META, true);
      const p3 = engine.flush(); // must also reuse it

      expect(createDraft).toHaveBeenCalledTimes(1);

      created.resolve({ id: "draft-1" });
      await Promise.all([p1, p2, p3]);

      expect(createDraft).toHaveBeenCalledTimes(1);
      expect(engine.draftId).toBe("draft-1");
      // the latest payload actually reached the server — not dropped because
      // a concurrent caller's create-resolution happened to run first.
      expect(updateDraft).toHaveBeenCalledWith(
        expect.objectContaining({ id: "draft-1", payload: { v: 3 } }),
      );
      expect(deleteDraft).not.toHaveBeenCalled();
    });

    it("never issues a second create once a draft id is bound", async () => {
      const createDraft = jest.fn().mockResolvedValue({ id: "draft-2" });
      const updateDraft = jest.fn().mockResolvedValue(undefined);
      const engine = createDraftAutosave({ createDraft, updateDraft });

      engine.update({ v: 1 }, META, true);
      await engine.flush();
      expect(createDraft).toHaveBeenCalledTimes(1);

      engine.update({ v: 2 }, META, true);
      await engine.flush();
      engine.update({ v: 3 }, META, true);
      await engine.flush();

      expect(createDraft).toHaveBeenCalledTimes(1);
      expect(updateDraft).toHaveBeenCalledTimes(2);
    });
  });

  describe("JSON-unchanged skip", () => {
    it("does not PATCH when the payload is byte-identical to the last save", async () => {
      const createDraft = jest.fn().mockResolvedValue({ id: "draft-3" });
      const updateDraft = jest.fn().mockResolvedValue(undefined);
      const engine = createDraftAutosave({ createDraft, updateDraft });

      engine.update({ v: 1, lines: [{ qty: 2 }] }, META, true);
      await engine.flush();
      expect(createDraft).toHaveBeenCalledTimes(1);

      // A fresh object, same JSON shape.
      engine.update({ v: 1, lines: [{ qty: 2 }] }, META, true);
      await engine.flush();

      expect(createDraft).toHaveBeenCalledTimes(1);
      expect(updateDraft).not.toHaveBeenCalled();
    });
  });

  describe("hydration", () => {
    it("seeds draftIdRef so a resumed session never creates", async () => {
      const createDraft = jest.fn();
      const updateDraft = jest.fn().mockResolvedValue(undefined);
      const engine = createDraftAutosave(
        { createDraft, updateDraft },
        { draftId: "resumed-1", payload: { v: "loaded" }, meta: META },
      );

      expect(engine.draftId).toBe("resumed-1");

      engine.update({ v: "changed" }, META, true);
      await engine.flush();

      expect(createDraft).not.toHaveBeenCalled();
      expect(updateDraft).toHaveBeenCalledWith(
        expect.objectContaining({ id: "resumed-1", payload: { v: "changed" } }),
      );
    });

    it("seeds lastSaved so resuming into the exact loaded payload does not immediately PATCH", async () => {
      const createDraft = jest.fn();
      const updateDraft = jest.fn().mockResolvedValue(undefined);
      const loadedPayload = { v: "loaded" };
      const engine = createDraftAutosave(
        { createDraft, updateDraft },
        { draftId: "resumed-2", payload: loadedPayload, meta: META },
      );

      // The builder's lazy useState initializers re-hydrate to the same
      // value the draft was loaded with — must not re-PATCH on resume.
      engine.update({ v: "loaded" }, META, true);
      await engine.flush();

      expect(createDraft).not.toHaveBeenCalled();
      expect(updateDraft).not.toHaveBeenCalled();
    });
  });

  describe("discard", () => {
    it("makes flush() a no-op immediately", async () => {
      const createDraft = jest.fn();
      const updateDraft = jest.fn();
      const engine = createDraftAutosave({ createDraft, updateDraft });

      engine.update({ v: 1 }, META, true);
      engine.discard();
      await engine.flush();

      expect(createDraft).not.toHaveBeenCalled();
      expect(updateDraft).not.toHaveBeenCalled();
    });

    it("suppresses the trailing PATCH even when discard() lands mid-create", async () => {
      const created = deferred<{ id: string }>();
      const createDraft = jest.fn(() => created.promise);
      const updateDraft = jest.fn().mockResolvedValue(undefined);
      const engine = createDraftAutosave({ createDraft, updateDraft });

      engine.update({ v: 1 }, META, true);
      const pending = engine.flush(); // create in flight

      engine.update({ v: 2 }, META, true); // a second change queued
      engine.discard();

      created.resolve({ id: "draft-4" });
      await pending;

      // Already dispatched before discard() — can't be un-sent.
      expect(createDraft).toHaveBeenCalledTimes(1);
      // But the trailing PATCH for the queued v2 change never fires.
      expect(updateDraft).not.toHaveBeenCalled();
    });

    it("cancels a pending debounced write", () => {
      jest.useFakeTimers();
      const createDraft = jest.fn();
      const updateDraft = jest.fn();
      const engine = createDraftAutosave({ createDraft, updateDraft });

      engine.update({ v: 1 }, META, true);
      engine.discard();
      jest.advanceTimersByTime(2000);

      expect(createDraft).not.toHaveBeenCalled();
    });

    it("is permanent — a later update()+flush() after discard() still writes nothing", async () => {
      const createDraft = jest.fn();
      const updateDraft = jest.fn();
      const engine = createDraftAutosave({ createDraft, updateDraft });

      engine.discard();
      engine.update({ v: 1 }, META, true);
      await engine.flush();
      engine.update({ v: 2 }, META, true);
      await engine.flush();

      expect(createDraft).not.toHaveBeenCalled();
      expect(updateDraft).not.toHaveBeenCalled();
    });
  });

  describe("enabled gate", () => {
    it("never writes while disabled, even via flush()", async () => {
      const createDraft = jest.fn();
      const updateDraft = jest.fn();
      const engine = createDraftAutosave({ createDraft, updateDraft });

      engine.update({ v: 1 }, META, false);
      await engine.flush();

      expect(createDraft).not.toHaveBeenCalled();
    });

    it("does not schedule a debounced write while disabled", () => {
      jest.useFakeTimers();
      const createDraft = jest.fn();
      const updateDraft = jest.fn();
      const engine = createDraftAutosave({ createDraft, updateDraft });

      engine.update({ v: 1 }, META, false);
      jest.advanceTimersByTime(5000);

      expect(createDraft).not.toHaveBeenCalled();
    });
  });

  describe("parkable gate", () => {
    it("never creates a draft for a state that is not parkable", async () => {
      const createDraft = jest.fn();
      const updateDraft = jest.fn();
      const engine = createDraftAutosave({ createDraft, updateDraft });

      engine.update({ lineItems: [] }, META, true, false);
      await engine.flush();

      expect(createDraft).not.toHaveBeenCalled();
      expect(updateDraft).not.toHaveBeenCalled();
    });

    it("keeps saving a BOUND draft once the state stops being parkable", async () => {
      // The operator adds lines (draft created), then deletes every one of
      // them and walks away. Freezing here would leave the parked copy
      // listing the items they just removed, and resuming would re-add them.
      const createDraft = jest.fn().mockResolvedValue({ id: "draft-5" });
      const updateDraft = jest.fn().mockResolvedValue(undefined);
      const engine = createDraftAutosave({ createDraft, updateDraft });

      engine.update({ lineItems: [{ qty: 3 }] }, META, true, true);
      await engine.flush();
      expect(createDraft).toHaveBeenCalledTimes(1);

      engine.update({ lineItems: [] }, META, true, false);
      await engine.flush();

      expect(createDraft).toHaveBeenCalledTimes(1);
      expect(updateDraft).toHaveBeenCalledWith(
        expect.objectContaining({ id: "draft-5", payload: { lineItems: [] } }),
      );
    });

    it("writes the emptied payload onto a draft whose create was still in flight", async () => {
      const created = deferred<{ id: string }>();
      const createDraft = jest.fn(() => created.promise);
      const updateDraft = jest.fn().mockResolvedValue(undefined);
      const engine = createDraftAutosave({ createDraft, updateDraft });

      engine.update({ lineItems: [{ qty: 3 }] }, META, true, true);
      const creating = engine.flush(); // POST in flight

      engine.update({ lineItems: [] }, META, true, false);
      const emptied = engine.flush(); // must ride the create, not bail out

      created.resolve({ id: "draft-6" });
      await Promise.all([creating, emptied]);

      expect(createDraft).toHaveBeenCalledTimes(1);
      expect(updateDraft).toHaveBeenCalledWith(
        expect.objectContaining({ id: "draft-6", payload: { lineItems: [] } }),
      );
    });

    it("defaults parkable to enabled when the caller omits it", async () => {
      const createDraft = jest.fn().mockResolvedValue({ id: "draft-7" });
      const updateDraft = jest.fn().mockResolvedValue(undefined);
      const engine = createDraftAutosave({ createDraft, updateDraft });

      engine.update({ v: 1 }, META, true, true);
      engine.update({ v: 2 }, META, true); // omitted ⇒ parkable, same as enabled
      await engine.flush();

      expect(createDraft).toHaveBeenCalledTimes(1);
    });
  });
});
