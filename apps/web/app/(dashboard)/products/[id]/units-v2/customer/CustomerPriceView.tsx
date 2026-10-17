"use client";

import * as React from "react";
import type {
  CustomerProductUnitPricesDto,
  CustomerUnitPriceRowDto,
  CustomerUnitPriceSource,
} from "@routeflow/types";
import { useTierLabels } from "@/lib/api/tier-labels";
import { useCustomerUnitPrices } from "@/lib/api/useCustomerUnitPrices";
import { formatMoney } from "@/lib/format";
import { productTierLabel } from "@/lib/tier-one-label";
import { CUSTOMER_VIEW_TESTIDS as T } from "./customer-testids";
import { CustomerPicker } from "./CustomerPicker";

/**
 * Units v2 Customer view (K6, S20-read + S22; UX-V5 V10, V11). READ ONLY: what one customer pays for each unit,
 * straight from GET /customers/:id/unit-prices (the server resolves every price; nothing is computed here).
 *
 * Two homes, one component:
 *  - `customerId` given (the customer page): that customer, every product they have something specific for.
 *  - `productId` only (the product page): starts on no one (V10), the owner finds ANY customer by name, and sees that
 *    product's units priced for them. The last choice is remembered for the session.
 * Editing a customer's price is not here; it comes through the product page's customer opt-in.
 */

const PAGE_SIZE = 10;

/** V10: "Remember the last choice for the session". Module scope: lives for the SPA session, gone on reload. */
let lastChoice: { id: string; name: string } | null = null;

/** Forget the remembered customer (tests; a sign-out could call it too). */
export function resetCustomerViewMemory() {
  lastChoice = null;
}

/**
 * P18: how the tier reads in a price caption. A tenant's own label is printed verbatim, whatever it says
 * (even "Tier A"). Only when there is NO custom label do we add " tier" to the app's default name, so a
 * numbered default ("Tier 3") is never doubled to "Tier 3 tier" and the base price reads "Retail tier".
 */
function captionTierName(labels: Record<string, string> | null | undefined, tier: number): string {
  const name = productTierLabel(labels, tier);
  if (labels?.[String(tier)]?.trim()) return name;
  return tier === 1 ? `${name} tier` : name;
}

function SourceCaption({
  source,
  tierCaption,
  orderUnitLabel,
}: {
  source: CustomerUnitPriceSource;
  tierCaption: string;
  orderUnitLabel: string;
}) {
  if (source === "customer") return <span>Set for this customer</span>;
  const why =
    source === "customer-shape"
      ? `From their ${orderUnitLabel} price`
      : source === "history"
        ? `${tierCaption} · History`
        : tierCaption;
  // P06: one "Auto" pill and a caption; the word is never repeated in the caption.
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="rounded-full bg-navy/10 px-1.5 py-0.5 text-[11px] font-medium text-navy">
        Auto
      </span>
      <span>{why}</span>
    </span>
  );
}

function PriceCell({ row }: { row: CustomerUnitPriceRowDto }) {
  return <span className="font-medium tabular-nums text-navy">{formatMoney(row.price)}</span>;
}

