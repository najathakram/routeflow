/**
 * F-10a review of #2112 (Opus, REQUIRED 1–4) — the send path must stay consistent with a
 * connection that changes underneath it:
 *   1. everything after the advisory lock uses the connection read UNDER the lock — never the
 *      pre-lock read an admin's reconnect (even to the other provider) may have made stale;
 *   2. a THROTTLED connection recovers only once its window has lapsed, and a rate limit alerts the
 *      admins at most once per connection per 24h (the audit row is still written every time);
 *   3. the status change and its audit row commit together, and nobody is told before they do;
 *   4. a successful send stamps lastSentAt only on the mailbox that actually sent it.
 *
 * The stand-in below holds the two tables the send path touches, with the semantics these pins
 * depend on: every read returns a copy (a later write never reaches a row the service already
 * holds), `updateMany` evaluates its where-clause against the CURRENT row, and `$transaction`
 * commits all of its writes or none. A query shape it can't evaluate throws, so no pin can pass on
 * a condition the stand-in silently ignored. Real-Postgres twins of these pins live in
 * mailbox-state-change.db.spec.ts.
 */
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { EncryptionService } from "../../common/encryption.service";
import { withAdvisoryLock } from "../../common/db-locks";
import { MailboxSendService, type MailboxStateChange } from "./mailbox-send.service";

jest.mock("axios");
jest.mock("../../common/db-locks", () => ({
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const MS_GRAPH_SEND_MAIL_URL = "https://graph.microsoft.com/v1.0/me/sendMail";
const RATE_LIMITED = "Rate-limited by Google — falling back to the next sender.";

const encryption = new EncryptionService({
  get: (k: string) => (k === "ENCRYPTION_KEY" ? "a".repeat(64) : undefined),
} as unknown as ConfigService);
const config = { get: () => undefined } as unknown as ConfigService;

// ─── The stand-in ────────────────────────────────────────────────────────────────────────────

type Row = Record<string, any>;
type Where = Record<string, any>;
interface Tables {
  connections: Row[];
  audit: Row[];
}

const COMPARISONS = new Set(["in", "lte", "gte", "lt", "gt"]);

/** Realm-proof: Jest's sandbox has its own `Date`, so `instanceof` can't be trusted here. */
const isDate = (v: unknown): v is Date => Object.prototype.toString.call(v) === "[object Date]";

/** A deep copy whose Dates are this realm's — `structuredClone` hands back Node's. */
function clone<T>(value: T): T {
  if (isDate(value)) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map((v) => clone(v)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])) as T;
  }
  return value;
}

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Where[]).some((w) => matches(row, w));
    if (key === "AND") return (cond as Where[]).every((w) => matches(row, w));
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (isDate(cond)) return isDate(value) && value.getTime() === cond.getTime();
    if (typeof cond === "object") {
      return Object.entries(cond as Record<string, unknown>).every(([op, arg]) => {
        if (!COMPARISONS.has(op)) throw new Error(`stand-in: unsupported operator "${op}"`);
        if (op === "in") return (arg as unknown[]).includes(value);
        if (value === null || value === undefined) return false;
        const [a, b] = [Number(value), Number(arg)];
        return op === "lte" ? a <= b : op === "gte" ? a >= b : op === "lt" ? a < b : a > b;
      });
    }
    return value === cond;
  });
}

class StandInDb {
  private tables: Tables = { connections: [], audit: [] };
  private seq = 0;
  /** Makes every audit insert fail, as a constraint or connection error would. */
  auditInsertFails = false;

  readonly client = this.clientOver(() => this.tables, true);

  seedConnection(row: Row): void {
    this.tables.connections.push(clone(row));
  }

  seedAudit(row: Row): void {
    this.tables.audit.push({ id: `al-seed-${++this.seq}`, ...clone(row) });
  }

  /** A write from outside the service: another replica, or the admin reconnecting. */
  write(id: string, patch: Row): void {
    const row = this.tables.connections.find((r) => r.id === id);
    if (!row) throw new Error(`stand-in: no connection ${id}`);
    Object.assign(row, clone(patch));
  }

