import {
  ORDER_SOURCE_RECORDED_FROM,
  creationChannelOf,
  channelOfOrderSource,
  channelOfRole,
  channelsToJudge,
  leastPrivilegedPrincipal,
  orderSourceForRole,
  resolveLineAuthors,
  stricterChannel,
} from "./line-author-channel";

/**
 * F1(i): a DRAFT line is judged at the STRICTER of the promoter's channel and the channel of whoever AUTHORED
 * the line. No line records its author, so the author is derived from what an order does record: its creation
 * `source` (APP = buyer, PHONE/ROUTE = staff/driver) and its edit revisions (editor role + line snapshot after
 * each edit). Anything unknown is the BUYER channel, the stricter one.
 */
const rev = (editedByRole: string | null, ...lines: Array<[string, number]>) => ({
  editedByRole,
  snapshot: { lineItems: lines.map(([productId, qty]) => ({ productId, qty })) },
});

describe("channel primitives", () => {
  it("stricterChannel: BUYER_PORTAL wins, STAFF only when both are", () => {
    expect(stricterChannel("STAFF", "STAFF")).toBe("STAFF");
    expect(stricterChannel("STAFF", "BUYER_PORTAL")).toBe("BUYER_PORTAL");
    expect(stricterChannel("BUYER_PORTAL", "STAFF")).toBe("BUYER_PORTAL");
    expect(stricterChannel("BUYER_PORTAL", "BUYER_PORTAL")).toBe("BUYER_PORTAL");
  });

  it("channelOfRole: staff roles and the driver are STAFF; customer, null and unknown are BUYER_PORTAL", () => {
    for (const r of ["OPERATOR", "TENANT_ADMIN", "SUPER_ADMIN", "DRIVER"])
      expect(channelOfRole(r)).toBe("STAFF");
    for (const r of ["CUSTOMER", null, undefined, "SOMETHING_NEW"])
      expect(channelOfRole(r)).toBe("BUYER_PORTAL");
  });

  it("orderSourceForRole / channelOfOrderSource round-trip, and an unknown source is the buyer", () => {
    expect(orderSourceForRole("OPERATOR")).toBe("PHONE");
    expect(orderSourceForRole("TENANT_ADMIN")).toBe("PHONE");
    expect(orderSourceForRole("DRIVER")).toBe("ROUTE");
    expect(orderSourceForRole("CUSTOMER")).toBe("APP");
    expect(orderSourceForRole(null)).toBe("APP");
    expect(channelOfOrderSource("PHONE")).toBe("STAFF");
    expect(channelOfOrderSource("ROUTE")).toBe("STAFF");
    expect(channelOfOrderSource("APP")).toBe("BUYER_PORTAL");
    expect(channelOfOrderSource(null)).toBe("BUYER_PORTAL");
    expect(channelOfOrderSource(undefined)).toBe("BUYER_PORTAL");
    expect(channelOfOrderSource("WHATEVER")).toBe("BUYER_PORTAL");
  });
});

