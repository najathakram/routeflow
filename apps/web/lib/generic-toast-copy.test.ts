import { readFileSync } from "fs";
import { join } from "path";
import { handleMutationError } from "./mutation-error-toast";
import { API_ERROR_CODES } from "@routeflow/types";
import { codedToastCopy, genericToastCopy } from "./generic-toast-copy";

/**
 * B980: the generic mutation toast shows FIXED copy chosen by code, then status. The raw server
 * message, the axios text and class-validator arrays are never rendered; a number comes from a
 * structured body field; opt-outs and handled codes are unchanged.
 */
const NEUTRAL_409 =
  "That conflicts with something that already exists or is in use. Check it and try again.";
const RAW = "secret internal detail: row 42 violates fk_x";
const err = (status: number, data: Record<string, unknown> = {}) => ({
  message: "Request failed with status code " + status,
  response: { status, data: { message: RAW, ...data } },
});

describe("genericToastCopy: status class", () => {
  it.each([
    [400, "Some details aren't valid. Check what you entered and try again."],
    [422, "Some details aren't valid. Check what you entered and try again."],
    [401, "Your session expired. Sign in again."],
    [403, "You don't have permission to do that."],
    [404, "That item no longer exists. Refresh and try again."],
    [409, NEUTRAL_409],
    [429, "Too many requests. Wait a moment and try again."],
    [500, "Something went wrong on our side. Please try again."],
    [503, "Something went wrong on our side. Please try again."],
  ])("status %i", (status, copy) => {
    expect(genericToastCopy(err(status))).toBe(copy);
  });

  it("an array message (class-validator) is never rendered", () => {
    expect(
      genericToastCopy(err(400, { message: ["name must be a string", "qty must be > 0"] })),
    ).toBe("Some details aren't valid. Check what you entered and try again.");
  });

  it("no response (timeout / dropped connection) is the 'couldn't confirm' line", () => {
    expect(genericToastCopy({ message: "Network Error", request: {} })).toMatch(/couldn't confirm/);
  });

  it("a non-error value is the generic line", () => {
    expect(genericToastCopy(undefined)).toBe("Something went wrong. Please try again.");
    expect(genericToastCopy("boom")).toBe("Something went wrong. Please try again.");
  });
});

describe("genericToastCopy: codes users rely on", () => {
  const STOCK = "Some items aren't available in that quantity.";

  it("INSUFFICIENT_STOCK is ONE numberless sentence in every body shape: a count is pieces with no noun and would overstate stock to a box buyer", () => {
    for (const body of [
      { code: "INSUFFICIENT_STOCK", available: 4, requested: 9 },
      { code: "INSUFFICIENT_STOCK", available: 0, requested: 2 },
      {
        code: "INSUFFICIENT_STOCK",
        lines: [{ productId: "p", name: "Mango 5ct", unit: "bag", available: 4, requested: 9 }],
        available: 4,
      },
      {
        code: "INSUFFICIENT_STOCK",
        lines: [
          { productId: "a", available: 1, requested: 3 },
          { productId: "b", available: 0, requested: 2 },
        ],
      },
      {
        code: "INSUFFICIENT_STOCK",
        message: "Not enough stock for X (available: 7, requested: 9).",
      },
      { code: "INSUFFICIENT_STOCK" },
    ]) {
      const copy = genericToastCopy(err(409, body));
      expect(copy).toBe(STOCK);
      expect(copy).not.toMatch(/\d/);
    }
  });

  it("an uncoded stock refusal (order create today, until #2871 lands) falls to the neutral 409 sentence", () => {
    expect(
      genericToastCopy(err(409, { message: "Insufficient stock: X (available: 7, requested: 9)" })),
    ).toBe(NEUTRAL_409);
  });

  it("a bare 409 is neutral: most uncoded 409s are 'already exists / in use', not stale data", () => {
    expect(genericToastCopy(err(409))).toBe(NEUTRAL_409);
    expect(NEUTRAL_409).not.toMatch(/changed while|stale/i);
  });

  it("a plain client Error (no response, no request: a bug or a throw) is the generic line, not 'couldn't confirm'", () => {
    expect(genericToastCopy(new Error("boom"))).toBe("Something went wrong. Please try again.");
    expect(genericToastCopy({ message: "Network Error", request: {} })).toMatch(/couldn't confirm/);
    expect(genericToastCopy({ code: "ECONNABORTED", request: {} })).toMatch(/couldn't confirm/);
  });

  it("ORDER_LINE_CHANGED is mapped through the shared constant", () => {
    expect(genericToastCopy(err(409, { code: API_ERROR_CODES.ORDER_LINE_CHANGED }))).toMatch(
      /changed while it was being billed/,
    );
  });

  it("ORDER_INVOICES_NEED_REVIEW (SA-687) shows the fixed review copy, never the server message", () => {
    expect(
      genericToastCopy(
        err(409, { code: API_ERROR_CODES.ORDER_INVOICES_NEED_REVIEW, message: "raw server text" }),
      ),
    ).toBe(
      "This order's invoices don't match its lines. Add the remaining items to the draft, or void and re-split, before billing more.",
    );
  });

  it("the duplicate-email sentence maps to the fixed copy", () => {
    expect(genericToastCopy(err(409, { message: "Email or username already taken" }))).toBe(
      "That email is already in use. Use a different email.",
    );
  });

  it.each([
    ["RETURN_REFUND_OVER_LINE_HEADROOM", /more than the invoice line is worth/],
    ["INLINE_RETURN_ALREADY_RETURNED_REASON_REQUIRED", /already returned. Add a reason/],
    ["INLINE_RETURN_KEY_CONFLICT", /already submitted/],
    ["CREDIT_NOTE_VOID_NOT_EDITABLE", /is void/],
    ["CREDIT_NOTE_OVER_HEADROOM", /more than the source invoice still allows/],
    ["UNIT_AWARE_LINE", /sold by a unit/],
    ["ORDER_CHANGED_DURING_EDIT", /changed while you were editing/],
    ["ORDER_BILLING_CHANGED", /billing changed/],
    ["ORDER_EDIT_WOULD_OVERPAY", /overpaid on the invoice/],
    ["ORDER_WITH_CARRIER_NO_CANCEL", /already with the carrier/],
    // B1135: the change-request refusal for an order that has shipped, pinned word for word.
    [
      "ORDER_WITH_CARRIER_NO_CHANGE_REQUEST",
      /^This order has already shipped\. Contact the seller for changes\.$/,
    ],
    ["ORDER_WITH_CARRIER_NO_REDUCE", /Record a return instead of reducing/],
    ["ORDER_WITH_CARRIER_NO_ADD", /Create a new order for the extra items/],
    ["CONCURRENT_UPDATE", /Someone else is updating/],
    ["BARCODE_TAKEN", /barcode/],
    ["ADDON_GATE", /isn't included in your current plan/],
  ])("%s", (code, re) => {
    const copy = genericToastCopy(err(409, { code }));
    expect(copy).toMatch(re);
    expect(copy).not.toContain(RAW);
  });

  it("the order-linked duplicate refusal (no code) maps by its exact sentence; a near-miss does not", () => {
    expect(
      genericToastCopy(
        err(400, {
          message:
            "Cannot duplicate an order-linked invoice. Create a new invoice or issue a credit note instead.",
        }),
      ),
    ).toMatch(/came from an order/);
    expect(
      genericToastCopy(
        err(400, { message: "Cannot duplicate an order-linked invoice. Also: " + RAW }),
      ),
    ).toBe("Some details aren't valid. Check what you entered and try again.");
  });

  describe("B986: coded refusals that tell the user what to fix (never less actionable than the server sentence)", () => {
    it("ALLOCATIONS_EXCEED_PAYMENT names the two amounts from the STRUCTURED fields, never the message", () => {
      const copy = genericToastCopy(
        err(400, { code: "ALLOCATIONS_EXCEED_PAYMENT", allocatedTotal: 150.5, totalAmount: 100 }),
      );
      expect(copy).toBe(
        "The allocations add up to $150.50, more than the $100.00 payment. Lower an allocation or raise the payment amount.",
      );
      expect(genericToastCopy(err(400, { code: "ALLOCATIONS_EXCEED_PAYMENT" }))).toBe(
        "The allocations add up to more than the payment. Lower an allocation or raise the payment amount.",
      );
      expect(
        genericToastCopy(
          err(400, { code: "ALLOCATIONS_EXCEED_PAYMENT", allocatedTotal: "x", totalAmount: 1 }),
        ),
      ).not.toMatch(/\$/);
    });

    it("UNLINKED_ITEMS (with lines, and the empty bill) says what to do", () => {
      expect(
        genericToastCopy(
          err(409, { code: API_ERROR_CODES.UNLINKED_ITEMS, unlinkedItems: [{ id: "i" }] }),
        ),
      ).toBe(
        "Some bill lines aren't linked to a product, so they won't update inventory or costs. Link them, or confirm to receive the bill anyway.",
      );
      expect(
        genericToastCopy(err(409, { code: API_ERROR_CODES.UNLINKED_ITEMS, unlinkedItems: [] })),
      ).toBe(
        "This bill has no line items, so receiving it won't update inventory or costs. Add the lines first.",
      );
    });

    it("PACK_SIZE_UNKNOWN keeps the 'confirm as loose pieces' option", () => {
      expect(genericToastCopy(err(409, { code: API_ERROR_CODES.PACK_SIZE_UNKNOWN }))).toBe(
        "Some lines don't have a pack size yet. Set each line's pack size, or confirm them as loose pieces, then try again.",
      );
    });

    describe("DUPLICATE_VENDOR_BILL: points at the existing bill, never teaches a bypass", () => {
      const dup = (duplicate: unknown) =>
        err(409, { code: API_ERROR_CODES.DUPLICATE_VENDOR_BILL, duplicate });
      it("names the existing bill from the STRUCTURED field", () => {
        expect(genericToastCopy(dup({ billNumber: "BILL-0012", status: "RECEIVED" }))).toBe(
          "This bill is already recorded as BILL-0012. Open it instead.",
        );
      });
      it("a DRAFT match says to finish receiving it", () => {
        expect(genericToastCopy(dup({ billNumber: "BILL-0013", status: "DRAFT" }))).toBe(
          "This bill is already saved as draft BILL-0013. Open it to finish receiving instead of creating a second bill.",
        );
      });
      it("without a usable bill number it still says to open the existing bill", () => {
        for (const d of [undefined, {}, { billNumber: 12 }, { billNumber: "<b>x</b> " + RAW }])
          expect(genericToastCopy(dup(d))).toBe(
            "This bill is already recorded. Open the existing bill instead.",
          );
      });
      it("never suggests changing the invoice number (it would defeat the duplicate guard)", () => {
        for (const d of [undefined, { billNumber: "B1", status: "DRAFT" }, { billNumber: "B1" }])
          expect(genericToastCopy(dup(d))).not.toMatch(/change the invoice number/i);
      });
    });

    it.each([
      [
        'A category named "Snacks" already exists.',
        "A category with that name already exists. Choose a different name.",
      ],
      [
        'A subcategory named "Cigars" already exists in this section.',
        "A subcategory with that name already exists. Choose a different name.",
      ],
      [
        'A product named "Widget" already exists',
        "A product with that name already exists. Choose a different name.",
      ],
      ["SKU already exists", "That SKU is already used by another product. Use a different SKU."],
      [
        "Barcode already exists",
        "That barcode is already used by another product. Use a different barcode.",
      ],
    ])("the duplicate 409 %s is a fixed sentence that says what to change", (message, copy) => {
      expect(genericToastCopy(err(409, { message }))).toBe(copy);
      expect(genericToastCopy(err(400, { message }))).toBe(copy);
    });

    it.each([
      [
        "No email address on file for this customer. Provide an email address.",
        "No email address on file for this customer. Provide an email address.",
      ],
      [
        "This order has returns recorded against it. Delete those returns first.",
        "This order has returns recorded against it. Delete those returns first.",
      ],
      [
        "Only DRAFT, PENDING, or CANCELLED orders can be deleted. This order is DELIVERED.",
        "Only draft, pending or cancelled orders can be deleted. Cancel this order first if it's still open.",
      ],
    ])(
      "B986-7: the actionable delete / email refusal %s keeps a fixed sentence",
      (message, copy) => {
        expect(genericToastCopy(err(400, { message }), "SURFACE")).toBe(copy);
        expect(genericToastCopy(err(409, { message }), "SURFACE")).toBe(copy);
      },
    );

    it("a delete refusal with a status outside the closed list, or extra text, is not trusted", () => {
      expect(
        genericToastCopy(
          err(400, {
            message:
              "Only DRAFT, PENDING, or CANCELLED orders can be deleted. This order is " + RAW,
          }),
          "SURFACE",
        ),
      ).toBe("SURFACE");
    });

    it("a duplicate sentence that echoes user text or names another noun is NOT trusted", () => {
      expect(genericToastCopy(err(409, { message: 'A secret named "x" already exists.' }))).toBe(
        NEUTRAL_409,
      );
      expect(
        genericToastCopy(err(409, { message: 'A category named "x" already exists. ' + RAW })),
      ).toBe(NEUTRAL_409);
    });
  });

  describe("B986-7 Opus: coded refusals are mapped with actionable sentences; codedToastCopy is null for the rest", () => {
    const code = (c: string, extra: object = {}) => err(409, { code: c, message: RAW, ...extra });
    it.each([
      ["UNIT_NOT_OFFERED", /unit isn't offered for this product.*another unit.*admin/],
      ["EMAIL_NOT_CONFIGURED", /Email isn't set up.*Settings → Email/],
      ["EMAIL_SEND_FAILED", /email couldn't be sent.*Settings → Email/],
      ["INVALID_LINE_SPLIT", /line split isn't valid.*quantities/],
      ["SOURCE_LINE_AMBIGUOUS", /more than one line.*order lines directly/],
      ["SOURCE_LINE_INVALID", /pack size or price isn't valid/],
      ["LINE_PACK_UNDERIVABLE", /no pack size.*next delivery.*Set its pack size/],
      ["RECIPE_PACK_MISMATCH", /recipe's pack size differs.*match/],
      ["COMPOSITION_CORRUPT", /mixed-pack composition is inconsistent.*pack split/],
      ["ORDER_BELOW_RETURN_CREDIT", /can't drop below the credit already issued.*returns/],
      ["UNIT_AWARE_LINE_UNVERIFIABLE", /lines couldn't be verified.*Ask an admin/],
      ["CHANGE_REQUEST_PACK_CHANGED", /pack size changed.*Decline it and re-add/],
      ["INVOICE_CHANGED_CONCURRENTLY", /invoice changed.*Refresh and try again/],
      ["INVOICE_TAX_STATE_STALE", /tax no longer matches.*Re-save the invoice lines/],
      [
        "INVOICE_TOTAL_BELOW_PAID",
        /total below what is already paid or credited.*change the lines or discount/,
      ],
      ["FAMILY_NOT_PRICEABLE", /family can't be priced or promoted.*variants/],
      // SA-770: the overdue list refuses past its id cap (422) and says how to narrow it.
      ["OVERDUE_FILTER_TOO_BROAD", /Too many invoices are overdue.*customer/],
      ["REMINDER_NO_BALANCE_DUE", /no balance due.*nothing to remind/],
      ["REMINDER_NOT_ISSUED", /issued and is still unpaid/],
    ])("%s", (c, re) => {
      const copy = genericToastCopy(code(c));
      expect(copy).toMatch(re);
      expect(copy).not.toContain(RAW);
      expect(codedToastCopy(code(c))).toBe(copy);
    });

    it("the plan-limit 403 ('Selling by unit') gets the plan sentence, not 'permission'", () => {
      const e = err(403, { message: "Selling by unit is not included in this plan." });
      expect(genericToastCopy(e)).toBe("Selling by unit isn't included in your current plan.");
      expect(codedToastCopy(e)).toBe("Selling by unit isn't included in your current plan.");
    });

    it("codedToastCopy is NULL for an uncoded refusal, an unknown code, a plain error and a status-only failure", () => {
      for (const e of [
        err(409),
        err(400, { message: "Cannot cancel an order with paid invoices" }),
        err(409, { code: "SOMETHING_NEW" }),
        new Error("boom"),
        err(500),
        err(403),
        undefined,
      ])
        expect(codedToastCopy(e)).toBeNull();
    });

    it("codedToastCopy still maps safe-text, plan gates, stock, known sentences and credit limit", () => {
      expect(
        codedToastCopy(err(400, { code: "TEXT_CELL_FORMULA_LEAD", field: "businessName" })),
      ).toMatch(/Business name/);
      expect(codedToastCopy(err(403, { code: "PLAN_GATE", flag: "x" }))).toBe(
        "This isn't included in your current plan.",
      );
      expect(codedToastCopy(err(409, { code: "INSUFFICIENT_STOCK" }))).toMatch(/aren't available/);
      expect(
        codedToastCopy(err(409, { code: "CREDIT_LIMIT_EXCEEDED", limit: 1, exposure: 2 })),
      ).toMatch(/credit limit/);
      expect(codedToastCopy(err(400, { message: 'A category named "x" already exists.' }))).toMatch(
        /already exists/,
      );
    });
  });

  describe("surfaceRefusal (B986-7)", () => {
    const FIX = "The order couldn't be created. Check the customer and lines, then try again.";
    it("replaces the status copy for an UNCODED 400 / 409 / 422 only", () => {
      for (const status of [400, 409, 422]) expect(genericToastCopy(err(status), FIX)).toBe(FIX);
      expect(genericToastCopy(err(500), FIX)).toBe(
        "Something went wrong on our side. Please try again.",
      );
      expect(genericToastCopy(err(403), FIX)).toBe("You don't have permission to do that.");
      expect(genericToastCopy(err(404), FIX)).toBe(
        "That item no longer exists. Refresh and try again.",
      );
    });
    it("never overrides a coded refusal, a known sentence, a safe-text refusal or the stock sentence", () => {
      expect(genericToastCopy(err(409, { code: "INSUFFICIENT_STOCK" }), FIX)).toBe(
        "Some items aren't available in that quantity.",
      );
      expect(genericToastCopy(err(409, { code: API_ERROR_CODES.PACK_SIZE_UNKNOWN }), FIX)).toMatch(
        /pack size/,
      );
      expect(
        genericToastCopy(err(409, { message: 'A category named "x" already exists.' }), FIX),
      ).toMatch(/already exists/);
      expect(
        genericToastCopy(err(400, { code: "TEXT_CELL_FORMULA_LEAD", field: "businessName" }), FIX),
      ).toMatch(/Business name can't start/);
    });
    it("never shows the server message, with or without a surface sentence", () => {
      expect(genericToastCopy(err(409), FIX)).not.toContain(RAW);
    });
  });

  it("a plan gate is the plan copy; PLAN_GATE_UNAVAILABLE falls through to the status copy", () => {
    expect(genericToastCopy(err(403, { code: "PLAN_GATE", flag: "x" }))).toBe(
      "This isn't included in your current plan.",
    );
    expect(genericToastCopy(err(403, { code: "PLAN_GATE_UNAVAILABLE" }))).toBe(
      "You don't have permission to do that.",
    );
  });

  it("an unknown code falls to the status copy, never the message", () => {
    expect(genericToastCopy(err(409, { code: "SOMETHING_NEW" }))).toBe(NEUTRAL_409);
  });
});

describe("handleMutationError: opt-outs and handled codes are unchanged (B980)", () => {
  const run = (e: unknown, mutation: { meta?: Record<string, unknown> } | undefined) => {
    const toast = jest.fn();
    handleMutationError(e, mutation, toast, { push: jest.fn() });
    return toast;
  };

  it.each([
    [400, {}],
    [409, { code: "INSUFFICIENT_STOCK", available: 1 }],
    [500, { code: "X" }],
    [403, { code: "ADDON_GATE" }],
    [400, { code: "TEXT_CELL_FORMULA_LEAD", field: "businessName" }],
  ])("localErrorToast opts out for status %i %j", (status, data) => {
    expect(
      run(err(status as number, data as Record<string, unknown>), {
        meta: { localErrorToast: true },
      }),
    ).not.toHaveBeenCalled();
  });

  it("HANDLED_CODES are still swallowed", () => {
    for (const code of ["MERGE_CHOICE_REQUIRED", "SELLING_RESTRICTED", "CREDIT_LIMIT_EXCEEDED"])
      expect(run(err(409, { code }), undefined)).not.toHaveBeenCalled();
  });

  it("an ordinary failure toasts once, with fixed copy, never the raw text", () => {
    const toast = run(err(409, { code: "INSUFFICIENT_STOCK", available: 3 }), undefined);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith({
      title: "Some items aren't available in that quantity.",
      variant: "error",
    });
    expect(JSON.stringify(toast.mock.calls)).not.toContain(RAW);
  });
});

describe("handleMutationError with a predicate localErrorToast (B986-7)", () => {
  const e400 = {
    response: { status: 400, data: { code: "TEXT_CELL_FORMULA_LEAD", field: "businessName" } },
  };
  const e500 = { response: { status: 500, data: { message: "db down" } } };
  const run = (e: unknown, local: unknown) => {
    const toast = jest.fn();
    handleMutationError(e, { meta: { localErrorToast: local } }, toast, { push: jest.fn() });
    return toast;
  };
  it("a predicate that matches skips the toast; one that does not shows it once", () => {
    expect(run(e400, () => true)).not.toHaveBeenCalled();
    expect(run(e500, () => false)).toHaveBeenCalledTimes(1);
    expect(
      run(e500, (e: unknown) => (e as { response: { status: number } }).response.status === 400),
    ).toHaveBeenCalledTimes(1);
  });
});

describe("B986-7 fold: codes #3051 registered are spelled through API_ERROR_CODES, never as bare keys or literals", () => {
  const src = readFileSync(join(__dirname, "generic-toast-copy.ts"), "utf8");
  const REGISTERED = [
    "UNIT_NOT_OFFERED",
    "INVALID_LINE_SPLIT",
    "SOURCE_LINE_AMBIGUOUS",
    "SOURCE_LINE_INVALID",
    "LINE_PACK_UNDERIVABLE",
    "RECIPE_PACK_MISMATCH",
    "COMPOSITION_CORRUPT",
    "ORDER_BELOW_RETURN_CREDIT",
    "UNIT_AWARE_LINE_UNVERIFIABLE",
    "CHANGE_REQUEST_PACK_CHANGED",
    "INVOICE_CHANGED_CONCURRENTLY",
    "INVOICE_TAX_STATE_STALE",
    "INVOICE_TOTAL_BELOW_PAID",
  ];
  it.each(REGISTERED)("%s is a computed [API_ERROR_CODES.X] key", (code) => {
    expect(src).toContain(`[API_ERROR_CODES.${code}]:`);
    expect(src).not.toMatch(new RegExp(`^\\s+${code}:`, "m"));
  });
  it("CREDIT_LIMIT_EXCEEDED is compared through the constant", () => {
    expect(src).toContain("code === API_ERROR_CODES.CREDIT_LIMIT_EXCEEDED");
    expect(src).not.toMatch(/["'`]CREDIT_LIMIT_EXCEEDED["'`]/);
  });
});

describe("P-4: ORDER_EDIT_WOULD_OVERPAY", () => {
  it("is fixed copy, never the server sentence", () => {
    const copy = genericToastCopy(err(409, { code: "ORDER_EDIT_WOULD_OVERPAY", excess: 5 }));
    expect(copy).toMatch(/overpaid/);
    expect(copy).not.toContain(RAW);
  });
});
