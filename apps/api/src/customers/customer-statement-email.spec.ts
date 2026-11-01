import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { CustomersController } from "./customers.controller";
import { EMAIL_KINDS, EMAIL_KIND_AUDIENCE } from "../email/email-kinds";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { buildStatementEmail, sendCustomerStatementEmail } from "./customer-statement-email";
import { SendStatementEmailDto } from "./dto/send-statement-email.dto";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import type { AccountStatement } from "@routeflow/types";

const mockBuild = jest.fn();
jest.mock("./account-statement", () => ({
  ...jest.requireActual("./account-statement"),
  buildAccountStatement: (...a: unknown[]) => mockBuild(...a),
}));

/**
 * SA-1078 PR-4 (W-1096): the statement email. Rows E1-E11 (+ S19 for the email route, + the kind registration). Dummy data:
 * Acme Corp on tenant `test`.
 */

const STATEMENT: AccountStatement = {
  asOf: "2026-10-31",
  customer: { id: "cust-1", businessName: "Acme Corp" },
  emailOnFile: null,
  openBalance: 350,
  overdue: 100,
  creditAvailable: 0,
  afterCredit: 350,
  waitingToClear: 0,
  openInvoices: [],
  recentPayments: [],
  recentPaymentsTruncated: false,
  credits: [],
};
const PDF = Buffer.from("%PDF-1.4 statement");

function arrange(
  over: {
    customerEmail?: string | null;
    customer?: unknown;
    configured?: boolean;
    sendResult?: Record<string, unknown>;
    statement?: Partial<AccountStatement>;
    tenantName?: string | null;
    renderFails?: boolean;
    now?: Date;
  } = {},
) {
  const customer =
    "customer" in over
      ? over.customer
      : {
          id: "cust-1",
          businessName: "Acme Corp",
          email: "customerEmail" in over ? over.customerEmail : "ap@acme.example",
        };
  const findFirst = jest.fn().mockResolvedValue(customer);
  const send = jest.fn().mockResolvedValue(over.sendResult ?? { delivered: true });
  const isEmailConfigured = jest.fn().mockResolvedValue(over.configured ?? true);
  mockBuild.mockReset();
  const statement = { ...STATEMENT, ...over.statement };
  mockBuild.mockResolvedValue(statement);
  const loadTenant = jest
    .fn()
    .mockResolvedValue(
      over.tenantName === null ? null : { businessName: over.tenantName ?? "Test Wholesale" },
    );
  const renderCurrent = over.renderFails
    ? jest.fn().mockRejectedValue(new Error("react-pdf blew up"))
    : jest.fn().mockResolvedValue(PDF);
  const prisma = {
    forTenant: () => ({ customer: { findFirst } }),
    getTenantId: () => "tenant-test",
  };
  const deps = {
    prisma,
    emailService: { isEmailConfigured, send },
    statementPdf: { loadTenant, renderCurrent },
    now: over.now,
  };
  return { deps: deps as any, findFirst, send, isEmailConfigured, renderCurrent, statement };
}

