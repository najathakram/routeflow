import "reflect-metadata";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { BuyerPaymentsController } from "../payment-requests/buyer-payments.controller";
import { BuyerController } from "./buyer.controller";
import {
  BuyerSellerContextGuard,
  SELLER_READ_ONLY_EXEMPT_BUYER_WRITES,
} from "./guards/buyer-seller-context.guard";

/**
 * SA-733r6 (B4): the SERVER is the authority that a read-only seller takes no buyer writes, and that authority is
 * `BuyerSellerContextGuard` (a real buyer token has no tenantId, so the global status guard never sees it). This
 * sweep reads the real route metadata: every non-GET handler of the seller-scoped buyer controllers must carry the
 * guard (on the handler or the class), except an explicit, reviewed list of account-level routes. A NEW buyer write
 * route that forgets the guard fails here.
 */
const READS = new Set([RequestMethod.GET, RequestMethod.HEAD, RequestMethod.OPTIONS]);
const VERB = (m: number) => RequestMethod[m];

/** Intentionally NOT seller-scoped: they act on the buyer's own account or on a link that does not exist yet. */
const REVIEWED_UNGUARDED: Record<string, string> = {
  "BuyerController POST invites/:token/accept":
    "account-level: links the buyer to a seller by invite token; there is no seller context yet",
  "BuyerController POST sellers/request":
    "account-level: asks to connect with a seller the buyer is not yet linked to",
  "BuyerController DELETE sellers/:sellerSlug":
    "account-level: a buyer leaving a seller, which must stay possible whatever the seller's state",
};

function writeHandlers(ctrl: new (...a: any[]) => unknown) {
  const out: { key: string; guarded: boolean }[] = [];
  const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, ctrl) ?? [];
  const base = Reflect.getMetadata(PATH_METADATA, ctrl);
  void base;
  for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
    if (name === "constructor") continue;
    const fn = (ctrl.prototype as any)[name];
    if (typeof fn !== "function") continue;
    const method = Reflect.getMetadata(METHOD_METADATA, fn);
    if (method === undefined || READS.has(method)) continue;
    const path = Reflect.getMetadata(PATH_METADATA, fn);
    const handlerGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, fn) ?? [];
    out.push({
      key: `${ctrl.name} ${VERB(method)} ${path === "/" ? "" : path}`.trim(),
      guarded: [...classGuards, ...handlerGuards].includes(BuyerSellerContextGuard),
    });
  }
  return out;
}

describe("buyer write routes carry BuyerSellerContextGuard (B4 B1 sweep)", () => {
  const all = [BuyerController, BuyerPaymentsController].flatMap((c) => writeHandlers(c as any));

  it("finds the write routes (the sweep is not vacuous)", () => {
    expect(all.length).toBeGreaterThanOrEqual(18);
    expect(all.some((r) => r.key === "BuyerController POST orders")).toBe(true);
    expect(all.some((r) => r.key === "BuyerPaymentsController POST card")).toBe(true);
  });

  it("every non-GET handler is guarded, except the reviewed account-level list", () => {
    const unguarded = all.filter((r) => !r.guarded).map((r) => r.key);
    expect(unguarded.sort()).toEqual(Object.keys(REVIEWED_UNGUARDED).sort());
  });

  it("every reviewed exemption still exists (a stale entry must be deleted)", () => {
    const keys = new Set(all.map((r) => r.key));
    for (const k of Object.keys(REVIEWED_UNGUARDED)) expect(keys.has(k)).toBe(true);
  });

  it("the money-moving ones are guarded: placing, editing and cancelling an order, and the card / cash payments", () => {
    const guarded = new Set(all.filter((r) => r.guarded).map((r) => r.key));
    for (const k of [
      "BuyerController POST orders",
      "BuyerController PATCH orders/:id/items",
      "BuyerController POST orders/:id/cancel",
      "BuyerPaymentsController POST card",
      "BuyerPaymentsController POST cash",
    ]) {
      expect(guarded.has(k)).toBe(true);
    }
  });

  // The READ_ONLY exemption is ONE constant: exactly the buyer's own payment routes match it, no BuyerController
  // route (orders, cart, templates, favorites ...) does.
  it("the read-only exemption matches the three payment writes and nothing else", () => {
    const exempt = (ctrl: any, name: string) => {
      const fn = ctrl.prototype[name];
      const method = Reflect.getMetadata(METHOD_METADATA, fn);
      const path = Reflect.getMetadata(PATH_METADATA, fn);
      const base = Reflect.getMetadata(PATH_METADATA, ctrl);
      const url = `/api/v1/${base}/${path}`.replace(/:[A-Za-z]+/g, "abc");
      return SELLER_READ_ONLY_EXEMPT_BUYER_WRITES.some(
        (e) => e.method === VERB(method) && e.pattern.test(url),
      );
    };
    const names = (ctrl: any) =>
      Object.getOwnPropertyNames(ctrl.prototype).filter(
        (n) => n !== "constructor" && typeof ctrl.prototype[n] === "function",
      );
    const hit = (ctrl: any) =>
      names(ctrl).filter(
        (n) =>
          Reflect.getMetadata(METHOD_METADATA, ctrl.prototype[n]) !== undefined && exempt(ctrl, n),
      );
    expect(hit(BuyerPaymentsController).sort()).toEqual(["cancel", "card", "cash"]);
    expect(hit(BuyerController)).toEqual([]);
  });
});
