"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  Package,
  Warehouse,
  Route,
  CheckCheck,
  ReceiptText,
  BarChart3,
  Play,
  Pause,
  RotateCcw,
  Plus,
  Minus,
  ArrowRight,
  Store,
  Check,
  Wallet,
  ArrowUpRight,
} from "lucide-react";
import { BrandSignature } from "@/components/brand";
import { exampleOrder, exampleRoutes, nextChapter } from "../lib/operation-model";

// OperationStory ("DeliveryDemo") — the interactive order-lifecycle demo
// (ported near-verbatim from the redesign's components/operation-story.tsx;
// spec.md R7, ux-spec.md §4, T8a). Controls are plain <button> elements
// styled by the site's own marketing.css classes (Tailwind preflight already
// strips default button chrome), not a shared Button component. The pure
// arithmetic/route data lives in ../lib/operation-model (already covered by
// its own unit tests).
const chapters = [
  {
    name: "Inventory",
    icon: Warehouse,
    title: "Know what is ready to go.",
    detail: "Change the quantity. Follow the same items through the order.",
  },
  {
    name: "Order",
    icon: Package,
    title: "Every detail travels with the order.",
    detail: "Customer, products, pricing, and delivery notes stay in context.",
  },
  {
    name: "Route",
    icon: Route,
    title: "Give the delivery a clear plan.",
    detail: "Choose an example run and see its driver and stops change.",
  },
  {
    name: "Delivery",
    icon: CheckCheck,
    title: "Keep a record of the handoff.",
    detail: "Confirm the sample delivery to carry the story into invoicing.",
  },
  {
    name: "Invoice",
    icon: ReceiptText,
    title: "The order has an account behind it.",
    detail: "The invoice reflects the quantities you chose at the start.",
  },
  {
    name: "Insights",
    icon: BarChart3,
    title: "See the result in context.",
    detail: "Review the order value, delivery record, and open balance.",
  },
];

const currency = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);

function RouteSurface({ selected, moving }: { selected: number; moving: boolean }) {
  const gradient = useId().replaceAll(":", "");
  return (
    <svg
      className={"route-surface " + (moving ? "route-moving" : "")}
      viewBox="0 0 460 250"
      role="img"
      aria-label={`Illustrative map for the ${exampleRoutes[selected].name}`}
    >
      <defs>
        <linearGradient id={gradient}>
          <stop stopColor="#45445c" />
          <stop offset="1" stopColor="#9a80ac" />
        </linearGradient>
      </defs>
      <rect width="460" height="250" rx="20" fill="#e9edf5" />
      <path d="M370-20C278 47 364 138 280 281" stroke="#b8dce8" strokeWidth="46" fill="none" />
      <path
        d="M32 36h103v56H32z M221 20h66v39h-66z M19 199h114v36H19z M352 181h95v47h-95z"
        fill="#d2e3d6"
      />
      <path
        d="M0 124H460 M149 0v250 M332 0v250 M0 47H460 M0 208H460"
        stroke="#fff"
        strokeWidth="15"
      />
      <path
        d="M0 124H460 M149 0v250 M332 0v250 M0 47H460 M0 208H460"
        stroke="#d9dfe9"
        strokeWidth="1"
        strokeDasharray="5 5"
      />
      <path
        d={exampleRoutes[selected].path}
        fill="none"
        stroke="white"
        strokeWidth="13"
        strokeLinecap="round"
      />
      <path
        className="order-route-line"
        d={exampleRoutes[selected].path}
        pathLength="1"
        fill="none"
        stroke={`url(#${gradient})`}
        strokeWidth="6"
        strokeLinecap="round"
      />
      {(
        [
          [65, 166, "W"],
          [182, 71, selected === 0 ? "1" : "2"],
          [393, 76, selected === 0 ? "2" : "1"],
        ] as const
      ).map(([x, y, label]) => (
        <g key={label} transform={`translate(${x} ${y})`}>
          <circle r="14" fill="white" stroke="#8b7a9a" strokeWidth="2" />
          <text textAnchor="middle" y="4" fill="#635071" fontSize="12" fontWeight="650">
            {label}
          </text>
        </g>
      ))}
      <g fill="#3e526d" fontSize="10" fontWeight="550">
        <text x="24" y="196">
          Warehouse
        </text>
        <text x="137" y="42">
          Parkside Market
        </text>
        <text x="346" y="108">
          Corner Store
        </text>
      </g>
    </svg>
  );
}