describe("sendCustomerStatementEmail (SA-1078 PR-4)", () => {
  it("E1: goes to the on-file address with the PDF attached, and subject, body and PDF come from one build object", async () => {
    const a = arrange();
    const res = await sendCustomerStatementEmail(a.deps, "cust-1");
    expect(res).toEqual({ success: true, sentTo: "ap@acme.example" });
    expect(mockBuild).toHaveBeenCalledTimes(1); // one read
    expect(a.renderCurrent).toHaveBeenCalledTimes(1); // one render
    expect(mockBuild.mock.calls[0][2]).toMatchObject({ staff: false }); // the customer-shaped read
    expect(a.renderCurrent.mock.calls[0][0]).toBe(a.statement); // the page is drawn from that same object
    const sent = a.send.mock.calls[0][0];
    expect(sent.to).toBe("ap@acme.example");
    expect(sent.subject).toBe("Your statement from Test Wholesale");
    expect(sent.attachments).toEqual([
      { filename: expect.stringMatching(/\.pdf$/), content: PDF, contentType: "application/pdf" },
    ]);
    // the body is built from the very statement the PDF was rendered from
    expect(sent.text).toContain("Open balance: $350.00");
    expect(sent.html).toContain("$350.00");
  });

  it("E2: a typed address wins over the on-file one", async () => {
    const a = arrange();
    const res = await sendCustomerStatementEmail(a.deps, "cust-1", "billing@acme.example");
    expect(res.sentTo).toBe("billing@acme.example");
    expect(a.send.mock.calls[0][0].to).toBe("billing@acme.example");
  });

  it("E3: an import-sentinel address on file is no address (400 with nothing rendered or sent)", async () => {
    const a = arrange({ customerEmail: "ghost@imported.local" });
    await expect(sendCustomerStatementEmail(a.deps, "cust-1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(a.renderCurrent).not.toHaveBeenCalled();
    expect(a.send).not.toHaveBeenCalled();
    // a typed address still goes
    const b = arrange({ customerEmail: "ghost@imported.local" });
    await expect(sendCustomerStatementEmail(b.deps, "cust-1", "ap@acme.example")).resolves.toEqual({
      success: true,
      sentTo: "ap@acme.example",
    });
    // and a typed sentinel is no address either
    const c = arrange({ customerEmail: null });
    await expect(
      sendCustomerStatementEmail(c.deps, "cust-1", "x@placeholder.local"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("E4: email not set up → EMAIL_NOT_CONFIGURED, nothing rendered", async () => {
    const a = arrange({ configured: false });
    await expect(sendCustomerStatementEmail(a.deps, "cust-1")).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.EMAIL_NOT_CONFIGURED },
    });
    expect(a.renderCurrent).not.toHaveBeenCalled();
    expect(a.send).not.toHaveBeenCalled();
  });

  it("E5: transport fails → EMAIL_SEND_FAILED carrying the reason", async () => {
    const a = arrange({ sendResult: { delivered: false, error: "550 mailbox full" } });
    await expect(sendCustomerStatementEmail(a.deps, "cust-1")).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.EMAIL_SEND_FAILED },
    });
    const err = await sendCustomerStatementEmail(a.deps, "cust-1").catch((e) => e);
    expect(JSON.stringify(err.response)).toContain("550 mailbox full");
  });

  it("E6: the delivery row is a CUSTOMER_STATEMENT on the Customer entity for the tenant", async () => {
    const a = arrange();
    await sendCustomerStatementEmail(a.deps, "cust-1");
    expect(a.send.mock.calls[0][0].delivery).toEqual({
      tenantId: "tenant-test",
      kind: "CUSTOMER_STATEMENT",
      entityType: "Customer",
      entityId: "cust-1",
    });
    expect(EMAIL_KINDS).toContain("CUSTOMER_STATEMENT");
    expect(EMAIL_KIND_AUDIENCE.CUSTOMER_STATEMENT).toBe("tenant");
  });

  it("E7: a tenant SMTP fallback still sends, and the warning and From address are returned", async () => {
    const a = arrange({
      sendResult: {
        delivered: true,
        smtpFallbackReason: "Your SMTP login was refused.",
        fromAddress: "noreply@routeflow.example",
      },
    });
    const res = await sendCustomerStatementEmail(a.deps, "cust-1");
    expect(res).toEqual({
      success: true,
      sentTo: "ap@acme.example",
      warning: "Your SMTP login was refused.",
      fromAddress: "noreply@routeflow.example",
    });
  });

  it("E8: $0 owed says so in the body (and still sends)", async () => {
    const a = arrange({ statement: { openBalance: 0, overdue: 0, afterCredit: 0 } });
    await sendCustomerStatementEmail(a.deps, "cust-1");
    const sent = a.send.mock.calls[0][0];
    expect(sent.text).toContain("You have no open balance as of Oct 31, 2026.");
    expect(sent.text).not.toContain("Open balance:");
  });

  it("E12: one clock — the read, the page's stamp, the subject and the body all read the same instant", async () => {
    const now = new Date("2026-11-01T04:30:00.000Z"); // Oct 31 evening in Chicago
    const a = arrange({ now });
    await sendCustomerStatementEmail(a.deps, "cust-1");
    expect(mockBuild.mock.calls[0][2]).toEqual({ staff: false, now });
    expect(a.renderCurrent.mock.calls[0][2]).toBe(now);
    expect(a.send.mock.calls[0][0].text).toContain("as of Oct 31, 2026");
  });

  it("E13: the attachment is the rendered buffer itself — storage is never read back", async () => {
    const a = arrange();
    await sendCustomerStatementEmail(a.deps, "cust-1");
    expect(a.send.mock.calls[0][0].attachments[0].content).toBe(PDF);
    expect(a.deps.statementPdf.download).toBeUndefined();
    expect(a.deps.storage).toBeUndefined();
  });

  it("E14: a render that throws sends nothing and writes no delivery row (EMAIL_SEND_FAILED)", async () => {
    const a = arrange({ renderFails: true });
    await expect(sendCustomerStatementEmail(a.deps, "cust-1")).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.EMAIL_SEND_FAILED },
    });
    expect(a.send).not.toHaveBeenCalled();
  });

  it("a customer the tenant does not have is a 404 before anything else", async () => {
    const a = arrange({ customer: null });
    await expect(sendCustomerStatementEmail(a.deps, "nope")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(a.isEmailConfigured).not.toHaveBeenCalled();
    expect(a.renderCurrent).not.toHaveBeenCalled();
  });
});

