/**
 * #2696(c) (SA-558 / 558a) — mobile's create surface overrides a SPECIAL (tier) price only with a
 * reason, decided by @routeflow/pricing's decideStaffOverride, the server's own rule A. Pure logic
 * + source pins (mobile Jest is pure-logic only).
 */
import * as fs from "fs";
import * as path from "path";
import { lineUnitFor, computeOrderTotal } from "../lib/cart-order-total";
import type { Product } from "../lib/cart-line-state";
import { decideTrayPrice, saleLinePriceFields } from "../lib/staff-price-override";
import { fromOrderDraftPayload, toOrderDraftPayload } from "../lib/drafts-payload";
import { resolveResumeLinePricing } from "../lib/order-draft-logic";

const product = {
  id: "p1",
  name: "Soda",
  pricePerUnit: "2.50",
  priceTier2: "2.00",
  unit: "each",
} as unknown as Product;

describe("#2696(c) decideTrayPrice — the tray editor's save", () => {
  const special = { base: 2, listPrice: 2.5, isSpecial: true };
  it("the special price itself (or within ½¢) clears any override — no reason asked", () => {
    expect(decideTrayPrice({ ...special, typed: 2, reason: "" })).toEqual({ kind: "clear" });
    expect(decideTrayPrice({ ...special, typed: 2.004, reason: "" })).toEqual({ kind: "clear" });
  });
  it("off the special price with no reason is refused (the server's 400)", () => {
    expect(decideTrayPrice({ ...special, typed: 1.5, reason: "  " })).toEqual({ kind: "refused" });
    expect(decideTrayPrice({ ...special, typed: 2.5, reason: "" })).toEqual({ kind: "refused" });
  });
  it("with a reason it is set, rounded, the reason trimmed", () => {
    expect(decideTrayPrice({ ...special, typed: 1.456, reason: " dented " })).toEqual({
      kind: "set",
      price: 1.46,
      overrideReason: "dented",
    });
  });
  it("a non-special line never needs a reason; its list price clears", () => {
    const plain = { base: 2.5, listPrice: 2.5, isSpecial: false };
    expect(decideTrayPrice({ ...plain, typed: 2, reason: "" })).toEqual({ kind: "set", price: 2 });
    expect(decideTrayPrice({ ...plain, typed: 2.5, reason: "" })).toEqual({ kind: "clear" });
  });
  it("an empty field clears", () => {
    expect(decideTrayPrice({ ...special, typed: null, reason: "" })).toEqual({ kind: "clear" });
  });
});

describe("#2696(c) a reasoned override on a special line is honored by the money", () => {
  it("red-first: lineUnitFor bills the override when it carries a reason", () => {
    expect(lineUnitFor({ qty: 2, unitPrice: 1.5, overrideReason: "dented" }, product, 2)).toBe(1.5);
  });
  it("but never a reasonless one (the server would refuse it) — the special price stands", () => {
    expect(lineUnitFor({ qty: 2, unitPrice: 1.5 }, product, 2)).toBe(2);
  });
  it("the footer total follows the same rule", () => {
    const { total } = computeOrderTotal(
      { p1: { qty: 2, unitPrice: 1.5, overrideReason: "dented" } },
      new Map([["p1", product]]),
      [],
      () => 2,
    );
    expect(total).toBe(3);
  });
});

describe("#2696(c) the reason survives park / resume", () => {
  it("red-first: drafts-payload models overrideReason both ways", () => {
    const state = fromOrderDraftPayload({
      customer: null,
      lineItems: [
        {
          tempId: "p1",
          productId: "p1",
          productName: "Soda",
          unit: "each",
          listPrice: 2.5,
          specialPrice: 2,
          discountedPrice: 1.5,
          unitPrice: 1.5,
          priceType: "MANUAL",
          qty: 2,
          overrideReason: "dented",
        },
      ],
    } as never);
    expect(state.items[0].overrideReason).toBe("dented");
    expect(toOrderDraftPayload(state).lineItems[0]).toMatchObject({ overrideReason: "dented" });
  });
  it("red-first: resume re-applies a MANUAL override WITH its reason", () => {
    expect(
      resolveResumeLinePricing(
        { productId: "p1", priceType: "MANUAL", unitPrice: 1.5, overrideReason: "dented" },
        product as never,
        [],
        2,
      ),
    ).toEqual({ unitPrice: 1.5, overrideReason: "dented" });
  });
});

describe("#2696(c) source pins — NewOrderScreen + LinePriceModal", () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const screen = read("components/NewOrderScreen.tsx");
  const modal = read("components/new-order/LinePriceModal.tsx");

  it("the tray no longer locks a special line's price", () => {
    expect(screen).not.toMatch(/Contract price — not editable on this order/);
  });
  it("the modal decides through decideTrayPrice and shows a Reason field", () => {
    expect(modal).toMatch(/decideTrayPrice\(/);
    expect(modal).toMatch(/Reason \(required\)/);
  });
  it("submit sends the reason with a special line's override", () => {
    expect(screen).toMatch(/overrideReason: line\.overrideReason\.trim\(\)/);
  });
});

// SA-558e: the operator's New-sale screen posts to /orders/sell (the server's create(), rule A).
describe("#2696(c) SA-558e saleLinePriceFields — a New-sale line's price fields", () => {
  const special = { base: 2, listPrice: 2.5, isSpecial: true };
  it("at the special price: just the price, no reason", () => {
    expect(saleLinePriceFields({ ...special, effective: 2, reason: "x" })).toEqual({
      unitPrice: 2,
    });
  });
  it("off it with no reason: refused (the sale is blocked)", () => {
    expect(saleLinePriceFields({ ...special, effective: 1.5, reason: " " })).toEqual({
      refused: true,
    });
  });
  it("off it with a reason: the price as shown + the trimmed reason", () => {
    expect(saleLinePriceFields({ ...special, effective: 1.5, reason: " dented " })).toEqual({
      unitPrice: 1.5,
      overrideReason: "dented",
    });
  });
  it("a non-special line never needs one", () => {
    expect(
      saleLinePriceFields({
        base: 2.5,
        listPrice: 2.5,
        isSpecial: false,
        effective: 2,
        reason: "",
      }),
    ).toEqual({ unitPrice: 2 });
  });
});

describe("#2696(c) SA-558e source pins — invoices/new (New sale)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "app/(operator)/(tabs)/invoices/new.tsx"),
    "utf8",
  );
  it("the sale builds each catalog line's price through saleLinePriceFields and blocks a refused one", () => {
    // VU-4b moved the per-line builder into lib/invoice-unit-pick (saleItemDto); the screen blocks a refusal.
    const builder = fs.readFileSync(path.join(__dirname, "..", "lib/invoice-unit-pick.ts"), "utf8");
    expect(builder).toMatch(/saleLinePriceFields\(/);
    expect(src).toMatch(/saleItemDto\(/);
    expect(src).toMatch(/reasonRequiredMessage\(/);
  });
  it("the review row shows a required Reason field", () => {
    expect(src).toMatch(/Reason \(required\)/);
  });
});
