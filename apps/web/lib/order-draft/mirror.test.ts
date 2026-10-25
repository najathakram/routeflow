import { attachMirrorFlush, createDraftMirror, LOCAL_MIRROR_MS } from "./mirror";
import { payloadHash } from "./payload-hash";
import {
  createMemoryDraftStorage,
  mirrorKey,
  mirrorPrefix,
  type DraftMirrorStorage,
} from "./storage";
import type { MirrorWriteInput } from "./mirror";

// SA-817 (A) 1/6/7: the local mirror. Key shape, the 300 ms debounce, flush on visibilitychange / pagehide, tenant + user scoping
// (A7), and "a record exists iff the server does not hold an identical payload" (nothing else is ever auto-deleted).

const payload = (n: number) =>
  ({
    customer: { id: "c1", businessName: "Acme" },
    lineItems: Array.from({ length: n }, (_, i) => ({
      tempId: `t${i}`,
      productId: `p${i}`,
      qty: 1,
    })),
    _submitKey: "K-1",
  }) as unknown as MirrorWriteInput["payload"];

const input = (
  localId: string,
  n: number,
  over: Partial<MirrorWriteInput> = {},
): MirrorWriteInput => ({
  localId,
  serverDraftId: null,
  serverUpdatedAt: null,
  syncedHash: null,
  customerId: "c1",
  customerName: "Acme",
  payload: payload(n),
  ...over,
});

