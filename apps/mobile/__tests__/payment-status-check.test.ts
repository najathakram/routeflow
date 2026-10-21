import {
  clearPaymentKeyRegistry,
  createPaymentKeyHolder,
  mountPaymentKeyHolder,
  rememberPaymentProof,
} from "../lib/payment-submit-key";
import {
  PAYMENT_STATUS_COPY,
  checkPaymentStatus,
  paymentByKeyPath,
} from "../lib/payment-status-check";

/**
 * SA-824 (SA conditions a/b): the mobile "Check payment status" step. Every case drives the screens' own
 * helper (`checkPaymentStatus`, the one the status hook calls) on a holder that comes from the screens'
 * own mount helper; no holder logic is repeated here. The shared holder decides what the GET-by-key
 * answer means; this pins the path, the FIXED copy (never a raw server message) and the found-path photo.
 */
const pay = { amount: 100, method: "CASH" };
const err = (status?: number, data: Record<string, unknown> = {}) =>
  Object.assign(new Error("RAW SERVER TEXT"), status ? { response: { status, data } } : {});
const SCOPE = "standalone:c1";
const unknownScreen = () => {
  const m = mountPaymentKeyHolder(SCOPE);
  m.holder.keyFor(pay);
  m.holder.settle({ ok: false, error: err(503) });
  return m;
};
const noUpload = jest.fn().mockResolvedValue(undefined);

describe("SA-824 payment status check (mobile)", () => {
  beforeEach(() => {
    clearPaymentKeyRegistry();
    jest.clearAllMocks();
  });

  it("the path is /invoices/payments/by-key/<encoded key>", () => {
    expect(paymentByKeyPath("a/b c")).toBe("/invoices/payments/by-key/a%2Fb%20c");
  });

  it("found: 'This payment was recorded.', the key is released, the stored payment is handed back", async () => {
    const { holder } = unknownScreen();
    const key = holder.peek();
    const fetch = jest.fn().mockResolvedValue({ id: "adv-1" });
    const out = await checkPaymentStatus(holder, SCOPE, fetch, noUpload);
    expect(fetch).toHaveBeenCalledWith(key);
    expect(out.message).toBe("This payment was recorded.");
    expect(out.outcome).toEqual({ kind: "found", payment: { id: "adv-1" } });
    expect(holder.hasUnknown()).toBe(false);
  });

  it("not found (404 PAYMENT_KEY_NOT_FOUND): 'Nothing was recorded. You can try again.', fresh key next", async () => {
    const { holder } = unknownScreen();
    const first = holder.peek();
    const out = await checkPaymentStatus(
      holder,
      SCOPE,
      () => Promise.reject(err(404, { code: "PAYMENT_KEY_NOT_FOUND" })),
      noUpload,
    );
    expect(out.message).toBe("Nothing was recorded. You can try again.");
    expect(holder.hasUnknown()).toBe(false);
    expect(holder.keyFor(pay)).not.toBe(first);
  });

  it("any other error: the fixed 'couldn't check' copy, still unknown, same key", async () => {
    const { holder } = unknownScreen();
    const first = holder.peek();
    const out = await checkPaymentStatus(holder, SCOPE, () => Promise.reject(err(500)), noUpload);
    expect(out.message).toBe("We couldn't check right now. Try again in a moment.");
    expect(out.message).not.toMatch(/RAW/);
    expect(holder.hasUnknown()).toBe(true);
    expect(holder.peek()).toBe(first);
  });

  it("nothing held (a fresh holder): notFound, no call", async () => {
    const holder = createPaymentKeyHolder();
    const fetch = jest.fn();
    const out = await checkPaymentStatus(holder, SCOPE, fetch, noUpload);
    expect(fetch).not.toHaveBeenCalled();
    expect(out.outcome.kind).toBe("notFound");
  });

  it("found: the remembered proof photo is attached to the found payment's id (same upload as the 2xx path)", async () => {
    const { holder } = unknownScreen();
    rememberPaymentProof(SCOPE, "file:///receipt.jpg");
    const upload = jest.fn().mockResolvedValue(undefined);
    const out = await checkPaymentStatus(
      holder,
      SCOPE,
      async () => ({
        scope: "STANDALONE_PAYMENT",
        paymentGroupId: "g1",
        payments: [{ id: "p1" }, { id: "p2" }],
      }),
      upload,
    );
    expect(upload).toHaveBeenCalledWith("p1", "file:///receipt.jpg");
    expect(out.photo).toBe("uploaded");
    expect(out.message).toBe("This payment was recorded.");
  });

  it("found, invoice scope: the photo goes to createdPaymentId", async () => {
    const { holder } = unknownScreen();
    rememberPaymentProof(SCOPE, "file:///receipt.jpg");
    const upload = jest.fn().mockResolvedValue(undefined);
    await checkPaymentStatus(
      holder,
      SCOPE,
      async () => ({ scope: "INVOICE_PAYMENT", id: "inv", createdPaymentId: "p9", payments: [] }),
      upload,
    );
    expect(upload).toHaveBeenCalledWith("p9", "file:///receipt.jpg");
  });

  it("found, no derivable payment id: the fixed 'add the photo from the payment' copy, no upload", async () => {
    const { holder } = unknownScreen();
    rememberPaymentProof(SCOPE, "file:///receipt.jpg");
    const upload = jest.fn();
    const out = await checkPaymentStatus(
      holder,
      SCOPE,
      async () => ({ scope: "STANDALONE_PAYMENT", paymentGroupId: "g1", payments: [] }),
      upload,
    );
    expect(upload).not.toHaveBeenCalled();
    expect(out.photo).toBe("later");
    expect(out.message).toBe("The payment was recorded. Add the photo from the payment.");
  });

  it("found, the upload fails: the existing fixed failure copy, the payment still counts as recorded", async () => {
    const { holder } = unknownScreen();
    rememberPaymentProof(SCOPE, "file:///receipt.jpg");
    const out = await checkPaymentStatus(
      holder,
      SCOPE,
      async () => ({ paymentGroupId: "g1", payments: [{ id: "p1" }] }),
      jest.fn().mockRejectedValue(new Error("boom")),
    );
    expect(out.outcome.kind).toBe("found");
    expect(out.photo).toBe("failed");
    expect(out.message).toBe("Payment recorded, but the photo failed to upload.");
    expect(holder.hasUnknown()).toBe(false);
  });

  it("found without a photo: no upload, the plain recorded copy", async () => {
    const { holder } = unknownScreen();
    const upload = jest.fn();
    const out = await checkPaymentStatus(
      holder,
      SCOPE,
      async () => ({ paymentGroupId: "g1", payments: [{ id: "p1" }] }),
      upload,
    );
    expect(upload).not.toHaveBeenCalled();
    expect(out.photo).toBe("none");
    expect(out.message).toBe("This payment was recorded.");
  });

  it("the action label", () => {
    expect(PAYMENT_STATUS_COPY.action).toBe("Check payment status");
  });
});
