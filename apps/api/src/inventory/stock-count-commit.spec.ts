import { ConflictException } from "@nestjs/common";
import {
  COUNT_COMMIT_BATCH,
  stockCountCommitting,
  stockCountReference,
} from "./stock-count-commit";

/** SA-767 L-2.2: the shared vocabulary of the batched stock-count commit. */
describe("stock-count-commit vocabulary", () => {
  it("the batch size is the ruled 50", () => {
    expect(COUNT_COMMIT_BATCH).toBe(50);
  });

  it("every movement of a count carries STOCK_COUNT-<sessionId>", () => {
    expect(stockCountReference("sess-1")).toBe("STOCK_COUNT-sess-1");
  });

  it("stockCountCommitting is a coded 409 STOCK_COUNT_COMMITTING", () => {
    const e = stockCountCommitting();
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toMatchObject({
      code: "STOCK_COUNT_COMMITTING",
      message: "This count is being saved. Try again in a moment.",
    });
  });
});
