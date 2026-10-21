"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { isSpecialTier } from "@routeflow/pricing";
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

/**
 * K11-06: the picked customer lives in the URL (`?customer=<id>`, the id only, never the name) on the product page,
 * so a refresh or a shared link comes back to the same customer. Product-page mode only: the customer page (a fixed
 * customerId) never reads or writes it. Reading goes through `useSearchParams`; writing is a plain
 * `history.replaceState` (no router needed: Next syncs `useSearchParams` from it, adds no history entry, and the
 * path, the other params and the hash are kept).
 */
function useCustomerParam(enabled: boolean) {
  const searchParams = useSearchParams();
  const fromUrl = enabled ? searchParams?.get("customer") || null : null;
  const write = (id: string | null) => {
    if (!enabled || typeof window === "undefined") return;
    const { pathname, search, hash } = window.location;
    const params = new URLSearchParams(search);
    if (id) params.set("customer", id);
    else params.delete("customer");
    const qs = params.toString();
    window.history.replaceState(null, "", `${pathname}${qs ? `?${qs}` : ""}${hash}`);
  };
  return { fromUrl, write };
}

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

/**
 * K11-07: what the tier would charge, in the caption of a row whose price is NOT the tier price. This replaces the
 * old tier column (which repeated the Price figure on every tier-priced row), so no information is lost. Hidden
 * below sm, where the table shows the price alone.
 */
function TierFigure({ tierName, tierPrice }: { tierName: string; tierPrice: number | null }) {
  if (tierPrice === null) return null;
  return (
    <span className="hidden sm:inline">
      {" "}
      · {tierName}: <span className="font-normal tabular-nums">{formatMoney(tierPrice)}</span>
    </span>
  );
}

