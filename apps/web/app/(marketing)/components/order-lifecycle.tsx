import {
  Boxes,
  Tags,
  Repeat2,
  Route,
  Camera,
  RotateCcw,
  ReceiptText,
  HandCoins,
} from "lucide-react";
import { Eyebrow } from "./marketing";
import { ScreenshotPlaceholder } from "./screenshot-placeholder";

// Wholesalers-only content — deliberately does NOT reuse `FeatureCatalog`'s
// capability grid or `FAQ` from the product page (owner ruling 2026-09-17):
// this page argues the operational case through one order's real path
// through the system, not a generic feature grid. Every claim here is
// checked against `apps/api` behavior, not aspirational.

const STEPS: Array<[string, string]> = [
  [
    "Intake",
    "An order comes in however your customer gives it to you — a call your staff keys in, a standing order that repeats itself, or the customer placing it directly through their own buyer portal. Whichever way it starts, it lands as one order record.",
  ],
  [
    "Pricing",
    "The order prices itself against that customer's tier and any per-product overrides you've set — the same pricing engine whether the order was typed by hand or generated from a standing order.",
  ],
  [
    "Route",
    "The order joins the day's route. Stop order is optimized for time or distance and checked against real delivery windows, and re-optimizes if something changes mid-route.",
  ],
  [
    "Proof of delivery",
    "The driver captures a signature and photos at the stop, and records exactly what was delivered — including a short-pick or refusal — not just what was on the original order.",
  ],
  [
    "Invoice",
    "The invoice is generated from what was actually delivered, not just what was ordered. A short-pick or partial delivery adjusts the bill automatically.",
  ],
  [
    "Payment",
    "Collected at the door in cash or check, or settled with the office. A driver's end-of-run settlement checks what they collected against what the system expected, with variance flagged rather than assumed.",
  ],
];

export function OrderLifecycle() {
  return (
    <section className="section wrap getting-started order-lifecycle">
      <div>
        <Eyebrow>ONE ORDER, START TO FINISH</Eyebrow>
        <h2>
          Follow an order
          <br />
          through the system.
        </h2>
        <p>
          Every one of these steps is the same order record — nothing gets re-typed or re-priced
          between the phone call and the invoice.
        </p>
        <ScreenshotPlaceholder label="Order builder — a real order being priced" />
      </div>
      <ol>
        {STEPS.map(([title, text], i) => (
          <li key={title}>
            <span>0{i + 1}</span>
            <div>
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

const CAPABILITIES = [
  {
    icon: Boxes,
    name: "Boxed pricing, real units",
    text: "Sell by the box or the piece — RouteFlow tracks and converts both, so a partial-box order doesn't get charged a full-box rate by accident.",
    tag: "PRICE IT RIGHT",
  },
  {
    icon: Tags,
    name: "Customer-tier pricing",
    text: "Set a pricing tier per customer and override individual product prices for individual accounts — your agreed rate applies automatically, every time.",
    tag: "HONOR THE DEAL YOU MADE",
  },
  {
    icon: Repeat2,
    name: "Standing orders that re-price",
    text: "A weekly standing order runs through the same tiered pricing as an order your staff types by hand, so a price change actually reaches your repeat customers.",
    tag: "REPEAT BUSINESS, CURRENT PRICES",
  },
  {
    icon: Route,
    name: "Window-aware routing",
    text: "Routes are optimized for time or distance and checked against each stop's delivery window — not just a straight line on a map.",
    tag: "GET THERE ON TIME",
  },
  {
    icon: Camera,
    name: "Proof of delivery",
    text: "A signature, photos, and a record of what was actually delivered versus what was ordered — for every stop.",
    tag: "SETTLE DISPUTES WITH EVIDENCE",
  },
  {
    icon: RotateCcw,
    name: "Returns at the stop",
    text: "Your driver can log a return right at the delivery — what came back, why, whether it restocks — without a follow-up call to the office.",
    tag: "NO PHONE TAG ON RETURNS",
  },
  {
    icon: ReceiptText,
    name: "Bills what was delivered",
    text: "A short-pick, a refusal, or a partial delivery adjusts the invoice automatically — you never manually re-key a smaller total.",
    tag: "INVOICE MATCHES REALITY",
  },
  {
    icon: HandCoins,
    name: "Driver settlement",
    text: "Cash and check collected at the door are recorded against the invoice on the spot, and checked against what the system expected the driver to collect at end of run.",
    tag: "AN ACTUAL AUDIT TRAIL",
  },
];

export function WholesalerCapabilities() {
  return (
    <div className="capability-catalog wholesaler-capabilities" id="wholesaler-capabilities">
      <div className="capability-grid">
        {CAPABILITIES.map((f) => (
          <article key={f.name} className="capability-card">
            <f.icon size={27} />
            <span>{f.tag}</span>
            <h3>{f.name}</h3>
            <p>{f.text}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
