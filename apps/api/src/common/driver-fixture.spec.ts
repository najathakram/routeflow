// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ensureDriverUser } = require("../../scripts/lib/driver-fixture.cjs") as {
  ensureDriverUser: (a: {
    prisma: unknown;
    hash: (pw: string) => Promise<string>;
    tenantId: string;
    username: string;
    email: string;
    password: string;
  }) => Promise<{ user: { id: string } | null; created: boolean }>;
};

// e2e-seed only created the driver when missing, so a driver seeded earlier kept its old password
// forever. The existing-user path must re-hash from E2E_DRIVER_PASSWORD.
function fakePrisma(existing: { id: string } | null) {
  return {
    user: {
      findFirst: jest.fn().mockResolvedValue(existing),
      create: jest.fn().mockImplementation(async ({ data }) => ({ id: "new", ...data })),
      update: jest.fn().mockImplementation(async ({ where, data }) => ({ id: where.id, ...data })),
    },
  };
}
const hash = async (pw: string) => `h(${pw})`;
const base = { tenantId: "t1", username: "e2e_driver", email: "d@x.test" };

describe("ensureDriverUser", () => {
  it("skips entirely when the password env is unset", async () => {
    const prisma = fakePrisma({ id: "u1" });
    const r = await ensureDriverUser({ ...base, prisma, hash, password: "" });
    expect(r.user).toBeNull();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it("re-hashes the password of an EXISTING driver", async () => {
    const prisma = fakePrisma({ id: "u1" });
    const r = await ensureDriverUser({ ...base, prisma, hash, password: "fresh" });
    expect(r.created).toBe(false);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { password: "h(fresh)" },
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("creates a missing driver with the hashed password", async () => {
    const prisma = fakePrisma(null);
    const r = await ensureDriverUser({ ...base, prisma, hash, password: "fresh" });
    expect(r.created).toBe(true);
    expect(prisma.user.create.mock.calls[0][0].data).toMatchObject({
      password: "h(fresh)",
      role: "DRIVER",
      tenantId: "t1",
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
