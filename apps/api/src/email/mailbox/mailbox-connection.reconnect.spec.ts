import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import axios from "axios";
import { MailboxConnectionService } from "./mailbox-connection.service";
import { EncryptionService } from "../../common/encryption.service";

jest.mock("axios");

// Pass-through lock: see mailbox-connection.service.spec.ts's identical header. The lock itself
// is proven in db-locks.spec.ts; what this file proves is what the confirm WRITES.
jest.mock("../../common/db-locks", () => ({
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

const mockOAuthClient = {
  generateCodeVerifierAsync: jest.fn(),
  generateAuthUrl: jest.fn(),
  getToken: jest.fn(),
  verifyIdToken: jest.fn(),
};
jest.mock("google-auth-library", () => ({
  OAuth2Client: jest.fn().mockImplementation(() => mockOAuthClient),
  CodeChallengeMethod: { S256: "S256" },
}));

const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MS_GRAPH_ME_URL = "https://graph.microsoft.com/v1.0/me";
const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const TENANT = "tenant-acme";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
];
const MS_SCOPES = [
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/User.Read",
  "offline_access",
];

/** Every column the generated client says MailboxConnection has — the source of truth. */
const COLUMNS = Object.values(Prisma.MailboxConnectionScalarFieldEnum) as string[];

type Row = Record<string, any>;

/**
 * An in-memory `mailboxConnection` table with Prisma's own write semantics, which is exactly
 * what this spec is about: `upsert`/`update` change ONLY the keys they are given (an `undefined`
 * value is skipped, as Prisma does), `create` applies the schema defaults, `@updatedAt` bumps
 * on every write, and an unknown column name throws (as Prisma's validation does) instead of
 * silently landing. A column the confirm forgets to write therefore keeps its old value here,
 * just as it would in Postgres. Reads and writes clone, so a test can never alias the store.
 */
function makeMailboxTable() {
  const rows = new Map<string, Row>();
  let seq = 0;
  let clock = Date.parse("2026-09-01T00:00:00.000Z");
  const tick = () => new Date((clock += 1_000));
  const clone = (v: any): any =>
    v instanceof Date ? new Date(v.getTime()) : Array.isArray(v) ? v.map(clone) : v;
  const cloneRow = (r: Row): Row =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clone(v)]));
  const tenantKey = (where: Row, op: string): string => {
    if (!where || Object.keys(where).join() !== "tenantId") {
      throw new Error(`${op}: this table is addressed by its unique tenantId only`);
    }
    return where.tenantId;
  };
  const apply = (target: Row, data: Row, op: string) => {
    for (const [k, v] of Object.entries(data)) {
      if (!COLUMNS.includes(k)) throw new Error(`${op}: unknown MailboxConnection column "${k}"`);
      if (v === undefined) continue;
      target[k] = clone(v);
    }
  };
  const create = (data: Row): Row => {
    for (const required of ["tenantId", "accountEmail", "externalSubject", "refreshTokenCipher"]) {
      if (data[required] === undefined) throw new Error(`create: missing required ${required}`);
    }
    const at = tick();
    const row: Row = {
      id: `mc-${++seq}`,
      provider: "GOOGLE",
      scopesGranted: [],
      accessTokenCipher: null,
      accessTokenExpiresAt: null,
      status: "CONNECTED",
      throttledUntil: null,
      lastError: null,
      lastErrorAt: null,
      alertPendingAt: null,
      lastSentAt: null,
      connectedByUserId: null,
      createdAt: at,
      updatedAt: at,
    };
    apply(row, data, "create");
    return row;
  };

  return {
    findUnique: jest.fn(async ({ where }: { where: Row }) => {
      const row = rows.get(tenantKey(where, "findUnique"));
      return row ? cloneRow(row) : null;
    }),
    upsert: jest.fn(
      async ({ where, create: c, update }: { where: Row; create: Row; update: Row }) => {
        const key = tenantKey(where, "upsert");
        const existing = rows.get(key);
        if (existing) {
          apply(existing, update, "upsert.update");
          existing.updatedAt = tick();
          return cloneRow(existing);
        }
        const row = create(c);
        rows.set(key, row);
        return cloneRow(row);
      },
    ),
    update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const existing = rows.get(tenantKey(where, "update"));
      if (!existing) throw new Error("update: record to update not found");
      apply(existing, data, "update");
      existing.updatedAt = tick();
      return cloneRow(existing);
    }),
    delete: jest.fn(async ({ where }: { where: Row }) => {
      const key = tenantKey(where, "delete");
      const existing = rows.get(key);
      if (!existing) throw new Error("delete: record to delete not found");
      rows.delete(key);
      return cloneRow(existing);
    }),
    /** Test-only raw read (bypasses the service). */
    peek: (tenantId: string): Row | null => {
      const row = rows.get(tenantId);
      return row ? cloneRow(row) : null;
    },
  };
}