function ProductBlock({
  entry,
  tierName,
  tierCaption,
  listName,
  showName,
}: {
  entry: CustomerProductUnitPricesDto;
  tierName: string;
  /** The tier as the caption under each price reads (see captionTierName). */
  tierCaption: string;
  /** The tenant's name for tier 1 (the list price column). */
  listName: string;
  showName: boolean;
}) {
  // A tier 1 customer pays the list price: a second column under the same name would print it twice.
  const showTierColumn = entry.tier !== 1;
  const own = entry.orderUnitScope === "customer";
  const rows = entry.rows;
  return (
    <article
      data-testid={T.product(entry.productId)}
      className="min-w-0 self-start rounded-lg border border-surface-border p-4"
    >
      {showName ? <h3 className="text-sm font-semibold text-navy">{entry.productName}</h3> : null}
      <p data-testid={T.ordersIn(entry.productId)} className="mt-1 text-sm text-navy/80">
        {own
          ? `Orders in ${entry.orderUnitLabel}.`
          : `Orders in ${entry.orderUnitLabel}. The usual unit for this product.`}
      </p>
      <div className="mt-3 overflow-x-auto">
        <table data-testid={T.prices(entry.productId)} className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-navy/60">
              <th scope="col" className="py-1.5 pr-3 align-top font-medium">
                Unit
              </th>
              <th scope="col" className="py-1.5 pr-3 align-top font-medium">
                Price
              </th>
              <th scope="col" className="hidden py-1.5 pr-3 align-top font-medium sm:table-cell">
                {listName}
              </th>
              {showTierColumn ? (
                <th scope="col" className="hidden py-1.5 align-top font-medium sm:table-cell">
                  {tierName}
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.ref}
                data-testid={T.row(entry.productId, row.ref)}
                className="border-t border-surface-border"
              >
                <td className="py-2 pr-3 align-top">
                  <div className="text-navy">{row.label}</div>
                  {row.code ? <div className="text-xs text-navy/60">{row.code}</div> : null}
                </td>
                <td className="py-2 pr-3 align-top">
                  <PriceCell row={row} />
                  <div className="mt-0.5 text-xs text-navy/60">
                    <SourceCaption
                      source={row.source}
                      tierCaption={tierCaption}
                      orderUnitLabel={entry.orderUnitLabel}
                    />
                  </div>
                </td>
                <td className="hidden py-2 pr-3 align-top tabular-nums text-navy/70 sm:table-cell">
                  {formatMoney(row.listPrice)}
                </td>
                {showTierColumn ? (
                  <td className="hidden py-2 align-top tabular-nums text-navy/70 sm:table-cell">
                    {formatMoney(row.tierPrice)}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details data-testid={T.where(entry.productId)} className="mt-3 text-sm">
        <summary className="cursor-pointer select-none text-navy/80 [&::-webkit-details-marker]:hidden">
          Where this comes from
        </summary>
        <dl className="mt-2 space-y-1 text-xs text-navy/70">
          <div>
            <dt className="inline font-medium">Unit for orders: </dt>
            <dd className="inline">
              {entry.orderUnitLabel}
              {own ? "" : " (the product's usual unit)"}
            </dd>
          </div>
          <div>
            <dt className="inline font-medium">Price tier: </dt>
            <dd className="inline">{tierName}</dd>
          </div>
        </dl>
      </details>
    </article>
  );
}

export interface CustomerPriceViewProps {
  /** Fixed customer (the customer page). Omit to let the owner pick one (the product page). */
  customerId?: string | null;
  /** Narrow to one product (the product page). */
  productId?: string;
}

export function CustomerPriceView({ customerId, productId }: CustomerPriceViewProps) {
  const fixed = customerId ?? null;
  const [picked, setPicked] = React.useState<{ id: string; name: string } | null>(
    fixed ? null : lastChoice,
  );
  const [page, setPage] = React.useState(1);
  const activeId = fixed ?? picked?.id ?? null;
  const q = useCustomerUnitPrices(activeId, productId, { page, limit: PAGE_SIZE });
  const labels = useTierLabels().data;

  const choose = (c: { id: string; name: string } | null) => {
    lastChoice = c;
    setPicked(c);
    setPage(1);
  };

  const res = q.data;
  const customerName = res?.customerName ?? picked?.name ?? "";
  const tierName = res ? productTierLabel(labels, res.tier) : "";

  return (
    <section data-testid={T.section} aria-labelledby="h-cust" className="space-y-3">
      <h2
        id="h-cust"
        data-testid={T.heading}
        tabIndex={-1}
        className="text-base font-semibold text-navy"
      >
        {fixed ? "Unit prices" : "Customer view"}
      </h2>

      {fixed ? null : activeId ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span data-testid={T.chosen} className="font-medium text-navy">
            {customerName}
          </span>
          <button
            type="button"
            data-testid={T.change}
            onClick={() => choose(null)}
            aria-label={`Change customer, now ${customerName}`}
            className="text-sm text-brand-600 underline"
          >
            Choose another customer
          </button>
        </div>
      ) : (
        <>
          <CustomerPicker onPick={choose} />
          <p data-testid={T.empty} className="text-sm text-navy/70">
            Choose a customer to see their units and prices.
          </p>
        </>
      )}

      {activeId ? (
        q.isLoading ? (
          <p className="text-sm text-navy/60">Loading prices...</p>
        ) : q.isError || !res ? (
          <p role="alert" className="text-sm text-red-600">
            Could not load this customer&apos;s prices.
          </p>
        ) : (
          <div data-testid={T.body} className="space-y-4">
            <p data-testid={T.blurb} className="text-sm text-navy/70">
              {customerName} pays {tierName} prices unless a price is set for them. Active
              promotions are not included.
            </p>
            {res.products.length === 0 ? (
              <p className="text-sm text-navy/70">
                {customerName} has no prices of their own yet. They pay {tierName} prices on every
                product.
              </p>
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                {res.products.map((entry) => (
                  <ProductBlock
                    key={entry.productId}
                    entry={entry}
                    tierName={productTierLabel(labels, entry.tier)}
                    tierCaption={captionTierName(labels, entry.tier)}
                    listName={productTierLabel(labels, 1)}
                    showName={!productId}
                  />
                ))}
              </div>
            )}
            {res.total > res.limit ? (
              <nav aria-label="Pages" className="flex items-center gap-3 text-sm">
                <button
                  type="button"
                  data-testid={T.prev}
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="rounded-md border border-surface-border px-3 py-1.5 disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="text-navy/70">
                  Page {res.page} of {Math.ceil(res.total / res.limit)}
                </span>
                <button
                  type="button"
                  data-testid={T.next}
                  disabled={page * res.limit >= res.total}
                  onClick={() => setPage((p) => p + 1)}
                  className="rounded-md border border-surface-border px-3 py-1.5 disabled:opacity-40"
                >
                  Next
                </button>
              </nav>
            ) : null}
          </div>
        )
      ) : null}
    </section>
  );
}
