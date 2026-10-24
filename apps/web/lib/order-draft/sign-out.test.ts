import { countUnsentOrders, signOutDecision, unsentOrderCopy } from "./sign-out";
import { createDraftMirror } from "./mirror";
import { createMemoryDraftStorage } from "./storage";
import type { MirrorWriteInput } from "./mirror";

// SA-817 (A) 6 / A8: an explicit sign-out with unsent work asks first; a session expiry keeps the local copy.

const input = (localId: string, extra: Record<string, unknown> = {}): MirrorWriteInput => ({
  localId,
  serverDraftId: null,
  serverUpdatedAt: null,
  syncedHash: null,
  customerId: "c1",
  customerName: "Acme",
  payload: {
    customer: { id: "c1", businessName: "Acme" },
    lineItems: [{ tempId: "t1", productId: "p1", qty: 1 }],
    _submitKey: "K-1",
    ...extra,
  } as never,
});

describe("sign-out with unsent work (A8)", () => {
  it("A8: the copy reads 'You have 1 unsent order on this device'", () => {
    expect(unsentOrderCopy(1)).toBe("You have 1 unsent order on this device");
    expect(unsentOrderCopy(3)).toBe("You have 3 unsent orders on this device");
  });

  it("A8: an explicit sign-out with unsent work asks first; without any it does not", () => {
    expect(signOutDecision("explicit", 1).ask).toBe(true);
    expect(signOutDecision("explicit", 0).ask).toBe(false);
  });

  it("A8: a session expiry never asks - and no sign-out path ever deletes a local copy", () => {
    expect(signOutDecision("expired", 5)).toEqual({ ask: false, wipeLocalCopies: false });
    expect(signOutDecision("explicit", 5).wipeLocalCopies).toBe(false);
  });

  it("A8: counts only this tenant + user's unsent copies", async () => {
    const storage = createMemoryDraftStorage();
    const mine = createDraftMirror({ storage, tenantId: "t1", userId: "u1" });
    mine.write(input("a"));
    mine.write(input("b", { submittedAt: "2026-10-19T10:00:00.000Z" })); // already an order: not unsent
    await mine.flush();
    const other = createDraftMirror({ storage, tenantId: "t1", userId: "u2" });
    other.write(input("c"));
    await other.flush();

    expect(await countUnsentOrders(storage, "t1", "u1")).toBe(1);
    expect(await countUnsentOrders(storage, "t1", "u2")).toBe(1);
    expect(await countUnsentOrders(storage, "t2", "u1")).toBe(0);
    expect(await countUnsentOrders(storage, null, "u1")).toBe(0);
  });

  it("A8: an expiry leaves the copies where they are, ready for the same user's next sign-in", async () => {
    const storage = createMemoryDraftStorage();
    const m = createDraftMirror({ storage, tenantId: "t1", userId: "u1" });
    m.write(input("a"));
    await m.flush();
    // expiry: signOutDecision says nothing is asked and nothing is wiped; the store is not touched
    signOutDecision("expired", await countUnsentOrders(storage, "t1", "u1"));
    expect(await countUnsentOrders(storage, "t1", "u1")).toBe(1);
  });

  it("an unreadable store never traps the user on the page", async () => {
    const broken = {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => {
        throw new Error("IndexedDB blocked");
      },
    };
    expect(await countUnsentOrders(broken, "t1", "u1")).toBe(0);
  });
});