function SourceCaption({
  source,
  tierCaption,
  tierName,
  tierPrice,
  orderUnitLabel,
}: {
  source: CustomerUnitPriceSource;
  tierCaption: string;
  tierName: string;
  /** The tier's own price for this unit, only on a row that is not priced by the tier; otherwise null. */
  tierPrice: number | null;
  orderUnitLabel: string;
}) {
  if (source === "customer") {
    return (
      <span>
        Set for this customer
        <TierFigure tierName={tierName} tierPrice={tierPrice} />
      </span>
    );
  }
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
      <span>
        {why}
        <TierFigure tierName={tierName} tierPrice={tierPrice} />
      </span>
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
  single,
}: {
  entry: CustomerProductUnitPricesDto;
  tierName: string;
  /** The tier as the caption under each price reads (see captionTierName). */
  tierCaption: string;
  /** The tenant's name for tier 1 (the list price column). */
  listName: string;
  showName: boolean;
  /** One product (the product page): the card fills its column instead of sitting in half a row. */
  single: boolean;
}) {
  // A tier 1 customer pays the list price, which the Retail column already shows: no tier figure to add.
  const hasTierFigure = isSpecialTier(entry.tier);
  const own = entry.orderUnitScope === "customer";
  const rows = entry.rows;
  return (
    <article
      data-testid={T.product(entry.productId)}
      className={`min-w-0 rounded-lg border border-surface-border p-4 ${single ? "" : "self-start"}`}
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
                      tierName={tierName}
                      tierPrice={
                        hasTierFigure &&
                        (row.source === "customer" ||
                          row.source === "customer-shape" ||
                          row.source === "history")
                          ? row.tierPrice
                          : null
                      }
                      orderUnitLabel={entry.orderUnitLabel}
                    />
                  </div>
                </td>
                <td className="hidden py-2 pr-3 align-top font-normal tabular-nums text-navy/70 sm:table-cell">
                  {formatMoney(row.listPrice)}
                </td>
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
  const url = useCustomerParam(!fixed);
  const [picked, setPicked] = React.useState<{ id: string; name: string } | null>(
    fixed ? null : url.fromUrl ? { id: url.fromUrl, name: "" } : lastChoice,
  );
  const [page, setPage] = React.useState(1);
  const activeId = fixed ?? picked?.id ?? null;
  const q = useCustomerUnitPrices(activeId, productId, { page, limit: PAGE_SIZE });
  const labels = useTierLabels().data;

  // K14 F12: after a pick the picker unmounts and focus would drop to the page top. Hand it to the chosen-customer line
  // (only for a pick, never for a customer restored from the URL or the session).
  const chosenRef = React.useRef<HTMLSpanElement>(null);
  const focusChosen = React.useRef(false);
  React.useEffect(() => {
    if (!focusChosen.current || !chosenRef.current) return;
    focusChosen.current = false;
    chosenRef.current.focus();
  });
  // K14 F09: after Choose another customer the picker is new; focus its search so typing continues.
  const focusSearch = React.useRef(false);
  React.useEffect(() => {
    if (!focusSearch.current) return;
    const el = document.getElementById("units-v2-cust-search");
    if (!el) return;
    focusSearch.current = false;
    el.focus();
  });

  const choose = (c: { id: string; name: string } | null) => {
    focusChosen.current = c !== null;
    focusSearch.current = c === null;
    lastChoice = c;
    setPicked(c);
    setPage(1);
    url.write(c?.id ?? null);
  };

  // K11-06: an id the server refuses (gone, or not this business's) drops out of the URL and the session memory,
  // so a refresh does not loop on it. The error line and the picker stay on screen.
  // Only a 4xx that means "not yours / not there" drops it; a transient failure (5xx, offline) keeps it.
  const failedStatus = (q.error as { response?: { status?: number } } | null | undefined)?.response
    ?.status;
  const refused =
    !fixed && activeId !== null && q.isError && [400, 403, 404].includes(failedStatus ?? 0);
  const dropRefused = React.useRef(url.write);
  dropRefused.current = url.write;
  React.useEffect(() => {
    if (!refused) return;
    if (lastChoice?.id === activeId) lastChoice = null;
    dropRefused.current(null);
  }, [refused, activeId]);

  const res = q.data;
  const customerName = res?.customerName ?? picked?.name ?? "";
  const tierName = res ? productTierLabel(labels, res.tier) : "";

  return (
    <section
      data-testid={T.section}
      aria-labelledby="h-cust"
      // K12 P05: on the product page the section follows a card; 24 px keeps the heading off it.
      className={`space-y-3 ${productId ? "mt-6" : ""}`}
    >
      <h2
        id="h-cust"
        data-testid={T.heading}
        tabIndex={-1}
        className="text-base font-semibold text-navy"
      >
        {fixed ? "Unit prices" : "Customer view"}
      </h2>

      {fixed ? null : activeId && !refused ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {/* A transient failure with no name yet (503, offline): not "loading", so no name span at all. */}
          {customerName || !q.isError ? (
            <span
              ref={chosenRef}
              tabIndex={-1}
              data-testid={T.chosen}
              className="scroll-mt-[var(--jump-offset,0px)] rounded-sm font-medium text-navy focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
            >
              {customerName || "Loading customer\u2026"}
            </span>
          ) : null}
          <button
            type="button"
            data-testid={T.change}
            onClick={() => choose(null)}
            aria-label={customerName ? `Change customer, now ${customerName}` : "Change customer"}
            className="text-sm text-brand-600 underline"
          >
            Choose another customer
          </button>
        </div>
      ) : (
        <>
          <CustomerPicker onPick={choose} />
          {refused ? null : (
            <p data-testid={T.empty} className="text-sm text-navy/70">
              Choose a customer to see their units and prices.
            </p>
          )}
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
              <div className={`grid gap-4 ${productId ? "" : "lg:grid-cols-2"}`}>
                {res.products.map((entry) => (
                  <ProductBlock
                    key={entry.productId}
                    entry={entry}
                    tierName={productTierLabel(labels, entry.tier)}
                    tierCaption={captionTierName(labels, entry.tier)}
                    listName={productTierLabel(labels, 1)}
                    showName={!productId}
                    single={Boolean(productId)}
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
