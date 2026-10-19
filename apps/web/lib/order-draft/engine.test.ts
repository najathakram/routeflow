import { readDraftSubmitKey } from "@routeflow/types/draft-submit-key";
import { createOrderDraftEngine, DRAFT_AUTOSAVE_MS, DraftConflictError } from "./engine";
import type { DraftPayload, DraftRowMeta, ServerDraftSnapshot } from "./engine";
import { createDraftMirror, LOCAL_MIRROR_MS } from "./mirror";
import { payloadHash } from "./payload-hash";
import { createMemoryDraftStorage, mirrorPrefix } from "./storage";

// SA-817 (A) - the web autosave engine: A2 (autosave from the first parkable change, no Minimize), A3 (offline edits keep the
// local mirror current; reconnecting gives exactly one PATCH), A4 (device B changed the draft: 409 DRAFT_CHANGED, both versions
// kept, nothing overwritten). Pure closures over fake timers and the in-memory storage adapter.

const T = (n: number) => `2026-10-19T10:00:0${n}.000Z`;
const META: DraftRowMeta = {
  kind: "ORDER",
  customerId: "c1",
  customerName: "Acme",
  title: "Order, Acme",
};
const payload = (lines: number, key = "K-1"): DraftPayload =>
  ({
    customer: { id: "c1", businessName: "Acme" },
    lineItems: Array.from({ length: lines }, (_, i) => ({
      tempId: `t${i}`,
      productId: `p${i}`,
      qty: 1,
      unitPrice: 10,
    })),
    _submitKey: key,
  }) as unknown as DraftPayload;

const networkError = () => Object.assign(new Error("Network Error"), { response: undefined });
const draftChanged = (current: ServerDraftSnapshot) =>
  Object.assign(new Error("Conflict"), {
    response: { status: 409, data: { code: "DRAFT_CHANGED", current } },
  });

function setup() {
  const storage = createMemoryDraftStorage();
  const mirror = createDraftMirror({ storage, tenantId: "t1", userId: "u1" });
  let stamp = 0;
  const createDraft = jest.fn(async (_: unknown) => ({ id: "d1", updatedAt: T(stamp++) }));
  const updateDraft = jest.fn(async (_: unknown) => ({ id: "d1", updatedAt: T(stamp++) }));
  const onConflict = jest.fn();
  const engine = createOrderDraftEngine({
    localId: "L1",
    createDraft: createDraft as never,
    updateDraft: updateDraft as never,
    mirror,
    parseConflict: (err) =>
      (err as { response?: { data?: { current?: ServerDraftSnapshot } } })?.response?.data
        ?.current ?? null,
    isGone: (err) => (err as { response?: { status?: number } })?.response?.status === 404,
    mintKey: () => "K-NEW",
    onConflict,
  });
  const local = () => storage.list(mirrorPrefix("t1", "u1"));
  return { storage, mirror, engine, createDraft, updateDraft, onConflict, local };
}

