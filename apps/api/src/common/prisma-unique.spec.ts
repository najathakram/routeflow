/**
 * B1186 / SA-717: the ONE reader of a Prisma P2002's violated constraint. With the pg DRIVER ADAPTER
 * (what this API runs) `meta.target` is absent and the index name rides in
 * `meta.driverAdapterError.cause.constraint.index`; the native engine reports `meta.target`.
 * The adapter fixture is an object captured from a real two-connection collision (real Postgres).
 */
import fixture from "./testing/fixtures/p2002-adapter.json";
import {
  describeUniqueViolation,
  uniqueViolationConstraints,
  uniqueViolationOn,
} from "./prisma-unique";

const adapter = fixture as unknown as Record<string, any>;
const orderIdem = adapter["Order (tenantId,idempotencyKey)"];
const estimateNo = adapter["Estimate (tenantId,estimateNumber)"];
const creditNo = adapter["CreditNote (tenantId,creditNoteNumber)"];
const returnKey = adapter["Return (tenantId,returnKey)"];
const tenantSlug = adapter["Tenant.slug (single-col unique)"];

describe("uniqueViolationConstraints", () => {
  it("is null for anything that is not a P2002", () => {
    expect(uniqueViolationConstraints(null)).toBeNull();
    expect(uniqueViolationConstraints(new Error("x"))).toBeNull();
    expect(uniqueViolationConstraints({ code: "P2003", meta: { target: ["a"] } })).toBeNull();
  });

  it("reads the adapter shape: the index name, no target", () => {
    expect(uniqueViolationConstraints(orderIdem)).toEqual({
      names: ["Order_tenantId_idempotencyKey_key"],
      fields: [],
    });
  });

  it("reads the native shapes: target array = fields, target string = a constraint name", () => {
    expect(
      uniqueViolationConstraints({ code: "P2002", meta: { target: ["tenantId", "returnKey"] } }),
    ).toEqual({ names: [], fields: ["tenantId", "returnKey"] });
    expect(
      uniqueViolationConstraints({
        code: "P2002",
        meta: { target: "Return_tenantId_returnKey_key" },
      }),
    ).toEqual({ names: ["Return_tenantId_returnKey_key"], fields: [] });
  });

  it("reads adapter constraint.fields and falls back to the originalMessage's quoted name", () => {
    const viaFields = {
      code: "P2002",
      meta: { driverAdapterError: { cause: { constraint: { fields: ["tenantId", "x"] } } } },
    };
    expect(uniqueViolationConstraints(viaFields)).toEqual({ names: [], fields: ["tenantId", "x"] });
    const viaMessage = {
      code: "P2002",
      meta: {
        driverAdapterError: {
          cause: {
            originalMessage: 'duplicate key value violates unique constraint "Foo_bar_key"',
          },
        },
      },
    };
    expect(uniqueViolationConstraints(viaMessage)?.names).toEqual(["Foo_bar_key"]);
  });

  it("a P2002 that reports nothing yields empty lists (never a match)", () => {
    expect(uniqueViolationConstraints({ code: "P2002" })).toEqual({ names: [], fields: [] });
    expect(uniqueViolationOn({ code: "P2002" }, "estimateNumber")).toBe(false);
  });
});

describe("uniqueViolationOn (substring, case-insensitive)", () => {
  it("matches each captured adapter error on its own column, and no other", () => {
    expect(uniqueViolationOn(estimateNo, "estimateNumber")).toBe(true);
    expect(uniqueViolationOn(creditNo, "creditNoteNumber")).toBe(true);
    expect(uniqueViolationOn(returnKey, "returnKey")).toBe(true);
    expect(uniqueViolationOn(orderIdem, "idempotencyKey")).toBe(true);
    expect(uniqueViolationOn(tenantSlug, "estimateNumber")).toBe(false);
    expect(uniqueViolationOn(tenantSlug, "creditNoteNumber")).toBe(false);
    expect(uniqueViolationOn(tenantSlug, "returnKey")).toBe(false);
    expect(uniqueViolationOn(estimateNo, "creditNoteNumber")).toBe(false);
  });

  it("a returnNumber collision is not a returnKey violation (the bug S4 pinned)", () => {
    const returnNumber = {
      code: "P2002",
      meta: {
        driverAdapterError: {
          cause: { constraint: { index: "Return_tenantId_returnNumber_key" } },
        },
      },
    };
    expect(uniqueViolationOn(returnNumber, "returnKey")).toBe(false);
  });

  it("still matches both legacy native shapes", () => {
    expect(
      uniqueViolationOn(
        { code: "P2002", meta: { target: ["tenantId", "estimateNumber"] } },
        "estimateNumber",
      ),
    ).toBe(true);
    expect(
      uniqueViolationOn(
        { code: "P2002", meta: { target: "CreditNote_tenantId_creditNoteNumber_key" } },
        "creditNoteNumber",
      ),
    ).toBe(true);
    expect(uniqueViolationOn({ code: "P2002", meta: { target: ["a"] } }, "estimateNumber")).toBe(
      false,
    );
  });

  it("is false for a non-P2002 even when the text would match", () => {
    expect(
      uniqueViolationOn({ code: "P2003", meta: { target: "estimateNumber" } }, "estimateNumber"),
    ).toBe(false);
  });
});

describe("uniqueViolationOn exact mode", () => {
  it("matches the whole constraint name or one whole field, never a substring", () => {
    expect(uniqueViolationOn(orderIdem, "Order_tenantId_idempotencyKey_key", { exact: true })).toBe(
      true,
    );
    expect(uniqueViolationOn(orderIdem, "idempotencyKey", { exact: true })).toBe(false);
    expect(
      uniqueViolationOn(
        { code: "P2002", meta: { target: ["tenantId", "returnKey"] } },
        "returnKey",
        { exact: true },
      ),
    ).toBe(true);
  });
});

describe("describeUniqueViolation", () => {
  it("names the constraint for a log line", () => {
    expect(describeUniqueViolation(estimateNo)).toBe("Estimate_tenantId_estimateNumber_key");
    expect(describeUniqueViolation({ code: "P2002", meta: { target: ["a", "b"] } })).toBe("a,b");
    expect(describeUniqueViolation({ code: "P2002" })).toBe("");
  });
});
