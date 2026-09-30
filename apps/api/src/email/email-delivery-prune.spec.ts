import { readFileSync } from "fs";
import { join } from "path";
import { EmailDeliveryPruneService } from "./email-delivery-prune.service";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-30T03:00:00Z");

/**
 * The prune loops tenants with no ambient tenant. ASSUMPTION: tenants are listed with
 * `prisma.tenant.findMany` and each delete goes through `prisma.emailDelivery.deleteMany` (or
 * `forTenant(id)` for that tenant) carrying `where.tenantId`. The mock points both surfaces at
 * the same jest.fn so either is accepted.
 */
function make(tenantIds: string[] = ["t1"], deleteImpl?: jest.Mock) {
  const deleteMany = deleteImpl ?? jest.fn().mockResolvedValue({ count: 0 });
  const emailDelivery = { deleteMany, findMany: jest.fn().mockResolvedValue([]) };
  const prisma = {
    tenant: { findMany: jest.fn().mockResolvedValue(tenantIds.map((id) => ({ id }))) },
    emailDelivery,
    forTenant: jest.fn().mockReturnValue({ emailDelivery }),
    $executeRaw: jest.fn().mockResolvedValue(0),
  } as any;
  return { svc: new EmailDeliveryPruneService(prisma), deleteMany, prisma };
}

/** Flatten a where clause (incl. OR/AND branches) to the candidate leaf objects. */
function leaves(where: any): any[] {
  if (!where) return [];
  const out: any[] = [where];
  for (const k of ["OR", "AND"]) {
    if (Array.isArray(where[k])) for (const w of where[k]) out.push(...leaves(w));
  }
  return out;
}

describe("EmailDeliveryPruneService.prune", () => {
  it("non-Invoice cutoff is 90 days, Invoice cutoff is 2 years", async () => {
    const { svc, deleteMany } = make();
    await svc.prune(NOW);
    const all = deleteMany.mock.calls.flatMap((c) => leaves(c[0].where));
    const cutoffs = all
      .map((w) => w.createdAt?.lt as Date | undefined)
      .filter((d): d is Date => d instanceof Date)
      .map((d) => Math.round((NOW.getTime() - d.getTime()) / DAY));
    // 89d row survives, 91d row is deleted for non-invoice: cutoff must be exactly 90d.
    expect(cutoffs).toContain(90);
    // 729d survives, 731d deleted for invoices: cutoff ~730d (2 years, leap-tolerant).
    expect(cutoffs.some((d) => d >= 729 && d <= 731)).toBe(true);
  });

  it("89-day-old non-Invoice row is outside the delete window, 91-day-old inside", async () => {
    const { svc, deleteMany } = make();
    await svc.prune(NOW);
    const nonInvoice = deleteMany.mock.calls
      .flatMap((c) => leaves(c[0].where))
      .filter((w) => w.entityType && typeof w.entityType === "object" && "not" in w.entityType);
    expect(nonInvoice.length).toBeGreaterThan(0);
    for (const w of nonInvoice) {
      expect(w.entityType.not).toBe("Invoice");
      const cutoff: Date = w.createdAt.lt;
      const age = (d: number) => new Date(NOW.getTime() - d * DAY);
      expect(age(89) < cutoff).toBe(false);
      expect(age(91) < cutoff).toBe(true);
    }
  });

  it("729-day-old Invoice row survives, 731-day-old is deleted", async () => {
    const { svc, deleteMany } = make();
    await svc.prune(NOW);
    const invoice = deleteMany.mock.calls
      .flatMap((c) => leaves(c[0].where))
      .filter((w) => w.entityType === "Invoice");
    expect(invoice.length).toBeGreaterThan(0);
    for (const w of invoice) {
      const cutoff: Date = w.createdAt.lt;
      const age = (d: number) => new Date(NOW.getTime() - d * DAY);
      expect(age(729) < cutoff).toBe(false);
      expect(age(731) < cutoff).toBe(true);
    }
  });

  it("deletes in batches of at most 5000 per call and loops until a short batch", async () => {
    const deleteMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 5000 })
      .mockResolvedValueOnce({ count: 123 })
      .mockResolvedValue({ count: 0 });
    const { svc } = make(["t1"], deleteMany);
    const out = await svc.prune(NOW);
    expect(out.deleted).toBeGreaterThanOrEqual(5123);
    // Prisma deleteMany has no LIMIT: batches are expressed as an id IN (<=5000) subquery or a
    // raw DELETE ... LIMIT. Accept either shape: no single call may target > 5000 ids.
    for (const c of deleteMany.mock.calls) {
      const ids = c[0]?.where?.id?.in;
      if (Array.isArray(ids)) expect(ids.length).toBeLessThanOrEqual(5000);
    }
  });

  it("never crosses tenants: every delete is scoped to exactly one tenantId", async () => {
    const { svc, deleteMany } = make(["t1", "t2"]);
    await svc.prune(NOW);
    const seen = new Set<string>();
    for (const c of deleteMany.mock.calls) {
      const tenantIds = leaves(c[0].where)
        .map((w) => w.tenantId)
        .filter((v) => typeof v === "string");
      expect(tenantIds.length).toBeGreaterThan(0);
      for (const id of tenantIds) seen.add(id);
    }
    expect([...seen].sort()).toEqual(["t1", "t2"]);
  });

  it("one tenant failing does not stop the others", async () => {
    const deleteMany = jest
      .fn()
      .mockRejectedValueOnce(new Error("lock timeout"))
      .mockResolvedValue({ count: 0 });
    const { svc } = make(["t1", "t2"], deleteMany);
    await expect(svc.prune(NOW)).resolves.toEqual(expect.objectContaining({ deleted: 0 }));
    expect(deleteMany.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("EmailDeliveryPruneService cron wiring", () => {
  const src = readFileSync(join(__dirname, "email-delivery-prune.service.ts"), "utf8");

  it('is decorated @LeaderCron("0 3 * * *", "email.pruneDeliveries")', () => {
    expect(src).toMatch(/@LeaderCron\(\s*"0 3 \* \* \*"\s*,\s*"email\.pruneDeliveries"\s*\)/);
  });

  it("never uses a bare @Cron(", () => {
    expect(src).not.toMatch(/@Cron\(/);
  });
});
