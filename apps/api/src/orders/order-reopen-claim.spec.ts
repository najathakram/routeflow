import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { claimReopenInTx } from "./order-reopen-claim";

/** B695: the reopen claim locks the Order row, then compare-and-sets CANCELLED -> PENDING. */
describe("claimReopenInTx", () => {
  const mkTx = (count: number) => {
    const calls: string[] = [];
    const tx = {
      $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
        calls.push(`raw:${strings.join("?").replace(/\s+/g, " ").trim()}`);
        return 1;
      }),
      order: {
        updateMany: jest.fn(async () => {
          calls.push("updateMany");
          return { count };
        }),
      },
    };
    return { tx, calls };
  };

  it("locks the Order row FOR UPDATE before the status claim", async () => {
    const { tx, calls } = mkTx(1);
    await claimReopenInTx(tx, "o-1");
    expect(calls).toEqual(['raw:SELECT id FROM "Order" WHERE id = ? FOR UPDATE', "updateMany"]);
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "o-1", status: "CANCELLED" },
      data: { status: "PENDING" },
    });
  });

  it("a lost claim (count 0) is the coded 409 ORDER_CHANGED_DURING_EDIT", async () => {
    const { tx } = mkTx(0);
    const err = await claimReopenInTx(tx, "o-1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT });
  });
});