function makeMockRedis() {
  const store = new Map<string, string>();
  return {
    set: jest.fn(async (key: string, val: string) => {
      store.set(key, val);
      return "OK";
    }),
    getdel: jest.fn(async (key: string) => {
      const v = store.has(key) ? store.get(key)! : null;
      store.delete(key);
      return v;
    }),
    eval: jest.fn(async () => null),
    on: jest.fn(),
    disconnect: jest.fn(),
  };
}

function buildService() {
  const config = {
    get: (k: string) =>
      ({
        GOOGLE_MAILBOX_CLIENT_ID: "g-client-id",
        GOOGLE_MAILBOX_CLIENT_SECRET: "g-client-secret",
        GOOGLE_MAILBOX_REDIRECT_URI: "https://api.acme.test/google/callback",
        MICROSOFT_MAILBOX_CLIENT_ID: "ms-client-id",
        MICROSOFT_MAILBOX_CLIENT_SECRET: "ms-client-secret",
        MICROSOFT_MAILBOX_REDIRECT_URI: "https://api.acme.test/microsoft/callback",
      })[k],
  } as unknown as ConfigService;
  const encryption = new EncryptionService({
    get: (k: string) => (k === "ENCRYPTION_KEY" ? "d".repeat(64) : undefined),
  } as unknown as ConfigService);
  const table = makeMailboxTable();
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new MailboxConnectionService(
    { mailboxConnection: table } as any,
    encryption,
    audit as any,
    config,
  );
  (service as any).redis = makeMockRedis();
  return { service, table, audit, encryption };
}

interface GoogleGrant {
  userId: string;
  sub: string;
  email: string;
  refreshToken: string;
  accessToken?: string;
  expiryDate?: number;
}

/** The REAL connect path: startConnect → handleCallback → confirmConnect (Google mocked at the
 *  library boundary only). */
async function connectGoogle(service: MailboxConnectionService, g: GoogleGrant) {
  mockOAuthClient.generateCodeVerifierAsync.mockResolvedValue({
    codeVerifier: "g-verifier",
    codeChallenge: "g-challenge",
  });
  mockOAuthClient.generateAuthUrl.mockImplementation(
    (opts: any) => `https://accounts.google.test/auth?state=${opts.state}`,
  );
  mockOAuthClient.getToken.mockResolvedValue({
    tokens: {
      refresh_token: g.refreshToken,
      access_token: g.accessToken,
      id_token: "g-id-token",
      expiry_date: g.expiryDate,
      scope: GOOGLE_SCOPES.join(" "),
    },
  });
  mockOAuthClient.verifyIdToken.mockResolvedValue({
    getPayload: () => ({ sub: g.sub, email: g.email, email_verified: true }),
  });
  const { url, connectSecret } = await service.startConnect(TENANT, g.userId);
  const state = new URL(url).searchParams.get("state")!;
  const { confirmToken } = await service.handleCallback("g-code", state);
  return service.confirmConnect(confirmToken, connectSecret, g.userId, TENANT);
}

interface MicrosoftGrant {
  userId: string;
  objectId: string;
  mail: string;
  refreshToken: string;
  accessToken: string;
  expiresIn: number;
}

/** The REAL connect path: startConnectMicrosoft → handleMicrosoftCallback → confirmConnect
 *  (Microsoft's token endpoint and Graph /me mocked at the axios boundary only). */
async function connectMicrosoft(service: MailboxConnectionService, m: MicrosoftGrant) {
  (axios.post as jest.Mock).mockImplementation(async (url: string) => {
    if (url !== MS_TOKEN_URL) throw new Error(`unexpected POST ${url}`);
    return {
      data: {
        access_token: m.accessToken,
        refresh_token: m.refreshToken,
        expires_in: m.expiresIn,
        scope: MS_SCOPES.join(" "),
      },
    };
  });
  (axios.get as jest.Mock).mockImplementation(async (url: string) => {
    if (url !== MS_GRAPH_ME_URL) throw new Error(`unexpected GET ${url}`);
    return { data: { id: m.objectId, mail: m.mail, userPrincipalName: m.mail } };
  });
  const { url, connectSecret } = await service.startConnectMicrosoft(TENANT, m.userId);
  const state = new URL(url).searchParams.get("state")!;
  const { confirmToken } = await service.handleMicrosoftCallback("ms-code", state);
  return service.confirmConnect(confirmToken, connectSecret, m.userId, TENANT);
}

