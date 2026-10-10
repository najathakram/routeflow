import { RECEIPT_CHANNELS, RECEIPT_CHANNEL_VALUES } from "./receipt-channels";
import {
  RECEIPT_EMAIL_PER_ORDER_KEY,
  RECEIPT_EMAIL_PER_TENANT_PER_DAY_KEY,
  resolveReceiptLimit,
} from "./receipt-limits";
import { EMAIL_KINDS } from "../email/email-kinds";

// L-072: the API keeps local literal copies of shared closed sets (it never value-imports `@routeflow/types`); this pins them.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shared = require("@routeflow/types") as {
  RECEIPT_CHANNEL_VALUES: readonly string[];
  EMAIL_KIND_VALUES: readonly string[];
  isRegisteredSettingKey: (key: string) => boolean;
};

describe("receipt channels (SA-751r)", () => {
  it("the local channel list is set-equal to the shared RECEIPT_CHANNEL_VALUES", () => {
    expect([...RECEIPT_CHANNEL_VALUES].sort()).toEqual([...shared.RECEIPT_CHANNEL_VALUES].sort());
  });

  it("the registry has exactly one sender per channel value, keyed by it (a new channel is one row)", () => {
    expect(Object.keys(RECEIPT_CHANNELS).sort()).toEqual([...RECEIPT_CHANNEL_VALUES].sort());
    for (const sender of Object.values(RECEIPT_CHANNELS)) expect(typeof sender).toBe("function");
  });

  it("RECEIPT is an allow-listed delivery kind, in the API list and the shared one", () => {
    expect(EMAIL_KINDS).toContain("RECEIPT");
    expect(shared.EMAIL_KIND_VALUES).toContain("RECEIPT");
  });

  it("the email sender sends through EmailService.send with the delivery context it was given, and throws on a failed send", async () => {
    const ok = { send: jest.fn().mockResolvedValue({ delivered: true, transport: "smtp" }) };
    const args = {
      to: "a@example.com",
      subject: "s",
      html: "<p>h</p>",
      text: "t",
      delivery: { tenantId: "t", kind: "RECEIPT" as const, entityType: "Order", entityId: "o" },
    };
    await expect(RECEIPT_CHANNELS.email({ email: ok as never }, args)).resolves.toBeUndefined();
    expect(ok.send).toHaveBeenCalledWith(args);
    const bad = { send: jest.fn().mockResolvedValue({ delivered: false, transport: "none" }) };
    await expect(RECEIPT_CHANNELS.email({ email: bad as never }, args)).rejects.toThrow();
  });
});

describe("receipt email limits as settings (SA-751r change 4)", () => {
  it("the two keys are registered in the settings registry (no setting without a row)", () => {
    expect(shared.isRegisteredSettingKey(RECEIPT_EMAIL_PER_ORDER_KEY)).toBe(true);
    expect(shared.isRegisteredSettingKey(RECEIPT_EMAIL_PER_TENANT_PER_DAY_KEY)).toBe(true);
    expect(RECEIPT_EMAIL_PER_ORDER_KEY).toBe("receipts.email.perOrder");
    expect(RECEIPT_EMAIL_PER_TENANT_PER_DAY_KEY).toBe("receipts.email.perTenantPerDay");
  });

  it("resolveReceiptLimit takes a positive whole number and nothing else", () => {
    expect(resolveReceiptLimit("7", 3)).toBe(7);
    expect(resolveReceiptLimit(" 7 ", 3)).toBe(7);
    for (const bad of [null, undefined, "", "0", "-1", "1.5", "abc", "1e3", "99999999999"])
      expect(resolveReceiptLimit(bad, 3)).toBe(3);
  });
});
