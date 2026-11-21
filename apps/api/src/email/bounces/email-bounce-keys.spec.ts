import {
  DELIVERY_REF_HEADER,
  classifyFallbackReason,
  lookupDeliveriesByMessageId,
  messageIdLookupForms,
  newDeliveryRefToken,
  normalizeMessageId,
} from "./email-bounce-keys";

/**
 * W-1286 PR-1 (SA-1202 C3, C4', C29): the two keys a later bounce is matched on, and the fallback class.
 * Pure helpers: no clock, no network, no addresses.
 */
describe("normalizeMessageId (C3)", () => {
  it("T10: brackets and letter case never make two forms of one id differ", () => {
    const stored = normalizeMessageId("<AbC123@Mail.Example.com>");
    expect(stored).toBe("abc123@mail.example.com");
    expect(normalizeMessageId("abc123@MAIL.example.com")).toBe(stored);
    expect(normalizeMessageId("  <abc123@mail.example.com>  ")).toBe(stored);
  });

  it("the lookup asks for the bare and the bracketed form, so old and new rows both match", () => {
    expect(messageIdLookupForms("<ABC@x.test>")).toEqual(["abc@x.test", "<abc@x.test>"]);
  });
});

describe("lookupDeliveriesByMessageId (C3, T10, T11)", () => {
  const writers = [
    "create",
    "createMany",
    "update",
    "updateMany",
    "upsert",
    "delete",
    "deleteMany",
  ];
  function fakePrisma(rows: unknown[]) {
    const emailDelivery: Record<string, jest.Mock> = {
      findMany: jest.fn().mockResolvedValue(rows),
    };
    for (const w of writers) emailDelivery[w] = jest.fn();
    return { prisma: { emailDelivery } as any, emailDelivery };
  }

  it("T10: a differently-written id finds the row through the bare and bracketed forms", async () => {
    const { prisma, emailDelivery } = fakePrisma([{ id: "d1", tenantId: "t1" }]);
    const out = await lookupDeliveriesByMessageId(prisma, "<ABC@X.test>");
    expect(emailDelivery.findMany.mock.calls[0][0].where).toEqual({
      providerMessageId: { in: ["abc@x.test", "<abc@x.test>"] },
    });
    expect(out).toEqual({ status: "MATCHED", rows: [{ id: "d1", tenantId: "t1" }] });
  });

  it("T11: a send made before the record existed is UNMATCHED and nothing is written", async () => {
    const { prisma, emailDelivery } = fakePrisma([]);
    const out = await lookupDeliveriesByMessageId(prisma, "<old@x.test>");
    expect(out).toEqual({ status: "UNMATCHED" });
    for (const w of writers) expect(emailDelivery[w]).not.toHaveBeenCalled();
  });

  it("never falls back to the recipient: only providerMessageId is queried", async () => {
    const { prisma, emailDelivery } = fakePrisma([]);
    await lookupDeliveriesByMessageId(prisma, "<old@x.test>");
    expect(Object.keys(emailDelivery.findMany.mock.calls[0][0].where)).toEqual([
      "providerMessageId",
    ]);
    expect(emailDelivery.findMany).toHaveBeenCalledTimes(1);
  });

  it("an empty id is UNMATCHED without a query", async () => {
    const { prisma, emailDelivery } = fakePrisma([{ id: "d1" }]);
    expect(await lookupDeliveriesByMessageId(prisma, "  <>  ")).toEqual({ status: "UNMATCHED" });
    expect(emailDelivery.findMany).not.toHaveBeenCalled();
  });
});

describe("newDeliveryRefToken (C4', T33a)", () => {
  it("is 128 random bits as 32 lower-case hex characters, never a uuid, new each time", () => {
    const a = newDeliveryRefToken();
    const b = newDeliveryRefToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it("the header name carries no brand", () => {
    expect(DELIVERY_REF_HEADER).toBe("X-Delivery-Ref");
  });
});

describe("classifyFallbackReason (C29, T30)", () => {
  it("a login refusal is AUTH, whatever the provider wrote", () => {
    expect(
      classifyFallbackReason({ code: "EAUTH", message: "535 bad login for jane@example.com" }),
    ).toBe("AUTH");
    expect(classifyFallbackReason({ responseCode: 535, message: "x" })).toBe("AUTH");
    expect(
      classifyFallbackReason({ message: "Invalid login: 535-5.7.8 Username and Password" }),
    ).toBe("AUTH");
  });

  it("an unreachable server is CONNECT", () => {
    for (const code of [
      "ECONNECTION",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "ESOCKET",
      "EDNS",
    ]) {
      expect(classifyFallbackReason({ code, message: "x" })).toBe("CONNECT");
    }
  });

  it("a secure-connection failure is TLS", () => {
    expect(classifyFallbackReason({ code: "ETLS", message: "x" })).toBe("TLS");
    expect(classifyFallbackReason({ message: "self signed certificate" })).toBe("TLS");
    expect(classifyFallbackReason({ code: "ESSL", message: "x" })).toBe("TLS");
  });

  it("anything else, or nothing, is OTHER", () => {
    expect(classifyFallbackReason({ message: "boom" })).toBe("OTHER");
    expect(classifyFallbackReason(undefined)).toBe("OTHER");
    expect(classifyFallbackReason(null)).toBe("OTHER");
  });
});
