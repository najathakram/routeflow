import { Logger } from "@nestjs/common";
import { captureRetriedStates, retriedStateFromLog } from "./tx-retry-capture";

describe("tx-retry-capture", () => {
  it("parses the retry warning's SQLSTATE only for the asked label", () => {
    const line = "inventory.assignToVariants: transaction conflict 40P01, retry 2/3";
    expect(retriedStateFromLog(line, "inventory.assignToVariants")).toBe("40P01");
    expect(retriedStateFromLog(line, "other.label")).toBeNull();
    expect(retriedStateFromLog("a.b: transaction conflict P2034, retry 3/3", "a.b")).toBe("P2034");
    expect(retriedStateFromLog("unrelated warning", "a.b")).toBeNull();
    expect(retriedStateFromLog(undefined, "a.b")).toBeNull();
  });

  it("records the states of retried attempts in order and restores the logger", () => {
    const original = Logger.prototype.warn;
    const cap = captureRetriedStates("x.y");
    const logger = new Logger("tx-retry");
    logger.warn("x.y: transaction conflict 40001, retry 2/3");
    logger.warn("noise");
    logger.warn("x.z: transaction conflict 40P01, retry 2/3");
    logger.warn("x.y: transaction conflict 40P01, retry 3/3");
    expect(cap.states).toEqual(["40001", "40P01"]);
    cap.restore();
    expect(Logger.prototype.warn).toBe(original);
  });
});
