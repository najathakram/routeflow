import { ArrowRight, ClipboardList, ReceiptText, Truck } from "lucide-react";

// W0 "Say it in one look" (COPY.md section 1): the hero picture. A laptop showing the whole job in
// three steps, so the picture says what the headline says with the words hidden.
//
// CSS only: no new binary, no motion, no script. It is a PICTURE, not tabs, so nothing here is a
// button, a link or a focus stop. The labels are at least 20 px at every width (marketing.css,
// `.hero-steps-label`). The accessible name is the alt text; the parts inside are hidden from
// assistive tech so the three labels are not read twice.

const STEPS = [
  { label: "Order", Icon: ClipboardList },
  { label: "Delivery", Icon: Truck },
  { label: "Invoice", Icon: ReceiptText },
] as const;

export function HeroSteps() {
  return (
    <div
      className="hero-steps"
      role="img"
      aria-label="A laptop showing three steps: order, delivery, and invoice."
    >
      <div className="hero-steps-laptop" aria-hidden="true">
        <div className="hero-steps-screen">
          <ol className="hero-steps-row">
            {STEPS.map(({ label, Icon }, i) => (
              <li key={label} className="hero-steps-item">
                <span className="hero-steps-icon">
                  <Icon size={34} strokeWidth={1.8} />
                </span>
                <span className="hero-steps-label">{label}</span>
                {i < STEPS.length - 1 ? (
                  <ArrowRight className="hero-steps-arrow" size={22} strokeWidth={2} />
                ) : null}
              </li>
            ))}
          </ol>
        </div>
        <div className="hero-steps-base" />
      </div>
    </div>
  );
}
