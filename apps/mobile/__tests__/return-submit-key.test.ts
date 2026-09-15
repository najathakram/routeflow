/**
 * returns-idem lane. The server honours an `Idempotency-Key` on POST /returns
 * (`apps/api/src/returns/returns.service.ts#create`), but that guard is inert until a client
 * sends the header — and a duplicate return, once approved, is a DOUBLE CUSTOMER CREDIT.
 *
 * Two jobs here:
 *   A. `lib/return-submit-key.ts` derives the key DETERMINISTICALLY, so a remount, an app kill
 *      or a reinstall re-derive the same value with nothing persisted.
 *   B. source-text pins that the key is actually plumbed — `useCreateReturn` sends it as a
 *      HEADER (the `lib/api/orders.ts` idiom), and the driver return screen passes one per
 *      payload. Mobile Jest is pure-logic only (testEnvironment node, no renderer), so screen
 *      and hook wiring is pinned by reading the file as text, in the style of
 *      `driver-durability.test.ts`. Paths resolve from `__dirname`, never `process.cwd()`.
 *
 * Every locator below asserts it MATCHED — a regex run over a string that came back empty
 * would otherwise pass vacuously.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { returnSubmitKey, type ReturnSubmitKeyInput } from "../lib/return-submit-key";

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

describe("returnSubmitKey is deterministic and identity-bearing (REG-RETURNS-IDEM-A)", () => {
  it("re-derives the SAME key from the same stop, order and goods — the remount/reinstall case", () => {
    const p = payload("order-1", [
      ["prod-a", 2],
      ["prod-b", 1],
    ]);
    // A second, structurally identical payload object stands in for the one a fresh app
    // launch re-derives from `undeliveredReturnLines`.
    const again = payload("order-1", [
      ["prod-a", 2],
      ["prod-b", 1],
    ]);
    expect(returnSubmitKey("stop-1", p)).toBe(returnSubmitKey("stop-1", again));
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
    expect(returnSubmitKey("stop-1", forward)).toBe(returnSubmitKey("stop-1", reversed));
  });

  it("separates a different stop, a different order, a different product and a different qty", () => {
    const base = payload("order-1", [["prod-a", 2]]);
    const key = returnSubmitKey("stop-1", base);
    expect(returnSubmitKey("stop-2", base)).not.toBe(key);
    expect(returnSubmitKey("stop-1", payload("order-2", [["prod-a", 2]]))).not.toBe(key);
    expect(returnSubmitKey("stop-1", payload("order-1", [["prod-b", 2]]))).not.toBe(key);
    expect(returnSubmitKey("stop-1", payload("order-1", [["prod-a", 3]]))).not.toBe(key);
    // An EXTRA returned line is a different return, not a replay of the smaller one.
    expect(
      returnSubmitKey(
        "stop-1",
        payload("order-1", [
          ["prod-a", 2],
          ["prod-b", 1],
        ]),
      ),
    ).not.toBe(key);
  });

  it("holds no state — the key survives nothing being kept between calls", () => {
    // Nothing to reset, nothing to clear: the module exports exactly one function, so there is
    // no per-session slot that an app kill could drop (contrast `lib/order-submit-key.ts`,
    // which deliberately mints and holds one).
    const src = readFileSync(join(__dirname, "..", "lib", "return-submit-key.ts"), "utf8");
    expect(src.length).toBeGreaterThan(0);
    expect(src).not.toMatch(/new Map\(|Math\.random|AsyncStorage|useState/);
  });

  it("emits a header-safe value", () => {
    const key = returnSubmitKey("stop 1", payload("order/1", [["prod a", 2]]));
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

  it("the driver return screen derives one key per payload from returnSubmitKey", () => {
    // TODAY (pre-fix): `pending.map((p) => createReturn.mutateAsync(p))` — the payload alone.
    expect(returnScreenSrc.length).toBeGreaterThan(0);
    expect(returnScreenSrc).toMatch(
      /import \{ returnSubmitKey \} from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/return-submit-key"/,
    );
    const callMatch = returnScreenSrc.match(/createReturn\.mutateAsync\(\{[\s\S]{0,120}?\}\)/);
    expect(callMatch).not.toBeNull();
    expect(callMatch![0]).toMatch(/\.\.\.p,\s*idempotencyKey:\s*returnSubmitKey\(stopId,\s*p\)/);
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