  connection(id: string): Row {
    return clone(this.tables.connections.find((r) => r.id === id)!);
  }

  auditRows(): Row[] {
    return clone(this.tables.audit);
  }

  private clientOver(tables: () => Tables, topLevel: boolean): any {
    const find = (where: Where) => tables().connections.find((r) => matches(r, where));
    const client: any = {
      mailboxConnection: {
        findUnique: async ({ where }: { where: Where }) => {
          const row = find(where);
          return row ? clone(row) : null;
        },
        update: async ({ where, data }: { where: Where; data: Row }) => {
          const row = find(where);
          if (!row)
            throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
          Object.assign(row, clone(data));
          return clone(row);
        },
        updateMany: async ({ where, data }: { where: Where; data: Row }) => {
          const hits = tables().connections.filter((r) => matches(r, where));
          for (const row of hits) Object.assign(row, clone(data));
          return { count: hits.length };
        },
      },
      auditLog: {
        create: async ({ data }: { data: Row }) => {
          if (this.auditInsertFails) {
            throw Object.assign(new Error("audit insert failed"), { code: "P1017" });
          }
          const row = { id: `al-${++this.seq}`, createdAt: new Date(), ...clone(data) };
          tables().audit.push(row);
          return clone(row);
        },
        findFirst: async ({ where }: { where: Where }) => {
          const row = tables().audit.find((r) => matches(r, where));
          return row ? { id: row.id } : null;
        },
      },
    };
    if (topLevel) {
      client.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
        const staged = clone(this.tables);
        const result = await fn(this.clientOver(() => staged, false));
        this.tables = staged; // commit — only reached when fn resolved
        return result;
      };
    }
    return client;
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────────────────────

function mailbox(over: Row = {}): Row {
  return {
    id: "mc-1",
    tenantId: "tenant-a",
    provider: "GOOGLE",
    accountEmail: "sales@acme.test",
    externalSubject: "google-sub-sales",
    scopesGranted: ["gmail.send"],
    status: "CONNECTED",
    throttledUntil: null,
    lastError: null,
    lastErrorAt: null,
    lastSentAt: null,
    refreshTokenCipher: encryption.encrypt("rt-sales"),
    accessTokenCipher: encryption.encrypt("at-sales"),
    accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    ...over,
  };
}

/**
 * What `confirmConnect` writes when an admin reconnects: the SAME row (it upserts on tenantId),
 * a new grant, CONNECTED, errors cleared — and, when it is a different mailbox, lastSentAt reset
 * (#2114). A re-grant of the same mailbox leaves lastSentAt alone.
 */
function reconnect(
  db: StandInDb,
  next: {
    provider: "GOOGLE" | "MICROSOFT";
    accountEmail: string;
    externalSubject: string;
    token: string;
    sameMailbox?: boolean;
  },
): void {
  db.write("mc-1", {
    provider: next.provider,
    accountEmail: next.accountEmail,
    externalSubject: next.externalSubject,
    refreshTokenCipher: encryption.encrypt(`rt-${next.token}`),
    accessTokenCipher: encryption.encrypt(`at-${next.token}`),
    accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    status: "CONNECTED",
    throttledUntil: null,
    lastError: null,
    lastErrorAt: null,
    ...(next.sameMailbox ? {} : { lastSentAt: null }),
  });
}

/** Runs `whileWaiting` while the send is blocked on the advisory lock — after its lock-free read,
 *  before its read under the lock: exactly where a concurrent `confirmConnect` lands. */
function whileSendWaitsForLock(whileWaiting: () => void): void {
  (withAdvisoryLock as jest.Mock).mockImplementationOnce(
    async (_opts: unknown, fn: () => Promise<unknown>) => {
      whileWaiting();
      return { acquired: true, value: await fn() };
    },
  );
}

function httpError(status: number, data: unknown = {}, headers: Record<string, string> = {}) {
  const err: any = new Error(`Request failed with status code ${status}`);
  err.response = { status, data, headers };
  return err;
}

interface ProviderCall {
  url: string;
  authorization: string;
  mime: string;
}

/** Stubs both provider APIs; `respond` decides each call's outcome. */
function providers(respond: (url: string) => unknown): ProviderCall[] {
  const calls: ProviderCall[] = [];
  (axios.post as jest.Mock).mockImplementation(async (url: string, body: any, cfg: any) => {
    const raw: string = url === GMAIL_SEND_URL ? body.raw : body;
    calls.push({
      url,
      authorization: cfg?.headers?.Authorization,
      mime: Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    });
    const outcome = respond(url);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return calls;
}

function build(db: StandInDb) {
  const service = new MailboxSendService(db.client, encryption, config, {
    decide: jest.fn().mockResolvedValue({ outcome: "granted", overrides: new Map() }),
  } as any);
  const alerts: MailboxStateChange[] = [];
  service.onStateChange((change) => {
    alerts.push(change);
  });
  return { service, alerts };
}

const send = (service: MailboxSendService) =>
  service.trySend("tenant-a", {
    to: "customer@example.test",
    subject: "Invoice INV-1001",
    html: "<p>Your invoice</p>",
    fromName: "Acme Wholesale",
  });

const throttleRows = (db: StandInDb) =>
  db.auditRows().filter((r) => r.action === "mailbox.throttled_detected");

beforeEach(() => jest.clearAllMocks());

// ─── 1. The connection read under the lock is the only one used afterwards ───────────────────

describe("REG-2112-1 — after the lock, only the connection read under it is used", () => {
  it("REG-2112-1a: an admin reconnects with the OTHER provider while the send waits for the lock — it sends through the new provider, as the new address, and never revokes the new connection", async () => {
    const db = new StandInDb();
    db.seedConnection(
      mailbox({
        provider: "MICROSOFT",
        accountEmail: "old@acme.test",
        externalSubject: "ms-oid-old",
        accessTokenCipher: encryption.encrypt("at-ms-old"),
      }),
    );
    whileSendWaitsForLock(() =>
      reconnect(db, {
        provider: "GOOGLE",
        accountEmail: "new@acme.test",
        externalSubject: "google-sub-new",
        token: "google-new",
      }),
    );
    // Graph would reject a Google token with 401 — the failure this pin exists to prevent.
    const calls = providers((url) =>
      url === GMAIL_SEND_URL
        ? { data: { id: "gmail-1" } }
        : httpError(401, { error: { code: "InvalidAuthenticationToken" } }),
    );
    const { service, alerts } = build(db);

    const res = await send(service);

    expect(res).toEqual({
      delivered: true,
      transport: "mailbox",
      id: "gmail-1",
      fromAddress: "new@acme.test",
    });
    expect(calls.map((c) => c.url)).toEqual([GMAIL_SEND_URL]);
    expect(calls[0].authorization).toBe("Bearer at-google-new");
    expect(calls[0].mime).toContain("Acme Wholesale <new@acme.test>");
    expect(db.connection("mc-1")).toMatchObject({ provider: "GOOGLE", status: "CONNECTED" });
    expect(db.auditRows()).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it("REG-2112-1b: a connection throttled while the send waited for the lock is not sent through", async () => {
    const db = new StandInDb();
    db.seedConnection(mailbox());
    const until = new Date(Date.now() + 60_000);
    whileSendWaitsForLock(() =>
      db.write("mc-1", { status: "THROTTLED", throttledUntil: until, lastError: RATE_LIMITED }),
    );
    const calls = providers(() => ({ data: { id: "gmail-1" } }));
    const { service } = build(db);

    const res = await send(service);

    expect(res).toEqual({ delivered: false, transport: "mailbox", error: "throttled" });
    expect(calls).toEqual([]);
    expect(db.connection("mc-1")).toMatchObject({ status: "THROTTLED", throttledUntil: until });
  });

  it("REG-2112-1c: a rate limit on a connection rebound while the send waited throttles THAT connection, and its audit row names that account", async () => {
    const db = new StandInDb();
    db.seedConnection(
      mailbox({ accountEmail: "old@acme.test", externalSubject: "google-sub-old" }),
    );
    whileSendWaitsForLock(() =>
      reconnect(db, {
        provider: "GOOGLE",
        accountEmail: "new@acme.test",
        externalSubject: "google-sub-new",
        token: "google-new",
      }),
    );
    providers(() => httpError(429, {}, { "retry-after": "120" }));
    const { service, alerts } = build(db);

    const res = await send(service);

    expect(res.error).toBe("throttled");
    expect(db.connection("mc-1")).toMatchObject({
      accountEmail: "new@acme.test",
      status: "THROTTLED",
    });
    expect(throttleRows(db)).toHaveLength(1);
    expect(throttleRows(db)[0].meta).toEqual({
      provider: "GOOGLE",
      accountEmail: "new@acme.test",
      reasonCode: "rate_limited",
    });
    expect(alerts.map((a) => a.accountEmail)).toEqual(["new@acme.test"]);
  });
});

// ─── 2. Recovery only after the window; one THROTTLED alert per connection per 24h ────────────

describe("REG-2112-2 — THROTTLED recovery and alert frequency", () => {
  it("REG-2112-2a: a send that succeeds while the THROTTLED window is still open does not recover the connection", async () => {
    const db = new StandInDb();
    db.seedConnection(mailbox());
    const until = new Date(Date.now() + 60_000);
    providers(() => {
      // A concurrent send hits the rate limit while this one is still on the wire.
      db.write("mc-1", {
        status: "THROTTLED",
        throttledUntil: until,
        lastError: RATE_LIMITED,
        lastErrorAt: new Date(),
      });
      return { data: { id: "gmail-1" } };
    });
    const { service } = build(db);

    const res = await send(service);

    expect(res).toMatchObject({ delivered: true }); // the message itself did go out
    expect(db.connection("mc-1")).toMatchObject({
      status: "THROTTLED",
      throttledUntil: until,
      lastError: RATE_LIMITED,
    });
  });

  it("(companion, not a red pin) a send after the window has lapsed does recover the connection", async () => {
    const db = new StandInDb();
    db.seedConnection(
      mailbox({
        status: "THROTTLED",
        throttledUntil: new Date(Date.now() - 1000),
        lastError: RATE_LIMITED,
      }),
    );
    providers(() => ({ data: { id: "gmail-1" } }));
    const { service } = build(db);

    await send(service);

    expect(db.connection("mc-1")).toMatchObject({
      status: "CONNECTED",
      throttledUntil: null,
      lastError: null,
    });
    expect(db.connection("mc-1").lastSentAt).toBeInstanceOf(Date);
  });

  it("REG-2112-2b: a second rate limit within 24h writes its audit row but alerts no one", async () => {
    const db = new StandInDb();
    db.seedConnection(mailbox());
    db.seedAudit({
      tenantId: "tenant-a",
      userId: null,
      action: "mailbox.throttled_detected",
      entityType: "mailbox_connection",
      entityId: "mc-1",
      meta: { provider: "GOOGLE", accountEmail: "sales@acme.test", reasonCode: "rate_limited" },
      createdAt: new Date(Date.now() - 60 * 60_000), // an hour ago
    });
    providers(() => httpError(429, {}, { "retry-after": "30" }));
    const { service, alerts } = build(db);

    const res = await send(service);

    expect(res.error).toBe("throttled");
    expect(db.connection("mc-1").status).toBe("THROTTLED");
    expect(throttleRows(db)).toHaveLength(2); // this transition is still on the record
    expect(alerts).toEqual([]);
  });

  it("(companion, not a red pin) a rate limit more than 24h after the last one alerts again", async () => {
    const db = new StandInDb();
    db.seedConnection(mailbox());
    db.seedAudit({
      tenantId: "tenant-a",
      userId: null,
      action: "mailbox.throttled_detected",
      entityType: "mailbox_connection",
      entityId: "mc-1",
      meta: { provider: "GOOGLE", accountEmail: "sales@acme.test", reasonCode: "rate_limited" },
      createdAt: new Date(Date.now() - 25 * 60 * 60_000),
    });
    providers(() => httpError(429, {}, { "retry-after": "30" }));
    const { service, alerts } = build(db);

    await send(service);

    expect(throttleRows(db)).toHaveLength(2);
    expect(alerts.map((a) => a.status)).toEqual(["THROTTLED"]);
  });

  it("(companion, not a red pin) a recent rate limit never mutes a revocation", async () => {
    const db = new StandInDb();
    db.seedConnection(mailbox({ provider: "MICROSOFT", externalSubject: "ms-oid-sales" }));
    db.seedAudit({
      tenantId: "tenant-a",
      userId: null,
      action: "mailbox.throttled_detected",
      entityType: "mailbox_connection",
      entityId: "mc-1",
      meta: { provider: "MICROSOFT", accountEmail: "sales@acme.test", reasonCode: "rate_limited" },
      createdAt: new Date(Date.now() - 60 * 60_000),
    });
    providers(() => httpError(401, { error: { code: "InvalidAuthenticationToken" } }));
    const { service, alerts } = build(db);

    await send(service);

    expect(db.connection("mc-1").status).toBe("REVOKED");
    expect(alerts.map((a) => a.status)).toEqual(["REVOKED"]);
  });
});

// ─── 3. The status change and its audit row commit together ─────────────────────────────────

describe("REG-2112-3 — one transaction, notify after commit", () => {
  it("REG-2112-3: when the audit insert fails, the status change rolls back and nothing is sent", async () => {
    const db = new StandInDb();
    db.seedConnection(mailbox({ provider: "MICROSOFT", externalSubject: "ms-oid-sales" }));
    db.auditInsertFails = true;
    providers(() => httpError(401, { error: { code: "InvalidAuthenticationToken" } }));
    const { service, alerts } = build(db);

    const res = await send(service);

    expect(res).toEqual({ delivered: false, transport: "mailbox", error: "revoked" }); // still falls through
    expect(db.connection("mc-1")).toMatchObject({ status: "CONNECTED", lastError: null });
    expect(db.auditRows()).toEqual([]);
    expect(alerts).toEqual([]);
  });
});

// ─── 4. lastSentAt belongs to the mailbox that sent ─────────────────────────────────────────

describe("REG-2112-4 — a send stamps only the mailbox that sent it", () => {
  it("REG-2112-4: a reconnect to a different mailbox during an in-flight send leaves the new row's lastSentAt null", async () => {
    const db = new StandInDb();
    db.seedConnection(mailbox({ lastSentAt: new Date("2026-09-01T00:00:00Z") }));
    providers(() => {
      reconnect(db, {
        provider: "GOOGLE",
        accountEmail: "new@acme.test",
        externalSubject: "google-sub-new",
        token: "google-new",
      });
      return { data: { id: "gmail-1" } };
    });
    const { service } = build(db);

    const res = await send(service);

    expect(res).toMatchObject({ delivered: true, fromAddress: "sales@acme.test" });
    expect(db.connection("mc-1")).toMatchObject({
      accountEmail: "new@acme.test",
      lastSentAt: null,
    });
  });

  it("(companion, not a red pin) a re-grant of the SAME mailbox during an in-flight send still records the send", async () => {
    const db = new StandInDb();
    const before = new Date("2026-09-01T00:00:00Z");
    db.seedConnection(mailbox({ lastSentAt: before }));
    providers(() => {
      reconnect(db, {
        provider: "GOOGLE",
        accountEmail: "sales@acme.test",
        externalSubject: "google-sub-sales",
        token: "google-regrant",
        sameMailbox: true,
      });
      return { data: { id: "gmail-1" } };
    });
    const { service } = build(db);

    await send(service);

    const stamped = db.connection("mc-1").lastSentAt as Date;
    expect(stamped).toBeInstanceOf(Date);
    expect(stamped.getTime()).toBeGreaterThan(before.getTime());
  });
});