describe("resolveLineAuthors", () => {
  it("a buyer line: an order created through the app with no edits is buyer-authored", () => {
    expect(resolveLineAuthors({ source: "APP" }, []).channelOf("p1")).toBe("BUYER_PORTAL");
  });

  it("a staff line: an order created by staff with no edits is staff-authored", () => {
    expect(resolveLineAuthors({ source: "PHONE" }, []).channelOf("p1")).toBe("STAFF");
    expect(resolveLineAuthors({ source: "ROUTE" }, []).channelOf("p1")).toBe("STAFF");
  });

  it("unknown: no source recorded (or a value that is not staff) is the BUYER channel", () => {
    expect(resolveLineAuthors({ source: null }, []).channelOf("p1")).toBe("BUYER_PORTAL");
    expect(resolveLineAuthors({}, []).channelOf("p1")).toBe("BUYER_PORTAL");
  });

  it("merge provenance: a system revision (no editor role) makes the lines it adds or raises buyer-authored", () => {
    const authors = resolveLineAuthors({ source: "PHONE" }, [
      rev("OPERATOR", ["p1", 2]),
      rev(null, ["p1", 2], ["p2", 5]), // the fold added p2
    ]);
    expect(authors.channelOf("p1")).toBe("STAFF");
    expect(authors.channelOf("p2")).toBe("BUYER_PORTAL");
  });

  it("mixed order: a staff-created draft the buyer then added to keeps each line on its author's channel", () => {
    const authors = resolveLineAuthors({ source: "PHONE" }, [
      rev("OPERATOR", ["staff-line", 3]),
      rev("CUSTOMER", ["staff-line", 3], ["buyer-line", 1]),
      rev("OPERATOR", ["staff-line", 3], ["buyer-line", 1], ["staff-line-2", 4]),
    ]);
    expect(authors.channelOf("staff-line")).toBe("STAFF");
    expect(authors.channelOf("buyer-line")).toBe("BUYER_PORTAL");
    expect(authors.channelOf("staff-line-2")).toBe("STAFF");
  });

  it("a buyer who RAISES the quantity of a staff line makes that line buyer-authored (the stricter wins)", () => {
    const authors = resolveLineAuthors({ source: "PHONE" }, [
      rev("OPERATOR", ["p1", 2]),
      rev("CUSTOMER", ["p1", 6]),
    ]);
    expect(authors.channelOf("p1")).toBe("BUYER_PORTAL");
  });

  it("a buyer who LOWERS a staff line's quantity (or leaves it) does not take it over", () => {
    const authors = resolveLineAuthors({ source: "PHONE" }, [
      rev("OPERATOR", ["p1", 6], ["p2", 1]),
      rev("CUSTOMER", ["p1", 2], ["p2", 1]),
    ]);
    expect(authors.channelOf("p1")).toBe("STAFF");
    expect(authors.channelOf("p2")).toBe("STAFF");
  });

  it("a staff edit never launders a buyer line: it stays buyer-authored", () => {
    const authors = resolveLineAuthors({ source: "APP" }, [
      rev("CUSTOMER", ["p1", 2]),
      rev("OPERATOR", ["p1", 2], ["p2", 1]),
      rev("OPERATOR", ["p1", 9], ["p2", 1]),
    ]);
    expect(authors.channelOf("p1")).toBe("BUYER_PORTAL");
    expect(authors.channelOf("p2")).toBe("STAFF");
  });

  it("the first edit of a buyer-created order cannot tell which lines it added: every line stays buyer", () => {
    const authors = resolveLineAuthors({ source: "APP" }, [rev("OPERATOR", ["p1", 2], ["p2", 1])]);
    expect(authors.channelOf("p1")).toBe("BUYER_PORTAL");
    expect(authors.channelOf("p2")).toBe("BUYER_PORTAL");
  });

  it("a line the recorded history does not account for is unknown, so buyer", () => {
    const authors = resolveLineAuthors({ source: "PHONE" }, [rev("OPERATOR", ["p1", 2])]);
    expect(authors.channelOf("p-never-recorded")).toBe("BUYER_PORTAL");
  });

  it("a malformed snapshot is treated as unknown, not as staff", () => {
    const authors = resolveLineAuthors({ source: "PHONE" }, [
      { editedByRole: "OPERATOR", snapshot: null },
      { editedByRole: "OPERATOR", snapshot: { lineItems: "nope" } },
    ]);
    expect(authors.channelOf("p1")).toBe("BUYER_PORTAL");
  });

  it("a removed then re-added product is authored by whoever re-added it", () => {
    const authors = resolveLineAuthors({ source: "PHONE" }, [
      rev("OPERATOR", ["p1", 2]),
      rev("OPERATOR"),
      rev("CUSTOMER", ["p1", 2]),
    ]);
    expect(authors.channelOf("p1")).toBe("BUYER_PORTAL");
  });
});

describe("channelsToJudge: the stricter of the author's and the promoter's channel, per product", () => {
  const staffDraft = resolveLineAuthors({ source: "PHONE" }, []);
  const buyerDraft = resolveLineAuthors({ source: "APP" }, []);
  const mixed = resolveLineAuthors({ source: "PHONE" }, [
    rev("OPERATOR", ["s", 1]),
    rev("CUSTOMER", ["s", 1], ["b", 1]),
  ]);

  it("promoter staff, every line staff: ONE group on STAFF (today's behaviour)", () => {
    expect(channelsToJudge(["a", "b"], staffDraft, "STAFF")).toEqual([
      { channel: "STAFF", productIds: ["a", "b"] },
    ]);
  });

  it("promoter staff, buyer-authored lines: judged on BUYER_PORTAL", () => {
    expect(channelsToJudge(["a", "b"], buyerDraft, "STAFF")).toEqual([
      { channel: "BUYER_PORTAL", productIds: ["a", "b"] },
    ]);
  });

  it("promoter staff, mixed order: each product on its own side", () => {
    expect(channelsToJudge(["s", "b"], mixed, "STAFF")).toEqual([
      { channel: "BUYER_PORTAL", productIds: ["b"] },
      { channel: "STAFF", productIds: ["s"] },
    ]);
  });

  it("promoter buyer: everything is judged on BUYER_PORTAL, whoever authored it", () => {
    expect(channelsToJudge(["s", "b"], mixed, "BUYER_PORTAL")).toEqual([
      { channel: "BUYER_PORTAL", productIds: ["s", "b"] },
    ]);
    expect(channelsToJudge(["a"], staffDraft, "BUYER_PORTAL")).toEqual([
      { channel: "BUYER_PORTAL", productIds: ["a"] },
    ]);
  });

  it("no products: nothing to judge", () => {
    expect(channelsToJudge([], mixed, "STAFF")).toEqual([]);
  });
});

