/**
 * #3219 follow-up: the web hides Cancel when `findOne` says `cancelBlockedReason: "WITH_CARRIER"` (the
 * parcel is with the carrier; a cancel would credit its stock back while it is still out). The mobile
 * order screen mirrors it: no Cancel action, the same fixed copy. Pure logic (no screen mount).
 */
import { cancelBlockedNote, statusActions, WITH_CARRIER_COPY } from "../lib/order-actions";
import type { OrderStatus } from "../lib/api/orders";

const CANCELLABLE: OrderStatus[] = [
  "PENDING",
  "CONFIRMED",
  "OUT_FOR_DELIVERY",
  "PARTIALLY_DELIVERED",
];
const cancels = (actions: ReturnType<typeof statusActions>) =>
  actions.filter((a) => a.toStatus === "CANCELLED");

describe("statusActions — cancelBlockedReason WITH_CARRIER hides Cancel", () => {
  it.each(CANCELLABLE)("%s: no Cancel action when the server says WITH_CARRIER", (status) => {
    expect(cancels(statusActions(status, "SHIP", "WITH_CARRIER"))).toEqual([]);
  });

  it.each(CANCELLABLE)("%s: Cancel stays when the reason is null / absent", (status) => {
    expect(cancels(statusActions(status, "SHIP", null))).toHaveLength(1);
    expect(cancels(statusActions(status, "SHIP"))).toHaveLength(1);
    expect(cancels(statusActions(status))).toHaveLength(1);
  });

  it("only Cancel goes: every other action of the status is kept, in order", () => {
    const all = statusActions("OUT_FOR_DELIVERY", "SHIP");
    const blocked = statusActions("OUT_FOR_DELIVERY", "SHIP", "WITH_CARRIER");
    expect(blocked).toEqual(all.filter((a) => a.toStatus !== "CANCELLED"));
    expect(blocked.length).toBeGreaterThan(0);
  });

  it("the CANCELLED reopen action is not a Cancel and is never hidden", () => {
    expect(statusActions("CANCELLED", "SHIP", "WITH_CARRIER")).toEqual(
      statusActions("CANCELLED", "SHIP"),
    );
  });
});

describe("cancelBlockedNote — the same fixed copy as the web", () => {
  it("WITH_CARRIER reads the web's words; null / undefined read nothing", () => {
    expect(WITH_CARRIER_COPY).toBe(
      "This order is already with the carrier. Use a return instead of cancelling.",
    );
    expect(cancelBlockedNote("WITH_CARRIER")).toBe(WITH_CARRIER_COPY);
    expect(cancelBlockedNote(null)).toBeNull();
    expect(cancelBlockedNote(undefined)).toBeNull();
  });
});

describe("wiring pins", () => {
  const read = (p: string): string =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("fs").readFileSync(require("path").join(__dirname, p), "utf8");

  it("the operator order screen passes the server's reason and shows the note", () => {
    const src = read("../app/(operator)/(tabs)/orders/[id].tsx");
    expect(src).toMatch(
      /statusActions\(\s*order\.status as OrderStatus,\s*order\.fulfillPath,\s*order\.cancelBlockedReason,?\s*\)/,
    );
    expect(src).toMatch(/cancelBlockedNote\(order\.cancelBlockedReason\)/);
  });

  it("the web's copy constant is the same string (one set of words on both apps)", () => {
    const web = read("../../web/app/(dashboard)/orders/[id]/CancelOrderButton.tsx");
    expect(web).toContain(
      '"This order is already with the carrier. Use a return instead of cancelling."',
    );
  });
});
