/**
 * SMTP integration spec — EmailService against a REAL SMTP server (the compose `mailpit`), not a
 * mocked nodemailer. Proves what the unit specs cannot: a genuine TCP connect, STARTTLS upgrade
 * (certificate verified — never disabled), AUTH and delivery, and that the failure paths are
 * reported honestly.
 *
 * Scope: the PLATFORM SMTP branch of `send()`/`sendPlatform()` (SMTP_HOST/PORT/USER/PASS). The
 * tenant-configured-SMTP branch cannot run here — `assertSafeSmtpEndpoint` only allows ports
 * 25/465/587/2525 (never mailpit's 1025), and `requireTLS` (port 587 only) is not exercised.
 *
 * Collected only by `jest.smtp.config.js` (`.smtp.spec.ts$`); run it with `npm run
 * local:test:smtp` (also chained into `npm run local:validate:features`). A run that cannot reach
 * mailpit FAILS — there is no skip path — and `requireLocalSmtp()` refuses any non-local target.
 * Every message uses a unique subject token so parallel local runs never read each other's mail;
 * `afterEach` deletes exactly the messages this file created.
 *
 * NOT covered here (by design, a follow-up once the [EMAIL@pc] attachment PR merges): the PDF
 * attachment assertion.
 */
import { randomUUID } from "crypto";
import * as net from "net";
import { EmailService } from "./email.service";
import { describeSmtp, requireLocalSmtp } from "../common/testing/smtp-spec";

const TARGET = requireLocalSmtp();
const BUSINESS = "Acme Test Bakery";
const REPLY_TO = "orders@acme-test.example";
const PLATFORM_ADDRESS = "noreply@routeflow.info";
const RECIPIENT = "buyer@example.test";

interface MailpitAddress {
  Name: string;
  Address: string;
}
interface MailpitMessage {
  ID: string;
  MessageID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  ReplyTo: MailpitAddress[];
  Subject: string;
  HTML: string;
  Text: string;
}