describe("order draft mirror (SA-817 A)", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("the key is rf:draft:{tenantId}:{userId}:{localId}", () => {
    expect(mirrorKey("t1", "u1", "L1")).toBe("rf:draft:t1:u1:L1");
    expect(mirrorPrefix("t1", "u1")).toBe("rf:draft:t1:u1:");
  });

  it("writes the latest state after a 300 ms debounce, not on every keystroke", async () => {
    const storage = createMemoryDraftStorage();
    const put = jest.spyOn(storage, "put");
    const mirror = createDraftMirror({ storage, tenantId: "t1", userId: "u1" });
    mirror.write(input("L1", 1));
    await jest.advanceTimersByTimeAsync(LOCAL_MIRROR_MS - 1);
    mirror.write(input("L1", 2));
    await jest.advanceTimersByTimeAsync(LOCAL_MIRROR_MS - 1);
    expect(put).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(put).toHaveBeenCalledTimes(1);
    const [rec] = await mirror.list();
    expect(rec.payload).toEqual(payload(2));
    expect(rec.hash).toBe(payloadHash(payload(2)));
  });

  it("flushes at once on visibilitychange (hidden) and on pagehide", async () => {
    const storage = createMemoryDraftStorage();
    const mirror = createDraftMirror({ storage, tenantId: "t1", userId: "u1" });
    const detach = attachMirrorFlush(mirror, document, window);

    mirror.write(input("L1", 1));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await jest.advanceTimersByTimeAsync(0);
    expect(await storage.list(mirrorPrefix("t1", "u1"))).toHaveLength(1);

    mirror.write(input("L1", 3));
    window.dispatchEvent(new Event("pagehide"));
    await jest.advanceTimersByTimeAsync(0);
    expect((await storage.list(mirrorPrefix("t1", "u1")))[0].payload).toEqual(payload(3));

    // a visible tab does not flush
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    mirror.write(input("L1", 4));
    document.dispatchEvent(new Event("visibilitychange"));
    await jest.advanceTimersByTimeAsync(0);
    expect((await storage.list(mirrorPrefix("t1", "u1")))[0].payload).toEqual(payload(3));

    detach();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await jest.advanceTimersByTimeAsync(0);
    expect((await storage.list(mirrorPrefix("t1", "u1")))[0].payload).toEqual(payload(3)); // detached
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  describe("A7 - a copy is never shown to another user or tenant in the same browser", () => {
    async function seeded(): Promise<DraftMirrorStorage> {
      const storage = createMemoryDraftStorage();
      for (const [tenant, user, id] of [
        ["t1", "u1", "mine"],
        ["t1", "u2", "other-user"],
        ["t2", "u1", "other-tenant"],
        ["t1", "u10", "prefix-lookalike-user"],
      ] as const) {
        const m = createDraftMirror({ storage, tenantId: tenant, userId: user });
        m.write(input(id, 1));
        await m.flush();
      }
      return storage;
    }

    it("A7: user X lists only their own copies; user Y and another tenant see none of them", async () => {
      const storage = await seeded();
      const x = createDraftMirror({ storage, tenantId: "t1", userId: "u1" });
      expect((await x.list()).map((r) => r.localId)).toEqual(["mine"]);

      const y = createDraftMirror({ storage, tenantId: "t1", userId: "u2" });
      expect((await y.list()).map((r) => r.localId)).toEqual(["other-user"]);

      const otherTenant = createDraftMirror({ storage, tenantId: "t2", userId: "u1" });
      expect((await otherTenant.list()).map((r) => r.localId)).toEqual(["other-tenant"]);

      const stranger = createDraftMirror({ storage, tenantId: "t3", userId: "u1" });
      expect(await stranger.list()).toEqual([]);
    });

    it("A7: u1 never lists u10's copy (the prefix ends with the separator)", async () => {
      const storage = await seeded();
      const x = createDraftMirror({ storage, tenantId: "t1", userId: "u1" });
      expect((await x.list()).map((r) => r.localId)).not.toContain("prefix-lookalike-user");
    });

    it("A7: a record carries only ids, quantities, staff-typed fields and customerName", async () => {
      const storage = createMemoryDraftStorage();
      const m = createDraftMirror({ storage, tenantId: "t1", userId: "u1" });
      m.write(input("L1", 1));
      await m.flush();
      const [rec] = await m.list();
      expect(Object.keys(rec).sort()).toEqual(
        [
          "customerId",
          "customerName",
          "hash",
          "localId",
          "payload",
          "savedAt",
          "serverDraftId",
          "serverUpdatedAt",
          "syncedHash",
          "tenantId",
          "userId",
        ].sort(),
      );
    });
  });

  describe("expiry - nothing is auto-deleted", () => {
    it("a copy the server never confirmed is kept, however many times it is rewritten", async () => {
      const storage = createMemoryDraftStorage();
      const m = createDraftMirror({ storage, tenantId: "t1", userId: "u1" });
      for (let n = 1; n <= 4; n += 1) {
        m.write(input("L1", n));
        await m.flush();
      }
      expect(await m.list()).toHaveLength(1);
    });

    it("a copy is deleted once the server holds an identical payload hash - and only then", async () => {
      const storage = createMemoryDraftStorage();
      const m = createDraftMirror({ storage, tenantId: "t1", userId: "u1" });
      m.write(input("L1", 2));
      await m.flush();
      // the server confirmed an OLDER payload: the copy still has something the server lacks
      m.write(input("L1", 2, { serverDraftId: "d1", syncedHash: payloadHash(payload(1)) }));
      await m.flush();
      expect(await m.list()).toHaveLength(1);
      // the server confirmed exactly this payload
      m.write(input("L1", 2, { serverDraftId: "d1", syncedHash: payloadHash(payload(2)) }));
      await jest.advanceTimersByTimeAsync(0);
      expect(await m.list()).toEqual([]);
    });

    it("remove() (the order was submitted, or the user discarded it) cancels a pending write and deletes the copy", async () => {
      const storage = createMemoryDraftStorage();
      const m = createDraftMirror({ storage, tenantId: "t1", userId: "u1" });
      m.write(input("L1", 1));
      await m.flush();
      m.write(input("L1", 2)); // pending
      await m.remove("L1");
      await jest.advanceTimersByTimeAsync(LOCAL_MIRROR_MS * 2);
      expect(await m.list()).toEqual([]);
    });
  });
});
