import { createOrderDraftEngine, DraftConflictError } from "./engine";
import type { DraftPayload, DraftRowMeta, ServerDraftSnapshot } from "./engine";
import { createDraftMirror, LOCAL_MIRROR_MS } from "./mirror";
import { findResumable } from "./resume";
import { payloadHash } from "./payload-hash";
import { createMemoryDraftStorage, mirrorPrefix } from "./storage";
import type { LocalDraftRecord } from "./storage";

// SA-1222 PR-A: the one draft engine serves a PURCHASE_ORDER kind. Keep-both copies the draft's OWN kind, the
// error copy names no document, the mirror record carries its kind, and the ORDER resume scan reads orders only.

const PO_META: DraftRowMeta = { kind: "PURCHASE_ORDER", title: "Acme Supply" };
const po = (lines: number, key = "K-1"): DraftPayload =>
  ({
    v: 1,
    supplierId: "sup-1",
    lines: Array.from({ length: lines }, (_, i) => ({ productId: `p${i}`, unitCost: 2 })),
    _submitKey: key,
  }) as unknown as DraftPayload;

describe("order draft engine: PURCHASE_ORDER kind (SA-1222)", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function setup() {
    const storage = createMemoryDraftStorage();
    const mirror = createDraftMirror({ storage, tenantId: "t1", userId: "u1" });
    const createDraft = jest.fn(async (_: unknown) => ({ id: "parked", updatedAt: "T2" }));
    const updateDraft = jest.fn(async (_: unknown) => ({ id: "d1", updatedAt: "T3" }));
    const engine = createOrderDraftEngine({
      localId: "L1",
      createDraft: createDraft as never,
      updateDraft: updateDraft as never,
      mirror,
      parseConflict: (err) =>
        (err as { response?: { data?: { current?: ServerDraftSnapshot } } })?.response?.data
          ?.current ?? null,
      mintKey: () => "K-NEW",
    });
    return { storage, engine, createDraft, updateDraft };
  }

  it("R5: keep-both (keepKey) on a PO draft parks the other version with kind PURCHASE_ORDER", async () => {
    const { engine, createDraft, updateDraft } = setup();
    const current: ServerDraftSnapshot = {
      id: "d1",
      updatedAt: "T1",
      payload: po(2, "K-OTHER") as never,
      title: "Acme Supply",
    };
    engine.hydrate({
      draftId: "d1",
      updatedAt: "T0",
      syncedHash: payloadHash(po(1)),
      payload: po(1),
      meta: PO_META,
      inSync: true,
    });
    updateDraft.mockRejectedValueOnce(
      Object.assign(new Error("Conflict"), {
        response: { status: 409, data: { code: "DRAFT_CHANGED", current } },
      }),
    );
    engine.update(po(3), PO_META, true, true);
    await jest.advanceTimersByTimeAsync(1000);
    expect(engine.conflict).not.toBeNull();
    await engine.resolveConflict("keep-mine", { keepKey: true });
    expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({ kind: "PURCHASE_ORDER" }));
  });

  it("the conflict error names no document", () => {
    expect(new DraftConflictError().message).toBe("This was changed on another device.");
  });

  it("the mirror record keeps the draft's kind (a record with none reads as an order)", async () => {
    const { engine, storage } = setup();
    engine.update(po(1), PO_META, true, true);
    await jest.advanceTimersByTimeAsync(LOCAL_MIRROR_MS + 1);
    const records = await storage.list(mirrorPrefix("t1", "u1"));
    expect(records.map((r) => r.kind)).toEqual(["PURCHASE_ORDER"]);
  });

  describe("R6: the ORDER resume scan", () => {
    const poRecord = (over: Partial<LocalDraftRecord> = {}): LocalDraftRecord => {
      const p = po(1) as LocalDraftRecord["payload"];
      return {
        localId: "LPO",
        tenantId: "t1",
        userId: "u1",
        kind: "PURCHASE_ORDER",
        serverDraftId: "d1",
        serverUpdatedAt: "T1",
        syncedHash: null,
        customerId: null,
        customerName: null,
        payload: p,
        hash: payloadHash(p),
        savedAt: "2026-11-22T10:00:00.000Z",
        ...over,
      };
    };

    it("ignores a PO mirror record: it is neither offered nor marked obsolete (the server holds the same payload)", () => {
      const rec = poRecord();
      const server = [{ id: "d1", updatedAt: "T1", payload: rec.payload }];
      const scan = findResumable([rec], server);
      expect(scan.obsolete).toEqual([]);
      expect(scan.resumable).toEqual([]);
    });

    it("still reads a record with no kind (written before this change) as an order", () => {
      const p = {
        customer: { id: "c1" },
        lineItems: [{ productId: "p1" }],
        _submitKey: "K",
      } as LocalDraftRecord["payload"];
      const legacy = poRecord({ kind: undefined, payload: p, hash: payloadHash(p) });
      expect(findResumable([legacy], []).resumable).toHaveLength(1);
    });
  });
});
