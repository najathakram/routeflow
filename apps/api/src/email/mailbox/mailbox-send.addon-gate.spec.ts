import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { Logger } from "@nestjs/common";
import { MailboxSendService } from "./mailbox-send.service";
import { EncryptionService } from "../../common/encryption.service";
import { AddonAccessService } from "../../billing/addon-access";
import { addonGateState, ADDON_GATE_REGISTRY } from "../../billing/addon-gate-registry";

jest.mock("axios");

jest.mock("../../common/db-locks", () => ({
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

// Only `addonGateState` is steered; it defaults to the real registry answer (dark).
jest.mock("../../billing/addon-gate-registry", () => {
  const actual = jest.requireActual("../../billing/addon-gate-registry");
  return { ...actual, addonGateState: jest.fn(actual.addonGateState) };
});

const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const KEY = "email.connected_mailbox";

describe("MailboxSendService — email.connected_mailbox add-on gate on the SEND path", () => {
  const encryption = new EncryptionService({
    get: (k: string) => (k === "ENCRYPTION_KEY" ? "c".repeat(64) : undefined),
  } as unknown as ConfigService);

  function build(opts: { held?: boolean; alwaysEnforced?: boolean } = {}) {
    const row = {
      id: "mc-1",
      tenantId: "tenant-a",
      provider: "GOOGLE",
      accountEmail: "owner@acme.test",
      externalSubject: "google-sub-1",
      status: "CONNECTED",
      throttledUntil: null,
      refreshTokenCipher: encryption.encrypt("real-refresh-token"),
      accessTokenCipher: encryption.encrypt("cached-access-token"),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    };
    const prisma: any = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}), findFirst: jest.fn() },
    };
    prisma.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
    const config = { get: () => "x" } as unknown as ConfigService;
    const access = new AddonAccessService(
      { getActiveAddons: jest.fn().mockResolvedValue(opts.held ? [KEY] : []) } as any,
      { isAlwaysEnforcedTenant: jest.fn().mockResolvedValue(opts.alwaysEnforced ?? false) } as any,
      { getMany: jest.fn().mockResolvedValue(new Map()) } as any,
    );
    const service = new MailboxSendService(prisma, encryption, config, access);
    return { service, prisma };
  }

  const params = { to: "c@example.com", subject: "Hi", html: "<p>hi</p>" };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    (addonGateState as jest.Mock).mockImplementation(
      jest.requireActual("../../billing/addon-gate-registry").addonGateState,
    );
    (axios.post as jest.Mock).mockImplementation((url: string) => {
      if (url === GMAIL_SEND_URL) return Promise.resolve({ data: { id: "gmail-msg-1" } });
      throw new Error(`unexpected POST to ${url}`);
    });
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => warn.mockRestore());

  it("registry: email.connected_mailbox still ships dark (flipping it is a later owner-approved diff)", () => {
    expect(ADDON_GATE_REGISTRY[KEY]?.state).toBe("dark");
  });

  it("DARK + add-on NOT held: still sends, and logs a would-deny warning naming the tenant", async () => {
    const { service } = build({ held: false });

    const res = await service.trySend("tenant-a", params);

    expect(res).toMatchObject({ delivered: true, transport: "mailbox", id: "gmail-msg-1" });
    expect(axios.post).toHaveBeenCalledWith(GMAIL_SEND_URL, expect.anything(), expect.anything());
    const msgs = warn.mock.calls.map((c) => String(c[0]));
    expect(msgs.some((m) => m.includes("would deny") && m.includes("tenant-a"))).toBe(true);
  });

  it("ENFORCED + add-on NOT held: returns addon_required and never calls the provider", async () => {
    (addonGateState as jest.Mock).mockReturnValue("enforced");
    const { service } = build({ held: false });

    const res = await service.trySend("tenant-a", params);

    expect(res).toEqual({ delivered: false, transport: "mailbox", error: "addon_required" });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("add-on HELD: unchanged — sends and logs no would-deny warning", async () => {
    const { service } = build({ held: true });

    const res = await service.trySend("tenant-a", params);

    expect(res).toMatchObject({ delivered: true, transport: "mailbox" });
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes("would deny"))).toBe(
      false,
    );
  });
});
