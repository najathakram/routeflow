/**
 * returns-idem lane. The server honours an `Idempotency-Key` on POST /returns
 * (`apps/api/src/returns/returns.service.ts#create`), but that guard is inert until a client
 * sends the header — and a duplicate return, once approved, is a DOUBLE CUSTOMER CREDIT.
 *
 * Three jobs here:
 *   A. `lib/return-submit-key.ts` derives the key DETERMINISTICALLY from stop+order+goods+nonce,
 *      so a remount, an app kill or a reinstall re-derive the same value given the same nonce.
 *   B. source-text pins that the key is actually plumbed — `useCreateReturn` sends it as a
 *      HEADER (the `lib/api/orders.ts` idiom), and the driver return screen passes one per
 *      payload. Mobile Jest is pure-logic only (testEnvironment node, no renderer), so screen
 *      and hook wiring is pinned by reading the file as text, in the style of
 *      `driver-durability.test.ts`. Paths resolve from `__dirname`, never `process.cwd()`.
 *   C/D. F1 (independent review, PR-2): stopId+orderId+goods alone is deterministic BY DESIGN
 *      (job A), which silently collapsed a genuinely NEW later return for identical goods (the
 *      driver returns 2 units, then later finds 2 more of the same product) into an earlier,
 *      already-landed one — under-crediting the customer. `store/returnSubmissionStore.ts`'s
 *      per-attempt NONCE closes that: C pins the store's own nonce lifecycle, D composes it with
 *      job A's key derivation to prove the exact end-to-end claim the review made. The SERVER
 *      then collapsing/not-collapsing accordingly is returns-idempotency.spec.ts's job
 *      (REG-RET-IDEM-6/REG-RET-IDEM-7 there).
 *
 * Every locator below asserts it MATCHED — a regex run over a string that came back empty
 * would otherwise pass vacuously.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { returnSubmitKey, type ReturnSubmitKeyInput } from "../lib/return-submit-key";
import { useReturnSubmissionStore } from "../store/returnSubmissionStore";

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

jest.mock("../lib/auth", () => ({
  getStoredUser: jest.fn(async () => null),
}));

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const RETURNS_API_PATH = join(__dirname, "..", "lib", "api", "returns.ts");
const RETURN_SCREEN_PATH = join(
  __dirname,
  "..",
  "app",
  "(driver)",
  "route",
  "stop",
  "[stopId]",
  "return",
  "index.tsx",
);

const returnsApiSrc = readFileSync(RETURNS_API_PATH, "utf8");
const returnScreenSrc = readFileSync(RETURN_SCREEN_PATH, "utf8");

const payload = (
  orderId: string,
  items: Array<[string, number]>,
): ReturnSubmitKeyInput & { reason: string } => ({
  orderId,
  reason: "EXCESS_ORDER",
  items: items.map(([productId, qty]) => ({ productId, qty })),
});

describe("returnSubmitKey is deterministic and identity-bearing given a fixed nonce (REG-RETURNS-IDEM-A)", () => {
  it("re-derives the SAME key from the same stop, order, goods and nonce — the remount/reinstall case", () => {
    const p = payload("order-1", [
      ["prod-a", 2],
      ["prod-b", 1],
    ]);
    // A second, structurally identical payload object stands in for the one a fresh app
    // launch re-derives from `undeliveredReturnLines`. The nonce itself is what the STORE now
    // persists (job C below) — held fixed here to isolate THIS module's own determinism.
    const again = payload("order-1", [
      ["prod-a", 2],
      ["prod-b", 1],
    ]);
    expect(returnSubmitKey("stop-1", p, "nonce-1")).toBe(
      returnSubmitKey("stop-1", again, "nonce-1"),
    );
  });

  it("is insensitive to the order the lines arrive in", () => {
    const forward = payload("order-1", [
      ["prod-a", 2],
      ["prod-b", 1],
    ]);
    const reversed = payload("order-1", [
      ["prod-b", 1],
      ["prod-a", 2],
    ]);
    expect(returnSubmitKey("stop-1", forward, "nonce-1")).toBe(
      returnSubmitKey("stop-1", reversed, "nonce-1"),
    );
  });

  it("separates a different stop, a different order, a different product, a different qty and a different nonce", () => {
    const base = payload("order-1", [["prod-a", 2]]);
    const key = returnSubmitKey("stop-1", base, "nonce-1");
    expect(returnSubmitKey("stop-2", base, "nonce-1")).not.toBe(key);
    expect(returnSubmitKey("stop-1", payload("order-2", [["prod-a", 2]]), "nonce-1")).not.toBe(key);
    expect(returnSubmitKey("stop-1", payload("order-1", [["prod-b", 2]]), "nonce-1")).not.toBe(key);
    expect(returnSubmitKey("stop-1", payload("order-1", [["prod-a", 3]]), "nonce-1")).not.toBe(key);
    // An EXTRA returned line is a different return, not a replay of the smaller one.
    expect(
      returnSubmitKey(
        "stop-1",
        payload("order-1", [
          ["prod-a", 2],
          ["prod-b", 1],
        ]),
        "nonce-1",
      ),
    ).not.toBe(key);
    // F1: a different NONCE for otherwise-identical goods is a different return too (see job D
    // for why — this is the whole point of the fix).
    expect(returnSubmitKey("stop-1", base, "nonce-2")).not.toBe(key);
  });

  it("holds no state OF ITS OWN — the nonce lives in the store, not smuggled back into this module", () => {
    // Nothing to reset, nothing to clear here: this module exports pure functions of its
    // arguments, so there is no per-session slot that an app kill could drop (contrast
    // `lib/order-submit-key.ts`, which deliberately mints and holds one, and
    // `store/returnSubmissionStore.ts`, which is where F1's nonce actually lives — job C).
    const src = readFileSync(join(__dirname, "..", "lib", "return-submit-key.ts"), "utf8");
    expect(src.length).toBeGreaterThan(0);
    expect(src).not.toMatch(/new Map\(|Math\.random|AsyncStorage|useState/);
  });

  it("emits a header-safe value", () => {
    const key = returnSubmitKey("stop 1", payload("order/1", [["prod a", 2]]), "nonce-1");
    expect(key.length).toBeGreaterThan(0);
    // Printable ASCII only, so it can never produce an unsendable header.
    expect(key).toMatch(/^[A-Za-z0-9:,._-]+$/);
  });
});

describe("the key is plumbed onto POST /returns (REG-RETURNS-IDEM-B)", () => {
  it("useCreateReturn sends it as the idempotency-key HEADER, not in the body", () => {
    // TODAY (pre-fix): `mutationFn: (dto) => apiClient.post("/returns", dto)` — no header, no
    // destructure, so the server's replay guard never fires for any mobile return.
    expect(returnsApiSrc.length).toBeGreaterThan(0);
    expect(returnsApiSrc).toMatch(/mutationFn:\s*\(\{\s*idempotencyKey,\s*\.\.\.body\s*\}\)/);
    expect(returnsApiSrc).toMatch(/"idempotency-key":\s*idempotencyKey/);
    // The body must be the REST, never the whole dto (that would ship the key as a field).
    expect(returnsApiSrc).not.toMatch(/apiClient\.post\("\/returns",\s*dto\)/);
    const dtoMatch = returnsApiSrc.match(/export interface CreateReturnDto \{[\s\S]*?\n\}/);
    expect(dtoMatch).not.toBeNull();
    expect(dtoMatch![0]).toContain("idempotencyKey?: string;");
  });

  it("the driver return screen derives one key per payload from returnSubmitKey, keyed on a per-attempt nonce from the store (F1)", () => {
    // TODAY (pre-F1): `idempotencyKey: returnSubmitKey(stopId, p)` — no nonce, so a genuinely
    // new later return for identical goods silently collapsed onto an earlier landed one.
    expect(returnScreenSrc.length).toBeGreaterThan(0);
    expect(returnScreenSrc).toMatch(
      /import \{ returnSubmitKey \} from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/return-submit-key"/,
    );
    const mapMatch = returnScreenSrc.match(/toSend\.map\(\(p\) => \{[\s\S]{0,400}?\}\),/);
    expect(mapMatch).not.toBeNull();
    const mapBlock = mapMatch![0];
    // The nonce is keyed the SAME way the submitted-dedup set already is
    // (`submittedReturnKey`, lib/returns-logic.ts) — one convention, not two.
    expect(mapBlock).toMatch(/getOrCreateNonce\(submittedReturnKey\(stopId,\s*p\.orderId\)\)/);
    expect(mapBlock).toMatch(/idempotencyKey:\s*returnSubmitKey\(stopId,\s*p,\s*nonce\)/);
  });

  it("an all-submitted stop re-issues instead of silently bouncing the driver back", () => {
    // REG-RETURNS-IDEM-2. TODAY (pre-fix): `if (pending.length === 0) { backToStop(); return; }`
    // — a queued return that later hard-failed at drain left the persisted submitted-mark
    // standing with no unmark path, so the driver could never re-issue it.
    expect(returnScreenSrc).not.toMatch(
      /const pending = pendingReturnPayloads\([\s\S]{0,80}?\);\s*\n\s*if \(pending\.length === 0\) \{\s*\n\s*backToStop\(\);/,
    );
    expect(returnScreenSrc).toMatch(/const reissue = pending\.length === 0;/);
    expect(returnScreenSrc).toMatch(/const toSend = reissue \? payloads : pending;/);
    // Every downstream index must read from what was actually sent, or a re-issue would
    // attribute its results to the wrong orders.
    expect(returnScreenSrc).toMatch(/const orderId = toSend\[i\]!\.orderId;/);
    expect(returnScreenSrc).not.toContain("pending[i]!.orderId");
  });
});

describe("returnSubmissionStore — nonce lifecycle (REG-RETURNS-IDEM-C, F1)", () => {
  beforeEach(() => {
    useReturnSubmissionStore.getState().reset();
  });

  it("getOrCreateNonce mints once and returns the SAME value on every retry of the same pending attempt", () => {
    const key = "stop-1:ord-1";
    const first = useReturnSubmissionStore.getState().getOrCreateNonce(key);
    expect(first).toMatch(UUID_V4);
    expect(useReturnSubmissionStore.getState().getOrCreateNonce(key)).toBe(first);
    expect(useReturnSubmissionStore.getState().getOrCreateNonce(key)).toBe(first);
  });

  it("a DIFFERENT stop+order key mints its OWN nonce, independent of any other", () => {
    const a = useReturnSubmissionStore.getState().getOrCreateNonce("stop-1:ord-1");
    const b = useReturnSubmissionStore.getState().getOrCreateNonce("stop-1:ord-2");
    expect(b).not.toBe(a);
  });

  it("markSubmitted clears ONLY that attempt's nonce — the next getOrCreateNonce for it mints FRESH, other keys untouched", () => {
    const key = "stop-1:ord-1";
    const otherKey = "stop-1:ord-2";
    const firstNonce = useReturnSubmissionStore.getState().getOrCreateNonce(key);
    const otherNonce = useReturnSubmissionStore.getState().getOrCreateNonce(otherKey);

    useReturnSubmissionStore.getState().markSubmitted("stop-1", "ord-1");

    const nextNonce = useReturnSubmissionStore.getState().getOrCreateNonce(key);
    expect(nextNonce).not.toBe(firstNonce);
    // Marking ord-1 submitted must not disturb the unrelated ord-2 attempt's nonce.
    expect(useReturnSubmissionStore.getState().getOrCreateNonce(otherKey)).toBe(otherNonce);
  });

  it("reset() clears every nonce (sign-out teardown, RULINGS.md R1)", () => {
    const key = "stop-1:ord-1";
    const before = useReturnSubmissionStore.getState().getOrCreateNonce(key);
    useReturnSubmissionStore.getState().reset();
    expect(useReturnSubmissionStore.getState().getOrCreateNonce(key)).not.toBe(before);
  });
});

describe("F1 end-to-end: the composed claim from the review (REG-RETURNS-IDEM-D)", () => {
  beforeEach(() => {
    useReturnSubmissionStore.getState().reset();
  });

  const stopId = "stop-1";
  const p = payload("ord-1", [["p1", 2]]);
  // Mirrors lib/returns-logic.ts#submittedReturnKey(stopId, orderId) — the store is keyed the
  // same way `submitted` already was, so nonces and dedup share one convention.
  const submissionKey = `${stopId}:${p.orderId}`;

  it("two submit attempts BEFORE the first lands produce the IDENTICAL Idempotency-Key — a retry/replay collapses server-side", () => {
    const nonce1 = useReturnSubmissionStore.getState().getOrCreateNonce(submissionKey);
    const key1 = returnSubmitKey(stopId, p, nonce1);

    // A second tap/replay of the SAME pending attempt (network timeout, offline-queue drain, an
    // app kill mid-request) reads the SAME nonce because markSubmitted() was never called.
    const nonce2 = useReturnSubmissionStore.getState().getOrCreateNonce(submissionKey);
    const key2 = returnSubmitKey(stopId, p, nonce2);

    expect(key2).toBe(key1);
  });

  it("a submission for IDENTICAL goods AFTER the first attempt landed produces a DIFFERENT Idempotency-Key — the exact under-crediting scenario the review flagged (driver returns 2, later finds 2 more)", () => {
    const nonce1 = useReturnSubmissionStore.getState().getOrCreateNonce(submissionKey);
    const key1 = returnSubmitKey(stopId, p, nonce1);

    // The first attempt landed (or was queued) — production wiring calls this from
    // app/(driver)/route/stop/[stopId]/return/index.tsx's issue() for every settled order.
    useReturnSubmissionStore.getState().markSubmitted(stopId, p.orderId);

    // A LATER, genuinely new return for the SAME product/qty — content-identical to the first.
    const nonce2 = useReturnSubmissionStore.getState().getOrCreateNonce(submissionKey);
    const key2 = returnSubmitKey(stopId, p, nonce2);

    expect(key2).not.toBe(key1);
  });
});
