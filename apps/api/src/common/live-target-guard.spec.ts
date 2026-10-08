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
    ["t-paying", { planKey: "STARTER", stripeSubId: null }],
    ["t-stripe", { planKey: null, stripeSubId: "sub_fake_qa" }],
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
    const out = guard.filterWritableTenants(rows, { "t-paying": { planKey: "STARTER" } }, NONE, {
      log: () => undefined,
    });
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
    },
    {
      id: "t-paying",
      slug: "acme-paying",
      status: "ACTIVE",
      class: "PRODUCTION",
      deletedAt: null,
      planKey: "STARTER",
      stripeSubId: null,
    },
    {
      id: "t-plain",
      slug: "acme-plain",
      status: "TRIAL",
      class: "PRODUCTION",
      deletedAt: null,
      planKey: null,
      stripeSubId: null,
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

describe("--check output", () => {
  it("prints counts only, and flags a configured slug that matches no tenant", () => {
    expect(guard.describeCheck(2, 2)).toEqual(["2 configured · 2 matched a tenant"]);
    const lines = guard.describeCheck(2, 1);
    expect(lines[0]).toBe("2 configured · 1 matched a tenant");
    expect(lines[1]).toMatch(/UNMATCHED: 1/);
  });
});