async function mailpit<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${TARGET.apiUrl}${path}`, init);
  if (!res.ok) throw new Error(`mailpit ${init?.method ?? "GET"} ${path} -> HTTP ${res.status}`);
  // Mailpit answers some writes (DELETE /messages) with the bare text "ok", not JSON.
  const body = await res.text();
  return (body.startsWith("{") || body.startsWith("[") ? JSON.parse(body) : body) as T;
}

/** The (0 or 1) messages whose subject carries this run's unique token. */
async function findBySubject(subject: string): Promise<MailpitMessage[]> {
  const found = await mailpit<{ messages: { ID: string }[] }>(
    `/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`,
  );
  return Promise.all(found.messages.map((m) => mailpit<MailpitMessage>(`/api/v1/message/${m.ID}`)));
}

function makeService(
  smtp: { host: string; port: number; user: string; pass: string } = TARGET,
): EmailService {
  const env: Record<string, string> = {
    SMTP_HOST: smtp.host,
    SMTP_PORT: String(smtp.port),
    SMTP_SECURE: "false",
    SMTP_USER: smtp.user,
    SMTP_PASS: smtp.pass,
    EMAIL_FROM: `RouteFlow <${PLATFORM_ADDRESS}>`,
  };
  const config = { get: (k: string) => env[k] } as never;
  const prisma = {
    getTenantId: () => "tenant-smtp-spec",
    forTenant: () => ({
      systemConfig: {
        findMany: () => Promise.resolve([]),
        findFirst: () => Promise.resolve(null),
      },
    }),
    tenantConfig: {
      findFirst: () => Promise.resolve({ businessName: BUSINESS, customerEmail: REPLY_TO }),
    },
    user: { findFirst: () => Promise.resolve(null) },
  } as never;
  const encryption = { decrypt: (v: string) => v } as never;
  const mailboxSend = {
    trySend: () => Promise.resolve({ delivered: false, transport: "mailbox", error: "none" }),
  } as never;
  return new EmailService(config, prisma, encryption, mailboxSend, { record: jest.fn() } as any);
}

/** One SMTP command/response exchange over a raw socket (no TLS) — reads until a final line. */
function smtpExchange(commands: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: TARGET.host, port: TARGET.port });
    const replies: string[] = [];
    let buf = "";
    let pending = commands.slice();
    const finish = (err?: Error) => {
      socket.destroy();
      if (err) reject(err);
      else resolve(replies);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(20_000, () => finish(new Error("raw SMTP exchange timed out")));
    socket.on("error", finish);
    socket.on("data", (chunk: string) => {
      buf += chunk;
      // A reply is complete on a line of the form "NNN text" (a space, not "-", after the code).
      const lines = buf.split("\r\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        replies.push(line);
        if (/^\d{3} /.test(line)) {
          const next = pending.shift();
          if (next === undefined) return finish();
          socket.write(`${next}\r\n`);
        }
      }
    });
  });
}

describeSmtp("EmailService over real SMTP (mailpit) — STARTTLS + AUTH + delivery", () => {
  const created: string[] = [];
  const subjectToken = (label: string) => {
    const subject = `[smtp-spec ${randomUUID().slice(0, 8)}] ${label}`;
    created.push(subject);
    return subject;
  };

  afterEach(async () => {
    const ids: string[] = [];
    for (const subject of created.splice(0)) {
      const found = await mailpit<{ messages: { ID: string }[] }>(
        `/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`,
      );
      ids.push(...found.messages.map((m) => m.ID));
    }
    if (ids.length) {
      await mailpit("/api/v1/messages", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ IDs: ids }),
      });
    }
  });

  describe("the server really is a STARTTLS + AUTH submission port", () => {
    it("advertises STARTTLS and refuses to take mail before it", async () => {
      const replies = await smtpExchange([
        "EHLO smtp-spec.local",
        `MAIL FROM:<${PLATFORM_ADDRESS}>`,
        "QUIT",
      ]);
      const text = replies.join("\n");
      expect(text).toMatch(/^220 /m); // greeting
      expect(text).toMatch(/^250[- ]STARTTLS/m);
      // With STARTTLS required, MAIL before the TLS upgrade is refused (530 5.7.0) — so any
      // delivery below can only have happened after a successful, certificate-verified upgrade.
      expect(text).toMatch(/^530 /m);
    });
  });

  describe("delivery", () => {
    it("send() delivers over STARTTLS+AUTH; the message lands with the right from-name, reply-to, subject and HTML", async () => {
      const subject = subjectToken("invoice INV-0001");
      const html = `<h1>Invoice INV-0001</h1><p>Total <strong>$12.34</strong></p>`;

      const res = await makeService().send({ to: RECIPIENT, subject, html });

      expect(res).toMatchObject({ delivered: true, transport: "smtp" });
      expect(res.id).toEqual(expect.any(String));
      expect(res.error).toBeUndefined();

      const [msg, ...rest] = await findBySubject(subject);
      expect(rest).toHaveLength(0);
      // The id EmailService returned is the id the server stored — the result is about THIS mail.
      expect(`<${msg.MessageID}>`).toBe(res.id);
      expect(msg.From).toEqual({
        Name: `${BUSINESS} via RouteFlow`,
        Address: PLATFORM_ADDRESS,
      });
      expect(msg.ReplyTo).toEqual([{ Name: "", Address: REPLY_TO }]);
      expect(msg.To).toEqual([{ Name: "", Address: RECIPIENT }]);
      expect(msg.Subject).toBe(subject);
      expect(msg.HTML).toContain("<h1>Invoice INV-0001</h1>");
      expect(msg.HTML).toContain("<strong>$12.34</strong>");
    });

    it("a platform-class send goes out from the bare platform identity with no tenant branding", async () => {
      const subject = subjectToken("password reset");

      const res = await makeService().send({
        to: RECIPIENT,
        subject,
        html: "<p>Reset your password</p>",
        text: "Reset your password",
        senderClass: "platform",
      });

      expect(res).toMatchObject({ delivered: true, transport: "smtp" });
      const [msg] = await findBySubject(subject);
      expect(msg.From).toEqual({ Name: "RouteFlow", Address: PLATFORM_ADDRESS });
      expect(msg.ReplyTo).toEqual([]);
      expect(msg.HTML).toContain("Reset your password");
      expect(msg.Text).toContain("Reset your password");
    });
  });

  describe("failure paths are surfaced honestly (no swallowed error, no fake success)", () => {
    it("a wrong password is a real auth failure: not delivered, error names it, nothing lands", async () => {
      const subject = subjectToken("bad password");

      const res = await makeService({ ...TARGET, pass: "not-the-password" }).send({
        to: RECIPIENT,
        subject,
        html: "<p>should never arrive</p>",
      });

      expect(res.delivered).toBe(false);
      expect(res.transport).toBe("smtp");
      expect(res.id).toBeUndefined();
      expect(res.error).toMatch(/535|invalid login|authentication|credentials/i);
      expect(res.smtpFallbackReason).toEqual(expect.any(String));
      expect(await findBySubject(subject)).toHaveLength(0);
    });

    it("a closed port is refused: not delivered, error carries the connection failure", async () => {
      const subject = subjectToken("closed port");

      const res = await makeService({ ...TARGET, port: 1 }).send({
        to: RECIPIENT,
        subject,
        html: "<p>should never arrive</p>",
      });

      expect(res.delivered).toBe(false);
      expect(res.transport).toBe("smtp");
      expect(res.error).toMatch(/ECONNREFUSED|refused|connect/i);
      expect(await findBySubject(subject)).toHaveLength(0);
    });

    it("an unreachable host times out (TEST-NET-1 blackhole): not delivered, error says so", async () => {
      const subject = subjectToken("unreachable host");

      // 192.0.2.0/24 (RFC 5737) is never routed, so the connect hangs until nodemailer's own
      // fail-fast connectionTimeout — the assertion is on the honest error, not on elapsed time.
      // (Blackhole-less networks answer ENETUNREACH/EHOSTUNREACH at once: still a real failure.)
      const res = await makeService({ ...TARGET, host: "192.0.2.1" }).send({
        to: RECIPIENT,
        subject,
        html: "<p>should never arrive</p>",
      });

      expect(res.delivered).toBe(false);
      expect(res.transport).toBe("smtp");
      expect(res.error).toMatch(/timeout|ETIMEDOUT|greeting|unreach|connect/i);
      expect(await findBySubject(subject)).toHaveLength(0);
    });
  });
});
