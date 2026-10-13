import {
  creationChannelOf,
  channelOfOrderSource,
  channelOfRole,
  channelsToJudge,
  leastPrivilegedPrincipal,
  orderSourceForRole,
  resolveLineAuthors,
  stricterChannel,
} from "./line-author-channel";
import * as channelModule from "./line-author-channel";
import { appendOrderRevisionInTx } from "./order-revisions";
import { readFileSync } from "fs";
import { join } from "path";

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
 * UNKNOWN_LEGACY, keyed on `Order.sourceRecorded` (no clock). Every create site of the new code writes
 * `sourceRecorded: true` with the principal's `source`; a row with `sourceRecorded: false` (every row that existed
 * before the column, and any row a rolled-back build writes) carries the column default APP whoever made it, so its
 * creation channel is STAFF. A revision is RECORDED when its snapshot carries `sourceRecorded: true`, which
 * `revisionSnapshot` stamps on every revision the new code writes. On a legacy order an unrecorded revision is
 * unknown history (STAFF whoever edited); a recorded revision's editor role counts, so a line a buyer path ADDS to a
 * legacy draft is still judged on the BUYER channel.
 */
describe("legacy source (Order.sourceRecorded)", () => {
  const T0 = new Date("2026-01-01T10:00:00.000Z"); // the legacy order's own createdAt
  const legacy = { source: "APP", sourceRecorded: false, createdAt: T0 };
  const recorded = { source: "APP", sourceRecorded: true, createdAt: T0 };
  /** A revision the new code wrote (marked) or an older one (unmarked). */
  const revBy = (
    marked: boolean,
    editedByRole: string | null,
    ...lines: Array<[string, number]>
  ) => ({
    editedByRole,
    snapshot: {
      ...(marked ? { sourceRecorded: true } : {}),
      lineItems: lines.map(([productId, qty]) => ({ productId, qty })),
    },
  });
  const line = (productId: string, createdAt: Date) => ({ productId, createdAt });
  const ms = (n: number) => new Date(T0.getTime() + n);

  it("creationChannelOf: sourceRecorded=false is STAFF whatever the source says; true follows the source", () => {
    expect(creationChannelOf({ source: "APP", sourceRecorded: false })).toBe("STAFF");
    expect(creationChannelOf({ source: "PHONE", sourceRecorded: false })).toBe("STAFF");
    expect(creationChannelOf({ source: "APP", sourceRecorded: true })).toBe("BUYER_PORTAL");
    expect(creationChannelOf({ source: "PHONE", sourceRecorded: true })).toBe("STAFF");
    // A caller that did not read the column gets the recorded source (the stricter reading), never STAFF.
    expect(creationChannelOf({ source: "APP" })).toBe("BUYER_PORTAL");
  });

  it("no clock: createdAt has no bearing on the creation channel", () => {
    const epoch = new Date(0);
    const future = new Date("2999-01-01T00:00:00.000Z");
    expect(creationChannelOf({ source: "APP", sourceRecorded: true, createdAt: epoch })).toBe(
      "BUYER_PORTAL",
    );
    expect(creationChannelOf({ source: "APP", sourceRecorded: false, createdAt: future })).toBe(
      "STAFF",
    );
  });

  it("the module exports no cutoff instant and builds no date", () => {
    const mod = channelModule as Record<string, unknown>;
    expect(Object.keys(mod).filter((k) => /RECORDED_FROM|CUTOFF/i.test(k))).toEqual([]);
    expect(Object.values(mod).filter((v) => v instanceof Date)).toEqual([]);
    const code = readFileSync(join(__dirname, "line-author-channel.ts"), "utf8");
    expect(code).not.toMatch(/new Date\(\s*["'`\d]|Date\.now\(/);
  });

  it("a legacy APP order with no edits is STAFF-authored", () => {
    expect(resolveLineAuthors(legacy, []).channelOf("p1")).toBe("STAFF");
  });

  it("a recorded APP order with no edits is BUYER-authored", () => {
    expect(resolveLineAuthors(recorded, []).channelOf("p1")).toBe("BUYER_PORTAL");
  });

  it("legacy: an unrecorded revision is unknown history, so STAFF whoever edited", () => {
    const a = resolveLineAuthors(legacy, [revBy(false, "CUSTOMER", ["old", 2])]);
    expect(a.channelOf("old")).toBe("STAFF");
  });

  it("legacy + a recorded buyer edit: the new line is BUYER, the baseline line stays STAFF", () => {
    const a = resolveLineAuthors(legacy, [
      revBy(false, "OPERATOR", ["old", 2]),
      revBy(true, "CUSTOMER", ["old", 2], ["new", 1]),
    ]);
    expect(a.channelOf("old")).toBe("STAFF");
    expect(a.channelOf("new")).toBe("BUYER_PORTAL");
  });

  describe("legacy, the FIRST revision is recorded (no earlier snapshot to diff against)", () => {
    it("a product whose lines carry the order's own createdAt (written by its create) stays STAFF", () => {
      const a = resolveLineAuthors(
        legacy,
        [revBy(true, "CUSTOMER", ["old", 2], ["new", 1])],
        [line("old", T0), line("new", ms(60_000))],
      );
      expect(a.channelOf("old")).toBe("STAFF");
      expect(a.channelOf("new")).toBe("BUYER_PORTAL");
    });

    it("a line written in the edit's own transaction, just before its revision row, is the editor's (BUYER)", () => {
      // The revision row lands 1 ms after the line it added (same transaction); its timestamp is not read.
      const revision = { ...revBy(true, "CUSTOMER", ["added", 1]), createdAt: ms(60_001) };
      const a = resolveLineAuthors(legacy, [revision], [line("added", ms(60_000))]);
      expect(a.channelOf("added")).toBe("BUYER_PORTAL");
    });

    it("a line OLDER than the order (moved in from another order) is not creation-authored: BUYER", () => {
      const a = resolveLineAuthors(
        legacy,
        [revBy(true, "CUSTOMER", ["moved", 1])],
        [line("moved", ms(-1))],
      );
      expect(a.channelOf("moved")).toBe("BUYER_PORTAL");
    });

    it("a product with one creation line and one later line is the editor's (BUYER)", () => {
      const a = resolveLineAuthors(
        legacy,
        [revBy(true, "CUSTOMER", ["p", 3])],
        [line("p", T0), line("p", ms(5))],
      );
      expect(a.channelOf("p")).toBe("BUYER_PORTAL");
    });

    it("no order createdAt: nothing reads as creation-authored (BUYER)", () => {
      const a = resolveLineAuthors(
        { source: "APP", sourceRecorded: false },
        [revBy(true, "CUSTOMER", ["old", 1])],
        [line("old", T0)],
      );
      expect(a.channelOf("old")).toBe("BUYER_PORTAL");
    });
  });

  it("legacy + a recorded system merge revision (no editor role): its new line is BUYER", () => {
    const a = resolveLineAuthors(legacy, [
      revBy(false, "OPERATOR", ["old", 2]),
      revBy(true, null, ["old", 2], ["cart", 1]),
    ]);
    expect(a.channelOf("old")).toBe("STAFF");
    expect(a.channelOf("cart")).toBe("BUYER_PORTAL");
  });

  it("a recorded order ignores the marker: an unmarked buyer revision still counts", () => {
    const a = resolveLineAuthors({ source: "PHONE", sourceRecorded: true }, [
      revBy(false, "OPERATOR", ["s", 1]),
      revBy(false, "CUSTOMER", ["s", 1], ["b", 1]),
    ]);
    expect(a.channelOf("s")).toBe("STAFF");
    expect(a.channelOf("b")).toBe("BUYER_PORTAL");
  });

  describe("legacy: a line with NO recorded buyer revision is STAFF, not unknown-buyer", () => {
    const bad = (marked: boolean, editedByRole: string | null) => ({
      editedByRole,
      snapshot: marked ? { sourceRecorded: true, lineItems: "nope" } : "not-a-snapshot",
    });

    it("an unreadable unrecorded snapshot is ignored (STAFF), not BUYER", () => {
      expect(resolveLineAuthors(legacy, [bad(false, "CUSTOMER")]).channelOf("p")).toBe("STAFF");
    });

    it("an unreadable recorded STAFF revision is still STAFF", () => {
      expect(resolveLineAuthors(legacy, [bad(true, "OPERATOR")]).channelOf("p")).toBe("STAFF");
    });

    it("a product no revision lists, with only staff/unrecorded revisions, is STAFF", () => {
      const a = resolveLineAuthors(legacy, [
        revBy(false, "CUSTOMER", ["a", 1]),
        revBy(true, "OPERATOR", ["a", 1]),
      ]);
      expect(a.channelOf("not-in-any-snapshot")).toBe("STAFF");
    });

    it("control: an unreadable recorded BUYER revision is unknown, so BUYER", () => {
      expect(resolveLineAuthors(legacy, [bad(true, "CUSTOMER")]).channelOf("p")).toBe(
        "BUYER_PORTAL",
      );
    });

    it("control: a product no revision lists, with a recorded buyer revision present, is BUYER", () => {
      const a = resolveLineAuthors(legacy, [revBy(true, "CUSTOMER", ["a", 1])]);
      expect(a.channelOf("not-in-any-snapshot")).toBe("BUYER_PORTAL");
    });

    it("control: a NON-legacy order keeps unknown = BUYER", () => {
      const fresh = { source: "PHONE", sourceRecorded: true };
      expect(resolveLineAuthors(fresh, [bad(true, "OPERATOR")]).channelOf("p")).toBe(
        "BUYER_PORTAL",
      );
      expect(resolveLineAuthors(fresh, [revBy(true, "OPERATOR", ["a", 1])]).channelOf("zzz")).toBe(
        "BUYER_PORTAL",
      );
    });
  });
});

describe("revisionSnapshot marks every revision the new code writes (sourceRecorded: true)", () => {
  it("appendOrderRevisionInTx stamps the marker on the snapshot it inserts", async () => {
    const create = jest.fn().mockResolvedValue({});
    const tx = {
      orderItem: { findMany: jest.fn().mockResolvedValue([]) },
      orderRevision: { aggregate: jest.fn().mockResolvedValue({ _max: {} }), create },
    };
    await appendOrderRevisionInTx(
      tx as never,
      "t-1",
      "ord-1",
      { sub: "u", role: "CUSTOMER" } as never,
      { subtotal: 0, tax: 0, total: 0 },
      "EDIT",
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          snapshot: expect.objectContaining({ sourceRecorded: true, lineItems: [] }),
        }),
      }),
    );
  });
});