/**
 * Every MailboxConnection column, spelled out, in a form a test can compare exactly: token
 * ciphertexts decrypted (their IVs are random), `updatedAt` reduced to whether this write bumped
 * it. The guard test below pins this key set to the generated client's column list, so a column
 * added to the schema fails this spec until it is classified here, and the replacement tests
 * then show whether confirmConnect handles it.
 */
function readable(row: Row, prev: Row, encryption: EncryptionService): Record<string, unknown> {
  const plain = (cipher: string | null) => (cipher ? encryption.decrypt(cipher) : null);
  return {
    // Row identity: one row per tenant, updated in place (tenantId is the unique key).
    id: row.id,
    tenantId: row.tenantId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt > prev.updatedAt ? "bumped" : "NOT bumped",
    // The grant: rewritten from the new provider's grant on every confirm.
    provider: row.provider,
    accountEmail: row.accountEmail,
    externalSubject: row.externalSubject,
    scopesGranted: row.scopesGranted,
    refreshTokenCipher: plain(row.refreshTokenCipher),
    accessTokenCipher: plain(row.accessTokenCipher),
    accessTokenExpiresAt: row.accessTokenExpiresAt,
    connectedByUserId: row.connectedByUserId,
    // Connection health: a new grant starts healthy.
    status: row.status,
    throttledUntil: row.throttledUntil,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt,
    alertPendingAt: row.alertPendingAt, // #2113: an owed alert about the old grant is dropped
    // The mailbox's own history: kept for the same mailbox, reset for a different one.
    lastSentAt: row.lastSentAt,
  };
}

const T = (iso: string) => new Date(iso);

/**
 * F-10b (#2078), test-plan §4 unit gap: one MailboxConnection row per tenant, either provider.
 * Reconnecting with the OTHER provider must leave a row that describes ONLY the new mailbox —
 * no scopes, tokens, expiry, health state or send history carried over from the old one. Each
 * test drives the real connect path and "ages" the first row with the exact write shapes
 * MailboxSendService uses over a connection's life (a send, a rate limit, a token refresh, a
 * revocation), then asserts every column after the reconnect.
 */