describe("order draft engine (SA-817 A)", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  describe("A2 - autosave from the first parkable change", () => {
    it("A2: creates the server draft 900 ms after the first parkable change, with no Minimize or flush", async () => {
      const { engine, createDraft } = setup();
      engine.update(payload(1), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS - 1);
      expect(createDraft).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(createDraft).toHaveBeenCalledTimes(1);
      expect(createDraft).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "ORDER", customerId: "c1", payload: payload(1) }),
      );
      expect(engine.draftId).toBe("d1");
    });

    it("A2: a state that is not parkable (no customer or no line) creates nothing", async () => {
      const { engine, createDraft } = setup();
      engine.update(payload(0), META, true, false);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(createDraft).not.toHaveBeenCalled();
    });

    it("A2: edits in a burst make ONE create (single-flight latch), then PATCHes carry the latest state", async () => {
      const { engine, createDraft, updateDraft } = setup();
      engine.update(payload(1), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS);
      engine.update(payload(2), META, true, true);
      engine.update(payload(3), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS);
      expect(createDraft).toHaveBeenCalledTimes(1);
      expect(updateDraft).toHaveBeenCalledTimes(1);
      expect(updateDraft).toHaveBeenCalledWith(
        expect.objectContaining({ id: "d1", payload: payload(3) }),
      );
    });

    it("A2: an unchanged payload is not written again", async () => {
      const { engine, createDraft, updateDraft } = setup();
      engine.update(payload(1), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS);
      engine.update(payload(1), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS * 2);
      expect(createDraft).toHaveBeenCalledTimes(1);
      expect(updateDraft).not.toHaveBeenCalled();
    });

    it("A2: once bound, the next PATCH carries the updatedAt the server last returned as expectedUpdatedAt", async () => {
      const { engine, updateDraft } = setup();
      engine.update(payload(1), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS);
      engine.update(payload(2), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS);
      expect(updateDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({ expectedUpdatedAt: T(0) }),
      );
      engine.update(payload(3), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS);
      expect(updateDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({ expectedUpdatedAt: T(1) }),
      );
    });

    it("A2: an emptied cart is still written onto an already-bound draft", async () => {
      const { engine, updateDraft } = setup();
      engine.update(payload(1), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS);
      engine.update(payload(0), META, true, false);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS);
      expect(updateDraft).toHaveBeenCalledWith(expect.objectContaining({ payload: payload(0) }));
    });

    it("A2: discard is final - nothing is written after the order exists", async () => {
      const { engine, createDraft } = setup();
      engine.update(payload(1), META, true, true);
      engine.discard();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(createDraft).not.toHaveBeenCalled();
    });
  });

  describe("A3 - offline edits keep the local mirror current; reconnecting gives exactly one PATCH", () => {
    it("A3: with the network off, every edit lands in the local mirror and the server is not reached", async () => {
      const { engine, updateDraft, createDraft, local } = setup();
      createDraft.mockRejectedValue(networkError());
      updateDraft.mockRejectedValue(networkError());
      engine.update(payload(1), META, true, true);
      await jest.advanceTimersByTimeAsync(LOCAL_MIRROR_MS);
      expect((await local()).map((r) => r.payload)).toEqual([payload(1)]);
      engine.update(payload(2), META, true, true);
      await jest.advanceTimersByTimeAsync(LOCAL_MIRROR_MS);
      engine.update(payload(3), META, true, true);
      await jest.advanceTimersByTimeAsync(LOCAL_MIRROR_MS);
      const [record] = await local();
      expect(record.payload).toEqual(payload(3));
      expect(record.hash).toBe(payloadHash(payload(3)));
      expect(record.syncedHash).toBeNull(); // the server never confirmed anything: this copy is never auto-deleted
    });

    it("A3: reconnecting gives exactly ONE PATCH that brings the server up to the local copy, then the mirror is released", async () => {
      const { engine, updateDraft, createDraft, local } = setup();
      // online: the draft is created and synced
      engine.update(payload(1), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS);
      expect(createDraft).toHaveBeenCalledTimes(1);
      // the connection drops: edits keep failing to reach the server
      updateDraft.mockRejectedValue(networkError());
      engine.update(payload(2), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS);
      engine.update(payload(3), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS);
      expect((await local())[0].payload).toEqual(payload(3)); // the mirror is current
      // the connection returns
      updateDraft.mockClear();
      updateDraft.mockImplementation(async () => ({ id: "d1", updatedAt: T(5) }));
      await engine.flush();
      expect(updateDraft).toHaveBeenCalledTimes(1);
      expect(updateDraft).toHaveBeenCalledWith(
        expect.objectContaining({ id: "d1", payload: payload(3), expectedUpdatedAt: T(0) }),
      );
      await jest.advanceTimersByTimeAsync(10);
      expect(await local()).toEqual([]); // the server holds an identical payload: nothing local to keep
      await engine.flush();
      expect(updateDraft).toHaveBeenCalledTimes(1); // and nothing more is sent
    });

    it("A3: a failed first create is retried with the latest state on the next save", async () => {
      const { engine, createDraft } = setup();
      createDraft.mockRejectedValueOnce(networkError());
      engine.update(payload(1), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS);
      engine.update(payload(2), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS);
      expect(createDraft).toHaveBeenCalledTimes(2);
      expect(createDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({ payload: payload(2) }),
      );
    });
  });

  describe("A4 - another device changed the draft: both versions are kept, nothing is overwritten", () => {
    const theirs: ServerDraftSnapshot = {
      id: "d1",
      updatedAt: T(9),
      payload: { ...(payload(5, "K-1") as object), from: "device-b" },
    };

    async function conflicted() {
      const s = setup();
      s.engine.update(payload(1), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS);
      s.updateDraft.mockRejectedValue(draftChanged(theirs));
      s.engine.update(payload(2), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS);
      return s;
    }

    it("A4: a 409 DRAFT_CHANGED suspends saving and reports BOTH versions; the server copy is not touched again", async () => {
      const { engine, onConflict, updateDraft, createDraft } = await conflicted();
      expect(onConflict).toHaveBeenCalledTimes(1);
      expect(onConflict).toHaveBeenCalledWith({ mine: payload(2), current: theirs });
      expect(engine.conflict).toEqual({ mine: payload(2), current: theirs });
      // further edits and timers write nothing to the server until the user chooses
      updateDraft.mockClear();
      engine.update(payload(3), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS * 3);
      expect(updateDraft).not.toHaveBeenCalled();
      expect(createDraft).toHaveBeenCalledTimes(1);
      await expect(engine.flush()).rejects.toBeInstanceOf(DraftConflictError);
    });

    it("A4: the local mirror keeps this device's version while the conflict is open", async () => {
      const { engine, local } = await conflicted();
      engine.update(payload(3), META, true, true);
      await jest.advanceTimersByTimeAsync(LOCAL_MIRROR_MS);
      expect((await local())[0].payload).toEqual(payload(3));
    });

    it("A4: 'Keep this one' parks this device's version as its OWN new draft with its OWN submit key; the other device's draft is never written", async () => {
      const { engine, createDraft, updateDraft } = await conflicted();
      updateDraft.mockClear();
      createDraft.mockClear();
      createDraft.mockResolvedValueOnce({ id: "d2", updatedAt: T(7) });
      const res = await engine.resolveConflict("keep-mine");
      expect(createDraft).toHaveBeenCalledTimes(1);
      const sent = (createDraft.mock.calls[0][0] as { payload: DraftPayload }).payload;
      expect(readDraftSubmitKey(sent)).toBe("K-NEW"); // the original key stays with the draft device B changed
      expect(sent).toMatchObject({ lineItems: (payload(2) as { lineItems: unknown[] }).lineItems });
      expect(updateDraft).not.toHaveBeenCalled(); // nothing overwrote d1
      expect(res).toEqual(expect.objectContaining({ choice: "keep-mine", draftId: "d2" }));
      expect(engine.draftId).toBe("d2");
      expect(engine.conflict).toBeNull();
      // saving resumes against the NEW draft
      updateDraft.mockResolvedValue({ id: "d2", updatedAt: T(8) });
      engine.update(payload(4, "K-NEW"), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS);
      expect(updateDraft).toHaveBeenCalledWith(
        expect.objectContaining({ id: "d2", expectedUpdatedAt: T(7) }),
      );
    });

    it("A4: 'Open the other' parks this device's version as a new draft and hands back the other device's version to show", async () => {
      const { engine, createDraft, updateDraft } = await conflicted();
      updateDraft.mockClear();
      createDraft.mockClear();
      createDraft.mockResolvedValueOnce({ id: "d3", updatedAt: T(8) });
      const res = await engine.resolveConflict("open-other");
      expect(createDraft).toHaveBeenCalledTimes(1);
      expect(
        readDraftSubmitKey((createDraft.mock.calls[0][0] as { payload: DraftPayload }).payload),
      ).toBe("K-NEW");
      expect(res).toEqual({ choice: "open-other", current: theirs, parkedDraftId: "d3" });
      expect(updateDraft).not.toHaveBeenCalled();
      expect(engine.draftId).toBe("d1");
      expect(engine.serverUpdatedAt).toBe(T(9)); // the next save is checked against THEIR version
    });
  });

  describe("a draft deleted elsewhere", () => {
    it("a 404 on PATCH forgets the binding and creates a fresh draft from the same state", async () => {
      const { engine, createDraft, updateDraft } = setup();
      engine.update(payload(1), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS);
      updateDraft.mockRejectedValueOnce(
        Object.assign(new Error("gone"), { response: { status: 404 } }),
      );
      createDraft.mockResolvedValueOnce({ id: "d9", updatedAt: T(6) });
      engine.update(payload(2), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS);
      expect(createDraft).toHaveBeenCalledTimes(2);
      expect(createDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({ payload: payload(2) }),
      );
      expect(engine.draftId).toBe("d9");
    });
  });

  describe("hydrate (a resume)", () => {
    it("hydrating a draft the server holds writes nothing; a local copy that is ahead PATCHes once with the saved updatedAt", async () => {
      const synced = setup();
      synced.engine.hydrate({
        draftId: "d1",
        updatedAt: T(1),
        syncedHash: payloadHash(payload(2)),
        payload: payload(2),
        meta: META,
        inSync: true,
      });
      synced.engine.update(payload(2), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS * 2);
      expect(synced.updateDraft).not.toHaveBeenCalled();

      const ahead = setup();
      ahead.engine.hydrate({
        draftId: "d1",
        updatedAt: T(1),
        syncedHash: payloadHash(payload(1)),
        payload: payload(3),
        meta: META,
        inSync: false,
      });
      ahead.engine.update(payload(3), META, true, true);
      await jest.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_MS);
      expect(ahead.updateDraft).toHaveBeenCalledTimes(1);
      expect(ahead.updateDraft).toHaveBeenCalledWith(
        expect.objectContaining({ id: "d1", payload: payload(3), expectedUpdatedAt: T(1) }),
      );
    });
  });
});
