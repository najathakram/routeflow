import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check, Warehouse, Store } from "lucide-react";
import type { ReactNode } from "react";
import { authLinks } from "./auth-links";

// Shared static/presentational building blocks used across the marketing
// pages (M1 §10). Copy is verbatim from the redesign's components/marketing.tsx.

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="eyebrow">
      <span />
      {children}
    </p>
  );
}

export function CheckList({ items }: { items: string[] }) {
  return (
    <ul className="check-list">
      {items.map((item) => (
        <li key={item}>
          <Check size={18} />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export function CTA({ retailer = false }: { retailer?: boolean } = {}) {
  return (
    <section className={"cta-block wrap " + (retailer ? "cta-retailer" : "")}>
      <div>
        <Eyebrow>{retailer ? "FOR YOUR NEXT RESTOCK" : "LET’S TALK ABOUT YOUR WORKFLOW"}</Eyebrow>
        <h2>
          {retailer ? (
            <>
              Place your next order <br />
              with a clearer view.
            </>
          ) : (
            <>
              Put your workflow <br />
              to the test.
            </>
          )}
        </h2>
        <p>
          {retailer
            ? "Use the web portal to order from your connected suppliers."
            : "Bring one example of how an order moves through your business. See where RouteFlow can connect the handoffs."}
        </p>
      </div>
      <div>
        <Link
          className="button button-white"
          href={retailer ? authLinks.retailerSignUp : "/book-a-demo"}
        >
          {retailer ? "Create a retailer account" : "Book a workflow demo"}
          <ArrowUpRight size={19} />
        </Link>
        <span>
          {retailer
            ? "Continue to the existing retailer portal"
            : "Review your workflow, pricing, and setup before you decide."}
        </span>
      </div>
    </section>
  );
}

export function AudienceCards() {
  return (
    <section className="section wrap">
      <div className="section-heading">
        <Eyebrow>TWO SIDES OF THE SAME DELIVERY</Eyebrow>
        <h2>
          Better connected,
          <br />
          from warehouse to store.
        </h2>
      </div>
      <div className="audience-grid">
        <article className="audience-card distributors">
          {/* Plain <img>, not next/image (ruling B1); below the fold, so lazy.
              Reuses public/marketing/warehouse.webp — no new binary (owner
              layout ruling, 2026-09-16, PR-3: audience cards get photos,
              matching the design study's own audience cards). */}
          {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
          <img
            src="/marketing/warehouse.webp"
            alt="Two warehouse workers carrying stock through an aisle."
            width={1400}
            height={933}
            loading="lazy"
            decoding="async"
          />
          <div>
            <Warehouse size={28} />
            <span className="card-eyebrow">FOR DISTRIBUTORS</span>
            <h3>
              Give your team
              <br />a shared plan.
            </h3>
            <p>
              Manage orders, prepare routes, and follow each delivery with the customer record close
              at hand.
            </p>
            <Link className="text-link" href="/wholesalers">
              Explore RouteFlow for distributors <ArrowRight size={18} />
            </Link>
          </div>
        </article>
        <article className="audience-card retailers">
          {/* Reuses public/marketing/retailer-technology.webp — no new binary. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
          <img
            src="/marketing/retailer-technology.webp"
            alt="Conceptual retailer web ordering on a phone, connected to a storefront and delivery cartons."
            width={1448}
            height={1086}
            loading="lazy"
            decoding="async"
          />
          <div>
            <Store size={28} />
            <span className="card-eyebrow">FOR RETAILERS</span>
            <h3>
              Restock with less
              <br />
              back and forth.
            </h3>
            <p>
              Browse your suppliers’ catalogs, place orders, and find your purchase history in the
              retailer portal.
            </p>
            <Link className="text-link" href="/retailers">
              Explore RouteFlow for retailers <ArrowRight size={18} />
            </Link>
          </div>
        </article>
      </div>
    </section>
  );
}
