"use client";

// B1264: "Find by order or invoice number" at the top of New Return. The receipt number is what the person holds, and it
// reaches a past-day walk-in counter sale the customer list never offers. Reads only: the orders list search (order
// number) and the invoices list search (invoice number), both already used by the web; an exact number match is the sale.
import * as React from "react";
import { Button } from "@routeflow/ui/web";
import { useOrder, useOrders, type Order } from "@/lib/api/orders";
import { useInvoices } from "@/lib/api/invoices";

const INVOICE_PREFIX = /^inv/i;

export function FindSaleByNumber({ onFound }: { onFound: (order: Order) => void }) {
  const [value, setValue] = React.useState("");
  const [term, setTerm] = React.useState("");
  const byInvoice = INVOICE_PREFIX.test(term);
  const { data: ordersData } = useOrders(
    term && !byInvoice ? { search: term, limit: 10 } : undefined,
    { enabled: !!term && !byInvoice },
  );
  const { data: invoicesData } = useInvoices(
    term && byInvoice ? { search: term, limit: 10 } : undefined,
    { enabled: !!term && byInvoice },
  );
  const same = (a?: string | null) => (a ?? "").trim().toLowerCase() === term.toLowerCase();
  const orderHit = byInvoice
    ? undefined
    : ((ordersData as { data?: Order[] } | undefined)?.data ?? []).find((o) => same(o.orderNumber));
  const invoiceHit = byInvoice
    ? (
        (
          invoicesData as
            { data?: Array<{ invoiceNumber?: string; orderId?: string | null }> } | undefined
        )?.data ?? []
      ).find((i) => same(i.invoiceNumber))
    : undefined;
  const orderId = orderHit?.id ?? invoiceHit?.orderId ?? "";
  const { data: order } = useOrder(orderId);
  const loaded = byInvoice ? invoicesData !== undefined : ordersData !== undefined;
  const missing = !!term && loaded && !orderId;

  const reported = React.useRef("");
  React.useEffect(() => {
    if (!term) {
      reported.current = "";
      return;
    }
    if (order && reported.current !== `${term}|${order.id}`) {
      reported.current = `${term}|${order.id}`;
      onFound(order);
    }
  }, [order, term, onFound]);

  return (
    <div>
      <label htmlFor="find-sale-number" className="mb-1.5 block text-sm font-medium text-navy">
        Find by order or invoice number
      </label>
      <div className="flex gap-2">
        <input
          id="find-sale-number"
          type="search"
          placeholder="ORD-… or INV-…"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (!e.target.value.trim()) setTerm("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              setTerm(value.trim());
            }
          }}
          className="h-10 min-w-0 flex-1 rounded-lg border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <Button type="button" variant="secondary" onClick={() => setTerm(value.trim())}>
          Find
        </Button>
      </div>
      {missing ? (
        <p className="mt-1 text-xs text-danger" role="status">
          No sale found for {term}.
        </p>
      ) : null}
    </div>
  );
}
