/**
 * Row 195 / SA-756r — the live-target guard. A protected tenant (paying, Stripe-linked, or named in
 * PROTECTED_TENANT_SLUGS) must be untouchable by a live-capable writer unless an operator names its
 * id AND types a confirmation at a real terminal. Ids and counts only: no slug in any output.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require("../../scripts/lib/live-target-guard.cjs");

const LISTED = new Set(["acme-foods"]);
const NONE = new Set<string>();
const trial = (over = {}) => ({
  id: "t-trial",
  slug: "acme-foods",
  status: "TRIAL",
  class: "PRODUCTION",
  deletedAt: null,
  ...over,
});
const tty = { isTTY: true };
const noTty = { isTTY: false };
const PHRASE = "ALLOW PROTECTED t-trial";

describe("filterWritableTenants", () => {
  const rows = [
    trial(),
    trial({ id: "t-paying", slug: "acme-paying", status: "ACTIVE" }),
    trial({ id: "t-stripe", slug: "acme-stripe", class: "TEST" }),
    trial({ id: "t-plain", slug: "acme-plain" }),
  ];
  const subs = new Map<string, object>([
    ["t-paying", { planKey: "STARTER", stripeSubId: null, couponFull: false }],
    ["t-stripe", { planKey: null, stripeSubId: "sub_fake_qa", couponFull: false }],
  ]);

  it("drops protected rows and prints per-arm counts only", () => {
    const lines: string[] = [];
    const out = guard.filterWritableTenants(rows, subs, LISTED, {
      log: (l: string) => lines.push(l),
    });
    expect(out.writable.map((r: { id: string }) => r.id)).toEqual(["t-plain"]);
    expect(out.skipped).toEqual({ paying: 1, "stripe-linked": 1, "env-listed": 1, total: 3 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/skipped 3 of 4/);
    expect(lines.join("\n")).not.toMatch(/acme/);
  });

  it("accepts a plain object for subsById", () => {
    const out = guard.filterWritableTenants(
      rows,
      { "t-paying": { planKey: "STARTER", couponFull: false } },
      NONE,
      {
        log: () => undefined,
      },
    );
    expect(out.writable.map((r: { id: string }) => r.id)).toEqual([
      "t-trial",
      "t-stripe",
      "t-plain",
    ]);
  });
});

describe("assertWritableTenant", () => {
  it("passes an unprotected tenant", () => {
    expect(guard.assertWritableTenant(trial({ slug: "acme-deli" }), null, LISTED)).toBeNull();
  });

  it("refuses an env-listed trial tenant, naming the id and arm but never the slug", () => {
    let message = "";
    try {
      guard.assertWritableTenant(trial(), null, LISTED);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/t-trial is protected \(env-listed\)/);
    expect(message).not.toMatch(/acme/);
  });

  it("a soft-deleted env-listed tenant is still refused", () => {
    expect(() =>
      guard.assertWritableTenant(trial({ deletedAt: new Date() }), null, LISTED),
    ).toThrow(/protected/);
  });

  it("a bare `true` is not an override", () => {
    expect(() =>
      guard.assertWritableTenant(trial(), null, LISTED, { allowProtected: true }),
    ).toThrow(/protected/);
  });
});

describe("confirmProtectedOverride", () => {
  const base = (over = {}) => ({
    tenantId: "t-trial",
    argv: ["--allow-protected", "t-trial", "--backup-taken"],
    stdin: tty,
    stdout: tty,
    ask: async () => PHRASE,
    ...over,
  });

  it("mints a token that assertWritableTenant accepts for that tenant only", async () => {
    const token = await guard.confirmProtectedOverride(base());
    expect(guard.assertWritableTenant(trial(), null, LISTED, { allowProtected: token })).toBe(
      "env-listed",
    );
    expect(() =>
      guard.assertWritableTenant(trial({ id: "t-other" }), null, LISTED, { allowProtected: token }),
    ).toThrow(/protected/);
  });

  it("non-TTY stdin is refused (no argv/env form of the phrase exists)", async () => {
    await expect(guard.confirmProtectedOverride(base({ stdin: noTty }))).rejects.toThrow(
      /real terminal/,
    );
  });

  it("non-TTY stdout is refused", async () => {
    await expect(guard.confirmProtectedOverride(base({ stdout: noTty }))).rejects.toThrow(
      /real terminal/,
    );
  });

  it("a flag naming another tenant, or no flag, is refused", async () => {
    await expect(
      guard.confirmProtectedOverride(
        base({ argv: ["--allow-protected", "t-x", "--backup-taken"] }),
      ),
    ).rejects.toThrow(/must name this tenant/);
    await expect(
      guard.confirmProtectedOverride(base({ argv: ["--backup-taken"] })),
    ).rejects.toThrow(/must name this tenant/);
  });

  it("the flag may repeat (one per protected tenant) and a script may name its own backup flag", async () => {
    const token = await guard.confirmProtectedOverride(
      base({
        argv: [
          "--allow-protected",
          "t-x",
          "--allow-protected",
          "t-trial",
          "--i-have-a-fresh-backup",
        ],
        backupFlag: "--i-have-a-fresh-backup",
      }),
    );
    expect(token.tenantId).toBe("t-trial");
  });

  it("--backup-taken is required", async () => {
    await expect(
      guard.confirmProtectedOverride(base({ argv: ["--allow-protected", "t-trial"] })),
    ).rejects.toThrow(/--backup-taken/);
  });

  it("a wrong typed phrase is refused", async () => {
    await expect(guard.confirmProtectedOverride(base({ ask: async () => "yes" }))).rejects.toThrow(
      /did not match/,
    );
  });

  it("--allow-paying-tenant is retired: an unknown argument", async () => {
    expect(() => guard.refuseRetiredFlags(["--allow-paying-tenant"])).toThrow(/unknown argument/);
    expect(() => guard.refuseRetiredFlags(["--confirm-paying"])).toThrow(/unknown argument/);
    await expect(
      guard.confirmProtectedOverride(base({ argv: [...base().argv, "--allow-paying-tenant"] })),
    ).rejects.toThrow(/unknown argument/);
  });
});

describe("confirmProtectedAdditive", () => {
  const counts = { paying: 2, "stripe-linked": 1, "env-listed": 1 };
  const base = (over = {}) => ({
    counts,
    tenantIds: ["t-trial", "t-other"],
    argv: ["--backup-taken"],
    stdin: tty,
    stdout: tty,
    ask: async () => "ALLOW PROTECTED ADDITIVE 4",
    log: () => undefined,
    ...over,
  });

  it("returns null and asks nothing when no protected tenant is in the run", async () => {
    const ask = jest.fn();
    await expect(
      guard.confirmProtectedAdditive(base({ counts: { paying: 0 }, ask })),
    ).resolves.toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  it("prints counts per arm only, and one valid confirmation covers every tenant of the run", async () => {
    const lines: string[] = [];
    const token = await guard.confirmProtectedAdditive(base({ log: (l: string) => lines.push(l) }));
    expect(lines.join("\n")).toMatch(/4 \(paying 2 · stripe-linked 1 · env-listed 1\)/);
    expect(lines.join("\n")).not.toMatch(/acme/);
    expect(guard.assertWritableTenant(trial(), null, LISTED, { allowProtected: token })).toBe(
      "env-listed",
    );
    expect(
      guard.assertWritableTenant(trial({ id: "t-other" }), null, LISTED, { allowProtected: token }),
    ).toBe("env-listed");
  });

  it("the token is bound to the run's tenant set: a tenant outside it is refused", async () => {
    const token = await guard.confirmProtectedAdditive(base());
    expect(() =>
      guard.assertWritableTenant(trial({ id: "t-never-counted" }), null, LISTED, {
        allowProtected: token,
      }),
    ).toThrow(/protected/);
    await expect(guard.confirmProtectedAdditive(base({ tenantIds: undefined }))).rejects.toThrow(
      /tenantIds/,
    );
  });

  it("an old backup flag still works as an alias, with a deprecation line; --backup-taken does not warn", async () => {
    const logs: string[] = [];
    const spy = jest.spyOn(console, "error").mockImplementation((l: string) => void logs.push(l));
    try {
      await guard.confirmProtectedAdditive(
        base({ argv: ["--backup-attested"], backupFlag: "--backup-attested" }),
      );
      expect(logs.join("\n")).toMatch(/deprecated: --backup-attested — use --backup-taken/);
      logs.length = 0;
      await guard.confirmProtectedAdditive(
        base({ argv: ["--backup-taken"], backupFlag: "--backup-attested" }),
      );
      expect(logs).toEqual([]);
      const token = await guard.confirmProtectedOverride({
        tenantId: "t-trial",
        argv: ["--allow-protected", "t-trial", "--i-have-a-fresh-backup"],
        stdin: tty,
        stdout: tty,
        ask: async () => PHRASE,
        backupFlag: "--i-have-a-fresh-backup",
      });
      expect(token.tenantId).toBe("t-trial");
      expect(logs.join("\n")).toMatch(/deprecated: --i-have-a-fresh-backup/);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses without --backup-taken, on a non-TTY, and on a wrong count", async () => {
    await expect(guard.confirmProtectedAdditive(base({ argv: [] }))).rejects.toThrow(
      /--backup-taken/,
    );
    await expect(guard.confirmProtectedAdditive(base({ stdin: noTty }))).rejects.toThrow(
      /real terminal/,
    );
    await expect(
      guard.confirmProtectedAdditive(base({ ask: async () => "ALLOW PROTECTED ADDITIVE 3" })),
    ).rejects.toThrow(/did not match/);
  });
});

describe("protectedTenantIds", () => {
  const rows = [
    {
      id: "t-trial",
      slug: "acme-foods",
      status: "TRIAL",
      class: "PRODUCTION",
      deletedAt: null,
      planKey: null,
      stripeSubId: null,
      couponFull: false,
    },
    {
      id: "t-paying",
      slug: "acme-paying",
      status: "ACTIVE",
      class: "PRODUCTION",
      deletedAt: null,
      planKey: "STARTER",
      stripeSubId: null,
      couponFull: false,
    },
    {
      id: "t-plain",
      slug: "acme-plain",
      status: "TRIAL",
      class: "PRODUCTION",
      deletedAt: null,
      planKey: null,
      stripeSubId: null,
      couponFull: false,
    },
  ];

  it("returns the protected ids from a pg-style client", async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows }) };
    await expect(guard.protectedTenantIds(client, LISTED)).resolves.toEqual([
      "t-trial",
      "t-paying",
    ]);
  });

  it("returns the protected ids from a Prisma-style client", async () => {
    const client = { $queryRawUnsafe: jest.fn().mockResolvedValue(rows) };
    await expect(guard.protectedTenantIds(client, LISTED)).resolves.toEqual([
      "t-trial",
      "t-paying",
    ]);
  });

  it("throws when a row lacks a string slug", async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ ...rows[2], slug: null }] }) };
    await expect(guard.protectedTenantIds(client, LISTED)).rejects.toThrow(/no string slug/);
  });
});

describe("assertNoLiveProtectedTenants (tunnel-proof refusal for destructive local scripts)", () => {
  const row = (over = {}) => ({
    id: "t-a",
    slug: "acme-foods",
    status: "TRIAL",
    class: "PRODUCTION",
    deletedAt: null,
    planKey: null,
    stripeSubId: null,
    couponFull: false,
    ...over,
  });

  it("passes a local database that holds only test tenants, even paying-looking ones", async () => {
    const client = {
      query: jest.fn().mockResolvedValue({
        rows: [
          row({ id: "t-1", slug: "qa-lite", status: "ACTIVE", planKey: "STARTER" }),
          row({ id: "t-2", slug: "test", stripeSubId: "sub_fake_qa" }),
        ],
      }),
    };
    await expect(guard.assertNoLiveProtectedTenants(client, NONE)).resolves.toBeUndefined();
  });

  it("passes when no tenant is protected", async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [row({ slug: "acme-deli" })] }) };
    await expect(guard.assertNoLiveProtectedTenants(client, LISTED)).resolves.toBeUndefined();
  });

  it("refuses a database that holds a protected non-test tenant, with counts only", async () => {
    const client = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValue([
          row(),
          row({ id: "t-p", slug: "acme-paying", status: "ACTIVE", planKey: "STARTER" }),
        ]),
    };
    const err = await guard.assertNoLiveProtectedTenants(client, LISTED).catch((e: Error) => e);
    expect(err).toBeInstanceOf(guard.ProtectedTenantError);
    expect(err.message).toMatch(/2 protected non-test tenant/);
    expect(err.message).toMatch(/paying 1 · stripe-linked 0 · env-listed 1/);
    expect(err.message).not.toMatch(/acme/);
  });
});

describe("--check output", () => {
  it("prints counts only, and flags a configured slug that matches no tenant", () => {
    expect(guard.describeCheck(2, 2)).toEqual(["2 configured · 2 matched a tenant"]);
    const lines = guard.describeCheck(2, 1);
    expect(lines[0]).toBe("2 configured · 1 matched a tenant");
    expect(lines[1]).toMatch(/UNMATCHED: 1/);
  });
});