describe("MailboxConnectionService — reconnecting replaces the tenant's single row", () => {
  let nowSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    nowSpy = jest.spyOn(Date, "now").mockReturnValue(NOW);
  });
  afterEach(() => nowSpy.mockRestore());

  const googleOwner: GoogleGrant = {
    userId: "user-1",
    sub: "google-sub-1",
    email: "gmail-owner@acme.test",
    refreshToken: "g-rt-1",
    accessToken: "g-at-1",
    expiryDate: NOW + 3_600_000,
  };
  const outlookOwner: MicrosoftGrant = {
    userId: "user-2",
    objectId: "ms-oid-1",
    mail: "outlook-owner@acme.test",
    refreshToken: "ms-rt-1",
    accessToken: "ms-at-1",
    expiresIn: 3_600,
  };

  it("classifies every MailboxConnection column (a new column fails here until it is handled)", async () => {
    const { service, table, encryption } = buildService();
    await connectGoogle(service, googleOwner);
    const row = table.peek(TENANT)!;

    expect(COLUMNS.length).toBeGreaterThan(0);
    expect(Object.keys(readable(row, row, encryption)).sort()).toEqual([...COLUMNS].sort());
  });

  it("Google → Microsoft → Google: each hop leaves only the new mailbox's values, nothing stale", async () => {
    const { service, table, audit, encryption } = buildService();

    // Hop 0: a Google mailbox, used for a while.
    await connectGoogle(service, googleOwner);
    await table.update({
      where: { tenantId: TENANT },
      data: {
        status: "CONNECTED",
        throttledUntil: null,
        lastSentAt: T("2026-09-20T09:00:00.000Z"),
        lastError: null,
      },
    });
    await table.update({
      where: { tenantId: TENANT },
      data: {
        accessTokenCipher: encryption.encrypt("g-at-refreshed"),
        accessTokenExpiresAt: T("2026-12-31T00:00:00.000Z"),
      },
    });
    await table.update({
      where: { tenantId: TENANT },
      data: {
        status: "THROTTLED",
        throttledUntil: T("2026-12-31T01:00:00.000Z"),
        lastError: "Rate-limited by Google — falling back to the next sender.",
        lastErrorAt: T("2026-09-23T10:00:00.000Z"),
        alertPendingAt: T("2026-09-23T10:00:00.000Z"),
      },
    });
    const googleRow = table.peek(TENANT)!;

    // Hop 1: another admin connects Outlook over it.
    const view1 = await connectMicrosoft(service, outlookOwner);
    const outlookRow = table.peek(TENANT)!;

    expect(readable(outlookRow, googleRow, encryption)).toEqual({
      id: googleRow.id,
      tenantId: TENANT,
      createdAt: googleRow.createdAt,
      updatedAt: "bumped",
      provider: "MICROSOFT",
      accountEmail: "outlook-owner@acme.test",
      externalSubject: "ms-oid-1",
      scopesGranted: MS_SCOPES,
      refreshTokenCipher: "ms-rt-1",
      accessTokenCipher: "ms-at-1",
      accessTokenExpiresAt: new Date(NOW + 3_600_000),
      connectedByUserId: "user-2",
      status: "CONNECTED",
      throttledUntil: null,
      lastError: null,
      lastErrorAt: null,
      alertPendingAt: null,
      lastSentAt: null,
    });
    // What the web is told, exactly — no Google-era value in any field.
    expect(view1).toEqual({
      configured: true,
      googleConfigured: true,
      microsoftConfigured: true,
      connected: true,
      provider: "MICROSOFT",
      accountEmail: "outlook-owner@acme.test",
      status: "CONNECTED",
      throttledUntil: null,
      lastError: null,
      lastSentAt: null,
    });
    expect(await service.getStatus(TENANT)).toEqual(view1);
    expect(audit.log).toHaveBeenLastCalledWith({
      tenantId: TENANT,
      userId: "user-2",
      action: "mailbox.reconnected_different_account",
      entityType: "mailbox_connection",
      entityId: googleRow.id,
      meta: { provider: "MICROSOFT", accountEmail: "outlook-owner@acme.test" },
    });

    // The Outlook mailbox is used, its refresh token rotates, then Microsoft rejects a send.
    await table.update({
      where: { tenantId: TENANT },
      data: {
        status: "CONNECTED",
        throttledUntil: null,
        lastSentAt: T("2026-09-24T08:00:00.000Z"),
        lastError: null,
      },
    });
    await table.update({
      where: { tenantId: TENANT },
      data: {
        accessTokenCipher: encryption.encrypt("ms-at-rotated"),
        accessTokenExpiresAt: T("2026-12-30T00:00:00.000Z"),
        refreshTokenCipher: encryption.encrypt("ms-rt-rotated"),
      },
    });
    await table.update({
      where: { tenantId: TENANT },
      data: {
        status: "REVOKED",
        lastError: "Microsoft rejected the send — reconnect required.",
        lastErrorAt: T("2026-09-24T09:00:00.000Z"),
      },
    });
    const agedOutlookRow = table.peek(TENANT)!;

    // Hop 2: back to Google — the original account, reconnected by its original admin.
    const googleAgain: GoogleGrant = {
      ...googleOwner,
      refreshToken: "g-rt-2",
      accessToken: "g-at-2",
      expiryDate: NOW + 1_800_000,
    };
    const view2 = await connectGoogle(service, googleAgain);
    const backRow = table.peek(TENANT)!;

    expect(readable(backRow, agedOutlookRow, encryption)).toEqual({
      id: googleRow.id,
      tenantId: TENANT,
      createdAt: googleRow.createdAt,
      updatedAt: "bumped",
      provider: "GOOGLE",
      accountEmail: "gmail-owner@acme.test",
      externalSubject: "google-sub-1",
      scopesGranted: GOOGLE_SCOPES,
      refreshTokenCipher: "g-rt-2",
      accessTokenCipher: "g-at-2",
      accessTokenExpiresAt: new Date(NOW + 1_800_000),
      connectedByUserId: "user-1",
      status: "CONNECTED",
      throttledUntil: null,
      lastError: null,
      lastErrorAt: null,
      alertPendingAt: null,
      // The Outlook mailbox's last send is not this Gmail mailbox's, and the row holds nothing
      // older than the Outlook connection, so "never sent" is the only truthful value.
      lastSentAt: null,
    });
    expect(view2).toEqual({
      configured: true,
      googleConfigured: true,
      microsoftConfigured: true,
      connected: true,
      provider: "GOOGLE",
      accountEmail: "gmail-owner@acme.test",
      status: "CONNECTED",
      throttledUntil: null,
      lastError: null,
      lastSentAt: null,
    });
    expect(audit.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "mailbox.reconnected_different_account",
        meta: { provider: "GOOGLE", accountEmail: "gmail-owner@acme.test" },
      }),
    );
  });

  it("a grant that carries no access token resets both access-token columns instead of inheriting the other provider's", async () => {
    const { service, table, encryption } = buildService();
    await connectMicrosoft(service, outlookOwner);
    const outlookRow = table.peek(TENANT)!;
    expect(outlookRow.accessTokenCipher).not.toBeNull();

    await connectGoogle(service, {
      ...googleOwner,
      accessToken: undefined,
      expiryDate: undefined,
    });
    const row = readable(table.peek(TENANT)!, outlookRow, encryption);

    expect(row.accessTokenCipher).toBeNull();
    expect(row.accessTokenExpiresAt).toBeNull();
    expect(row.refreshTokenCipher).toBe("g-rt-1");
  });

  it("re-granting the SAME mailbox (REVOKED → Reconnect, same Google account) resets the grant and health but keeps the mailbox's lastSentAt", async () => {
    const { service, table, audit, encryption } = buildService();
    await connectGoogle(service, googleOwner);
    const lastSend = T("2026-09-22T15:30:00.000Z");
    await table.update({
      where: { tenantId: TENANT },
      data: { status: "CONNECTED", throttledUntil: null, lastSentAt: lastSend, lastError: null },
    });
    await table.update({
      where: { tenantId: TENANT },
      data: {
        status: "REVOKED",
        lastError: "Google revoked access to this mailbox — reconnect required.",
        lastErrorAt: T("2026-09-23T07:00:00.000Z"),
      },
    });
    const revokedRow = table.peek(TENANT)!;

    await connectGoogle(service, { ...googleOwner, refreshToken: "g-rt-2", accessToken: "g-at-2" });

    expect(readable(table.peek(TENANT)!, revokedRow, encryption)).toEqual({
      id: revokedRow.id,
      tenantId: TENANT,
      createdAt: revokedRow.createdAt,
      updatedAt: "bumped",
      provider: "GOOGLE",
      accountEmail: "gmail-owner@acme.test",
      externalSubject: "google-sub-1",
      scopesGranted: GOOGLE_SCOPES,
      refreshTokenCipher: "g-rt-2",
      accessTokenCipher: "g-at-2",
      accessTokenExpiresAt: new Date(NOW + 3_600_000),
      connectedByUserId: "user-1",
      status: "CONNECTED",
      throttledUntil: null,
      lastError: null,
      lastErrorAt: null,
      alertPendingAt: null,
      lastSentAt: lastSend,
    });
    expect(audit.log).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "mailbox.reconnected" }),
    );
  });

  it("the same provider but a DIFFERENT account is a different mailbox: lastSentAt resets", async () => {
    const { service, table, audit } = buildService();
    await connectGoogle(service, googleOwner);
    await table.update({
      where: { tenantId: TENANT },
      data: { lastSentAt: T("2026-09-22T15:30:00.000Z") },
    });

    const view = await connectGoogle(service, {
      ...googleOwner,
      sub: "google-sub-2",
      email: "other-gmail@acme.test",
    });

    expect(table.peek(TENANT)!.lastSentAt).toBeNull();
    expect(view.lastSentAt).toBeNull();
    expect(view.accountEmail).toBe("other-gmail@acme.test");
    expect(audit.log).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "mailbox.reconnected_different_account" }),
    );
  });

  it("the other provider is a different mailbox even when its account id happens to equal the old one: identity is (provider, subject)", async () => {
    const { service, table, audit } = buildService();
    await connectGoogle(service, { ...googleOwner, sub: "shared-id-1" });
    await table.update({
      where: { tenantId: TENANT },
      data: { lastSentAt: T("2026-09-22T15:30:00.000Z") },
    });

    await connectMicrosoft(service, { ...outlookOwner, objectId: "shared-id-1" });

    expect(table.peek(TENANT)!.lastSentAt).toBeNull();
    expect(audit.log).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "mailbox.reconnected_different_account" }),
    );
  });

  it("the table double refuses a column the schema doesn't have, so a mistyped write can't pass silently", async () => {
    const { service, table } = buildService();
    await connectGoogle(service, googleOwner);

    await expect(
      table.update({ where: { tenantId: TENANT }, data: { lastSentOn: new Date() } }),
    ).rejects.toThrow('unknown MailboxConnection column "lastSentOn"');
  });
});