export function OperationStory({ compact = false }: { compact?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusNextHeading = useRef(false);
  const [announcement, setAnnouncement] = useState("");
  const [chapter, setChapter] = useState(0);
  const [quantity, setQuantity] = useState(4);
  const [route, setRoute] = useState(0);
  const [delivered, setDelivered] = useState(false);
  const [paid, setPaid] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [visible, setVisible] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const order = exampleOrder(quantity, { delivered, paid });
  const current = chapters[chapter];

  useEffect(() => {
    if (focusNextHeading.current) {
      heading.current?.focus({ preventScroll: true });
      focusNextHeading.current = false;
    }
  }, [chapter]);

  useEffect(() => {
    if (!root.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      threshold: 0.1,
    });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);

  // Reduced motion respected (spec.md R7, ux-spec.md §4): the automatic
  // chapter-advance timer below never runs while the viewer's OS setting
  // asks for less motion — the story stays fully explorable through the
  // manual controls (chapter dots, quantity, route, confirm/pay buttons).
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(query.matches);
    const onChange = () => setReducedMotion(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!playing || !visible || reducedMotion) return;
    const timer = window.setTimeout(() => {
      if (document.hidden) {
        setPlaying(false);
        return;
      }
      const next = nextChapter(chapter);
      if (next >= 4) setDelivered(true);
      setChapter(next);
      if (next === 5) setPlaying(false);
    }, 3300);
    return () => clearTimeout(timer);
  }, [chapter, playing, visible, reducedMotion]);

  const select = (i: number, focus = false) => {
    setPlaying(false);
    focusNextHeading.current = focus;
    setChapter(i);
    setAnnouncement(chapters[i].name + ": " + chapters[i].title);
  };
  const adjust = (by: number) => {
    setPlaying(false);
    setQuantity((q) => Math.max(1, Math.min(12, q + by)));
    setDelivered(false);
    setPaid(false);
  };
  const assign = (i: number) => {
    setPlaying(false);
    if (i === route) return;
    setRoute(i);
    setDelivered(false);
    setPaid(false);
    setAnnouncement(
      "Assigned to " +
        exampleRoutes[i].name +
        ". Delivery and payment reset for the new assignment.",
    );
  };
  const restart = () => {
    setChapter(0);
    setQuantity(4);
    setRoute(0);
    setDelivered(false);
    setPaid(false);
    setPlaying(true);
  };
  const confirm = () => {
    setDelivered(true);
    setPlaying(false);
    focusNextHeading.current = true;
    setChapter(4);
    setAnnouncement("Sample delivery confirmed. Invoice ready to review.");
  };

  return (
    <div ref={root} className={"operation-story " + (compact ? "story-compact" : "")}>
      <div className="story-light story-light-one" />
      <div className="story-light story-light-two" />
      <div className="story-top">
        <span>
          <span /> INTERACTIVE PRODUCT EXAMPLE
        </span>
        <span>One order. Every team.</span>
      </div>
      <div className="story-intro">
        <span className="story-chapter-count">0{chapter + 1} / 06</span>
        <h3 ref={heading} tabIndex={-1}>
          {current.title}
        </h3>
      </div>
      <div className="passport-stage">
        <div className="passport-shadow" />
        <div className="order-passport">
          <div className="passport-chrome">
            <span className="passport-brand">
              <BrandSignature />
            </span>
            <span className="passport-module">
              <current.icon size={14} />
              {current.name}
            </span>
          </div>
          <div className="passport-context">
            <div>
              <span>ORDER #RF-1042</span>
              <strong>Parkside Market</strong>
            </div>
            <span className={"passport-status " + (delivered ? "status-done" : "")}>
              {paid ? "Payment recorded" : delivered ? "Delivered" : "Sample order"}
            </span>
          </div>
          <div className="passport-content" key={chapter} onFocusCapture={() => setPlaying(false)}>
            {chapter === 0 && (
              <div className="inventory-scene">
                <div className="stock-scene-top">
                  <div>
                    <span className="story-small-label">SPRING WATER · 24-PACK</span>
                    <strong className="stock-count">
                      148<span>cases on hand</span>
                    </strong>
                    <p>Plan this example order.</p>
                  </div>
                  {/* Plain <img>, not next/image (ruling B1); below the fold, so lazy. */}
                  {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
                  <img
                    className="stock-cutout"
                    src="/marketing/stock-cutout-v3.webp"
                    alt="Photorealistic unbranded cartons and a case of bottled water."
                    width={640}
                    height={512}
                    loading="lazy"
                    decoding="async"
                  />
                </div>
                <div className="quantity-card">
                  <div>
                    <strong>Cases for this order</strong>
                    <span>$18 per case · example price</span>
                  </div>
                  <div className="quantity-controls">
                    <button
                      type="button"
                      onClick={() => adjust(-1)}
                      disabled={quantity <= 1}
                      aria-label="Remove one case"
                    >
                      <Minus size={15} />
                    </button>
                    <output aria-label="Cases in sample order">{quantity}</output>
                    <button
                      type="button"
                      onClick={() => adjust(1)}
                      disabled={quantity >= 12}
                      aria-label="Add one case"
                    >
                      <Plus size={15} />
                    </button>
                  </div>
                </div>
                <div className="stock-after">
                  <span>
                    <span />
                    After this example order
                  </span>
                  <strong>{order.available} cases</strong>
                </div>
              </div>
            )}
            {chapter === 1 && (
              <div className="order-detail-scene">
                <div className="passport-section-label">
                  <Package size={17} />
                  Items & customer pricing
                </div>
                <div className="example-item">
                  <Package size={24} className="order-item-icon" />
                  <div>
                    <strong>Spring water · 24-pack</strong>
                    <span>{quantity} cases × $18</span>
                  </div>
                  <b>{currency(order.waterTotal)}</b>
                </div>
                <div className="example-item">
                  <Package size={24} className="order-item-icon" />
                  <div>
                    <strong>Mixed snacks · 30-pack</strong>
                    <span>2 cases × $21</span>
                  </div>
                  <b>$42</b>
                </div>
                <div className="order-delivery-note">
                  <span>DELIVERY NOTE</span>
                  <p>Use the rear receiving entrance.</p>
                </div>
                <div className="passport-total">
                  <span>Example subtotal</span>
                  <strong>{currency(order.total)}</strong>
                </div>
              </div>
            )}
            {chapter === 2 && (
              <div className="route-scene">
                <fieldset className="example-runs" aria-label="Assign the sample delivery run">
                  {exampleRoutes.map((r, i) => (
                    <button
                      key={r.name}
                      type="button"
                      aria-pressed={route === i}
                      onClick={() => assign(i)}
                      className={route === i ? "is-selected" : ""}
                    >
                      {r.name}
                      {route === i && <Check size={13} />}
                    </button>
                  ))}
                </fieldset>
                <RouteSurface key={route} selected={route} moving={playing} />
                <div className="run-summary">
                  <span>
                    <Route size={15} />
                    {exampleRoutes[route].driver} · 3 example stops
                  </span>
                  <strong>{exampleRoutes[route].name}</strong>
                </div>
              </div>
            )}
            {chapter === 3 && (
              <div className="delivery-scene-v3">
                <span className="delivery-receipt-icon">
                  <CheckCheck size={33} />
                </span>
                <h4>At the receiving door.</h4>
                <p>
                  Parkside Market
                  <br />
                  <span>
                    {quantity + 2} cases · {exampleRoutes[route].name}
                  </span>
                </p>
                <div className="delivery-proof-row">
                  <Check size={16} />A delivery record for the order
                </div>
                <button type="button" className="story-action" onClick={confirm}>
                  Confirm sample delivery <ArrowRight size={15} />
                </button>
              </div>
            )}
            {chapter === 4 && (
              <div className="invoice-scene">
                <div className="invoice-title">
                  <span>
                    <ReceiptText size={19} />
                    Invoice
                  </span>
                  <b>{delivered ? "READY" : "DRAFT"}</b>
                </div>
                <div className="invoice-reference">
                  INV-1042 <span>From order RF-1042</span>
                </div>
                <div className="invoice-line">
                  <span>Spring water · {quantity} cases</span>
                  <strong>{currency(order.waterTotal)}</strong>
                </div>
                <div className="invoice-line">
                  <span>Mixed snacks · 2 cases</span>
                  <strong>$42</strong>
                </div>
                <div className="passport-total">
                  <span>Example subtotal</span>
                  <strong>{currency(order.total)}</strong>
                </div>
                <div className="account-balance">
                  <Wallet size={16} />
                  <span>Open balance</span>
                  <strong>{currency(order.balance)}</strong>
                </div>
                {!delivered ? (
                  <button
                    type="button"
                    className="story-inline-action"
                    onClick={() => select(3, true)}
                  >
                    Confirm delivery first <ArrowRight size={14} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="story-action"
                    disabled={paid}
                    onClick={() => {
                      setPaid(true);
                      setPlaying(false);
                      setAnnouncement("Sample payment recorded. Open balance is zero.");
                    }}
                  >
                    {paid ? (
                      <>
                        <Check size={15} /> Sample payment recorded
                      </>
                    ) : (
                      <>
                        Record sample payment <ArrowRight size={14} />
                      </>
                    )}
                  </button>
                )}
              </div>
            )}
            {chapter === 5 && (
              <div className="insights-scene">
                <div className="passport-section-label">
                  <BarChart3 size={17} />
                  This order, in context
                </div>
                <div className="insights-metrics">
                  <div>
                    <span>Order value</span>
                    <strong>{currency(order.total)}</strong>
                  </div>
                  <div>
                    <span>Open balance</span>
                    <strong>{currency(order.balance)}</strong>
                  </div>
                </div>
                <div
                  className="example-chart"
                  aria-label={`Example order value: water ${currency(order.waterTotal)}, snacks 42 dollars`}
                >
                  <div>
                    <span>Water</span>
                    <div>
                      <i style={{ width: (order.waterTotal / order.total) * 100 + "%" }} />
                    </div>
                    <strong>{currency(order.waterTotal)}</strong>
                  </div>
                  <div>
                    <span>Snacks</span>
                    <div>
                      <i style={{ width: (42 / order.total) * 100 + "%" }} />
                    </div>
                    <strong>$42</strong>
                  </div>
                </div>
                <div className="insight-outcomes">
                  <span>
                    <Package size={15} />
                    {quantity + 2} cases
                  </span>
                  <span>
                    <Store size={15} />1 customer
                  </span>
                  <span>
                    <CheckCheck size={15} />
                    {delivered ? "Delivered" : "Not delivered"}
                  </span>
                </div>
                <p>Illustrative order data. No business performance claim.</p>
              </div>
            )}
          </div>
          <div className="passport-bottom">
            <span className="connected-dot" /> Same order. Connected context.
            <span>DEMO</span>
          </div>
        </div>
        <div className="customer-glimpse">
          <div className="phone-speaker" />
          <span className="customer-portal-label">
            <Store size={14} />
            Retailer portal
          </span>
          <strong>
            Parkside
            <br />
            Market
          </strong>
          <div className="phone-order">
            <Package size={21} />
            <span>RF-1042</span>
            <b>{currency(order.total)}</b>
            <span>{quantity + 2} cases</span>
          </div>
          <span className={"phone-state " + (delivered ? "complete" : "")}>
            {delivered ? <CheckCheck size={12} /> : <Package size={12} />}{" "}
            {delivered ? "Delivered" : "Example order"}
          </span>
          <button type="button" onClick={() => select(1)}>
            View order <ArrowUpRight size={13} />
          </button>
        </div>
        <div className="story-link-pill">
          <span />
          <span>
            Office <ArrowRight size={11} /> Driver <ArrowRight size={11} /> Customer
          </span>
        </div>
      </div>
      <div className="story-controls">
        <div className="story-explanation">
          <p>{current.detail}</p>
          <div>
            <button
              type="button"
              className="story-play"
              aria-label={
                playing ? "Pause story" : chapter === 5 ? "Replay story" : "Follow this order"
              }
              onClick={() =>
                playing ? setPlaying(false) : chapter === 5 ? restart() : setPlaying(true)
              }
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
              <span>
                {playing ? "Pause" : chapter === 5 ? "Replay story" : "Follow this order"}
              </span>
            </button>
            <button
              type="button"
              className="story-reset"
              onClick={restart}
              aria-label="Restart the sample order story"
            >
              <RotateCcw size={15} />
            </button>
          </div>
        </div>
        <fieldset className="story-chapters" aria-label="Explore the order workflow">
          {chapters.map((c, i) => (
            <button
              key={c.name}
              type="button"
              aria-pressed={chapter === i}
              onClick={() => select(i)}
              className={chapter === i ? "is-current" : ""}
            >
              <c.icon size={16} />
              <span>{c.name}</span>
            </button>
          ))}
        </fieldset>
      </div>
      <p className="story-disclaimer">
        Interactive illustration, not a live account. Changes stay in this example.
      </p>
      <output className="sr-only" aria-live="polite">
        {announcement}
      </output>
    </div>
  );
}
