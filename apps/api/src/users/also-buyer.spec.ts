import { hasActiveBuyerLink } from "./also-buyer";

/**
 * W-839 / SA-937 MUST 3: is this staff user also an ACTIVE buyer of THIS tenant? One boolean helper, one tenant-scoped
 * read. Every condition is pinned on the where-clause here (each one's absence is a red), and the real rows are judged by
 * also-buyer.db.spec.ts (two tenants: the cross-tenant-oracle guard, SA-937 §3).
 */
function prisma(found: unknown = { id: "link-1" }) {
  const findFirst = jest.fn().mockResolvedValue(found);
  const db: Parameters<typeof hasActiveBuyerLink>[0] = {
    forTenant: () => ({ customerLink: { findFirst } }),
  };
  return { db, findFirst };
}

describe("hasActiveBuyerLink", () => {
  it("asks for an ACTIVE link of THIS tenant, a live customer and an active, verified, unmerged buyer with this email", async () => {
    const { db, findFirst } = prisma();
    await expect(
      hasActiveBuyerLink(db, { email: "Sam@Acme.example", tenantId: "t1" }),
    ).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: "t1",
        status: "ACTIVE",
        customer: { deletedAt: null },
        buyerAccount: {
          email: { equals: "Sam@Acme.example", mode: "insensitive" },
          status: "ACTIVE",
          emailVerified: true,
          deletedAt: null,
          mergedIntoId: null,
        },
      },
      select: { id: true },
    });
  });

  it("no matching link is false", async () => {
    const { db } = prisma(null);
    await expect(
      hasActiveBuyerLink(db, { email: "sam@acme.example", tenantId: "t1" }),
    ).resolves.toBe(false);
  });

  it.each<[string, Parameters<typeof hasActiveBuyerLink>[1]]>([
    ["a null tenant (a super admin)", { email: "sam@acme.example", tenantId: null }],
    ["no email on file", { email: "", tenantId: "t1" }],
  ])("%s is false, with no query", async (_l, args) => {
    const { db, findFirst } = prisma();
    await expect(hasActiveBuyerLink(db, args)).resolves.toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
