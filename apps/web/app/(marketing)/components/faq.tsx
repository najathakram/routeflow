"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";

// Words: COPY.md 2i (W6). Two hardcoded Q&A sets, selected via the `retail` prop. Re-implemented on
// native `<details>/<summary>` (ux-spec.md §4) instead of the shadcn
// `Accordion` the redesign used (no `@radix-ui/react-accordion` in this
// repo's dependency set — standing rules), with a controlled `openIndex` so
// only the most recently opened item stays expanded.

const GENERAL: Array<[string, string]> = [
  [
    "Who is RouteFlow for?",
    "RouteFlow is for wholesale businesses that take orders and deliver them. Their customers can order in the retailer portal.",
  ],
  [
    "Can retailers order through RouteFlow?",
    "Yes. Retailers see catalogs and place orders in the retailer portal, and it’s free for them. Each supplier has to add them first.",
  ],
  [
    "What does my team use it on?",
    "Your office and retailers use a web browser, on a phone or computer. There’s nothing to install. Drivers sign in on their phones.",
  ],
  [
    "Does RouteFlow work with QuickBooks?",
    "Not directly: RouteFlow doesn’t connect to QuickBooks, Xero, or Zoho. You can import customers, products, invoices, payments, expenses, and stock from CSV files. You can export invoices as CSV files.",
  ],
  // Held for W4 (COPY.md 2i row 5, the trial-end answer): until then the fifth question stays,
  // with "demo" changed to "video call" (COPY.md section 8). The answer is unchanged.
  [
    "What will we cover on a video call?",
    "Start with your ordering and delivery process. Ask to see order intake, route planning, delivery confirmation, and customer records, then discuss the plan and setup that fit your team.",
  ],
];

const RETAILER: Array<[string, string]> = [
  [
    "Do I need a supplier connection?",
    "Yes. Your supplier decides the catalogs, prices, and ordering options you see. Ask your supplier how to connect.",
  ],
  [
    "How do I pay an invoice?",
    "Pay by card in the portal if your supplier turns it on. If not, ask your supplier how to pay.",
  ],
  [
    "Can I use the portal on my phone?",
    "Yes. The retailer portal works in the web browser on your phone, with nothing to install.",
  ],
  [
    "Who handles my order or delivery questions?",
    "Ask the supplier sending your order about products, delivery, returns, or payment.",
  ],
  [
    "Will this create a new distributor account?",
    "No. Use the retailer sign-up link to create a retailer account. Distributors sign up on a different page.",
  ],
];

export function FAQ({ retail = false }: { retail?: boolean } = {}) {
  const items = retail ? RETAILER : GENERAL;
  const [openIndex, setOpenIndex] = React.useState<number | null>(null);

  return (
    // id="faq" is where /faq, /integrations and /quickbooks land (they redirect to /#faq).
    <section className="section faq-section wrap" id="faq">
      <div>
        <h2>Questions before you start.</h2>
        <p>Have another question?</p>
        <Link className="text-link" href="/contact">
          Contact us
        </Link>
      </div>
      <div className="faq-list">
        {items.map(([question, answer], i) => (
          <details
            key={question}
            data-slot="accordion-item"
            open={openIndex === i}
            onToggle={(event) => {
              if (event.currentTarget.open) setOpenIndex(i);
            }}
          >
            <summary data-slot="accordion-trigger">
              {question}
              <ChevronDown size={18} aria-hidden="true" />
            </summary>
            <div data-slot="accordion-content">
              <div>{answer}</div>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
