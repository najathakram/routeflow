import Link from "next/link";
import { ArrowRight, FileText, ScanText, UserCheck } from "lucide-react";

// Copy verbatim from the redesign's components/ai-spotlight.tsx (M1 §1.4).

export function AISpotlight() {
  return (
    <section className="ai-spotlight section wrap" aria-labelledby="ai-heading">
      <div className="ai-copy">
        <span className="ai-label">
          <ScanText size={17} /> AI PURCHASE-INVOICE SCANNING
        </span>
        <h2 id="ai-heading">
          Less invoice entry.
          <br />
          <em>
            More clarity on <br />
            stock and cost.
          </em>
        </h2>
        <p>
          Different vendors. Different invoices. One easier way to update inventory and costing.
          RouteFlow uses AI to scan purchase invoices, reducing the work of entering supplier
          purchases by hand.
        </p>
        <Link className="text-link" href="/book-a-demo">
          See AI invoice scanning in a demo <ArrowRight size={18} />
        </Link>
      </div>
      <div className="ai-review">
        <div className="ai-review-heading">
          <span>INVOICE → INVENTORY → COSTING</span>
          <span>Built for multiple vendors</span>
        </div>
        <ol className="ai-review-steps">
          <li>
            <span className="ai-step-icon">
              <FileText size={27} />
            </span>
            <div>
              <small>01 / THE WORK</small>
              <h3>Bring your purchase invoices.</h3>
              <p>Keep purchases from different vendors in one workflow.</p>
            </div>
          </li>
          <li className="ai-assisted-step">
            <span className="ai-step-icon">
              <ScanText size={27} />
            </span>
            <div>
              <small>02 / AI ASSISTANCE</small>
              <h3>Let AI scan the invoice.</h3>
              <p>Turn purchase-invoice information into usable purchase data.</p>
            </div>
          </li>
          <li>
            <span className="ai-step-icon">
              <UserCheck size={27} />
            </span>
            <div>
              <small>03 / YOUR DECISION</small>
              <h3>Update inventory and costing.</h3>
              <p>Connect what you bought with stock quantities and purchase costs.</p>
            </div>
          </li>
        </ol>
        <p className="ai-illustration-note">
          Illustrative workflow. See supported invoice formats and your inventory and costing
          configuration in a product demo.
        </p>
      </div>
    </section>
  );
}
