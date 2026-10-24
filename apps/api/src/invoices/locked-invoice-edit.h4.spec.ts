import { ConflictException } from "@nestjs/common";
import { assertInvoiceCurrent, updateHeaderOnly } from "./locked-invoice-edit";

/**
 * H4: the header-only invoice save that touches no totals. Without a token it stays the one unlocked update
 * and reports the missing token (the warn that says when the token can be required); with one it locks the
 * row and refuses a stale token before writing.
 */
describe("H4 updateHeaderOnly", () => {
  const AT = new Date("2026-10-13T10:00:00.000Z");
  const mk = () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      invoice: {
        findUnique: jest.fn().mockResolvedValue({ id: "inv-1", updatedAt: AT, status: "DRAFT" }),
        update: jest.fn().mockResolvedValue({ id: "inv-1" }),
      },
    };
    const plain = { invoice: { update: jest.fn().mockResolvedValue({ id: "inv-1" }) } };
    const prisma = {
      forTenant: () => plain,
      tenantTransaction: jest.fn((fn: (t: any) => Promise<any>) => fn(tx)),
    };
    return { tx, plain, prisma };
  };

  it("no token: the plain update runs and the missing token is reported", async () => {
    const { tx, plain, prisma } = mk();
    const onMissing = jest.fn();
    await updateHeaderOnly(prisma, "inv-1", {}, { notes: "n" }, {}, onMissing);
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(plain.invoice.update).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: { notes: "n" },
      include: {},
    });
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  it("a current token: locks, checks and writes, and reports nothing", async () => {
    const { tx, prisma } = mk();
    const onMissing = jest.fn();
    await updateHeaderOnly(
      prisma,
      "inv-1",
      { expectedUpdatedAt: AT.toISOString() },
      {},
      {},
      onMissing,
    );
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.invoice.update).toHaveBeenCalledTimes(1);
    expect(onMissing).not.toHaveBeenCalled();
  });

  it("a stale token: 409 INVOICE_STALE and nothing written", async () => {
    const { tx, prisma } = mk();
    await expect(
      updateHeaderOnly(
        prisma,
        "inv-1",
        { expectedUpdatedAt: "2026-10-13T09:00:00.000Z" },
        {},
        {},
        jest.fn(),
      ),
    ).rejects.toMatchObject({ response: { code: "INVOICE_STALE" } });
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });
});

describe("H4 assertInvoiceCurrent", () => {
  it("equal instants pass whatever the string form; a different instant is a ConflictException", () => {
    const at = new Date("2026-10-13T10:00:00.000Z");
    expect(() =>
      assertInvoiceCurrent({ updatedAt: at }, "2026-10-13T05:00:00.000-05:00"),
    ).not.toThrow();
    expect(() => assertInvoiceCurrent({ updatedAt: at }, "2026-10-13T10:00:00.001Z")).toThrow(
      ConflictException,
    );
  });
});
