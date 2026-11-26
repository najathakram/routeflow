import {
  MAIL_WALL_MAX_ENTRIES,
  isSinglePlainAddress,
  decideRecipientWall,
  mailWallAllows,
  mailWallKey,
  normalizeMailWallEntry,
  parseMailWallValue,
  writeMailWall,
} from "./recipient-wall";

describe("recipient wall: entries", () => {
  it.each([
    ["Tester@Acme.Example ", "tester@acme.example"],
    ["tester+*@acme.example", "tester+*@acme.example"],
    ["tester+orders@acme.example", "tester+orders@acme.example"],
  ])("accepts %j as %j", (raw, want) => {
    expect(normalizeMailWallEntry(raw)).toBe(want);
  });

  it.each([
    "@gmail.com",
    "*@gmail.com",
    "gmail.com",
    "+*@gmail.com",
    "a b@acme.example",
    "te%st@acme.example",
    "tester+a%b@acme.example",
    "",
    "a@b",
    7,
    null,
  ])("refuses %j (never a whole mail domain, never a wildcard domain)", (raw) => {
    expect(normalizeMailWallEntry(raw)).toBeNull();
  });
});

describe("recipient wall: reading a stored value", () => {
  it("no row is absent; a good array is a list; anything else is unreadable", () => {
    expect(parseMailWallValue(null)).toEqual({ kind: "absent" });
    expect(parseMailWallValue('["a@acme.example"]')).toEqual({
      kind: "list",
      entries: ["a@acme.example"],
    });
    expect(parseMailWallValue("{")).toEqual({ kind: "unreadable" });
    expect(parseMailWallValue('["*@gmail.com"]')).toEqual({ kind: "unreadable" });
    const tooMany = JSON.stringify(
      Array.from({ length: MAIL_WALL_MAX_ENTRIES + 1 }, (_, i) => `u${i}@acme.example`),
    );
    expect(parseMailWallValue(tooMany)).toEqual({ kind: "unreadable" });
  });
});

describe("recipient wall: the rule", () => {
  const list = { kind: "list" as const, entries: ["a@acme.example", "b+*@acme.example"] };
  it("matches exactly, and plus-addressing only for a plus entry", () => {
    expect(mailWallAllows(list.entries, "A@ACME.example")).toBe(true);
    expect(mailWallAllows(list.entries, "b+x@acme.example")).toBe(true);
    expect(mailWallAllows(list.entries, "b+@acme.example")).toBe(false);
    expect(mailWallAllows(list.entries, "a+x@acme.example")).toBe(false);
    expect(mailWallAllows(list.entries, "xb+x@acme.example")).toBe(false);
  });
  it("walls only TEST: list, unreadable and absent each decide as specified", () => {
    expect(decideRecipientWall({ klass: "TEST", list, to: "z@acme.example" })).toBe("hold");
    expect(decideRecipientWall({ klass: "TEST", list, to: "a@acme.example" })).toBe("allow");
    expect(
      decideRecipientWall({ klass: "TEST", list: { kind: "unreadable" }, to: "a@acme.example" }),
    ).toBe("hold");
    expect(
      decideRecipientWall({ klass: "TEST", list: { kind: "absent" }, to: "a@acme.example" }),
    ).toBe("would-hold");
    for (const klass of ["PRODUCTION", "DEMO", "INTERNAL"]) {
      expect(decideRecipientWall({ klass, list, to: "z@acme.example" })).toBe("allow");
    }
  });
});

describe("recipient wall: the store", () => {
  const fake = () => {
    const executed: unknown[][] = [];
    const prisma = {
      $executeRaw: jest.fn(async (...args: unknown[]) => {
        executed.push(args);
        return 1;
      }),
    } as any;
    return { prisma, executed };
  };

  it("writes a de-duplicated, normalised list under the business's own key", async () => {
    const { prisma, executed } = fake();
    const stored = await writeMailWall(prisma, "t1", [
      "A@acme.example",
      "a@acme.example",
      "b+*@acme.example",
    ]);
    expect(stored).toEqual(["a@acme.example", "b+*@acme.example"]);
    // template values: [strings, key, value]
    expect(executed[0][1]).toBe(mailWallKey("t1"));
    expect(executed[0][2]).toBe(JSON.stringify(stored));
  });

  it("an empty list removes the row (back to the dark step)", async () => {
    const { prisma, executed } = fake();
    expect(await writeMailWall(prisma, "t1", [])).toEqual([]);
    expect(String((executed[0][0] as string[]).join(""))).toMatch(/DELETE FROM "PlatformConfig"/);
  });
});

describe("mailWallAllows: only a single plain address can match (H1)", () => {
  const entries = ["tester+*@acme.test", "tester@acme.test"];
  it.each([
    "tester+a@evil.test,tester+x@acme.test",
    "tester+Evil <evil@evil.test>@acme.test",
    "tester+x@evil.test@acme.test",
    '"tester+x@acme.test"',
    "tester+x@acme.test, b@evil.test",
    "tester@acme.test;b@evil.test",
  ])("%j matches nothing", (to) => {
    expect(mailWallAllows(entries, to)).toBe(false);
  });
  it("a plain address still matches", () => {
    expect(mailWallAllows(entries, "tester+x@acme.test")).toBe(true);
    expect(mailWallAllows(entries, "Tester@Acme.test")).toBe(true);
  });
});

describe("mailWallAllows: the local part is a closed character set (H1 residual)", () => {
  const entries = ["tester+*@acme.test"];
  it.each([
    "tester+a:b@acme.test",
    "tester+a%b@acme.test",
    "tester+a!b@acme.test",
    "tester+a[b@acme.test",
    "tester+é@acme.test",
  ])("%j matches nothing", (to) => expect(mailWallAllows(entries, to)).toBe(false));
});

describe("isSinglePlainAddress: the domain is ASCII letters, digits, dot and hyphen only", () => {
  it.each(["a@é.test", "a@acme.tést", "a@ac_me.test", "a@acme.test!"])("%j is not plain", (to) => {
    expect(isSinglePlainAddress(to)).toBe(false);
  });
  it("an ASCII domain is plain", () => {
    expect(isSinglePlainAddress("a@sub-1.acme.test")).toBe(true);
  });
});
