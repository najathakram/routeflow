import type { InvoiceFacts } from "../billing/catchup-claim";

/**
 * A stateful fake of the slice of StripeService the October catch-up touches: invoices (paid / open / draft /
 * uncollectible, an ACH payment `processing`), subscriptions, Checkout sessions, and the ORDERED call log -
 * so a spec asserts the release order (Step 0 .. Step 4), not just that each call happened. No network.
 */
export interface FakeInvoice {
  id: string;
  status: "draft" | "open" | "paid" | "void" | "uncollectible";
  subscription: string | null;
  amountPaid?: number;
  amountDue?: number;
  processing?: boolean;
  attemptCount?: number;
  nextPaymentAttempt?: number | null;
}

export function fakeStripeCatchup(
  seed: {
    invoices?: FakeInvoice[];
    sessions?: Record<string, any>;
    subs?: Record<string, any>;
  } = {},
) {
  const invoices = new Map<string, FakeInvoice>((seed.invoices ?? []).map((i) => [i.id, { ...i }]));
  const sessions: Record<string, any> = { ...(seed.sessions ?? {}) };
  const subs: Record<string, any> = { ...(seed.subs ?? {}) };
  const calls: string[] = [];
  const items: { id: string; invoice: string; metadata: Record<string, string> }[] = [];
  let seq = 0;

  const facts = (i: FakeInvoice | undefined): InvoiceFacts =>
    i
      ? {
          status: i.status,
          amountPaid: i.amountPaid ?? (i.status === "paid" ? (i.amountDue ?? 0) : 0),
          amountDue: i.amountDue ?? 0,
          paymentProcessing: i.processing === true,
          nextPaymentAttempt: i.nextPaymentAttempt ?? null,
          attemptCount: i.attemptCount ?? 0,
          subscriptionId: i.subscription,
        }
      : {
          status: null,
          amountPaid: 0,
          amountDue: 0,
          paymentProcessing: false,
          nextPaymentAttempt: null,
          attemptCount: 0,
          subscriptionId: null,
        };

  const stripe = {
    isConfigured: true,
    invoices,
    sessions,
    subs,
    calls,
    getInvoiceFacts: jest.fn(async (id: string) => {
      calls.push(`getInvoiceFacts:${id}`);
      return facts(invoices.get(id));
    }),
    listInvoiceItems: jest.fn(async (invoiceId: string) =>
      items.filter((i) => i.invoice === invoiceId),
    ),
    listSubscriptionInvoices: jest.fn(async (subId: string) =>
      [...invoices.values()].filter((i) => i.subscription === subId).map((i) => ({ id: i.id })),
    ),
    voidInvoice: jest.fn(async (id: string) => {
      calls.push(`voidInvoice:${id}`);
      const i = invoices.get(id);
      if (!i || i.status !== "open") throw new Error(`invoice ${id} cannot be voided`);
      i.status = "void";
      return { id, status: "void" };
    }),
    deleteDraftInvoice: jest.fn(async (id: string) => {
      calls.push(`deleteDraftInvoice:${id}`);
      const i = invoices.get(id);
      if (!i || i.status !== "draft") throw new Error(`invoice ${id} is not a draft`);
      invoices.delete(id);
      return { id, deleted: true };
    }),
    cancelSubscription: jest.fn(async (id: string, _p?: unknown, _o?: unknown) => {
      calls.push(`cancelSubscription:${id}`);
      if (subs[id]) subs[id] = { ...subs[id], status: "canceled" };
      return { id, status: "canceled" };
    }),
    getCheckoutSession: jest.fn(async (id: string) => {
      calls.push(`getCheckoutSession:${id}`);
      const s = sessions[id];
      if (!s) throw Object.assign(new Error("No such session"), { code: "resource_missing" });
      return s;
    }),
    getSubscription: jest.fn(async (id: string) => {
      const s = subs[id];
      if (!s) throw Object.assign(new Error("No such subscription"), { code: "resource_missing" });
      return s;
    }),
    client: {
      invoices: {
        create: jest.fn(async (params: any, opts?: any) => {
          calls.push("invoices.create");
          const inv: FakeInvoice = {
            id: `in_stub${++seq}`,
            status: "draft",
            subscription: params.subscription ?? null,
            amountDue: 0,
          };
          invoices.set(inv.id, inv);
          (stripe.client.invoices.create as jest.Mock & { lastParams?: unknown }).lastParams = {
            params,
            opts,
          };
          return { id: inv.id, status: "draft" };
        }),
      },
      invoiceItems: {
        create: jest.fn(async (params: any, _opts?: unknown) => {
          calls.push("invoiceItems.create");
          const inv = invoices.get(params.invoice);
          if (inv) inv.amountDue = (inv.amountDue ?? 0) + params.amount;
          const item = {
            id: `ii_${++seq}`,
            invoice: params.invoice,
            metadata: params.metadata ?? {},
          };
          items.push(item);
          return item;
        }),
        list: jest.fn(async ({ invoice }: any) => ({
          data: items.filter((i) => i.invoice === invoice),
        })),
      },
      checkout: {
        sessions: {
          create: jest.fn(async (params: any, opts?: any) => {
            calls.push("sessions.create");
            const id = `cs_catchup${++seq}`;
            sessions[id] = { id, status: "open", metadata: params.metadata, params, opts };
            return { id, url: `https://pay.test/${id}` };
          }),
        },
      },
    },
  };
  return stripe;
}
