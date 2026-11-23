import { readFileSync } from "fs";
import { join } from "path";
import { BadRequestException } from "@nestjs/common";
import {
  BUYER_EDIT_BODY_FIELDS,
  BUYER_EDIT_ENTRY_FIELDS,
  BUYER_EDIT_INPUT_NOT_ALLOWED_MESSAGE,
  assertBuyerEditInput,
  buyerEditInputRefused,
} from "./buyer-edit-input";

/** SA-1161 B4/B12 + P2: the buyer edit allowlist, every declared field either listed or refused. */
const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");

/** Fields declared in one class body of a DTO file (decorated or plain, comments skipped). */
function declared(src: string, cls: string): string[] {
  const start = src.search(new RegExp(`class ${cls}\\b`));
  if (start < 0) throw new Error(`no class ${cls}`);
  const rest = src.slice(start);
  const open = rest.indexOf("{");
  const end = rest.search(/^}/m);
  return [...rest.slice(open, end).matchAll(/^ {2}(?:@.*?\)\s+)?(\w+)[?!]?:\s[^;]*;\s*$/gm)].map(
    (m) => m[1],
  );
}

const ENTRY_DECLARED = declared(read("dto", "update-order-items.dto.ts"), "UpdateOrderItemDto");
const BODY_DECLARED = [
  ...declared(read("dto", "update-order-items.dto.ts"), "UpdateOrderItemsDto"),
  ...declared(
    read("..", "selling-restrictions", "dto", "restriction-ack.dto.ts"),
    "RestrictionAckDto",
  ),
];

const VALUE: Record<string, unknown> = {
  id: "x",
  productId: "x",
  orderItemId: "x",
  qty: 1,
  action: "CANCEL",
  substituteProductId: "x",
  unitLabel: "x",
  name: "x",
  boxes: 1,
  pieces: 1,
  unitPrice: 1,
  notes: "x",
  itemNote: "x",
  substitution: "x",
  overrideReason: "x",
  items: [],
  namesLines: true,
  expectedRevisionNumber: 1,
  ackSentRevert: true, // B1372 N2: staff only; a buyer never sees the confirm, so a buyer body carrying it is refused
  replaceAll: false,
  orderNotes: "x",
  shippingFee: 1,
  appliedCreditNotes: [],
  inlineReturn: {},
  restrictionOverrides: [],
  warningHash: "x",
};

describe("buyer edit allowlist (SA-1161)", () => {
  it("P2: the entry census and the body census are exactly the declared DTO fields", () => {
    expect(ENTRY_DECLARED.length).toBeGreaterThan(10);
    expect(Object.keys(VALUE).sort()).toEqual([...ENTRY_DECLARED, ...BODY_DECLARED].sort());
    expect([...BUYER_EDIT_ENTRY_FIELDS, "x"].length).toBe(4);
  });

  it.each(ENTRY_DECLARED.map((f) => [f, !BUYER_EDIT_ENTRY_FIELDS.includes(f)] as const))(
    "B4 entry field %s alone: refused=%s",
    (f, refused) => {
      const dto = { items: [{ [f]: VALUE[f] }] };
      if (refused) {
        expect(buyerEditInputRefused(dto)).toBe(true);
        expect(() => assertBuyerEditInput(dto)).toThrow(BadRequestException);
      } else {
        expect(() => assertBuyerEditInput(dto)).not.toThrow();
      }
    },
  );

  it.each(BODY_DECLARED.map((f) => [f, !BUYER_EDIT_BODY_FIELDS.includes(f)] as const))(
    "B4 body field %s alone: refused=%s",
    (f, refused) => {
      const dto = { items: [], [f]: VALUE[f] };
      expect(buyerEditInputRefused(dto)).toBe(refused);
    },
  );

  it("refuses 400 with the code and the neutral message", () => {
    try {
      assertBuyerEditInput({ items: [{ unitPrice: 1 }] });
      throw new Error("not refused");
    } catch (e: any) {
      expect(e.getStatus()).toBe(400);
      expect(e.getResponse()).toEqual({
        code: "BUYER_EDIT_INPUT_NOT_ALLOWED",
        message: BUYER_EDIT_INPUT_NOT_ALLOWED_MESSAGE,
      });
    }
  });

  it("B12: a key present with value undefined passes", () => {
    expect(
      buyerEditInputRefused({
        items: [{ productId: "p", qty: 1, unitPrice: undefined }],
        shippingFee: undefined,
      }),
    ).toBe(false);
  });

  it("the buyer shapes pass: web body, mobile body", () => {
    expect(
      buyerEditInputRefused({
        items: [
          { orderItemId: "a", qty: 2 },
          { productId: "p", qty: 1 },
        ],
        expectedRevisionNumber: 3,
      }),
    ).toBe(false);
    expect(buyerEditInputRefused({ items: [{ productId: "p", qty: 1 }], namesLines: true })).toBe(
      false,
    );
  });

  it("parity: the API lists equal the types package lists", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "..", "..", "packages", "types", "api", "buyer-order-edit.ts"),
      "utf8",
    );
    const list = (name: string) =>
      [
        ...(src.match(new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`))?.[1] ?? "").matchAll(
          /"(\w+)"/g,
        ),
      ].map((m) => m[1]);
    expect(list("BUYER_EDIT_ENTRY_FIELDS")).toEqual([...BUYER_EDIT_ENTRY_FIELDS]);
    expect(list("BUYER_EDIT_BODY_FIELDS")).toEqual([...BUYER_EDIT_BODY_FIELDS]);
  });
});

/**
 * B13: the buyer CREATE route needs no check of its own because its input is already an allowlist (the global
 * pipe is whitelist + forbidNonWhitelisted). The server-built merge fold may carry more; the create DTOs may not
 * grow unseen, so a new create field fails here until a row covers it.
 */
describe("buyer create DTOs stay closed (SA-1161 B13)", () => {
  const create = read("..", "buyer", "dto", "buyer-create-order.dto.ts");
  it("BuyerOrderItemDto declares exactly productId, qty, boxes, pieces, notes", () => {
    expect(declared(create, "BuyerOrderItemDto").sort()).toEqual(
      ["boxes", "notes", "pieces", "productId", "qty"].sort(),
    );
  });
  it("BuyerCreateOrderDto declares exactly items, notes, urgent, requestedDeliveryDate, status, forceNew, fulfillPath", () => {
    expect(declared(create, "BuyerCreateOrderDto").sort()).toEqual(
      [
        "forceNew",
        "fulfillPath",
        "items",
        "notes",
        "requestedDeliveryDate",
        "status",
        "urgent",
      ].sort(),
    );
  });
});
