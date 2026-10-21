import { readFileSync } from "fs";
import { join } from "path";
import {
  DRAFT_SUBMIT_KEY_FIELD,
  isDraftSubmitKey,
  readDraftSubmitKey,
  resolveDraftSubmitKey,
  withDraftSubmitKey,
} from "@routeflow/types/draft-submit-key";
import {
  adoptOrderSubmitKey,
  clearAllOrderSubmitKeys,
  getOrderSubmitKey,
  resetOrderSubmitKey,
  seedOrderSubmitKeyFromDraft,
} from "../lib/order-submit-key";

/**
 * SA-817 (A) 4 / A6, mobile half: ONE submit key per draft, persisted in the draft (`payload._submitKey`). The module's map is
 * process memory; a resumed draft re-seeds it from its payload BEFORE the screen first reads a key, so a resubmit after an app
 * kill replays the key the first attempt used (one order).
 */
const src = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8");

describe("draft submit key rule (shared with web)", () => {
  it("the field is _submitKey", () => {
    expect(DRAFT_SUBMIT_KEY_FIELD).toBe("_submitKey");
  });

  it("reads a legal key and nothing else", () => {
    expect(readDraftSubmitKey({ _submitKey: "abc-123" })).toBe("abc-123");
    for (const bad of [
      null,
      undefined,
      7,
      {},
      { _submitKey: "" },
      { _submitKey: "a b" },
      { _submitKey: "x".repeat(129) },
    ]) {
      expect(readDraftSubmitKey(bad)).toBeNull();
    }
    expect(isDraftSubmitKey("K-1")).toBe(true);
    expect(isDraftSubmitKey("has space")).toBe(false);
  });

  it("withDraftSubmitKey copies the payload and sets the key, leaving every other field alone", () => {
    const payload = { lineItems: [1], notes: "n" };
    const out = withDraftSubmitKey(payload, "K-2");
    expect(out).toEqual({ lineItems: [1], notes: "n", _submitKey: "K-2" });
    expect(payload).toEqual({ lineItems: [1], notes: "n" });
  });

  it("resolveDraftSubmitKey prefers the persisted key and only mints when the draft has none", () => {
    const mint = jest.fn(() => "minted");
    expect(resolveDraftSubmitKey({ _submitKey: "persisted" }, mint)).toBe("persisted");
    expect(mint).not.toHaveBeenCalled();
    expect(resolveDraftSubmitKey({}, mint)).toBe("minted");
  });
});

describe("order-submit-key re-seeded from the draft (A6)", () => {
  beforeEach(() => clearAllOrderSubmitKeys());

  it("A6: after an app kill (empty map) a resumed draft's own key is what the resubmit sends", () => {
    const first = getOrderSubmitKey("cust-1");
    const persisted = withDraftSubmitKey({ lineItems: [] }, first); // what the autosave wrote to the draft
    clearAllOrderSubmitKeys(); // the process died: the map is gone
    expect(getOrderSubmitKey("cust-1")).not.toBe(first); // WITHOUT the draft a restart really would mint a sibling key

    clearAllOrderSubmitKeys();
    expect(seedOrderSubmitKeyFromDraft("cust-1", persisted)).toBe(first);
    expect(getOrderSubmitKey("cust-1")).toBe(first);
  });

  it("Opus MUST 3: a resumed draft with NO _submitKey gets a FRESH key - never the customer slot's key, which may belong to another draft", () => {
    const slot = getOrderSubmitKey("cust-1"); // another draft of cust-1 holds this one
    const fresh = seedOrderSubmitKeyFromDraft("cust-1", { lineItems: [] });
    expect(fresh).not.toBe(slot);
    expect(isDraftSubmitKey(fresh)).toBe(true);
    expect(getOrderSubmitKey("cust-1")).toBe(fresh); // and the screen's next read sends it
  });

  it("Opus MUST 3: two key-less drafts of the same customer do not share a key", () => {
    const a = seedOrderSubmitKeyFromDraft("cust-1", { lineItems: [] });
    const b = seedOrderSubmitKeyFromDraft("cust-1", { lineItems: [] });
    expect(a).not.toBe(b);
  });

  it("seeding is per customer: another customer's slot is untouched", () => {
    const b = getOrderSubmitKey("cust-b");
    seedOrderSubmitKeyFromDraft("cust-a", { _submitKey: "K-A" });
    expect(getOrderSubmitKey("cust-a")).toBe("K-A");
    expect(getOrderSubmitKey("cust-b")).toBe(b);
  });

  it("adopt replaces the slot; a successful submit still ends it (the next cart is a new order)", () => {
    getOrderSubmitKey("cust-1");
    adoptOrderSubmitKey("cust-1", "K-ADOPTED");
    expect(getOrderSubmitKey("cust-1")).toBe("K-ADOPTED");
    resetOrderSubmitKey("cust-1");
    expect(getOrderSubmitKey("cust-1")).not.toBe("K-ADOPTED");
  });
});

describe("NewOrderScreen wiring (A6)", () => {
  const screen = src("components", "NewOrderScreen.tsx");

  it("settles the key slot BEFORE the first key is read: a resume re-seeds it, a new cart resets it", () => {
    const settle = screen.indexOf("keySlotSettledRef");
    const firstRead = screen.indexOf("withDraftSubmitKey(toOrderDraftPayload");
    expect(settle).toBeGreaterThan(-1);
    expect(firstRead).toBeGreaterThan(settle);
    expect(screen).toMatch(/seedOrderSubmitKeyFromDraft\(customerId, initialDraft\.payload\)/);
    // the old mount effect reset the slot AFTER the render had already minted into it
    expect(screen).not.toMatch(
      /useEffect\(\(\) => \{[^}]*if \(!initialDraft\) resetOrderSubmitKey/,
    );
  });

  it("the draft payload carries the customer's key, so every autosave writes it to the server draft", () => {
    expect(screen).toMatch(
      /withDraftSubmitKey\(\s*toOrderDraftPayload\(draftBuilderState\),\s*getOrderSubmitKey\(customerId\),?\s*\)/,
    );
  });

  it("the submit still sends the same slot's key and resets it only on success", () => {
    expect(screen).toMatch(/idempotencyKey:\s*getOrderSubmitKey\(customerId\)/);
    expect(screen).toMatch(/resetOrderSubmitKey\(customerId\)/);
  });
});

describe("the stale comment (SA-817 fact pack)", () => {
  it("order-submit-key.ts no longer claims an offline-queue replay or a key that outlives the process", () => {
    const text = src("lib", "order-submit-key.ts");
    expect(text).not.toMatch(/offline[- ]queue replay/i);
    expect(text).toMatch(/PROCESS MEMORY/);
    expect(text).toMatch(/_submitKey/);
  });
});

describe("the stale NewOrderScreen comments (coordinator)", () => {
  it("no longer says offline draft writes are queued (they are online-only, refused with isOnlineRequired)", () => {
    const text = src("components", "NewOrderScreen.tsx");
    expect(text).not.toMatch(/api-client queues that write/);
    expect(text).not.toMatch(/rejected draft write \(offline queue/);
    expect(text).toMatch(/ONLINE-ONLY/);
  });
});