describe("buildStatementEmail (SA-1078 PR-4)", () => {
  it("subject and body use the spec's words, from the one statement", () => {
    const m = buildStatementEmail(STATEMENT, "Test Wholesale");
    expect(m.subject).toBe("Your statement from Test Wholesale");
    expect(m.text).toBe(
      "Here's your statement as of Oct 31, 2026. Open balance: $350.00. Overdue: $100.00. The PDF is attached. Reply to this email with any questions.",
    );
  });

  it("falls back to a plain subject when the business has no name on file", () => {
    expect(buildStatementEmail(STATEMENT, null).subject).toBe("Your account statement");
  });

  it("a business name with markup is escaped in the HTML body and never executable", () => {
    const m = buildStatementEmail(STATEMENT, `<script>alert("x")</script>`);
    expect(m.html).not.toContain("<script>");
  });

  it("the PDF's file name names the customer's day, not the clock", () => {
    expect(buildStatementEmail(STATEMENT, "Test Wholesale").pdfFilename).toBe(
      "statement-2026-10-31.pdf",
    );
  });
});

describe("POST /customers/:id/account-statement/email (SA-1078 PR-4)", () => {
  it("S19: the route is OPERATOR-only (a DRIVER or CUSTOMER role is refused)", () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      CustomersController.prototype.sendAccountStatementEmail,
    );
    expect(roles).toEqual(["OPERATOR"]);
  });

  it("E11: a bad address is a 400 from the DTO, before any render", async () => {
    const bad = plainToInstance(SendStatementEmailDto, { email: "not-an-address" });
    expect((await validate(bad)).length).toBeGreaterThan(0);
    const long = plainToInstance(SendStatementEmailDto, {
      email: `${"a".repeat(250)}@acme.example`,
    });
    expect((await validate(long)).length).toBeGreaterThan(0);
    const ok = plainToInstance(SendStatementEmailDto, { email: "ap@acme.example" });
    expect(await validate(ok)).toHaveLength(0);
    const none = plainToInstance(SendStatementEmailDto, {});
    expect(await validate(none)).toHaveLength(0);
  });
});
