import Link from "next/link";
import { BrandMark } from "@/components/brand";
import {
  MessagesSquare,
  Route,
  Phone,
  ArrowRight,
  Check,
  PackageCheck,
  Users,
  FileCheck2,
} from "lucide-react";
import { Eyebrow } from "./marketing";

// Copy verbatim from the redesign's components/conversion-sections.tsx (M1 §1.3, §1.6, §1.8).

export function ProblemSection() {
  const pains = [
    {
      icon: MessagesSquare,
      title: "Orders arrive in messages.",
      text: "Someone has to turn those messages into work the warehouse can use.",
      detail: "Re-entering the same details",
    },
    {
      icon: Route,
      title: "Drivers work from another list.",
      text: "Stop details and delivery notes need another handoff before the driver can leave.",
      detail: "More coordination before dispatch",
    },
    {
      icon: Phone,
      title: "Customers want an update.",
      text: "You hunt for the order, delivery record, or invoice before you can answer.",
      detail: "Time spent chasing information",
    },
  ];
  return (
    <section className="problem-section section wrap">
      <div className="section-heading split-heading">
        <div>
          <Eyebrow>THE EVERYDAY COST OF DISCONNECTED TOOLS</Eyebrow>
          <h2>
            Scattered orders create work.
            <br />
            Before the delivery even starts.
          </h2>
        </div>
        <p>
          As order volume grows, so does the coordination. Messages, separate lists, and repeated
          calls make every order harder to move.
        </p>
      </div>
      <div className="problem-grid">
        {pains.map((p, i) => (
          <article key={p.title}>
            <div className="problem-card-top">
              <p.icon size={24} />
              <span>0{i + 1}</span>
            </div>
            <h3>{p.title}</h3>
            <p>{p.text}</p>
            <div className="problem-cost">
              <span />
              {p.detail}
            </div>
          </article>
        ))}
      </div>
      <div className="problem-conclusion">
        <span>Each handoff adds work and creates another place for a detail to get lost.</span>
        <a href="#how-it-works" className="text-link">
          Connect the workflow <ArrowRight size={17} />
        </a>
      </div>
    </section>
  );
}

export function DifferenceSection() {
  const rows = [
    [
      "Turn messages into a separate order list",
      "Manage the order with its customer and product details",
    ],
    [
      "Pass delivery information to the driver again",
      "Keep stops and delivery notes in the assigned run",
    ],
    [
      "Look across tools to answer a customer",
      "Refer to delivery records and account history in one workspace",
    ],
  ];
  return (
    <section className="difference-section surface">
      <div className="section wrap">
        <div className="section-heading split-heading">
          <div>
            <Eyebrow>THE REASON TO SWITCH</Eyebrow>
            <h2>
              One workflow your
              <br />
              whole team can follow.
            </h2>
          </div>
          <p>
            RouteFlow connects order management, delivery operations, and customer accounts. Your
            team can follow the work across those handoffs.
          </p>
        </div>
        <div className="difference-table">
          <table aria-label="Disconnected workflow compared with RouteFlow">
            <thead>
              <tr className="difference-row difference-head">
                <th scope="col">
                  <div className="comparison-cell">With disconnected tools</div>
                </th>
                <th scope="col">
                  <div className="comparison-cell">
                    <span className="mini-route-mark">
                      <BrandMark />
                    </span>{" "}
                    With RouteFlow
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([before, after]) => (
                <tr className="difference-row" key={before}>
                  <td>
                    <div className="comparison-cell">
                      <span className="before-dot" />
                      {before}
                    </div>
                  </td>
                  <td>
                    <div className="comparison-cell">
                      <Check size={18} />
                      {after}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="difference-footer">
          <p>
            For distributors and the retailers they serve. Built around ordering and delivery, with
            the customer record close at hand.
          </p>
          <Link href="/product" className="text-link">
            Explore the connected platform <ArrowRight size={17} />
          </Link>
        </div>
      </div>
    </section>
  );
}

export function BuyingConfidence() {
  const points = [
    {
      icon: PackageCheck,
      title: "Start with one real order.",
      text: "Bring an example of how an order reaches your team today.",
    },
    {
      icon: Users,
      title: "Follow the handoffs.",
      text: "See what the office, warehouse, and driver need at each step.",
    },
    {
      icon: FileCheck2,
      title: "Confirm the fit before you commit.",
      text: "Review the features, plan limits, and setup your operation needs.",
    },
  ];
  return (
    <section className="buying-confidence section wrap">
      <div>
        <Eyebrow>MAKE THE NEXT STEP USEFUL</Eyebrow>
        <h2>
          See it handle the work
          <br />
          you do every day.
        </h2>
        <p>
          A useful demo starts with your operation. Walk through the parts of your workflow you want
          to improve and ask the team to show you how RouteFlow handles them.
        </p>
        <Link href="/book-a-demo" className="button">
          Book a workflow demo <ArrowRight size={18} />
        </Link>
        <span className="confidence-note">
          Come with your questions. Leave with a clearer decision.
        </span>
      </div>
      <div className="confidence-points">
        {points.map((p) => (
          <article key={p.title}>
            <p.icon size={23} />
            <div>
              <h3>{p.title}</h3>
              <p>{p.text}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
