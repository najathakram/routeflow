import * as fs from "fs";
import { rawMessageReads } from "./raw-message-scan";
import * as path from "path";
import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";

/**
 * B986-7 (orders + customers): the surfaces below render fixed copy chosen by code/status and say what to try for an
 * uncoded refusal; none reads the server message. The mutation surfaces that toast or banner themselves opt out of the
 * global toast so a failure shows once.
 */
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
const D = "app/(dashboard)";

describe("no raw server message on the orders + customers surfaces", () => {
  it.each([
    `${D}/orders/[id]/page.tsx`,
    `${D}/orders/_components/CreateOrderModal.tsx`,
    `${D}/orders/_components/CreditNotePicker.tsx`,
    `${D}/orders/_components/LicenseGuardModal.tsx`,
    `${D}/orders/_components/SplitInvoiceModal.tsx`,
    `${D}/customers/[id]/StandingOrderModal.tsx`,
    "lib/api/credit-limit.ts",
    "lib/api/selling-restricted.ts",
  ])("%s", (f) => {
    expect(rawMessageReads(read(f))).toEqual([]);
  });

  it("each surface passes its OWN actionable sentence for an uncoded refusal", () => {
    const want: Record<string, RegExp[]> = {
      [`${D}/orders/[id]/page.tsx`]: [
        /couldn't be marked as sent/,
        /email couldn't be sent/,
        /can't be cancelled right now/,
        /can't be deleted in its current state/,
        /fulfillment path couldn't be changed/,
      ],
      [`${D}/orders/_components/CreateOrderModal.tsx`]: [/order couldn't be created/],
      [`${D}/orders/_components/CreditNotePicker.tsx`]: [/credit note couldn't be created/],
      [`${D}/orders/_components/LicenseGuardModal.tsx`]: [
        /license couldn't be saved/,
        /override couldn't be recorded/,
      ],
      [`${D}/orders/_components/SplitInvoiceModal.tsx`]: [/invoice couldn't be created/],
      [`${D}/customers/[id]/StandingOrderModal.tsx`]: [/standing order couldn't be saved/],
    };
    for (const [f, res] of Object.entries(want)) for (const re of res) expect(read(f)).toMatch(re);
  });

  it("the surfaces that render their own error opt out of the global toast (a failure shows once)", () => {
    const opt = "{ localErrorToast: true }";
    const page = read(`${D}/orders/[id]/page.tsx`);
    for (const h of ["useSendInvoice", "useSendInvoiceEmail", "usePatchOrderFulfillPath"])
      expect(page).toContain(`${h}(${opt})`);
    expect(read(`${D}/orders/_components/CreateOrderModal.tsx`)).toContain(
      `useCreateOrder(${opt})`,
    );
    expect(read(`${D}/orders/_components/CreditNotePicker.tsx`)).toContain(
      `useCreateCreditNote(${opt})`,
    );
    expect(read(`${D}/orders/_components/SplitInvoiceModal.tsx`)).toContain(
      `useCreatePartialInvoiceFromOrder(${opt})`,
    );
    const so = read(`${D}/customers/[id]/StandingOrderModal.tsx`);
    expect(so).toContain(`useCreateOrderTemplate(${opt})`);
    expect(so).toContain(`useUpdateOrderTemplate(${opt})`);
  });
});

describe("the hooks carry meta.localErrorToast only when asked", () => {
  jest.mock("@/lib/api-client", () => {
    const fail = () => jest.fn().mockRejectedValue(new Error("x"));
    return {
      __esModule: true,
      default: { post: fail(), patch: fail() },
      apiClient: { post: fail(), patch: fail() },
    };
  });
  const metaOf = async (make: () => { mutate: (v: any, o?: any) => void }) => {
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(make, { wrapper });
    await act(async () => {
      result.current.mutate({ id: "1", fulfillPath: "ROUTE" }, { onError: () => undefined });
    });
    return qc.getMutationCache().getAll()[0]?.meta;
  };
  it("all eight", async () => {
    const inv = await import("./api/invoices");
    const ord = await import("./api/orders");
    const tpl = await import("./api/order-templates");
    const cn = await import("./api/credit-notes");
    const on = { localErrorToast: true };
    const o = { localErrorToast: true } as const;
    expect(await metaOf(() => inv.useSendInvoice(o))).toEqual(on);
    expect(await metaOf(() => inv.useSendInvoiceEmail(o))).toEqual(on);
    expect(await metaOf(() => inv.useCreatePartialInvoiceFromOrder(o))).toEqual(on);
    expect(await metaOf(() => ord.useCreateOrder(o))).toEqual(on);
    expect(await metaOf(() => ord.usePatchOrderFulfillPath(o))).toEqual(on);
    expect(await metaOf(() => tpl.useCreateOrderTemplate(o))).toEqual(on);
    expect(await metaOf(() => tpl.useUpdateOrderTemplate(o))).toEqual(on);
    expect(await metaOf(() => cn.useCreateCreditNote(o))).toEqual(on);
    expect(await metaOf(() => ord.useCreateOrder())).toBeUndefined();
  });
});