describe("leastPrivilegedPrincipal (the at-door approval): staff only when resolver AND requester are staff", () => {
  const driver = { role: "DRIVER", sub: "d" };
  const operator = { role: "OPERATOR", sub: "o" };

  it("staff resolver + staff requester: the resolver itself (STAFF judgement kept)", () => {
    expect(leastPrivilegedPrincipal(driver, "DRIVER")).toBe(driver);
    expect(leastPrivilegedPrincipal(operator, "OPERATOR")).toBe(operator);
  });

  it("staff resolver + buyer, unknown or missing requester: the buyer principal", () => {
    for (const requester of ["CUSTOMER", null, undefined, "NEW_ROLE"])
      expect(leastPrivilegedPrincipal(driver, requester)).toEqual({ type: "BUYER" });
  });

  it("buyer resolver stays buyer even for a staff requester", () => {
    expect(leastPrivilegedPrincipal({ role: "CUSTOMER", type: "BUYER" }, "OPERATOR")).toEqual({
      type: "BUYER",
    });
  });
});

/**
 * The legacy-source CUTOFF. `Order.source` was only written from the creating principal from
 * ORDER_SOURCE_RECORDED_FROM on; before that every row carries the column default APP, which says nothing about who
 * created it. A row created before the cutoff is UNKNOWN_LEGACY and its creation channel is STAFF; a buyer path that
 * ADDS a line after the cutoff is still judged on the BUYER channel.
 */
describe("legacy-source cutoff", () => {
  const before = new Date(ORDER_SOURCE_RECORDED_FROM.getTime() - 1);
  const after = new Date(ORDER_SOURCE_RECORDED_FROM.getTime());
  const revAt = (
    createdAt: Date,
    editedByRole: string | null,
    ...lines: Array<[string, number]>
  ) => ({ ...rev(editedByRole, ...lines), createdAt });
  const line = (productId: string, createdAt: Date) => ({ productId, createdAt });

  it("ORDER_SOURCE_RECORDED_FROM is pinned (PLACEHOLDER: the lead sets the real deploy instant; change it deliberately)", () => {
    expect(ORDER_SOURCE_RECORDED_FROM.toISOString()).toBe("2026-10-16T00:00:00.000Z");
  });

  it("creationChannelOf: before the cutoff is STAFF whatever the source says; at/after it follows the source", () => {
    expect(creationChannelOf({ source: "APP", createdAt: before })).toBe("STAFF");
    expect(creationChannelOf({ source: "PHONE", createdAt: before })).toBe("STAFF");
    expect(creationChannelOf({ source: "APP", createdAt: after })).toBe("BUYER_PORTAL");
    expect(creationChannelOf({ source: "PHONE", createdAt: after })).toBe("STAFF");
    expect(creationChannelOf({ source: "APP" })).toBe("BUYER_PORTAL"); // no createdAt: the recorded source
  });

  it("a legacy APP order with no edits is STAFF-authored", () => {
    expect(resolveLineAuthors({ source: "APP", createdAt: before }, []).channelOf("p1")).toBe(
      "STAFF",
    );
  });

  it("a post-cutoff APP order with no edits is BUYER-authored", () => {
    expect(resolveLineAuthors({ source: "APP", createdAt: after }, []).channelOf("p1")).toBe(
      "BUYER_PORTAL",
    );
  });

  it("legacy: revisions before the cutoff are unknown history, so STAFF whoever edited", () => {
    const a = resolveLineAuthors({ source: "APP", createdAt: before }, [
      revAt(before, "CUSTOMER", ["old", 2]),
    ]);
    expect(a.channelOf("old")).toBe("STAFF");
  });

  it("legacy + a buyer edit after the cutoff: the new line is BUYER, the baseline line stays STAFF", () => {
    const a = resolveLineAuthors({ source: "APP", createdAt: before }, [
      revAt(before, "OPERATOR", ["old", 2]),
      revAt(after, "CUSTOMER", ["old", 2], ["new", 1]),
    ]);
    expect(a.channelOf("old")).toBe("STAFF");
    expect(a.channelOf("new")).toBe("BUYER_PORTAL");
  });

  it("legacy, the ONLY revision is post-cutoff: lines that predate the cutoff stay STAFF, a later line is BUYER", () => {
    const a = resolveLineAuthors(
      { source: "APP", createdAt: before },
      [revAt(after, "CUSTOMER", ["old", 2], ["new", 1])],
      [line("old", before), line("new", after)],
    );
    expect(a.channelOf("old")).toBe("STAFF");
    expect(a.channelOf("new")).toBe("BUYER_PORTAL");
  });

  it("legacy + a system merge revision (no editor role) after the cutoff: its new line is BUYER", () => {
    const a = resolveLineAuthors({ source: "APP", createdAt: before }, [
      revAt(before, "OPERATOR", ["old", 2]),
      revAt(after, null, ["old", 2], ["cart", 1]),
    ]);
    expect(a.channelOf("old")).toBe("STAFF");
    expect(a.channelOf("cart")).toBe("BUYER_PORTAL");
  });
});
