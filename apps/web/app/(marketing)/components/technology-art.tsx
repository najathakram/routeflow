import Link from "next/link";
import { Check, Globe, Package, ArrowUpRight } from "lucide-react";
import { authLinks } from "./auth-links";

// `RetailerArt` and `RetailerDetail` only — `NetworkArt`/`ProductCinema` are
// not imported by any live route (M1 §11) and are not ported. Copy verbatim
// from the redesign's components/technology-art.tsx (M1 §2c).

export function RetailerArt() {
  return (
    <figure className="retailer-art">
      {/* Plain <img>, not next/image: no `images` config under
          `output: "standalone"` (ruling B1). Above the fold on /retailers, so
          it stays eagerly loaded (the former `priority`). */}
      {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
      <img
        src="/marketing/retailer-technology.webp"
        alt="Conceptual retailer web ordering on a phone, connected to a storefront and delivery cartons."
        width={1448}
        height={1086}
        decoding="async"
      />
      <div className="art-chip browser-chip">
        <Globe size={17} />
        <span>YOUR SUPPLIERS. ONE PORTAL.</span>
      </div>
      <div className="art-chip order-chip">
        <span className="order-chip-check">
          <Check size={18} />
        </span>
        <div>
          <strong>A clearer next restock.</strong>
          <small>Catalogs, orders, and history.</small>
        </div>
      </div>
      <figcaption>Conceptual product illustration · Web portal available</figcaption>
    </figure>
  );
}

export function RetailerDetail() {
  return (
    <section className="retailer-detail-section wrap">
      <div>
        <p className="eyebrow">
          <span />
          THE DETAILS BEHIND THE ORDER
        </p>
        <h2>
          Know what you ordered.
          <br />
          Find it when you need it.
        </h2>
        <p>
          Keep purchases with their supplier context, so you can refer back to your last restock.
        </p>
        <Link className="text-link" href={authLinks.retailerSignUp}>
          Explore the retailer portal <ArrowUpRight size={18} />
        </Link>
      </div>
      <div className="retailer-detail-card">
        <div className="record-caption">
          SAMPLE ORDER <Package size={21} />
        </div>
        <h3>Parkside Market</h3>
        <p>From your connected distributor</p>
        <div className="record-rows">
          <div>
            <span>Spring water · 2 cases</span>
            <strong>$48.00</strong>
          </div>
          <div>
            <span>Sparkling water · 2 cases</span>
            <strong>$36.00</strong>
          </div>
          <div>
            <span>Mixed snacks · 1 case</span>
            <strong>$30.00</strong>
          </div>
        </div>
        <div className="cart-total">
          <span>Sample subtotal</span>
          <strong>$114.00</strong>
        </div>
        <p className="sample-note">Illustrative products and prices.</p>
      </div>
    </section>
  );
}
