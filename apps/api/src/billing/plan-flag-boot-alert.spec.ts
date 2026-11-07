/**
 * FG-1 WP3 (T9): `PLAN_FLAG_ENFORCEMENT` on at boot sends the owner ONE alert; off sends none; a second boot call in
 * the same process sends nothing more; a failed send never throws into the boot.
 */
import { OwnerAlertService } from "../email/owner-alert.service";
import { PlanFlagBootAlert } from "./plan-flag-boot-alert";

const SWITCH = "PLAN_FLAG_ENFORCEMENT";
const saved = { switch: process.env[SWITCH], to: process.env.DEMO_BOOKING_ADMIN_EMAIL };
beforeEach(() => {
  process.env.DEMO_BOOKING_ADMIN_EMAIL = "owner@example.test";
});
afterEach(() => {
  for (const [k, v] of [
    [SWITCH, saved.switch],
    ["DEMO_BOOKING_ADMIN_EMAIL", saved.to],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function build(send = jest.fn(async (_m: unknown) => ({ delivered: true, transport: "resend" }))) {
  const alert = new OwnerAlertService({} as never, { send } as never);
  return { send, boot: new PlanFlagBootAlert(alert) };
}
const flush = () => new Promise((r) => setImmediate(r));

describe("PlanFlagBootAlert", () => {
  it("T9: switch on -> one mail to the owner, with the plain words", async () => {
    process.env[SWITCH] = "on";
    const { boot, send } = build();
    boot.onApplicationBootstrap();
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0][0] as Record<string, string>;
    expect(mail.to).toBe("owner@example.test");
    expect(mail.subject).toBe("Plan feature enforcement is on");
    expect(mail.text).toContain(
      "If you didn't turn this on, check the PLAN_FLAG_ENFORCEMENT setting.",
    );
  });

  it("T9: deduped per boot: a second call in the same process sends nothing", async () => {
    process.env[SWITCH] = "on";
    const { boot, send } = build();
    boot.onApplicationBootstrap();
    boot.onApplicationBootstrap();
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("switch off -> no mail", async () => {
    delete process.env[SWITCH];
    const { boot, send } = build();
    boot.onApplicationBootstrap();
    await flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("a send that throws never breaks the boot", async () => {
    process.env[SWITCH] = "on";
    const { boot } = build(jest.fn(async () => Promise.reject(new Error("smtp down"))) as never);
    expect(() => boot.onApplicationBootstrap()).not.toThrow();
    await flush();
  });
});
